import type { BatchItem, BatchItemStatus, BatchSnapshot } from '@/batch/types';
import type {
  BatchHistoryEntry,
  BatchHistoryItem,
} from '@/storage/batch-history';
import type { PlanChunk, PlansMap, SitePlan } from '@/storage/plans';
import { type DashboardRepository, mapBatchItemStatus } from './db';
import {
  type Attempt,
  type AttemptError,
  type DashboardBatchStatus,
  type DashboardRunStatus,
  type LegacyImportBundle,
  type LegacyImportResult,
  type Plan,
  type PlanBatch,
  type PlanTarget,
  type PlanTargetStatus,
  type Run,
  countTargetStatuses,
  isFailedTargetStatus,
  isProcessedTargetStatus,
} from './model';

export const LEGACY_DASHBOARD_MIGRATION_MARKER =
  'legacy-dashboard-migration:v1';

export interface LegacyDashboardPlanRunReference {
  kind: 'plan';
  planId: string;
  batchId: string;
  runId: string;
  externalBatchId: string;
}

export interface LegacyDashboardStandaloneRunReference {
  kind: 'standalone';
  runId: string;
  externalBatchId: string;
}

export type LegacyDashboardActiveRunReference =
  | LegacyDashboardPlanRunReference
  | LegacyDashboardStandaloneRunReference;

export interface LegacyDashboardMigrationResult extends LegacyImportResult {
  markerKey: string;
  verified: boolean;
  activeRunReference: LegacyDashboardActiveRunReference | null;
}

interface LegacyBatchSource {
  id: string;
  createdAt: number;
  updatedAt: number;
  settings: BatchSnapshot['settings'];
  snapshot?: BatchSnapshot;
  history?: BatchHistoryEntry;
}

