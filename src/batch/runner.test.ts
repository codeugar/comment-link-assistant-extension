import type { FormPlan } from '@/api/form-planner';
import type {
  PageAnalysis,
  PageSubmissionResult,
  PreparedPageSubmission,
} from '@/page/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type BatchRunnerDependencies,
  advanceBatchStep,
  commentFingerprint,
} from './runner';
import {
  completeCurrentItem,
  createBatch,
  pauseCurrentItem,
  resumeBatch,
  updateBatchProgress,
} from './state';
import type { BatchSnapshot } from './types';

const prepared: PreparedPageSubmission = {
  fingerprint: 'A useful comment',
  comment: 'A useful comment',
  domToken: 'dom-token',
  baseline: { feedbackMessages: [], renderedComment: false },
  expected: {
    url: 'https://blog.example/post',
    editorLabel: 'Comment',
    submitLabel: 'Post comment',
    hasWebsiteField: true,
  },
};

function analysis(
  readiness: PageAnalysis['form']['readiness'] = 'ready'
): PageAnalysis {
  return {
    page: {
      url: 'https://blog.example/post',
      title: 'A thoughtful post',
      description: 'Post description',
      excerpt: 'Enough page context to generate a relevant reply.',
      language: 'en',
      hasWebsiteField: true,
    },
    form: {
      readiness,
      editorLabel: 'Comment',
      submitLabel: 'Post comment',
      hasNameField: true,
      hasEmailField: true,
      hasWebsiteField: true,
      message: readiness === 'ready' ? '' : readiness.toUpperCase(),
    },
  };
}

function initialBatch(targetText = 'https://blog.example/post'): BatchSnapshot {
  let batch = createBatch({
    id: 'batch-1',
    targetText,
    settings: {
      provider: 'deepseek',
      websiteUrl: 'https://product.example',
      displayName: 'Alex',
      email: 'alex@example.com',
      linkMode: 'prefer-website-field',
    },
    now: 1,
  });
  batch = updateBatchProgress(
    batch,
    {
      websiteProfile: {
        url: 'https://product.example/',
        title: 'Useful Product',
        description: 'A product that helps readers solve this problem.',
      },
    },
    2
  );
  return batch;
}

function dependencies(
  initial = initialBatch(),
  overrides: Partial<BatchRunnerDependencies> = {}
) {
  let stored: BatchSnapshot | null = initial;
  let now = 10;
  const published: PageSubmissionResult = {
    status: 'published',
    message: 'COMMENT_PUBLISHED',
    fingerprint: prepared.fingerprint,
    clickOccurred: true,
  };
  const deps: BatchRunnerDependencies = {
    getBatch: vi.fn(async () => stored),
    setBatch: vi.fn(async (batch) => {
      stored = batch;
      return batch;
    }),
    getProviderApiKeys: vi.fn(async () => ({
      deepseekApiKey: 'deepseek-key',
      kieApiKey: '',
    })),
    createWorkerTab: vi.fn(async (url) => ({
      id: 7,
      url,
      status: 'complete',
    })),
    getWorkerTab: vi.fn(async () => ({
      id: 7,
      url: 'https://blog.example/post',
      status: 'complete',
    })),
    navigateWorkerTab: vi.fn(async (tabId, url) => ({
      id: tabId,
      url,
      status: 'loading',
    })),
    analyzeTab: vi.fn(async () => analysis()),
    planCommentForm: vi.fn(
      async (_keys, input): Promise<FormPlan> => ({
        schemaVersion: 1,
        snapshotId: input.observation.snapshotId,
        decision: 'commentable',
        formCandidateId: 'form-1',
        bindings: { comment: 'control-1' },
        submitCandidateId: 'control-2',
        requiredRoles: ['comment'],
        uncertainties: [],
      })
    ),
    classifySubmissionOutcome: vi.fn(async () => ({
      status: 'unknown' as const,
      reason: 'COMMENT_SUBMISSION_UNCONFIRMED',
    })),
    generateComment: vi.fn(async () => 'A useful comment'),
    prepareTabSubmission: vi.fn(async () => ({
      ok: true as const,
      prepared,
    })),
    clickPreparedTabSubmission: vi.fn(async () => {
      expect(stored?.items[0]?.status).toBe('click_dispatched');
      return published;
    }),
    verifyTabSubmission: vi.fn(async () => published),
    isCommentPubliclyVisible: vi.fn(async () => true),
    now: () => now++,
    ...overrides,
  };
  return { deps, read: () => stored };
}

