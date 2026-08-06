import { type AnchorPlan, createDefaultAnchorPlan } from '@/anchor/types';
import type { BatchItem, BatchSnapshot } from '@/batch/types';
import type {
  Attempt,
  Plan,
  PlanBatch,
  PlanDetail,
  PlanTarget,
} from '@/dashboard/model';
import type { DashboardSummaryView } from '@/runtime/messages';
import { sendToBackground } from '@/runtime/messages';
import {
  type AnchorLedger,
  emptyAnchorLedger,
  getAnchorLedger,
} from '@/storage/anchor-ledger';
import { getAnchorPlan, saveAnchorPlan } from '@/storage/anchor-plan';
import { getBatch } from '@/storage/batch';
import type { DataBackupFile } from '@/storage/data-backup';
import {
  createDefaultSettings,
  getProviderApiKeys,
  getSettings,
} from '@/storage/settings';
import type { ExtensionSettings, ProviderApiKeys } from '@/types';
import type {
  DashboardMessage,
  DashboardRequestResult,
  PlanTargetWithAttempts,
  PlanTargetsPage,
  PlansListResult,
} from './native-types';

export const DASHBOARD_REVISION_KEY =
  'comment-link-assistant.dashboard-revision';

const now = Date.now();
const minute = 60_000;

function makePlan(
  id: string,
  name: string,
  siteLabel: string,
  websiteUrl: string,
  targetCount: number,
  processedCount: number,
  batchCount: number,
  status: Plan['status'] = 'active'
): Plan {
  return {
    id,
    name,
    promotingSiteId: `site-${id}`,
    promotingSiteLabel: siteLabel,
    promotingWebsiteUrl: websiteUrl,
    status,
    chunkSize: 30,
    targetCount,
    processedCount,
    submittedCount: Math.max(0, processedCount - (id === 'seed-audio' ? 2 : 0)),
    failedCount: id === 'seed-audio' ? 2 : 0,
    unknownCount: 0,
    createdAt: now - batchCount * 86_400_000,
    updatedAt: now - 3 * minute,
  };
}

let demoPlans: Plan[] = [
  makePlan(
    'techradar',
    'TechRadar 外链计划',
    'TechRadar',
    'https://techradar.com',
    180,
    180,
    6,
    'completed'
  ),
  makePlan(
    'guitar-world',
    'Guitar World 外链计划',
    'Guitar World',
    'https://guitarworld.com',
    150,
    150,
    5,
    'completed'
  ),
  makePlan(
    'seed-audio',
    'Seed Audio 外链计划',
    'Seed Audio',
    'https://seed-audio.com',
    240,
    60,
    8
  ),
  makePlan(
    'audio-technology',
    'Audio Technology 外链计划',
    'Audio Technology',
    'https://audiotechnology.com',
    120,
    0,
    4
  ),
  makePlan(
    'musicradar',
    'MusicRadar 外链计划',
    'MusicRadar',
    'https://musicradar.com',
    90,
    0,
    3
  ),
];

const demoDeletedTargets = new Set<string>();

function makeBatch(
  plan: Plan,
  sequence: number,
  status: PlanBatch['status'],
  processedCount = 0,
  failedCount = 0
): PlanBatch {
  const targetCount = Math.min(
    plan.chunkSize,
    Math.max(0, plan.targetCount - (sequence - 1) * plan.chunkSize)
  );
  return {
    id: `${plan.id}-batch-${sequence}`,
    planId: plan.id,
    sequence,
    status,
    targetCount,
    processedCount,
    submittedCount: Math.max(0, processedCount - failedCount),
    failedCount,
    unknownCount: 0,
    externalBatchId:
      status === 'running' ? 'demo-external-seed-audio-3' : undefined,
    currentRunId: status === 'running' ? 'demo-run-seed-audio-3' : undefined,
    startedAt:
      status === 'pending' ? undefined : now - Math.max(1, sequence) * minute,
    completedAt:
      status === 'completed' || status === 'completed_with_errors'
        ? now - minute
        : undefined,
    createdAt: plan.createdAt,
    updatedAt: now - minute,
  };
}

