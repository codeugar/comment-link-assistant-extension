import type { BatchSnapshot } from '@/batch/types';
import type {
  Attempt,
  Plan,
  PlanBatch,
  PlanDetail,
  PlanTarget,
  PlanTargetPage,
} from '@/dashboard/model';
import type { DashboardSummaryView } from '@/runtime/messages';
import type { ExtensionSettings } from '@/types';

export type { Attempt, Plan, PlanBatch, PlanDetail, PlanTarget };

export type PlanTargetWithAttempts = PlanTarget & {
  attempts?: Attempt[];
};

export type PlanTargetsPage = Omit<PlanTargetPage, 'items'> & {
  items: PlanTargetWithAttempts[];
};

export interface PlansListResult {
  plans: Plan[];
}

export type DashboardMessage =
  | { type: 'dashboard.getSummary' }
  | { type: 'plans.list'; includeArchived?: boolean }
  | { type: 'plan.getDetail'; planId: string }
  | {
      type: 'plan.getTargets';
      planId: string;
      batchId?: string;
      page: number;
      pageSize: number;
    }
  | {
      type: 'plan.create';
      name: string;
      siteId: string;
      targetText: string;
      chunkSize: number;
    }
  | { type: 'plan.rename'; planId: string; name: string }
  | { type: 'plan.setChunkSize'; planId: string; chunkSize: number }
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
  | { type: 'batch.open-current' }
  | { type: 'batch.stop' };

export type DashboardRequestResult =
  | DashboardSummaryView
  | PlansListResult
  | PlanDetail
  | PlanTargetsPage
  | Plan
  | PlanTarget
  | BatchSnapshot
  | null;

export interface DashboardDataState {
  summary: DashboardSummaryView;
  plans: Plan[];
  settings: ExtensionSettings;
  batch: BatchSnapshot | null;
}
