import type { BatchSnapshot } from '@/batch/types';
import { batchSnapshotSchema } from '@/batch/types';

export const BATCH_STORAGE_KEY = 'comment-link-assistant.batch';

export async function getBatch(): Promise<BatchSnapshot | null> {
  const stored = await chrome.storage.local.get(BATCH_STORAGE_KEY);
  const parsed = batchSnapshotSchema.safeParse(stored[BATCH_STORAGE_KEY]);
  return parsed.success ? parsed.data : null;
}

export async function setBatch(batch: BatchSnapshot): Promise<BatchSnapshot> {
  const parsed = batchSnapshotSchema.parse(batch);
  await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: parsed });
  return parsed;
}

export async function clearBatch(): Promise<void> {
  await chrome.storage.local.remove(BATCH_STORAGE_KEY);
}