function batchesForPlan(plan: Plan): PlanBatch[] {
  const count = Math.max(1, Math.ceil(plan.targetCount / plan.chunkSize));
  return Array.from({ length: count }, (_, index) => {
    const sequence = index + 1;
    if (plan.id === 'seed-audio') {
      if (sequence <= 2) return makeBatch(plan, sequence, 'completed', 30);
      if (sequence === 3) return makeBatch(plan, sequence, 'running', 18, 2);
      return makeBatch(plan, sequence, 'pending');
    }
    const batchEnd = sequence * plan.chunkSize;
    if (batchEnd <= plan.processedCount) {
      return makeBatch(plan, sequence, 'completed', plan.chunkSize);
    }
    return makeBatch(plan, sequence, 'pending');
  });
}

function demoUrl(position: number): string {
  const slugs = [
    'best-vst-plugins-2026',
    'mixing-tips-for-beginners',
    'free-vst-plugins',
    'mastering-basics',
    'compression-guide',
    'reverb-tips',
    'delay-vs-reverb',
    'eq-cheat-sheet',
    'italian-greetings',
    'home-studio-acoustics',
  ];
  return `https://www.seed-audio.com/blog/${slugs[position % slugs.length]}`;
}

function failureError(code: string, friendlyMessage: string, at: number) {
  return {
    code,
    message:
      code === 'NO_COMMENT_FORM'
        ? 'Comment form not found in the inspected document'
        : 'Target form rejected the generated payload',
    friendlyMessage,
    at,
  };
}

function targetFor(
  planId: string,
  batchId: string,
  batchSequence: number,
  position: number
): PlanTargetWithAttempts {
  const batchOffset = (batchSequence - 1) * 30;
  const absolute = batchOffset + position;
  let status: PlanTarget['status'] = 'pending';
  if (batchSequence < 3) status = 'published';
  if (batchSequence === 3 && position <= 18) status = 'published';
  if (batchSequence === 3 && position === 19) status = 'running';
  if (batchSequence === 3 && (position === 20 || position === 21)) {
    status = 'failed';
  }
  const updatedAt = now - Math.max(0, 22 - position) * 27_000;
  const lastError =
    status === 'failed'
      ? failureError(
          position === 20 ? 'NO_COMMENT_FORM' : 'VALIDATION_ERROR',
          position === 20 ? '没有找到可用的评论表单' : '评论表单校验未通过',
          updatedAt
        )
      : undefined;
  const timeline = [
    {
      stage: 'opening',
      status: 'running' as const,
      message: 'Opened target page',
      at: updatedAt - 35_000,
    },
    {
      stage: 'analyzing',
      status: 'running' as const,
      message: 'Analyzed page and comment form',
      at: updatedAt - 21_000,
    },
    {
      stage: 'generating',
      status: 'running' as const,
      message: 'Generated comment content',
      at: updatedAt - 14_000,
    },
    {
      stage: 'prepared',
      status: 'running' as const,
      message: 'Prepared the target comment form',
      at: updatedAt - 9_000,
    },
    {
      stage: 'click_dispatched',
      status: 'running' as const,
      message: 'Submitted the prepared form',
      at: updatedAt - 5_000,
    },
    {
      stage: 'verifying',
      status: 'running' as const,
      message: 'Verified the submission result',
      at: updatedAt - 2_000,
    },
    {
      stage: status === 'failed' ? 'failed' : 'published',
      status,
      message: lastError?.message ?? 'Submission confirmed',
      at: updatedAt,
    },
  ];
  const attempt: Attempt = {
    id: `attempt-${absolute}`,
    runId: 'demo-run-seed-audio-3',
    planId,
    batchId,
    targetId: `target-${absolute}`,
    url: demoUrl(absolute),
    attemptNumber: 1,
    status,
    timeline,
    ...(status === 'published' || status === 'running'
      ? {
          comment:
            'Really enjoyed this perspective. The practical examples make the topic much easier to apply.',
        }
      : {}),
    error: lastError,
    createdAt: updatedAt - 40_000,
    updatedAt,
    completedAt: status === 'running' ? undefined : updatedAt,
  };
  return {
    id: `target-${absolute}`,
    planId,
    batchId,
    batchSequence,
    sequence: absolute,
    url: demoUrl(absolute),
    host: 'seed-audio.com',
    status,
    attemptCount: 1,
    latestMessage:
      lastError?.message ??
      (status === 'running' ? 'Generating comment' : 'Submission confirmed'),
    lastError,
    createdAt: now - 2 * 86_400_000,
    updatedAt,
    attempts: [attempt],
  };
}

