import {
  claimWorkerTab,
  ownsWorkerTab,
  releaseWorkerTab,
} from '@/storage/worker-tab-ownership';

export async function createOwnedWorkerTab(
  batchId: string,
  url: string
): Promise<chrome.tabs.Tab & { id: number }> {
  const tab = await chrome.tabs.create({ active: true, url });
  if (typeof tab.id !== 'number') throw new Error('WORKER_TAB_CREATE_FAILED');
  await claimWorkerTab(batchId, tab.id);
  return { ...tab, id: tab.id };
}

export async function getOwnedWorkerTab(
  batchId: string,
  tabId: number
): Promise<chrome.tabs.Tab | null> {
  if (!(await ownsWorkerTab(batchId, tabId))) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) await releaseWorkerTab(tabId);
  return tab;
}

export async function updateOwnedWorkerTab(
  batchId: string,
  tabId: number,
  updateProperties: chrome.tabs.UpdateProperties
): Promise<chrome.tabs.Tab | null> {
  if (!(await ownsWorkerTab(batchId, tabId))) return null;
  const tab = await chrome.tabs
    .update(tabId, updateProperties)
    .catch(() => null);
  if (!tab) await releaseWorkerTab(tabId);
  return tab;
}

export async function assertWorkerTabOwnership(
  batchId: string,
  tabId: number
): Promise<void> {
  if (!(await ownsWorkerTab(batchId, tabId))) {
    throw new Error('WORKER_TAB_NOT_OWNED');
  }
}
