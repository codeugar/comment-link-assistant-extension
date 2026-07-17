import {
  PAGE_COMMAND_MESSAGE_TYPE,
  type PageCommand,
  type PageCommandResult,
} from '@/page/command';
import {
  hasWordPressSubmitReceipt,
  matchesWordPressCommentPathname,
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

const PAGE_COMMAND_SCRIPT = 'content-scripts/page-command.js';
const PAGE_COMMAND_TIMEOUT_MS = 10_000;
const JETPACK_COMMENT_FRAME_HOST = 'jetpack.wordpress.com';
const JETPACK_COMMENT_FRAME_PATH = '/jetpack-comment';
// A promoted Jetpack frame commits asynchronously after analyze sets its src, so
// poll webNavigation for it rather than assuming it is already listed.
const JETPACK_FRAME_RESOLVE_TIMEOUT_MS = 8_000;
const JETPACK_FRAME_POLL_INTERVAL_MS = 250;
// A read-only analyze now self-settles heavy pages (bounded DOMContentLoaded +
// mutation waits) and has no double-submit risk, so it gets generous headroom.
// Mutating commands (submit.prepare / submit.click / verify) keep
// the tight 10s bound.
const ANALYZE_COMMAND_TIMEOUT_MS = 30_000;
const activeSubmissionTabs = new Set<number>();

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
  await withPageCommandTimeout(
    chrome.scripting.executeScript({
      target: { tabId },
      files: [PAGE_COMMAND_SCRIPT],
      // Without this the injection waits for document_idle, which a heavy
      // still-loading page can push past the command timeout.
      injectImmediately: true,
    }),
    commandTimeout(command)
  );
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
  await withPageCommandTimeout(
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: [PAGE_COMMAND_SCRIPT],
    }),
    commandTimeout(command)
  );
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
  prepared: Pick<PreparedPageSubmission, 'fingerprint' | 'baseline'>,
  expectedUrl: string
): Promise<PageSubmissionResult> {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  // The WordPress redirect receipt on the tab URL is authoritative and needs
  // no content script — the page may still be loading and stay unreachable
  // long past the command timeout.
  if (current && hasWordPressSubmitReceipt(current.url ?? '', expectedUrl)) {
    return {
      status: 'submitted',
      message: 'COMMENT_SUBMITTED',
      fingerprint: prepared.fingerprint,
      clickOccurred: true,
    };
  }
  if (
    !current ||
    !isAllowedSubmissionReturnUrl(current.url ?? '', expectedUrl)
  ) {
    throw new Error('PAGE_CHANGED_SINCE_SUBMISSION');
  }
  return readSubmission(
    await executePageCommand(tabId, {
      type: 'verify',
      fingerprint: prepared.fingerprint,
      baseline: prepared.baseline,
      expectedUrl,
    })
  );
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
      if (
        !current ||
        !isAllowedSubmissionReturnUrl(current.url ?? '', target.url)
      ) {
        return unconfirmedSubmission(preparation.prepared.fingerprint);
      }
      return readSubmission(
        await executePageCommand(tabId, {
          type: 'verify',
          fingerprint: preparation.prepared.fingerprint,
          baseline: preparation.prepared.baseline,
          expectedUrl: target.url,
        })
      );
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
    status: 'submitted',
    message: 'COMMENT_SUBMITTED',
    fingerprint,
    clickOccurred: true,
  };
}
