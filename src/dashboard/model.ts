export const DASHBOARD_PLAN_STATUSES = [
  'active',
  'completed',
  'archived',
] as const;

export type DashboardPlanStatus = (typeof DASHBOARD_PLAN_STATUSES)[number];

export const DASHBOARD_BATCH_STATUSES = [
  'pending',
  'running',
  'blocked',
  'interrupted',
  'completed',
  'completed_with_errors',
] as const;

export type DashboardBatchStatus = (typeof DASHBOARD_BATCH_STATUSES)[number];

export const PLAN_TARGET_STATUSES = [
  'pending',
  'running',
  'blocked',
  'interrupted',
  'filtered',
  'published',
  'pending_moderation',
  // Public, with the promoted link removed by the site. Terminal: no amount of
  // re-checking brings a stripped link back.
  'link_stripped',
  'unconfirmed',
  // Legacy rows that collapsed every click result into a generic success.
  'submitted',
  'no_form',
  'validation_error',
  'failed',
  'unknown',
] as const;

export type PlanTargetStatus = (typeof PLAN_TARGET_STATUSES)[number];

export const DASHBOARD_RUN_KINDS = [
  'batch',
  'resume',
  'retry',
  'legacy',
] as const;

export type DashboardRunKind = (typeof DASHBOARD_RUN_KINDS)[number];

export const DASHBOARD_RUN_STATUSES = [
  'running',
  'blocked',
  'interrupted',
  'completed',
  'completed_with_errors',
] as const;

export type DashboardRunStatus = (typeof DASHBOARD_RUN_STATUSES)[number];