function targetPage(
  planId: string,
  batchId: string | undefined,
  page: number,
  pageSize: number
): PlanTargetsPage {
  const plan = demoPlans.find((item) => item.id === planId) ?? demoPlans[0]!;
  const batches = batchesForPlan(plan);
  const selectedBatch =
    batches.find((item) => item.id === batchId) ??
    batches.find((item) => item.status === 'running') ??
    batches[0]!;
  const all = Array.from({ length: selectedBatch.targetCount }, (_, index) =>
    targetFor(plan.id, selectedBatch.id, selectedBatch.sequence, index + 1)
  ).filter((target) => !demoDeletedTargets.has(`${plan.id}:${target.id}`));
  const start = (page - 1) * pageSize;
  return {
    items: all.slice(start, start + pageSize),
    page,
    pageSize,
    total: all.length,
    totalPages: Math.max(1, Math.ceil(all.length / pageSize)),
  };
}

function statusCounts() {
  return {
    total: demoPlans.reduce((sum, plan) => sum + plan.targetCount, 0),
    processed: 186,
    submitted: 163,
    failed: 9,
    pending: 500,
    running: 1,
    blocked: 0,
    interrupted: 0,
    filtered: 0,
    unknown: 13,
  };
}

function buildDemoSummary(): DashboardSummaryView {
  const seed = demoPlans.find((plan) => plan.id === 'seed-audio')!;
  const musicradar = demoPlans.find((plan) => plan.id === 'musicradar')!;
  const seedBatches = batchesForPlan(seed);
  const musicBatches = batchesForPlan(musicradar);
  const schedule = [seedBatches[2]!, musicBatches[0]!].map((batch) => {
    const plan = demoPlans.find((item) => item.id === batch.planId)!;
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
  });
  const nextSchedule = [seedBatches[3]!, musicBatches[1]!].map((batch) => {
    const plan = demoPlans.find((item) => item.id === batch.planId)!;
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
  });
  const recentFailures = [20, 21, 16, 12, 8].map((position, index) => {
    const target = targetFor(seed.id, seedBatches[2]!.id, 3, position);
    const error =
      target.lastError ??
      failureError(
        'NO_COMMENT_FORM',
        '没有找到可用的评论表单',
        now - index * minute
      );
    return {
      planId: seed.id,
      planName: seed.name,
      batchId: seedBatches[2]!.id,
      targetId: target.id,
      url: target.url,
      host: target.host,
      status:
        error.code === 'VALIDATION_ERROR'
          ? ('validation_error' as const)
          : ('no_form' as const),
      error,
      updatedAt: now - index * 7 * minute,
    };
  });
  return {
    activePlanCount: demoPlans.filter((plan) => plan.status === 'active')
      .length,
    counts: statusCounts(),
    todaySchedule: schedule,
    nextSchedule,
    promotingSites: demoPlans.slice(0, 5).map((plan) => ({
      siteId: plan.promotingSiteId,
      siteLabel: plan.promotingSiteLabel,
      websiteUrl: plan.promotingWebsiteUrl,
      planCount: 1,
      total: plan.targetCount,
      processed: plan.processedCount,
      submitted: plan.submittedCount,
      failed: plan.failedCount,
      pending: Math.max(0, plan.targetCount - plan.processedCount),
      running: plan.id === 'seed-audio' ? 1 : 0,
      blocked: 0,
      interrupted: 0,
      filtered: 0,
      unknown: plan.unknownCount,
    })),
    targetHosts: [
      ['seed-audio.com', 68, 56, 51, 5],
      ['musicradar.com', 42, 39, 37, 2],
      ['techradar.com', 36, 31, 30, 1],
      ['guitarworld.com', 28, 25, 24, 1],
      ['audiotechnology.com', 24, 18, 18, 0],
    ].map(([host, total, processed, submitted, failed]) => ({
      host: String(host),
      total: Number(total),
      processed: Number(processed),
      submitted: Number(submitted),
      failed: Number(failed),
      pending: Number(total) - Number(processed),
      running: 0,
      blocked: 0,
      interrupted: 0,
      filtered: 0,
      unknown: 0,
    })),
    recentFailures,
    activeRun: {
      planId: seed.id,
      planName: seed.name,
      batchId: seedBatches[2]!.id,
      batchSequence: 3,
      status: 'running',
      currentTarget: {
        ...targetFor(seed.id, seedBatches[2]!.id, 3, 19),
        attempts: [
          {
            id: 'demo-current-attempt',
            runId: 'demo-run-seed-audio-3',
            planId: seed.id,
            batchId: seedBatches[2]!.id,
            targetId: 'seed-audio-batch-3-target-19',
            url: demoUrl(79),
            attemptNumber: 1,
            status: 'running',
            timeline: [],
            createdAt: now - minute,
            updatedAt: now,
          },
        ],
      },
      counts: {
        total: 30,
        processed: 20,
        submitted: 18,
        failed: 2,
        remaining: 10,
      },
    },
  };
}

