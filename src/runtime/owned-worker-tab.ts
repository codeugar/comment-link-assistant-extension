import {
  claimWorkerTab,
  ownsWorkerTab,
  releaseWorkerTab,
} from '@/storage/worker-tab-ownership';

export async function createOwnedWorkerTab(
  batchId: string,
  url: string
): Promise<chrome.tabs.Tab & { id: number }> {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
    windowType: 'normal',
  });
  if (typeof activeTab?.id !== 'number') {
    throw new Error('ACTIVE_TAB_NOT_FOUND');
  }
  const tab = await chrome.tabs.create({
    active: false,
    index: activeTab.index + 1,
    openerTabId: activeTab.id,
    windowId: activeTab.windowId,
    url,
  });
  if (typeof tab.id !== 'number') throw new Error('WORKER_TAB_CREATE_FAILED');
  try {
    const groupId = await chrome.tabs.group({
      createProperties: { windowId: activeTab.windowId },
      tabIds: tab.id,
    });
    await chrome.tabGroups.update(groupId, {
      collapsed: false,
      color: 'orange',
      title: 'Comment Assistant',
    });
    await chrome.tabs.update(tab.id, { autoDiscardable: false });
    await claimWorkerTab(batchId, tab.id);
    return { ...tab, id: tab.id };
  } catch (error) {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
    throw error;
  }
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
