import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  WORKER_TAB_OWNERSHIP_STORAGE_KEY,
  claimWorkerTab,
  ownsWorkerTab,
  releaseWorkerTab,
} from './worker-tab-ownership';

describe('worker tab session ownership', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('binds a tab ID to one batch only for the current browser session', async () => {
    await claimWorkerTab('batch-1', 7);

    expect(await ownsWorkerTab('batch-1', 7)).toBe(true);
    expect(await ownsWorkerTab('batch-2', 7)).toBe(false);
    expect(await ownsWorkerTab('batch-1', 8)).toBe(false);

    await chrome.storage.session.clear();
    expect(await ownsWorkerTab('batch-1', 7)).toBe(false);
  });

  it('does not clear a newer worker tab from an older removal event', async () => {
    await claimWorkerTab('batch-2', 9);

    await releaseWorkerTab(7);

    expect(await ownsWorkerTab('batch-2', 9)).toBe(true);
    expect(
      (await chrome.storage.session.get(WORKER_TAB_OWNERSHIP_STORAGE_KEY))[
        WORKER_TAB_OWNERSHIP_STORAGE_KEY
      ]
    ).toEqual({ batchId: 'batch-2', tabId: 9 });
  });
});