type LegacyItem = BatchItem | BatchHistoryItem;

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${stableHash(value)}`;
}

function legacyPlanId(plan: SitePlan): string {
  return stableId('legacy-plan', `${plan.siteId}\u0000${plan.createdAt}`);
}

function normalizedLegacyUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return value;
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function legacyHost(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function sourceItems(source: LegacyBatchSource | undefined): LegacyItem[] {
  return source?.snapshot?.items ?? source?.history?.items ?? [];
}

function sourceStatus(
  source: LegacyBatchSource | undefined,
  targets: PlanTarget[],
  fallback: PlanChunk['status']
): DashboardBatchStatus {
  if (source?.snapshot) {
    if (source.snapshot.status === 'running') return 'running';
    if (source.snapshot.status === 'paused') return 'blocked';
    if (source.snapshot.status === 'stopped') return 'interrupted';
    const counts = countTargetStatuses(targets);
    return counts.failed > 0 || counts.unknown > 0 || counts.interrupted > 0
      ? 'completed_with_errors'
      : 'completed';
  }
  if (source?.history) {
    const counts = countTargetStatuses(targets);
    return counts.failed > 0 ||
      counts.unknown > 0 ||
      counts.interrupted > 0 ||
      counts.blocked > 0 ||
      counts.running > 0 ||
      counts.pending > 0
      ? 'completed_with_errors'
      : 'completed';
  }
  if (fallback === 'pending') return 'pending';
  if (fallback === 'started') return 'interrupted';
  return 'completed_with_errors';
}

function targetStatus(
  chunkStatus: PlanChunk['status'],
  item: LegacyItem | undefined
): PlanTargetStatus {
  if (item) return mapBatchItemStatus(item.status);
  if (chunkStatus === 'pending') return 'pending';
  if (chunkStatus === 'started') return 'interrupted';
  return 'unknown';
}

function errorForLegacyItem(
  status: PlanTargetStatus,
  message: string,
  at: number
): AttemptError | undefined {
  if (!isFailedTargetStatus(status)) return undefined;
  const friendlyMessages = {
    no_form: '没有找到可用的评论表单',
    validation_error: '评论表单未通过网站校验',
    failed: '处理外链时发生错误',
  } as const;
  return {
    code: status.toUpperCase(),
    message,
    friendlyMessage: friendlyMessages[status],
    at,
  };
}

function itemMessage(item: LegacyItem): string {
  return item.message;
}

function itemUpdatedAt(item: LegacyItem, source: LegacyBatchSource): number {
  return 'updatedAt' in item ? item.updatedAt : source.updatedAt;
}

function itemCreatedAt(item: LegacyItem, source: LegacyBatchSource): number {
  return 'createdAt' in item ? item.createdAt : source.createdAt;
}

function attemptTimeline(
  item: LegacyItem,
  source: LegacyBatchSource
): Attempt['timeline'] {
  if ('events' in item) {
    return item.events.map((event) => ({
      stage: event.status,
      status: mapBatchItemStatus(event.status),
      message: event.message,
      at: event.at,
    }));
  }
  return [
    {
      stage: item.status,
      status: mapBatchItemStatus(item.status),
      message: item.message,
      at: source.updatedAt,
    },
  ];
}

function shouldCreateAttempt(item: LegacyItem): boolean {
  return item.status !== 'queued';
}

function runStatus(status: DashboardBatchStatus): DashboardRunStatus {
  if (status === 'running') return 'running';
  if (status === 'blocked') return 'blocked';
  if (status === 'interrupted' || status === 'pending') return 'interrupted';
  if (status === 'completed') return 'completed';
  return 'completed_with_errors';
}

function isTerminalRun(status: DashboardRunStatus): boolean {
  return (
    status === 'interrupted' ||
    status === 'completed' ||
    status === 'completed_with_errors'
  );
}

function sourceMap(
  history: BatchHistoryEntry[],
  currentBatch: BatchSnapshot | null
): Map<string, LegacyBatchSource> {
  const sources = new Map<string, LegacyBatchSource>();
  for (const entry of history) {
    sources.set(entry.id, {
      id: entry.id,
      createdAt: entry.createdAt,
      updatedAt: entry.archivedAt,
      settings: entry.settings,
      history: entry,
    });
  }
  if (currentBatch) {
    sources.set(currentBatch.id, {
      id: currentBatch.id,
      createdAt: currentBatch.createdAt,
      updatedAt: currentBatch.updatedAt,
      settings: currentBatch.settings,
      snapshot: currentBatch,
    });
  }
  return sources;
}

function sourceForPlan(
  legacyPlan: SitePlan,
  sources: Map<string, LegacyBatchSource>
): LegacyBatchSource | undefined {
  for (const chunk of legacyPlan.chunks) {
    if (!chunk.batchId) continue;
    const source = sources.get(chunk.batchId);
    if (source) return source;
  }
  return [...sources.values()].find(
    (source) => source.settings.siteId === legacyPlan.siteId
  );
}

function targetForSourceItem(
  items: LegacyItem[],
  url: string
): LegacyItem | undefined {
  const normalized = normalizedLegacyUrl(url);
  return items.find(
    (item) => item.url === url || normalizedLegacyUrl(item.url) === normalized
  );
}

function makeAttempt(
  run: Run,
  target: PlanTarget | undefined,
  item: LegacyItem,
  source: LegacyBatchSource,
  index: number
): Attempt {
  const status = mapBatchItemStatus(item.status);
  const updatedAt = itemUpdatedAt(item, source);
  const error = errorForLegacyItem(status, itemMessage(item), updatedAt);
  const id = target
    ? `${run.id}:${target.id}`
    : stableId('legacy-attempt', `${run.id}\u0000${index}\u0000${item.url}`);
  return {
    id,
    runId: run.id,
    ...(run.planId ? { planId: run.planId } : {}),
    ...(run.batchId ? { batchId: run.batchId } : {}),
    ...(target ? { targetId: target.id } : {}),
    url: normalizedLegacyUrl(item.url),
    attemptNumber: 1,
    status,
    timeline: attemptTimeline(item, source),
    ...(error ? { error } : {}),
    createdAt: itemCreatedAt(item, source),
    updatedAt,
    ...(isProcessedTargetStatus(status) ? { completedAt: updatedAt } : {}),
  };
}

function addStandaloneSource(
  bundle: LegacyImportBundle,
  source: LegacyBatchSource
): void {
  const items = sourceItems(source);
  const mappedStatuses = items.map((item) => mapBatchItemStatus(item.status));
  const status: DashboardRunStatus = source.snapshot
    ? source.snapshot.status === 'running'
      ? 'running'
      : source.snapshot.status === 'paused'
        ? 'blocked'
        : source.snapshot.status === 'stopped'
          ? 'interrupted'
          : mappedStatuses.some(
                (itemStatus) =>
                  isFailedTargetStatus(itemStatus) ||
                  itemStatus === 'unknown' ||
                  itemStatus === 'interrupted'
              )
            ? 'completed_with_errors'
            : 'completed'
    : mappedStatuses.some(
          (itemStatus) =>
            isFailedTargetStatus(itemStatus) ||
            itemStatus === 'unknown' ||
            itemStatus === 'interrupted' ||
            itemStatus === 'blocked' ||
            itemStatus === 'running' ||
            itemStatus === 'pending'
        )
      ? 'completed_with_errors'
      : 'completed';
  const run: Run = {
    id: stableId('legacy-run', `standalone\u0000${source.id}`),
    externalBatchId: source.id,
    kind: 'legacy',
    status,
    targetIds: [],
    createdAt: source.createdAt,
    startedAt: source.createdAt,
    updatedAt: source.updatedAt,
    ...(isTerminalRun(status) ? { completedAt: source.updatedAt } : {}),
  };
  bundle.runs.push(run);
  for (const [index, item] of items.entries()) {
    if (!shouldCreateAttempt(item)) continue;
    bundle.attempts.push(makeAttempt(run, undefined, item, source, index));
  }
}

export function buildLegacyMigrationBundle(
  plansMap: PlansMap,
  history: BatchHistoryEntry[],
  currentBatch: BatchSnapshot | null
): LegacyImportBundle {
  const bundle: LegacyImportBundle = {
    plans: [],
    batches: [],
    targets: [],
    runs: [],
    attempts: [],
  };
  const sources = sourceMap(history, currentBatch);
  const associatedSources = new Set<string>();

  for (const legacyPlan of Object.values(plansMap)) {
    const id = legacyPlanId(legacyPlan);
    const promotingSource = sourceForPlan(legacyPlan, sources);
    const promotingSiteLabel =
      promotingSource?.settings.siteLabel ?? legacyPlan.siteId;
    const promotingWebsiteUrl = promotingSource?.settings.websiteUrl ?? '';
    const planTargets: PlanTarget[] = [];
    const planBatches: PlanBatch[] = [];

    for (const [batchIndex, chunk] of legacyPlan.chunks.entries()) {
      const sequence = batchIndex + 1;
      const idForBatch = `${id}:batch:${sequence}`;
      const source = chunk.batchId ? sources.get(chunk.batchId) : undefined;
      if (source) associatedSources.add(source.id);
      const items = sourceItems(source);
      const batchTargets: PlanTarget[] = [];

      for (const [targetIndex, rawUrl] of chunk.urls.entries()) {
        const sequenceForTarget = planTargets.length + targetIndex + 1;
        const item = targetForSourceItem(items, rawUrl);
        const status = targetStatus(chunk.status, item);
        const updatedAt = item
          ? itemUpdatedAt(item, source!)
          : (chunk.completedAt ?? chunk.startedAt ?? legacyPlan.updatedAt);
        const error = item
          ? errorForLegacyItem(status, itemMessage(item), updatedAt)
          : undefined;
        const target: PlanTarget = {
          id: `${id}:target:${sequenceForTarget}`,
          planId: id,
          batchId: idForBatch,
          batchSequence: sequence,
          sequence: sequenceForTarget,
          url: normalizedLegacyUrl(rawUrl),
          host: legacyHost(rawUrl),
          status,
          attemptCount: item && shouldCreateAttempt(item) ? 1 : 0,
          latestMessage: item ? itemMessage(item) : '',
          ...(error ? { lastError: error } : {}),
          createdAt: legacyPlan.createdAt,
          updatedAt,
        };
        batchTargets.push(target);
      }
      planTargets.push(...batchTargets);
      const counts = countTargetStatuses(batchTargets);
      const status = sourceStatus(source, batchTargets, chunk.status);
      const batch: PlanBatch = {
        id: idForBatch,
        planId: id,
        sequence,
        status,
        targetCount: counts.total,
        processedCount: counts.processed,
        submittedCount: counts.submitted,
        failedCount: counts.failed,
        unknownCount: counts.unknown,
        ...(chunk.batchId ? { externalBatchId: chunk.batchId } : {}),
        ...(chunk.startedAt !== undefined
          ? { startedAt: chunk.startedAt }
          : source
            ? { startedAt: source.createdAt }
            : {}),
        ...(chunk.completedAt !== undefined
          ? { completedAt: chunk.completedAt }
          : status === 'completed' || status === 'completed_with_errors'
            ? { completedAt: source?.updatedAt ?? legacyPlan.updatedAt }
            : {}),
        createdAt: legacyPlan.createdAt,
        updatedAt: source?.updatedAt ?? legacyPlan.updatedAt,
      };

      if (source || chunk.status !== 'pending') {
        const externalId = chunk.batchId ?? chunk.id;
        const run: Run = {
          id: stableId(
            'legacy-run',
            `${id}\u0000${sequence}\u0000${externalId}`
          ),
          planId: id,
          batchId: idForBatch,
          ...(externalId ? { externalBatchId: externalId } : {}),
          kind: 'legacy',
          status: runStatus(status),
          targetIds: batchTargets.map((target) => target.id),
          createdAt:
            source?.createdAt ?? chunk.startedAt ?? legacyPlan.createdAt,
          startedAt:
            chunk.startedAt ?? source?.createdAt ?? legacyPlan.createdAt,
          updatedAt: source?.updatedAt ?? legacyPlan.updatedAt,
          ...(isTerminalRun(runStatus(status))
            ? {
                completedAt:
                  chunk.completedAt ??
                  source?.updatedAt ??
                  legacyPlan.updatedAt,
              }
            : {}),
        };
        bundle.runs.push(run);
        batch.currentRunId = run.id;
        if (source) {
          for (const [itemIndex, item] of items.entries()) {
            if (!shouldCreateAttempt(item)) continue;
            const matchedTarget = batchTargets.find(
              (candidate) => candidate.url === normalizedLegacyUrl(item.url)
            );
            bundle.attempts.push(
              makeAttempt(run, matchedTarget, item, source, itemIndex)
            );
          }
        }
      }
      planBatches.push(batch);
    }

    const counts = countTargetStatuses(planTargets);
    const completed = planBatches.every(
      (batch) =>
        batch.status === 'completed' || batch.status === 'completed_with_errors'
    );
    const plan: Plan = {
      id,
      name: `${promotingSiteLabel} 评论计划`,
      promotingSiteId: legacyPlan.siteId,
      promotingSiteLabel,
      promotingWebsiteUrl,
      status: completed ? 'completed' : 'active',
      chunkSize: legacyPlan.chunkSize,
      targetCount: counts.total,
      processedCount: counts.processed,
      submittedCount: counts.submitted,
      failedCount: counts.failed,
      unknownCount: counts.unknown,
      createdAt: legacyPlan.createdAt,
      updatedAt: legacyPlan.updatedAt,
    };
    bundle.plans.push(plan);
    bundle.batches.push(...planBatches);
    bundle.targets.push(...planTargets);
  }

  for (const source of sources.values()) {
    if (!associatedSources.has(source.id)) {
      addStandaloneSource(bundle, source);
    }
  }
  return bundle;
}

function activeRunReferenceForMigration(
  bundle: LegacyImportBundle,
  currentBatch: BatchSnapshot | null
): LegacyDashboardActiveRunReference | null {
  if (
    !currentBatch ||
    (currentBatch.status !== 'running' &&
      currentBatch.status !== 'paused' &&
      currentBatch.status !== 'stopped')
  ) {
    return null;
  }
  const batch = bundle.batches.find(
    (candidate) =>
      candidate.externalBatchId === currentBatch.id &&
      (candidate.status === 'running' ||
        candidate.status === 'blocked' ||
        candidate.status === 'interrupted')
  );
  if (batch?.currentRunId) {
    const run = bundle.runs.find(
      (candidate) =>
        candidate.id === batch.currentRunId &&
        candidate.planId === batch.planId &&
        candidate.batchId === batch.id &&
        candidate.externalBatchId === currentBatch.id &&
        (candidate.status === 'running' ||
          candidate.status === 'blocked' ||
          candidate.status === 'interrupted')
    );
    if (run) {
      return {
        kind: 'plan',
        planId: batch.planId,
        batchId: batch.id,
        runId: run.id,
        externalBatchId: currentBatch.id,
      };
    }
  }
  const standalone = bundle.runs.find(
    (candidate) =>
      candidate.externalBatchId === currentBatch.id &&
      candidate.planId === undefined &&
      candidate.batchId === undefined &&
      (candidate.status === 'running' ||
        candidate.status === 'blocked' ||
        candidate.status === 'interrupted')
  );
  if (!standalone) return null;
  return {
    kind: 'standalone',
    runId: standalone.id,
    externalBatchId: currentBatch.id,
  };
}

export async function migrateLegacyDashboardData(
  repository: DashboardRepository,
  plansMap: PlansMap,
  history: BatchHistoryEntry[],
  currentBatch: BatchSnapshot | null,
  at: number = Date.now()
): Promise<LegacyDashboardMigrationResult> {
  const bundle = buildLegacyMigrationBundle(plansMap, history, currentBatch);
  const result = await repository.importLegacyRecords(
    LEGACY_DASHBOARD_MIGRATION_MARKER,
    bundle,
    at
  );
  const expected = {
    plans: bundle.plans.length,
    batches: bundle.batches.length,
    targets: bundle.targets.length,
    runs: bundle.runs.length,
    attempts: bundle.attempts.length,
  };
  const verified =
    result.counts.plans === expected.plans &&
    result.counts.batches === expected.batches &&
    result.counts.targets === expected.targets &&
    result.counts.runs === expected.runs &&
    result.counts.attempts === expected.attempts;
  return {
    ...result,
    markerKey: LEGACY_DASHBOARD_MIGRATION_MARKER,
    verified,
    // A completed migration must not manufacture deterministic legacy run IDs
    // for a newer active batch. The background restores a matching persisted
    // run or registers that batch as a standalone run instead.
    activeRunReference: result.imported
      ? activeRunReferenceForMigration(bundle, currentBatch)
      : null,
  };
}