describe('batch runner', () => {
  it('adopts an HTTP to HTTPS canonical redirect before analysis', async () => {
    const canonicalUrl = 'https://blog.example/post';
    const batch = updateBatchProgress(
      initialBatch('http://blog.example/post'),
      {
        workerTabId: 7,
        item: {
          status: 'opening',
          message: 'BATCH_TARGET_NAVIGATION_PENDING',
        },
      },
      3
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => ({
        id: 7,
        url: canonicalUrl,
        status: 'complete',
      })),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()?.items[0]).toMatchObject({
      url: canonicalUrl,
      status: 'analyzing',
      message: '',
    });
    expect(context.deps.analyzeTab).not.toHaveBeenCalled();
  });

  it('adopts a canonical redirect that removes the www hostname prefix', async () => {
    const canonicalUrl = 'https://example.com/post';
    const batch = updateBatchProgress(
      initialBatch('https://www.example.com/post'),
      {
        workerTabId: 7,
        item: {
          status: 'opening',
          message: 'BATCH_TARGET_NAVIGATION_PENDING',
        },
      },
      3
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => ({
        id: 7,
        url: canonicalUrl,
        status: 'complete',
      })),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()?.items[0]).toMatchObject({
      url: canonicalUrl,
      status: 'analyzing',
      message: '',
    });
  });

  it('adopts a canonical redirect that adds the www hostname prefix', async () => {
    const canonicalUrl = 'https://www.example.com/post';
    const batch = updateBatchProgress(
      initialBatch('https://example.com/post'),
      {
        workerTabId: 7,
        item: {
          status: 'opening',
          message: 'BATCH_TARGET_NAVIGATION_PENDING',
        },
      },
      3
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => ({
        id: 7,
        url: canonicalUrl,
        status: 'complete',
      })),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()?.items[0]).toMatchObject({
      url: canonicalUrl,
      status: 'analyzing',
      message: '',
    });
  });

  it('adopts a same-path canonical redirect that only removes tracking query parameters', async () => {
    const canonicalUrl = 'https://blog.example/post?id=42';
    const batch = updateBatchProgress(
      initialBatch(
        'https://blog.example/post?id=42&utm_source=newsletter&fbclid=abc'
      ),
      {
        workerTabId: 7,
        item: {
          status: 'opening',
          message: 'BATCH_TARGET_NAVIGATION_PENDING',
        },
      },
      3
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => ({
        id: 7,
        url: canonicalUrl,
        status: 'complete',
      })),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()?.items[0]).toMatchObject({
      url: canonicalUrl,
      status: 'analyzing',
      message: '',
    });
  });

  it('does not submit the same canonical article twice', async () => {
    let batch = initialBatch(
      'http://example.com/post?utm_source=first\nhttps://www.example.com/post'
    );
    batch = updateBatchProgress(
      batch,
      {
        workerTabId: 7,
        item: {
          url: 'https://www.example.com/post',
          status: 'analyzing',
        },
      },
      3
    );
    batch = completeCurrentItem(batch, 'published', 'COMMENT_PUBLISHED', 4);
    batch = updateBatchProgress(
      batch,
      {
        item: {
          status: 'opening',
          message: 'BATCH_TARGET_NAVIGATION_PENDING',
        },
      },
      5
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => ({
        id: 7,
        url: 'https://www.example.com/post',
        status: 'complete',
      })),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [
        { status: 'published' },
        {
          status: 'failed',
          message: 'DUPLICATE_CANONICAL_TARGET',
        },
      ],
    });
    expect(context.deps.analyzeTab).not.toHaveBeenCalled();
    expect(context.deps.generateComment).not.toHaveBeenCalled();
  });

  it('does not adopt a redirect to a different path', async () => {
    const batch = updateBatchProgress(
      initialBatch('https://blog.example/post'),
      {
        workerTabId: 7,
        item: {
          status: 'opening',
          message: 'BATCH_TARGET_NAVIGATION_PENDING',
        },
      },
      3
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => ({
        id: 7,
        url: 'https://blog.example/different-post',
        status: 'complete',
      })),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()?.items[0]).toMatchObject({
      url: 'https://blog.example/post',
      status: 'failed',
      message: 'TARGET_PAGE_REDIRECT_UNSUPPORTED',
    });
  });

  it('pauses when a custom same-origin redirect renders a login gate', async () => {
    const batch = updateBatchProgress(
      initialBatch('https://blog.example/post'),
      {
        workerTabId: 7,
        item: {
          status: 'opening',
          message: 'BATCH_TARGET_NAVIGATION_PENDING',
        },
      },
      3
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => ({
        id: 7,
        url: 'https://blog.example/members-only',
        status: 'complete',
      })),
      analyzeTab: vi.fn(async () => analysis('login_required')),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()).toMatchObject({
      status: 'paused',
      items: [{ status: 'login_required' }],
    });
  });

  it('does not adopt a redirect that changes a non-tracking query parameter', async () => {
    const batch = updateBatchProgress(
      initialBatch('https://blog.example/post?id=42'),
      {
        workerTabId: 7,
        item: {
          status: 'opening',
          message: 'BATCH_TARGET_NAVIGATION_PENDING',
        },
      },
      3
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => ({
        id: 7,
        url: 'https://blog.example/post?id=99',
        status: 'complete',
      })),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()?.items[0]).toMatchObject({
      url: 'https://blog.example/post?id=42',
      status: 'failed',
      message: 'TARGET_PAGE_REDIRECT_UNSUPPORTED',
    });
  });

  it('pauses instead of adopting a redirect to an unrelated domain', async () => {
    const batch = updateBatchProgress(
      initialBatch('https://blog.example/post'),
      {
        workerTabId: 7,
        item: {
          status: 'opening',
          message: 'BATCH_TARGET_NAVIGATION_PENDING',
        },
      },
      3
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => ({
        id: 7,
        url: 'https://unrelated.example/post',
        status: 'complete',
      })),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()?.items[0]).toMatchObject({
      url: 'https://blog.example/post',
      status: 'login_required',
      message: 'TARGET_REDIRECT_REQUIRES_MANUAL_ACTION',
    });
  });

  it('runs one target through analysis, generation, submit, and completion', async () => {
    const context = dependencies();

    for (let step = 0; step < 12; step += 1) {
      await advanceBatchStep(context.deps);
      if (context.read()?.status === 'completed') break;
    }

    expect(context.read()).toMatchObject({
      status: 'completed',
      currentIndex: 1,
      items: [{ status: 'published' }],
    });
    expect(context.deps.generateComment).toHaveBeenCalledTimes(1);
    expect(context.deps.clickPreparedTabSubmission).toHaveBeenCalledTimes(1);
  });

  it('uses AI semantics to turn a localized candidate form into a ready plan', async () => {
    const localized = analysis('not_found');
    localized.form.message = 'COMMENT_FORM_NOT_FOUND';
    localized.probe = {
      snapshotId: 'snapshot-localized',
      url: localized.page.url,
      formCandidates: [
        {
          formId: 'form-1',
          tag: 'form',
          attributes: { class: 'vcard' },
          controlCandidateIds: ['control-1', 'control-2'],
        },
      ],
      controlCandidates: [
        {
          candidateId: 'control-1',
          formId: 'form-1',
          tag: 'textarea',
          type: 'textarea',
          attributes: { name: 'vText' },
          labels: ['Komentar'],
          nearbyText: [],
          ancestorTokens: ['form.vcard'],
          requiredSignals: ['ancestor-class:required'],
          visible: true,
          enabled: true,
          hasValue: false,
        },
        {
          candidateId: 'control-2',
          formId: 'form-1',
          tag: 'button',
          type: 'button',
          attributes: { type: 'button' },
          labels: [],
          nearbyText: ['Potvrdi'],
          ancestorTokens: ['form.vcard'],
          requiredSignals: [],
          visible: true,
          enabled: true,
          hasValue: false,
        },
      ],
    };
    const batch = updateBatchProgress(
      initialBatch(),
      { workerTabId: 7, item: { status: 'analyzing' } },
      3
    );
    const context = dependencies(batch, {
      analyzeTab: vi.fn(async () => localized),
    });

    await advanceBatchStep(context.deps);

    expect(context.deps.planCommentForm).toHaveBeenCalledTimes(1);
    expect(context.read()?.items[0]).toMatchObject({
      status: 'generating',
      analysis: {
        form: {
          readiness: 'ready',
          editorLabel: 'Komentar',
          submitLabel: 'Potvrdi',
        },
        formPlan: {
          snapshotId: 'snapshot-localized',
          bindings: { comment: 'control-1' },
          submitCandidateId: 'control-2',
        },
      },
    });
    expect(context.read()?.items[0]?.analysis?.probe).toBeUndefined();
  });

  it('uses a required website field even when inline placement was preferred', async () => {
    const planned = analysis();
    planned.formPlan = {
      schemaVersion: 1,
      snapshotId: 'snapshot-1',
      decision: 'commentable',
      formCandidateId: 'form-1',
      bindings: {
        comment: 'control-1',
        website: 'control-2',
      },
      submitCandidateId: 'control-3',
      requiredRoles: ['comment', 'website'],
      uncertainties: [],
    };
    let batch = initialBatch();
    batch = {
      ...batch,
      settings: { ...batch.settings, linkMode: 'inline' },
    };
    batch = updateBatchProgress(
      batch,
      {
        workerTabId: 7,
        item: {
          status: 'generating',
          analysis: planned,
          message: 'COMMENT_GENERATION_READY',
        },
      },
      3
    );
    const context = dependencies(batch);

    await advanceBatchStep(context.deps);
    await advanceBatchStep(context.deps);

    expect(context.deps.generateComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ linkMode: 'prefer-website-field' })
    );
    expect(context.deps.prepareTabSubmission).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ websiteUrl: 'https://product.example' }),
      expect.objectContaining({ formPlan: planned.formPlan }),
      'batch-1'
    );
  });

  it('rejects a generated comment already used earlier in the batch', async () => {
    let batch = initialBatch(
      'https://blog.example/first\nhttps://forum.example/second'
    );
    batch = updateBatchProgress(
      batch,
      {
        item: {
          status: 'generating',
          commentFingerprint: commentFingerprint('A useful comment'),
        },
      },
      3
    );
    batch = completeCurrentItem(batch, 'published', 'COMMENT_PUBLISHED', 4);
    const secondAnalysis = analysis();
    secondAnalysis.page.url = 'https://forum.example/second';
    batch = updateBatchProgress(
      batch,
      {
        item: {
          status: 'generating',
          analysis: secondAnalysis,
          message: 'COMMENT_GENERATION_READY',
        },
      },
      5
    );
    const context = dependencies(batch, {
      generateComment: vi.fn(async () => 'A useful comment'),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [
        {
          status: 'published',
          commentFingerprint: expect.any(String),
        },
        {
          status: 'failed',
          commentFingerprint: expect.any(String),
          message: 'DUPLICATE_COMMENT_GENERATED',
        },
      ],
    });
    expect(context.deps.prepareTabSubmission).not.toHaveBeenCalled();
    expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
  });

  it.each(['login_required', 'captcha_required'] as const)(
    'pauses on %s without stealing focus from the current page',
    async (readiness) => {
      const batch = updateBatchProgress(
        initialBatch(),
        { workerTabId: 7, item: { status: 'analyzing' } },
        3
      );
      const context = dependencies(batch, {
        analyzeTab: vi.fn(async () => analysis(readiness)),
      });

      await expect(advanceBatchStep(context.deps)).resolves.toBe('wait');

      expect(context.read()).toMatchObject({
        status: 'paused',
        currentIndex: 0,
        items: [{ status: readiness }],
      });
    }
  );

  it('returns to the queued target after manual login ends elsewhere on the same site', async () => {
    let batch = updateBatchProgress(
      initialBatch(),
      { workerTabId: 7, item: { status: 'analyzing' } },
      3
    );
    batch = pauseCurrentItem(batch, 'login_required', 'LOGIN_REQUIRED', 4);
    batch = resumeBatch(batch, 5);
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => ({
        id: 7,
        url: 'https://blog.example/account',
        status: 'complete',
      })),
    });

    await advanceBatchStep(context.deps);

    expect(context.deps.navigateWorkerTab).toHaveBeenCalledWith(
      7,
      'https://blog.example/post',
      'batch-1'
    );
    expect(context.deps.analyzeTab).not.toHaveBeenCalled();
    expect(context.read()?.items[0]).toMatchObject({
      status: 'opening',
      message: 'BATCH_TARGET_NAVIGATION_PENDING',
    });
  });

  it.each([
    ['https://blog.example/wp-login.php', 'login_required'],
    ['https://identity.example/oauth/authorize', 'login_required'],
    ['https://blog.example/register', 'login_required'],
    ['https://blog.example/create-account', 'login_required'],
    ['https://blog.example/challenge/captcha', 'captcha_required'],
  ] as const)(
    'pauses directly when target navigation reaches the manual gate %s',
    async (redirectUrl, expectedStatus) => {
      const batch = updateBatchProgress(
        initialBatch(),
        {
          workerTabId: 7,
          item: {
            status: 'opening',
            message: 'BATCH_TARGET_NAVIGATION_PENDING',
          },
        },
        3
      );
      const context = dependencies(batch, {
        getWorkerTab: vi.fn(async () => ({
          id: 7,
          url: redirectUrl,
          status: 'complete',
        })),
      });

      await advanceBatchStep(context.deps);

      expect(context.read()).toMatchObject({
        status: 'paused',
        items: [{ status: expectedStatus }],
      });
      expect(context.deps.analyzeTab).not.toHaveBeenCalled();
    }
  );

  it('recovers after a dispatched click by verifying without clicking again', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: { status: 'click_dispatched', prepared },
      },
      3
    );
    const submittedNotVisible: PageSubmissionResult = {
      status: 'submitted_not_visible',
      message: 'COMMENT_SUBMITTED_NOT_VISIBLE',
      fingerprint: prepared.fingerprint,
      clickOccurred: true,
    };
    const context = dependencies(batch, {
      verifyTabSubmission: vi.fn(async () => submittedNotVisible),
      isCommentPubliclyVisible: vi.fn(async () => false),
    });

    await advanceBatchStep(context.deps);
    await advanceBatchStep(context.deps);

    expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
    expect(context.deps.verifyTabSubmission).toHaveBeenCalledTimes(1);
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [{ status: 'submitted_not_visible' }],
    });
  });

  it('records an unconfirmed click error once and continues without retrying', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: {
          status: 'prepared',
          analysis: analysis(),
          comment: prepared.comment,
          prepared,
        },
      },
      3
    );
    const context = dependencies(batch, {
      clickPreparedTabSubmission: vi.fn(async () => {
        throw new Error('SCRIPT_FAILED_AFTER_CLICK_BOUNDARY');
      }),
    });

    await advanceBatchStep(context.deps);

    expect(context.deps.clickPreparedTabSubmission).toHaveBeenCalledTimes(1);
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [
        {
          status: 'unknown',
          message: 'COMMENT_SUBMISSION_UNCONFIRMED',
        },
      ],
    });
  });

  it('rejects a comment that is visible only in the submitting session', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: { status: 'verifying', prepared },
      },
      3
    );
    const context = dependencies(batch, {
      isCommentPubliclyVisible: vi.fn(async () => false),
    });

    await advanceBatchStep(context.deps);

    expect(context.deps.isCommentPubliclyVisible).toHaveBeenCalledWith(
      prepared.expected.url,
      prepared.fingerprint
    );
    expect(context.deps.setBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ status: 'checking_public' })],
      })
    );
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [
        {
          status: 'submitted_not_visible',
          message: 'COMMENT_SUBMITTED_NOT_VISIBLE',
        },
      ],
    });
  });

  it('keeps an accepted comment when the ordinary public page contains it', async () => {
    const accepted: PageSubmissionResult = {
      status: 'submitted_not_visible',
      message: 'COMMENT_SUBMITTED_NOT_VISIBLE',
      fingerprint: prepared.fingerprint,
      clickOccurred: true,
    };
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: { status: 'verifying', prepared },
      },
      3
    );
    const context = dependencies(batch, {
      verifyTabSubmission: vi.fn(async () => accepted),
      isCommentPubliclyVisible: vi.fn(async () => true),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [{ status: 'published', message: 'COMMENT_PUBLISHED' }],
    });
  });

  it('recovers an interrupted anonymous public visibility check', async () => {
    let batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: { status: 'verifying', prepared },
      },
      3
    );
    batch = updateBatchProgress(
      batch,
      {
        item: {
          status: 'checking_public',
          message: 'PUBLIC_CHECK_ACCEPTED',
        },
      },
      4
    );
    const context = dependencies(batch, {
      isCommentPubliclyVisible: vi.fn(async () => false),
    });

    await advanceBatchStep(context.deps);

    expect(context.deps.isCommentPubliclyVisible).toHaveBeenCalledWith(
      prepared.expected.url,
      prepared.fingerprint
    );
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [{ status: 'submitted_not_visible' }],
    });
  });

  it('skips later targets from a site rejected by an earlier result', async () => {
    let batch = initialBatch(
      'https://blog.example/first\nhttps://www.blog.example/second'
    );
    batch = completeCurrentItem(
      batch,
      'submitted_not_visible',
      'COMMENT_SUBMITTED_NOT_VISIBLE',
      3
    );
    const context = dependencies(batch);

    await advanceBatchStep(context.deps);

    expect(context.deps.createWorkerTab).not.toHaveBeenCalled();
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [
        { status: 'submitted_not_visible' },
        { status: 'failed', message: 'SITE_REJECTED_BY_PRIOR_RESULT' },
      ],
    });
  });

  it('publishes an otherwise unknown result when the ordinary public page contains it', async () => {
    const unknownResult = {
      status: 'unknown' as const,
      message: 'COMMENT_SUBMISSION_UNCONFIRMED',
      fingerprint: prepared.fingerprint,
      clickOccurred: true,
      verificationObservation: {
        url: 'https://blog.example/post',
        language: 'en',
        feedbackMessages: [],
        editorCleared: false,
        renderedCommentAdded: false,
      },
    } satisfies PageSubmissionResult;
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: { status: 'verifying', prepared },
      },
      3
    );
    const context = dependencies(batch, {
      verifyTabSubmission: vi.fn(async () => unknownResult),
      isCommentPubliclyVisible: vi.fn(async () => true),
    });

    await advanceBatchStep(context.deps);

    expect(context.deps.classifySubmissionOutcome).not.toHaveBeenCalled();
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [{ status: 'published', message: 'COMMENT_PUBLISHED' }],
    });
  });

  it.each([
    ['submitted_not_visible', 'submitted_not_visible'],
    ['validation_error', 'validation_error'],
  ] as const)(
    'classifies an observed unknown submission as %s without clicking again',
    async (classifiedStatus, expectedStatus) => {
      const observation = {
        url: 'https://blog.example/post',
        language: 'sr',
        feedbackMessages: ['Vaš komentar čeka odobrenje.'],
        editorCleared: true,
        renderedCommentAdded: false,
      };
      const unknownResult = {
        status: 'unknown' as const,
        message: 'COMMENT_SUBMISSION_UNCONFIRMED',
        fingerprint: prepared.fingerprint,
        clickOccurred: true,
        verificationObservation: observation,
      } satisfies PageSubmissionResult;
      const batch = updateBatchProgress(
        initialBatch(),
        {
          workerTabId: 7,
          item: { status: 'verifying', prepared },
        },
        3
      );
      const classifySubmissionOutcome = vi.fn(async () => ({
        status: classifiedStatus,
        reason: `AI_${classifiedStatus.toUpperCase()}`,
      }));
      const context = dependencies(batch, {
        verifyTabSubmission: vi.fn(async () => unknownResult),
        classifySubmissionOutcome,
        isCommentPubliclyVisible: vi.fn(async () => false),
      });

      await advanceBatchStep(context.deps);

      expect(classifySubmissionOutcome).toHaveBeenCalledTimes(1);
      expect(classifySubmissionOutcome).toHaveBeenCalledWith(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { provider: 'deepseek', observation }
      );
      expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
      expect(context.read()).toMatchObject({
        status: 'completed',
        items: [
          {
            status: expectedStatus,
            message:
              classifiedStatus === 'submitted_not_visible'
                ? 'COMMENT_SUBMITTED_NOT_VISIBLE'
                : `AI_${classifiedStatus.toUpperCase()}`,
          },
        ],
      });
    }
  );

  it('completes an AI-classified unknown submission without clicking again', async () => {
    const observation = {
      url: 'https://blog.example/post',
      language: 'sr',
      feedbackMessages: ['Nepoznat odgovor.'],
      editorCleared: true,
      renderedCommentAdded: false,
    };
    const unknownResult = {
      status: 'unknown' as const,
      message: 'COMMENT_SUBMISSION_UNCONFIRMED',
      fingerprint: prepared.fingerprint,
      clickOccurred: true,
      verificationObservation: observation,
    } satisfies PageSubmissionResult;
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: { status: 'verifying', prepared },
      },
      3
    );
    const classifySubmissionOutcome = vi.fn(async () => ({
      status: 'unknown' as const,
      reason: 'AI_STILL_UNCERTAIN',
    }));
    const context = dependencies(batch, {
      verifyTabSubmission: vi.fn(async () => unknownResult),
      classifySubmissionOutcome,
      isCommentPubliclyVisible: vi.fn(async () => false),
    });

    await advanceBatchStep(context.deps);

    expect(classifySubmissionOutcome).toHaveBeenCalledTimes(1);
    expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [
        {
          status: 'unknown',
          message: 'COMMENT_SUBMISSION_UNCONFIRMED',
        },
      ],
    });
  });

  it('does not retry when an AI validation reason matches an internal recovery code', async () => {
    const unknownResult = {
      status: 'unknown' as const,
      message: 'COMMENT_SUBMISSION_UNCONFIRMED',
      fingerprint: prepared.fingerprint,
      clickOccurred: true,
      verificationObservation: {
        url: 'https://blog.example/post',
        language: 'sr',
        feedbackMessages: ['Unos nije prihvaćen.'],
        editorCleared: false,
        renderedCommentAdded: false,
      },
    } satisfies PageSubmissionResult;
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: { status: 'verifying', prepared },
      },
      3
    );
    const context = dependencies(batch, {
      verifyTabSubmission: vi.fn(async () => unknownResult),
      classifySubmissionOutcome: vi.fn(async () => ({
        status: 'validation_error' as const,
        reason: 'LINK_PLACEMENT_CHANGED',
      })),
      isCommentPubliclyVisible: vi.fn(async () => false),
    });

    await advanceBatchStep(context.deps);

    expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [
        {
          status: 'validation_error',
          message: 'LINK_PLACEMENT_CHANGED',
        },
      ],
    });
  });

  it('completes an unknown submission when AI classification fails', async () => {
    const unknownResult = {
      status: 'unknown' as const,
      message: 'COMMENT_SUBMISSION_UNCONFIRMED',
      fingerprint: prepared.fingerprint,
      clickOccurred: true,
      verificationObservation: {
        url: 'https://blog.example/post',
        language: 'sr',
        feedbackMessages: ['Nepoznat odgovor.'],
        editorCleared: true,
        renderedCommentAdded: false,
      },
    } satisfies PageSubmissionResult;
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: { status: 'verifying', prepared },
      },
      3
    );
    const classifySubmissionOutcome = vi.fn(async () => {
      throw new Error('CLASSIFIER_UNAVAILABLE');
    });
    const context = dependencies(batch, {
      verifyTabSubmission: vi.fn(async () => unknownResult),
      classifySubmissionOutcome,
      isCommentPubliclyVisible: vi.fn(async () => false),
    });

    await advanceBatchStep(context.deps);

    expect(classifySubmissionOutcome).toHaveBeenCalledTimes(1);
    expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [
        {
          status: 'unknown',
          message: 'COMMENT_SUBMISSION_UNCONFIRMED',
        },
      ],
    });
  });

  it.each([
    ['not clicked', false, true],
    ['missing observation', true, false],
  ] as const)(
    'does not classify an unknown submission when it was %s',
    async (_case, clickOccurred, includeObservation) => {
      const unknownResult = {
        status: 'unknown' as const,
        message: 'COMMENT_SUBMISSION_UNCONFIRMED',
        fingerprint: prepared.fingerprint,
        clickOccurred,
        ...(includeObservation
          ? {
              verificationObservation: {
                url: 'https://blog.example/post',
                language: 'sr',
                feedbackMessages: ['Nepoznat odgovor.'],
                editorCleared: true,
                renderedCommentAdded: false,
              },
            }
          : {}),
      } satisfies PageSubmissionResult;
      const batch = updateBatchProgress(
        initialBatch(),
        {
          workerTabId: 7,
          item: { status: 'verifying', prepared },
        },
        3
      );
      const classifySubmissionOutcome = vi.fn();
      const context = dependencies(batch, {
        verifyTabSubmission: vi.fn(async () => unknownResult),
        classifySubmissionOutcome,
        isCommentPubliclyVisible: vi.fn(async () => false),
      });

      await advanceBatchStep(context.deps);

      expect(classifySubmissionOutcome).not.toHaveBeenCalled();
      expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
      expect(context.read()).toMatchObject({
        status: 'completed',
        items: [{ status: 'unknown' }],
      });
    }
  );

  it('pauses on a post-submit login redirect and resumes by verifying the same item', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: { status: 'click_dispatched', prepared },
      },
      3
    );
    const getWorkerTab = vi
      .fn()
      .mockResolvedValueOnce({
        id: 7,
        url: 'https://blog.example/wp-login.php',
        status: 'complete',
      })
      .mockResolvedValue({
        id: 7,
        url: 'https://blog.example/post',
        status: 'complete',
      });
    const context = dependencies(batch, { getWorkerTab });

    await advanceBatchStep(context.deps);
    expect(context.read()).toMatchObject({
      status: 'paused',
      items: [{ status: 'login_required', prepared: expect.any(Object) }],
    });

    await context.deps.setBatch(resumeBatch(context.read() as BatchSnapshot));
    expect(context.read()?.items[0]).toMatchObject({
      status: 'opening',
      message: 'BATCH_RESUME_VERIFICATION_REQUIRED',
    });
    await advanceBatchStep(context.deps);
    expect(context.read()?.items[0]).toMatchObject({ status: 'verifying' });
    expect(context.deps.analyzeTab).not.toHaveBeenCalled();
    expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
  });

  it('pauses when a post-submit custom same-origin redirect renders a login gate', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: { status: 'click_dispatched', prepared },
      },
      3
    );
    const loginAnalysis = analysis('login_required');
    loginAnalysis.page.url = 'https://blog.example/members-only';
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => ({
        id: 7,
        url: loginAnalysis.page.url,
        status: 'complete',
      })),
      analyzeTab: vi.fn(async () => loginAnalysis),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()).toMatchObject({
      status: 'paused',
      items: [{ status: 'login_required', prepared: expect.any(Object) }],
    });
    expect(context.deps.verifyTabSubmission).not.toHaveBeenCalled();
  });

  it('re-prepares after a CAPTCHA appears before the click occurs', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: {
          status: 'prepared',
          analysis: analysis(),
          comment: 'A useful comment',
          prepared,
        },
      },
      3
    );
    const preClickGate = {
      status: 'captcha_required' as const,
      message: 'CAPTCHA_REQUIRED',
      fingerprint: prepared.fingerprint,
      clickOccurred: false,
    };
    const context = dependencies(batch, {
      clickPreparedTabSubmission: vi.fn(async () => preClickGate),
    });

    await advanceBatchStep(context.deps);
    expect(context.read()).toMatchObject({
      status: 'paused',
      items: [{ status: 'captcha_required', prepared: null }],
    });

    await context.deps.setBatch(resumeBatch(context.read() as BatchSnapshot));
    expect(context.read()?.items[0]).toMatchObject({
      status: 'opening',
      message: 'BATCH_RESUME_TARGET_REQUIRED',
      comment: 'A useful comment',
    });
  });

  it('does not repeat a generation POST left in an uncertain state', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: {
          status: 'generating',
          analysis: analysis(),
          message: 'COMMENT_GENERATION_REQUESTED',
        },
      },
      3
    );
    const context = dependencies(batch);

    await advanceBatchStep(context.deps);

    expect(context.deps.generateComment).not.toHaveBeenCalled();
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [
        {
          status: 'failed',
          message: 'COMMENT_GENERATION_STATE_UNCONFIRMED',
        },
      ],
    });
  });

  it('reopens a missing worker tab without regenerating a finished comment', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: {
          status: 'generating',
          analysis: analysis(),
          comment: 'A useful comment',
        },
      },
      3
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => null),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()).toMatchObject({
      status: 'running',
      items: [{ status: 'opening', comment: 'A useful comment' }],
    });
    expect(context.read()).not.toHaveProperty('workerTabId');
    expect(context.deps.generateComment).not.toHaveBeenCalled();
    expect(context.deps.prepareTabSubmission).not.toHaveBeenCalled();
  });

  it('does not dispatch a prepared click to a missing worker tab', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: {
          status: 'prepared',
          analysis: analysis(),
          comment: 'A useful comment',
          prepared,
        },
      },
      3
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => null),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()).toMatchObject({
      status: 'running',
      items: [
        {
          status: 'opening',
          comment: 'A useful comment',
          prepared: null,
        },
      ],
    });
    expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'reanalyzes and regenerates when website-field availability changes to %s',
    async (hasWebsiteField) => {
      const originalAnalysis = analysis();
      originalAnalysis.form.hasWebsiteField = !hasWebsiteField;
      originalAnalysis.page.hasWebsiteField = !hasWebsiteField;
      const batch = updateBatchProgress(
        initialBatch(),
        {
          workerTabId: 7,
          item: {
            status: 'generating',
            analysis: originalAnalysis,
            comment: 'A generated comment',
          },
        },
        3
      );
      const context = dependencies(batch, {
        prepareTabSubmission: vi.fn(async () => ({
          ok: false as const,
          result: {
            status: 'validation_error' as const,
            message: 'LINK_PLACEMENT_CHANGED',
            fingerprint: 'A generated comment',
            clickOccurred: false,
          },
        })),
      });

      await expect(advanceBatchStep(context.deps)).resolves.toBe('continue');

      expect(context.read()?.items[0]).toMatchObject({
        status: 'analyzing',
        analysis: null,
        comment: null,
        prepared: null,
        message: 'LINK_PLACEMENT_CHANGED',
      });
      expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
    }
  );

  it('reanalyzes once when an AI-planned DOM snapshot is no longer live', async () => {
    const plannedAnalysis = analysis();
    plannedAnalysis.formPlan = {
      schemaVersion: 1,
      snapshotId: 'snapshot-old',
      decision: 'commentable',
      formCandidateId: 'form-1',
      bindings: { comment: 'control-1' },
      submitCandidateId: 'control-2',
      requiredRoles: ['comment'],
      uncertainties: [],
    };
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: {
          status: 'generating',
          analysis: plannedAnalysis,
          comment: 'A generated comment',
        },
      },
      3
    );
    const context = dependencies(batch, {
      prepareTabSubmission: vi.fn(async () => ({
        ok: false as const,
        result: {
          status: 'validation_error' as const,
          message: 'PAGE_CHANGED_SINCE_GENERATION',
          fingerprint: 'A generated comment',
          clickOccurred: false,
        },
      })),
    });

    await expect(advanceBatchStep(context.deps)).resolves.toBe('continue');

    expect(context.read()?.items[0]).toMatchObject({
      status: 'analyzing',
      analysis: null,
      comment: null,
      prepared: null,
      formPlanRefreshes: 1,
      message: 'PAGE_CHANGED_SINCE_GENERATION',
    });
    expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
  });

  it('does not click when a stop request arrives at the persisted click boundary', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: {
          status: 'prepared',
          analysis: analysis(),
          comment: 'A useful comment',
          prepared,
        },
      },
      3
    );
    const context = dependencies(batch);

    await advanceBatchStep(
      context.deps,
      () => context.read()?.items[0]?.status === 'click_dispatched'
    );

    expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
    expect(context.read()?.items[0]).toMatchObject({
      status: 'prepared',
      message: 'BATCH_STOP_REQUESTED',
    });
  });

  it('reopens a missing tab before analyzing the target', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      { workerTabId: 7, item: { status: 'analyzing' } },
      3
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => null),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()).toMatchObject({
      status: 'running',
      items: [{ status: 'opening' }],
    });
    expect(context.deps.analyzeTab).not.toHaveBeenCalled();
  });

  it('reuses the worker tab when advancing to the next target', async () => {
    let batch = createBatch({
      id: 'batch-2',
      targetText: 'https://blog.example/first\nhttps://forum.example/second',
      settings: initialBatch().settings,
      now: 1,
    });
    batch = updateBatchProgress(batch, { workerTabId: 7 }, 2);
    batch = completeCurrentItem(batch, 'published', '', 3);
    const context = dependencies(batch);

    await advanceBatchStep(context.deps);

    expect(context.deps.createWorkerTab).not.toHaveBeenCalled();
    expect(context.deps.navigateWorkerTab).toHaveBeenCalledWith(
      7,
      'https://forum.example/second',
      'batch-2'
    );
    expect(context.read()).toMatchObject({
      currentIndex: 1,
      items: [{ status: 'published' }, { status: 'opening' }],
    });
  });
});
