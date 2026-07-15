import { createBatch } from '@/batch/state';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { getBatch, setBatch } from './batch';
import {
  clearBatchStopIntent,
  consumeBatchStopIntent,
  getBatchStopIntent,
  requestBatchStop,
} from './stop-intent';

function makeBatch() {
  return createBatch({
    id: 'batch-stop-intent',
    targetText: 'https://blog.example/post',
    settings: {
      provider: 'kie-gemini',
      websiteUrl: 'https://product.example',
      displayName: '',
      email: '',
      linkMode: 'inline',
    },
    now: 1_000,
  });
}

describe('batch stop intent storage', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('survives service worker memory loss until explicitly cleared', async () => {
    expect(await getBatchStopIntent()).toBe(false);

    await requestBatchStop();
    expect(await getBatchStopIntent()).toBe(true);

    await clearBatchStopIntent();
    expect(await getBatchStopIntent()).toBe(false);
  });

  it('stops an active persisted batch before consuming the intent', async () => {
    await setBatch(makeBatch());
    await requestBatchStop();

    expect(await consumeBatchStopIntent()).toBe(true);

    expect((await getBatch())?.status).toBe('stopped');
    expect(await getBatchStopIntent()).toBe(false);
  });

  it('keeps the intent when persisting the stopped batch fails', async () => {
    await setBatch(makeBatch());
    await requestBatchStop();
    vi.spyOn(chrome.storage.local, 'set').mockRejectedValueOnce(
      new Error('storage unavailable')
    );

    await expect(consumeBatchStopIntent()).rejects.toThrow(
      'storage unavailable'
    );

    expect(await getBatchStopIntent()).toBe(true);
    expect((await getBatch())?.status).toBe('running');
  });
});
