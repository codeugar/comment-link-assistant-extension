import type { BatchItemStatus, BatchSnapshot } from '@/batch/types';
import {
  type Attempt,
  type AttemptError,
  type BatchRunStart,
  type CreatePlanInput,
  type DashboardBatchStatus,
  type DashboardMeta,
  type DashboardRunKind,
  type DashboardRunStatus,
  type DashboardSummary,
  type LegacyImportBundle,
  type LegacyImportResult,
  type Plan,
  type PlanBatch,
  type PlanDetail,
  type PlanTarget,
  type PlanTargetPage,
  type PlanTargetStatus,
  type PromotingSiteSummary,
  type RecentFailureSummary,
  type Run,
  type ScheduledBatchSummary,
  type StartBatchRunInput,
  type TargetHostSummary,
  countTargetStatuses,
  isFailedTargetStatus,
  isProcessedTargetStatus,
} from './model';

export const DASHBOARD_DB_NAME = 'comment-link-assistant.dashboard';
export const DASHBOARD_DB_VERSION = 1;

export const DASHBOARD_STORE_NAMES = {
  plans: 'plans',
  planBatches: 'planBatches',
  planTargets: 'planTargets',
  runs: 'runs',
  attempts: 'attempts',
  meta: 'meta',
} as const;

const INDEXES = {
  plans: {
    status: 'by-status',
    promotingSite: 'by-promoting-site',
  },
  batches: {
    plan: 'by-plan',
    planSequence: 'by-plan-sequence',
    status: 'by-status',
    externalBatch: 'by-external-batch',
  },
  targets: {
    plan: 'by-plan',
    batch: 'by-batch',
    batchSequence: 'by-batch-sequence',
    planSequence: 'by-plan-sequence',
    host: 'by-host',
    status: 'by-status',
  },
  runs: {
    plan: 'by-plan',
    batch: 'by-batch',
    externalBatch: 'by-external-batch',
    status: 'by-status',
  },
  attempts: {
    plan: 'by-plan',
    batch: 'by-batch',
    target: 'by-target',
    run: 'by-run',
    targetNumber: 'by-target-number',
  },
} as const;

const MAX_PLAN_TARGETS = 2_000;
const DEFAULT_CHUNK_SIZE = 30;
const MAX_CHUNK_SIZE = 200;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 100;
const DEFAULT_RECENT_FAILURE_LIMIT = 5;

type StoreName =
  (typeof DASHBOARD_STORE_NAMES)[keyof typeof DASHBOARD_STORE_NAMES];

export type DashboardDataErrorCode =
  | 'DASHBOARD_INDEXED_DB_UNAVAILABLE'
  | 'DASHBOARD_DATABASE_OPEN_FAILED'
  | 'PLAN_NAME_INVALID'
  | 'PLAN_SITE_INVALID'
  | 'PLAN_WEBSITE_URL_INVALID'
  | 'PLAN_URLS_REQUIRED'
  | 'PLAN_TARGET_LIMIT_EXCEEDED'
  | 'PLAN_TARGET_URL_INVALID'
  | 'PLAN_CHUNK_SIZE_INVALID'
  | 'PLAN_ID_CONFLICT'
  | 'PLAN_SITE_CONFLICT'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_TARGET_NOT_FOUND'
  | 'PLAN_ARCHIVED'
  | 'PLAN_DELETE_REQUIRES_ARCHIVE'
  | 'BATCH_NOT_FOUND'
  | 'BATCH_ALREADY_ACTIVE'
  | 'BATCH_NOT_RUNNABLE'
  | 'BATCH_ALREADY_STARTED_TODAY'
  | 'RUN_ALREADY_ACTIVE'
  | 'RUN_NOT_FOUND'
  | 'RETRY_TARGET_INVALID'
  | 'RETRY_TARGET_BATCH_MISMATCH'
  | 'TARGET_PAGE_INVALID'
  | 'MIGRATION_INVALID';

export class DashboardDataError extends Error {
  constructor(
    readonly code: DashboardDataErrorCode,
    message: string = code
  ) {
    super(message);
    this.name = 'DashboardDataError';
  }
}

export interface DashboardRepositoryOptions {
  databaseName?: string;
  indexedDB?: IDBFactory;
  now?: () => number;
  idFactory?: () => string;
}

export interface ListPlansOptions {
  includeArchived?: boolean;
}

export interface TargetPageOptions {
  batchId?: string;
  page?: number;
  pageSize?: number;
}

export interface DashboardSummaryOptions {
  now?: number;
  recentFailureLimit?: number;
}

export interface SyncBatchSnapshotOptions {
  runId?: string;
  at?: number;
}

/** A durable, read-only verification job for a comment awaiting moderation. */
export interface PendingModerationCheck {
  targetId: string;
  attemptId: string;
  planId: string;
  url: string;
  targetWebsiteUrl: string;
  fingerprint: string;
  checkCount: number;
  lastCheckAt?: number;
  lastCheckMessage?: string;
}

export interface ModerationPublishedTransition {
  targetId: string;
  planId: string;
  url: string;
  fingerprint: string;
  checkCount: number;
  publishedAt: number;
  message: string;
}

export interface RecordModerationCheckInput {
  targetId: string;
  attemptId: string;
  status: 'pending_moderation' | 'published';
  message: string;
  at?: number;
  /** Used by an explicit history-row check: keep the old status when absent. */
  preserveCurrentStatus?: boolean;
}

export interface RetryRunInput {
  runId?: string;
  externalBatchId?: string;
  at?: number;
}

export interface DashboardBatchReference {
  planId: string;
  batchId: string;
  runId: string;
  externalBatchId: string;
  batchStatus: DashboardBatchStatus;
  runStatus: DashboardRunStatus;
}

export interface DashboardStandaloneRunReference {
  runId: string;
  externalBatchId: string;
  runStatus: DashboardRunStatus;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionFinished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IDB_TRANSACTION_ABORTED'));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IDB_TRANSACTION_FAILED'));
  });
}

function createStore(database: IDBDatabase, name: StoreName): IDBObjectStore {
  return database.createObjectStore(name, { keyPath: 'id' });
}

function upgradeDatabase(database: IDBDatabase): void {
  const plans = createStore(database, DASHBOARD_STORE_NAMES.plans);
  plans.createIndex(INDEXES.plans.status, 'status');
  plans.createIndex(INDEXES.plans.promotingSite, 'promotingSiteId');

  const batches = createStore(database, DASHBOARD_STORE_NAMES.planBatches);
  batches.createIndex(INDEXES.batches.plan, 'planId');
  batches.createIndex(INDEXES.batches.planSequence, ['planId', 'sequence'], {
    unique: true,
  });
  batches.createIndex(INDEXES.batches.status, 'status');
  batches.createIndex(INDEXES.batches.externalBatch, 'externalBatchId');

  const targets = createStore(database, DASHBOARD_STORE_NAMES.planTargets);
  targets.createIndex(INDEXES.targets.plan, 'planId');
  targets.createIndex(INDEXES.targets.batch, 'batchId');
  targets.createIndex(INDEXES.targets.batchSequence, ['batchId', 'sequence'], {
    unique: true,
  });
  targets.createIndex(INDEXES.targets.planSequence, ['planId', 'sequence'], {
    unique: true,
  });
  targets.createIndex(INDEXES.targets.host, 'host');
  targets.createIndex(INDEXES.targets.status, 'status');

  const runs = createStore(database, DASHBOARD_STORE_NAMES.runs);
  runs.createIndex(INDEXES.runs.plan, 'planId');
  runs.createIndex(INDEXES.runs.batch, 'batchId');
  runs.createIndex(INDEXES.runs.externalBatch, 'externalBatchId');
  runs.createIndex(INDEXES.runs.status, 'status');

  const attempts = createStore(database, DASHBOARD_STORE_NAMES.attempts);
  attempts.createIndex(INDEXES.attempts.plan, 'planId');
  attempts.createIndex(INDEXES.attempts.batch, 'batchId');
  attempts.createIndex(INDEXES.attempts.target, 'targetId');
  attempts.createIndex(INDEXES.attempts.run, 'runId');
  attempts.createIndex(
    INDEXES.attempts.targetNumber,
    ['targetId', 'attemptNumber'],
    { unique: true }
  );

  database.createObjectStore(DASHBOARD_STORE_NAMES.meta, {
    keyPath: 'key',
  });
}

function openDatabase(
  factory: IDBFactory,
  databaseName: string
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, DASHBOARD_DB_VERSION);
    request.onupgradeneeded = (event) => {
      if ((event as IDBVersionChangeEvent).oldVersion === 0)
        upgradeDatabase(request.result);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () =>
      reject(
        new DashboardDataError(
          'DASHBOARD_DATABASE_OPEN_FAILED',
          request.error?.message
        )
      );
  });
}

async function allFromIndex<T>(
  store: IDBObjectStore,
  indexName: string,
  query?: IDBValidKey
): Promise<T[]> {
  const request =
    query === undefined
      ? store.index(indexName).getAll()
      : store.index(indexName).getAll(query);
  return (await requestResult(request)) as T[];
}

function nonEmptyString(
  value: string,
  code: DashboardDataErrorCode,
  maxLength = 200
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new DashboardDataError(code);
  }
  return normalized;
}

function normalizeHttpUrl(
  value: string,
  errorCode: 'PLAN_WEBSITE_URL_INVALID' | 'PLAN_TARGET_URL_INVALID'
): string {
  try {
    const trimmed = value.trim();
    if (
      !trimmed ||
      (/^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^https?:\/\//i.test(trimmed))
    ) {
      throw new Error('URL_NOT_ALLOWED');
    }
    const url = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    );
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password
    ) {
      throw new Error('URL_NOT_ALLOWED');
    }
    url.hash = '';
    return url.toString();
  } catch {
    throw new DashboardDataError(errorCode);
  }
}

