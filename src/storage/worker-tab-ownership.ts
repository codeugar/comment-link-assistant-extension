import { z } from 'zod';

export const WORKER_TAB_OWNERSHIP_STORAGE_KEY =
  'comment-link-assistant.worker-tab-ownership';

const workerTabOwnershipSchema = z
  .object({
    batchId: z.string().min(1).max(200),
    tabId: z.number().int().nonnegative(),
  })
  .strict();

export async function claimWorkerTab(
  batchId: string,
  tabId: number
): Promise<void> {
  const ownership = workerTabOwnershipSchema.parse({ batchId, tabId });
  await chrome.storage.session.set({
    [WORKER_TAB_OWNERSHIP_STORAGE_KEY]: ownership,
  });
}

export async function ownsWorkerTab(
  batchId: string,
  tabId: number
): Promise<boolean> {
  const stored = await chrome.storage.session.get(
    WORKER_TAB_OWNERSHIP_STORAGE_KEY
  );
  const parsed = workerTabOwnershipSchema.safeParse(
    stored[WORKER_TAB_OWNERSHIP_STORAGE_KEY]
  );
  return (
    parsed.success &&
    parsed.data.batchId === batchId &&
    parsed.data.tabId === tabId
  );
}

export async function releaseWorkerTab(tabId: number): Promise<void> {
  const stored = await chrome.storage.session.get(
    WORKER_TAB_OWNERSHIP_STORAGE_KEY
  );
  const parsed = workerTabOwnershipSchema.safeParse(
    stored[WORKER_TAB_OWNERSHIP_STORAGE_KEY]
  );
  if (parsed.success && parsed.data.tabId === tabId) {
    await chrome.storage.session.remove(WORKER_TAB_OWNERSHIP_STORAGE_KEY);
  }
}
