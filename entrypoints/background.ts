import { generateComment } from '@/api/client';
import { runHistoryRetry } from '@/batch/history-retry';
import { BATCH_RECOVERY_ALARM, armBatchRecoveryAlarm } from '@/batch/recovery';
import { type BatchStepResult, runBatchUntilBlocked } from '@/batch/runner';
import {
  createBatch,
  resumeBatch,
  retryItems,
  stopBatch,
  updateBatchProgress,
} from '@/batch/state';
import {
  handleRemovedWorkerTabSafely,
  openCurrentTargetSafely,
} from '@/batch/tab-coordinator';
import type { BatchSettingsSnapshot, BatchSnapshot } from '@/batch/types';
import { parseTargetUrls } from '@/batch/urls';
import { closeTerminalBatchWorker } from '@/batch/worker-cleanup';
import type {
  BackgroundResponse,
  PopupMessage,
  PopupMessageResult,
} from '@/runtime/messages';
import {
  closeOwnedWorkerTab,
  createOwnedWorkerTab,
  updateOwnedWorkerTab,
} from '@/runtime/owned-worker-tab';
import {
  analyzeActivePage,
  analyzeCurrentPage,
  submitCurrentPage,
} from '@/runtime/page-commands';
import { hasBatchOriginPermissions } from '@/runtime/permissions';
import { configureSidePanel } from '@/runtime/side-panel';
import { clearBatch, getBatch, setBatch } from '@/storage/batch';
import { archiveBatch, getBatchHistory } from '@/storage/batch-history';
import {
  getProviderApiKeys,
  getSettings,
  restrictStorageToTrustedContexts,
} from '@/storage/settings';
import {
  clearBatchStopIntent,
  consumeBatchStopIntent,
  getBatchStopIntent,
  requestBatchStop,
} from '@/storage/stop-intent';
import { releaseWorkerTab } from '@/storage/worker-tab-ownership';
import type { WebsiteProfile } from '@/website/profile';
import { loadWebsiteProfile } from '@/website/profile-cache';

type SendResponse = (response: BackgroundResponse) => void;

let runnerPromise: Promise<void> | null = null;
let rerunRequested = false;
let localWakeTimer: number | undefined;
let stopRequested = false;

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN_ERROR';
  return error.message.split(':', 1)[0] || 'UNKNOWN_ERROR';
}

function currentBatchItem(batch: BatchSnapshot) {
  return batch.items[batch.currentIndex] ?? null;
}

async function updateBatchBadge(batch?: BatchSnapshot | null): Promise<void> {
  const current = batch === undefined ? await getBatch() : batch;
  let text = '';
  let color = '#1f7253';
  if (current?.status === 'running') {
    text = `${current.currentIndex + 1}/${current.items.length}`;
  } else if (current?.status === 'paused') {
    text = '!';
    color = '#a66a09';
  } else if (current?.status === 'completed') {
    text = '✓';
  }
  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setBadgeBackgroundColor({ color }),
  ]);
}

function scheduleLocalWake(delayMs: number): void {
  if (localWakeTimer !== undefined) clearTimeout(localWakeTimer);
  localWakeTimer = self.setTimeout(() => {
    localWakeTimer = undefined;
    requestBatchWake();
  }, delayMs);
}

async function reconcileBatchWake(result: BatchStepResult): Promise<void> {
  let batch = await getBatch();
  if (batch) {
    batch = await closeTerminalBatchWorker(batch, {
      closeWorkerTab: closeOwnedWorkerTab,
      setBatch,
      now: Date.now,
    });
  }
  await updateBatchBadge(batch);
  if (batch?.status !== 'running') {
    if (localWakeTimer !== undefined) clearTimeout(localWakeTimer);
    localWakeTimer = undefined;
    await chrome.alarms.clear(BATCH_RECOVERY_ALARM);
    return;
  }

  if (result === 'continue') scheduleLocalWake(0);
}

function requestBatchWake(): void {
  if (stopRequested) return;
  rerunRequested = true;
  if (runnerPromise) return;

  runnerPromise = (async () => {
    if (await consumeBatchStopIntent()) {
      rerunRequested = false;
      await reconcileBatchWake('wait');
      return;
    }
    if (stopRequested) return;
    await armBatchRecoveryAlarm();
    while (rerunRequested) {
      rerunRequested = false;
      await reconcileBatchWake(
        await runBatchUntilBlocked(undefined, () => stopRequested)
      );
    }
  })()
    .catch(async () => {
      await chrome.action.setBadgeText({ text: '!' }).catch(() => undefined);
    })
    .finally(() => {
      runnerPromise = null;
      if (rerunRequested) requestBatchWake();
    });
}