export function normalizePlanUrls(urls: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const [index, value] of urls.entries()) {
    let url: string;
    try {
      url = normalizeHttpUrl(value, 'PLAN_TARGET_URL_INVALID');
    } catch {
      throw new DashboardDataError(
        'PLAN_TARGET_URL_INVALID',
        `PLAN_TARGET_URL_INVALID:${index + 1}`
      );
    }
    if (seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
    if (normalized.length > MAX_PLAN_TARGETS) {
      throw new DashboardDataError('PLAN_TARGET_LIMIT_EXCEEDED');
    }
  }

  if (normalized.length === 0) {
    throw new DashboardDataError('PLAN_URLS_REQUIRED');
  }
  return normalized;
}

function fallbackId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function sameLocalDay(leftTimestamp: number, rightTimestamp: number): boolean {
  const left = new Date(leftTimestamp);
  const right = new Date(rightTimestamp);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function targetId(planId: string, sequence: number): string {
  return `${planId}:target:${sequence}`;
}

function batchId(planId: string, sequence: number): string {
  return `${planId}:batch:${sequence}`;
}

function runId(idFactory: () => string): string {
  return `run:${idFactory()}`;
}

function attemptId(runIdentifier: string, targetIdentifier: string): string {
  return `${runIdentifier}:${targetIdentifier}`;
}

function commentFingerprint(comment: string): string {
  return comment.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function sortPlans(plans: Plan[]): Plan[] {
  const rank: Record<Plan['status'], number> = {
    active: 0,
    completed: 1,
    archived: 2,
  };
  return plans.sort(
    (left, right) =>
      rank[left.status] - rank[right.status] ||
      right.updatedAt - left.updatedAt ||
      left.name.localeCompare(right.name)
  );
}

function sortBatches(batches: PlanBatch[]): PlanBatch[] {
  return batches.sort((left, right) => left.sequence - right.sequence);
}

function sortTargets(targets: PlanTarget[]): PlanTarget[] {
  return targets.sort((left, right) => left.sequence - right.sequence);
}

function applyCountsToPlan(
  plan: Plan,
  targets: PlanTarget[],
  batches: PlanBatch[],
  at: number
): Plan {
  const counts = countTargetStatuses(targets);
  const allSettled =
    batches.length > 0 &&
    batches.every(
      (batch) =>
        batch.status === 'completed' || batch.status === 'completed_with_errors'
    );
  return {
    ...plan,
    status:
      plan.status === 'archived'
        ? 'archived'
        : allSettled
          ? 'completed'
          : 'active',
    targetCount: counts.total,
    processedCount: counts.processed,
    submittedCount: counts.submitted,
    failedCount: counts.failed,
    unknownCount: counts.unknown,
    updatedAt: at,
  };
}

function applyCountsToBatch(
  batch: PlanBatch,
  targets: PlanTarget[]
): PlanBatch {
  const counts = countTargetStatuses(targets);
  return {
    ...batch,
    targetCount: counts.total,
    processedCount: counts.processed,
    submittedCount: counts.submitted,
    failedCount: counts.failed,
    unknownCount: counts.unknown,
  };
}

export function mapBatchItemStatus(status: BatchItemStatus): PlanTargetStatus {
  if (status === 'queued') return 'pending';
  if (
    status === 'opening' ||
    status === 'analyzing' ||
    status === 'generating' ||
    status === 'prepared' ||
    status === 'click_dispatched' ||
    status === 'verifying'
  ) {
    return 'running';
  }
  if (status === 'login_required' || status === 'captcha_required') {
    return 'blocked';
  }
  if (status === 'stopped') return 'interrupted';
  // Older content scripts reported a click with no receipt as `submitted`.
  // Preserve the row while preventing it from becoming a confirmed success.
  if (status === 'submitted') return 'unconfirmed';
  return status;
}

// Batch snapshots can arrive out of order: a stale wake-up must never turn a
// confirmed result back into a live status. At an identical timestamp, retain
// the already-saved terminal result; a real retry first moves the target back
// to pending, so it is still allowed to establish its own next result.
function shouldApplySnapshotTarget(
  target: PlanTarget,
  incomingUpdatedAt: number
): boolean {
  if (incomingUpdatedAt > target.updatedAt) return true;
  if (incomingUpdatedAt < target.updatedAt) return false;
  if (isProcessedTargetStatus(target.status)) return false;
  return true;
}

function friendlyError(
  status: PlanTargetStatus,
  message: string,
  at: number
): AttemptError | undefined {
  if (!isFailedTargetStatus(status)) return undefined;
  const friendlyMessages: Record<
    'no_form' | 'validation_error' | 'failed',
    string
  > = {
    no_form: '没有找到可用的评论表单',
    validation_error: '评论表单未通过网站校验',
    failed: '处理外链时发生错误',
  };
  const rawCode = message.trim();
  const code = /^[A-Z][A-Z0-9_:-]{1,120}$/.test(rawCode)
    ? rawCode
    : status.toUpperCase();
  return {
    code,
    message,
    friendlyMessage: friendlyMessages[status],
    at,
  };
}

function batchStatusFromSnapshot(
  snapshot: BatchSnapshot,
  targets: PlanTarget[]
): DashboardBatchStatus {
  const counts = countTargetStatuses(targets);
  const allTargetsSettled =
    targets.length > 0 &&
    targets.every(
      (target) =>
        isProcessedTargetStatus(target.status) || target.status === 'unknown'
    );
  if (allTargetsSettled) {
    return counts.failed > 0 || counts.unknown > 0
      ? 'completed_with_errors'
      : 'completed';
  }
  if (snapshot.status === 'running') return 'running';
  if (snapshot.status === 'paused') return 'blocked';
  if (snapshot.status === 'stopped') return 'interrupted';
  return counts.failed > 0 || counts.unknown > 0 || counts.interrupted > 0
    ? 'completed_with_errors'
    : 'completed';
}

function runStatusForBatch(status: DashboardBatchStatus): DashboardRunStatus {
  if (status === 'blocked') return 'blocked';
  if (status === 'interrupted' || status === 'pending') return 'interrupted';
  if (status === 'completed_with_errors') return 'completed_with_errors';
  if (status === 'completed') return 'completed';
  return 'running';
}

function isTerminalRunStatus(status: DashboardRunStatus): boolean {
  return (
    status === 'interrupted' ||
    status === 'completed' ||
    status === 'completed_with_errors'
  );
}

function standaloneRunStatusFromSnapshot(
  snapshot: BatchSnapshot
): DashboardRunStatus {
  if (snapshot.status === 'running') return 'running';
  if (snapshot.status === 'paused') return 'blocked';
  if (snapshot.status === 'stopped') return 'interrupted';
  return snapshot.items.some((item) =>
    isFailedTargetStatus(mapBatchItemStatus(item.status))
  )
    ? 'completed_with_errors'
    : 'completed';
}

function isTerminalBatchStatus(status: DashboardBatchStatus): boolean {
  return status === 'completed' || status === 'completed_with_errors';
}

function isDeletionActiveRunStatus(status: DashboardRunStatus): boolean {
  return (
    status === 'running' || status === 'blocked' || status === 'interrupted'
  );
}

function batchHasActiveRunForTargetDeletion(
  batch: PlanBatch,
  runs: readonly Run[]
): boolean {
  if (
    batch.status === 'running' ||
    batch.status === 'blocked' ||
    batch.status === 'interrupted'
  ) {
    return true;
  }

  // currentRunId is retained as a useful historical pointer after a batch
  // finishes. It only blocks deletion when it is dangling or still active.
  if (batch.currentRunId) {
    const currentRun = runs.find((run) => run.id === batch.currentRunId);
    if (!currentRun || isDeletionActiveRunStatus(currentRun.status)) {
      return true;
    }
  }

  return runs.some(
    (run) => run.batchId === batch.id && isDeletionActiveRunStatus(run.status)
  );
}
function scheduleItem(plan: Plan, batch: PlanBatch): ScheduledBatchSummary {
  return {
    planId: plan.id,
    planName: plan.name,
    promotingSiteLabel: plan.promotingSiteLabel,
    batchId: batch.id,
    batchSequence: batch.sequence,
    batchStatus: batch.status,
    targetCount: batch.targetCount,
    processedCount: batch.processedCount,
  };
}

function newCountsGroup(): ReturnType<typeof countTargetStatuses> {
  return countTargetStatuses([]);
}

function addTargetToCounts(
  counts: ReturnType<typeof countTargetStatuses>,
  target: PlanTarget
): void {
  counts.total += 1;
  if (isProcessedTargetStatus(target.status)) counts.processed += 1;
  if (target.status === 'published' || target.status === 'pending_moderation') {
    counts.submitted += 1;
  } else if (isFailedTargetStatus(target.status)) counts.failed += 1;
  else if (target.status === 'pending') counts.pending += 1;
  else if (target.status === 'running') counts.running += 1;
  else if (target.status === 'blocked') counts.blocked += 1;
  else if (target.status === 'interrupted') counts.interrupted += 1;
  else if (target.status === 'filtered') counts.filtered += 1;
  else if (
    target.status === 'unknown' ||
    target.status === 'unconfirmed' ||
    target.status === 'submitted'
  ) {
    counts.unknown += 1;
  }
}

function assertUniqueIds<T extends { id: string }>(
  records: T[],
  label: string
): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (!record.id || ids.has(record.id)) {
      throw new DashboardDataError(
        'MIGRATION_INVALID',
        `MIGRATION_INVALID:${label}`
      );
    }
    ids.add(record.id);
  }
}