export interface Plan {
  id: string;
  name: string;
  promotingSiteId: string;
  promotingSiteLabel: string;
  promotingWebsiteUrl: string;
  status: DashboardPlanStatus;
  chunkSize: number;
  targetCount: number;
  processedCount: number;
  submittedCount: number;
  failedCount: number;
  unknownCount: number;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export type PlanSummary = Plan;
export interface PlanBatch {
  id: string;
  planId: string;
  sequence: number;
  status: DashboardBatchStatus;
  targetCount: number;
  processedCount: number;
  submittedCount: number;
  failedCount: number;
  unknownCount: number;
  externalBatchId?: string;
  currentRunId?: string;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AttemptError {
  code: string;
  message: string;
  friendlyMessage: string;
  at: number;
}

export interface PlanTarget {
  id: string;
  planId: string;
  batchId: string;
  batchSequence: number;
  sequence: number;
  url: string;
  host: string;
  status: PlanTargetStatus;
  attemptCount: number;
  latestMessage: string;
  /** Most recent read-only check while a submitted comment awaits moderation. */
  lastModerationCheckAt?: number;
  lastModerationCheckMessage?: string;
  lastError?: AttemptError;
  createdAt: number;
  updatedAt: number;
}

export interface Run {
  id: string;
  planId?: string;
  batchId?: string;
  externalBatchId?: string;
  kind: DashboardRunKind;
  status: DashboardRunStatus;
  targetIds: string[];
  createdAt: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface AttemptEvent {
  stage: string;
  status: PlanTargetStatus;
  message: string;
  at: number;
}

export interface Attempt {
  id: string;
  runId: string;
  planId?: string;
  batchId?: string;
  targetId?: string;
  url: string;
  attemptNumber: number;
  status: PlanTargetStatus;
  timeline: AttemptEvent[];
  /**
   * Generated comment content retained from the worker snapshot. Keeping it
   * with the attempt lets plan history mirror the side panel after a run ends.
   */
  comment?: string;
  /** Normalized comment prefix used for read-only public-render checks. */
  commentFingerprint?: string;
  /** Submit receipt: the page the comment landed on and the id the server gave
   *  it. Carried so an anonymous re-check can address this exact comment. */
  receipt?: { url: string; commentId?: string };
  error?: AttemptError;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface DashboardMeta {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface CreatePlanInput {
  id?: string;
  name: string;
  promotingSiteId: string;
  promotingSiteLabel: string;
  promotingWebsiteUrl: string;
  urls: string[];
  chunkSize?: number;
  now?: number;
}

export interface PlanDetail {
  plan: Plan;
  batches: PlanBatch[];
}

export interface PlanTargetPage {
  items: PlanTarget[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PlanTargetQuery {
  batchId?: string;
  page?: number;
  pageSize?: number;
}

export interface TargetStatusCounts {
  total: number;
  processed: number;
  submitted: number;
  failed: number;
  pending: number;
  running: number;
  blocked: number;
  interrupted: number;
  filtered: number;
  unknown: number;
}

export interface PromotingSiteSummary extends TargetStatusCounts {
  siteId: string;
  siteLabel: string;
  websiteUrl: string;
  planCount: number;
}

export interface TargetHostSummary extends TargetStatusCounts {
  host: string;
}

export interface ScheduledBatchSummary {
  planId: string;
  planName: string;
  promotingSiteLabel: string;
  batchId: string;
  batchSequence: number;
  batchStatus: DashboardBatchStatus;
  targetCount: number;
  processedCount: number;
}

export interface RecentFailureSummary {
  planId: string;
  planName: string;
  batchId: string;
  targetId: string;
  url: string;
  host: string;
  status: 'no_form' | 'validation_error' | 'failed';
  error?: AttemptError;
  updatedAt: number;
}

export interface DashboardSummary {
  activePlanCount: number;
  counts: TargetStatusCounts;
  todaySchedule: ScheduledBatchSummary[];
  nextSchedule: ScheduledBatchSummary[];
  promotingSites: PromotingSiteSummary[];
  targetHosts: TargetHostSummary[];
  recentFailures: RecentFailureSummary[];
}

export interface StartBatchRunInput {
  runId?: string;
  externalBatchId?: string;
  kind?: Exclude<DashboardRunKind, 'legacy'>;
  targetIds?: string[];
  at?: number;
}

export interface BatchRunStart {
  plan: Plan;
  batch: PlanBatch;
  run: Run;
  targets: PlanTarget[];
}

export interface LegacyImportBundle {
  plans: Plan[];
  batches: PlanBatch[];
  targets: PlanTarget[];
  runs: Run[];
  attempts: Attempt[];
}

export interface LegacyImportResult {
  imported: boolean;
  counts: {
    plans: number;
    batches: number;
    targets: number;
    runs: number;
    attempts: number;
  };
}

/** A full snapshot of every IndexedDB object store, used by the data-backup
 * export/import feature to migrate a dashboard's entire history. */
export interface DashboardBackupData {
  plans: Plan[];
  batches: PlanBatch[];
  targets: PlanTarget[];
  runs: Run[];
  attempts: Attempt[];
  meta: DashboardMeta[];
}

export type FailedPlanTargetStatus =
  | 'no_form'
  | 'validation_error'
  | 'failed'
  // The comment landed and its link did not, so the run produced nothing here.
  | 'link_stripped';

const failedStatuses = new Set<PlanTargetStatus>([
  'no_form',
  'validation_error',
  'failed',
  'link_stripped',
]);

export function isFailedTargetStatus(
  status: PlanTargetStatus
): status is FailedPlanTargetStatus {
  return failedStatuses.has(status);
}

export function isProcessedTargetStatus(status: PlanTargetStatus): boolean {
  return (
    status === 'blocked' ||
    status === 'published' ||
    status === 'pending_moderation' ||
    status === 'unconfirmed' ||
    status === 'submitted' ||
    status === 'filtered' ||
    isFailedTargetStatus(status)
  );
}

export function countTargetStatuses(
  targets: Iterable<Pick<PlanTarget, 'status'>>
): TargetStatusCounts {
  const counts: TargetStatusCounts = {
    total: 0,
    processed: 0,
    submitted: 0,
    failed: 0,
    pending: 0,
    running: 0,
    blocked: 0,
    interrupted: 0,
    filtered: 0,
    unknown: 0,
  };

  for (const target of targets) {
    counts.total += 1;
    if (isProcessedTargetStatus(target.status)) counts.processed += 1;
    if (
      target.status === 'published' ||
      target.status === 'pending_moderation'
    ) {
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

  return counts;
}
