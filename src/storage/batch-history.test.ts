import { completeCurrentItem, createBatch } from '@/batch/state';
import type { BatchSnapshot } from '@/batch/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  HISTORY_STORAGE_KEY,
  archiveBatch,
  getBatchHistory,
} from './batch-history';

const settings = {
  provider: 'deepseek' as const,
  websiteUrl: 'https://product.example',
  displayName: 'Alex',
  email: '',
  linkMode: 'inline' as const,
};

function terminalBatch(id: string, now = 1_000): BatchSnapshot {
  let batch = createBatch({
    id,
    targetText: 'https://blog.example/one\nhttps://forum.example/two',
    settings,
    now,
  });
  batch = completeCurrentItem(batch, 'submitted', 'COMMENT_SUBMITTED', now + 1);
  batch = completeCurrentItem(batch, 'failed', 'BOOM', now + 2);
  return batch;
}

describe('batch history storage', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('returns an empty list when nothing is stored', async () => {
    expect(await getBatchHistory()).toEqual([]);
  });

  it('archives a lean entry and reads it back', async () => {
    await archiveBatch(terminalBatch('batch-a'), 5_000);

    const history = await getBatchHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: 'batch-a',
      settings,
      createdAt: 1_000,
      archivedAt: 5_000,
      counts: { submitted: 1, failed: 1, total: 2 },
      items: [
        {
          url: 'https://blog.example/one',
          status: 'submitted',
          message: 'COMMENT_SUBMITTED',
        },
        { url: 'https://forum.example/two', status: 'failed', message: 'BOOM' },
      ],
    });
  });

  it('counts no_form and validation_error as failed', async () => {
    let batch = createBatch({
      id: 'batch-mixed',
      targetText:
        'https://a.example/1\nhttps://b.example/2\nhttps://c.example/3',
      settings,
      now: 1_000,
    });
    batch = completeCurrentItem(batch, 'no_form', 'NF', 1_100);
    batch = completeCurrentItem(batch, 'validation_error', 'VE', 1_200);
    batch = completeCurrentItem(batch, 'submitted', 'OK', 1_300);
    await archiveBatch(batch, 2_000);

    expect((await getBatchHistory())[0]?.counts).toEqual({
      submitted: 1,
      failed: 2,
      total: 3,
    });
  });

  it('drops heavy per-item fields when archiving', async () => {
    await archiveBatch(terminalBatch('batch-b'));

    const stored = (await chrome.storage.local.get(HISTORY_STORAGE_KEY))[
      HISTORY_STORAGE_KEY
    ] as Array<{ items: Array<Record<string, unknown>> }>;
    const item = stored[0]?.items[0] ?? {};
    expect(Object.keys(item).sort()).toEqual(['message', 'status', 'url']);
    expect(item).not.toHaveProperty('analysis');
    expect(item).not.toHaveProperty('events');
    expect(item).not.toHaveProperty('comment');
    expect(item).not.toHaveProperty('prepared');
  });

  it('prepends newest first and caps at 20 entries', async () => {
    for (let index = 0; index < 21; index += 1) {
      await archiveBatch(
        terminalBatch(`batch-${index}`, 1_000 + index),
        10_000 + index
      );
    }

    const history = await getBatchHistory();
    expect(history).toHaveLength(20);
    expect(history[0]?.id).toBe('batch-20');
    expect(history.some((entry) => entry.id === 'batch-0')).toBe(false);
  });

  it('treats invalid stored data as empty history', async () => {
    await chrome.storage.local.set({
      [HISTORY_STORAGE_KEY]: { not: 'an array' },
    });
    expect(await getBatchHistory()).toEqual([]);
  });

  it('preserves site provenance from a multi-site batch snapshot', async () => {
    let batch = createBatch({
      id: 'batch-site',
      targetText: 'https://blog.example/one',
      settings: { ...settings, siteId: 'site-9', siteLabel: 'Museimage' },
      now: 1_000,
    });
    batch = completeCurrentItem(batch, 'submitted', 'OK', 1_100);
    await archiveBatch(batch, 2_000);

    expect((await getBatchHistory())[0]?.settings).toMatchObject({
      siteId: 'site-9',
      siteLabel: 'Museimage',
    });
  });
});