function validateLegacyBundle(bundle: LegacyImportBundle): void {
  assertUniqueIds(bundle.plans, 'plans');
  assertUniqueIds(bundle.batches, 'batches');
  assertUniqueIds(bundle.targets, 'targets');
  assertUniqueIds(bundle.runs, 'runs');
  assertUniqueIds(bundle.attempts, 'attempts');

  const planIds = new Set(bundle.plans.map((plan) => plan.id));
  const batchIds = new Set(bundle.batches.map((batch) => batch.id));
  const targetIds = new Set(bundle.targets.map((target) => target.id));
  const runIds = new Set(bundle.runs.map((run) => run.id));

  if (
    bundle.batches.some((batch) => !planIds.has(batch.planId)) ||
    bundle.targets.some(
      (target) => !planIds.has(target.planId) || !batchIds.has(target.batchId)
    ) ||
    bundle.runs.some(
      (run) =>
        (run.planId !== undefined && !planIds.has(run.planId)) ||
        (run.batchId !== undefined && !batchIds.has(run.batchId))
    ) ||
    bundle.attempts.some(
      (attempt) =>
        !runIds.has(attempt.runId) ||
        (attempt.planId !== undefined && !planIds.has(attempt.planId)) ||
        (attempt.batchId !== undefined && !batchIds.has(attempt.batchId)) ||
        (attempt.targetId !== undefined && !targetIds.has(attempt.targetId))
    )
  ) {
    throw new DashboardDataError('MIGRATION_INVALID');
  }
}

export class DashboardRepository {
  readonly databaseName: string;
  private readonly factory: IDBFactory;
  private readonly clock: () => number;
  private readonly makeId: () => string;
  private databasePromise?: Promise<IDBDatabase>;

