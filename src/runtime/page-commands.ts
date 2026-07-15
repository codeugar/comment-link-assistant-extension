import {
  PAGE_COMMAND_MESSAGE_TYPE,
  type PageCommand,
  type PageCommandResult,
} from '@/page/command';
import type {
  PageAnalysis,
  PageSubmissionExpectation,
  PageSubmissionInput,
  PageSubmissionPreparation,
  PageSubmissionResult,
  PageSubmissionTarget,
  PreparedPageSubmission,
} from '@/page/types';

const PAGE_COMMAND_SCRIPT = 'content-scripts/page-command.js';
const activeSubmissionTabs = new Set<number>();

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
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [PAGE_COMMAND_SCRIPT],
  });
  return sendPageCommand(tabId, command);
}

async function sendPageCommand(
  tabId: number,
  command: PageCommand
): Promise<PageCommandResult> {
  const result = (await chrome.tabs.sendMessage(tabId, {
    type: PAGE_COMMAND_MESSAGE_TYPE,
    command,
  })) as PageCommandResult | undefined;
  if (!result) throw new Error('PAGE_COMMAND_NO_RESULT');
  return result;
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
  return readAnalysis(await executePageCommand(tabId, { type: 'analyze' }));
}

export async function prepareTabSubmission(
  tabId: number,
  input: PageSubmissionInput,
  target: PageSubmissionExpectation
): Promise<PageSubmissionPreparation> {
  return readPreparation(
    await executePageCommand(tabId, {
      type: 'submit.prepare',
      input,
      expected: target,
    })
  );
}

export async function clickPreparedTabSubmission(
  tabId: number,
  prepared: PreparedPageSubmission
): Promise<PageSubmissionResult> {
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

export async function verifyTabSubmission(
  tabId: number,
  prepared: Pick<PreparedPageSubmission, 'fingerprint' | 'baseline'>,
  expectedUrl: string
): Promise<PageSubmissionResult> {
  const current = await chrome.tabs.get(tabId).catch(() => null);
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
    current.pathname !== expected.pathname
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
    status: 'unknown',
    message: 'COMMENT_SUBMISSION_UNCONFIRMED',
    fingerprint,
    clickOccurred: true,
  };
}
