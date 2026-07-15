import { describe, expect, it, vi } from 'vitest';
import { completeCurrentItem, createBatch, updateBatchProgress } from './state';
import { closeTerminalBatchWorker } from './worker-cleanup';

describe('terminal batch worker cleanup', () => {
  it('closes the background worker while preserving the completed batch', async () => {
    let batch = createBatch({
      id: 'batch-1',
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
    batch = updateBatchProgress(batch, { workerTabId: 7 }, 2);
    batch = completeCurrentItem(batch, 'published', 'COMMENT_PUBLISHED', 3);
    const closeWorkerTab = vi.fn(async () => true);
    const setBatch = vi.fn(async (value) => value);

    const cleaned = await closeTerminalBatchWorker(batch, {
      closeWorkerTab,
      setBatch,
      now: () => 4,
    });

    expect(closeWorkerTab).toHaveBeenCalledWith('batch-1', 7);
    expect(cleaned).toMatchObject({ status: 'completed', updatedAt: 4 });
    expect(cleaned).not.toHaveProperty('workerTabId');
    expect(setBatch).toHaveBeenCalledWith(cleaned);
  });

  it('retains the worker reference when Chrome cannot close the tab', async () => {
    let batch = createBatch({
      id: 'batch-1',
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
    batch = updateBatchProgress(batch, { workerTabId: 7 }, 2);
    batch = completeCurrentItem(batch, 'published', 'COMMENT_PUBLISHED', 3);
    const setBatch = vi.fn(async (value) => value);

    const unchanged = await closeTerminalBatchWorker(batch, {
      closeWorkerTab: vi.fn(async () => false),
      setBatch,
      now: () => 4,
    });

    expect(unchanged).toBe(batch);
    expect(unchanged).toHaveProperty('workerTabId', 7);
    expect(setBatch).not.toHaveBeenCalled();
  });
});