  constructor(options: DashboardRepositoryOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) {
      throw new DashboardDataError('DASHBOARD_INDEXED_DB_UNAVAILABLE');
    }
    this.factory = factory;
    this.databaseName = options.databaseName ?? DASHBOARD_DB_NAME;
    this.clock = options.now ?? (() => Date.now());
    this.makeId =
      options.idFactory ??
      (() => globalThis.crypto?.randomUUID?.() ?? fallbackId(this.clock()));
  }

  private database(): Promise<IDBDatabase> {
    this.databasePromise ??= openDatabase(this.factory, this.databaseName);
    return this.databasePromise;
  }

  private async transaction<T>(
    storeNames: StoreName[],
    mode: IDBTransactionMode,
    operation: (transaction: IDBTransaction) => Promise<T>
  ): Promise<T> {
    const database = await this.database();
    const transaction = database.transaction(storeNames, mode);
    const finished = transactionFinished(transaction);
    try {
      const result = await operation(transaction);
      await finished;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted because of a request error.
      }
      await finished.catch(() => undefined);
      throw error;
    }
  }

  async createPlan(input: CreatePlanInput): Promise<PlanDetail> {
    const now = input.now ?? this.clock();
    const name = nonEmptyString(input.name, 'PLAN_NAME_INVALID');
    const promotingSiteId = nonEmptyString(
      input.promotingSiteId,
      'PLAN_SITE_INVALID'
    );
    const promotingSiteLabel = nonEmptyString(
      input.promotingSiteLabel || promotingSiteId,
      'PLAN_SITE_INVALID'
    );
    const promotingWebsiteUrl = normalizeHttpUrl(
      input.promotingWebsiteUrl,
      'PLAN_WEBSITE_URL_INVALID'
    );
    const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE;
    if (
      !Number.isInteger(chunkSize) ||
      chunkSize < 1 ||
      chunkSize > MAX_CHUNK_SIZE
    ) {
      throw new DashboardDataError('PLAN_CHUNK_SIZE_INVALID');
    }
    const urls = normalizePlanUrls(input.urls);
    const id = input.id ?? `plan:${this.makeId()}`;
    const plan: Plan = {
      id,
      name,
      promotingSiteId,
      promotingSiteLabel,
      promotingWebsiteUrl,
      status: 'active',
      chunkSize,
      targetCount: urls.length,
      processedCount: 0,
      submittedCount: 0,
      failedCount: 0,
      unknownCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const batches: PlanBatch[] = [];
    const targets: PlanTarget[] = [];

    for (
      let start = 0, batchSequence = 1;
      start < urls.length;
      start += chunkSize, batchSequence += 1
    ) {
      const currentBatchId = batchId(id, batchSequence);
      const batchUrls = urls.slice(start, start + chunkSize);
      batches.push({
        id: currentBatchId,
        planId: id,
        sequence: batchSequence,
        status: 'pending',
        targetCount: batchUrls.length,
        processedCount: 0,
        submittedCount: 0,
        failedCount: 0,
        unknownCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      for (const [offset, url] of batchUrls.entries()) {
        const sequence = start + offset + 1;
        targets.push({
          id: targetId(id, sequence),
          planId: id,
          batchId: currentBatchId,
          batchSequence,
          sequence,
          url,
          host: new URL(url).hostname.toLowerCase(),
          status: 'pending',
          attemptCount: 0,
          latestMessage: '',
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return this.transaction(
      [
        DASHBOARD_STORE_NAMES.plans,
        DASHBOARD_STORE_NAMES.planBatches,
        DASHBOARD_STORE_NAMES.planTargets,
      ],
      'readwrite',
      async (transaction) => {
        const planStore = transaction.objectStore(DASHBOARD_STORE_NAMES.plans);
        if (await requestResult(planStore.get(id))) {
          throw new DashboardDataError('PLAN_ID_CONFLICT');
        }
        planStore.add(plan);
        const batchStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planBatches
        );
        for (const batch of batches) batchStore.add(batch);
        const targetStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planTargets
        );
        for (const target of targets) targetStore.add(target);
        return { plan, batches };
      }
    );
  }

  async listPlans(options: ListPlansOptions = {}): Promise<Plan[]> {
    return this.transaction(
      [DASHBOARD_STORE_NAMES.plans],
      'readonly',
      async (transaction) => {
        const plans = (await requestResult(
          transaction.objectStore(DASHBOARD_STORE_NAMES.plans).getAll()
        )) as Plan[];
        return sortPlans(
          options.includeArchived
            ? plans
            : plans.filter((plan) => plan.status !== 'archived')
        );
      }
    );
  }

  async getPlanDetail(planIdValue: string): Promise<PlanDetail | null> {
    return this.transaction(
      [DASHBOARD_STORE_NAMES.plans, DASHBOARD_STORE_NAMES.planBatches],
      'readonly',
      async (transaction) => {
        const plan = (await requestResult(
          transaction.objectStore(DASHBOARD_STORE_NAMES.plans).get(planIdValue)
        )) as Plan | undefined;
        if (!plan) return null;
        const batches = await allFromIndex<PlanBatch>(
          transaction.objectStore(DASHBOARD_STORE_NAMES.planBatches),
          INDEXES.batches.plan,
          planIdValue
        );
        return { plan, batches: sortBatches(batches) };
      }
    );
  }

  async findBatchReferenceByExternalBatchId(
    externalBatchId: string
  ): Promise<DashboardBatchReference | null> {
    if (!externalBatchId) return null;
    return this.transaction(
      [DASHBOARD_STORE_NAMES.planBatches, DASHBOARD_STORE_NAMES.runs],
      'readonly',
      async (transaction) => {
        const batchStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planBatches
        );
        const runStore = transaction.objectStore(DASHBOARD_STORE_NAMES.runs);
        const batches = (
          await allFromIndex<PlanBatch>(
            batchStore,
            INDEXES.batches.externalBatch,
            externalBatchId
          )
        ).sort((left, right) => right.updatedAt - left.updatedAt);
        const batch = batches[0];
        if (!batch) return null;

        const byExternal = (
          await allFromIndex<Run>(
            runStore,
            INDEXES.runs.externalBatch,
            externalBatchId
          )
        )
          .filter(
            (candidate) =>
              candidate.planId === batch.planId &&
              candidate.batchId === batch.id
          )
          .sort((left, right) => right.updatedAt - left.updatedAt);
        const currentRun = batch.currentRunId
          ? ((await requestResult(runStore.get(batch.currentRunId))) as
              | Run
              | undefined)
          : undefined;
        const run =
          currentRun &&
          currentRun.planId === batch.planId &&
          currentRun.batchId === batch.id
            ? currentRun
            : byExternal[0];
        if (!run) return null;
        return {
          planId: batch.planId,
          batchId: batch.id,
          runId: run.id,
          externalBatchId,
          batchStatus: batch.status,
          runStatus: run.status,
        };
      }
    );
  }

  async findStandaloneRunReferenceByExternalBatchId(
    externalBatchId: string
  ): Promise<DashboardStandaloneRunReference | null> {
    if (!externalBatchId) return null;
    return this.transaction(
      [DASHBOARD_STORE_NAMES.runs],
      'readonly',
      async (transaction) => {
        const runs = (
          await allFromIndex<Run>(
            transaction.objectStore(DASHBOARD_STORE_NAMES.runs),
            INDEXES.runs.externalBatch,
            externalBatchId
          )
        )
          .filter(
            (run) => run.planId === undefined && run.batchId === undefined
          )
          .sort((left, right) => right.updatedAt - left.updatedAt);
        const run = runs[0];
        if (!run || !run.externalBatchId) return null;
        return {
          runId: run.id,
          externalBatchId: run.externalBatchId,
          runStatus: run.status,
        };
      }
    );
  }

  async getTargets(
    planIdValue: string,
    options: TargetPageOptions = {}
  ): Promise<PlanTargetPage> {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > MAX_PAGE_SIZE
    ) {
      throw new DashboardDataError('TARGET_PAGE_INVALID');
    }

    return this.transaction(
      [DASHBOARD_STORE_NAMES.planTargets],
      'readonly',
      async (transaction) => {
        const store = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planTargets
        );
        const targets = options.batchId
          ? await allFromIndex<PlanTarget>(
              store,
              INDEXES.targets.batch,
              options.batchId
            )
          : await allFromIndex<PlanTarget>(
              store,
              INDEXES.targets.plan,
              planIdValue
            );
        const matching = sortTargets(
          targets.filter((target) => target.planId === planIdValue)
        );
        const offset = (page - 1) * pageSize;
        return {
          items: matching.slice(offset, offset + pageSize),
          page,
          pageSize,
          total: matching.length,
          totalPages:
            matching.length === 0 ? 0 : Math.ceil(matching.length / pageSize),
        };
      }
    );
  }

  async getBatchTargets(batchIdValue: string): Promise<PlanTarget[]> {
    return this.transaction(
      [DASHBOARD_STORE_NAMES.planTargets],
      'readonly',
      async (transaction) =>
        sortTargets(
          await allFromIndex<PlanTarget>(
            transaction.objectStore(DASHBOARD_STORE_NAMES.planTargets),
            INDEXES.targets.batch,
            batchIdValue
          )
        )
    );
  }

  async getTarget(
    planIdValue: string,
    targetIdValue: string
  ): Promise<PlanTarget | null> {
    return this.transaction(
      [DASHBOARD_STORE_NAMES.planTargets],
      'readonly',
      async (transaction) => {
        const target = (await requestResult(
          transaction
            .objectStore(DASHBOARD_STORE_NAMES.planTargets)
            .get(targetIdValue)
        )) as PlanTarget | undefined;
        return target?.planId === planIdValue ? target : null;
      }
    );
  }

  async getAttempts(targetIdValue: string): Promise<Attempt[]> {
    return this.transaction(
      [DASHBOARD_STORE_NAMES.attempts],
      'readonly',
      async (transaction) => {
        const attempts = await allFromIndex<Attempt>(
          transaction.objectStore(DASHBOARD_STORE_NAMES.attempts),
          INDEXES.attempts.target,
          targetIdValue
        );
        return attempts.sort(
          (left, right) =>
            right.attemptNumber - left.attemptNumber ||
            right.updatedAt - left.updatedAt
        );
      }
    );
  }

  async getPendingModerationChecks(
    limit = 12
  ): Promise<PendingModerationCheck[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.transaction(
      [
        DASHBOARD_STORE_NAMES.plans,
        DASHBOARD_STORE_NAMES.planTargets,
        DASHBOARD_STORE_NAMES.attempts,
      ],
      'readonly',
      async (transaction) => {
        const targetStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planTargets
        );
        const planStore = transaction.objectStore(DASHBOARD_STORE_NAMES.plans);
        const attemptStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.attempts
        );
        const targets = (
          await Promise.all(
            ['pending_moderation', 'unconfirmed'].map((status) =>
              allFromIndex<PlanTarget>(
                targetStore,
                INDEXES.targets.status,
                status
              )
            )
          )
        ).flat();
        const checks: PendingModerationCheck[] = [];
        for (const target of targets.sort(
          (left, right) =>
            (left.lastModerationCheckAt ?? 0) -
              (right.lastModerationCheckAt ?? 0) ||
            left.updatedAt - right.updatedAt ||
            left.sequence - right.sequence
        )) {
          if (checks.length >= boundedLimit) break;
          const attempts = await allFromIndex<Attempt>(
            attemptStore,
            INDEXES.attempts.target,
            target.id
          );
          const attempt = attempts
            .filter((candidate) => candidate.status === target.status)
            .sort(
              (left, right) =>
                right.attemptNumber - left.attemptNumber ||
                right.updatedAt - left.updatedAt
            )[0];
          const fingerprint =
            attempt?.commentFingerprint ??
            (attempt?.comment ? commentFingerprint(attempt.comment) : '');
          if (!attempt || !fingerprint) continue;
          const plan = (await requestResult(planStore.get(target.planId))) as
            | Plan
            | undefined;
          if (!plan?.promotingWebsiteUrl) continue;
          checks.push({
            targetId: target.id,
            attemptId: attempt.id,
            planId: target.planId,
            url: target.url,
            targetWebsiteUrl: plan.promotingWebsiteUrl,
            fingerprint,
            checkCount: attempt.timeline.filter(
              (event) => event.stage === 'moderation_recheck'
            ).length,
            ...(target.lastModerationCheckAt
              ? { lastCheckAt: target.lastModerationCheckAt }
              : {}),
            ...(target.lastModerationCheckMessage
              ? { lastCheckMessage: target.lastModerationCheckMessage }
              : {}),
          });
        }
        return checks;
      }
    );
  }

  async getRecentModerationTransitions(
    limit = 50
  ): Promise<ModerationPublishedTransition[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.transaction(
      [DASHBOARD_STORE_NAMES.planTargets, DASHBOARD_STORE_NAMES.attempts],
      'readonly',
      async (transaction) => {
        const targetStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planTargets
        );
        const attemptStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.attempts
        );
        const targets = (await requestResult(
          targetStore.getAll()
        )) as PlanTarget[];
        const targetById = new Map(
          targets.map((target) => [target.id, target])
        );
        const attempts = (await requestResult(
          attemptStore.getAll()
        )) as Attempt[];
        const transitions: ModerationPublishedTransition[] = [];
        for (const attempt of attempts) {
          const published = [...attempt.timeline]
            .reverse()
            .find(
              (event) =>
                event.stage === 'moderation_recheck' &&
                event.status === 'published'
            );
          const target = attempt.targetId
            ? targetById.get(attempt.targetId)
            : undefined;
          if (!published || !target || !attempt.targetId) continue;
          transitions.push({
            targetId: attempt.targetId,
            planId: target.planId,
            url: target.url,
            fingerprint:
              attempt.commentFingerprint ??
              (attempt.comment ? commentFingerprint(attempt.comment) : ''),
            checkCount: attempt.timeline.filter(
              (event) => event.stage === 'moderation_recheck'
            ).length,
            publishedAt: published.at,
            message: published.message,
          });
        }
        return transitions
          .sort((left, right) => right.publishedAt - left.publishedAt)
          .slice(0, boundedLimit);
      }
    );
  }

  async recordModerationCheck(
    input: RecordModerationCheckInput
  ): Promise<PlanTarget | null> {
    const at = input.at ?? this.clock();
    return this.transaction(
      [
        DASHBOARD_STORE_NAMES.plans,
        DASHBOARD_STORE_NAMES.planBatches,
        DASHBOARD_STORE_NAMES.planTargets,
        DASHBOARD_STORE_NAMES.attempts,
      ],
      'readwrite',
      async (transaction) => {
        const planStore = transaction.objectStore(DASHBOARD_STORE_NAMES.plans);
        const batchStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planBatches
        );
        const targetStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planTargets
        );
        const attemptStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.attempts
        );
        const originalTarget = (await requestResult(
          targetStore.get(input.targetId)
        )) as PlanTarget | undefined;
        // A user retry or a late batch sync may have moved it on since this
        // read-only check was selected. Never overwrite that newer result.
        if (
          !originalTarget ||
          (!input.preserveCurrentStatus &&
            originalTarget.status !== 'pending_moderation' &&
            originalTarget.status !== 'unconfirmed')
        ) {
          return null;
        }
        const originalAttempt = (await requestResult(
          attemptStore.get(input.attemptId)
        )) as Attempt | undefined;
        if (
          !originalAttempt ||
          originalAttempt.targetId !== originalTarget.id ||
          (!input.preserveCurrentStatus &&
            originalAttempt.status !== 'pending_moderation' &&
            originalAttempt.status !== 'unconfirmed')
        ) {
          return null;
        }
        const plan = (await requestResult(
          planStore.get(originalTarget.planId)
        )) as Plan | undefined;
        const originalBatch = (await requestResult(
          batchStore.get(originalTarget.batchId)
        )) as PlanBatch | undefined;
        if (!plan || !originalBatch || originalBatch.planId !== plan.id) {
          return null;
        }

        const targetStatus =
          input.status === 'published' ? 'published' : originalTarget.status;
        const target: PlanTarget = {
          ...originalTarget,
          status:
            input.status === 'published' ? 'published' : originalTarget.status,
          ...(targetStatus === 'published'
            ? { latestMessage: input.message }
            : {}),
          lastModerationCheckAt: at,
          lastModerationCheckMessage: input.message,
          updatedAt: at,
        };
        if (targetStatus === 'published') {
          Reflect.deleteProperty(target, 'lastError');
        }
        const attempt: Attempt = {
          ...originalAttempt,
          status: targetStatus,
          timeline: [
            ...originalAttempt.timeline,
            {
              stage: 'moderation_recheck',
              status: input.status,
              message: input.message,
              at,
            },
          ].slice(-100),
          updatedAt: at,
          ...(targetStatus === 'published' ? { completedAt: at } : {}),
        };
        targetStore.put(target);
        attemptStore.put(attempt);

        const planTargets = await allFromIndex<PlanTarget>(
          targetStore,
          INDEXES.targets.plan,
          plan.id
        );
        const updatedPlanTargets = planTargets.map((candidate) =>
          candidate.id === target.id ? target : candidate
        );
        const batchTargets = updatedPlanTargets.filter(
          (candidate) => candidate.batchId === originalBatch.id
        );
        const updatedBatch = applyCountsToBatch(
          { ...originalBatch, updatedAt: at },
          batchTargets
        );
        batchStore.put(updatedBatch);
        const allBatches = (
          await allFromIndex<PlanBatch>(
            batchStore,
            INDEXES.batches.plan,
            plan.id
          )
        ).map((candidate) =>
          candidate.id === updatedBatch.id ? updatedBatch : candidate
        );
        planStore.put(
          applyCountsToPlan(plan, updatedPlanTargets, allBatches, at)
        );
        return target;
      }
    );
  }

  async getRunAttempts(runIdValue: string): Promise<Attempt[]> {
    return this.transaction(
      [DASHBOARD_STORE_NAMES.attempts],
      'readonly',
      async (transaction) =>
        (
          await allFromIndex<Attempt>(
            transaction.objectStore(DASHBOARD_STORE_NAMES.attempts),
            INDEXES.attempts.run,
            runIdValue
          )
        ).sort((left, right) => left.updatedAt - right.updatedAt)
    );
  }

  async getRun(runIdValue: string): Promise<Run | null> {
    return this.transaction(
      [DASHBOARD_STORE_NAMES.runs],
      'readonly',
      async (transaction) =>
        ((await requestResult(
          transaction.objectStore(DASHBOARD_STORE_NAMES.runs).get(runIdValue)
        )) as Run | undefined) ?? null
    );
  }

  async getNextRunnableBatch(
    planIdValue: string,
    at: number = this.clock()
  ): Promise<PlanBatch | null> {
    const detail = await this.getPlanDetail(planIdValue);
    if (!detail) throw new DashboardDataError('PLAN_NOT_FOUND');
    if (detail.plan.status === 'archived') {
      throw new DashboardDataError('PLAN_ARCHIVED');
    }
    if (
      detail.batches.some(
        (batch) =>
          batch.startedAt !== undefined && sameLocalDay(batch.startedAt, at)
      )
    ) {
      return null;
    }
    return detail.batches.find((batch) => batch.status === 'pending') ?? null;
  }

  async renamePlan(
    planIdValue: string,
    nameValue: string,
    at: number = this.clock()
  ): Promise<Plan> {
    const name = nonEmptyString(nameValue, 'PLAN_NAME_INVALID');
    return this.transaction(
      [DASHBOARD_STORE_NAMES.plans],
      'readwrite',
      async (transaction) => {
        const store = transaction.objectStore(DASHBOARD_STORE_NAMES.plans);
        const plan = (await requestResult(store.get(planIdValue))) as
          | Plan
          | undefined;
        if (!plan) throw new DashboardDataError('PLAN_NOT_FOUND');
        if (plan.status === 'archived') {
          throw new DashboardDataError('PLAN_ARCHIVED');
        }
        const renamed: Plan = {
          ...plan,
          name,
          updatedAt: at,
        };
        store.put(renamed);
        return renamed;
      }
    );
  }

  async archivePlan(
    planIdValue: string,
    at: number = this.clock()
  ): Promise<Plan> {
    return this.transaction(
      [DASHBOARD_STORE_NAMES.plans],
      'readwrite',
      async (transaction) => {
        const store = transaction.objectStore(DASHBOARD_STORE_NAMES.plans);
        const plan = (await requestResult(store.get(planIdValue))) as
          | Plan
          | undefined;
        if (!plan) throw new DashboardDataError('PLAN_NOT_FOUND');
        const archived: Plan = {
          ...plan,
          status: 'archived',
          archivedAt: at,
          updatedAt: at,
        };
        store.put(archived);
        return archived;
      }
    );
  }

  async deletePlanPermanently(planIdValue: string): Promise<void> {
    await this.transaction(
      [
        DASHBOARD_STORE_NAMES.plans,
        DASHBOARD_STORE_NAMES.planBatches,
        DASHBOARD_STORE_NAMES.planTargets,
        DASHBOARD_STORE_NAMES.runs,
        DASHBOARD_STORE_NAMES.attempts,
      ],
      'readwrite',
      async (transaction) => {
        const planStore = transaction.objectStore(DASHBOARD_STORE_NAMES.plans);
        const plan = (await requestResult(planStore.get(planIdValue))) as
          | Plan
          | undefined;
        if (!plan) throw new DashboardDataError('PLAN_NOT_FOUND');
        if (plan.status !== 'archived') {
          throw new DashboardDataError('PLAN_DELETE_REQUIRES_ARCHIVE');
        }

        const batchStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planBatches
        );
        const targetStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planTargets
        );
        const runStore = transaction.objectStore(DASHBOARD_STORE_NAMES.runs);
        const attemptStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.attempts
        );
        const [batchKeys, targetKeys, runKeys, attemptKeys] = await Promise.all(
          [
            requestResult(
              batchStore.index(INDEXES.batches.plan).getAllKeys(planIdValue)
            ),
            requestResult(
              targetStore.index(INDEXES.targets.plan).getAllKeys(planIdValue)
            ),
            requestResult(
              runStore.index(INDEXES.runs.plan).getAllKeys(planIdValue)
            ),
            requestResult(
              attemptStore.index(INDEXES.attempts.plan).getAllKeys(planIdValue)
            ),
          ]
        );
        for (const key of batchKeys) batchStore.delete(key);
        for (const key of targetKeys) targetStore.delete(key);
        for (const key of runKeys) runStore.delete(key);
        for (const key of attemptKeys) attemptStore.delete(key);
        planStore.delete(planIdValue);
      }
    );
  }

  /**
   * Removes one target from a non-archived plan after checking live and
   * resumable batch state in the same IndexedDB transaction. This closes the
   * gap between a UI pre-check and a concurrent batch activation.
   */
  async deleteTarget(
    planIdValue: string,
    targetIdValue: string,
    at: number = this.clock()
  ): Promise<PlanTarget> {
    return this.transaction(
      [
        DASHBOARD_STORE_NAMES.plans,
        DASHBOARD_STORE_NAMES.planBatches,
        DASHBOARD_STORE_NAMES.planTargets,
        DASHBOARD_STORE_NAMES.runs,
        DASHBOARD_STORE_NAMES.attempts,
      ],
      'readwrite',
      async (transaction) => {
        const planStore = transaction.objectStore(DASHBOARD_STORE_NAMES.plans);
        const batchStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planBatches
        );
        const targetStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planTargets
        );
        const runStore = transaction.objectStore(DASHBOARD_STORE_NAMES.runs);
        const attemptStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.attempts
        );
        const plan = (await requestResult(planStore.get(planIdValue))) as
          | Plan
          | undefined;
        if (!plan) throw new DashboardDataError('PLAN_NOT_FOUND');
        if (plan.status === 'archived') {
          throw new DashboardDataError('PLAN_ARCHIVED');
        }
        const target = (await requestResult(targetStore.get(targetIdValue))) as
          | PlanTarget
          | undefined;
        if (!target || target.planId !== plan.id) {
          throw new DashboardDataError('PLAN_TARGET_NOT_FOUND');
        }

        const [allTargets, batches, runs, attempts] = await Promise.all([
          allFromIndex<PlanTarget>(targetStore, INDEXES.targets.plan, plan.id),
          allFromIndex<PlanBatch>(batchStore, INDEXES.batches.plan, plan.id),
          allFromIndex<Run>(runStore, INDEXES.runs.plan, plan.id),
          allFromIndex<Attempt>(
            attemptStore,
            INDEXES.attempts.target,
            target.id
          ),
        ]);
        const targetBatch = batches.find(
          (batch) => batch.id === target.batchId
        );
        if (!targetBatch || targetBatch.planId !== plan.id) {
          throw new DashboardDataError('BATCH_NOT_FOUND');
        }
        if (batchHasActiveRunForTargetDeletion(targetBatch, runs)) {
          throw new DashboardDataError('BATCH_ALREADY_ACTIVE');
        }

        const remainingTargets = allTargets.filter(
          (candidate) => candidate.id !== target.id
        );

        targetStore.delete(target.id);
        for (const attempt of attempts) attemptStore.delete(attempt.id);
        for (const run of runs) {
          if (!run.targetIds.includes(target.id)) continue;
          runStore.put({
            ...run,
            targetIds: run.targetIds.filter((id) => id !== target.id),
            updatedAt: at,
          } satisfies Run);
        }

        const updatedBatches = batches.map((batch) => {
          const batchTargets = remainingTargets.filter(
            (candidate) => candidate.batchId === batch.id
          );
          const counted = applyCountsToBatch(
            { ...batch, updatedAt: at },
            batchTargets
          );
          const allSettled =
            batchTargets.length === 0 ||
            batchTargets.every(
              (candidate) =>
                isProcessedTargetStatus(candidate.status) ||
                candidate.status === 'unknown'
            );
          if (!allSettled) return counted;
          const counts = countTargetStatuses(batchTargets);
          return {
            ...counted,
            status:
              counts.failed > 0 || counts.unknown > 0
                ? 'completed_with_errors'
                : 'completed',
            completedAt: batch.completedAt ?? at,
          } satisfies PlanBatch;
        });
        for (const batch of updatedBatches) batchStore.put(batch);
        planStore.put(
          applyCountsToPlan(plan, remainingTargets, updatedBatches, at)
        );
        return target;
      }
    );
  }

  async startBatchRun(
    planIdValue: string,
    batchIdValue: string,
    input: StartBatchRunInput = {}
  ): Promise<BatchRunStart> {
    const at = input.at ?? this.clock();
    const kind = input.kind ?? 'batch';

    return this.transaction(
      [
        DASHBOARD_STORE_NAMES.plans,
        DASHBOARD_STORE_NAMES.planBatches,
        DASHBOARD_STORE_NAMES.planTargets,
        DASHBOARD_STORE_NAMES.runs,
      ],
      'readwrite',
      async (transaction) => {
        const planStore = transaction.objectStore(DASHBOARD_STORE_NAMES.plans);
        const batchStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planBatches
        );
        const targetStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planTargets
        );
        const runStore = transaction.objectStore(DASHBOARD_STORE_NAMES.runs);
        const plan = (await requestResult(planStore.get(planIdValue))) as
          | Plan
          | undefined;
        if (!plan) throw new DashboardDataError('PLAN_NOT_FOUND');
        if (plan.status === 'archived') {
          throw new DashboardDataError('PLAN_ARCHIVED');
        }
        const batch = (await requestResult(batchStore.get(batchIdValue))) as
          | PlanBatch
          | undefined;
        if (!batch || batch.planId !== planIdValue) {
          throw new DashboardDataError('BATCH_NOT_FOUND');
        }
        const planBatches = sortBatches(
          await allFromIndex<PlanBatch>(
            batchStore,
            INDEXES.batches.plan,
            planIdValue
          )
        );
        const batchTargets = sortTargets(
          await allFromIndex<PlanTarget>(
            targetStore,
            INDEXES.targets.batch,
            batchIdValue
          )
        );

        const activeRuns = (
          (await requestResult(runStore.getAll())) as Run[]
        ).filter((run) => run.status === 'running' || run.status === 'blocked');
        const resumableCurrent =
          kind === 'resume'
            ? activeRuns.find((run) => run.id === batch.currentRunId)
            : undefined;
        if (
          activeRuns.some(
            (run) => !resumableCurrent || run.id !== resumableCurrent.id
          )
        ) {
          throw new DashboardDataError('RUN_ALREADY_ACTIVE');
        }
        if (resumableCurrent) {
          runStore.put({
            ...resumableCurrent,
            status: 'interrupted',
            completedAt: at,
            updatedAt: at,
          } satisfies Run);
        }

        if (kind === 'batch') {
          if (
            batch.status !== 'pending' ||
            planBatches.find((candidate) => candidate.status === 'pending')
              ?.id !== batch.id
          ) {
            throw new DashboardDataError('BATCH_NOT_RUNNABLE');
          }
          if (
            planBatches.some(
              (candidate) =>
                candidate.startedAt !== undefined &&
                sameLocalDay(candidate.startedAt, at)
            )
          ) {
            throw new DashboardDataError('BATCH_ALREADY_STARTED_TODAY');
          }
        } else if (kind === 'resume') {
          if (
            batch.status !== 'interrupted' &&
            batch.status !== 'blocked' &&
            batch.status !== 'running'
          ) {
            throw new DashboardDataError('BATCH_NOT_RUNNABLE');
          }
        } else if (!isTerminalBatchStatus(batch.status)) {
          throw new DashboardDataError('BATCH_NOT_RUNNABLE');
        }

        const requestedTargetIds = input.targetIds
          ? new Set(input.targetIds)
          : null;
        let selected = batchTargets.filter((target) => {
          if (requestedTargetIds && !requestedTargetIds.has(target.id)) {
            return false;
          }
          if (kind === 'retry') return isFailedTargetStatus(target.status);
          if (kind === 'resume') {
            return (
              target.status === 'pending' ||
              target.status === 'running' ||
              target.status === 'blocked' ||
              target.status === 'interrupted'
            );
          }
          return target.status === 'pending';
        });
        if (requestedTargetIds && selected.length !== requestedTargetIds.size) {
          throw new DashboardDataError('RETRY_TARGET_INVALID');
        }
        if (selected.length === 0) {
          throw new DashboardDataError(
            kind === 'retry' ? 'RETRY_TARGET_INVALID' : 'BATCH_NOT_RUNNABLE'
          );
        }

        selected = selected.map((target) => ({
          ...target,
          status: 'pending',
          updatedAt: at,
        }));
        for (const target of selected) targetStore.put(target);

        const identifier = input.runId ?? runId(this.makeId);
        if (await requestResult(runStore.get(identifier))) {
          throw new DashboardDataError('RUN_ALREADY_ACTIVE');
        }
        const run: Run = {
          id: identifier,
          planId: plan.id,
          batchId: batch.id,
          ...(input.externalBatchId
            ? { externalBatchId: input.externalBatchId }
            : {}),
          kind,
          status: 'running',
          targetIds: selected.map((target) => target.id),
          createdAt: at,
          startedAt: at,
          updatedAt: at,
        };
        runStore.add(run);

        const runningBatch: PlanBatch = {
          ...batch,
          status: 'running',
          currentRunId: run.id,
          ...(input.externalBatchId
            ? { externalBatchId: input.externalBatchId }
            : {}),
          startedAt: batch.startedAt ?? at,
          updatedAt: at,
        };
        Reflect.deleteProperty(runningBatch, 'completedAt');
        batchStore.put(runningBatch);

        const activePlan: Plan = {
          ...plan,
          status: 'active',
          updatedAt: at,
        };
        planStore.put(activePlan);
        return {
          plan: activePlan,
          batch: runningBatch,
          run,
          targets: selected,
        };
      }
    );
  }

  async resumeBatchRun(
    planIdValue: string,
    batchIdValue: string,
    input: Omit<StartBatchRunInput, 'kind' | 'targetIds'> = {}
  ): Promise<BatchRunStart> {
    return this.startBatchRun(planIdValue, batchIdValue, {
      ...input,
      kind: 'resume',
    });
  }

  async startStandaloneBatchRun(
    snapshot: BatchSnapshot,
    kind: Exclude<DashboardRunKind, 'legacy'> = 'batch',
    at: number = this.clock()
  ): Promise<Run> {
    return this.transaction(
      [DASHBOARD_STORE_NAMES.runs],
      'readwrite',
      async (transaction) => {
        const runStore = transaction.objectStore(DASHBOARD_STORE_NAMES.runs);
        const activeRuns = (
          (await requestResult(runStore.getAll())) as Run[]
        ).filter((run) => run.status === 'running' || run.status === 'blocked');
        if (activeRuns.length > 0) {
          throw new DashboardDataError('RUN_ALREADY_ACTIVE');
        }
        const status = standaloneRunStatusFromSnapshot(snapshot);
        const run: Run = {
          id: runId(this.makeId),
          externalBatchId: snapshot.id,
          kind,
          status,
          targetIds: [],
          createdAt: at,
          startedAt: at,
          updatedAt: at,
          ...(isTerminalRunStatus(status) ? { completedAt: at } : {}),
        };
        runStore.add(run);
        return run;
      }
    );
  }

  async prepareRetry(
    planIdValue: string,
    targetIds: string[],
    input: RetryRunInput = {}
  ): Promise<BatchRunStart> {
    const uniqueTargetIds = [...new Set(targetIds)];
    if (uniqueTargetIds.length === 0) {
      throw new DashboardDataError('RETRY_TARGET_INVALID');
    }
    const targets = await this.transaction(
      [DASHBOARD_STORE_NAMES.planTargets],
      'readonly',
      async (transaction) => {
        const store = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planTargets
        );
        return Promise.all(
          uniqueTargetIds.map(
            async (id) =>
              ((await requestResult(store.get(id))) as
                | PlanTarget
                | undefined) ?? null
          )
        );
      }
    );
    if (
      targets.some(
        (target) =>
          !target ||
          target.planId !== planIdValue ||
          !isFailedTargetStatus(target.status)
      )
    ) {
      throw new DashboardDataError('RETRY_TARGET_INVALID');
    }
    const first = targets[0]!;
    if (targets.some((target) => target?.batchId !== first.batchId)) {
      throw new DashboardDataError('RETRY_TARGET_BATCH_MISMATCH');
    }
    return this.startBatchRun(planIdValue, first.batchId, {
      ...input,
      kind: 'retry',
      targetIds: uniqueTargetIds,
    });
  }

  async syncStandaloneBatchSnapshot(
    runIdValue: string,
    snapshot: BatchSnapshot,
    at: number = snapshot.updatedAt ?? this.clock()
  ): Promise<Run> {
    return this.transaction(
      [DASHBOARD_STORE_NAMES.runs, DASHBOARD_STORE_NAMES.attempts],
      'readwrite',
      async (transaction) => {
        const runStore = transaction.objectStore(DASHBOARD_STORE_NAMES.runs);
        const attemptStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.attempts
        );
        const run = (await requestResult(runStore.get(runIdValue))) as
          | Run
          | undefined;
        if (
          !run ||
          run.planId !== undefined ||
          run.batchId !== undefined ||
          run.externalBatchId !== snapshot.id
        ) {
          throw new DashboardDataError('RUN_NOT_FOUND');
        }
        const attempts = new Map(
          (
            await allFromIndex<Attempt>(
              attemptStore,
              INDEXES.attempts.run,
              run.id
            )
          ).map((attempt) => [attempt.id, attempt])
        );
        for (const item of snapshot.items) {
          const identifier = attemptId(run.id, item.id);
          const existing = attempts.get(identifier);
          if (item.status === 'queued' && !existing) continue;
          const status = mapBatchItemStatus(item.status);
          const error = friendlyError(status, item.message, item.updatedAt);
          const comment =
            item.prepared?.comment ?? item.comment ?? existing?.comment;
          const fingerprint = comment
            ? commentFingerprint(comment)
            : existing?.commentFingerprint;
          const attempt: Attempt = {
            id: identifier,
            runId: run.id,
            url: item.url,
            attemptNumber: 1,
            status,
            timeline: item.events.map((event) => ({
              stage: event.status,
              status: mapBatchItemStatus(event.status),
              message: event.message,
              at: event.at,
            })),
            ...(comment ? { comment } : {}),
            ...(fingerprint ? { commentFingerprint: fingerprint } : {}),
            ...(error ? { error } : {}),
            createdAt:
              existing?.createdAt ?? item.events[0]?.at ?? item.createdAt,
            updatedAt: item.updatedAt,
            ...(isProcessedTargetStatus(status)
              ? { completedAt: item.updatedAt }
              : {}),
          };
          attemptStore.put(attempt);
        }
        const status = standaloneRunStatusFromSnapshot(snapshot);
        const updated: Run = {
          ...run,
          status,
          updatedAt: at,
          ...(isTerminalRunStatus(status) ? { completedAt: at } : {}),
        };
        if (!isTerminalRunStatus(status)) {
          Reflect.deleteProperty(updated, 'completedAt');
        }
        runStore.put(updated);
        return updated;
      }
    );
  }

  async syncBatchSnapshot(
    planIdValue: string,
    batchIdValue: string,
    snapshot: BatchSnapshot,
    options: SyncBatchSnapshotOptions = {}
  ): Promise<PlanDetail> {
    const at = options.at ?? snapshot.updatedAt ?? this.clock();

    return this.transaction(
      [
        DASHBOARD_STORE_NAMES.plans,
        DASHBOARD_STORE_NAMES.planBatches,
        DASHBOARD_STORE_NAMES.planTargets,
        DASHBOARD_STORE_NAMES.runs,
        DASHBOARD_STORE_NAMES.attempts,
      ],
      'readwrite',
      async (transaction) => {
        const planStore = transaction.objectStore(DASHBOARD_STORE_NAMES.plans);
        const batchStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planBatches
        );
        const targetStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planTargets
        );
        const runStore = transaction.objectStore(DASHBOARD_STORE_NAMES.runs);
        const attemptStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.attempts
        );
        const plan = (await requestResult(planStore.get(planIdValue))) as
          | Plan
          | undefined;
        if (!plan) throw new DashboardDataError('PLAN_NOT_FOUND');
        const originalBatch = (await requestResult(
          batchStore.get(batchIdValue)
        )) as PlanBatch | undefined;
        if (!originalBatch || originalBatch.planId !== planIdValue) {
          throw new DashboardDataError('BATCH_NOT_FOUND');
        }

        const planTargets = await allFromIndex<PlanTarget>(
          targetStore,
          INDEXES.targets.plan,
          planIdValue
        );
        const batchTargets = sortTargets(
          planTargets.filter((target) => target.batchId === batchIdValue)
        );
        const targetByUrl = new Map(
          batchTargets.map((target) => [target.url, target])
        );
        const targetById = new Map(
          batchTargets.map((target) => [target.id, target])
        );
        const runIdentifier =
          options.runId ?? originalBatch.currentRunId ?? undefined;
        let run = runIdentifier
          ? ((await requestResult(runStore.get(runIdentifier))) as
              | Run
              | undefined)
          : undefined;
        if (!run) {
          const byExternal = await allFromIndex<Run>(
            runStore,
            INDEXES.runs.externalBatch,
            snapshot.id
          );
          run = byExternal.find(
            (candidate) => candidate.batchId === batchIdValue
          );
        }
        if (!run) {
          const identifier = runId(this.makeId);
          run = {
            id: identifier,
            planId: plan.id,
            batchId: originalBatch.id,
            externalBatchId: snapshot.id,
            kind: 'batch',
            status: 'running',
            targetIds: batchTargets.map((target) => target.id),
            createdAt: snapshot.createdAt,
            startedAt: snapshot.createdAt,
            updatedAt: at,
          };
          runStore.add(run);
        }
        // Redirects can replace BatchItem.url. Keep plan target association
        // stable through the original batch order or the selected run order.
        const targetsBySnapshotPosition =
          snapshot.items.length === batchTargets.length
            ? batchTargets
            : snapshot.items.length === run.targetIds.length
              ? run.targetIds.map((targetId) => targetById.get(targetId))
              : [];
        const selectedTargetIds = new Set(run.targetIds);
        const existingAttempts = new Map(
          (
            await allFromIndex<Attempt>(
              attemptStore,
              INDEXES.attempts.run,
              run.id
            )
          ).map((attempt) => [attempt.targetId, attempt])
        );
        const updates = new Map<string, PlanTarget>();

        for (const [snapshotPosition, item] of snapshot.items.entries()) {
          let normalizedUrl = item.url;
          try {
            normalizedUrl = normalizeHttpUrl(
              item.url,
              'PLAN_TARGET_URL_INVALID'
            );
          } catch {
            // Stored snapshots were already validated; exact matching remains
            // a safe fallback for a future legacy shape.
          }
          const target =
            targetsBySnapshotPosition[snapshotPosition] ??
            targetByUrl.get(normalizedUrl) ??
            targetByUrl.get(item.url);
          if (!target) continue;
          const status = mapBatchItemStatus(item.status);
          if (!shouldApplySnapshotTarget(target, item.updatedAt)) {
            continue;
          }
          const error = friendlyError(status, item.message, item.updatedAt);
          const updated: PlanTarget = {
            ...target,
            status,
            latestMessage: item.message,
            ...(error ? { lastError: error } : {}),
            updatedAt: item.updatedAt,
          };
          if (
            status === 'published' ||
            status === 'pending_moderation' ||
            status === 'unconfirmed'
          ) {
            Reflect.deleteProperty(updated, 'lastError');
          }

          const existingAttempt = existingAttempts.get(target.id);
          if (
            selectedTargetIds.has(target.id) &&
            (item.status !== 'queued' || existingAttempt)
          ) {
            const attemptNumber =
              existingAttempt?.attemptNumber ?? target.attemptCount + 1;
            const comment =
              item.prepared?.comment ??
              item.comment ??
              existingAttempt?.comment;
            const fingerprint = comment
              ? commentFingerprint(comment)
              : existingAttempt?.commentFingerprint;
            const attempt: Attempt = {
              id: existingAttempt?.id ?? attemptId(run.id, target.id),
              runId: run.id,
              planId: plan.id,
              batchId: originalBatch.id,
              targetId: target.id,
              url: target.url,
              attemptNumber,
              status,
              timeline: item.events.map((event) => ({
                stage: event.status,
                status: mapBatchItemStatus(event.status),
                message: event.message,
                at: event.at,
              })),
              ...(comment ? { comment } : {}),
              ...(fingerprint ? { commentFingerprint: fingerprint } : {}),
              ...(error ? { error } : {}),
              createdAt:
                existingAttempt?.createdAt ??
                item.events[0]?.at ??
                item.createdAt,
              updatedAt: item.updatedAt,
              ...(isProcessedTargetStatus(status)
                ? { completedAt: item.updatedAt }
                : {}),
            };
            attemptStore.put(attempt);
            updated.attemptCount = Math.max(
              updated.attemptCount,
              attemptNumber
            );
          }
          targetStore.put(updated);
          updates.set(updated.id, updated);
        }

        const updatedPlanTargets = planTargets.map(
          (target) => updates.get(target.id) ?? target
        );
        const updatedBatchTargets = batchTargets.map(
          (target) => updates.get(target.id) ?? target
        );
        let updatedBatch = applyCountsToBatch(
          {
            ...originalBatch,
            externalBatchId: snapshot.id,
            currentRunId: run.id,
            startedAt: originalBatch.startedAt ?? snapshot.createdAt,
            updatedAt: at,
          },
          updatedBatchTargets
        );
        updatedBatch = {
          ...updatedBatch,
          status: batchStatusFromSnapshot(snapshot, updatedBatchTargets),
        };
        if (isTerminalBatchStatus(updatedBatch.status)) {
          updatedBatch.completedAt = at;
        } else {
          Reflect.deleteProperty(updatedBatch, 'completedAt');
        }
        batchStore.put(updatedBatch);

        const updatedRunStatus = runStatusForBatch(updatedBatch.status);
        const updatedRun: Run = {
          ...run,
          externalBatchId: snapshot.id,
          status: updatedRunStatus,
          updatedAt: at,
          ...(isTerminalRunStatus(updatedRunStatus) ? { completedAt: at } : {}),
        };
        runStore.put(updatedRun);

        const allBatches = (
          await allFromIndex<PlanBatch>(
            batchStore,
            INDEXES.batches.plan,
            planIdValue
          )
        ).map((batch) => (batch.id === updatedBatch.id ? updatedBatch : batch));
        const updatedPlan = applyCountsToPlan(
          plan,
          updatedPlanTargets,
          allBatches,
          at
        );
        planStore.put(updatedPlan);
        return { plan: updatedPlan, batches: sortBatches(allBatches) };
      }
    );
  }

  async markBatchInterrupted(
    planIdValue: string,
    batchIdValue: string,
    at: number = this.clock()
  ): Promise<PlanDetail> {
    return this.transaction(
      [
        DASHBOARD_STORE_NAMES.plans,
        DASHBOARD_STORE_NAMES.planBatches,
        DASHBOARD_STORE_NAMES.planTargets,
        DASHBOARD_STORE_NAMES.runs,
      ],
      'readwrite',
      async (transaction) => {
        const planStore = transaction.objectStore(DASHBOARD_STORE_NAMES.plans);
        const batchStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planBatches
        );
        const targetStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planTargets
        );
        const runStore = transaction.objectStore(DASHBOARD_STORE_NAMES.runs);
        const plan = (await requestResult(planStore.get(planIdValue))) as
          | Plan
          | undefined;
        if (!plan) throw new DashboardDataError('PLAN_NOT_FOUND');
        const batch = (await requestResult(batchStore.get(batchIdValue))) as
          | PlanBatch
          | undefined;
        if (!batch || batch.planId !== plan.id) {
          throw new DashboardDataError('BATCH_NOT_FOUND');
        }
        const planTargets = await allFromIndex<PlanTarget>(
          targetStore,
          INDEXES.targets.plan,
          plan.id
        );
        const updatedTargets = planTargets.map((target) => {
          if (
            target.batchId !== batch.id ||
            isProcessedTargetStatus(target.status) ||
            target.status === 'unknown'
          ) {
            return target;
          }
          const updated: PlanTarget = {
            ...target,
            status: 'interrupted',
            updatedAt: at,
          };
          targetStore.put(updated);
          return updated;
        });
        const updatedBatch = applyCountsToBatch(
          { ...batch, status: 'interrupted', updatedAt: at },
          updatedTargets.filter((target) => target.batchId === batch.id)
        );
        Reflect.deleteProperty(updatedBatch, 'completedAt');
        batchStore.put(updatedBatch);

        if (batch.currentRunId) {
          const run = (await requestResult(runStore.get(batch.currentRunId))) as
            | Run
            | undefined;
          if (run) {
            runStore.put({
              ...run,
              status: 'interrupted',
              completedAt: at,
              updatedAt: at,
            } satisfies Run);
          }
        }
        const allBatches = (
          await allFromIndex<PlanBatch>(
            batchStore,
            INDEXES.batches.plan,
            plan.id
          )
        ).map((candidate) =>
          candidate.id === updatedBatch.id ? updatedBatch : candidate
        );
        const updatedPlan = applyCountsToPlan(
          plan,
          updatedTargets,
          allBatches,
          at
        );
        planStore.put(updatedPlan);
        return { plan: updatedPlan, batches: sortBatches(allBatches) };
      }
    );
  }

  async getDashboardSummary(
    options: DashboardSummaryOptions = {}
  ): Promise<DashboardSummary> {
    const now = options.now ?? this.clock();
    const recentFailureLimit =
      options.recentFailureLimit ?? DEFAULT_RECENT_FAILURE_LIMIT;
    if (
      !Number.isInteger(recentFailureLimit) ||
      recentFailureLimit < 0 ||
      recentFailureLimit > 100
    ) {
      throw new DashboardDataError('TARGET_PAGE_INVALID');
    }

    return this.transaction(
      [
        DASHBOARD_STORE_NAMES.plans,
        DASHBOARD_STORE_NAMES.planBatches,
        DASHBOARD_STORE_NAMES.planTargets,
      ],
      'readonly',
      async (transaction) => {
        const allPlans = (await requestResult(
          transaction.objectStore(DASHBOARD_STORE_NAMES.plans).getAll()
        )) as Plan[];
        const plans = allPlans.filter((plan) => plan.status !== 'archived');
        const planIds = new Set(plans.map((plan) => plan.id));
        const allBatches = (await requestResult(
          transaction.objectStore(DASHBOARD_STORE_NAMES.planBatches).getAll()
        )) as PlanBatch[];
        const batches = allBatches.filter((batch) => planIds.has(batch.planId));
        const allTargets = (await requestResult(
          transaction.objectStore(DASHBOARD_STORE_NAMES.planTargets).getAll()
        )) as PlanTarget[];
        const targets = allTargets.filter((target) =>
          planIds.has(target.planId)
        );
        const planById = new Map(plans.map((plan) => [plan.id, plan]));
        const promotingGroups = new Map<
          string,
          PromotingSiteSummary & { planIds: Set<string> }
        >();
        const hostGroups = new Map<string, TargetHostSummary>();

        for (const target of targets) {
          const plan = planById.get(target.planId);
          if (!plan) continue;
          let promotingGroup = promotingGroups.get(plan.promotingSiteId);
          if (!promotingGroup) {
            promotingGroup = {
              siteId: plan.promotingSiteId,
              siteLabel: plan.promotingSiteLabel,
              websiteUrl: plan.promotingWebsiteUrl,
              planCount: 0,
              planIds: new Set<string>(),
              ...newCountsGroup(),
            };
            promotingGroups.set(plan.promotingSiteId, promotingGroup);
          }
          promotingGroup.planIds.add(plan.id);
          addTargetToCounts(promotingGroup, target);

          let hostGroup = hostGroups.get(target.host);
          if (!hostGroup) {
            hostGroup = { host: target.host, ...newCountsGroup() };
            hostGroups.set(target.host, hostGroup);
          }
          addTargetToCounts(hostGroup, target);
        }

        const todaySchedule: ScheduledBatchSummary[] = [];
        const nextSchedule: ScheduledBatchSummary[] = [];
        for (const plan of plans.filter(
          (candidate) => candidate.status === 'active'
        )) {
          const planBatches = sortBatches(
            batches.filter((batch) => batch.planId === plan.id)
          );
          const activeBatch = planBatches.find(
            (batch) =>
              batch.status === 'running' ||
              batch.status === 'blocked' ||
              batch.status === 'interrupted'
          );
          const startedToday = [...planBatches]
            .reverse()
            .find(
              (batch) =>
                batch.startedAt !== undefined &&
                sameLocalDay(batch.startedAt, now)
            );
          const todayBatch =
            activeBatch ??
            startedToday ??
            planBatches.find((batch) => batch.status === 'pending');
          if (!todayBatch) continue;
          todaySchedule.push(scheduleItem(plan, todayBatch));
          const nextBatch = planBatches.find(
            (batch) =>
              batch.status === 'pending' && batch.sequence > todayBatch.sequence
          );
          if (nextBatch) nextSchedule.push(scheduleItem(plan, nextBatch));
        }

        const recentFailures: RecentFailureSummary[] = targets
          .filter(
            (
              target
            ): target is PlanTarget & {
              status: 'no_form' | 'validation_error' | 'failed';
            } => isFailedTargetStatus(target.status)
          )
          .sort((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, recentFailureLimit)
          .map((target) => ({
            planId: target.planId,
            planName: planById.get(target.planId)?.name ?? '',
            batchId: target.batchId,
            targetId: target.id,
            url: target.url,
            host: target.host,
            status: target.status,
            ...(target.lastError ? { error: target.lastError } : {}),
            updatedAt: target.updatedAt,
          }));
        const promotingSites = [...promotingGroups.values()]
          .map(({ planIds: groupPlanIds, ...group }) => ({
            ...group,
            planCount: groupPlanIds.size,
          }))
          .sort(
            (left, right) =>
              right.processed - left.processed ||
              right.total - left.total ||
              left.siteLabel.localeCompare(right.siteLabel)
          );
        const targetHosts = [...hostGroups.values()].sort(
          (left, right) =>
            right.processed - left.processed ||
            right.total - left.total ||
            left.host.localeCompare(right.host)
        );

        return {
          activePlanCount: plans.filter((plan) => plan.status === 'active')
            .length,
          counts: countTargetStatuses(targets),
          todaySchedule,
          nextSchedule,
          promotingSites,
          targetHosts,
          recentFailures,
        };
      }
    );
  }

  async getMeta<T = unknown>(key: string): Promise<T | undefined> {
    return this.transaction(
      [DASHBOARD_STORE_NAMES.meta],
      'readonly',
      async (transaction) => {
        const record = (await requestResult(
          transaction.objectStore(DASHBOARD_STORE_NAMES.meta).get(key)
        )) as DashboardMeta | undefined;
        return record?.value as T | undefined;
      }
    );
  }

  async setMeta(
    key: string,
    value: unknown,
    at: number = this.clock()
  ): Promise<void> {
    await this.transaction(
      [DASHBOARD_STORE_NAMES.meta],
      'readwrite',
      async (transaction) => {
        transaction.objectStore(DASHBOARD_STORE_NAMES.meta).put({
          key,
          value,
          updatedAt: at,
        } satisfies DashboardMeta);
      }
    );
  }

  async importLegacyRecords(
    markerKey: string,
    bundle: LegacyImportBundle,
    at: number = this.clock()
  ): Promise<LegacyImportResult> {
    validateLegacyBundle(bundle);
    const counts = {
      plans: bundle.plans.length,
      batches: bundle.batches.length,
      targets: bundle.targets.length,
      runs: bundle.runs.length,
      attempts: bundle.attempts.length,
    };

    return this.transaction(
      [
        DASHBOARD_STORE_NAMES.plans,
        DASHBOARD_STORE_NAMES.planBatches,
        DASHBOARD_STORE_NAMES.planTargets,
        DASHBOARD_STORE_NAMES.runs,
        DASHBOARD_STORE_NAMES.attempts,
        DASHBOARD_STORE_NAMES.meta,
      ],
      'readwrite',
      async (transaction) => {
        const metaStore = transaction.objectStore(DASHBOARD_STORE_NAMES.meta);
        if (await requestResult(metaStore.get(markerKey))) {
          return { imported: false, counts };
        }
        const planStore = transaction.objectStore(DASHBOARD_STORE_NAMES.plans);
        const batchStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planBatches
        );
        const targetStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.planTargets
        );
        const runStore = transaction.objectStore(DASHBOARD_STORE_NAMES.runs);
        const attemptStore = transaction.objectStore(
          DASHBOARD_STORE_NAMES.attempts
        );
        for (const plan of bundle.plans) planStore.put(plan);
        for (const batch of bundle.batches) batchStore.put(batch);
        for (const target of bundle.targets) targetStore.put(target);
        for (const run of bundle.runs) runStore.put(run);
        for (const attempt of bundle.attempts) attemptStore.put(attempt);
        metaStore.put({
          key: markerKey,
          value: { completed: true, counts },
          updatedAt: at,
        } satisfies DashboardMeta);
        return { imported: true, counts };
      }
    );
  }

  async close(): Promise<void> {
    if (!this.databasePromise) return;
    const database = await this.databasePromise;
    database.close();
    this.databasePromise = undefined;
  }
}

export function createDashboardRepository(
  options: DashboardRepositoryOptions = {}
): DashboardRepository {
  return new DashboardRepository(options);
}

export async function deleteDashboardDatabase(
  options: Pick<DashboardRepositoryOptions, 'databaseName' | 'indexedDB'> = {}
): Promise<void> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) {
    throw new DashboardDataError('DASHBOARD_INDEXED_DB_UNAVAILABLE');
  }
  const request = factory.deleteDatabase(
    options.databaseName ?? DASHBOARD_DB_NAME
  );
  await requestResult(request);
}
