import {
  type GenerateCommentInput,
  type PlanCommentFormInput,
  classifySubmissionOutcome,
  generateComment,
  planCommentForm,
} from '@/api/client';
import { fetchPublicPageContainsFingerprint } from '@/page/public-visibility';
import {
  applyFormPlan,
  buildFormPlanningObservation,
  hasPlausibleCommentControls,
} from '@/page/semantics';
import type {
  PageAnalysis,
  PageSubmissionExpectation,
  PageSubmissionInput,
  PageSubmissionPreparation,
  PageSubmissionResult,
  PreparedPageSubmission,
} from '@/page/types';
import {
  assertWorkerTabOwnership,
  createOwnedWorkerTab,
  getOwnedWorkerTab,
  updateOwnedWorkerTab,
} from '@/runtime/owned-worker-tab';
import {
  analyzeTab,
  clickPreparedTabSubmission,
  prepareTabSubmission,
  revealCommentFormTab,
  verifyTabSubmission,
} from '@/runtime/page-commands';
import { getBatch, setBatch } from '@/storage/batch';
import { getProviderApiKeys } from '@/storage/settings';
import type { ProviderApiKeys } from '@/types';
import {
  completeCurrentItem,
  pauseCurrentItem,
  updateBatchProgress,
} from './state';
import type { BatchItem, BatchSnapshot } from './types';

const GENERATION_READY = 'COMMENT_GENERATION_READY';
const GENERATION_REQUESTED = 'COMMENT_GENERATION_REQUESTED';
const TARGET_NAVIGATION_PENDING = 'BATCH_TARGET_NAVIGATION_PENDING';
const RESUME_TARGET_REQUIRED = 'BATCH_RESUME_TARGET_REQUIRED';
const RESUME_VERIFICATION_REQUIRED = 'BATCH_RESUME_VERIFICATION_REQUIRED';
const VERIFICATION_NAVIGATION_PENDING = 'BATCH_VERIFICATION_NAVIGATION_PENDING';
const PARTIAL_PAGE_READY = 'BATCH_PARTIAL_PAGE_READY';
const PUBLIC_CHECK_ACCEPTED = 'PUBLIC_CHECK_ACCEPTED';
const PUBLIC_CHECK_UNKNOWN = 'PUBLIC_CHECK_UNKNOWN';
const TARGET_LOAD_GRACE_MS = 30_000;

export interface WorkerTab {
  id: number;
  url?: string;
  pendingUrl?: string;
  status?: string;
}

export interface BatchRunnerDependencies {
  getBatch(): Promise<BatchSnapshot | null>;
  setBatch(batch: BatchSnapshot): Promise<BatchSnapshot>;
  getProviderApiKeys(): Promise<ProviderApiKeys>;
  createWorkerTab(url: string, batchId: string): Promise<WorkerTab>;
  getWorkerTab(tabId: number, batchId: string): Promise<WorkerTab | null>;
  navigateWorkerTab(
    tabId: number,
    url: string,
    batchId: string
  ): Promise<WorkerTab | null>;
  analyzeTab(tabId: number, batchId: string): Promise<PageAnalysis>;
  revealCommentForm(
    tabId: number,
    snapshotId: string,
    candidateId: string,
    batchId: string
  ): Promise<boolean>;
  generateComment(
    keys: ProviderApiKeys,
    input: GenerateCommentInput
  ): Promise<string>;
  planCommentForm(
    keys: ProviderApiKeys,
    input: PlanCommentFormInput
  ): ReturnType<typeof planCommentForm>;
  classifySubmissionOutcome: typeof classifySubmissionOutcome;
  prepareTabSubmission(
    tabId: number,
    input: PageSubmissionInput,
    target: PageSubmissionExpectation,
    batchId: string
  ): Promise<PageSubmissionPreparation>;
  clickPreparedTabSubmission(
    tabId: number,
    prepared: PreparedPageSubmission,
    batchId: string
  ): Promise<PageSubmissionResult>;
  verifyTabSubmission(
    tabId: number,
    prepared: Pick<PreparedPageSubmission, 'fingerprint' | 'baseline'>,
    expectedUrl: string,
    batchId: string
  ): Promise<PageSubmissionResult>;
  isCommentPubliclyVisible(url: string, fingerprint: string): Promise<boolean>;
  now(): number;
}

export type BatchStepResult = 'continue' | 'wait';

