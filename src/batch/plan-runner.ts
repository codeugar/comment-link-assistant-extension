import type { PlansMap, SitePlan } from '@/storage/plans';
import type { CommentProvider, ExtensionSettings, SiteProfile } from '@/types';
import {
  type IdleArchiveDependencies,
  ensureIdleAndArchive,
} from './batch-lifecycle';
import { markChunkStarted, nextPendingChunk } from './plan';
import type { BatchSettingsSnapshot, BatchSnapshot } from './types';

export interface PlanRunDependencies extends IdleArchiveDependencies {
  getPlans(): Promise<PlansMap>;
  getSettings(): Promise<ExtensionSettings>;
  startBatch(
    targetText: string,
    settings: BatchSettingsSnapshot
  ): Promise<BatchSnapshot>;
  savePlan(plan: SitePlan): Promise<void>;
  buildSnapshot(
    provider: CommentProvider,
    site: SiteProfile
  ): BatchSettingsSnapshot;
  now(): number;
}

export async function runPlanNext(
  deps: PlanRunDependencies,
  siteId: string
): Promise<BatchSnapshot> {
  const plans = await deps.getPlans();
  const plan = plans[siteId];
  if (!plan) throw new Error('PLAN_NOT_FOUND');
  const chunk = nextPendingChunk(plan);
  if (!chunk) throw new Error('PLAN_NO_PENDING_CHUNK');

  const settings = await deps.getSettings();
  const site = settings.sites.find((candidate) => candidate.id === siteId);
  if (!site) throw new Error('PLAN_SITE_MISSING');

  await ensureIdleAndArchive(deps);

  const snapshot = deps.buildSnapshot(settings.provider, site);
  const batch = await deps.startBatch(chunk.urls.join('\n'), snapshot);
  await deps.savePlan(markChunkStarted(plan, chunk.id, batch.id, deps.now()));
  return batch;
}
