import { selectAnchor } from '@/anchor/select';
import type {
  AnchorBucket,
  AnchorBucketCursors,
  AnchorPlan,
} from '@/anchor/types';
import { generateWriteTurn } from '@/api/client';
import { addManualModerationEntry } from '@/dashboard/moderation-recheck';
import {
  comparablePageUrl,
  readActivePageWriteContext,
  readTabWriteContext,
} from '@/runtime/page-commands';
import {
  getAnchorLedger,
  recordAnchorPublished,
} from '@/storage/anchor-ledger';
import { getAnchorPlan, saveAnchorPlan } from '@/storage/anchor-plan';
import { addOutboundLinkLibraryEntryWithResult } from '@/storage/outbound-link-library';
import { getProviderApiKeys, getSettings } from '@/storage/settings';
import type { SiteProfile } from '@/types';
import type { WebsiteProfile } from '@/website/profile';
import { loadWebsiteProfile } from '@/website/profile-cache';
import { buildWritePrompt } from './prompt';
import { renderDraft } from './render';
import {
  deleteWriteSession,
  getWriteSession,
  isWriteSessionStale,
  setWriteSession,
} from './session-store';
import type { WriteDraft, WriteLinkFormat, WriteSession } from './types';

const MODERATION_RECHECK_ENTRY_EXISTS = 'MODERATION_RECHECK_ENTRY_EXISTS';
// Below this, there is not enough on the page to restate a topic from.
const MIN_CONTEXT_TEXT_LENGTH = 40;

function requireSite(siteId: string, sites: SiteProfile[]): SiteProfile {
  const site = sites.find((candidate) => candidate.id === siteId);
  if (!site) throw new Error('SITE_NOT_FOUND');
  return site;
}

/** What a chat turn should ask the model for, and how to record it once (and
 *  only once) a draft actually comes back. */
interface AnchorResolution {
  bucket: AnchorBucket | null;
  text: string | null;
  requestAnchorText: boolean;
  /** Set only when the rotation was drawn from a plan, so the caller can
   *  persist the advanced cursor after a draft is confirmed. */
  plan: AnchorPlan | null;
  cursor: AnchorBucketCursors | null;
}

const NO_ANCHOR: AnchorResolution = {
  bucket: null,
  text: null,
  requestAnchorText: false,
  plan: null,
  cursor: null,
};

/**
 * Resolves the anchor for one chat turn, keyed off the session's render
 * format — never off the model's own opinion, matching how batch generation
 * only spends the rotation for a link mode that actually carries a link.
 *
 * `none` renders no link, so nothing is drawn and nothing is ever recorded.
 * `bare-url` renders the raw URL with no wording, so it always records the
 * `naked` bucket against the site's own URL rather than drawing from the
 * plan. Only bbcode/markdown/html — which render a labeled anchor — go
 * through `selectAnchor`, and even then the cursor is not saved here: the
 * caller only persists it once a draft actually used this pick.
 */
async function resolveAnchorForFormat(
  format: WriteLinkFormat,
  siteId: string,
  websiteUrl: string
): Promise<AnchorResolution> {
  if (format === 'none') return NO_ANCHOR;
  if (format === 'bare-url') {
    return { ...NO_ANCHOR, bucket: 'naked', text: websiteUrl };
  }
  try {
    const [plan, ledger] = await Promise.all([
      getAnchorPlan(siteId),
      getAnchorLedger(siteId),
    ]);
    const selection = selectAnchor(plan, ledger);
    if (!selection) return NO_ANCHOR;
    return {
      bucket: selection.bucket,
      text: selection.text,
      requestAnchorText: selection.bucket === 'natural',
      plan,
      cursor: selection.cursor,
    };
  } catch {
    // A missing or unreadable anchor plan must never block the chat turn.
    return NO_ANCHOR;
  }
}

/** Persists the rotation this turn drew, but only once a draft actually spent
 *  it — a follow-up question that produced no draft must not cost a pool
 *  entry the way a failed batch target never would either. */
async function commitAnchorCursor(anchor: AnchorResolution): Promise<void> {
  if (anchor.plan && anchor.cursor && anchor.cursor !== anchor.plan.cursor) {
    await saveAnchorPlan({ ...anchor.plan, cursor: anchor.cursor });
  }
}

async function loadFreshSession(tabId: number): Promise<WriteSession> {
  const session = await getWriteSession(tabId);
  if (!session) throw new Error('WRITE_SESSION_NOT_FOUND');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || isWriteSessionStale(session, tab.url)) {
    await deleteWriteSession(tabId);
    throw new Error('WRITE_SESSION_STALE');
  }
  return session;
}

