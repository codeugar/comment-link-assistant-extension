import { generateComment, generateNaturalAnchorTexts } from '@/api/client';
import { ensureIdleAndArchive } from '@/batch/batch-lifecycle';
import { isDueToday, markChunkDone, splitIntoChunks } from '@/batch/plan';
import { BATCH_RECOVERY_ALARM, armBatchRecoveryAlarm } from '@/batch/recovery';
import {
  type BatchRunnerDependencies,
  type BatchStepResult,
  defaultDependencies as defaultRunnerDependencies,
  runBatchUntilBlocked,
} from '@/batch/runner';
import {
  createBatch,
  filterQueuedItems,
  resumeBatch,
  resumeStoppedBatch,
  skipCurrentManualGate,
  stopBatch,
  updateBatchProgress,
} from '@/batch/state';
import {
  handleRemovedWorkerTabSafely,
  openCurrentTargetSafely,
} from '@/batch/tab-coordinator';
import type {
  BatchItem,
  BatchSettingsSnapshot,
  BatchSnapshot,
} from '@/batch/types';
import { TargetUrlError, parseTargetUrls } from '@/batch/urls';
import { createDashboardRepository } from '@/dashboard/db';
import { processLegacyDashboardStorage } from '@/dashboard/legacy-bootstrap';
import { migrateLegacyDashboardData } from '@/dashboard/migration';
import type { Plan, PlanBatch, PlanTarget } from '@/dashboard/model';
import {
  type ModerationRecheckDashboardData,
  type ModerationRecheckLastRun,
  PENDING_MODERATION_RECHECK_ALARM,
  PendingModerationRecheckCoordinator,
  addManualModerationEntry,
  armPendingModerationRecheckAlarm,
  createPublicCommentPort,
  loadManualModerationEntries,
  loadModerationRecheckLastRun,
  loadModerationRecheckSettings,
  moderationResultFromPublicCheck,
  publicCommentCriterion,
  recheckManualModerationEntry,
  runManualModerationRechecks,
  saveModerationRecheckLastRun,
  saveModerationRecheckSettings,
} from '@/dashboard/moderation-recheck';
import { buildPlanBatchSettingsSnapshot } from '@/dashboard/plan-settings';
import {
  type DashboardActiveRunReference,
  DashboardService,
  isDashboardPlanRunReference,
  shouldSettlePlanBatch,
} from '@/dashboard/service';
import type { ModerationCheckResult } from '@/page/types';
import type {
  BackgroundResponse,
  DashboardPlanCreateMessage,
  PopupMessage,
  PopupMessageResult,
} from '@/runtime/messages';
import {
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
import {
  ANCHOR_LEDGER_STORAGE_KEY,
  getAnchorLedgers,
  resolveAnchorPending,
} from '@/storage/anchor-ledger';
import { ANCHOR_PLAN_STORAGE_KEY, getAnchorPlans } from '@/storage/anchor-plan';
import { clearBatch, getBatch, setBatch } from '@/storage/batch';
import {
  HISTORY_STORAGE_KEY,
  archiveBatch,
  getBatchHistory,
} from '@/storage/batch-history';
import {
  type DataBackupFile,
  buildDataBackup,
  clearFirstRunPending,
  markFirstRunPending,
  parseDataBackupFile,
} from '@/storage/data-backup';
import {
  FILTER_LIST_STORAGE_KEY,
  addFilterListEntry,
  addFilterListEntryWithResult,
  findMatchingFilterEntry,
  getFilterList,
  isTargetFiltered,
  removeFilterListEntry,
} from '@/storage/filter-list';
import {
  OUTBOUND_LINK_LIBRARY_STORAGE_KEY,
  addOutboundLinkLibraryEntry,
  getOutboundLinkLibrary,
  removeOutboundLinkLibraryEntry,
  updateOutboundLinkLibraryEntry,
} from '@/storage/outbound-link-library';
import {
  type PlansMap,
  type SitePlan,
  deletePlan,
  getPlans,
  savePlan,
  setPlans,
} from '@/storage/plans';
import {
  PROVIDER_API_KEYS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  getActiveSite,
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
import { loadWebsiteProfile } from '@/website/profile-cache';

type SendResponse = (response: BackgroundResponse) => void;

let runnerPromise: Promise<void> | null = null;
let rerunRequested = false;
let localWakeTimer: number | undefined;
let stopRequested = false;
// Cancels the in-flight LLM generation when the user stops the batch. Page
// commands have no cancellation channel; their late results are dropped by the
// guarded setBatch below instead.
let runnerAbort = new AbortController();

// The stop handler persists the terminal `stopped` snapshot without waiting
// for the in-flight step. Until that step's runner settles, its progress
// writes must not resurrect the batch.
const runnerDependencies: BatchRunnerDependencies = {
  ...defaultRunnerDependencies,
  setBatch: async (batch) =>
    stopRequested ? batch : defaultRunnerDependencies.setBatch(batch),
  generateComment: (keys, input) =>
    generateComment(keys, input, { signal: runnerAbort.signal }),
};
let dashboardPlanOperationTail: Promise<void> = Promise.resolve();
let pendingModerationRecheckPromise: Promise<ModerationRecheckLastRun> | null =
  null;

function serializeDashboardPlanOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const queued = dashboardPlanOperationTail.then(operation, operation);
  dashboardPlanOperationTail = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

type DashboardRepository = ReturnType<typeof createDashboardRepository>;

let dashboardRepositoryInstance: DashboardRepository | null = null;
let dashboardServiceInstance: DashboardService | null = null;

function lazyObject<T extends object>(load: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const target = load();
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const dashboardRepository = lazyObject<DashboardRepository>(() => {
  if (!dashboardRepositoryInstance) {
    dashboardRepositoryInstance = createDashboardRepository();
  }
  return dashboardRepositoryInstance;
});

const dashboardService = lazyObject<DashboardService>(() => {
  if (!dashboardServiceInstance) {
    dashboardServiceInstance = new DashboardService({
      repository: dashboardRepository,
    });
  }
  return dashboardServiceInstance;
});
let dashboardReadyPromise: Promise<void> | null = null;

function sameDashboardRunReference(
  left: DashboardActiveRunReference,
  right: DashboardActiveRunReference
): boolean {
  if (
    left.kind !== right.kind ||
    left.runId !== right.runId ||
    left.externalBatchId !== right.externalBatchId
  ) {
    return false;
  }
  return (
    !isDashboardPlanRunReference(left) ||
    (isDashboardPlanRunReference(right) &&
      left.planId === right.planId &&
      left.batchId === right.batchId)
  );
}

function ensureDashboardReady(): Promise<void> {
  if (!dashboardReadyPromise) {
    dashboardReadyPromise = (async () => {
      const currentBatch = await getBatch();
      await processLegacyDashboardStorage(
        chrome.storage.local,
        async ({ plans, history }) => {
          const migration = await migrateLegacyDashboardData(
            dashboardRepository,
            plans,
            history,
            currentBatch
          );
          if (!migration.verified) {
            throw new Error('DASHBOARD_MIGRATION_INVALID');
          }
          let restoredReference: DashboardActiveRunReference | null = null;
          if (migration.activeRunReference) {
            await dashboardService.restoreActiveRunReference(
              migration.activeRunReference
            );
            restoredReference = migration.activeRunReference;
          } else if (currentBatch) {
            restoredReference =
              await dashboardService.restoreActiveRunReferenceForExternalBatch(
                currentBatch.id
              );
          }
          if (
            migration.activeRunReference &&
            (!restoredReference ||
              !sameDashboardRunReference(
                restoredReference,
                migration.activeRunReference
              ))
          ) {
            throw new Error('DASHBOARD_ACTIVE_RUN_RESTORE_FAILED');
          }
          let syncedActiveBatch = false;
          if (currentBatch && restoredReference) {
            const synced = await dashboardService.syncActiveBatch(currentBatch);
            if (!synced) throw new Error('DASHBOARD_ACTIVE_RUN_SYNC_FAILED');
            syncedActiveBatch = true;
          } else if (currentBatch && currentBatch.status !== 'completed') {
            // An old quick batch may predate the migration marker and have no
            // associated SitePlan. Give it a standalone run before it continues.
            await dashboardService.startStandaloneBatchRun(currentBatch);
            syncedActiveBatch = true;
          }
          if (migration.imported) {
            await dashboardService.bumpRevision();
          }
          // Legacy plan definitions are now represented in IndexedDB. Keep the
          // compact sidepanel history temporarily so standalone legacy runs remain
          // diagnosable while that history UI has not moved to the dashboard yet.
          return {
            removeLegacyPlans:
              !currentBatch ||
              currentBatch.status === 'completed' ||
              syncedActiveBatch,
          };
        }
      );
    })().catch((error: unknown) => {
      dashboardReadyPromise = null;
      throw error;
    });
  }
  return dashboardReadyPromise;
}
function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN_ERROR';
  return error.message.split(':', 1)[0] || 'UNKNOWN_ERROR';
}

function signalDeferredDashboardBootstrap(): void {
  void Promise.all([
    chrome.action.setBadgeText({ text: '!' }),
    chrome.action.setBadgeBackgroundColor({ color: '#a66a09' }),
  ]).catch(() => undefined);
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

// Marks whichever plan chunk a finished batch was running as done. Cheap and
// idempotent: no-op when there are no plans or none owns this batch id.
async function settlePlanChunk(batchId: string): Promise<void> {
  const plans = await getPlans();
  const now = Date.now();
  let changed = false;
  const next: PlansMap = { ...plans };
  for (const [siteId, plan] of Object.entries(plans)) {
    const updated = markChunkDone(plan, batchId, now);
    if (updated !== plan) {
      next[siteId] = updated;
      changed = true;
    }
  }
  if (changed) await setPlans(next);
}

// Layers a due-plan indicator on top of the batch badge. An active batch's
// progress badge always wins; when idle, a due plan shows '!' and otherwise the
// batch badge (✓ / empty) is restored.
async function updateDueBadge(
  knownBatch?: BatchSnapshot | null
): Promise<void> {
  const batch = knownBatch === undefined ? await getBatch() : knownBatch;
  if (batch?.status === 'running' || batch?.status === 'paused') return;
  const plans = await getPlans();
  const now = Date.now();
  const due = Object.values(plans).some((plan) => isDueToday(plan, now));
  if (due) {
    await Promise.all([
      chrome.action.setBadgeText({ text: '!' }),
      chrome.action.setBadgeBackgroundColor({ color: '#a66a09' }),
    ]);
    return;
  }
  await updateBatchBadge(batch);
}

function requestPendingModerationRecheck(): Promise<ModerationRecheckLastRun> {
  if (pendingModerationRecheckPromise) return pendingModerationRecheckPromise;
  const startedAt = Date.now();
  pendingModerationRecheckPromise = ensureDashboardReady()
    .then(async () => {
      const settings = await loadModerationRecheckSettings();
      const coordinator = new PendingModerationRecheckCoordinator(
        dashboardService,
        createPublicCommentPort(),
        settings.maxChecksPerRun,
        async (check) => {
          await resolveAnchorPending(
            check.promotingSiteId,
            check.url,
            'published'
          );
        },
        // The comment is public and the link is not, so the slot this link was
        // holding is released rather than credited.
        async (check) => {
          await resolveAnchorPending(
            check.promotingSiteId,
            check.url,
            'dropped'
          );
        }
      );
      const storedResult = await coordinator.run();
      const manualResult = await runManualModerationRechecks(
        createPublicCommentPort(),
        settings.maxChecksPerRun - storedResult.selected
      );
      const result = {
        selected: storedResult.selected + manualResult.selected,
        checked: storedResult.checked + manualResult.checked,
        published: storedResult.published + manualResult.published,
        linkStripped: storedResult.linkStripped + manualResult.linkStripped,
        stillPending: storedResult.stillPending + manualResult.stillPending,
      };
      const lastRun: ModerationRecheckLastRun = {
        ...result,
        startedAt,
        completedAt: Date.now(),
      };
      await saveModerationRecheckLastRun(lastRun);
      return lastRun;
    })
    .finally(() => {
      pendingModerationRecheckPromise = null;
    });
  return pendingModerationRecheckPromise;
}

async function armConfiguredModerationRecheckAlarm(): Promise<void> {
  await armPendingModerationRecheckAlarm(
    chrome.alarms,
    await loadModerationRecheckSettings()
  );
}

async function getModerationRecheckDashboard(): Promise<ModerationRecheckDashboardData> {
  const [settings, lastRun, pending, published, manual, alarm] =
    await Promise.all([
      loadModerationRecheckSettings(),
      loadModerationRecheckLastRun(),
      dashboardService.getPendingModerationChecks(100),
      dashboardService.getRecentModerationTransitions(50),
      loadManualModerationEntries(),
      chrome.alarms.get(PENDING_MODERATION_RECHECK_ALARM),
    ]);
  return {
    settings,
    running: pendingModerationRecheckPromise !== null,
    pending: [
      ...pending.map((item) => ({
        id: `plan:${item.targetId}`,
        source: 'plan' as const,
        ...item,
      })),
      ...manual
        .filter((entry) => entry.status === 'pending_moderation')
        .map((entry) => ({
          id: entry.id,
          source: 'manual' as const,
          url: entry.pageUrl,
          fingerprint: entry.targetWebsiteUrl,
          targetWebsiteUrl: entry.targetWebsiteUrl,
          checkCount: entry.checkCount,
          needsCommentPermalink: entry.needsCommentPermalink,
          ...(entry.lastCheckAt ? { lastCheckAt: entry.lastCheckAt } : {}),
          ...(entry.lastCheckMessage
            ? { lastCheckMessage: entry.lastCheckMessage }
            : {}),
        })),
    ],
    published: [
      ...published.map((item) => ({
        id: `plan:${item.targetId}:${item.publishedAt}`,
        source: 'plan' as const,
        ...item,
      })),
      // Only real publications belong here: this list drives the "now
      // published" counter, and a comment whose link was stripped is counted as
      // a failure everywhere else.
      ...manual
        .filter((entry) => entry.status === 'published' && entry.publishedAt)
        .map((entry) => ({
          id: entry.id,
          source: 'manual' as const,
          url: entry.pageUrl,
          fingerprint: entry.targetWebsiteUrl,
          targetWebsiteUrl: entry.targetWebsiteUrl,
          checkCount: entry.checkCount,
          publishedAt: entry.publishedAt as number,
          message:
            entry.lastCheckMessage ?? 'COMMENT_PUBLISHED_RENDERED_TARGET_URL',
        })),
    ].sort((left, right) => right.publishedAt - left.publishedAt),
    ...(lastRun ? { lastRun } : {}),
    ...(alarm?.scheduledTime ? { nextRunAt: alarm.scheduledTime } : {}),
  };
}

async function recheckDashboardTarget(
  planId: string,
  targetId: string
): Promise<ModerationCheckResult> {
  const [target, planDetail] = await Promise.all([
    dashboardService.getTargetWithAttempts(planId, targetId),
    dashboardService.getPlanDetail(planId),
  ]);
  const attempt = [...target.attempts]
    .sort(
      (left, right) =>
        right.attemptNumber - left.attemptNumber ||
        right.updatedAt - left.updatedAt
    )
    .find((candidate) => candidate.commentFingerprint || candidate.comment);
  const fingerprint =
    attempt?.commentFingerprint ??
    attempt?.comment?.trim().replace(/\s+/g, ' ').slice(0, 80) ??
    '';
  if (!attempt || !fingerprint) {
    throw new Error('COMMENT_FINGERPRINT_MISSING');
  }
  let result: ModerationCheckResult;
  try {
    result = moderationResultFromPublicCheck(
      await createPublicCommentPort().check({
        pageUrl: attempt.receipt?.url ?? target.url,
        fingerprint,
        criterion: publicCommentCriterion(
          attempt.linkMode,
          planDetail.plan.promotingWebsiteUrl
        ),
        ...(attempt.receipt?.commentId
          ? { commentId: attempt.receipt.commentId }
          : {}),
      }),
      fingerprint
    );
  } catch {
    result = {
      status: 'pending_moderation',
      message: 'COMMENT_PENDING_MODERATION_RECHECK_UNAVAILABLE',
      fingerprint,
    };
  }
  await dashboardService.recordModerationCheck({
    targetId: target.id,
    attemptId: attempt.id,
    // `published` and `link_stripped` are both terminal; anything else leaves
    // the row pending. Collapsing them all to pending kept a settled comment in
    // the re-check queue for good.
    status:
      result.status === 'published' || result.status === 'link_stripped'
        ? result.status
        : 'pending_moderation',
    message: result.message,
    preserveCurrentStatus: true,
  });
  return result;
}

function scheduleLocalWake(delayMs: number): void {
  if (localWakeTimer !== undefined) clearTimeout(localWakeTimer);
  localWakeTimer = self.setTimeout(() => {
    localWakeTimer = undefined;
    requestBatchWake();
  }, delayMs);
}

async function reconcileBatchWake(result: BatchStepResult): Promise<void> {
  // #11 keeps the worker tab open at terminal — no closeTerminalBatchWorker.
  const batch = await getBatch();
  if (batch) {
    await ensureDashboardReady();
    await dashboardService.syncActiveBatch(batch);
  }
  if (batch && shouldSettlePlanBatch(batch)) {
    await settlePlanChunk(batch.id);
  }
  await updateBatchBadge(batch);
  await updateDueBadge(batch);
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
      await ensureDashboardReady();
      rerunRequested = false;
      await reconcileBatchWake('wait');
      return;
    }
    if (stopRequested) return;
    await armBatchRecoveryAlarm();
    while (rerunRequested) {
      rerunRequested = false;
      await reconcileBatchWake(
        await runBatchUntilBlocked(runnerDependencies, () => stopRequested)
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

// Start/continue explicitly countermand a prior stop. While the stopped
// runner's last step is still in flight, the wake is chained behind it so the
// fresh run never races the old step's (dropped) writes.
function wakeCountermandingStop(): void {
  const activeRunner = runnerPromise;
  if (stopRequested && activeRunner) {
    void activeRunner.finally(() => {
      stopRequested = false;
      requestBatchWake();
    });
    return;
  }
  stopRequested = false;
  requestBatchWake();
}

async function prepareComment(): Promise<PopupMessageResult> {
  const [settings, keys, activePage] = await Promise.all([
    getSettings(),
    getProviderApiKeys(),
    analyzeActivePage(),
  ]);
  const { analysis, tabId } = activePage;
  const site = getActiveSite(settings);
  if (!site.websiteUrl) throw new Error('WEBSITE_URL_REQUIRED');
  if (analysis.form.readiness !== 'ready') {
    throw new Error(
      analysis.form.message || analysis.form.readiness.toUpperCase()
    );
  }

  const websiteProfile = await loadWebsiteProfile(site.websiteUrl);
  const generated = await generateComment(keys, {
    provider: settings.provider,
    websiteProfile,
    targetPage: analysis.page,
    linkMode: site.linkMode,
  });
  return {
    type: 'comment.prepare',
    data: {
      analysis,
      websiteProfile,
      comment: generated.comment,
      target: {
        tabId,
        url: analysis.page.url,
        editorLabel: analysis.form.editorLabel,
        submitLabel: analysis.form.submitLabel,
        hasWebsiteField: analysis.form.hasWebsiteField,
        fillWebsiteField:
          site.linkMode !== 'comment-only' && analysis.form.hasWebsiteField,
      },
    },
  };
}

// The single start path for a run. The promoted site's profile is always loaded
// from the site named by this run's own settings snapshot, through the 30-day
// cache — no caller supplies one, so a profile reviewed for one site can never
// be carried into a run for another. All start guards live here so callers never
// duplicate them.
async function startBatchFromBackground(
  targetText: string,
  settings: BatchSettingsSnapshot,
  wake = true,
  trackStandalone = false
): Promise<BatchSnapshot> {
  const [keys, existing, filterEntries] = await Promise.all([
    getProviderApiKeys(),
    getBatch(),
    getFilterList(),
  ]);
  if (existing?.status === 'running' || existing?.status === 'paused') {
    throw new Error('BATCH_ALREADY_ACTIVE');
  }

  const targets = parseTargetUrls(targetText);
  const filteredUrls = new Set(
    targets.filter((target) =>
      Boolean(findMatchingFilterEntry(target, filterEntries))
    )
  );
  const runnableTargets = targets.filter((target) => !filteredUrls.has(target));
  if (runnableTargets.length > 0 && !settings.websiteUrl) {
    throw new Error('WEBSITE_URL_REQUIRED');
  }
  if (
    runnableTargets.length > 0 &&
    settings.provider === 'deepseek' &&
    !keys.deepseekApiKey
  ) {
    throw new Error('DEEPSEEK_API_KEY_REQUIRED');
  }
  if (
    runnableTargets.length > 0 &&
    settings.provider === 'kie-gemini' &&
    !keys.kieApiKey
  ) {
    throw new Error('KIE_API_KEY_REQUIRED');
  }
  if (
    runnableTargets.length > 0 &&
    !(await hasBatchOriginPermissions([
      settings.websiteUrl,
      ...runnableTargets,
    ]))
  ) {
    throw new Error('ORIGIN_PERMISSION_REQUIRED');
  }

  let batch = createBatch({ targetText, settings });
  if (runnableTargets.length > 0) {
    const profile = await loadWebsiteProfile(settings.websiteUrl);
    batch = updateBatchProgress(batch, { websiteProfile: profile });
  }
  batch = filterQueuedItems(batch, filteredUrls);
  // A stale stop intent (a stop whose cleanup was interrupted) must not be
  // consumed by this fresh run's first wake and kill it instantly.
  await clearBatchStopIntent();
  await setBatch(batch);
  if (trackStandalone) {
    try {
      await dashboardService.startStandaloneBatchRun(batch);
    } catch (error) {
      if (existing) await setBatch(existing);
      else await clearBatch();
      throw error;
    }
  }
  if (wake) wakeCountermandingStop();
  return batch;
}

async function continueBatch(): Promise<PopupMessageResult> {
  const batch = await getBatch();
  if (!batch) throw new Error('BATCH_NOT_FOUND');
  await clearBatchStopIntent();
  const next = resumeBatch(batch);
  if (next !== batch) await setBatch(next);
  wakeCountermandingStop();
  return { type: 'batch.continue', data: next };
}

async function skipCurrentBatchManualGate(): Promise<PopupMessageResult> {
  const batch = await getBatch();
  if (!batch) throw new Error('BATCH_NOT_FOUND');
  const next = skipCurrentManualGate(batch);
  await setBatch(next);
  requestBatchWake();
  return { type: 'batch.skip-current', data: next };
}

// Writes the terminal `stopped` snapshot and answers immediately instead of
// awaiting the in-flight step (which can block for minutes on an unabortable
// page command). The guarded runner setBatch drops that step's late writes,
// and `stopRequested` stays raised until the runner actually settles.
async function stopCurrentBatch(): Promise<PopupMessageResult> {
  stopRequested = true;
  rerunRequested = false;
  const activeRunner = runnerPromise;
  runnerAbort.abort();
  runnerAbort = new AbortController();
  try {
    await requestBatchStop();
    const batch = await getBatch();
    if (!batch) {
      await clearBatchStopIntent();
      return { type: 'batch.stop', data: null };
    }
    const next = stopBatch(batch);
    if (next !== batch) await setBatch(next);
    // #11 keeps the worker tab open at terminal — no closeTerminalBatchWorker.
    try {
      await dashboardService.syncActiveBatch(next);
    } catch {
      // The stop must stay terminal even when the dashboard sync fails; the
      // recovery alarm re-syncs on a later tick.
    }
    await clearBatchStopIntent();
    if (localWakeTimer !== undefined) clearTimeout(localWakeTimer);
    localWakeTimer = undefined;
    await updateBatchBadge(next);
    await updateDueBadge(next);
    await chrome.alarms.clear(BATCH_RECOVERY_ALARM);
    return { type: 'batch.stop', data: next };
  } finally {
    if (activeRunner) {
      void activeRunner.finally(() => {
        stopRequested = false;
      });
    } else {
      stopRequested = false;
    }
  }
}

// Picks a stopped run back up from the surface that stopped it, without needing
// the plan it belongs to. A stop is not a discard: unfinished targets go back to
// the queue, while a target whose click was already dispatched keeps its
// prepared payload so the resume verifies that click instead of commenting a
// second time (resumeStoppedBatch owns that distinction).
async function resumeCurrentBatch(): Promise<PopupMessageResult> {
  const current = await getBatch();
  if (!current) throw new Error('BATCH_NOT_FOUND');
  if (current.status !== 'stopped') throw new Error('BATCH_RESUME_UNAVAILABLE');

  // resumeStoppedBatch is the authority on whether anything is left to run; it
  // raises BATCH_NOT_RUNNABLE below. Permissions are asked for the wider set of
  // targets this run could still open.
  await validateResumePermissions(
    current,
    unsettledItems(current).map((item) => item.url)
  );

  await ensureDashboardReady();
  // The run this snapshot belongs to is looked up from the snapshot itself, so
  // the sidepanel does not have to know which plan started it.
  const reference = await dashboardService.findBatchReferenceByExternalBatchId(
    current.id
  );
  const next = resumeStoppedBatch(current);
  await setBatch(next);
  try {
    if (reference) {
      await dashboardService.resumeBatchRun(
        reference.planId,
        reference.batchId,
        next
      );
    } else {
      // A snapshot with no dashboard run behind it (an older standalone batch)
      // still resumes; it simply keeps reporting through the active reference.
      await dashboardService.syncActiveBatch(next);
    }
  } catch (error) {
    await setBatch(current);
    throw error;
  }
  await clearBatchStopIntent();
  requestBatchWake();
  return { type: 'batch.resume', data: next };
}

async function resetBatch(): Promise<PopupMessageResult> {
  const batch = await getBatch();
  if (batch?.status === 'running' || batch?.status === 'paused') {
    throw new Error('BATCH_ALREADY_ACTIVE');
  }
  // Preserve the finished batch in history before discarding it, so a reset is
  // no longer destructive.
  if (batch) {
    await dashboardService.syncActiveBatch(batch);
    if (shouldSettlePlanBatch(batch)) await settlePlanChunk(batch.id);
    await dashboardService.clearActiveRunReference();
    await archiveBatch(batch);
  }
  await clearBatch();
  await updateBatchBadge(null);
  await updateDueBadge(null);
  return { type: 'batch.reset', data: null };
}

async function createLegacyPlan(
  message: Extract<PopupMessage, { type: 'plan.create' }>
): Promise<PopupMessageResult> {
  let urls: string[];
  try {
    urls = parseTargetUrls(message.targetText);
  } catch (error) {
    if (error instanceof TargetUrlError && error.lineNumber === 0) {
      throw new Error('PLAN_NO_URLS');
    }
    throw error;
  }
  const now = Date.now();
  const plan: SitePlan = {
    siteId: message.siteId,
    chunkSize: message.chunkSize,
    chunks: splitIntoChunks(urls, message.chunkSize).map((group, index) => ({
      id: `${message.siteId}:${now}:${index}`,
      urls: group,
      status: 'pending',
    })),
    createdAt: now,
    updatedAt: now,
  };
  await savePlan(plan);
  await updateDueBadge();
  return { type: 'plan.create', data: plan };
}

async function createDashboardPlan(
  message: DashboardPlanCreateMessage
): Promise<PopupMessageResult> {
  const settings = await getSettings();
  const site = settings.sites.find(
    (candidate) => candidate.id === message.siteId
  );
  if (!site) throw new Error('PLAN_SITE_MISSING');
  const data = await dashboardService.createPlan({
    name: message.name,
    promotingSiteId: site.id,
    promotingSiteLabel: site.label || site.websiteUrl,
    promotingWebsiteUrl: site.websiteUrl,
    targetText: message.targetText,
    chunkSize: message.chunkSize,
  });
  return { type: 'plan.create', data: data.plan };
}

async function removePlan(
  message: Extract<PopupMessage, { type: 'plan.delete' }>
): Promise<PopupMessageResult> {
  await deletePlan(message.siteId);
  await updateDueBadge();
  return { type: 'plan.delete', data: null };
}

async function getDashboardPlanContext(planId: string) {
  const [detail, settings] = await Promise.all([
    dashboardService.getPlanDetail(planId),
    getSettings(),
  ]);
  return {
    detail,
    batchSettings: buildPlanBatchSettingsSnapshot(
      detail.plan,
      settings.provider,
      settings.sites
    ),
  };
}

async function ensureDashboardBatchIdle(): Promise<void> {
  await ensureIdleAndArchive({
    getBatch,
    archiveBatch,
    clearBatch,
    onArchive: async (snapshot) => {
      await dashboardService.syncActiveBatch(snapshot);
      if (shouldSettlePlanBatch(snapshot)) {
        await settlePlanChunk(snapshot.id);
      }
      await dashboardService.clearActiveRunReference();
    },
  });
}

async function beginDashboardBatch(
  urls: string[],
  settings: BatchSettingsSnapshot,
  register: (snapshot: BatchSnapshot) => Promise<unknown>
): Promise<BatchSnapshot> {
  if (urls.length === 0) throw new Error('BATCH_NOT_RUNNABLE');
  await ensureDashboardBatchIdle();
  // Do not wake the runner here: the caller registers the dashboard run first,
  // and only then wakes it.
  const snapshot = await startBatchFromBackground(
    urls.join('\n'),
    settings,
    false
  );
  try {
    await register(snapshot);
  } catch (error) {
    const current = await getBatch();
    if (current?.id === snapshot.id) await clearBatch();
    throw error;
  }
  await clearBatchStopIntent();
  requestBatchWake();
  return snapshot;
}

function activePlanBatch(batches: PlanBatch[]): PlanBatch | null {
  return (
    batches.find(
      (batch) =>
        batch.status === 'running' ||
        batch.status === 'blocked' ||
        batch.status === 'interrupted'
    ) ?? null
  );
}

async function runDashboardPlanNext(
  message: Extract<PopupMessage, { type: 'plan.runNext' }>
): Promise<PopupMessageResult> {
  const context = await getDashboardPlanContext(message.planId);
  if (activePlanBatch(context.detail.batches)) {
    throw new Error('PLAN_RESUME_REQUIRED');
  }
  const batch = await dashboardService.getNextRunnableBatch(message.planId);
  if (!batch) {
    if (
      context.detail.batches.some((candidate) => candidate.status === 'pending')
    ) {
      throw new Error('BATCH_ALREADY_STARTED_TODAY');
    }
    throw new Error('PLAN_NO_PENDING_CHUNK');
  }
  const targets = await dashboardService.getBatchTargets(batch.id);
  const data = await beginDashboardBatch(
    targets.map((target) => target.url),
    context.batchSettings,
    (snapshot) =>
      dashboardService.startBatchRun(message.planId, batch.id, snapshot)
  );
  return { type: 'plan.runNext', data };
}

const SETTLED_ITEM_STATUSES = new Set<BatchItem['status']>([
  'published',
  'pending_moderation',
  'unconfirmed',
  'submitted',
  'no_form',
  'validation_error',
  'failed',
  'filtered',
]);

// The items a resume has to pick back up: everything a run has not already
// finished with, one way or another.
function unsettledItems(batch: BatchSnapshot): BatchItem[] {
  return batch.items.filter((item) => !SETTLED_ITEM_STATUSES.has(item.status));
}

async function validateResumePermissions(
  snapshot: BatchSnapshot,
  urls: string[]
): Promise<void> {
  const runnableUrls = (
    await Promise.all(
      urls.map(async (url) => ((await isTargetFiltered(url)) ? null : url))
    )
  ).filter((url): url is string => url !== null);
  if (runnableUrls.length === 0) return;

  if (
    !(await hasBatchOriginPermissions([
      snapshot.settings.websiteUrl,
      ...runnableUrls,
    ]))
  ) {
    throw new Error('ORIGIN_PERMISSION_REQUIRED');
  }
}

async function resumeDashboardPlan(
  message: Extract<PopupMessage, { type: 'plan.resume' }>
): Promise<PopupMessageResult> {
  const context = await getDashboardPlanContext(message.planId);
  const planBatch = activePlanBatch(context.detail.batches);
  if (!planBatch) throw new Error('PLAN_NO_INTERRUPTED_BATCH');
  const [current, activeReference] = await Promise.all([
    getBatch(),
    dashboardService.getActiveRunReference(),
  ]);
  let reference: DashboardActiveRunReference | null = activeReference;
  if (
    current &&
    (!reference ||
      !isDashboardPlanRunReference(reference) ||
      reference.externalBatchId !== current.id ||
      reference.planId !== message.planId ||
      reference.batchId !== planBatch.id)
  ) {
    const found = await dashboardService.findBatchReferenceByExternalBatchId(
      current.id
    );
    reference = found
      ? {
          kind: 'plan',
          planId: found.planId,
          batchId: found.batchId,
          runId: found.runId,
          externalBatchId: found.externalBatchId,
        }
      : null;
  }
  const matchesCurrent =
    current &&
    reference &&
    isDashboardPlanRunReference(reference) &&
    reference.planId === message.planId &&
    reference.batchId === planBatch.id &&
    reference.externalBatchId === current.id;

  if (matchesCurrent && current.status === 'running') {
    requestBatchWake();
    return { type: 'plan.resume', data: current };
  }
  if (matchesCurrent && current.status === 'paused') {
    await validateResumePermissions(
      current,
      unsettledItems(current).map((item) => item.url)
    );
    const next = resumeBatch(current);
    await setBatch(next);
    await dashboardService.syncActiveBatch(next);
    await clearBatchStopIntent();
    requestBatchWake();
    return { type: 'plan.resume', data: next };
  }
  if (matchesCurrent && current.status === 'stopped') {
    const resumable = unsettledItems(current);
    if (resumable.length === 0) throw new Error('BATCH_NOT_RUNNABLE');
    await validateResumePermissions(
      current,
      resumable.map((item) => item.url)
    );
    const next = resumeStoppedBatch(current);
    await setBatch(next);
    try {
      await dashboardService.resumeBatchRun(message.planId, planBatch.id, next);
    } catch (error) {
      await setBatch(current);
      throw error;
    }
    await clearBatchStopIntent();
    requestBatchWake();
    return { type: 'plan.resume', data: next };
  }

  const targets = (await dashboardService.getBatchTargets(planBatch.id)).filter(
    (target) =>
      target.status === 'pending' ||
      target.status === 'running' ||
      target.status === 'blocked' ||
      target.status === 'interrupted'
  );
  const data = await beginDashboardBatch(
    targets.map((target) => target.url),
    context.batchSettings,
    (snapshot) =>
      dashboardService.resumeBatchRun(message.planId, planBatch.id, snapshot)
  );
  return { type: 'plan.resume', data };
}

async function selectedPlanTargets(
  planId: string,
  targetIds: string[]
): Promise<PlanTarget[]> {
  const selectedIds = new Set(targetIds);
  if (selectedIds.size === 0) throw new Error('RETRY_TARGET_INVALID');
  const selected: PlanTarget[] = [];
  let page = 1;
  while (selected.length < selectedIds.size) {
    const result = await dashboardService.repository.getTargets(planId, {
      page,
      pageSize: 100,
    });
    selected.push(
      ...result.items.filter((target) => selectedIds.has(target.id))
    );
    if (page >= result.totalPages) break;
    page += 1;
  }
  if (selected.length !== selectedIds.size) {
    throw new Error('RETRY_TARGET_INVALID');
  }
  return selected;
}

async function retryDashboardPlanTargets(
  message: Extract<PopupMessage, { type: 'plan.retryTargets' }>
): Promise<PopupMessageResult> {
  const context = await getDashboardPlanContext(message.planId);
  const targets = await selectedPlanTargets(message.planId, message.targetIds);
  if (
    targets.some(
      (target) =>
        target.status !== 'no_form' &&
        target.status !== 'validation_error' &&
        target.status !== 'failed'
    )
  ) {
    throw new Error('RETRY_TARGET_INVALID');
  }
  const batchId = targets[0]?.batchId;
  if (!batchId || targets.some((target) => target.batchId !== batchId)) {
    throw new Error('RETRY_TARGET_BATCH_MISMATCH');
  }
  const batch = context.detail.batches.find(
    (candidate) => candidate.id === batchId
  );
  if (
    !batch ||
    (batch.status !== 'completed' && batch.status !== 'completed_with_errors')
  ) {
    throw new Error('BATCH_NOT_RUNNABLE');
  }
  const uniqueIds = [...new Set(message.targetIds)];
  const data = await beginDashboardBatch(
    targets.map((target) => target.url),
    context.batchSettings,
    (snapshot) =>
      dashboardService.prepareRetry(message.planId, uniqueIds, snapshot)
  );
  return { type: 'plan.retryTargets', data };
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

function isLiveBatchSnapshot(
  snapshot: BatchSnapshot | null
): snapshot is BatchSnapshot {
  return (
    snapshot?.status === 'running' ||
    snapshot?.status === 'paused' ||
    snapshot?.status === 'stopped'
  );
}

async function deleteDashboardTarget(
  message: Extract<PopupMessage, { type: 'plan.deleteTarget' }>
): Promise<PopupMessageResult> {
  const [target, current] = await Promise.all([
    dashboardService.getTarget(message.planId, message.targetId),
    getBatch(),
  ]);

  if (
    isLiveBatchSnapshot(current) &&
    current.items.some((item) => item.url === target.url)
  ) {
    throw new Error('BATCH_ALREADY_ACTIVE');
  }

  let createdFilterId: string | null = null;
  if (message.addToFilter) {
    const filter = await addFilterListEntryWithResult({
      value: target.url,
      kind: 'url',
    });
    if (filter.created) createdFilterId = filter.entry.id;
  }

  try {
    const deleted = await dashboardService.deleteTarget(
      message.planId,
      message.targetId
    );
    return { type: message.type, data: deleted };
  } catch (error) {
    if (!createdFilterId) throw error;

    try {
      await removeFilterListEntry(createdFilterId);
    } catch (rollbackError) {
      const original =
        error instanceof Error ? error.message : 'TARGET_DELETE_FAILED';
      const rollback =
        rollbackError instanceof Error
          ? rollbackError.message
          : 'FILTER_ROLLBACK_FAILED';
      throw new Error(
        `TARGET_DELETE_FILTER_ROLLBACK_FAILED:${original}:${rollback}`
      );
    }
    throw error;
  }
}

// Gathers every piece of locally stored user data into the versioned backup
// envelope. IndexedDB access stays on this side of the runtime (the same side
// DashboardService/dashboardRepository already live on) so the dashboard page
// never opens the database directly; it always goes through this message.
// Fallback wording for the natural bucket, written once from the settings page
// rather than per comment. It runs through the promoted site's own profile so
// the phrasing suits that site's language.
async function generateNaturalAnchors(message: {
  siteId: string;
  count: number;
}): Promise<string[]> {
  const settings = await getSettings();
  const site = settings.sites.find(
    (candidate) => candidate.id === message.siteId
  );
  if (!site?.websiteUrl) throw new Error('WEBSITE_URL_REQUIRED');
  const [keys, websiteProfile] = await Promise.all([
    getProviderApiKeys(),
    loadWebsiteProfile(site.websiteUrl),
  ]);
  return generateNaturalAnchorTexts(keys, {
    provider: settings.provider,
    websiteProfile,
    count: message.count,
  });
}

async function exportDataBackup(): Promise<DataBackupFile> {
  const [
    settings,
    providerApiKeys,
    outboundLinkLibrary,
    filterList,
    batchHistory,
    dashboard,
    anchorPlans,
    anchorLedgers,
  ] = await Promise.all([
    getSettings(),
    getProviderApiKeys(),
    getOutboundLinkLibrary(),
    getFilterList(),
    getBatchHistory(),
    dashboardRepository.exportAll(),
    getAnchorPlans(),
    getAnchorLedgers(),
  ]);
  return buildDataBackup(
    {
      settings,
      providerApiKeys,
      outboundLinkLibrary,
      filterList,
      batchHistory,
      dashboard,
      anchorPlans,
      anchorLedgers,
    },
    chrome.runtime.getManifest().version
  );
}

// Validates the file, then replaces every section. The dashboard import runs
// first: it re-validates referential integrity and writes inside a single
// IndexedDB transaction, so a rejected backup fails before anything at all is
// written. The chrome.storage sections were already schema-validated by
// parseDataBackupFile, so their write after that point cannot be rejected.
async function importDataBackup(raw: unknown): Promise<void> {
  const backup = parseDataBackupFile(raw);
  await dashboardRepository.importAll(backup.data.dashboard);
  await chrome.storage.local.set({
    [SETTINGS_STORAGE_KEY]: backup.data.settings,
    [PROVIDER_API_KEYS_STORAGE_KEY]: backup.data.providerApiKeys,
    [OUTBOUND_LINK_LIBRARY_STORAGE_KEY]: backup.data.outboundLinkLibrary,
    [FILTER_LIST_STORAGE_KEY]: backup.data.filterList,
    [HISTORY_STORAGE_KEY]: backup.data.batchHistory,
    [ANCHOR_PLAN_STORAGE_KEY]: backup.data.anchorPlans,
    [ANCHOR_LEDGER_STORAGE_KEY]: backup.data.anchorLedgers,
  });
  await clearFirstRunPending();
  await dashboardService.bumpRevision();
}

async function dispatch(
  message: PopupMessage,
  sender?: chrome.runtime.MessageSender
): Promise<PopupMessageResult> {
  if (message.type === 'page.analyze') {
    return { type: message.type, data: await analyzeCurrentPage() };
  }
  if (message.type === 'comment.prepare') return prepareComment();
  if (message.type === 'batch.continue') return continueBatch();
  if (message.type === 'batch.skip-current')
    return skipCurrentBatchManualGate();
  if (message.type === 'batch.stop') return stopCurrentBatch();
  // Shares the dashboard plan queue: a resume and a plan run must never build
  // two runs over the same batch.
  if (message.type === 'batch.resume') {
    return serializeDashboardPlanOperation(resumeCurrentBatch);
  }
  if (message.type === 'batch.reset') return resetBatch();
  if (message.type === 'plan.create') {
    return 'name' in message
      ? createDashboardPlan(message)
      : createLegacyPlan(message);
  }
  if (message.type === 'plan.delete') return removePlan(message);
  if (message.type === 'filter.list') {
    return { type: message.type, data: await getFilterList() };
  }
  if (message.type === 'filter.add') {
    return {
      type: message.type,
      data: await addFilterListEntry(message),
    };
  }
  if (message.type === 'filter.remove') {
    return {
      type: message.type,
      data: await removeFilterListEntry(message.id),
    };
  }
  if (message.type === 'link-library.list') {
    return { type: message.type, data: await getOutboundLinkLibrary() };
  }
  if (message.type === 'link-library.add') {
    return {
      type: message.type,
      data: await addOutboundLinkLibraryEntry(message),
    };
  }
  if (message.type === 'link-library.update') {
    return {
      type: message.type,
      data: await updateOutboundLinkLibraryEntry(message),
    };
  }
  if (message.type === 'link-library.remove') {
    return {
      type: message.type,
      data: await removeOutboundLinkLibraryEntry(message.id),
    };
  }
  if (message.type === 'dashboard.getSummary') {
    return {
      type: message.type,
      data: await dashboardService.getSummary(await getBatch()),
    };
  }
  if (message.type === 'moderation.getDashboard') {
    return {
      type: message.type,
      data: await getModerationRecheckDashboard(),
    };
  }
  if (message.type === 'moderation.runNow') {
    return {
      type: message.type,
      data: await requestPendingModerationRecheck(),
    };
  }
  if (message.type === 'moderation.addManual') {
    await addManualModerationEntry({
      pageUrl: message.pageUrl,
      targetWebsiteUrl: message.targetWebsiteUrl,
    });
    return {
      type: message.type,
      data: await getModerationRecheckDashboard(),
    };
  }
  if (message.type === 'moderation.recheckManual') {
    await recheckManualModerationEntry(
      message.entryId,
      createPublicCommentPort()
    );
    return {
      type: message.type,
      data: await getModerationRecheckDashboard(),
    };
  }
  if (message.type === 'moderation.recheckTarget') {
    return {
      type: message.type,
      data: await recheckDashboardTarget(message.planId, message.targetId),
    };
  }
  if (message.type === 'moderation.updateSettings') {
    const settings = await saveModerationRecheckSettings(message.settings);
    await armPendingModerationRecheckAlarm(chrome.alarms, settings);
    return {
      type: message.type,
      data: await getModerationRecheckDashboard(),
    };
  }
  if (message.type === 'plans.list') {
    return {
      type: message.type,
      data: {
        plans: await dashboardService.listPlans(
          message.includeArchived === true
        ),
      },
    };
  }
  if (message.type === 'plan.getDetail') {
    return {
      type: message.type,
      data: await dashboardService.getPlanDetail(message.planId),
    };
  }
  if (message.type === 'plan.getTargets') {
    return {
      type: message.type,
      data: await dashboardService.getTargets(message.planId, {
        ...(message.batchId ? { batchId: message.batchId } : {}),
        ...(message.page !== undefined ? { page: message.page } : {}),
        ...(message.pageSize !== undefined
          ? { pageSize: message.pageSize }
          : {}),
      }),
    };
  }
  if (message.type === 'plan.rename') {
    return {
      type: message.type,
      data: await dashboardService.renamePlan(message.planId, message.name),
    };
  }
  if (message.type === 'plan.setChunkSize') {
    return {
      type: message.type,
      data: await dashboardService.setPlanChunkSize(
        message.planId,
        message.chunkSize
      ),
    };
  }
  if (message.type === 'plan.archive') {
    return {
      type: message.type,
      data: await dashboardService.archivePlan(message.planId),
    };
  }
  if (message.type === 'plan.deletePermanently') {
    await dashboardService.deletePlanPermanently(message.planId);
    return { type: message.type, data: null };
  }
  if (message.type === 'plan.deleteTarget') {
    return serializeDashboardPlanOperation(() =>
      deleteDashboardTarget(message)
    );
  }
  if (message.type === 'plan.runNext') {
    return serializeDashboardPlanOperation(() => runDashboardPlanNext(message));
  }
  if (message.type === 'plan.resume') {
    return serializeDashboardPlanOperation(() => resumeDashboardPlan(message));
  }
  if (message.type === 'plan.retryTargets') {
    return serializeDashboardPlanOperation(() =>
      retryDashboardPlanTargets(message)
    );
  }
  if (message.type === 'batch.open-current') {
    return openCurrentBatchTarget();
  }
  if (message.type === 'comment.submit') {
    const site = getActiveSite(await getSettings());
    const result = await submitCurrentPage(
      {
        comment: message.comment,
        displayName: site.displayName || undefined,
        email: site.email || undefined,
        websiteUrl:
          site.linkMode === 'comment-only' || !message.target.fillWebsiteField
            ? ''
            : site.websiteUrl,
        requireInlineAnchor:
          site.linkMode === 'a-tag-newline' || site.linkMode === 'inline',
      },
      message.target
    );
    return { type: message.type, data: result };
  }
  if (message.type === 'anchor.generateNaturalTexts') {
    assertTrustedUiSender(sender);
    return { type: message.type, data: await generateNaturalAnchors(message) };
  }
  if (message.type === 'data-backup.export') {
    assertTrustedUiSender(sender);
    return { type: message.type, data: await exportDataBackup() };
  }
  if (message.type === 'data-backup.import') {
    assertTrustedUiSender(sender);
    await importDataBackup(message.backup);
    return { type: message.type, data: { imported: true } };
  }
  throw new Error('BACKGROUND_MESSAGE_UNSUPPORTED');
}

// The backup surface moves plaintext API keys and rewrites every store, so it
// only answers the extension's own pages — never a content script, whose
// sender.url is the arbitrary page it runs in.
function assertTrustedUiSender(
  sender: chrome.runtime.MessageSender | undefined
): void {
  if (!sender?.url?.startsWith(chrome.runtime.getURL(''))) {
    throw new Error('BACKGROUND_MESSAGE_UNSUPPORTED');
  }
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
      (message: PopupMessage, sender, sendResponse: SendResponse) => {
        void storageReady
          .then(() => ensureDashboardReady())
          .then(() => dispatch(message, sender))
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
      if (alarm.name === PENDING_MODERATION_RECHECK_ALARM) {
        void requestPendingModerationRecheck().catch(() => {
          // Durable pending records remain queued for the next scheduled run.
        });
      }
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
    chrome.runtime.onStartup.addListener(() => {
      requestBatchWake();
      void armConfiguredModerationRecheckAlarm();
    });
    chrome.runtime.onInstalled.addListener((details) => {
      requestBatchWake();
      void armConfiguredModerationRecheckAlarm();
      if (details.reason === 'install') {
        // Lets the dashboard offer to import a backup on its next load,
        // covering the "reinstalled from a different folder" migration path
        // where the extension ID (and therefore all local storage) changed.
        void markFirstRunPending();
      }
    });

    void storageReady
      .then(async () => {
        await ensureDashboardReady();
        await armConfiguredModerationRecheckAlarm();
        requestBatchWake();
        await updateBatchBadge();
        await updateDueBadge();
      })
      .catch(() => {
        // A stale pre-migration run must not turn extension startup into an
        // unhandled promise. ensureDashboardReady resets its cached promise,
        // so the next dashboard request safely retries the recovery.
        signalDeferredDashboardBootstrap();
      });
  },
});
