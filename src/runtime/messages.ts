import type { BatchSnapshot } from '@/batch/types';
import type {
  Attempt,
  DashboardSummary,
  Plan,
  PlanDetail,
  PlanTarget,
  PlanTargetPage,
} from '@/dashboard/model';
import type {
  ModerationRecheckDashboardData,
  ModerationRecheckLastRun,
  ModerationRecheckSettings,
} from '@/dashboard/moderation-recheck';
import type {
  ModerationCheckResult,
  PageAnalysis,
  PageSubmissionResult,
  PageSubmissionTarget,
} from '@/page/types';
import type { DataBackupFile } from '@/storage/data-backup';
import type { FilterEntryKind, FilterListEntry } from '@/storage/filter-list';
import type {
  OutboundLinkFollowStatus,
  OutboundLinkLibraryEntry,
  OutboundLinkTag,
} from '@/storage/outbound-link-library';
import type { SitePlan } from '@/storage/plans';
import type { WebsiteProfile } from '@/website/profile';

export interface DashboardActiveRun {
  planId: string;
  planName: string;
  batchId: string;
  batchSequence: number;
  status: BatchSnapshot['status'];
  currentTarget: (PlanTarget & { attempts: Attempt[] }) | null;
  counts: {
    total: number;
    processed: number;
    submitted: number;
    failed: number;
    remaining: number;
  };
}

export interface DashboardSummaryView extends DashboardSummary {
  activeRun: DashboardActiveRun | null;
}

export interface DashboardPlanTarget extends PlanTarget {
  attempts: Attempt[];
}

export interface DashboardPlanTargetPage extends Omit<PlanTargetPage, 'items'> {
  items: DashboardPlanTarget[];
}

export interface LegacyPlanCreateMessage {
  type: 'plan.create';
  siteId: string;
  targetText: string;
  chunkSize: number;
}

export interface DashboardPlanCreateMessage extends LegacyPlanCreateMessage {
  name: string;
}

export type PopupMessage =
  | { type: 'page.analyze' }
  | { type: 'comment.prepare' }
  | { type: 'batch.preview'; websiteUrl: string; refresh?: boolean }
  | {
      type: 'batch.start';
      targetText: string;
      websiteProfile?: WebsiteProfile;
      siteId?: string;
    }
  | { type: 'batch.continue' }
  | { type: 'batch.skip-current' }
  | { type: 'batch.stop' }
  | { type: 'batch.reset' }
  | { type: 'batch.retry-items'; itemIds: string[] }
  | { type: 'batch.retry-from-history'; historyId: string; urls?: string[] }
  | { type: 'batch.open-current' }
  | LegacyPlanCreateMessage
  | DashboardPlanCreateMessage
  | { type: 'plan.delete'; siteId: string }
  | { type: 'plan.run-next'; siteId: string }
  | { type: 'filter.list' }
  | { type: 'filter.add'; value: string; kind?: FilterEntryKind }
  | { type: 'filter.remove'; id: string }
  | { type: 'link-library.list' }
  | {
      type: 'link-library.add';
      url: string;
      domain?: string;
      tags?: OutboundLinkTag[];
      followStatus?: OutboundLinkFollowStatus;
      loginRequired?: boolean | null;
      captchaRequired?: boolean | null;
    }
  | {
      type: 'link-library.update';
      id: string;
      url?: string;
      domain?: string;
      tags?: OutboundLinkTag[];
      followStatus?: OutboundLinkFollowStatus;
      loginRequired?: boolean | null;
      captchaRequired?: boolean | null;
    }
  | { type: 'link-library.remove'; id: string }
  | { type: 'dashboard.getSummary' }
  | { type: 'moderation.getDashboard' }
  | { type: 'moderation.runNow' }
  | {
      type: 'moderation.addManual';
      pageUrl: string;
      targetWebsiteUrl: string;
    }
  | { type: 'moderation.recheckManual'; entryId: string }
  | {
      type: 'moderation.recheckTarget';
      planId: string;
      targetId: string;
    }
  | {
      type: 'moderation.updateSettings';
      settings: ModerationRecheckSettings;
    }
  | { type: 'plans.list'; includeArchived?: boolean }
  | { type: 'plan.getDetail'; planId: string }
  | {
      type: 'plan.getTargets';
      planId: string;
      batchId?: string;
      page?: number;
      pageSize?: number;
    }
  | { type: 'plan.rename'; planId: string; name: string }
  | { type: 'plan.archive'; planId: string }
  | { type: 'plan.deletePermanently'; planId: string }
  | {
      type: 'plan.deleteTarget';
      planId: string;
      targetId: string;
      addToFilter?: boolean;
    }
  | { type: 'plan.runNext'; planId: string }
  | { type: 'plan.resume'; planId: string }
  | { type: 'plan.retryTargets'; planId: string; targetIds: string[] }
  | {
      type: 'comment.submit';
      comment: string;
      target: PageSubmissionTarget;
    }
  | { type: 'anchor.generateNaturalTexts'; siteId: string; count: number }
  | { type: 'data-backup.export' }
  | { type: 'data-backup.import'; backup: unknown };

