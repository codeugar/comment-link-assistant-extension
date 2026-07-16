import type { ExtensionSettings } from '@/types';
import { describe, expect, it } from 'vitest';
import {
  completeCurrentItem,
  createBatch,
  pauseCurrentItem,
  resumeBatch,
  stopBatch,
  updateBatchProgress,
} from './state';

const settings: ExtensionSettings = {
  provider: 'deepseek',
  websiteUrl: 'https://product.example',
  displayName: 'Alex',
  email: 'alex@example.com',
  linkMode: 'prefer-website-field',
};

function createTwoItemBatch() {
  return createBatch({
    id: 'batch-1',
    targetText:
      'https://blog.example/post#comment\nhttps://forum.example/thread',
    settings,
    now: 1_000,
  });
}

describe('batch state', () => {
  it('creates a normalized queue with a key-free settings snapshot', () => {
    const batch = createTwoItemBatch();

    expect(batch).toMatchObject({
      id: 'batch-1',
      status: 'running',
      currentIndex: 0,
      websiteProfile: null,
      settings,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(batch.settings).not.toHaveProperty('deepseekApiKey');
    expect(batch.settings).not.toHaveProperty('kieApiKey');
    expect(batch.items).toEqual([
      {
        id: 'batch-1:0',
        url: 'https://blog.example/post',
        status: 'queued',
        analysis: null,
        comment: null,
        commentFingerprint: null,
        prepared: null,
        events: [{ status: 'queued', message: '', at: 1_000 }],
        message: '',
        createdAt: 1_000,
        updatedAt: 1_000,
      },
      {
        id: 'batch-1:1',
        url: 'https://forum.example/thread',
        status: 'queued',
        analysis: null,
        comment: null,
        commentFingerprint: null,
        prepared: null,
        events: [{ status: 'queued', message: '', at: 1_000 }],
        message: '',
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ]);
  });

  it('stores batch and item progress without mutating the previous snapshot', () => {
    const original = createTwoItemBatch();
    const next = updateBatchProgress(
      original,
      {
        websiteProfile: {
          url: 'https://product.example/',
          title: 'Product',
          description: 'A useful product',
        },
        workerTabId: 42,
        item: {
          status: 'generating',
          analysis: {
            page: {
              url: 'https://blog.example/post',
              title: 'Post',
              description: 'Post description',
              excerpt: 'Post excerpt',
              language: 'en',
              hasWebsiteField: true,
            },
            form: {
              readiness: 'ready',
              editorLabel: 'Comment',
              submitLabel: 'Post comment',
              hasNameField: true,
              hasEmailField: true,
              hasWebsiteField: true,
              message: '',
            },
          },
        },
      },
      2_000
    );

    expect(original.websiteProfile).toBeNull();
    expect(original.items[0]?.status).toBe('queued');
    expect(next).toMatchObject({
      workerTabId: 42,
      updatedAt: 2_000,
      websiteProfile: { title: 'Product' },
      items: [
        {
          status: 'generating',
          updatedAt: 2_000,
        },
        { status: 'queued' },
      ],
    });
  });

  it('advances after terminal success or failure and completes at the end', () => {
    let batch = createTwoItemBatch();

    batch = completeCurrentItem(batch, 'submitted', 'Submitted', 2_000);
    expect(batch).toMatchObject({ status: 'running', currentIndex: 1 });
    expect(batch.items[0]).toMatchObject({
      status: 'submitted',
      message: 'Submitted',
      updatedAt: 2_000,
    });

    batch = completeCurrentItem(batch, 'no_form', 'No form', 3_000);
    expect(batch).toMatchObject({
      status: 'completed',
      currentIndex: 2,
      updatedAt: 3_000,
    });
    expect(batch.items[1]).toMatchObject({
      status: 'no_form',
      message: 'No form',
    });
  });

  it('keeps the generated comment but drops page payloads after completion', () => {
    let batch = createTwoItemBatch();
    batch = updateBatchProgress(
      batch,
      {
        item: {
          status: 'generating',
          comment: 'A generated comment',
          analysis: {
            page: {
              url: 'https://blog.example/post',
              title: 'Post',
              description: 'Description',
              excerpt: 'Excerpt',
              language: 'en',
              hasWebsiteField: false,
            },
            form: {
              readiness: 'ready',
              editorLabel: 'Comment',
              submitLabel: 'Post comment',
              hasNameField: false,
              hasEmailField: false,
              hasWebsiteField: false,
              message: '',
            },
          },
        },
      },
      1_500
    );

    batch = completeCurrentItem(batch, 'submitted', 'Submitted', 2_000);

    expect(batch.items[0]).toMatchObject({
      status: 'submitted',
      analysis: null,
      comment: 'A generated comment',
      prepared: null,
    });
  });

  it('keeps a timestamped node history for each website', () => {
    let batch = createTwoItemBatch();
    batch = updateBatchProgress(batch, { item: { status: 'opening' } }, 1_100);
    batch = updateBatchProgress(
      batch,
      { item: { status: 'analyzing' } },
      1_200
    );
    batch = updateBatchProgress(
      batch,
      { item: { status: 'generating', comment: 'Generated comment' } },
      1_300
    );
    batch = completeCurrentItem(batch, 'submitted', 'COMMENT_SUBMITTED', 1_400);

    expect(batch.items[0]?.events).toEqual([
      { status: 'queued', message: '', at: 1_000 },
      { status: 'opening', message: '', at: 1_100 },
      { status: 'analyzing', message: '', at: 1_200 },
      { status: 'generating', message: '', at: 1_300 },
      {
        status: 'submitted',
        message: 'COMMENT_SUBMITTED',
        at: 1_400,
      },
    ]);
  });

  it.each(['login_required', 'captcha_required'] as const)(
    'pauses on %s and resumes the same item at opening',
    (status) => {
      const paused = pauseCurrentItem(
        createTwoItemBatch(),
        status,
        'Manual action required',
        2_000
      );

      expect(paused).toMatchObject({ status: 'paused', currentIndex: 0 });
      expect(paused.items[0]).toMatchObject({ status });

      const resumed = resumeBatch(paused, 3_000);
      expect(resumed).toMatchObject({
        status: 'running',
        currentIndex: 0,
        updatedAt: 3_000,
      });
      expect(resumed.items[0]).toMatchObject({
        status: 'opening',
        updatedAt: 3_000,
      });
    }
  );

  it('records a submitted result once and immediately advances', () => {
    const completed = completeCurrentItem(
      createTwoItemBatch(),
      'submitted',
      'COMMENT_SUBMITTED',
      2_000
    );

    expect(completed).toMatchObject({ status: 'running', currentIndex: 1 });
    expect(completed.items[0]).toMatchObject({
      status: 'submitted',
      message: 'COMMENT_SUBMITTED',
      updatedAt: 2_000,
    });
    expect(completed.items[1]?.status).toBe('queued');
  });

  it('completes when the final result is a terminal failure', () => {
    let batch = createTwoItemBatch();
    batch = completeCurrentItem(batch, 'submitted', '', 2_000);
    batch = completeCurrentItem(batch, 'failed', '', 3_000);

    expect(batch).toMatchObject({
      status: 'completed',
      currentIndex: 2,
    });
    expect(batch.items[1]?.status).toBe('failed');
  });

  it('stops only unprocessed items and preserves attempted outcomes', () => {
    let batch = createTwoItemBatch();
    batch = completeCurrentItem(batch, 'submitted', 'COMMENT_SUBMITTED', 2_000);

    const stopped = stopBatch(batch, 3_000);
    expect(stopped).toMatchObject({ status: 'stopped', updatedAt: 3_000 });
    expect(stopped.items[0]).toMatchObject({
      status: 'submitted',
      updatedAt: 2_000,
    });
    expect(stopped.items[1]).toMatchObject({
      status: 'stopped',
      updatedAt: 3_000,
    });
  });
});
