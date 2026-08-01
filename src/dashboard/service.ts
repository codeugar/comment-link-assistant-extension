import type { BatchItemStatus, BatchSnapshot } from '@/batch/types';
import type {
  DashboardActiveRun,
  DashboardPlanTargetPage,
  DashboardSummaryView,
} from '@/runtime/messages';
import {
  type DashboardBatchReference,
  DashboardDataError,
  type DashboardRepository,
  type DashboardStandaloneRunReference as StoredStandaloneRunReference,
  createDashboardRepository,
  normalizePlanUrls,
} from './db';
import type {
  BatchRunStart,
  CreatePlanInput,
  DashboardRunKind,
  Plan,
  PlanBatch,
  PlanDetail,
  Run,
  PlanTarget,
} from './model';
import { parseDashboardTargetRows } from './target-import';

export const DASHBOARD_REVISION_STORAGE_KEY =
  'comment-link-assistant.dashboard-revision';
export const DASHBOARD_ACTIVE_RUN_STORAGE_KEY =
  'comment-link-assistant.dashboard-active-run';

const failedBatchStatuses = new Set<BatchItemStatus>([
  'no_form',
  'validation_error',
  'failed',
]);

function isRunNotFoundError(error: unknown): boolean {
  if (error instanceof DashboardDataError) {
    return error.code === 'RUN_NOT_FOUND';
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'RUN_NOT_FOUND'
  );
}

export function shouldSettlePlanBatch(
  snapshot: Pick<BatchSnapshot, 'status'>
): boolean {
  return snapshot.status === 'completed';
}

export interface DashboardPlanRunReference {
  kind: 'plan';
  planId: string;
  batchId: string;
  runId: string;
  externalBatchId: string;
}

export interface DashboardStandaloneRunReference {
  kind: 'standalone';
  runId: string;
  externalBatchId: string;
}

export type DashboardActiveRunReference =
  | DashboardPlanRunReference
  | DashboardStandaloneRunReference;

export function isDashboardPlanRunReference(
  reference: DashboardActiveRunReference
): reference is DashboardPlanRunReference {
  return reference.kind === 'plan';
}

type RepositoryPort = Pick<
  DashboardRepository,
  | 'archivePlan'
  | 'close'
  | 'createPlan'
  | 'deletePlanPermanently'
  | 'deleteTarget'
  | 'findBatchReferenceByExternalBatchId'
  | 'findStandaloneRunReferenceByExternalBatchId'
  | 'getAttempts'
  | 'getBatchTargets'
  | 'getDashboardSummary'
  | 'getNextRunnableBatch'
  | 'getPlanDetail'
  | 'getRun'
  | 'getTarget'
  | 'getTargets'
  | 'listPlans'
  | 'prepareRetry'
  | 'renamePlan'
  | 'resumeBatchRun'
  | 'startBatchRun'
  | 'startStandaloneBatchRun'
  | 'syncBatchSnapshot'
  | 'syncStandaloneBatchSnapshot'
>;

type LocalStoragePort = Pick<
  chrome.storage.StorageArea,
  'get' | 'set' | 'remove'
>;

export interface DashboardServiceOptions {
  repository?: RepositoryPort;
  storage?: LocalStoragePort;
  now?: () => number;
}

export interface CreateDashboardPlanInput {
  name: string;
  promotingSiteId: string;
  promotingSiteLabel: string;
  promotingWebsiteUrl: string;
  targetText: string;
  chunkSize: number;
}

export function parseDashboardTargetText(targetText: string): string[] {
  if (targetText.length > 5_000_000) {
    throw new DashboardDataError('PLAN_TARGET_LIMIT_EXCEEDED');
  }
  const parsed = parseDashboardTargetRows(targetText);
  if (parsed.invalidLineNumbers.length > 0) {
    throw new DashboardDataError(
      'PLAN_TARGET_URL_INVALID',
      `PLAN_TARGET_URL_INVALID:${parsed.invalidLineNumbers[0]}`
    );
  }
  const candidates = parsed.candidates.map((candidate) => candidate.value);
  try {
    return normalizePlanUrls(candidates);
  } catch (error) {
    if (error instanceof DashboardDataError) {
      const invalidIndex = Number(error.message.split(':')[1]);
      const lineNumber = parsed.candidates[invalidIndex - 1]?.lineNumber;
      if (lineNumber) {
        throw new DashboardDataError(
          'PLAN_TARGET_URL_INVALID',
          `PLAN_TARGET_URL_INVALID:${lineNumber}`
        );
      }
    }
    throw error;
  }
}

