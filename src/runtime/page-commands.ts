import {
  PAGE_COMMAND_MESSAGE_TYPE,
  type PageCommand,
  type PageCommandResult,
} from '@/page/command';
import {
  type WordPressReceipt,
  matchesWordPressCommentPathname,
  readWordPressSubmitReceipt,
} from '@/page/receipts';
import type {
  CommentFrameReference,
  PageAnalysis,
  PageSubmissionExpectation,
  PageSubmissionInput,
  PageSubmissionPreparation,
  PageSubmissionResult,
  PageSubmissionTarget,
  PreparedPageSubmission,
} from '@/page/types';
import { checkPublicComment } from '@/verify/public-comment';

const PAGE_COMMAND_SCRIPT = 'content-scripts/page-command.js';
// Ad-heavy recipe pages can keep the content-script message channel busy well
// past 10 seconds even after the form is visibly filled. Give prepare/click/
// verify enough headroom to return instead of recording a transient failure.
const PAGE_COMMAND_TIMEOUT_MS = 120_000;
const JETPACK_COMMENT_FRAME_HOST = 'jetpack.wordpress.com';
const JETPACK_COMMENT_FRAME_PATH = '/jetpack-comment';
// A promoted Jetpack frame commits asynchronously after analyze sets its src, so
// poll webNavigation for it rather than assuming it is already listed.
const JETPACK_FRAME_RESOLVE_TIMEOUT_MS = 8_000;
const JETPACK_FRAME_POLL_INTERVAL_MS = 250;
// A read-only analyze now self-settles heavy pages (bounded DOMContentLoaded +
// mutation waits) and has no double-submit risk, so it gets generous headroom.
// Mutating commands (submit.prepare / submit.click / verify) use the bounded
// 2-minute window above.
const ANALYZE_COMMAND_TIMEOUT_MS = 30_000;
const activeSubmissionTabs = new Set<number>();

// A tab whose navigation failed (DNS, refused, timeout, cert) keeps the target
// URL and reports `complete`, so every caller-side guard passes and injection is
// the first thing to notice. Chrome rejects it with a raw internal string; map
// it to an owned code so the failure reads as "site is down", not a Chrome bug.
function injectionRejectedByErrorPage(error: unknown): boolean {
  return error instanceof Error && /showing error page/i.test(error.message);
}

async function injectPageCommandScript(
  target: chrome.scripting.InjectionTarget,
  command: PageCommand,
  // Without this the injection waits for document_idle, which a heavy
  // still-loading page can push past the command timeout.
  injectImmediately = true
): Promise<void> {
  try {
    await withPageCommandTimeout(
      chrome.scripting.executeScript({
        target,
        files: [PAGE_COMMAND_SCRIPT],
        injectImmediately,
      }),
      commandTimeout(command)
    );
  } catch (error) {
    if (injectionRejectedByErrorPage(error)) {
      throw new Error('TARGET_PAGE_UNREACHABLE');
    }
    throw error;
  }
}

function commandTimeout(command: PageCommand): number {
  return command.type === 'analyze'
    ? ANALYZE_COMMAND_TIMEOUT_MS
    : PAGE_COMMAND_TIMEOUT_MS;
}

function withPageCommandTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number = PAGE_COMMAND_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('PAGE_COMMAND_TIMEOUT')),
      timeoutMs
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function activeTab(): Promise<chrome.tabs.Tab> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('ACTIVE_TAB_NOT_FOUND');
  }
  if (!/^https?:/i.test(tab.url ?? '')) {
    throw new Error('PAGE_NOT_SUPPORTED');
  }
  return tab;
}

async function executePageCommand(
  tabId: number,
  command: PageCommand
): Promise<PageCommandResult> {
  try {
    return await sendPageCommand(tabId, command);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes('Receiving end does not exist')
    ) {
      throw error;
    }
  }
  await injectPageCommandScript({ tabId }, command);
  return sendPageCommand(tabId, command);
}

