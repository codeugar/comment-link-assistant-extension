import { type AnchorSelection, selectAnchor } from '@/anchor/select';
import { generateWriteTurn } from '@/api/client';
import { addManualModerationEntry } from '@/dashboard/moderation-recheck';
import { readActivePageWriteContext } from '@/runtime/page-commands';
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

async function selectWriteAnchor(
  siteId: string
): Promise<AnchorSelection | null> {
  try {
    const [plan, ledger] = await Promise.all([
      getAnchorPlan(siteId),
      getAnchorLedger(siteId),
    ]);
    const selection = selectAnchor(plan, ledger);
    if (!selection) return null;
    // Matches src/batch/runner.ts: the rotation advances on selection, not on
    // success, so a failed turn costs one entry rather than reusing it.
    if (selection.cursor !== plan.cursor) {
      await saveAnchorPlan({ ...plan, cursor: selection.cursor });
    }
    return selection;
  } catch {
    // A missing or unreadable anchor plan must never block the chat turn.
    return null;
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

async function turnAnchorInput(siteId: string): Promise<{
  bucket: AnchorSelection['bucket'] | null;
  text: string | null;
  requestAnchorText: boolean;
}> {
  const anchor = await selectWriteAnchor(siteId);
  return {
    bucket: anchor?.bucket ?? null,
    text: anchor?.text ?? null,
    requestAnchorText: anchor?.bucket === 'natural',
  };
}

function buildDraft(
  version: number,
  generatedDraft: { template: string; anchorText?: string },
  anchor: { bucket: AnchorSelection['bucket'] | null; text: string | null },
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

export async function writeSend(input: {
  tabId: number;
  text: string;
}): Promise<WriteSession> {
  const session = await loadFreshSession(input.tabId);
  const settings = await getSettings();
  const site = requireSite(session.siteId, settings.sites);
  const [keys, websiteProfile, anchor] = await Promise.all([
    getProviderApiKeys(),
    loadWebsiteProfile(site.websiteUrl),
    turnAnchorInput(site.id),
  ]);

  const prompt = buildWritePrompt({
    websiteProfile,
    context: session.context,
    history: session.turns,
    userMessage: input.text,
    format: session.format,
    ...(anchor.text ? { anchorText: anchor.text } : {}),
    requestAnchorText: anchor.requestAnchorText,
  });
  const generated = await generateWriteTurn(keys, {
    provider: settings.provider,
    websiteProfile,
    prompt,
    isFirstTurn: false,
    ...(anchor.text ? { anchorText: anchor.text } : {}),
    requestAnchorText: anchor.requestAnchorText,
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

export async function writeMarkSent(input: {
  tabId: number;
  draftId: string;
  addToRecheck: boolean;
}): Promise<WriteSession> {
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

  if (draft.format !== 'none' && draft.anchorBucket) {
    await recordAnchorPublished(
      site.id,
      draft.anchorBucket,
      draft.anchorText ?? undefined,
      now
    );
  }

  await addOutboundLinkLibraryEntryWithResult({ url: session.pageUrl, now });

  if (input.addToRecheck) {
    try {
      await addManualModerationEntry({
        pageUrl: session.pageUrl,
        targetWebsiteUrl: site.websiteUrl,
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== MODERATION_RECHECK_ENTRY_EXISTS
      ) {
        throw error;
      }
    }
  }

  const drafts = session.drafts.map((candidate) =>
    candidate.id === input.draftId ? { ...candidate, sentAt: now } : candidate
  );
  return setWriteSession({ ...session, drafts, updatedAt: now });
}