export async function writeStart(input: {
  siteId: string;
  format: WriteLinkFormat;
}): Promise<WriteSession> {
  const settings = await getSettings();
  const site = requireSite(input.siteId, settings.sites);
  const [{ tabId, context }, keys, websiteProfile] = await Promise.all([
    readActivePageWriteContext(),
    getProviderApiKeys(),
    loadWebsiteProfile(site.websiteUrl),
  ]);
  if (
    !context.title.trim() &&
    context.firstPost.length < MIN_CONTEXT_TEXT_LENGTH
  ) {
    throw new Error('WRITE_CONTEXT_EMPTY');
  }

  const prompt = buildWritePrompt({
    websiteProfile,
    context,
    history: [],
    userMessage: null,
    format: input.format,
  });
  const generated = await generateWriteTurn(keys, {
    provider: settings.provider,
    websiteProfile,
    prompt,
    isFirstTurn: true,
  });

  const now = Date.now();
  const session: WriteSession = {
    tabId,
    pageUrl: context.url,
    siteId: site.id,
    format: input.format,
    context,
    turns: [{ role: 'assistant', text: generated.reply, at: now }],
    drafts: [],
    createdAt: now,
    updatedAt: now,
  };
  return setWriteSession(session);
}

function buildDraft(
  version: number,
  generatedDraft: { template: string; anchorText?: string },
  anchor: AnchorResolution,
  site: SiteProfile,
  websiteProfile: WebsiteProfile,
  format: WriteLinkFormat,
  now: number
): WriteDraft {
  const anchorText = generatedDraft.anchorText ?? anchor.text ?? null;
  const rendered = renderDraft(generatedDraft.template, {
    websiteUrl: site.websiteUrl,
    anchorText,
    websiteTitle: websiteProfile.title,
    format,
  });
  return {
    id: crypto.randomUUID(),
    version,
    template: generatedDraft.template,
    anchorBucket: anchor.bucket,
    anchorText,
    rendered,
    format,
    createdAt: now,
  };
}

/**
 * A live conversation can outlive the moment the user selected text: they
 * might pick a different reply mid-chat and say "respond to the one I just
 * selected." Each turn re-reads the tab's selection so that works — but only
 * the selection, and only when the tab is still on the same page the session
 * was started for, so a background tab that has since navigated never
 * silently swaps in unrelated content.
 */
async function withFreshSelection(
  session: WriteSession
): Promise<WriteSession['context']> {
  const fresh = await readTabWriteContext(session.tabId).catch(() => null);
  if (!fresh) return session.context;
  try {
    if (comparablePageUrl(fresh.url) !== comparablePageUrl(session.pageUrl)) {
      return session.context;
    }
  } catch {
    return session.context;
  }
  return { ...session.context, selection: fresh.selection };
}

export async function writeSend(input: {
  tabId: number;
  text: string;
}): Promise<WriteSession> {
  const staleSession = await loadFreshSession(input.tabId);
  const context = await withFreshSelection(staleSession);
  const session: WriteSession = { ...staleSession, context };
  const settings = await getSettings();
  const site = requireSite(session.siteId, settings.sites);
  const [keys, websiteProfile, anchor] = await Promise.all([
    getProviderApiKeys(),
    loadWebsiteProfile(site.websiteUrl),
    resolveAnchorForFormat(session.format, site.id, site.websiteUrl),
  ]);
  // Only bbcode/markdown/html wording is worth telling the model about: a
  // bare URL or no link at all is never phrased as a labeled reference.
  const modelAnchorText =
    session.format === 'none' || session.format === 'bare-url'
      ? undefined
      : (anchor.text ?? undefined);
  const modelRequestAnchorText =
    session.format === 'none' || session.format === 'bare-url'
      ? false
      : anchor.requestAnchorText;

  const prompt = buildWritePrompt({
    websiteProfile,
    context: session.context,
    history: session.turns,
    userMessage: input.text,
    format: session.format,
    ...(modelAnchorText ? { anchorText: modelAnchorText } : {}),
    requestAnchorText: modelRequestAnchorText,
  });
  const generated = await generateWriteTurn(keys, {
    provider: settings.provider,
    websiteProfile,
    prompt,
    isFirstTurn: false,
    ...(modelAnchorText ? { anchorText: modelAnchorText } : {}),
    requestAnchorText: modelRequestAnchorText,
  });

  const now = Date.now();
  const turns = [
    ...session.turns,
    { role: 'user' as const, text: input.text, at: now },
    { role: 'assistant' as const, text: generated.reply, at: now },
  ];
  const drafts = generated.draft
    ? [
        ...session.drafts,
        buildDraft(
          session.drafts.length + 1,
          generated.draft,
          anchor,
          site,
          websiteProfile,
          session.format,
          now
        ),
      ]
    : session.drafts;

  // The rotation is only ever spent once a draft actually used the pick — a
  // reply with no draft (a follow-up question, a "make it shorter") must not
  // burn a pool entry.
  if (generated.draft) await commitAnchorCursor(anchor);

  return setWriteSession({ ...session, turns, drafts, updatedAt: now });
}