async function prepareComment(): Promise<PopupMessageResult> {
  const [settings, keys, activePage] = await Promise.all([
    getSettings(),
    getProviderApiKeys(),
    analyzeActivePage(),
  ]);
  const { analysis, tabId } = activePage;
  if (!settings.websiteUrl) throw new Error('WEBSITE_URL_REQUIRED');
  if (analysis.form.readiness !== 'ready') {
    throw new Error(
      analysis.form.message || analysis.form.readiness.toUpperCase()
    );
  }

  const websiteProfile = await loadWebsiteProfile(settings.websiteUrl);
  const effectiveLinkMode =
    settings.linkMode === 'prefer-website-field' &&
    !analysis.form.hasWebsiteField
      ? 'inline'
      : settings.linkMode;
  const comment = await generateComment(keys, {
    provider: settings.provider,
    websiteProfile,
    targetPage: analysis.page,
    linkMode: effectiveLinkMode,
  });
  return {
    type: 'comment.prepare',
    data: {
      analysis,
      websiteProfile,
      comment,
      target: {
        tabId,
        url: analysis.page.url,
        editorLabel: analysis.form.editorLabel,
        submitLabel: analysis.form.submitLabel,
        hasWebsiteField: analysis.form.hasWebsiteField,
        fillWebsiteField:
          effectiveLinkMode === 'prefer-website-field' &&
          analysis.form.hasWebsiteField,
      },
    },
  };
}

// Shared start path for both the sidepanel-confirmed batch and history reruns.
// When a reviewed profile is supplied (batch.start) it is used as-is; otherwise
// the promoted site's profile is loaded through the 30-day cache (history rerun,
// which has no sidepanel preview payload). All start guards live here so callers
// never duplicate them.
async function startBatchFromBackground(
  targetText: string,
  settings: BatchSettingsSnapshot,
  websiteProfile?: WebsiteProfile
): Promise<BatchSnapshot> {
  const [keys, existing] = await Promise.all([
    getProviderApiKeys(),
    getBatch(),
  ]);
  if (!settings.websiteUrl) throw new Error('WEBSITE_URL_REQUIRED');
  if (settings.provider === 'deepseek' && !keys.deepseekApiKey) {
    throw new Error('DEEPSEEK_API_KEY_REQUIRED');
  }
  if (settings.provider === 'kie-gemini' && !keys.kieApiKey) {
    throw new Error('KIE_API_KEY_REQUIRED');
  }
  if (existing?.status === 'running' || existing?.status === 'paused') {
    throw new Error('BATCH_ALREADY_ACTIVE');
  }

  const targets = parseTargetUrls(targetText);
  if (!(await hasBatchOriginPermissions([settings.websiteUrl, ...targets]))) {
    throw new Error('ORIGIN_PERMISSION_REQUIRED');
  }

  const profile =
    websiteProfile ?? (await loadWebsiteProfile(settings.websiteUrl));
  let batch = createBatch({ targetText, settings });
  batch = updateBatchProgress(batch, { websiteProfile: profile });
  await setBatch(batch);
  requestBatchWake();
  return batch;
}

async function startBatch(
  message: Extract<PopupMessage, { type: 'batch.start' }>
): Promise<PopupMessageResult> {
  const settings = await getSettings();
  const data = await startBatchFromBackground(
    message.targetText,
    settings,
    message.websiteProfile
  );
  return { type: 'batch.start', data };
}

async function continueBatch(): Promise<PopupMessageResult> {
  const batch = await getBatch();
  if (!batch) throw new Error('BATCH_NOT_FOUND');
  const next = resumeBatch(batch);
  if (next !== batch) await setBatch(next);
  requestBatchWake();
  return { type: 'batch.continue', data: next };
}

async function stopCurrentBatch(): Promise<PopupMessageResult> {
  stopRequested = true;
  rerunRequested = false;
  try {
    await requestBatchStop();
    const activeRunner = runnerPromise;
    if (activeRunner) await activeRunner;
    const batch = await getBatch();
    if (!batch) {
      await clearBatchStopIntent();
      return { type: 'batch.stop', data: null };
    }
    let next = stopBatch(batch);
    if (next !== batch) await setBatch(next);
    next = await closeTerminalBatchWorker(next, {
      closeWorkerTab: closeOwnedWorkerTab,
      setBatch,
      now: Date.now,
    });
    await clearBatchStopIntent();
    if (localWakeTimer !== undefined) clearTimeout(localWakeTimer);
    localWakeTimer = undefined;
    await updateBatchBadge(next);
    await chrome.alarms.clear(BATCH_RECOVERY_ALARM);
    return { type: 'batch.stop', data: next };
  } finally {
    stopRequested = false;
  }
}