export interface PreparedComment {
  analysis: PageAnalysis;
  websiteProfile: WebsiteProfile;
  comment: string;
  target: PageSubmissionTarget;
}

export type PopupMessageResult =
  | { type: 'page.analyze'; data: PageAnalysis }
  | { type: 'comment.prepare'; data: PreparedComment }
  | { type: 'comment.submit'; data: PageSubmissionResult }
  | { type: 'batch.preview'; data: WebsiteProfile }
  | {
      type:
        | 'batch.start'
        | 'batch.continue'
        | 'batch.skip-current'
        | 'batch.stop'
        | 'batch.reset'
        | 'batch.retry-items'
        | 'batch.retry-from-history'
        | 'batch.open-current'
        | 'plan.run-next';
      data: BatchSnapshot | null;
    }
  | { type: 'plan.create'; data: SitePlan }
  | { type: 'plan.create'; data: Plan }
  | { type: 'plan.delete'; data: null }
  | { type: 'filter.list'; data: FilterListEntry[] }
  | { type: 'filter.add'; data: FilterListEntry }
  | { type: 'filter.remove'; data: boolean }
  | { type: 'link-library.list'; data: OutboundLinkLibraryEntry[] }
  | { type: 'link-library.add'; data: OutboundLinkLibraryEntry }
  | { type: 'link-library.update'; data: OutboundLinkLibraryEntry | null }
  | { type: 'link-library.remove'; data: boolean }
  | { type: 'anchor.generateNaturalTexts'; data: string[] }
  | { type: 'dashboard.getSummary'; data: DashboardSummaryView }
  | { type: 'moderation.getDashboard'; data: ModerationRecheckDashboardData }
  | { type: 'moderation.runNow'; data: ModerationRecheckLastRun }
  | { type: 'moderation.addManual'; data: ModerationRecheckDashboardData }
  | { type: 'moderation.recheckManual'; data: ModerationRecheckDashboardData }
  | { type: 'moderation.recheckTarget'; data: ModerationCheckResult }
  | {
      type: 'moderation.updateSettings';
      data: ModerationRecheckDashboardData;
    }
  | { type: 'plans.list'; data: { plans: Plan[] } }
  | { type: 'plan.getDetail'; data: PlanDetail }
  | { type: 'plan.getTargets'; data: DashboardPlanTargetPage }
  | { type: 'plan.rename'; data: Plan }
  | { type: 'plan.archive'; data: Plan }
  | { type: 'plan.deletePermanently'; data: null }
  | { type: 'plan.deleteTarget'; data: PlanTarget }
  | {
      type: 'plan.runNext' | 'plan.resume' | 'plan.retryTargets';
      data: BatchSnapshot;
    }
  | { type: 'data-backup.export'; data: DataBackupFile }
  | { type: 'data-backup.import'; data: { imported: true } };

export type BackgroundResponse =
  | { ok: true; data: PopupMessageResult }
  | { ok: false; error: { code: string; message: string } };

function isBackgroundResponse(value: unknown): value is BackgroundResponse {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'ok' in value &&
      typeof (value as { ok: unknown }).ok === 'boolean'
  );
}

type PopupMessageResultForType<T extends PopupMessage['type']> =
  PopupMessageResult extends infer Result
    ? Result extends { type: infer ResultType }
      ? T extends ResultType
        ? Result
        : never
      : never
    : never;

export type PopupMessageResultFor<M extends PopupMessage> =
  M extends DashboardPlanCreateMessage
    ? Extract<PopupMessageResult, { type: 'plan.create'; data: Plan }>
    : M extends LegacyPlanCreateMessage
      ? Extract<PopupMessageResult, { type: 'plan.create'; data: SitePlan }>
      : PopupMessageResultForType<M['type']>;

export async function sendToBackground<M extends PopupMessage>(
  message: M
): Promise<PopupMessageResultFor<M>> {
  const response = (await chrome.runtime.sendMessage(message)) as unknown;
  if (!isBackgroundResponse(response))
    throw new Error('BACKGROUND_RESPONSE_INVALID');
  if (!response.ok)
    throw new Error(`${response.error.code}:${response.error.message}`);
  return response.data as PopupMessageResultFor<M>;
}