export async function writeSetFormat(input: {
  tabId: number;
  format: WriteLinkFormat;
}): Promise<WriteSession> {
  const session = await loadFreshSession(input.tabId);
  const settings = await getSettings();
  const site = requireSite(session.siteId, settings.sites);
  const websiteProfile = await loadWebsiteProfile(site.websiteUrl);
  const drafts = session.drafts.map((draft) => ({
    ...draft,
    format: input.format,
    rendered: renderDraft(draft.template, {
      websiteUrl: site.websiteUrl,
      anchorText: draft.anchorText,
      websiteTitle: websiteProfile.title,
      format: input.format,
    }),
  }));
  return setWriteSession({
    ...session,
    format: input.format,
    drafts,
    updatedAt: Date.now(),
  });
}

export async function writeSetAnchor(input: {
  tabId: number;
  draftId: string;
  anchorText: string;
}): Promise<WriteSession> {
  const session = await loadFreshSession(input.tabId);
  if (!session.drafts.some((draft) => draft.id === input.draftId)) {
    throw new Error('WRITE_DRAFT_NOT_FOUND');
  }
  const settings = await getSettings();
  const site = requireSite(session.siteId, settings.sites);
  const websiteProfile = await loadWebsiteProfile(site.websiteUrl);
  const anchorText = input.anchorText.trim() || null;
  const drafts = session.drafts.map((draft) =>
    draft.id === input.draftId
      ? {
          ...draft,
          // The bucket a draft was drawn from never changes here — only its
          // rendered wording does.
          anchorText,
          rendered: renderDraft(draft.template, {
            websiteUrl: site.websiteUrl,
            anchorText,
            websiteTitle: websiteProfile.title,
            format: draft.format,
          }),
        }
      : draft
  );
  return setWriteSession({ ...session, drafts, updatedAt: Date.now() });
}

export async function writeGet(input: {
  tabId: number;
}): Promise<WriteSession | null> {
  const session = await getWriteSession(input.tabId);
  if (!session) return null;
  const tab = await chrome.tabs.get(input.tabId).catch(() => null);
  if (!tab?.url || isWriteSessionStale(session, tab.url)) {
    await deleteWriteSession(input.tabId);
    return null;
  }
  return session;
}

export async function writeReset(input: { tabId: number }): Promise<null> {
  await deleteWriteSession(input.tabId);
  return null;
}

/**
 * Records the ledger effect of one sent draft, keyed off the draft's format
 * *at send time* — not the format it was drawn under. `writeSetFormat` can
 * change a draft's format after generation, so a draft drawn under bbcode and
 * later switched to `none` correctly records nothing here; the rotation cost
 * already happened when it was drawn, the same as a batch target that later
 * failed.
 */
async function recordDraftAnchor(
  siteId: string,
  websiteUrl: string,
  draft: WriteDraft,
  now: number
): Promise<void> {
  if (draft.format === 'none') return;
  if (draft.format === 'bare-url') {
    await recordAnchorPublished(siteId, 'naked', websiteUrl, now);
    return;
  }
  if (draft.anchorBucket) {
    await recordAnchorPublished(
      siteId,
      draft.anchorBucket,
      draft.anchorText ?? undefined,
      now
    );
  }
}

export async function writeMarkSent(input: {
  tabId: number;
  draftId: string;
  addToRecheck: boolean;
}): Promise<WriteSession & { recheckError?: string }> {
  const session = await loadFreshSession(input.tabId);
  const draft = session.drafts.find(
    (candidate) => candidate.id === input.draftId
  );
  if (!draft) throw new Error('WRITE_DRAFT_NOT_FOUND');
  // Already recorded: markSent must never double-count a ledger entry, a
  // library row, or a re-check request for the same draft.
  if (draft.sentAt) return session;

  const settings = await getSettings();
  const site = requireSite(session.siteId, settings.sites);
  const now = Date.now();

  // Ledger, then library, then the session is persisted with `sentAt` — only
  // once all three have happened does a retry see the draft as already sent.
  // The re-check enrollment comes last and is best-effort: an unexpected
  // failure there must never leave the ledger/library writes unrecorded, nor
  // cause a retry to double-record them.
  await recordDraftAnchor(site.id, site.websiteUrl, draft, now);
  await addOutboundLinkLibraryEntryWithResult({ url: session.pageUrl, now });

  const drafts = session.drafts.map((candidate) =>
    candidate.id === input.draftId ? { ...candidate, sentAt: now } : candidate
  );
  const persisted = await setWriteSession({
    ...session,
    drafts,
    updatedAt: now,
  });

  if (!input.addToRecheck) return persisted;

  try {
    await addManualModerationEntry({
      pageUrl: session.pageUrl,
      targetWebsiteUrl: site.websiteUrl,
    });
    return persisted;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === MODERATION_RECHECK_ENTRY_EXISTS
    ) {
      return persisted;
    }
    return {
      ...persisted,
      recheckError:
        error instanceof Error ? error.message : 'WRITE_RECHECK_FAILED',
    };
  }
}