function makeDemoBatchItem(index: number): BatchItem {
  const target = targetFor('seed-audio', 'seed-audio-batch-3', 3, index + 1);
  const status =
    index < 18
      ? 'published'
      : index === 18
        ? 'generating'
        : index === 19 || index === 20
          ? 'failed'
          : 'queued';
  return {
    id: target.id,
    url: target.url,
    status,
    analysis: null,
    comment: null,
    commentFingerprint: null,
    prepared: null,
    events: [
      {
        status: status === 'generating' ? 'opening' : status,
        message: target.latestMessage,
        at: target.updatedAt,
      },
    ],
    message: target.latestMessage,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}

const demoBatch: BatchSnapshot = {
  id: 'demo-external-seed-audio-3',
  status: 'running',
  settings: {
    provider: 'deepseek',
    websiteUrl: 'https://seed-audio.com',
    displayName: 'Seed Audio',
    email: 'hello@seed-audio.com',
    linkMode: 'prefer-website-field',
    siteId: 'site-seed-audio',
    siteLabel: 'Seed Audio',
  },
  items: Array.from({ length: 30 }, (_, index) => makeDemoBatchItem(index)),
  currentIndex: 18,
  websiteProfile: {
    url: 'https://seed-audio.com',
    title: 'Seed Audio',
    description: 'Professional audio tools and production resources.',
  },
  createdAt: now - 12 * minute,
  updatedAt: now,
};

let demoSettings: ExtensionSettings = {
  ...createDefaultSettings(),
  provider: 'deepseek',
  activeSiteId: 'site-seed-audio',
  sites: demoPlans.slice(0, 4).map((plan) => ({
    id: plan.promotingSiteId,
    label: plan.promotingSiteLabel,
    websiteUrl: plan.promotingWebsiteUrl,
    displayName: plan.promotingSiteLabel,
    email: `hello@${new URL(plan.promotingWebsiteUrl).hostname}`,
    linkMode: 'prefer-website-field',
  })),
};

let demoApiKeys: ProviderApiKeys = {
  deepseekApiKey: '',
  kieApiKey: '',
};

/** Keep preview plan creation on the same settings state shown by the UI. */
export function syncPreviewSettings(settings: ExtensionSettings): void {
  if (isPreviewMode()) demoSettings = settings;
}

/** Keep preview settings edits on the same API key state shown by the UI. */
export function syncPreviewApiKeys(apiKeys: ProviderApiKeys): void {
  if (isPreviewMode()) demoApiKeys = apiKeys;
}

export function isPreviewMode(): boolean {
  if (new URLSearchParams(globalThis.location?.search ?? '').has('preview')) {
    return true;
  }
  return !(
    typeof chrome !== 'undefined' &&
    Boolean(chrome.runtime?.id) &&
    typeof chrome.runtime?.sendMessage === 'function'
  );
}

async function demoRequest<T extends DashboardRequestResult>(
  message: DashboardMessage
): Promise<T> {
  if (message.type === 'dashboard.getSummary') {
    return buildDemoSummary() as T;
  }
  if (message.type === 'plans.list') {
    return { plans: [...demoPlans] } as T;
  }
  if (message.type === 'plan.getDetail') {
    const plan =
      demoPlans.find((item) => item.id === message.planId) ?? demoPlans[0]!;
    return { plan, batches: batchesForPlan(plan) } as T;
  }
  if (message.type === 'plan.getTargets') {
    return targetPage(
      message.planId,
      message.batchId,
      message.page,
      message.pageSize
    ) as T;
  }
  if (message.type === 'plan.create') {
    const site =
      demoSettings.sites.find((item) => item.id === message.siteId) ??
      demoSettings.sites[0]!;
    const urls = message.targetText.split(/\s+/).filter(Boolean);
    const plan = makePlan(
      `plan-${Date.now()}`,
      message.name,
      site.label,
      site.websiteUrl,
      urls.length,
      0,
      Math.ceil(urls.length / message.chunkSize)
    );
    plan.promotingSiteId = site.id;
    plan.chunkSize = message.chunkSize;
    demoPlans = [plan, ...demoPlans];
    return plan as T;
  }
  if (message.type === 'plan.rename') {
    const current = demoPlans.find((plan) => plan.id === message.planId);
    if (!current) return null as T;
    const renamed: Plan = {
      ...current,
      name: message.name.trim(),
      updatedAt: Date.now(),
    };
    demoPlans = demoPlans.map((plan) =>
      plan.id === renamed.id ? renamed : plan
    );
    return renamed as T;
  }
  if (message.type === 'plan.archive') {
    demoPlans = demoPlans.map((plan) =>
      plan.id === message.planId ? { ...plan, status: 'archived' } : plan
    );
    return null as T;
  }
  if (message.type === 'plan.deleteTarget') {
    demoDeletedTargets.add(`${message.planId}:${message.targetId}`);
    return null as T;
  }
  if (message.type === 'plan.deletePermanently') {
    demoPlans = demoPlans.filter((plan) => plan.id !== message.planId);
    return null as T;
  }
  return null as T;
}

export async function dashboardRequest<T extends DashboardRequestResult>(
  message: DashboardMessage
): Promise<T> {
  if (isPreviewMode()) return demoRequest<T>(message);
  const result = await (
    sendToBackground as unknown as (
      input: DashboardMessage
    ) => Promise<{ type: string; data: T }>
  )(message);
  return result.data;
}

export async function loadDashboardSummary(): Promise<DashboardSummaryView> {
  return dashboardRequest<DashboardSummaryView>({
    type: 'dashboard.getSummary',
  });
}

export async function loadPlans(): Promise<Plan[]> {
  const result = await dashboardRequest<PlansListResult>({
    type: 'plans.list',
    includeArchived: true,
  });
  return result.plans;
}

export async function loadSettings(): Promise<ExtensionSettings> {
  if (isPreviewMode()) return demoSettings;
  return getSettings();
}

export async function loadProviderApiKeys(): Promise<ProviderApiKeys> {
  if (isPreviewMode()) return demoApiKeys;
  return getProviderApiKeys();
}

export async function loadActiveBatch(): Promise<BatchSnapshot | null> {
  if (isPreviewMode()) return demoBatch;
  return getBatch();
}

/**
 * Backup export/import always goes through the background service worker,
 * the same side of the runtime that owns the dashboard's IndexedDB
 * (DashboardService/DashboardRepository never open in the dashboard page
 * itself). The preview build has no background worker to talk to, so it
 * echoes the in-memory demo state instead.
 */
export async function exportDataBackup(): Promise<DataBackupFile> {
  if (isPreviewMode()) {
    return {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      appVersion: 'preview',
      data: {
        settings: demoSettings,
        providerApiKeys: demoApiKeys,
        outboundLinkLibrary: [],
        filterList: [],
        anchorPlans: {},
        anchorLedgers: {},
        batchHistory: [],
        dashboard: {
          plans: demoPlans,
          batches: [],
          targets: [],
          runs: [],
          attempts: [],
          meta: [],
        },
      },
    };
  }
  const result = await sendToBackground({ type: 'data-backup.export' });
  return result.data;
}

export async function importDataBackup(backup: DataBackupFile): Promise<void> {
  if (isPreviewMode()) {
    demoSettings = backup.data.settings;
    demoApiKeys = backup.data.providerApiKeys;
    demoPlans = backup.data.dashboard.plans;
    return;
  }
  await sendToBackground({ type: 'data-backup.import', backup });
}

/**
 * The anchor plan and its tally live in chrome.storage, which the dashboard
 * page reads directly the same way it reads settings. Only the fallback-wording
 * generator needs the background worker, since it holds the provider keys and
 * the promoted site's cached profile.
 */
export async function loadAnchorPlan(siteId: string): Promise<AnchorPlan> {
  if (isPreviewMode()) return createDefaultAnchorPlan(siteId, Date.now());
  return getAnchorPlan(siteId);
}

export async function storeAnchorPlan(plan: AnchorPlan): Promise<void> {
  if (isPreviewMode()) return;
  await saveAnchorPlan(plan);
}

export async function loadAnchorLedger(siteId: string): Promise<AnchorLedger> {
  if (isPreviewMode()) return emptyAnchorLedger(siteId, Date.now());
  return getAnchorLedger(siteId);
}

export async function generateNaturalAnchorTexts(
  siteId: string,
  count: number
): Promise<string[]> {
  if (isPreviewMode()) return [];
  const result = await sendToBackground({
    type: 'anchor.generateNaturalTexts',
    siteId,
    count,
  });
  return result.data;
}