const defaultDependencies: BatchRunnerDependencies = {
  getBatch,
  setBatch,
  getProviderApiKeys,
  async createWorkerTab(url, batchId) {
    const tab = await createOwnedWorkerTab(batchId, url);
    return {
      id: tab.id,
      url: tab.url,
      pendingUrl: tab.pendingUrl,
      status: tab.status,
    };
  },
  async getWorkerTab(tabId, batchId) {
    const tab = await getOwnedWorkerTab(batchId, tabId);
    if (!tab || typeof tab.id !== 'number') return null;
    return {
      id: tab.id,
      url: tab.url,
      pendingUrl: tab.pendingUrl,
      status: tab.status,
    };
  },
  async navigateWorkerTab(tabId, url, batchId) {
    const tab = await updateOwnedWorkerTab(batchId, tabId, { url });
    if (!tab || typeof tab.id !== 'number') return null;
    return {
      id: tab.id,
      url: tab.url,
      pendingUrl: tab.pendingUrl,
      status: tab.status,
    };
  },
  async analyzeTab(tabId, batchId) {
    await assertWorkerTabOwnership(batchId, tabId);
    return analyzeTab(tabId);
  },
  async revealCommentForm(tabId, snapshotId, candidateId, batchId) {
    await assertWorkerTabOwnership(batchId, tabId);
    return revealCommentFormTab(tabId, snapshotId, candidateId);
  },
  generateComment,
  planCommentForm,
  classifySubmissionOutcome,
  async prepareTabSubmission(tabId, input, target, batchId) {
    await assertWorkerTabOwnership(batchId, tabId);
    return prepareTabSubmission(tabId, input, target);
  },
  async clickPreparedTabSubmission(tabId, prepared, batchId) {
    await assertWorkerTabOwnership(batchId, tabId);
    return clickPreparedTabSubmission(tabId, prepared);
  },
  async verifyTabSubmission(tabId, prepared, expectedUrl, batchId) {
    await assertWorkerTabOwnership(batchId, tabId);
    return verifyTabSubmission(tabId, prepared, expectedUrl);
  },
  isCommentPubliclyVisible: fetchPublicPageContainsFingerprint,
  now: Date.now,
};

function currentItem(batch: BatchSnapshot): BatchItem {
  const item = batch.items[batch.currentIndex];
  if (!item) throw new Error('BATCH_CURRENT_ITEM_MISSING');
  return item;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'UNKNOWN_ERROR';
}

