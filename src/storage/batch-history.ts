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
  counts: { submitted: number; failed: number; total: number };
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
        submitted: z.number().int().nonnegative(),
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
  let submitted = 0;
  let failed = 0;
  for (const item of snapshot.items) {
    if (item.status === 'submitted') submitted += 1;
    else if (failedItemStatuses.has(item.status)) failed += 1;
  }
  return {
    id: snapshot.id,
    settings: snapshot.settings,
    createdAt: snapshot.createdAt,
    archivedAt,
    counts: { submitted, failed, total: snapshot.items.length },
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
  const parsed = historySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function getBatchHistory(): Promise<BatchHistoryEntry[]> {
  const stored = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
  return parseStoredBatchHistory(stored[HISTORY_STORAGE_KEY]) ?? [];
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
