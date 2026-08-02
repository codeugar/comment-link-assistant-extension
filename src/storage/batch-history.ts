import {
  BATCH_ITEM_STATUSES,
  type BatchItemStatus,
  type BatchSettingsSnapshot,
  type BatchSnapshot,
  batchSettingsSnapshotSchema,
} from '@/batch/types';
import { z } from 'zod';

export const HISTORY_STORAGE_KEY = 'comment-link-assistant.batch-history';

const MAX_HISTORY_ENTRIES = 20;

const failedItemStatuses = new Set<BatchItemStatus>([
  'failed',
  'no_form',
  'validation_error',
]);

export interface BatchHistoryItem {
  url: string;
  status: BatchItemStatus;
  message: string;
}

export interface BatchHistoryEntry {
  id: string;
  settings: BatchSettingsSnapshot;
  createdAt: number;
  archivedAt: number;
  counts: {
    /** Compatibility shape for callers holding an unmigrated history entry. */
    submitted?: number;
    published?: number;
    pendingModeration?: number;
    unconfirmed?: number;
    failed: number;
    total: number;
  };
  items: BatchHistoryItem[];
}

const historyEntrySchema: z.ZodType<BatchHistoryEntry> = z
  .object({
    id: z.string().min(1).max(200),
    settings: batchSettingsSnapshotSchema,
    createdAt: z.number().int().nonnegative(),
    archivedAt: z.number().int().nonnegative(),
    counts: z
      .object({
        published: z.number().int().nonnegative(),
        pendingModeration: z.number().int().nonnegative(),
        unconfirmed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    items: z
      .array(
        z
          .object({
            url: z.string().min(1).max(2_048),
            status: z.enum(BATCH_ITEM_STATUSES),
            message: z.string().max(500),
          })
          .strict()
      )
      .max(200),
  })
  .strict();

const historySchema = z.array(historyEntrySchema).max(MAX_HISTORY_ENTRIES);

export function isFailedHistoryStatus(status: BatchItemStatus): boolean {
  return failedItemStatuses.has(status);
}

// Prunes a full snapshot down to the lean archival shape: analysis, prepared,
// comment, and per-item event timelines are dropped to stay well under the
// storage.local quota (no unlimitedStorage permission).
function toHistoryEntry(
  snapshot: BatchSnapshot,
  archivedAt: number
): BatchHistoryEntry {
  let published = 0;
  let pendingModeration = 0;
  let unconfirmed = 0;
  let failed = 0;
  for (const item of snapshot.items) {
    if (item.status === 'published') published += 1;
    else if (item.status === 'pending_moderation') pendingModeration += 1;
    else if (item.status === 'unconfirmed' || item.status === 'submitted') {
      unconfirmed += 1;
    } else if (failedItemStatuses.has(item.status)) failed += 1;
  }
  return {
    id: snapshot.id,
    settings: snapshot.settings,
    createdAt: snapshot.createdAt,
    archivedAt,
    counts: {
      published,
      pendingModeration,
      unconfirmed,
      failed,
      total: snapshot.items.length,
    },
    items: snapshot.items.map((item) => ({
      url: item.url,
      status: item.status,
      message: item.message,
    })),
  };
}

export function parseStoredBatchHistory(
  value: unknown
): BatchHistoryEntry[] | null {
  const parsed = historySchema.safeParse(migrateLegacyBatchHistory(value));
  return parsed.success ? parsed.data : null;
}

// Old history only stored the ambiguous `submitted` bucket. It is safer and
// more truthful to preserve those attempts as unconfirmed than claim they were
// public or waiting for review without their original page receipts.
function migrateLegacyBatchHistory(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  let changed = false;
  const entries = value.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const record = entry as Record<string, unknown>;
    const counts = record.counts;
    const migratedCounts =
      counts &&
      typeof counts === 'object' &&
      !Object.hasOwn(counts, 'published') &&
      typeof (counts as Record<string, unknown>).submitted === 'number'
        ? {
            published: 0,
            pendingModeration: 0,
            unconfirmed: (counts as Record<string, number>).submitted,
            failed: (counts as Record<string, number>).failed,
            total: (counts as Record<string, number>).total,
          }
        : counts;
    const items = Array.isArray(record.items)
      ? record.items.map((item) => {
          if (!item || typeof item !== 'object') return item;
          const itemRecord = item as Record<string, unknown>;
          if (itemRecord.status !== 'submitted') return item;
          changed = true;
          return {
            ...itemRecord,
            status: 'unconfirmed',
            message: 'COMMENT_SUBMISSION_UNCONFIRMED',
          };
        })
      : record.items;
    if (migratedCounts === counts && items === record.items) return entry;
    changed = true;
    return { ...record, counts: migratedCounts, items };
  });
  return changed ? entries : value;
}

export async function getBatchHistory(): Promise<BatchHistoryEntry[]> {
  const stored = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
  const value = stored[HISTORY_STORAGE_KEY];
  const migrated = migrateLegacyBatchHistory(value);
  const parsed = historySchema.safeParse(migrated);
  if (!parsed.success) return [];
  if (migrated !== value) {
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: parsed.data });
  }
  return parsed.data;
}

export async function archiveBatch(
  snapshot: BatchSnapshot,
  at: number = Date.now()
): Promise<void> {
  const entry = historyEntrySchema.parse(toHistoryEntry(snapshot, at));
  const existing = await getBatchHistory();
  const next = [entry, ...existing].slice(0, MAX_HISTORY_ENTRIES);
  await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: next });
}
