import { claimWorkerTab } from '@/storage/worker-tab-ownership';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  assertWorkerTabOwnership,
  closeOwnedWorkerTab,
  createOwnedWorkerTab,
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

  it('creates one inactive worker to the right without freezing its group', async () => {
    const activeTab = {
      id: 5,
      index: 2,
      pinned: false,
      highlighted: true,
      active: true,
      incognito: false,
      selected: true,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      windowId: 1,
    } satisfies chrome.tabs.Tab;
    const workerTab = {
      ...activeTab,
      id: 7,
      index: 3,
      highlighted: false,
      active: false,
      selected: false,
    } satisfies chrome.tabs.Tab;
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([activeTab]);
    const create = vi
      .spyOn(chrome.tabs, 'create')
      .mockResolvedValue(workerTab as never);
    const update = vi.spyOn(chrome.tabs, 'update').mockResolvedValue(undefined);
    const group = vi.fn(async () => 11);
    Object.defineProperty(chrome.tabs, 'group', {
      configurable: true,
      value: group,
    });
    const updateGroup = vi.fn(
      async () =>
        ({
          id: 11,
          collapsed: false,
          color: 'orange',
          title: 'Comment Assistant',
          windowId: 1,
        }) satisfies chrome.tabGroups.TabGroup
    );
    Object.defineProperty(chrome, 'tabGroups', {
      configurable: true,
      value: { update: updateGroup },
    });

    await expect(
      createOwnedWorkerTab('batch-1', 'https://blog.example/post')
    ).resolves.toMatchObject({ id: 7, active: false });

    expect(create).toHaveBeenCalledWith({
      active: false,
      index: 3,
      openerTabId: 5,
      windowId: 1,
      url: 'https://blog.example/post',
    });
    expect(group).toHaveBeenCalledWith({
      createProperties: { windowId: 1 },
      tabIds: 7,
    });
    expect(updateGroup).toHaveBeenCalledWith(11, {
      collapsed: false,
      color: 'orange',
      title: 'Comment Assistant',
    });
    expect(update).toHaveBeenCalledWith(7, { autoDiscardable: false });
  });

  it('closes only the worker tab owned by the completed batch', async () => {
    await claimWorkerTab('batch-1', 7);
    const workerTab = {
      id: 7,
    } as chrome.tabs.Tab;
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([workerTab]);
    const remove = vi.spyOn(chrome.tabs, 'remove').mockResolvedValue(undefined);

    await expect(closeOwnedWorkerTab('batch-2', 7)).resolves.toBe(false);
    await expect(closeOwnedWorkerTab('batch-1', 7)).resolves.toBe(true);

    expect(remove).toHaveBeenCalledOnce();
  });

  it('keeps ownership when Chrome rejects the close request', async () => {
    await claimWorkerTab('batch-1', 7);
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([
      {
        id: 7,
      } as chrome.tabs.Tab,
    ]);
    vi.spyOn(chrome.tabs, 'remove').mockRejectedValue(
      new Error('TAB_EDIT_REJECTED')
    );

    await expect(closeOwnedWorkerTab('batch-1', 7)).resolves.toBe(false);
    await expect(
      assertWorkerTabOwnership('batch-1', 7)
    ).resolves.toBeUndefined();
  });

  it('treats an already absent tab as cleaned after ownership is lost', async () => {
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([]);
    const remove = vi.spyOn(chrome.tabs, 'remove');

    await expect(closeOwnedWorkerTab('batch-1', 7)).resolves.toBe(true);

    expect(remove).not.toHaveBeenCalled();
  });
});
