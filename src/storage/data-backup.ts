import {
  DASHBOARD_BATCH_STATUSES,
  DASHBOARD_PLAN_STATUSES,
  DASHBOARD_RUN_KINDS,
  DASHBOARD_RUN_STATUSES,
  PLAN_TARGET_STATUSES,
} from '@/dashboard/model';
import type { DashboardBackupData } from '@/dashboard/model';
import type { ExtensionSettings, ProviderApiKeys, SiteProfile } from '@/types';
import { z } from 'zod';
import { anchorLedgersSchema } from './anchor-ledger';
import type { AnchorLedgersMap } from './anchor-ledger';
import { anchorPlansSchema } from './anchor-plan';
import type { AnchorPlansMap } from './anchor-plan';
import { batchHistorySchema } from './batch-history';
import type { BatchHistoryEntry } from './batch-history';
import { filterListSchema } from './filter-list';
import type { FilterListEntry } from './filter-list';
import { outboundLinkLibrarySchema } from './outbound-link-library';
import type { OutboundLinkLibraryEntry } from './outbound-link-library';
import {
  createDefaultSettings,
  extensionSettingsSchema,
  providerApiKeysSchema,
} from './settings';

/**
 * Versioned JSON export/import of every piece of user data the extension
 * stores locally, so a user can migrate everything (settings, API keys,
 * outbound link library, filter list, batch history, and the dashboard's
 * IndexedDB plans/runs/targets/attempts) to a fresh install after the
 * extension ID changes. Format changes bump `DATA_BACKUP_FORMAT_VERSION`;
 * older extension builds refuse to import a newer, unrecognized version.
 */
export const DATA_BACKUP_FORMAT_VERSION = 1;

export const FIRST_RUN_STORAGE_KEY = 'comment-link-assistant.first-run';

export interface DataBackupSections {
  settings: ExtensionSettings;
  providerApiKeys: ProviderApiKeys;
  outboundLinkLibrary: OutboundLinkLibraryEntry[];
  filterList: FilterListEntry[];
  batchHistory: BatchHistoryEntry[];
  dashboard: DashboardBackupData;
  /**
   * Anchor mix configuration and its running tally. Both are optional on read:
   * a backup taken before anchor ratios existed simply restores as no mix
   * configured and an empty tally, which is exactly the pre-feature behaviour.
   */
  anchorPlans: AnchorPlansMap;
  anchorLedgers: AnchorLedgersMap;
}

export interface DataBackupFile {
  formatVersion: number;
  exportedAt: string;
  appVersion: string;
  data: DataBackupSections;
}

export type DataBackupErrorCode =
  | 'BACKUP_FILE_INVALID'
  | 'BACKUP_FORMAT_VERSION_UNSUPPORTED'
  | 'BACKUP_SECTION_SETTINGS_INVALID'
  | 'BACKUP_SECTION_PROVIDER_API_KEYS_INVALID'
  | 'BACKUP_SECTION_OUTBOUND_LINK_LIBRARY_INVALID'
  | 'BACKUP_SECTION_FILTER_LIST_INVALID'
  | 'BACKUP_SECTION_BATCH_HISTORY_INVALID'
  | 'BACKUP_SECTION_DASHBOARD_INVALID'
  | 'BACKUP_SECTION_ANCHOR_PLANS_INVALID'
  | 'BACKUP_SECTION_ANCHOR_LEDGERS_INVALID';

export class DataBackupError extends Error {
  constructor(
    readonly code: DataBackupErrorCode,
    message: string = code
  ) {
    super(message);
    this.name = 'DataBackupError';
  }
}

const attemptErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    friendlyMessage: z.string(),
    at: z.number(),
  })
  .strict();

const dashboardPlanSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    promotingSiteId: z.string(),
    promotingSiteLabel: z.string(),
    promotingWebsiteUrl: z.string(),
    status: z.enum(DASHBOARD_PLAN_STATUSES),
    chunkSize: z.number(),
    targetCount: z.number(),
    processedCount: z.number(),
    submittedCount: z.number(),
    failedCount: z.number(),
    unknownCount: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    archivedAt: z.number().optional(),
  })
  .strict();