function activeReference(value: unknown): DashboardActiveRunReference | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind === 'standalone' &&
    typeof candidate.runId === 'string' &&
    typeof candidate.externalBatchId === 'string'
  ) {
    return {
      kind: 'standalone',
      runId: candidate.runId,
      externalBatchId: candidate.externalBatchId,
    };
  }
  if (
    typeof candidate.planId !== 'string' ||
    typeof candidate.batchId !== 'string' ||
    typeof candidate.runId !== 'string' ||
    typeof candidate.externalBatchId !== 'string'
  ) {
    return null;
  }
  return {
    kind: 'plan',
    planId: candidate.planId,
    batchId: candidate.batchId,
    runId: candidate.runId,
    externalBatchId: candidate.externalBatchId,
  };
}

function snapshotCounts(snapshot: BatchSnapshot) {
  let submitted = 0;
  let failed = 0;
  let filtered = 0;
  for (const item of snapshot.items) {
    if (item.status === 'submitted') submitted += 1;
    else if (failedBatchStatuses.has(item.status)) failed += 1;
    else if (item.status === 'filtered') filtered += 1;
  }
  const processed = submitted + failed + filtered;
  return {
    total: snapshot.items.length,
    processed,
    submitted,
    failed,
    remaining: snapshot.items.length - processed,
  };
}

export class DashboardService {
  readonly repository: RepositoryPort;
  private readonly storage: LocalStoragePort;
  private readonly clock: () => number;
  private lastRevision = 0;
  private revisionTail: Promise<number> = Promise.resolve(0);

  constructor(options: DashboardServiceOptions = {}) {
    this.repository = options.repository ?? createDashboardRepository();
    this.storage = options.storage ?? chrome.storage.local;
    this.clock = options.now ?? Date.now;
  }

  async getActiveRunReference(): Promise<DashboardActiveRunReference | null> {
    const stored = await this.storage.get(DASHBOARD_ACTIVE_RUN_STORAGE_KEY);
    return activeReference(stored[DASHBOARD_ACTIVE_RUN_STORAGE_KEY]);
  }

  private async setActiveRunReference(
    reference: DashboardActiveRunReference
  ): Promise<void> {
    await this.storage.set({ [DASHBOARD_ACTIVE_RUN_STORAGE_KEY]: reference });
  }

  async clearActiveRunReference(): Promise<void> {
    await this.storage.remove(DASHBOARD_ACTIVE_RUN_STORAGE_KEY);
  }

  async restoreActiveRunReference(
    reference: DashboardActiveRunReference
  ): Promise<void> {
    await this.setActiveRunReference(reference);
  }

  findBatchReferenceByExternalBatchId(
    externalBatchId: string
  ): Promise<DashboardBatchReference | null> {
    return this.repository.findBatchReferenceByExternalBatchId(externalBatchId);
  }

  async restoreActiveRunReferenceForExternalBatch(
    externalBatchId: string
  ): Promise<DashboardActiveRunReference | null> {
    const reference =
      await this.findBatchReferenceByExternalBatchId(externalBatchId);
    if (
      reference &&
      (reference.batchStatus === 'running' ||
        reference.batchStatus === 'blocked' ||
        reference.batchStatus === 'interrupted') &&
      (reference.runStatus === 'running' ||
        reference.runStatus === 'blocked' ||
        reference.runStatus === 'interrupted')
    ) {
      const active: DashboardPlanRunReference = {
        kind: 'plan',
        planId: reference.planId,
        batchId: reference.batchId,
        runId: reference.runId,
        externalBatchId: reference.externalBatchId,
      };
      await this.restoreActiveRunReference(active);
      return active;
    }
    const standalone: StoredStandaloneRunReference | null =
      await this.repository.findStandaloneRunReferenceByExternalBatchId(
        externalBatchId
      );
    if (
      !standalone ||
      (standalone.runStatus !== 'running' &&
        standalone.runStatus !== 'blocked' &&
        standalone.runStatus !== 'interrupted')
    ) {
      return null;
    }
    const active: DashboardStandaloneRunReference = {
      kind: 'standalone',
      runId: standalone.runId,
      externalBatchId: standalone.externalBatchId,
    };
    await this.restoreActiveRunReference(active);
    return active;
  }