async function sendPageCommand(
  tabId: number,
  command: PageCommand
): Promise<PageCommandResult> {
  const result = (await withPageCommandTimeout(
    chrome.tabs.sendMessage(tabId, {
      type: PAGE_COMMAND_MESSAGE_TYPE,
      command,
    }),
    commandTimeout(command)
  )) as PageCommandResult | undefined;
  if (!result) throw new Error('PAGE_COMMAND_NO_RESULT');
  return result;
}

interface ResolvedFrame {
  frameId: number;
  url: string;
}

function jetpackFrameKey(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.host !== JETPACK_COMMENT_FRAME_HOST ||
      !url.pathname.startsWith(JETPACK_COMMENT_FRAME_PATH)
    ) {
      return null;
    }
    return `${url.searchParams.get('blogid') ?? ''}|${
      url.searchParams.get('postid') ?? ''
    }`;
  } catch {
    return null;
  }
}

// The committed frame carries extra params (sig, comment_registration, …) the
// top page's data-lazy-src hint lacks, so match on the stable blogid|postid key
// and fall back to any jetpack-comment frame when the hint omits them.
function isSameJetpackFrame(
  candidate: string | undefined,
  hint: string
): boolean {
  const candidateKey = jetpackFrameKey(candidate);
  if (candidateKey === null) return false;
  const hintKey = jetpackFrameKey(hint);
  return hintKey === null || hintKey === '|' || candidateKey === hintKey;
}

function frameDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveJetpackFrame(
  tabId: number,
  hint: string
): Promise<ResolvedFrame | null> {
  const deadline = Date.now() + JETPACK_FRAME_RESOLVE_TIMEOUT_MS;
  for (;;) {
    const frames = await chrome.webNavigation
      .getAllFrames({ tabId })
      .catch(() => null);
    const match = frames?.find((frame) => isSameJetpackFrame(frame.url, hint));
    if (match) return { frameId: match.frameId, url: match.url };
    if (Date.now() >= deadline) return null;
    await frameDelay(JETPACK_FRAME_POLL_INTERVAL_MS);
  }
}

async function sendFramePageCommand(
  tabId: number,
  frameId: number,
  command: PageCommand
): Promise<PageCommandResult> {
  const result = (await withPageCommandTimeout(
    chrome.tabs.sendMessage(
      tabId,
      { type: PAGE_COMMAND_MESSAGE_TYPE, command },
      { frameId }
    ),
    commandTimeout(command)
  )) as PageCommandResult | undefined;
  if (!result) throw new Error('PAGE_COMMAND_NO_RESULT');
  return result;
}

async function executeFramePageCommand(
  tabId: number,
  frameId: number,
  command: PageCommand
): Promise<PageCommandResult> {
  try {
    return await sendFramePageCommand(tabId, frameId, command);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes('Receiving end does not exist')
    ) {
      throw error;
    }
  }
  await injectPageCommandScript({ tabId, frameIds: [frameId] }, command, false);
  return sendFramePageCommand(tabId, frameId, command);
}

function readAnalysis(result: PageCommandResult): PageAnalysis {
  if (result.type === 'analysis') return result.analysis;
  throw new Error(
    result.type === 'error' ? result.message : 'PAGE_ANALYSIS_FAILED'
  );
}

function readSubmission(result: PageCommandResult): PageSubmissionResult {
  if (result.type === 'submission') return result.result;
  throw new Error(
    result.type === 'error' ? result.message : 'PAGE_SUBMISSION_FAILED'
  );
}

function readPreparation(result: PageCommandResult): PageSubmissionPreparation {
  if (result.type === 'preparation') return result.preparation;
  throw new Error(
    result.type === 'error' ? result.message : 'PAGE_PREPARATION_FAILED'
  );
}

