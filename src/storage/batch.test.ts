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

  it('keeps a pre-timeline batch by adding its current node on read', async () => {
    const legacy = makeBatch() as unknown as {
      items: Array<Record<string, unknown>>;
    };
    for (const item of legacy.items) Reflect.deleteProperty(item, 'events');
    await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: legacy });

    await expect(getBatch()).resolves.toMatchObject({
      id: 'batch-storage',
      items: [
        {
          events: [{ status: 'queued', message: '', at: 1_000 }],
        },
      ],
    });
    expect(
      (await chrome.storage.local.get(BATCH_STORAGE_KEY))[BATCH_STORAGE_KEY]
    ).toHaveProperty('items.0.events');
  });

  it('migrates an ambiguous submitted item and event to unconfirmed', async () => {
    const legacy = makeBatch();
    legacy.items[0] = {
      ...legacy.items[0],
      status: 'submitted',
      message: 'COMMENT_SUBMITTED',
      events: [
        {
          status: 'submitted',
          message: 'COMMENT_SUBMITTED',
          at: 1_000,
        },
      ],
    };
    legacy.status = 'completed';
    legacy.currentIndex = 1;
    await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: legacy });

    await expect(getBatch()).resolves.toMatchObject({
      status: 'completed',
      items: [
        {
          status: 'unconfirmed',
          message: 'COMMENT_SUBMISSION_UNCONFIRMED',
          events: [
            {
              status: 'unconfirmed',
              message: 'COMMENT_SUBMISSION_UNCONFIRMED',
            },
          ],
        },
      ],
    });
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