  async bumpRevision(): Promise<number> {
    const operation = this.revisionTail.then(async () => {
      const stored = await this.storage.get(DASHBOARD_REVISION_STORAGE_KEY);
      const persisted = stored[DASHBOARD_REVISION_STORAGE_KEY];
      const persistedRevision =
        typeof persisted === 'number' && Number.isSafeInteger(persisted)
          ? persisted
          : 0;
      const revision = Math.max(
        this.clock(),
        this.lastRevision + 1,
        persistedRevision + 1
      );
      await this.storage.set({ [DASHBOARD_REVISION_STORAGE_KEY]: revision });
      this.lastRevision = revision;
      return revision;
    });
    this.revisionTail = operation.catch(() => this.lastRevision);
    return operation;
  }

  async createPlan(input: CreateDashboardPlanInput): Promise<PlanDetail> {
    const detail = await this.repository.createPlan({
      name: input.name,
      promotingSiteId: input.promotingSiteId,
      promotingSiteLabel: input.promotingSiteLabel,
      promotingWebsiteUrl: input.promotingWebsiteUrl,
      urls: parseDashboardTargetText(input.targetText),
      chunkSize: input.chunkSize,
    } satisfies CreatePlanInput);
    await this.bumpRevision();
    return detail;
  }

  async listPlans(includeArchived = false): Promise<Plan[]> {
    return this.repository.listPlans({ includeArchived });
  }

  async getPlanDetail(planId: string): Promise<PlanDetail> {
    const detail = await this.repository.getPlanDetail(planId);
    if (!detail) throw new DashboardDataError('PLAN_NOT_FOUND');
    return detail;
  }

  async renamePlan(planId: string, name: string): Promise<Plan> {
    const plan = await this.repository.renamePlan(planId, name);
    await this.bumpRevision();
    return plan;
  }

  async getTargets(
    planId: string,
    options: { batchId?: string; page?: number; pageSize?: number }
  ): Promise<DashboardPlanTargetPage> {
    const page = await this.repository.getTargets(planId, options);
    return {
      ...page,
      items: await Promise.all(
        page.items.map(async (target) => ({
          ...target,
          attempts: await this.repository.getAttempts(target.id),
        }))
      ),
    };
  }

  async getTarget(planId: string, targetId: string): Promise<PlanTarget> {
    const target = await this.repository.getTarget(planId, targetId);
    if (!target) throw new DashboardDataError('PLAN_TARGET_NOT_FOUND');
    return target;
  }

  async archivePlan(planId: string): Promise<Plan> {
    const active = await this.getActiveRunReference();
    if (
      active &&
      isDashboardPlanRunReference(active) &&
      active.planId === planId
    ) {
      throw new Error('BATCH_ALREADY_ACTIVE');
    }
    const plan = await this.repository.archivePlan(planId);
    await this.bumpRevision();
    return plan;
  }

  async deletePlanPermanently(planId: string): Promise<void> {
    const active = await this.getActiveRunReference();
    if (
      active &&
      isDashboardPlanRunReference(active) &&
      active.planId === planId
    ) {
      throw new Error('BATCH_ALREADY_ACTIVE');
    }
    await this.repository.deletePlanPermanently(planId);
    await this.bumpRevision();
  }

  async deleteTarget(planId: string, targetId: string): Promise<PlanTarget> {
    const target = await this.getTarget(planId, targetId);
    const active = await this.getActiveRunReference();
    if (
      active &&
      isDashboardPlanRunReference(active) &&
      active.planId === planId &&
      active.batchId === target.batchId
    ) {
      throw new DashboardDataError('BATCH_ALREADY_ACTIVE');
    }
    const deleted = await this.repository.deleteTarget(planId, targetId);
    await this.bumpRevision();
    return deleted;
  }

  getNextRunnableBatch(planId: string): Promise<PlanBatch | null> {
    return this.repository.getNextRunnableBatch(planId);
  }

  getBatchTargets(batchId: string) {
    return this.repository.getBatchTargets(batchId);
  }

  private async activateRun(
    started: BatchRunStart,
    snapshot: BatchSnapshot
  ): Promise<BatchRunStart> {
    await this.setActiveRunReference({
      kind: 'plan',
      planId: started.plan.id,
      batchId: started.batch.id,
      runId: started.run.id,
      externalBatchId: snapshot.id,
    });
    await this.bumpRevision();
    await this.repository.syncBatchSnapshot(
      started.plan.id,
      started.batch.id,
      snapshot,
      { runId: started.run.id }
    );
    await this.bumpRevision();
    return started;
  }

  async startBatchRun(
    planId: string,
    batchId: string,
    snapshot: BatchSnapshot
  ): Promise<BatchRunStart> {
    const started = await this.repository.startBatchRun(planId, batchId, {
      externalBatchId: snapshot.id,
    });
    return this.activateRun(started, snapshot);
  }

