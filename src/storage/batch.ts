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

export async function getBatch(): Promise<BatchSnapshot | null> {
  const stored = await chrome.storage.local.get(BATCH_STORAGE_KEY);
  const value = stored[BATCH_STORAGE_KEY];
  const parsed = batchSnapshotSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  const migrated = addLegacyItemEvents(value);
  if (migrated === value) return null;
  const migratedBatch = batchSnapshotSchema.safeParse(migrated);
  if (!migratedBatch.success) return null;
  await chrome.storage.local.set({
    [BATCH_STORAGE_KEY]: migratedBatch.data,
  });
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
