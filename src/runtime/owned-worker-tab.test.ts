import { claimWorkerTab } from '@/storage/worker-tab-ownership';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  assertWorkerTabOwnership,
  getOwnedWorkerTab,
  updateOwnedWorkerTab,
} from './owned-worker-tab';

describe('owned worker tab runtime', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('never reads or navigates a persisted tab ID after session ownership is lost', async () => {
    const get = vi.spyOn(chrome.tabs, 'get');
    const update = vi.spyOn(chrome.tabs, 'update');

    await expect(getOwnedWorkerTab('batch-1', 7)).resolves.toBeNull();
    await expect(
      updateOwnedWorkerTab('batch-1', 7, {
        url: 'https://blog.example/post',
      })
    ).resolves.toBeNull();
    await expect(assertWorkerTabOwnership('batch-1', 7)).rejects.toThrow(
      'WORKER_TAB_NOT_OWNED'
    );

    expect(get).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('allows tab operations only for the batch that claimed the tab', async () => {
    await claimWorkerTab('batch-1', 7);
    const tab = {
      id: 7,
      index: 0,
      pinned: false,
      highlighted: false,
      active: true,
      incognito: false,
      selected: true,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      windowId: 1,
    } satisfies chrome.tabs.Tab;
    const get = vi.spyOn(chrome.tabs, 'get').mockResolvedValue(tab);

    await expect(getOwnedWorkerTab('batch-1', 7)).resolves.toEqual(tab);
    await expect(getOwnedWorkerTab('batch-2', 7)).resolves.toBeNull();
    expect(get).toHaveBeenCalledOnce();
  });
});
