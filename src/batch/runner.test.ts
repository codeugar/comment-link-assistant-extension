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
    revealCommentForm: vi.fn(async () => true),
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
    now: () => now++,
    ...overrides,
  };
  return { deps, read: () => stored };
}

describe('batch runner', () => {
  it('finishes a target from the available DOM when loading never completes', async () => {
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
        url: 'https://blog.example/post',
        status: 'loading',
      })),
      now: () => 30_004,
    });

    for (let step = 0; step < 8; step += 1) {
      await advanceBatchStep(context.deps);
      if (context.read()?.status === 'completed') break;
    }

    expect(context.deps.analyzeTab).toHaveBeenCalledWith(7, 'batch-1');
    expect(context.deps.clickPreparedTabSubmission).toHaveBeenCalledOnce();
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [{ status: 'submitted' }],
    });
  });

  it('does not accept a different same-origin page from a loading redirect', async () => {
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
        url: 'https://blog.example/different-post',
        status: 'loading',
      })),
      now: () => 30_004,
    });

    await advanceBatchStep(context.deps);

    expect(context.deps.analyzeTab).not.toHaveBeenCalled();
    expect(context.deps.generateComment).not.toHaveBeenCalled();
    expect(context.read()?.items[0]).toMatchObject({
      status: 'failed',
      message: 'TARGET_PAGE_REDIRECT_UNSUPPORTED',
    });
  });

  it('does not analyze the old DOM while a different URL is pending', async () => {
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
        url: 'https://blog.example/post',
        pendingUrl: 'https://blog.example/login',
        status: 'loading',
      })),
      now: () => 30_004,
    });

    await advanceBatchStep(context.deps);

    expect(context.deps.analyzeTab).not.toHaveBeenCalled();
    expect(context.deps.generateComment).not.toHaveBeenCalled();
    expect(context.read()?.items[0]).toMatchObject({
      status: 'failed',
      message: 'TARGET_PAGE_LOAD_UNCONFIRMED',
    });
  });

  it('does not analyze the old DOM when the target URL is still pending', async () => {
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
        url: 'about:blank',
        pendingUrl: 'https://blog.example/post',
        status: 'complete',
      })),
      now: () => 4,
    });

    await advanceBatchStep(context.deps);
    await advanceBatchStep(context.deps);

    expect(context.deps.analyzeTab).not.toHaveBeenCalled();
    expect(context.read()?.items[0]).toMatchObject({
      status: 'opening',
      message: 'BATCH_TARGET_NAVIGATION_PENDING',
    });
  });

  it('retries a timed-out read-only analysis once on the same tab', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      { workerTabId: 7, item: { status: 'analyzing' } },
      3
    );
    const analyzeTab = vi
      .fn()
      .mockRejectedValueOnce(new Error('PAGE_COMMAND_TIMEOUT'))
      .mockResolvedValueOnce(analysis());
    const context = dependencies(batch, { analyzeTab });

    await advanceBatchStep(context.deps);

    expect(analyzeTab).toHaveBeenCalledTimes(2);
    expect(context.read()?.items[0]).toMatchObject({
      status: 'generating',
      message: 'COMMENT_GENERATION_READY',
    });
  });

  it('does not prepare or click during an unapproved page reload', async () => {
    let batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: {
          status: 'generating',
          analysis: analysis(),
          comment: prepared.comment,
        },
      },
      3
    );
    const loadingTab = vi.fn(async () => ({
      id: 7,
      url: 'https://blog.example/post',
      status: 'loading',
    }));
    const generating = dependencies(batch, {
      getWorkerTab: loadingTab,
      now: () => 4,
    });

    await advanceBatchStep(generating.deps);

    expect(generating.deps.prepareTabSubmission).not.toHaveBeenCalled();

    batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: { status: 'prepared', prepared },
      },
      3
    );
    const preparedContext = dependencies(batch, {
      getWorkerTab: loadingTab,
      now: () => 4,
    });

    await advanceBatchStep(preparedContext.deps);

    expect(
      preparedContext.deps.clickPreparedTabSubmission
    ).not.toHaveBeenCalled();
  });

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
    batch = completeCurrentItem(batch, 'submitted', 'COMMENT_SUBMITTED', 4);
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
        { status: 'submitted' },
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
      items: [{ status: 'submitted' }],
    });
    expect(context.deps.generateComment).toHaveBeenCalledTimes(1);
    expect(context.deps.clickPreparedTabSubmission).toHaveBeenCalledTimes(1);
    expect(
      context.read()?.items[0]?.events.map((event) => event.status)
    ).toEqual([
      'queued',
      'opening',
      'analyzing',
      'generating',
      'prepared',
      'click_dispatched',
      'verifying',
      'submitted',
    ]);
  });

  it('uses a confidently detected standard comment form without AI planning', async () => {
    const ready = analysis('ready');
    ready.probe = {
      snapshotId: 'snapshot-standard',
      url: ready.page.url,
      formCandidates: [
        {
          formId: 'form-1',
          tag: 'form',
          attributes: { id: 'commentform' },
          controlCandidateIds: ['control-1', 'control-2'],
        },
      ],
      controlCandidates: [
        {
          candidateId: 'control-1',
          formId: 'form-1',
          tag: 'textarea',
          type: 'textarea',
          attributes: { name: 'comment' },
          labels: ['Comment'],
          nearbyText: [],
          ancestorTokens: ['form#commentform'],
          requiredSignals: [],
          visible: true,
          enabled: true,
          hasValue: false,
        },
        {
          candidateId: 'control-2',
          formId: 'form-1',
          tag: 'button',
          type: 'submit',
          attributes: { type: 'submit' },
          labels: ['Submit Comment'],
          nearbyText: [],
          ancestorTokens: ['form#commentform'],
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
      analyzeTab: vi.fn(async () => ready),
    });

    await advanceBatchStep(context.deps);

    expect(context.deps.planCommentForm).not.toHaveBeenCalled();
    expect(context.read()?.items[0]).toMatchObject({
      status: 'generating',
      analysis: {
        form: { readiness: 'ready' },
      },
    });
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

  it('uses AI semantics once to reveal a localized hidden comment form', async () => {
    const hidden = analysis('not_found');
    hidden.form.message = 'COMMENT_FORM_NOT_FOUND';
    hidden.probe = {
      snapshotId: 'snapshot-hidden',
      url: hidden.page.url,
      formCandidates: [],
      controlCandidates: [
        {
          candidateId: 'control-1',
          formId: null,
          tag: 'div',
          type: 'button',
          attributes: { id: 'show-comment', class: 'btn write-comment-btn' },
          labels: [],
          nearbyText: ['Skriv kommentar'],
          ancestorTokens: ['section.responses'],
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
    let now = 1_000;
    const revealCommentForm = vi.fn(async () => {
      expect(context.read()?.items[0]).toMatchObject({
        status: 'opening',
        formRevealAttempted: true,
        message: 'COMMENT_FORM_REVEAL_DISPATCHED',
      });
      return true;
    });
    const context = dependencies(batch, {
      analyzeTab: vi.fn(async () => hidden),
      planCommentForm: vi.fn(
        async (): Promise<FormPlan> => ({
          schemaVersion: 1,
          snapshotId: 'snapshot-hidden',
          decision: 'reveal_form',
          formCandidateId: null,
          bindings: {},
          submitCandidateId: null,
          revealCandidateId: 'control-1',
          requiredRoles: [],
          uncertainties: [],
        })
      ),
      revealCommentForm,
      now: () => now,
    });

    await advanceBatchStep(context.deps);

    expect(revealCommentForm).toHaveBeenCalledWith(
      7,
      'snapshot-hidden',
      'control-1',
      'batch-1'
    );
    expect(context.read()?.items[0]).toMatchObject({
      status: 'opening',
      formRevealAttempted: true,
      message: 'COMMENT_FORM_REVEALED',
    });

    await advanceBatchStep(context.deps);
    expect(context.deps.analyzeTab).toHaveBeenCalledTimes(1);
    expect(context.read()?.items[0]).toMatchObject({ status: 'opening' });

    now += 601;
    await advanceBatchStep(context.deps);
    await advanceBatchStep(context.deps);

    expect(revealCommentForm).toHaveBeenCalledTimes(1);
    expect(context.read()?.items[0]).toMatchObject({
      status: 'no_form',
      formRevealAttempted: true,
    });
  });

  it('does not retry when a persisted form-reveal click has an unknown result', async () => {
    const hidden = analysis('not_found');
    hidden.probe = {
      snapshotId: 'snapshot-hidden',
      url: hidden.page.url,
      formCandidates: [],
      controlCandidates: [
        {
          candidateId: 'control-1',
          formId: null,
          tag: 'button',
          type: 'button',
          attributes: { id: 'show-comment' },
          labels: ['Escribe una respuesta'],
          nearbyText: [],
          ancestorTokens: [],
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
    const revealCommentForm = vi.fn(async () => {
      throw new Error('PAGE_FORM_REVEAL_RESULT_UNKNOWN');
    });
    const context = dependencies(batch, {
      analyzeTab: vi.fn(async () => hidden),
      planCommentForm: vi.fn(
        async (): Promise<FormPlan> => ({
          schemaVersion: 1,
          snapshotId: 'snapshot-hidden',
          decision: 'reveal_form',
          formCandidateId: null,
          bindings: {},
          submitCandidateId: null,
          revealCandidateId: 'control-1',
          requiredRoles: [],
          uncertainties: [],
        })
      ),
      revealCommentForm,
    });

    await advanceBatchStep(context.deps);
    await advanceBatchStep(context.deps);

    expect(revealCommentForm).toHaveBeenCalledTimes(1);
    expect(context.read()?.items[0]).toMatchObject({
      status: 'failed',
      formRevealAttempted: true,
      message: 'PAGE_FORM_REVEAL_RESULT_UNKNOWN',
    });
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

  it('uses a required website field discovered by deterministic analysis', async () => {
    const detected = analysis();
    detected.form.hasWebsiteField = true;
    detected.form.requiresWebsiteField = true;
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
          analysis: detected,
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
      expect.anything(),
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
    batch = completeCurrentItem(batch, 'submitted', 'COMMENT_SUBMITTED', 4);
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
          status: 'submitted',
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
    });

    await advanceBatchStep(context.deps);
    await advanceBatchStep(context.deps);

    expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
    expect(context.deps.verifyTabSubmission).toHaveBeenCalledTimes(1);
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [{ status: 'submitted', message: 'COMMENT_SUBMITTED' }],
    });
  });

  it('verifies once when post-submit navigation never finishes loading', async () => {
    const batch = updateBatchProgress(
      initialBatch(),
      {
        workerTabId: 7,
        item: { status: 'click_dispatched', prepared },
      },
      3
    );
    const context = dependencies(batch, {
      getWorkerTab: vi.fn(async () => ({
        id: 7,
        url: 'https://blog.example/post',
        status: 'loading',
      })),
      now: () => 30_004,
    });

    await advanceBatchStep(context.deps);
    await advanceBatchStep(context.deps);

    expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
    expect(context.deps.verifyTabSubmission).toHaveBeenCalledOnce();
    expect(context.read()?.items[0]).toMatchObject({ status: 'submitted' });
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
          status: 'failed',
          message: 'COMMENT_SUBMISSION_UNCONFIRMED',
        },
      ],
    });
  });

  it('treats a clicked but unconfirmed result as submitted without any re-fetch', async () => {
    const unconfirmed: PageSubmissionResult = {
      status: 'unknown',
      message: 'COMMENT_SUBMISSION_UNCONFIRMED',
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
      verifyTabSubmission: vi.fn(async () => unconfirmed),
    });

    await advanceBatchStep(context.deps);

    expect(context.deps.clickPreparedTabSubmission).not.toHaveBeenCalled();
    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [{ status: 'submitted', message: 'COMMENT_SUBMITTED' }],
    });
  });

  it('records an explicit validation error as a kept terminal result', async () => {
    const rejected: PageSubmissionResult = {
      status: 'validation_error',
      message: 'COMMENT_REJECTED',
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
      verifyTabSubmission: vi.fn(async () => rejected),
    });

    await advanceBatchStep(context.deps);

    expect(context.read()).toMatchObject({
      status: 'completed',
      items: [{ status: 'validation_error', message: 'COMMENT_REJECTED' }],
    });
  });

  it('processes a later same-host target after an earlier validation error', async () => {
    let batch = initialBatch(
      'https://blog.example/first\nhttps://www.blog.example/second'
    );
    batch = completeCurrentItem(
      batch,
      'validation_error',
      'COMMENT_REJECTED',
      3
    );
    const context = dependencies(batch);

    await advanceBatchStep(context.deps);

    expect(context.deps.createWorkerTab).toHaveBeenCalledWith(
      'https://www.blog.example/second',
      'batch-1'
    );
    expect(context.read()?.items[1]).toMatchObject({ status: 'opening' });
    expect(context.read()?.items[1]?.status).not.toBe('failed');
  });

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
    batch = completeCurrentItem(batch, 'submitted', '', 3);
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
      items: [{ status: 'submitted' }, { status: 'opening' }],
    });
  });
});
