import { describe, expect, it, vi } from 'vitest';
import {
  createBatch,
  pauseCurrentItem,
  stopBatch,
  updateBatchProgress,
} from './state';
import {
  handleRemovedWorkerTabSafely,
  openCurrentTargetSafely,
} from './tab-coordinator';
import type { BatchSnapshot } from './types';

function initialBatch(): BatchSnapshot {
  return createBatch({
    id: 'batch-tab-race',
    targetText: 'https://blog.example/post',
    settings: {
      provider: 'deepseek',
      websiteUrl: 'https://product.example',
      displayName: '',
      email: '',
      linkMode: 'inline',
    },
    now: 1,
  });
}

function dependencies(current: () => BatchSnapshot | null) {
  return {
    getActiveRunner: () => null,
    getBatch: vi.fn(async () => current()),
    setBatch: vi.fn(async (batch: BatchSnapshot) => batch),
    getBatchStopIntent: vi.fn(async () => false),
    activateTab: vi.fn(async () => false),
    createTab: vi.fn(async () => 9),
    requestBatchWake: vi.fn(),
    isStopRequested: vi.fn(() => false),
    now: vi.fn(() => 10),
  };
}

describe('background batch tab coordination', () => {
  it('cannot overwrite a generated comment when a worker tab disappears', async () => {
    const stale = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: {
          status: 'generating',
          message: 'COMMENT_GENERATION_REQUESTED',
        },
      },
      2
    );
    let persisted = stale;
    let finishActivation: ((value: boolean) => void) | undefined;
    const deps = dependencies(() => persisted);
    deps.activateTab.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishActivation = resolve;
        })
    );

    const opening = openCurrentTargetSafely(deps);
    await vi.waitFor(() => expect(finishActivation).toBeTypeOf('function'));
    persisted = updateBatchProgress(
      stale,
      { item: { comment: 'Generated comment', message: '' } },
      3
    );
    finishActivation?.(false);

    await expect(opening).resolves.toMatchObject({
      items: [{ comment: 'Generated comment' }],
    });
    expect(deps.setBatch).not.toHaveBeenCalled();
    expect(deps.createTab).not.toHaveBeenCalled();
    expect(deps.requestBatchWake).toHaveBeenCalledOnce();
  });

  it('cannot revive a stopped batch after opening a paused target', async () => {
    const running = updateBatchProgress(initialBatch(), { workerTabId: 7 }, 2);
    const paused = pauseCurrentItem(
      running,
      'login_required',
      'LOGIN_REQUIRED',
      3
    );
    let persisted = paused;
    const deps = dependencies(() => persisted);
    deps.getBatchStopIntent.mockImplementation(async () => {
      persisted = stopBatch(paused, 4);
      return true;
    });

    await expect(openCurrentTargetSafely(deps)).resolves.toMatchObject({
      status: 'stopped',
    });
    expect(deps.createTab).toHaveBeenCalledOnce();
    expect(deps.setBatch).not.toHaveBeenCalled();
    expect(persisted.status).toBe('stopped');
  });

  it('never writes a stale snapshot from a removed-tab event', async () => {
    const stale = updateBatchProgress(initialBatch(), { workerTabId: 7 }, 2);
    const persisted = stopBatch(stale, 3);
    const requestBatchWake = vi.fn();

    await handleRemovedWorkerTabSafely(7, {
      getBatch: async () => stale,
      requestBatchWake,
    });

    expect(requestBatchWake).toHaveBeenCalledOnce();
    expect(persisted.status).toBe('stopped');
  });
});