  async resumeBatchRun(
    planId: string,
    batchId: string,
    snapshot: BatchSnapshot
  ): Promise<BatchRunStart> {
    const started = await this.repository.resumeBatchRun(planId, batchId, {
      externalBatchId: snapshot.id,
    });
    return this.activateRun(started, snapshot);
  }

  async prepareRetry(
    planId: string,
    targetIds: string[],
    snapshot: BatchSnapshot
  ): Promise<BatchRunStart> {
    const started = await this.repository.prepareRetry(planId, targetIds, {
      externalBatchId: snapshot.id,
    });
    return this.activateRun(started, snapshot);
  }

  async startStandaloneBatchRun(
    snapshot: BatchSnapshot,
    kind: Exclude<DashboardRunKind, 'legacy'> = 'batch'
  ): Promise<Run> {
    const run = await this.repository.startStandaloneBatchRun(snapshot, kind);
    await this.setActiveRunReference({
      kind: 'standalone',
      runId: run.id,
      externalBatchId: snapshot.id,
    });
    await this.bumpRevision();
    try {
      await this.repository.syncStandaloneBatchSnapshot(run.id, snapshot);
    } catch (error) {
      // A worker can be restarted while IndexedDB is being recreated. Do not
      // leave storage.local pointing at a standalone run that was never saved.
      if (isRunNotFoundError(error)) {
        await this.clearActiveRunReference();
      }
      throw error;
    }
    await this.bumpRevision();
    return run;
  }

  async syncActiveBatch(snapshot: BatchSnapshot): Promise<boolean> {
    const active = await this.getActiveRunReference();
    if (!active || active.externalBatchId !== snapshot.id) return false;
    try {
      if (isDashboardPlanRunReference(active)) {
        await this.repository.syncBatchSnapshot(
          active.planId,
          active.batchId,
          snapshot,
          { runId: active.runId }
        );
      } else {
        await this.repository.syncStandaloneBatchSnapshot(
          active.runId,
          snapshot
        );
      }
    } catch (error) {
      // IndexedDB can be reset while storage.local keeps the active quick-run
      // reference. Preserve the actual browser batch (especially Stop) by
      // registering it again instead of surfacing RUN_NOT_FOUND to both views.
      if (!isDashboardPlanRunReference(active) && isRunNotFoundError(error)) {
        await this.clearActiveRunReference();
        await this.startStandaloneBatchRun(snapshot);
        return true;
      }
      throw error;
    }
    await this.bumpRevision();
    if (snapshot.status === 'completed') {
      await this.clearActiveRunReference();
    }
    return true;
  }

  async getSummary(
    snapshot: BatchSnapshot | null
  ): Promise<DashboardSummaryView> {
    const summary = await this.repository.getDashboardSummary({
      recentFailureLimit: 5,
    });
    const active = snapshot ? await this.getActiveRunReference() : null;
    if (
      !snapshot ||
      !active ||
      !isDashboardPlanRunReference(active) ||
      active.externalBatchId !== snapshot.id
    ) {
      return { ...summary, activeRun: null };
    }
    const [detail, targets, run] = await Promise.all([
      this.getPlanDetail(active.planId),
      this.repository.getBatchTargets(active.batchId),
      this.repository.getRun(active.runId),
    ]);
    const batch = detail.batches.find(
      (candidate) => candidate.id === active.batchId
    );
    if (!batch) return { ...summary, activeRun: null };
    const currentItem = snapshot.items[snapshot.currentIndex] ?? null;
    const targetById = new Map(targets.map((target) => [target.id, target]));
    const targetsBySnapshotPosition =
      snapshot.items.length === targets.length
        ? targets
        : run && snapshot.items.length === run.targetIds.length
          ? run.targetIds.map((targetId) => targetById.get(targetId))
          : [];
    const target = currentItem
      ? (targetsBySnapshotPosition[snapshot.currentIndex] ??
        targets.find((candidate) => candidate.url === currentItem.url) ??
        null)
      : null;
    const currentTarget = target
      ? { ...target, attempts: await this.repository.getAttempts(target.id) }
      : null;
    const activeRun: DashboardActiveRun = {
      planId: detail.plan.id,
      planName: detail.plan.name,
      batchId: batch.id,
      batchSequence: batch.sequence,
      status: snapshot.status,
      currentTarget,
      counts: snapshotCounts(snapshot),
    };
    return { ...summary, activeRun };
  }

  close(): Promise<void> {
    return this.repository.close();
  }
}
