import { stopBatch } from '@/batch/state';
import { getBatch, setBatch } from './batch';

export const BATCH_STOP_INTENT_STORAGE_KEY =
  'comment-link-assistant.batch-stop-intent';

export async function requestBatchStop(): Promise<void> {
  await chrome.storage.local.set({ [BATCH_STOP_INTENT_STORAGE_KEY]: true });
}

export async function getBatchStopIntent(): Promise<boolean> {
  const stored = await chrome.storage.local.get(BATCH_STOP_INTENT_STORAGE_KEY);
  return stored[BATCH_STOP_INTENT_STORAGE_KEY] === true;
}

export async function clearBatchStopIntent(): Promise<void> {
  await chrome.storage.local.remove(BATCH_STOP_INTENT_STORAGE_KEY);
}

export async function consumeBatchStopIntent(): Promise<boolean> {
  if (!(await getBatchStopIntent())) return false;

  const batch = await getBatch();
  if (batch?.status === 'running' || batch?.status === 'paused') {
    await setBatch(stopBatch(batch));
  }
  await clearBatchStopIntent();
  return true;
}