const dashboardPlanBatchSchema = z
  .object({
    id: z.string().min(1),
    planId: z.string().min(1),
    sequence: z.number(),
    status: z.enum(DASHBOARD_BATCH_STATUSES),
    targetCount: z.number(),
    processedCount: z.number(),
    submittedCount: z.number(),
    failedCount: z.number(),
    unknownCount: z.number(),
    externalBatchId: z.string().optional(),
    currentRunId: z.string().optional(),
    startedAt: z.number().optional(),
    completedAt: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

const dashboardPlanTargetSchema = z
  .object({
    id: z.string().min(1),
    planId: z.string().min(1),
    batchId: z.string().min(1),
    batchSequence: z.number(),
    sequence: z.number(),
    url: z.string(),
    host: z.string(),
    status: z.enum(PLAN_TARGET_STATUSES),
    attemptCount: z.number(),
    latestMessage: z.string(),
    lastModerationCheckAt: z.number().optional(),
    lastModerationCheckMessage: z.string().optional(),
    lastError: attemptErrorSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

const dashboardRunSchema = z
  .object({
    id: z.string().min(1),
    planId: z.string().optional(),
    batchId: z.string().optional(),
    externalBatchId: z.string().optional(),
    kind: z.enum(DASHBOARD_RUN_KINDS),
    status: z.enum(DASHBOARD_RUN_STATUSES),
    targetIds: z.array(z.string()),
    createdAt: z.number(),
    startedAt: z.number(),
    updatedAt: z.number(),
    completedAt: z.number().optional(),
  })
  .strict();

const attemptEventSchema = z
  .object({
    stage: z.string(),
    status: z.enum(PLAN_TARGET_STATUSES),
    message: z.string(),
    at: z.number(),
  })
  .strict();

const dashboardAttemptSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    planId: z.string().optional(),
    batchId: z.string().optional(),
    targetId: z.string().optional(),
    url: z.string(),
    attemptNumber: z.number(),
    status: z.enum(PLAN_TARGET_STATUSES),
    timeline: z.array(attemptEventSchema),
    comment: z.string().optional(),
    commentFingerprint: z.string().optional(),
    error: attemptErrorSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    completedAt: z.number().optional(),
  })
  .strict();

const dashboardMetaSchema = z
  .object({
    key: z.string().min(1),
    value: z.unknown(),
    updatedAt: z.number(),
  })
  .strict();

const dashboardBackupDataSchema: z.ZodType<DashboardBackupData> = z.object({
  plans: z.array(dashboardPlanSchema),
  batches: z.array(dashboardPlanBatchSchema),
  targets: z.array(dashboardPlanTargetSchema),
  runs: z.array(dashboardRunSchema),
  attempts: z.array(dashboardAttemptSchema),
  meta: z.array(dashboardMetaSchema),
});

const backupEnvelopeShapeSchema = z.object({
  formatVersion: z.number(),
  exportedAt: z.string(),
  appVersion: z.string(),
  data: z.record(z.string(), z.unknown()),
});

/** Wraps the gathered per-module data into the versioned backup envelope. */
export function buildDataBackup(
  sections: DataBackupSections,
  appVersion: string,
  now: () => Date = () => new Date()
): DataBackupFile {
  return {
    formatVersion: DATA_BACKUP_FORMAT_VERSION,
    exportedAt: now().toISOString(),
    appVersion,
    data: sections,
  };
}

/**
 * Validates a parsed JSON value as a data backup file. Every section is
 * validated independently against the same schemas the live modules use, so
 * a malformed or corrupted section produces a specific, actionable error
 * instead of silently importing partial data. A `formatVersion` newer than
 * this build understands is rejected outright (forward-compatible refusal);
 * unrecognized top-level fields on the envelope itself are ignored so a
 * future minor addition does not break older extension builds.
 */
export function parseDataBackupFile(raw: unknown): DataBackupFile {
  const envelope = backupEnvelopeShapeSchema.safeParse(raw);
  if (!envelope.success) throw new DataBackupError('BACKUP_FILE_INVALID');
  if (envelope.data.formatVersion !== DATA_BACKUP_FORMAT_VERSION) {
    throw new DataBackupError(
      'BACKUP_FORMAT_VERSION_UNSUPPORTED',
      `BACKUP_FORMAT_VERSION_UNSUPPORTED:${envelope.data.formatVersion}`
    );
  }

  const data = envelope.data.data;

  const settings = extensionSettingsSchema.safeParse(data.settings);
  if (!settings.success) {
    throw new DataBackupError('BACKUP_SECTION_SETTINGS_INVALID');
  }
  const providerApiKeys = providerApiKeysSchema.safeParse(data.providerApiKeys);
  if (!providerApiKeys.success) {
    throw new DataBackupError('BACKUP_SECTION_PROVIDER_API_KEYS_INVALID');
  }
  const outboundLinkLibrary = outboundLinkLibrarySchema.safeParse(
    data.outboundLinkLibrary
  );
  if (!outboundLinkLibrary.success) {
    throw new DataBackupError('BACKUP_SECTION_OUTBOUND_LINK_LIBRARY_INVALID');
  }
  const filterList = filterListSchema.safeParse(data.filterList);
  if (!filterList.success) {
    throw new DataBackupError('BACKUP_SECTION_FILTER_LIST_INVALID');
  }
  const batchHistory = batchHistorySchema.safeParse(data.batchHistory);
  if (!batchHistory.success) {
    throw new DataBackupError('BACKUP_SECTION_BATCH_HISTORY_INVALID');
  }
  const dashboard = dashboardBackupDataSchema.safeParse(data.dashboard);
  if (!dashboard.success) {
    throw new DataBackupError('BACKUP_SECTION_DASHBOARD_INVALID');
  }
  // Absent in any backup written before anchor ratios shipped, so a missing
  // section restores as empty rather than rejecting the whole file.
  const anchorPlans = anchorPlansSchema.safeParse(data.anchorPlans ?? {});
  if (!anchorPlans.success) {
    throw new DataBackupError('BACKUP_SECTION_ANCHOR_PLANS_INVALID');
  }
  const anchorLedgers = anchorLedgersSchema.safeParse(data.anchorLedgers ?? {});
  if (!anchorLedgers.success) {
    throw new DataBackupError('BACKUP_SECTION_ANCHOR_LEDGERS_INVALID');
  }

  return {
    formatVersion: DATA_BACKUP_FORMAT_VERSION,
    exportedAt: envelope.data.exportedAt,
    appVersion: envelope.data.appVersion,
    data: {
      settings: settings.data,
      providerApiKeys: providerApiKeys.data,
      outboundLinkLibrary: outboundLinkLibrary.data,
      filterList: filterList.data,
      batchHistory: batchHistory.data,
      dashboard: dashboard.data,
      anchorPlans: anchorPlans.data,
      anchorLedgers: anchorLedgers.data,
    },
  };
}

function siteProfileIsUnconfigured(site: SiteProfile): boolean {
  return !site.label && !site.websiteUrl && !site.displayName && !site.email;
}

/**
 * Used to decide whether the first-run "import a backup?" prompt should
 * appear: true only when the user has not configured any promoting site yet
 * (a brand-new install), so the prompt never interrupts someone who already
 * set the extension up by hand.
 */
export function isDefaultExtensionSettings(
  settings: ExtensionSettings
): boolean {
  const defaults = createDefaultSettings();
  return (
    settings.provider === defaults.provider &&
    settings.sites.length === defaults.sites.length &&
    settings.sites.every((site) => siteProfileIsUnconfigured(site))
  );
}

/** Set by the background service worker's `onInstalled` (reason: 'install')
 * handler; cleared once the user dismisses or completes the first-run
 * import prompt shown by the dashboard. */
export async function markFirstRunPending(): Promise<void> {
  await chrome.storage.local.set({ [FIRST_RUN_STORAGE_KEY]: true });
}

export async function isFirstRunPending(): Promise<boolean> {
  const stored = await chrome.storage.local.get(FIRST_RUN_STORAGE_KEY);
  return stored[FIRST_RUN_STORAGE_KEY] === true;
}

export async function clearFirstRunPending(): Promise<void> {
  await chrome.storage.local.remove(FIRST_RUN_STORAGE_KEY);
}