async function retryBatchItems(
  message: Extract<PopupMessage, { type: 'batch.retry-items' }>
): Promise<PopupMessageResult> {
  const batch = await getBatch();
  if (!batch) throw new Error('BATCH_NOT_FOUND');
  const next = retryItems(batch, message.itemIds);
  await setBatch(next);
  // The finished run may have left a stop-intent flag behind (e.g. a service
  // worker torn down mid-stop). Clear it so the fresh run is not immediately
  // re-stopped by consumeBatchStopIntent on the next wake.
  await clearBatchStopIntent();
  requestBatchWake();
  return { type: 'batch.retry-items', data: next };
}

async function resetBatch(): Promise<PopupMessageResult> {
  const batch = await getBatch();
  if (batch?.status === 'running' || batch?.status === 'paused') {
    throw new Error('BATCH_ALREADY_ACTIVE');
  }
  // Preserve the finished batch in history before discarding it, so a reset is
  // no longer destructive.
  if (batch) await archiveBatch(batch);
  await clearBatch();
  await updateBatchBadge(null);
  return { type: 'batch.reset', data: null };
}

async function retryFromHistory(
  message: Extract<PopupMessage, { type: 'batch.retry-from-history' }>
): Promise<PopupMessageResult> {
  const data = await runHistoryRetry(
    {
      getBatchHistory,
      getBatch,
      archiveBatch,
      clearBatch,
      startBatch: (targetText, settings) =>
        startBatchFromBackground(targetText, settings),
    },
    message.historyId,
    message.urls
  );
  return { type: 'batch.retry-from-history', data };
}

async function openCurrentBatchTarget(): Promise<PopupMessageResult> {
  const data = await openCurrentTargetSafely({
    getActiveRunner: () => runnerPromise,
    getBatch,
    setBatch,
    getBatchStopIntent,
    activateTab: async (batchId, tabId) =>
      Boolean(await updateOwnedWorkerTab(batchId, tabId, { active: true })),
    createTab: async (batchId, url) => {
      const tab = await createOwnedWorkerTab(batchId, url);
      if (typeof tab.id !== 'number') return null;
      await updateOwnedWorkerTab(batchId, tab.id, { active: true });
      return tab.id;
    },
    requestBatchWake,
    isStopRequested: () => stopRequested,
    now: Date.now,
  });
  return { type: 'batch.open-current', data };
}

async function dispatch(message: PopupMessage): Promise<PopupMessageResult> {
  if (message.type === 'page.analyze') {
    return { type: message.type, data: await analyzeCurrentPage() };
  }
  if (message.type === 'comment.prepare') return prepareComment();
  if (message.type === 'batch.preview') {
    return {
      type: message.type,
      data: await loadWebsiteProfile(message.websiteUrl, {
        refresh: message.refresh === true,
      }),
    };
  }
  if (message.type === 'batch.start') return startBatch(message);
  if (message.type === 'batch.continue') return continueBatch();
  if (message.type === 'batch.stop') return stopCurrentBatch();
  if (message.type === 'batch.reset') return resetBatch();
  if (message.type === 'batch.retry-items') return retryBatchItems(message);
  if (message.type === 'batch.retry-from-history') {
    return retryFromHistory(message);
  }
  if (message.type === 'batch.open-current') {
    return openCurrentBatchTarget();
  }

  const settings = await getSettings();
  const result = await submitCurrentPage(
    {
      comment: message.comment,
      displayName: settings.displayName || undefined,
      email: settings.email || undefined,
      websiteUrl: message.target.fillWebsiteField ? settings.websiteUrl : '',
    },
    message.target
  );
  return { type: message.type, data: result };
}

async function handleWorkerTabRemoved(tabId: number): Promise<void> {
  await releaseWorkerTab(tabId);
  await handleRemovedWorkerTabSafely(tabId, { getBatch, requestBatchWake });
}

export default defineBackground({
  type: 'module',
  main() {
    const storageReady = restrictStorageToTrustedContexts();
    void configureSidePanel(chrome.sidePanel);

    chrome.runtime.onMessage.addListener(
      (message: PopupMessage, _sender, sendResponse: SendResponse) => {
        void storageReady
          .then(() => dispatch(message))
          .then((data) => sendResponse({ ok: true, data }))
          .catch((error: unknown) => {
            sendResponse({
              ok: false,
              error: {
                code: errorCode(error),
                message:
                  error instanceof Error ? error.message : 'Unknown error',
              },
            });
          });
        return true;
      }
    );

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === BATCH_RECOVERY_ALARM) requestBatchWake();
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status !== 'complete') return;
      void getBatch().then((batch) => {
        if (batch?.workerTabId === tabId) requestBatchWake();
      });
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      void handleWorkerTabRemoved(tabId);
    });
    chrome.runtime.onStartup.addListener(requestBatchWake);
    chrome.runtime.onInstalled.addListener(requestBatchWake);

    void storageReady.then(() => {
      requestBatchWake();
      return updateBatchBadge();
    });
  },
});