async function waitForTabLoad(
  tabId: number,
  timeoutMs = 15_000
): Promise<void> {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (current?.status === 'complete') return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    function onUpdated(
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

export async function analyzeCurrentPage(): Promise<PageAnalysis> {
  return (await analyzeActivePage()).analysis;
}

export async function analyzeTab(tabId: number): Promise<PageAnalysis> {
  const analysis = readAnalysis(
    await executePageCommand(tabId, { type: 'analyze' })
  );
  if (analysis.form.frame?.kind !== 'jetpack') return analysis;
  return mergeJetpackFrameAnalysis(tabId, analysis, analysis.form.frame.url);
}

// The top document only detects the Jetpack frame; its real form shape lives in
// the cross-origin frame. Re-analyze inside the frame and keep the blog page's
// context (title/excerpt/url) for comment generation.
async function mergeJetpackFrameAnalysis(
  tabId: number,
  topAnalysis: PageAnalysis,
  hint: string
): Promise<PageAnalysis> {
  const resolved = await resolveJetpackFrame(tabId, hint);
  const frameAnalysis = resolved
    ? await executeFramePageCommand(tabId, resolved.frameId, {
        type: 'analyze',
      })
        .then(readAnalysis)
        .catch(() => null)
    : null;
  if (!resolved || !frameAnalysis) {
    return {
      page: topAnalysis.page,
      form: {
        readiness: 'not_found',
        editorLabel: '',
        submitLabel: '',
        hasNameField: false,
        hasEmailField: false,
        hasWebsiteField: false,
        message: 'CROSS_ORIGIN_COMMENT_FRAME_UNSUPPORTED',
      },
    };
  }
  return {
    page: topAnalysis.page,
    form: {
      ...frameAnalysis.form,
      frame: { kind: 'jetpack', url: resolved.url },
    },
  };
}

export async function prepareTabSubmission(
  tabId: number,
  input: PageSubmissionInput,
  target: PageSubmissionExpectation,
  frame?: CommentFrameReference
): Promise<PageSubmissionPreparation> {
  if (frame?.kind === 'jetpack') {
    const resolved = await resolveJetpackFrame(tabId, frame.url);
    if (!resolved) throw new Error('JETPACK_COMMENT_FRAME_UNAVAILABLE');
    const preparation = readPreparation(
      await executeFramePageCommand(tabId, resolved.frameId, {
        type: 'submit.prepare',
        input,
        expected: { ...target, url: resolved.url },
      })
    );
    // Restore the blog (tab) URL on the returned expectation so the runner's
    // tab-level guards keep comparing against the article, not the frame.
    return restoreExpectedUrl(preparation, target.url);
  }
  return readPreparation(
    await sendPageCommand(tabId, {
      type: 'submit.prepare',
      input,
      expected: target,
    })
  );
}

function restoreExpectedUrl(
  preparation: PageSubmissionPreparation,
  url: string
): PageSubmissionPreparation {
  if (!preparation.ok) return preparation;
  return {
    ok: true,
    prepared: {
      ...preparation.prepared,
      expected: { ...preparation.prepared.expected, url },
    },
  };
}

export async function clickPreparedTabSubmission(
  tabId: number,
  prepared: PreparedPageSubmission,
  frame?: CommentFrameReference
): Promise<PageSubmissionResult> {
  if (frame?.kind === 'jetpack') {
    return clickPreparedJetpackSubmission(tabId, prepared, frame);
  }
  let result: PageCommandResult;
  try {
    result = await sendPageCommand(tabId, {
      type: 'submit.click',
      prepared,
    });
  } catch {
    throw new Error('PAGE_SUBMISSION_NAVIGATION_IN_PROGRESS');
  }
  return readSubmission(result);
}

async function clickPreparedJetpackSubmission(
  tabId: number,
  prepared: PreparedPageSubmission,
  frame: CommentFrameReference
): Promise<PageSubmissionResult> {
  let resolved: ResolvedFrame | null;
  try {
    resolved = await resolveJetpackFrame(tabId, frame.url);
  } catch {
    // The frame already navigated away on submit: treat as an in-flight submit.
    throw new Error('PAGE_SUBMISSION_NAVIGATION_IN_PROGRESS');
  }
  if (!resolved) throw new Error('PAGE_SUBMISSION_NAVIGATION_IN_PROGRESS');
  let result: PageCommandResult;
  try {
    result = await sendFramePageCommand(tabId, resolved.frameId, {
      type: 'submit.click',
      prepared: {
        ...prepared,
        expected: { ...prepared.expected, url: resolved.url },
      },
    });
  } catch {
    throw new Error('PAGE_SUBMISSION_NAVIGATION_IN_PROGRESS');
  }
  return readSubmission(result);
}

export async function verifyTabSubmission(
  tabId: number,
  prepared: Pick<
    PreparedPageSubmission,
    'fingerprint' | 'baseline' | 'websiteUrl'
  >,
  expectedUrl: string
): Promise<PageSubmissionResult> {
  // Verifying a half-loaded page is how a published comment gets misread as a
  // failure; the in-page verdict poll only starts once the load settles.
  await waitForTabLoad(tabId);
  const current = await chrome.tabs.get(tabId).catch(() => null);
  // A redirect receipt proves the server took the comment, and carries the id
  // the anonymous read needs. It never proves the comment is public.
  const receipt = current
    ? readWordPressSubmitReceipt(current.url ?? '', expectedUrl)
    : null;
  if (
    !current ||
    !isAllowedSubmissionReturnUrl(current.url ?? '', expectedUrl)
  ) {
    throw new Error('PAGE_CHANGED_SINCE_SUBMISSION');
  }
  try {
    const result = readSubmission(
      await executePageCommand(tabId, {
        type: 'verify',
        fingerprint: prepared.fingerprint,
        baseline: prepared.baseline,
        expectedUrl,
        targetWebsiteUrl: prepared.websiteUrl ?? '',
      })
    );
    return await settlePublicly(result, receipt, prepared, expectedUrl);
  } catch (error) {
    if (!receipt) throw error;
    return await settlePublicly(
      acceptedSubmission(prepared.fingerprint),
      receipt,
      prepared,
      expectedUrl
    );
  }
}

export async function analyzeActivePage(): Promise<{
  tabId: number;
  analysis: PageAnalysis;
}> {
  const tab = await activeTab();
  const tabId = tab.id as number;
  return {
    tabId,
    analysis: await analyzeTab(tabId),
  };
}

export async function submitCurrentPage(
  input: PageSubmissionInput,
  target: PageSubmissionTarget
): Promise<PageSubmissionResult> {
  const tab = await activeTab();
  const tabId = tab.id as number;
  if (
    tabId !== target.tabId ||
    comparablePageUrl(tab.url ?? '') !== comparablePageUrl(target.url)
  ) {
    throw new Error('PAGE_CHANGED_SINCE_GENERATION');
  }
  if (activeSubmissionTabs.has(tabId)) {
    throw new Error('SUBMISSION_ALREADY_IN_PROGRESS');
  }
  activeSubmissionTabs.add(tabId);
  try {
    const expected = {
      url: target.url,
      editorLabel: target.editorLabel,
      submitLabel: target.submitLabel,
      hasWebsiteField: target.hasWebsiteField,
    };
    const preparation = readPreparation(
      await executePageCommand(tabId, {
        type: 'submit.prepare',
        input,
        expected,
      })
    );
    if (!preparation.ok) return preparation.result;

    try {
      return readSubmission(
        await sendPageCommand(tabId, {
          type: 'submit.click',
          prepared: preparation.prepared,
        })
      );
    } catch {
      await waitForTabLoad(tabId);
      const current = await chrome.tabs.get(tabId).catch(() => null);
      const receipt = current
        ? readWordPressSubmitReceipt(current.url ?? '', target.url)
        : null;
      if (
        !current ||
        !isAllowedSubmissionReturnUrl(current.url ?? '', target.url)
      ) {
        return unconfirmedSubmission(preparation.prepared.fingerprint);
      }
      const promoted = { websiteUrl: input.websiteUrl };
      try {
        const result = readSubmission(
          await executePageCommand(tabId, {
            type: 'verify',
            fingerprint: preparation.prepared.fingerprint,
            baseline: preparation.prepared.baseline,
            expectedUrl: target.url,
            targetWebsiteUrl: input.websiteUrl,
          })
        );
        return await settlePublicly(result, receipt, promoted, target.url);
      } catch {
        if (!receipt) {
          return unconfirmedSubmission(preparation.prepared.fingerprint);
        }
        return await settlePublicly(
          acceptedSubmission(preparation.prepared.fingerprint),
          receipt,
          promoted,
          target.url
        );
      }
    }
  } finally {
    activeSubmissionTabs.delete(tabId);
  }
}

function comparablePageUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

function isAllowedSubmissionReturnUrl(
  currentValue: string,
  expectedValue: string
): boolean {
  let current: URL;
  let expected: URL;
  try {
    current = new URL(currentValue);
    expected = new URL(expectedValue);
  } catch {
    return false;
  }
  if (
    current.origin !== expected.origin ||
    !matchesWordPressCommentPathname(current.pathname, expected.pathname)
  ) {
    return false;
  }

  const remaining = Array.from(current.searchParams.entries());
  for (const entry of expected.searchParams.entries()) {
    const index = remaining.findIndex(
      ([key, value]) => key === entry[0] && value === entry[1]
    );
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return remaining.every(([key]) =>
    ['unapproved', 'moderation-hash'].includes(key)
  );
}

function unconfirmedSubmission(fingerprint: string): PageSubmissionResult {
  return {
    status: 'unconfirmed',
    message: 'COMMENT_SUBMISSION_UNCONFIRMED',
    fingerprint,
    clickOccurred: true,
  };
}

/** The server took the comment; whether anyone else can see it is unknown. */
function acceptedSubmission(fingerprint: string): PageSubmissionResult {
  return {
    status: 'unconfirmed',
    message: 'COMMENT_ACCEPTED_AWAITING_PUBLIC_CHECK',
    fingerprint,
    clickOccurred: true,
    acceptance: 'server_receipt',
  };
}

/**
 * Turns acceptance into a verdict by reading the page as a stranger.
 *
 * Everything upstream of this function was observed inside the submitting
 * session, which the site treats differently from a visitor. Only what an
 * anonymous read finds may set `published`; a read that fails leaves the
 * in-page result alone rather than inventing either outcome.
 */
async function settlePublicly(
  result: PageSubmissionResult,
  receipt: WordPressReceipt | null,
  prepared: Pick<PreparedPageSubmission, 'websiteUrl'>,
  expectedUrl: string
): Promise<PageSubmissionResult> {
  const carried: PageSubmissionResult = receipt
    ? {
        ...result,
        receipt: {
          url: receipt.url,
          ...(receipt.commentId ? { commentId: receipt.commentId } : {}),
        },
      }
    : result;
  // The site said in its own redirect that it is holding the comment. A held
  // comment is not public by definition, so there is nothing left to read.
  if (receipt?.type === 'pending_moderation') {
    return {
      ...carried,
      status: 'pending_moderation',
      message: 'COMMENT_PENDING_WORDPRESS_MODERATION',
      clickOccurred: true,
    };
  }
  if (carried.status === 'pending_moderation') return carried;
  const websiteUrl = prepared.websiteUrl ?? '';
  const accepted =
    Boolean(receipt) ||
    Boolean(carried.acceptance) ||
    carried.status === 'published';
  // Nothing was accepted, or there is no promoted link to look for: a public
  // read has no question to answer.
  if (!accepted || !websiteUrl) return carried;
  const publicCheck = await checkPublicComment({
    // The receipt URL resolves to the right comment page by itself.
    pageUrl: receipt?.url ?? expectedUrl,
    websiteUrl,
    ...(receipt?.commentId ? { commentId: receipt.commentId } : {}),
  });
  if (publicCheck.visibility === 'visible') {
    return {
      ...carried,
      status: 'published',
      message: 'COMMENT_PUBLISHED_PUBLIC_CHECK',
      clickOccurred: true,
      publicCheck,
    };
  }
  // The comment is public and the link is not in it. Nothing to wait for.
  if (publicCheck.visibility === 'link_stripped') {
    return {
      ...carried,
      status: 'link_stripped',
      message: 'COMMENT_PUBLIC_LINK_STRIPPED',
      clickOccurred: true,
      publicCheck,
    };
  }
  if (publicCheck.visibility === 'not_visible') {
    return {
      ...carried,
      status: 'pending_moderation',
      message: 'COMMENT_ACCEPTED_NOT_PUBLIC_YET',
      clickOccurred: true,
      publicCheck,
    };
  }
  // Inconclusive: the page could not be read at all. Keep what the page said
  // and let the re-check job ask again later.
  return { ...carried, publicCheck };
}