export function commentFingerprint(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${normalized.length.toString(16)}-${(first >>> 0).toString(16)}-${(
    second >>> 0
  ).toString(16)}`;
}

function afterTerminal(batch: BatchSnapshot): BatchStepResult {
  return batch.status === 'running' ? 'continue' : 'wait';
}

function tabLocation(tab: WorkerTab): string {
  return tab.pendingUrl || tab.url || '';
}

function canUsePartialPage(item: BatchItem, tab: WorkerTab): boolean {
  return (
    item.partialPageAllowed === true &&
    !tab.pendingUrl &&
    Boolean(tab.url) &&
    isSamePage(tab.url ?? '', item.url)
  );
}

function hasSameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function isSamePage(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    const comparablePath = (pathname: string) =>
      pathname === '/' ? pathname : pathname.replace(/\/+$/, '');
    return (
      leftUrl.origin === rightUrl.origin &&
      comparablePath(leftUrl.pathname) === comparablePath(rightUrl.pathname) &&
      leftUrl.search === rightUrl.search
    );
  } catch {
    return false;
  }
}

function isSafeCanonicalRedirect(left: string, right: string): boolean {
  try {
    const source = new URL(left);
    const target = new URL(right);
    const comparablePath = (pathname: string) =>
      pathname === '/' ? pathname : pathname.replace(/\/+$/, '');
    const comparableHostname = (hostname: string) =>
      hostname.replace(/^www\./, '');
    const safeProtocol =
      source.protocol === target.protocol ||
      (source.protocol === 'http:' && target.protocol === 'https:');
    return (
      safeProtocol &&
      comparableHostname(source.hostname) ===
        comparableHostname(target.hostname) &&
      source.port === target.port &&
      source.username === target.username &&
      source.password === target.password &&
      comparablePath(source.pathname) === comparablePath(target.pathname) &&
      removesOnlyTrackingQueryParameters(source, target)
    );
  } catch {
    return false;
  }
}

function removesOnlyTrackingQueryParameters(source: URL, target: URL): boolean {
  const remaining = Array.from(source.searchParams.entries());
  for (const entry of target.searchParams.entries()) {
    const index = remaining.findIndex(
      ([key, value]) => key === entry[0] && value === entry[1]
    );
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return remaining.every(([key]) => isTrackingQueryParameter(key));
}

function isTrackingQueryParameter(key: string): boolean {
  return (
    /^utm_/i.test(key) ||
    [
      '_ga',
      '_gl',
      'dclid',
      'fbclid',
      'gbraid',
      'gclid',
      'mc_cid',
      'mc_eid',
      'msclkid',
      'wbraid',
    ].includes(key.toLowerCase())
  );
}

function canonicalPageUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

function canonicalTargetKey(value: string): string {
  const url = new URL(value);
  url.hash = '';
  for (const key of Array.from(url.searchParams.keys())) {
    if (isTrackingQueryParameter(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  const hostname = url.hostname.replace(/^www\./i, '');
  const pathname =
    url.pathname === '/' ? '/' : url.pathname.replace(/\/+$/, '');
  return `${hostname}${url.port ? `:${url.port}` : ''}${pathname}${url.search}`;
}

function hasAttemptedCanonicalTarget(
  batch: BatchSnapshot,
  resolvedUrl: string
): boolean {
  const attemptedStatuses = new Set([
    'published',
    'submitted_not_visible',
    'unknown',
  ]);
  const key = canonicalTargetKey(resolvedUrl);
  return batch.items
    .slice(0, batch.currentIndex)
    .some(
      (item) =>
        attemptedStatuses.has(item.status) &&
        canonicalTargetKey(item.url) === key
    );
}

function targetSiteKey(value: string): string {
  return new URL(value).hostname.replace(/^www\./i, '').toLowerCase();
}

function hasRejectedSite(batch: BatchSnapshot, value: string): boolean {
  const rejectedStatuses = new Set([
    'submitted_not_visible',
    'validation_error',
    'unknown',
  ]);
  const site = targetSiteKey(value);
  return batch.items
    .slice(0, batch.currentIndex)
    .some(
      (item) =>
        rejectedStatuses.has(item.status) && targetSiteKey(item.url) === site
    );
}

async function advanceResolvedPage(
  batch: BatchSnapshot,
  resolvedUrl: string,
  dependencies: BatchRunnerDependencies,
  partial = false
): Promise<BatchStepResult> {
  const url = canonicalPageUrl(resolvedUrl);
  const nextStatus =
    currentItem(batch).message === RESUME_VERIFICATION_REQUIRED ||
    currentItem(batch).message === VERIFICATION_NAVIGATION_PENDING
      ? 'verifying'
      : 'analyzing';
  const resolved = updateBatchProgress(
    batch,
    {
      item: {
        url,
        status: nextStatus,
        message: partial ? PARTIAL_PAGE_READY : '',
        partialPageAllowed: partial,
      },
    },
    dependencies.now()
  );
  if (hasAttemptedCanonicalTarget(resolved, url)) {
    const duplicate = completeCurrentItem(
      resolved,
      'failed',
      'DUPLICATE_CANONICAL_TARGET',
      dependencies.now()
    );
    await dependencies.setBatch(duplicate);
    return afterTerminal(duplicate);
  }
  await dependencies.setBatch(resolved);
  return 'continue';
}

function manualGateStatus(
  currentValue: string
): 'login_required' | 'captcha_required' | null {
  try {
    const pathname = new URL(currentValue).pathname;
    if (/captcha|challenge|recaptcha|hcaptcha|turnstile/i.test(pathname)) {
      return 'captcha_required';
    }
    if (
      /(?:^|\/)(?:wp-login\.php|login|log-in|signin|sign-in|signup|sign-up|register|create-account|account|members-only|auth|authenticate|oauth|sso|session)(?:\/|$)/i.test(
        pathname
      )
    ) {
      return 'login_required';
    }
    return null;
  } catch {
    return null;
  }
}

async function saveFailure(
  batch: BatchSnapshot,
  message: string,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const next = completeCurrentItem(
    batch,
    'failed',
    message,
    dependencies.now()
  );
  await dependencies.setBatch(next);
  return afterTerminal(next);
}

async function saveUnconfirmedSubmission(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies,
  message = 'COMMENT_SUBMISSION_UNCONFIRMED'
): Promise<BatchStepResult> {
  const next = completeCurrentItem(
    batch,
    'unknown',
    message,
    dependencies.now()
  );
  await dependencies.setBatch(next);
  return afterTerminal(next);
}

async function savePause(
  batch: BatchSnapshot,
  status: 'login_required' | 'captcha_required',
  message: string,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const next = pauseCurrentItem(batch, status, message, dependencies.now());
  await dependencies.setBatch(next);
  return 'wait';
}

async function checkPublicVisibility(
  batch: BatchSnapshot,
  fingerprint: string,
  message: typeof PUBLIC_CHECK_ACCEPTED | typeof PUBLIC_CHECK_UNKNOWN,
  dependencies: BatchRunnerDependencies
): Promise<{ batch: BatchSnapshot; visible: boolean }> {
  const checking = updateBatchProgress(
    batch,
    { item: { status: 'checking_public', message } },
    dependencies.now()
  );
  await dependencies.setBatch(checking);
  const item = currentItem(checking);
  const visible = await dependencies
    .isCommentPubliclyVisible(
      item.prepared?.expected.url ?? item.url,
      fingerprint
    )
    .catch(() => false);
  return { batch: checking, visible };
}

async function saveSubmissionResult(
  batch: BatchSnapshot,
  result: PageSubmissionResult,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const item = currentItem(batch);
  if (
    result.status === 'validation_error' &&
    result.message === 'LINK_PLACEMENT_CHANGED' &&
    !result.clickOccurred
  ) {
    const next = updateBatchProgress(
      batch,
      {
        item: {
          status: 'analyzing',
          analysis: null,
          comment: null,
          prepared: null,
          message: result.message,
        },
      },
      dependencies.now()
    );
    await dependencies.setBatch(next);
    return 'continue';
  }
  if (
    result.status === 'validation_error' &&
    result.message === 'PAGE_CHANGED_SINCE_GENERATION' &&
    !result.clickOccurred &&
    item.analysis?.formPlan &&
    (item.formPlanRefreshes ?? 0) < 1
  ) {
    const next = updateBatchProgress(
      batch,
      {
        item: {
          status: 'analyzing',
          analysis: null,
          comment: null,
          prepared: null,
          formPlanRefreshes: (item.formPlanRefreshes ?? 0) + 1,
          message: result.message,
        },
      },
      dependencies.now()
    );
    await dependencies.setBatch(next);
    return 'continue';
  }
  if (
    result.status === 'published' ||
    result.status === 'submitted_not_visible'
  ) {
    const publicCheck = await checkPublicVisibility(
      batch,
      result.fingerprint,
      PUBLIC_CHECK_ACCEPTED,
      dependencies
    );
    const next = completeCurrentItem(
      publicCheck.batch,
      publicCheck.visible ? 'published' : 'submitted_not_visible',
      publicCheck.visible
        ? 'COMMENT_PUBLISHED'
        : 'COMMENT_SUBMITTED_NOT_VISIBLE',
      dependencies.now()
    );
    await dependencies.setBatch(next);
    return afterTerminal(next);
  }
  if (result.status === 'login_required') {
    const resumable = result.clickOccurred
      ? batch
      : updateBatchProgress(
          batch,
          { item: { prepared: null } },
          dependencies.now()
        );
    return savePause(resumable, 'login_required', result.message, dependencies);
  }
  if (result.status === 'captcha_required') {
    const resumable = result.clickOccurred
      ? batch
      : updateBatchProgress(
          batch,
          { item: { prepared: null } },
          dependencies.now()
        );
    return savePause(
      resumable,
      'captcha_required',
      result.message,
      dependencies
    );
  }
  if (result.status === 'unknown') {
    let current = batch;
    if (result.clickOccurred) {
      const publicCheck = await checkPublicVisibility(
        batch,
        result.fingerprint,
        PUBLIC_CHECK_UNKNOWN,
        dependencies
      );
      current = publicCheck.batch;
      if (publicCheck.visible) {
        const next = completeCurrentItem(
          current,
          'published',
          'COMMENT_PUBLISHED',
          dependencies.now()
        );
        await dependencies.setBatch(next);
        return afterTerminal(next);
      }
    }
    if (result.clickOccurred && result.verificationObservation) {
      try {
        const keys = await dependencies.getProviderApiKeys();
        const classification = await dependencies.classifySubmissionOutcome(
          keys,
          {
            provider: batch.settings.provider,
            observation: result.verificationObservation,
          }
        );
        if (classification.status !== 'unknown') {
          if (
            classification.status === 'published' ||
            classification.status === 'submitted_not_visible'
          ) {
            const next = completeCurrentItem(
              current,
              'submitted_not_visible',
              'COMMENT_SUBMITTED_NOT_VISIBLE',
              dependencies.now()
            );
            await dependencies.setBatch(next);
            return afterTerminal(next);
          }
          return saveSubmissionResult(
            current,
            {
              ...result,
              status: classification.status,
              message: classification.reason,
            },
            dependencies
          );
        }
      } catch {
        // A post-click classifier failure must not turn an unknown result into a
        // retryable failure or cause another submission attempt.
      }
    }
    return saveUnconfirmedSubmission(current, dependencies, result.message);
  }

  const next = completeCurrentItem(
    batch,
    'validation_error',
    result.message,
    dependencies.now()
  );
  await dependencies.setBatch(next);
  return afterTerminal(next);
}

async function resumePublicVisibilityCheck(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const item = currentItem(batch);
  if (!item.prepared) {
    return saveUnconfirmedSubmission(batch, dependencies);
  }
  const visible = await dependencies
    .isCommentPubliclyVisible(
      item.prepared.expected.url,
      item.prepared.fingerprint
    )
    .catch(() => false);
  const acceptedBeforeCheck = item.message === PUBLIC_CHECK_ACCEPTED;
  const next = completeCurrentItem(
    batch,
    visible
      ? 'published'
      : acceptedBeforeCheck
        ? 'submitted_not_visible'
        : 'unknown',
    visible
      ? 'COMMENT_PUBLISHED'
      : acceptedBeforeCheck
        ? 'COMMENT_SUBMITTED_NOT_VISIBLE'
        : 'COMMENT_SUBMISSION_UNCONFIRMED',
    dependencies.now()
  );
  await dependencies.setBatch(next);
  return afterTerminal(next);
}

async function openWorkerTab(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const item = currentItem(batch);
  if (hasRejectedSite(batch, item.url)) {
    const skipped = completeCurrentItem(
      batch,
      'failed',
      'SITE_REJECTED_BY_PRIOR_RESULT',
      dependencies.now()
    );
    await dependencies.setBatch(skipped);
    return afterTerminal(skipped);
  }
  let current = batch;
  try {
    if (batch.workerTabId !== undefined) {
      const existing = await dependencies.getWorkerTab(
        batch.workerTabId,
        batch.id
      );
      if (existing) {
        const alreadyOnTarget = isSamePage(tabLocation(existing), item.url);
        const next = updateBatchProgress(
          batch,
          {
            item: {
              status: 'opening',
              partialPageAllowed: false,
              message: alreadyOnTarget
                ? item.message
                : item.message === RESUME_VERIFICATION_REQUIRED
                  ? VERIFICATION_NAVIGATION_PENDING
                  : TARGET_NAVIGATION_PENDING,
            },
          },
          dependencies.now()
        );
        await dependencies.setBatch(next);
        if (alreadyOnTarget) {
          return existing.status === 'complete' ? 'continue' : 'wait';
        }
        const navigated = await dependencies.navigateWorkerTab(
          existing.id,
          item.url,
          batch.id
        );
        if (!navigated) {
          return saveFailure(
            next,
            'WORKER_TAB_NAVIGATION_FAILED',
            dependencies
          );
        }
        return navigated.status === 'complete' ? 'continue' : 'wait';
      }
      current = updateBatchProgress(
        batch,
        { workerTabId: null },
        dependencies.now()
      );
      await dependencies.setBatch(current);
    }

    const tab = await dependencies.createWorkerTab(item.url, batch.id);
    const next = updateBatchProgress(
      current,
      {
        workerTabId: tab.id,
        item: {
          status: 'opening',
          partialPageAllowed: false,
          message:
            item.message === RESUME_VERIFICATION_REQUIRED
              ? VERIFICATION_NAVIGATION_PENDING
              : TARGET_NAVIGATION_PENDING,
        },
      },
      dependencies.now()
    );
    await dependencies.setBatch(next);
    return tab.status === 'complete' ? 'continue' : 'wait';
  } catch (error) {
    return saveFailure(current, errorMessage(error), dependencies);
  }
}

async function advanceOpening(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  if (batch.workerTabId === undefined) {
    return openWorkerTab(batch, dependencies);
  }

  const item = currentItem(batch);
  const tab = await dependencies.getWorkerTab(batch.workerTabId, batch.id);
  if (!tab) {
    const withoutTab = updateBatchProgress(
      batch,
      { workerTabId: null },
      dependencies.now()
    );
    await dependencies.setBatch(withoutTab);
    return openWorkerTab(withoutTab, dependencies);
  }

  const location = tabLocation(tab);
  if (tab.status !== 'complete') {
    if (dependencies.now() - item.updatedAt < TARGET_LOAD_GRACE_MS) {
      return 'wait';
    }
    if (!tab.pendingUrl && tab.url && isSamePage(tab.url, item.url)) {
      return advanceResolvedPage(batch, tab.url, dependencies, true);
    }
    return saveFailure(
      batch,
      tab.pendingUrl
        ? 'TARGET_PAGE_LOAD_UNCONFIRMED'
        : 'TARGET_PAGE_REDIRECT_UNSUPPORTED',
      dependencies
    );
  }
  if (isSamePage(location, item.url)) {
    return advanceResolvedPage(batch, location, dependencies);
  }

  if (
    tab.status === 'complete' &&
    (item.message === TARGET_NAVIGATION_PENDING ||
      item.message === VERIFICATION_NAVIGATION_PENDING)
  ) {
    if (isSafeCanonicalRedirect(item.url, location)) {
      return advanceResolvedPage(batch, location, dependencies);
    }
    const gateStatus = manualGateStatus(location);
    if (gateStatus) {
      return savePause(
        batch,
        gateStatus,
        gateStatus === 'captcha_required'
          ? 'CAPTCHA_REQUIRED'
          : 'LOGIN_REQUIRED',
        dependencies
      );
    }
    if (!location || !hasSameOrigin(location, item.url)) {
      return savePause(
        batch,
        'login_required',
        'TARGET_REDIRECT_REQUIRES_MANUAL_ACTION',
        dependencies
      );
    }
    try {
      const redirectAnalysis = await dependencies.analyzeTab(tab.id, batch.id);
      if (
        redirectAnalysis.form.readiness === 'login_required' ||
        redirectAnalysis.form.readiness === 'captcha_required'
      ) {
        return savePause(
          batch,
          redirectAnalysis.form.readiness,
          redirectAnalysis.form.message ||
            (redirectAnalysis.form.readiness === 'captcha_required'
              ? 'CAPTCHA_REQUIRED'
              : 'LOGIN_REQUIRED'),
          dependencies
        );
      }
    } catch {
      // Fall through to the unsupported redirect result.
    }
    return saveFailure(batch, 'TARGET_PAGE_REDIRECT_UNSUPPORTED', dependencies);
  }

  const pending = updateBatchProgress(
    batch,
    {
      item: {
        status: 'opening',
        partialPageAllowed: false,
        message:
          item.message === RESUME_VERIFICATION_REQUIRED
            ? VERIFICATION_NAVIGATION_PENDING
            : item.message === VERIFICATION_NAVIGATION_PENDING
              ? VERIFICATION_NAVIGATION_PENDING
              : TARGET_NAVIGATION_PENDING,
      },
    },
    dependencies.now()
  );
  await dependencies.setBatch(pending);

  const navigated = await dependencies.navigateWorkerTab(
    tab.id,
    item.url,
    batch.id
  );
  if (!navigated)
    return saveFailure(pending, 'WORKER_TAB_NAVIGATION_FAILED', dependencies);
  return 'wait';
}

async function advanceAnalysis(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const item = currentItem(batch);
  const tab =
    batch.workerTabId === undefined
      ? null
      : await dependencies.getWorkerTab(batch.workerTabId, batch.id);
  const location = tab ? tabLocation(tab) : '';
  const onTarget = tab ? isSamePage(location, item.url) : false;
  if (!tab || !onTarget) {
    const next = updateBatchProgress(
      batch,
      {
        workerTabId: tab ? batch.workerTabId : null,
        item: {
          status: 'opening',
          partialPageAllowed: false,
          message: RESUME_TARGET_REQUIRED,
        },
      },
      dependencies.now()
    );
    await dependencies.setBatch(next);
    return 'continue';
  }
  if (tab.status !== 'complete' && !canUsePartialPage(item, tab)) {
    return 'wait';
  }
  let analysis: PageAnalysis;
  try {
    analysis = await dependencies.analyzeTab(tab.id, batch.id);
  } catch (error) {
    return saveFailure(batch, errorMessage(error), dependencies);
  }

  if (analysis.form.readiness === 'login_required') {
    return savePause(
      batch,
      'login_required',
      analysis.form.message || 'LOGIN_REQUIRED',
      dependencies
    );
  }
  if (analysis.form.readiness === 'captcha_required') {
    return savePause(
      batch,
      'captcha_required',
      analysis.form.message || 'CAPTCHA_REQUIRED',
      dependencies
    );
  }
  if (!analysis.page.title.trim() || !analysis.page.excerpt.trim()) {
    return saveFailure(batch, 'TARGET_PAGE_CONTEXT_MISSING', dependencies);
  }

  const canPlanFormReveal =
    analysis.form.readiness === 'not_found' &&
    !item.formRevealAttempted &&
    analysis.probe?.controlCandidates.some(
      (candidate) =>
        candidate.visible &&
        candidate.enabled &&
        (candidate.tag === 'button' ||
          candidate.tag === 'a' ||
          candidate.attributes.role === 'button' ||
          (candidate.tag === 'input' && candidate.type === 'button'))
    );
  const needsSemanticFormPlan =
    analysis.form.readiness === 'not_found' &&
    Boolean(analysis.probe && hasPlausibleCommentControls(analysis.probe));
  if (analysis.probe && (needsSemanticFormPlan || canPlanFormReveal)) {
    try {
      const keys = await dependencies.getProviderApiKeys();
      const plan = await dependencies.planCommentForm(keys, {
        provider: batch.settings.provider,
        observation: buildFormPlanningObservation(
          analysis.probe,
          analysis.page
        ),
      });
      if (
        plan.decision === 'reveal_form' &&
        plan.revealCandidateId &&
        canPlanFormReveal
      ) {
        const dispatched = updateBatchProgress(
          batch,
          {
            item: {
              status: 'opening',
              formRevealAttempted: true,
              message: 'COMMENT_FORM_REVEAL_DISPATCHED',
            },
          },
          dependencies.now()
        );
        await dependencies.setBatch(dispatched);
        let clicked: boolean;
        try {
          clicked = await dependencies.revealCommentForm(
            tab.id,
            analysis.probe.snapshotId,
            plan.revealCandidateId,
            batch.id
          );
        } catch (error) {
          return saveFailure(dispatched, errorMessage(error), dependencies);
        }
        if (clicked) {
          const next = updateBatchProgress(
            dispatched,
            {
              item: {
                status: 'opening',
                message: 'COMMENT_FORM_REVEALED',
              },
            },
            dependencies.now()
          );
          await dependencies.setBatch(next);
          return 'continue';
        }
        const blocked = completeCurrentItem(
          dispatched,
          'no_form',
          'COMMENT_FORM_REVEAL_BLOCKED',
          dependencies.now()
        );
        await dependencies.setBatch(blocked);
        return afterTerminal(blocked);
      }
      const planned = applyFormPlan(analysis, analysis.probe, plan);
      analysis = {
        page: planned.page,
        form: planned.form,
        formPlan: planned.formPlan,
      };
    } catch (error) {
      return saveFailure(batch, errorMessage(error), dependencies);
    }
  } else {
    analysis = { page: analysis.page, form: analysis.form };
  }

  if (analysis.form.readiness === 'not_found') {
    const next = completeCurrentItem(
      batch,
      'no_form',
      analysis.form.message || 'COMMENT_FORM_NOT_FOUND',
      dependencies.now()
    );
    await dependencies.setBatch(next);
    return afterTerminal(next);
  }

  const next = updateBatchProgress(
    batch,
    {
      item: {
        status: 'generating',
        analysis,
        message: GENERATION_READY,
      },
    },
    dependencies.now()
  );
  await dependencies.setBatch(next);
  return 'continue';
}

async function saveGeneratedComment(
  batch: BatchSnapshot,
  comment: string,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const fingerprint = commentFingerprint(comment);
  const duplicate = batch.items
    .slice(0, batch.currentIndex)
    .some((item) => item.commentFingerprint === fingerprint);
  if (duplicate) {
    const withFingerprint = updateBatchProgress(
      batch,
      { item: { commentFingerprint: fingerprint } },
      dependencies.now()
    );
    return saveFailure(
      withFingerprint,
      'DUPLICATE_COMMENT_GENERATED',
      dependencies
    );
  }
  const next = updateBatchProgress(
    batch,
    {
      item: {
        status: 'generating',
        comment,
        commentFingerprint: fingerprint,
        message: '',
      },
    },
    dependencies.now()
  );
  await dependencies.setBatch(next);
  return 'continue';
}

async function prepareGeneratedComment(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const item = currentItem(batch);
  if (!item.analysis || !item.comment || !batch.websiteProfile) {
    return saveFailure(batch, 'BATCH_GENERATION_CONTEXT_MISSING', dependencies);
  }
  const tab =
    batch.workerTabId === undefined
      ? null
      : await dependencies.getWorkerTab(batch.workerTabId, batch.id);
  if (!tab) {
    const next = updateBatchProgress(
      batch,
      {
        workerTabId: null,
        item: {
          status: 'opening',
          prepared: null,
          partialPageAllowed: false,
          message: 'WORKER_TAB_MISSING',
        },
      },
      dependencies.now()
    );
    await dependencies.setBatch(next);
    return 'continue';
  }
  if (tab.status !== 'complete' && !canUsePartialPage(item, tab)) {
    if (dependencies.now() - item.updatedAt < TARGET_LOAD_GRACE_MS) {
      return 'wait';
    }
    return saveFailure(batch, 'PAGE_CHANGED_SINCE_GENERATION', dependencies);
  }
  const input: PageSubmissionInput = {
    comment: item.comment,
    displayName: batch.settings.displayName || undefined,
    email: batch.settings.email || undefined,
    websiteUrl:
      item.analysis.form.hasWebsiteField &&
      (batch.settings.linkMode === 'prefer-website-field' ||
        item.analysis.formPlan?.requiredRoles.includes('website'))
        ? batch.settings.websiteUrl
        : '',
  };
  const target: PageSubmissionExpectation = {
    url: item.analysis.page.url,
    editorLabel: item.analysis.form.editorLabel,
    submitLabel: item.analysis.form.submitLabel,
    hasWebsiteField: item.analysis.form.hasWebsiteField,
    formPlan: item.analysis.formPlan,
  };

  try {
    const preparation = await dependencies.prepareTabSubmission(
      tab.id,
      input,
      target,
      batch.id
    );
    if (!preparation.ok) {
      return saveSubmissionResult(batch, preparation.result, dependencies);
    }
    const next = updateBatchProgress(
      batch,
      {
        item: {
          status: 'prepared',
          prepared: preparation.prepared,
          message: '',
        },
      },
      dependencies.now()
    );
    await dependencies.setBatch(next);
    return 'continue';
  } catch (error) {
    return saveFailure(batch, errorMessage(error), dependencies);
  }
}

async function advanceGeneration(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const item = currentItem(batch);
  if (item.comment) return prepareGeneratedComment(batch, dependencies);
  if (item.message === GENERATION_REQUESTED) {
    return saveFailure(
      batch,
      'COMMENT_GENERATION_STATE_UNCONFIRMED',
      dependencies
    );
  }
  if (!item.analysis || !batch.websiteProfile) {
    return saveFailure(batch, 'BATCH_GENERATION_CONTEXT_MISSING', dependencies);
  }
  const keys = await dependencies.getProviderApiKeys();
  if (
    (batch.settings.provider === 'deepseek' && !keys.deepseekApiKey) ||
    (batch.settings.provider === 'kie-gemini' && !keys.kieApiKey)
  ) {
    return saveFailure(
      batch,
      batch.settings.provider === 'deepseek'
        ? 'DEEPSEEK_API_KEY_REQUIRED'
        : 'KIE_API_KEY_REQUIRED',
      dependencies
    );
  }

  const requested = updateBatchProgress(
    batch,
    { item: { status: 'generating', message: GENERATION_REQUESTED } },
    dependencies.now()
  );
  await dependencies.setBatch(requested);
  const websiteFieldRequired =
    item.analysis.formPlan?.requiredRoles.includes('website') ?? false;
  const effectiveLinkMode = websiteFieldRequired
    ? 'prefer-website-field'
    : requested.settings.linkMode === 'prefer-website-field' &&
        !item.analysis.form.hasWebsiteField
      ? 'inline'
      : requested.settings.linkMode;
  try {
    const comment = await dependencies.generateComment(keys, {
      provider: requested.settings.provider,
      websiteProfile: requested.websiteProfile as NonNullable<
        BatchSnapshot['websiteProfile']
      >,
      targetPage: item.analysis.page,
      linkMode: effectiveLinkMode,
    });
    return saveGeneratedComment(requested, comment, dependencies);
  } catch (error) {
    return saveFailure(requested, errorMessage(error), dependencies);
  }
}

async function dispatchPreparedComment(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies,
  shouldStop: () => boolean
): Promise<BatchStepResult> {
  if (shouldStop()) return 'wait';
  const item = currentItem(batch);
  if (batch.workerTabId === undefined || !item.prepared) {
    return saveFailure(batch, 'BATCH_PREPARED_COMMENT_MISSING', dependencies);
  }

  const tab = await dependencies.getWorkerTab(batch.workerTabId, batch.id);
  if (!tab || !isSamePage(tabLocation(tab), item.prepared.expected.url)) {
    const next = updateBatchProgress(
      batch,
      {
        workerTabId: tab ? batch.workerTabId : null,
        item: {
          status: 'opening',
          prepared: null,
          partialPageAllowed: false,
          message: 'WORKER_TAB_CHANGED',
        },
      },
      dependencies.now()
    );
    await dependencies.setBatch(next);
    return 'continue';
  }
  if (tab.status !== 'complete' && !canUsePartialPage(item, tab)) {
    if (dependencies.now() - item.updatedAt < TARGET_LOAD_GRACE_MS) {
      return 'wait';
    }
    return saveFailure(batch, 'PAGE_CHANGED_SINCE_GENERATION', dependencies);
  }
  if (shouldStop()) return 'wait';

  const dispatched = updateBatchProgress(
    batch,
    { item: { status: 'click_dispatched', message: '' } },
    dependencies.now()
  );
  await dependencies.setBatch(dispatched);
  if (shouldStop()) {
    await dependencies.setBatch(
      updateBatchProgress(
        dispatched,
        {
          item: {
            status: 'prepared',
            message: 'BATCH_STOP_REQUESTED',
          },
        },
        dependencies.now()
      )
    );
    return 'wait';
  }
  try {
    const result = await dependencies.clickPreparedTabSubmission(
      batch.workerTabId,
      item.prepared,
      batch.id
    );
    if (!result.clickOccurred) {
      return saveSubmissionResult(dispatched, result, dependencies);
    }
    const verifying = updateBatchProgress(
      dispatched,
      { item: { status: 'verifying', message: '' } },
      dependencies.now()
    );
    await dependencies.setBatch(verifying);
    return saveSubmissionResult(verifying, result, dependencies);
  } catch (error) {
    if (errorMessage(error) === 'PAGE_SUBMISSION_NAVIGATION_IN_PROGRESS') {
      return 'wait';
    }
    return saveUnconfirmedSubmission(dispatched, dependencies);
  }
}

async function advanceDispatchedClick(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const item = currentItem(batch);
  if (batch.workerTabId === undefined) {
    return saveUnconfirmedSubmission(batch, dependencies);
  }
  const tab = await dependencies.getWorkerTab(batch.workerTabId, batch.id);
  if (
    tab?.status === 'loading' &&
    dependencies.now() - item.updatedAt < TARGET_LOAD_GRACE_MS
  ) {
    return 'wait';
  }
  const location = tab ? tabLocation(tab) : '';
  const gateStatus = manualGateStatus(location);
  if (gateStatus) {
    return savePause(
      batch,
      gateStatus,
      gateStatus === 'captcha_required' ? 'CAPTCHA_REQUIRED' : 'LOGIN_REQUIRED',
      dependencies
    );
  }
  if (
    tab &&
    item.prepared &&
    location &&
    hasSameOrigin(location, item.prepared.expected.url) &&
    !isSamePage(location, item.prepared.expected.url)
  ) {
    try {
      const redirectAnalysis = await dependencies.analyzeTab(tab.id, batch.id);
      if (
        redirectAnalysis.form.readiness === 'login_required' ||
        redirectAnalysis.form.readiness === 'captcha_required'
      ) {
        return savePause(
          batch,
          redirectAnalysis.form.readiness,
          redirectAnalysis.form.message ||
            (redirectAnalysis.form.readiness === 'captcha_required'
              ? 'CAPTCHA_REQUIRED'
              : 'LOGIN_REQUIRED'),
          dependencies
        );
      }
    } catch {
      // Verification below keeps the click idempotent when the redirect is opaque.
    }
  }
  const next = updateBatchProgress(
    batch,
    {
      item: {
        status: 'verifying',
        message: tab?.status === 'loading' ? PARTIAL_PAGE_READY : '',
      },
    },
    dependencies.now()
  );
  await dependencies.setBatch(next);
  return 'continue';
}

async function verifyDispatchedComment(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const item = currentItem(batch);
  if (batch.workerTabId === undefined || !item.prepared) {
    return saveUnconfirmedSubmission(batch, dependencies);
  }
  const tab = await dependencies.getWorkerTab(batch.workerTabId, batch.id);
  if (tab?.status === 'loading' && item.message !== PARTIAL_PAGE_READY) {
    return 'wait';
  }
  try {
    const result = await dependencies.verifyTabSubmission(
      batch.workerTabId,
      item.prepared,
      item.prepared.expected.url,
      batch.id
    );
    return saveSubmissionResult(batch, result, dependencies);
  } catch {
    return saveUnconfirmedSubmission(batch, dependencies);
  }
}

export async function advanceBatchStep(
  dependencies: BatchRunnerDependencies = defaultDependencies,
  shouldStop: () => boolean = () => false
): Promise<BatchStepResult> {
  if (shouldStop()) return 'wait';
  const batch = await dependencies.getBatch();
  if (!batch || batch.status !== 'running') return 'wait';

  switch (currentItem(batch).status) {
    case 'queued':
      return openWorkerTab(batch, dependencies);
    case 'opening':
      return advanceOpening(batch, dependencies);
    case 'analyzing':
      return advanceAnalysis(batch, dependencies);
    case 'generating':
      return advanceGeneration(batch, dependencies);
    case 'prepared':
      return dispatchPreparedComment(batch, dependencies, shouldStop);
    case 'click_dispatched':
      return advanceDispatchedClick(batch, dependencies);
    case 'verifying':
      return verifyDispatchedComment(batch, dependencies);
    case 'checking_public':
      return resumePublicVisibilityCheck(batch, dependencies);
    default:
      return saveFailure(batch, 'BATCH_ITEM_STATE_INVALID', dependencies);
  }
}

export async function runBatchUntilBlocked(
  dependencies: BatchRunnerDependencies = defaultDependencies,
  shouldStop: () => boolean = () => false
): Promise<BatchStepResult> {
  for (let step = 0; step < 20; step += 1) {
    if (shouldStop()) return 'wait';
    const result = await advanceBatchStep(dependencies, shouldStop);
    if (result !== 'continue') return result;
  }
  return 'continue';
}
