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

    batch = completeCurrentItem(batch, 'published', 'Published', 2_000);
    expect(batch).toMatchObject({ status: 'running', currentIndex: 1 });
    expect(batch.items[0]).toMatchObject({
      status: 'published',
      message: 'Published',
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

  it('drops generation and page payloads after an item becomes terminal', () => {
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

    batch = completeCurrentItem(batch, 'published', 'Published', 2_000);

    expect(batch.items[0]).toMatchObject({
      status: 'published',
      analysis: null,
      comment: null,
      prepared: null,
    });
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

  it('never retries an unknown result and advances at most once on resume', () => {
    const paused = pauseCurrentItem(
      createTwoItemBatch(),
      'unknown',
      'Submission could not be confirmed',
      2_000
    );

    const resumed = resumeBatch(paused, 3_000);
    expect(resumed).toMatchObject({ status: 'running', currentIndex: 1 });
    expect(resumed.items[0]).toMatchObject({
      status: 'unknown',
      message: 'Submission could not be confirmed',
      updatedAt: 2_000,
    });
    expect(resumed.items[1]?.status).toBe('queued');

    expect(resumeBatch(resumed, 4_000)).toEqual(resumed);
  });

  it('completes when the final unknown result is acknowledged', () => {
    let batch = createTwoItemBatch();
    batch = completeCurrentItem(batch, 'published', '', 2_000);
    batch = pauseCurrentItem(batch, 'unknown', '', 3_000);

    const resumed = resumeBatch(batch, 4_000);
    expect(resumed).toMatchObject({
      status: 'completed',
      currentIndex: 2,
    });
    expect(resumed.items[1]?.status).toBe('unknown');
  });

  it('stops only unprocessed items and preserves attempted outcomes', () => {
    let batch = createTwoItemBatch();
    batch = pauseCurrentItem(batch, 'unknown', 'Unconfirmed click', 2_000);

    const stopped = stopBatch(batch, 3_000);
    expect(stopped).toMatchObject({ status: 'stopped', updatedAt: 3_000 });
    expect(stopped.items[0]).toMatchObject({
      status: 'unknown',
      updatedAt: 2_000,
    });
    expect(stopped.items[1]).toMatchObject({
      status: 'stopped',
      updatedAt: 3_000,
    });
  });
});
