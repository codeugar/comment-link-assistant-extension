import { describe, expect, it } from 'vitest';
import {
  RETRYABLE_ITEM_STATUSES,
  completeCurrentItem,
  createBatch,
  filterQueuedItems,
  hasResumableItems,
  pauseCurrentItem,
  resumeBatch,
  resumeStoppedBatch,
  retryItems,
  skipCurrentManualGate,
  stopBatch,
  updateBatchProgress,
} from './state';
import type { BatchSettingsSnapshot } from './types';
import { batchSnapshotSchema } from './types';

const settings: BatchSettingsSnapshot = {
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
  it('accepts the canonical Website value in a prepared item', () => {
    const batch = createTwoItemBatch();
    const preparedBatch = {
      ...batch,
      items: [
        {
          ...batch.items[0],
          status: 'prepared' as const,
          prepared: {
            fingerprint: 'comment-fingerprint',
            comment: 'A useful comment',
            websiteUrl: 'https://product.example',
            domToken: 'dom-token',
            baseline: { feedbackMessages: [], renderedComment: false },
            expected: {
              url: 'https://blog.example/post',
              editorLabel: 'Comment',
              submitLabel: 'Post comment',
              hasWebsiteField: true,
            },
          },
        },
        ...batch.items.slice(1),
      ],
    };

    expect(() => batchSnapshotSchema.parse(preparedBatch)).not.toThrow();
  });

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

  it('marks queued matches filtered and completes when none remain runnable', () => {
    const partiallyFiltered = filterQueuedItems(
      createTwoItemBatch(),
      ['https://blog.example/post'],
      'FILTER_LIST_MATCHED',
      2_000
    );

    expect(partiallyFiltered).toMatchObject({
      status: 'running',
      currentIndex: 1,
      items: [
        {
          status: 'filtered',
          message: 'FILTER_LIST_MATCHED',
          updatedAt: 2_000,
        },
        { status: 'queued' },
      ],
    });

    const completed = filterQueuedItems(
      createTwoItemBatch(),
      ['https://blog.example/post', 'https://forum.example/thread'],
      'FILTER_LIST_MATCHED',
      2_000
    );
    expect(completed.status).toBe('completed');
    expect(completed.currentIndex).toBe(2);
    expect(completed.items.every((item) => item.status === 'filtered')).toBe(
      true
    );
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

  it.each([
    ['login_required', 'LOGIN_REQUIRED_SKIPPED'],
    ['captcha_required', 'CAPTCHA_REQUIRED_SKIPPED'],
  ] as const)(
    'skips a pre-submit %s gate and continues the queue',
    (status, message) => {
      const paused = pauseCurrentItem(
        createTwoItemBatch(),
        status,
        'MANUAL_GATE',
        2_000
      );
      const skipped = skipCurrentManualGate(paused, 3_000);

      expect(skipped).toMatchObject({ status: 'running', currentIndex: 1 });
      expect(skipped.items[0]).toMatchObject({
        status,
        message,
        updatedAt: 3_000,
        prepared: null,
      });
      expect(skipped.items[0]?.events.at(-1)).toEqual({
        status,
        message,
        at: 3_000,
      });
      expect(skipped.items[1]?.status).toBe('queued');
    }
  );

  it('does not skip a manual gate after a submit click may have occurred', () => {
    let batch = updateBatchProgress(
      createTwoItemBatch(),
      {
        item: {
          status: 'prepared',
          prepared: {
            fingerprint: 'fingerprint',
            comment: 'Comment',
            domToken: 'token',
            baseline: { feedbackMessages: [], renderedComment: false },
            expected: {
              url: 'https://blog.example/post',
              editorLabel: 'Comment',
              submitLabel: 'Post',
              hasWebsiteField: false,
            },
          },
        },
      },
      2_000
    );
    batch = pauseCurrentItem(batch, 'login_required', 'LOGIN_REQUIRED', 3_000);

    expect(() => skipCurrentManualGate(batch, 4_000)).toThrow(
      'BATCH_SKIP_UNAVAILABLE'
    );
  });

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
  it.each(['click_dispatched', 'verifying'] as const)(
    'resumes a stopped %s item by verifying it instead of requeueing it',
    (inFlightStatus) => {
      let batch = createThreeItemBatch();
      batch = completeCurrentItem(
        batch,
        'submitted',
        'COMMENT_SUBMITTED',
        2_000
      );
      batch = updateBatchProgress(
        batch,
        { workerTabId: 42, item: { status: inFlightStatus } },
        3_000
      );
      batch = stopBatch(batch, 4_000);

      const resumed = resumeStoppedBatch(batch, 5_000);

      expect(resumed).toMatchObject({
        status: 'running',
        currentIndex: 1,
        workerTabId: 42,
      });
      expect(resumed.items[0]).toMatchObject({ status: 'submitted' });
      expect(resumed.items[1]).toMatchObject({
        status: inFlightStatus,
        updatedAt: 3_000,
      });
      expect(resumed.items[2]).toMatchObject({
        status: 'queued',
        analysis: null,
        comment: null,
        prepared: null,
        updatedAt: 5_000,
      });
      expect(resumed.items[2]?.events.at(-1)).toEqual({
        status: 'queued',
        message: 'BATCH_RESUME',
        at: 5_000,
      });
      expect(() => batchSnapshotSchema.parse(resumed)).not.toThrow();
    }
  );

  it('agrees with resumeStoppedBatch about whether a stop left work behind', () => {
    let batch = createTwoItemBatch();
    batch = stopBatch(batch, 3_000);
    expect(hasResumableItems(batch)).toBe(true);
    expect(() => resumeStoppedBatch(batch, 4_000)).not.toThrow();
  });

  it('reports no resumable work once every target settled', () => {
    let batch = createTwoItemBatch();
    batch = completeCurrentItem(batch, 'submitted', '', 2_000);
    batch = completeCurrentItem(batch, 'failed', 'BOOM', 3_000);

    // A stop over a run with nothing left is a no-op, so the snapshot stays
    // completed and never offers a resume.
    expect(stopBatch(batch, 4_000)).toBe(batch);
    expect(hasResumableItems(batch)).toBe(false);
  });
});

function createThreeItemBatch() {
  return createBatch({
    id: 'batch-1',
    targetText:
      'https://blog.example/one\nhttps://forum.example/two\nhttps://news.example/three',
    settings,
    now: 1_000,
  });
}

describe('batch retry', () => {
  it('exposes the item statuses eligible for retry', () => {
    expect([...RETRYABLE_ITEM_STATUSES]).toEqual([
      'failed',
      'no_form',
      'validation_error',
      'login_required',
      'captcha_required',
      'stopped',
    ]);
  });

  it('requeues a failed item from a completed batch and resumes running', () => {
    let batch = createTwoItemBatch();
    batch = completeCurrentItem(batch, 'submitted', 'COMMENT_SUBMITTED', 2_000);
    batch = completeCurrentItem(batch, 'failed', 'BOOM', 3_000);
    expect(batch.status).toBe('completed');

    const retried = retryItems(batch, ['batch-1:1'], 5_000);

    expect(retried).toMatchObject({
      status: 'running',
      currentIndex: 1,
      updatedAt: 5_000,
    });
    expect(retried.items[0]).toMatchObject({ status: 'submitted' });
    expect(retried.items[1]).toMatchObject({
      status: 'queued',
      analysis: null,
      comment: null,
      commentFingerprint: null,
      prepared: null,
      message: '',
      updatedAt: 5_000,
    });
    expect(retried.items[1]?.events.at(-1)).toEqual({
      status: 'queued',
      message: 'BATCH_ITEM_RETRY',
      at: 5_000,
    });
    // The originating snapshot is not mutated.
    expect(batch.items[1]?.status).toBe('failed');
  });

  it('drops the stale worker tab when retrying a terminal batch', () => {
    let batch = createTwoItemBatch();
    batch = updateBatchProgress(batch, { workerTabId: 42 }, 1_500);
    batch = completeCurrentItem(batch, 'submitted', '', 2_000);
    batch = completeCurrentItem(batch, 'failed', '', 3_000);
    expect(batch.workerTabId).toBe(42);

    const retried = retryItems(batch, ['batch-1:1'], 5_000);

    expect(retried).not.toHaveProperty('workerTabId');
  });

  it('can retry a stopped batch', () => {
    let batch = createTwoItemBatch();
    batch = completeCurrentItem(batch, 'submitted', 'COMMENT_SUBMITTED', 2_000);
    batch = stopBatch(batch, 3_000);
    expect(batch.status).toBe('stopped');

    const retried = retryItems(batch, ['batch-1:1'], 5_000);

    expect(retried).toMatchObject({ status: 'running', currentIndex: 1 });
    expect(retried.items[1]?.status).toBe('queued');
  });

  it('sets the cursor to the smallest retried index across multiple items', () => {
    let batch = createThreeItemBatch();
    batch = completeCurrentItem(batch, 'failed', 'A', 2_000);
    batch = completeCurrentItem(batch, 'submitted', 'B', 3_000);
    batch = completeCurrentItem(batch, 'no_form', 'C', 4_000);
    expect(batch.status).toBe('completed');

    const retried = retryItems(batch, ['batch-1:2', 'batch-1:0'], 5_000);

    expect(retried).toMatchObject({ status: 'running', currentIndex: 0 });
    expect(retried.items[0]?.status).toBe('queued');
    expect(retried.items[1]?.status).toBe('submitted');
    expect(retried.items[2]?.status).toBe('queued');
  });

  it('rejects retrying a running batch', () => {
    const batch = createTwoItemBatch();
    expect(() => retryItems(batch, ['batch-1:0'])).toThrow(
      'BATCH_RETRY_UNAVAILABLE'
    );
  });

  it('rejects retrying a paused batch', () => {
    const paused = pauseCurrentItem(
      createTwoItemBatch(),
      'login_required',
      '',
      2_000
    );
    expect(() => retryItems(paused, ['batch-1:0'])).toThrow(
      'BATCH_RETRY_UNAVAILABLE'
    );
  });

  it('rejects an empty id list', () => {
    let batch = createTwoItemBatch();
    batch = completeCurrentItem(batch, 'failed', 'A', 2_000);
    batch = completeCurrentItem(batch, 'failed', 'B', 3_000);
    expect(() => retryItems(batch, [])).toThrow('BATCH_ITEM_NOT_RETRYABLE');
  });

  it('rejects an unknown item id', () => {
    let batch = createTwoItemBatch();
    batch = completeCurrentItem(batch, 'failed', 'A', 2_000);
    batch = completeCurrentItem(batch, 'failed', 'B', 3_000);
    expect(() => retryItems(batch, ['batch-1:9'])).toThrow(
      'BATCH_ITEM_NOT_RETRYABLE'
    );
  });

  it('rejects retrying a non-retryable (submitted) item', () => {
    let batch = createTwoItemBatch();
    batch = completeCurrentItem(batch, 'submitted', 'A', 2_000);
    batch = completeCurrentItem(batch, 'failed', 'B', 3_000);
    expect(() => retryItems(batch, ['batch-1:0'])).toThrow(
      'BATCH_ITEM_NOT_RETRYABLE'
    );
  });

  it('advances past terminal items when a mid-list retry completes', () => {
    let batch = createThreeItemBatch();
    batch = completeCurrentItem(batch, 'failed', 'A', 2_000);
    batch = completeCurrentItem(batch, 'submitted', 'B', 3_000);
    batch = completeCurrentItem(batch, 'failed', 'C', 4_000);
    batch = retryItems(batch, ['batch-1:0'], 5_000);
    expect(batch).toMatchObject({ status: 'running', currentIndex: 0 });

    // The retried item finishes; the cursor must skip the already-terminal
    // items 1 and 2 and land the batch on 'completed'.
    const done = completeCurrentItem(batch, 'submitted', 'RETRY_OK', 6_000);

    expect(done).toMatchObject({ status: 'completed', currentIndex: 3 });
    expect(done.items.map((item) => item.status)).toEqual([
      'submitted',
      'submitted',
      'failed',
    ]);
    // Every invariant still holds after the skip-to-completion.
    expect(() => batchSnapshotSchema.parse(done)).not.toThrow();
  });

  it('keeps the normal sequential flow identical (no skip when next is queued)', () => {
    let batch = createThreeItemBatch();
    batch = completeCurrentItem(batch, 'submitted', 'A', 2_000);
    expect(batch).toMatchObject({ status: 'running', currentIndex: 1 });
    expect(batch.items[1]?.status).toBe('queued');
  });
});

describe('batch snapshot site provenance', () => {
  it('carries siteId and siteLabel when the input settings provide them', () => {
    const batch = createBatch({
      id: 'batch-site',
      targetText: 'https://blog.example/post',
      settings: { ...settings, siteId: 'site-9', siteLabel: 'Museimage' },
      now: 1_000,
    });

    expect(batch.settings).toMatchObject({
      siteId: 'site-9',
      siteLabel: 'Museimage',
      websiteUrl: 'https://product.example',
    });
    expect(() => batchSnapshotSchema.parse(batch)).not.toThrow();
  });

  it('omits provenance for a legacy settings snapshot and still parses', () => {
    const batch = createBatch({
      id: 'batch-legacy',
      targetText: 'https://blog.example/post',
      settings,
      now: 1_000,
    });

    expect(batch.settings).not.toHaveProperty('siteId');
    expect(batch.settings).not.toHaveProperty('siteLabel');
    expect(() => batchSnapshotSchema.parse(batch)).not.toThrow();
  });
});
