import type { BatchSnapshot } from '@/batch/types';
import { batchSnapshotSchema } from '@/batch/types';

export const BATCH_STORAGE_KEY = 'comment-link-assistant.batch';

function addLegacyItemEvents(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const snapshot = value as Record<string, unknown>;
  if (!Array.isArray(snapshot.items)) return value;
  let changed = false;
  const items = snapshot.items.map((item) => {
    if (!item || typeof item !== 'object' || Object.hasOwn(item, 'events')) {
      return item;
    }
    const legacy = item as Record<string, unknown>;
    changed = true;
    return {
      ...legacy,
      events: [
        {
          status: legacy.status,
          message: typeof legacy.message === 'string' ? legacy.message : '',
          at: legacy.updatedAt,
        },
      ],
    };
  });
  return changed ? { ...snapshot, items } : value;
}

// Prior releases used `submitted` for every post-click outcome, including a
// click with no receipt. Those records cannot be retroactively classified as
// public or held for moderation, so retain them as an explicit unknown result.
function migrateLegacySubmissionStatuses(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const snapshot = value as Record<string, unknown>;
  if (!Array.isArray(snapshot.items)) return value;
  let changed = false;
  const items = snapshot.items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const record = item as Record<string, unknown>;
    const status =
      record.status === 'submitted' ? 'unconfirmed' : record.status;
    const message =
      record.status === 'submitted'
        ? 'COMMENT_SUBMISSION_UNCONFIRMED'
        : record.message;
    const events = Array.isArray(record.events)
      ? record.events.map((event) => {
          if (!event || typeof event !== 'object') return event;
          const eventRecord = event as Record<string, unknown>;
          if (eventRecord.status !== 'submitted') return event;
          changed = true;
          return {
            ...eventRecord,
            status: 'unconfirmed',
            message: 'COMMENT_SUBMISSION_UNCONFIRMED',
          };
        })
      : record.events;
    if (status === record.status && events === record.events) return item;
    changed = true;
    return { ...record, status, message, events };
  });
  return changed ? { ...snapshot, items } : value;
}

export async function getBatch(): Promise<BatchSnapshot | null> {
  const stored = await chrome.storage.local.get(BATCH_STORAGE_KEY);
  const value = stored[BATCH_STORAGE_KEY];
  const withEvents = addLegacyItemEvents(value);
  const migrated = migrateLegacySubmissionStatuses(withEvents);
  const migratedBatch = batchSnapshotSchema.safeParse(migrated);
  if (!migratedBatch.success) return null;
  if (migrated !== value) {
    await chrome.storage.local.set({
      [BATCH_STORAGE_KEY]: migratedBatch.data,
    });
  }
  return migratedBatch.data;
}

export async function setBatch(batch: BatchSnapshot): Promise<BatchSnapshot> {
  const parsed = batchSnapshotSchema.parse(batch);
  await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: parsed });
  return parsed;
}

export async function clearBatch(): Promise<void> {
  await chrome.storage.local.remove(BATCH_STORAGE_KEY);
}
