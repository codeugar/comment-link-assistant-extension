import { createBatch } from '@/batch/state';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { BATCH_STORAGE_KEY, clearBatch, getBatch, setBatch } from './batch';

function makeBatch() {
  return createBatch({
    id: 'batch-storage',
    targetText: 'https://blog.example/post',
    settings: {
      provider: 'kie-gemini',
      websiteUrl: 'https://product.example',
      displayName: 'Alex',
      email: '',
      linkMode: 'inline',
    },
    now: 1_000,
  });
}

describe('batch storage', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('returns null when no valid batch is stored', async () => {
    expect(await getBatch()).toBeNull();

    await chrome.storage.local.set({
      [BATCH_STORAGE_KEY]: {
        ...makeBatch(),
        currentIndex: 99,
      },
    });
    expect(await getBatch()).toBeNull();
  });

  it('validates, persists, and returns a legal snapshot', async () => {
    const batch = makeBatch();

    expect(await setBatch(batch)).toEqual(batch);
    expect(await getBatch()).toEqual(batch);
    expect(
      (await chrome.storage.local.get(BATCH_STORAGE_KEY))[BATCH_STORAGE_KEY]
    ).toEqual(batch);
  });

  it('rejects an invalid snapshot instead of persisting it', async () => {
    const invalid = {
      ...makeBatch(),
      settings: {
        ...makeBatch().settings,
        kieApiKey: 'must-not-persist',
      },
    };

    await expect(setBatch(invalid)).rejects.toThrow();
    expect(await getBatch()).toBeNull();
  });

  it('clears the persisted batch', async () => {
    await setBatch(makeBatch());
    await clearBatch();

    expect(await getBatch()).toBeNull();
  });
});
