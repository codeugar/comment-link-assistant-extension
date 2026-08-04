import { type GenerateCommentInput, generateComment } from '@/api/client';
import type {
  CommentFrameReference,
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
  verifyTabSubmission,
} from '@/runtime/page-commands';
import { getBatch, setBatch } from '@/storage/batch';
import { isTargetFiltered } from '@/storage/filter-list';
import { getProviderApiKeys } from '@/storage/settings';
import { type ProviderApiKeys, usesInlineAnchor } from '@/types';
import { normalizeWebsiteUrl } from '@/website/profile';
import {
  type TargetLibraryGateState,
  type TargetLibraryObservation,
  getTargetLibraryGateState,
  observeTargetLibrary,
} from './link-library-observer';
import { completeCurrentItem, updateBatchProgress } from './state';
import type { BatchItem, BatchItemStatus, BatchSnapshot } from './types';

const GENERATION_READY = 'COMMENT_GENERATION_READY';
const GENERATION_REQUESTED = 'COMMENT_GENERATION_REQUESTED';
const TARGET_NAVIGATION_PENDING = 'BATCH_TARGET_NAVIGATION_PENDING';
const RESUME_TARGET_REQUIRED = 'BATCH_RESUME_TARGET_REQUIRED';
const RESUME_VERIFICATION_REQUIRED = 'BATCH_RESUME_VERIFICATION_REQUIRED';
const VERIFICATION_NAVIGATION_PENDING = 'BATCH_VERIFICATION_NAVIGATION_PENDING';
const PARTIAL_PAGE_READY = 'BATCH_PARTIAL_PAGE_READY';
const TARGET_LOAD_GRACE_MS = 30_000;
// Post-submit verification races the content-script re-injection against a
// still-loading page, so a failed attempt is usually transient. The recovery
// alarm ticks every 30s; this window guarantees at least two more attempts
// before the item is written off as unconfirmed.
const VERIFY_RETRY_WINDOW_MS = 90_000;
// Heavy / slow pages keep their tab in `loading` far longer than it takes their
// server-rendered comment form to appear. Because analyze is now load-tolerant,
// we hand off to analysis on an on-target tab after this short settle instead of
// dead-waiting the full TARGET_LOAD_GRACE_MS (which remains the hard cap).
const ANALYZE_LOADING_SETTLE_MS = 750;

const filterableItemStatuses = new Set<BatchItemStatus>([
  'queued',
  'opening',
  'analyzing',
  'generating',
  'prepared',
]);

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
  generateComment(
    keys: ProviderApiKeys,
    input: GenerateCommentInput
  ): Promise<string>;
  prepareTabSubmission(
    tabId: number,
    input: PageSubmissionInput,
    target: PageSubmissionExpectation,
    batchId: string,
    frame?: CommentFrameReference
  ): Promise<PageSubmissionPreparation>;
  clickPreparedTabSubmission(
    tabId: number,
    prepared: PreparedPageSubmission,
    batchId: string,
    frame?: CommentFrameReference
  ): Promise<PageSubmissionResult>;
  verifyTabSubmission(
    tabId: number,
    prepared: Pick<PreparedPageSubmission, 'fingerprint' | 'baseline'>,
    expectedUrl: string,
    batchId: string
  ): Promise<PageSubmissionResult>;
  /**
   * Checked immediately before a queued target is opened. Optional so callers
   * with isolated runner dependencies remain backwards compatible; production
   * uses the persisted filter list below.
   */
  isTargetFiltered?(url: string): Promise<boolean>;
  /**
   * Domain-level outbound-link observations. Kept optional for isolated
   * runners and migration tests; production uses the storage adapter.
   */
  getTargetLibraryGateState?(url: string): Promise<TargetLibraryGateState>;
  observeTargetLibrary?(
    url: string,
    observation: TargetLibraryObservation
  ): Promise<void>;
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
  generateComment,
  async prepareTabSubmission(tabId, input, target, batchId, frame) {
    await assertWorkerTabOwnership(batchId, tabId);
    return prepareTabSubmission(tabId, input, target, frame);
  },
  async clickPreparedTabSubmission(tabId, prepared, batchId, frame) {
    await assertWorkerTabOwnership(batchId, tabId);
    return clickPreparedTabSubmission(tabId, prepared, frame);
  },
  async verifyTabSubmission(tabId, prepared, expectedUrl, batchId) {
    await assertWorkerTabOwnership(batchId, tabId);
    return verifyTabSubmission(tabId, prepared, expectedUrl);
  },
  isTargetFiltered,
  getTargetLibraryGateState,
  observeTargetLibrary,
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

function promotedWebsiteUrl(batch: BatchSnapshot): string {
  return normalizeWebsiteUrl(
    batch.websiteProfile?.url || batch.settings.websiteUrl
  );
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

async function observeTargetLibrarySafely(
  dependencies: BatchRunnerDependencies,
  url: string,
  observation: TargetLibraryObservation
): Promise<void> {
  try {
    await dependencies.observeTargetLibrary?.(url, observation);
  } catch {
    // Library observations are telemetry. A storage or migration failure must
    // never strand the execution queue or turn a gate into a batch failure.
  }
}

async function targetLibraryGateStateSafely(
  dependencies: BatchRunnerDependencies,
  url: string
): Promise<TargetLibraryGateState> {
  try {
    return (
      (await dependencies.getTargetLibraryGateState?.(url)) ?? {
        loginRequired: false,
        captchaRequired: false,
      }
    );
  } catch {
    // A stale or malformed library row must not prevent the target from being
    // opened. The page-level detector remains the source of truth.
    return { loginRequired: false, captchaRequired: false };
  }
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
  const key = canonicalTargetKey(resolvedUrl);
  const currentId = batch.items[batch.currentIndex]?.id;
  // Scan every other item, not just those before the cursor: a retry rewinds
  // currentIndex, so a duplicate the batch already submitted can now sit at a
  // later index than the item being processed.
  return batch.items.some(
    (item) =>
      item.id !== currentId &&
      (item.status === 'published' ||
        item.status === 'pending_moderation' ||
        item.status === 'submitted') &&
      canonicalTargetKey(item.url) === key
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

async function skipFilteredTarget(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const next = completeCurrentItem(
    batch,
    'filtered',
    'FILTER_LIST_MATCHED',
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
    'unconfirmed',
    message,
    dependencies.now()
  );
  await dependencies.setBatch(next);
  return afterTerminal(next);
}

async function saveManualGate(
  batch: BatchSnapshot,
  status: 'login_required' | 'captcha_required',
  message: string,
  dependencies: BatchRunnerDependencies,
  clicked = false
): Promise<BatchStepResult> {
  await observeTargetLibrarySafely(
    dependencies,
    batch.items[batch.currentIndex]!.url,
    {
      [status === 'login_required' ? 'loginRequired' : 'captchaRequired']: true,
    }
  );
  const next = completeCurrentItem(
    batch,
    clicked ? 'unconfirmed' : status,
    clicked
      ? `${status === 'login_required' ? 'LOGIN_REQUIRED' : 'CAPTCHA_REQUIRED'}_AFTER_CLICK:${message}`
      : message,
    dependencies.now()
  );
  await dependencies.setBatch(next);
  return afterTerminal(next);
}

async function saveSubmissionResult(
  batch: BatchSnapshot,
  result: PageSubmissionResult,
  dependencies: BatchRunnerDependencies,
  clicked = false
): Promise<BatchStepResult> {
  const targetUrl = batch.items[batch.currentIndex]?.url;
  const didClick = clicked || result.clickOccurred;
  if (
    targetUrl &&
    (result.linkFollow?.status === 'dofollow' ||
      result.linkFollow?.status === 'nofollow')
  ) {
    await observeTargetLibrarySafely(dependencies, targetUrl, {
      followStatus: result.linkFollow.status,
    });
  }
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
  if (result.status === 'login_required') {
    const resumable = didClick
      ? batch
      : updateBatchProgress(
          batch,
          { item: { prepared: null } },
          dependencies.now()
        );
    return saveManualGate(
      resumable,
      'login_required',
      result.message,
      dependencies,
      didClick
    );
  }
  if (result.status === 'captcha_required') {
    const resumable = didClick
      ? batch
      : updateBatchProgress(
          batch,
          { item: { prepared: null } },
          dependencies.now()
        );
    return saveManualGate(
      resumable,
      'captcha_required',
      result.message,
      dependencies,
      didClick
    );
  }
  // An explicit in-page validation/submission error is a kept terminal state.
  // It no longer blacklists the domain: later same-host targets run normally.
  if (result.status === 'validation_error') {
    const next = completeCurrentItem(
      batch,
      'validation_error',
      result.message,
      dependencies.now()
    );
    await dependencies.setBatch(next);
    return afterTerminal(next);
  }
  const confirmedStatus =
    result.status === 'published' || result.status === 'pending_moderation'
      ? result.status
      : result.status === 'unconfirmed' || result.status === 'submitted'
        ? 'unconfirmed'
        : null;
  if (confirmedStatus && result.clickOccurred) {
    const next = completeCurrentItem(
      batch,
      confirmedStatus,
      result.message,
      dependencies.now()
    );
    await dependencies.setBatch(next);
    return afterTerminal(next);
  }
  // The click could never be dispatched and there is no page evidence at all:
  // treat it as an infrastructure failure.
  return saveFailure(batch, result.message, dependencies);
}

async function openWorkerTab(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const item = currentItem(batch);
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

  if (tab.pendingUrl) {
    if (dependencies.now() - item.updatedAt < TARGET_LOAD_GRACE_MS) {
      return 'wait';
    }
    return saveFailure(batch, 'TARGET_PAGE_LOAD_UNCONFIRMED', dependencies);
  }

  const location = tabLocation(tab);
  if (tab.status !== 'complete') {
    if (!tab.pendingUrl && tab.url && isSamePage(tab.url, item.url)) {
      // On-target but still loading: after a short settle, analyze the partial
      // page instead of blocking for the full grace window.
      if (dependencies.now() - item.updatedAt < ANALYZE_LOADING_SETTLE_MS) {
        return 'wait';
      }
      return advanceResolvedPage(batch, tab.url, dependencies, true);
    }
    // Not on the target yet (pending navigation / redirect in flight): keep the
    // hard grace cap before giving up.
    if (dependencies.now() - item.updatedAt < TARGET_LOAD_GRACE_MS) {
      return 'wait';
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
      return saveManualGate(
        batch,
        gateStatus,
        gateStatus === 'captcha_required'
          ? 'CAPTCHA_REQUIRED'
          : 'LOGIN_REQUIRED',
        dependencies
      );
    }
    if (!location || !hasSameOrigin(location, item.url)) {
      return saveManualGate(
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
        return saveManualGate(
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
  const location = tab?.url ?? '';
  const onTarget = tab ? isSamePage(location, item.url) : false;
  if (!tab || tab.pendingUrl || !onTarget) {
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
  // Load-tolerant analyze: an on-target tab (no pending navigation, same page —
  // already asserted above) that is still `loading` can be analyzed after a
  // short settle. analyze() self-settles heavy pages and has its own generous
  // 30s timeout, so we no longer dead-wait for `complete`.
  if (
    tab.status !== 'complete' &&
    !canUsePartialPage(item, tab) &&
    dependencies.now() - item.updatedAt < ANALYZE_LOADING_SETTLE_MS
  ) {
    return 'wait';
  }
  let analysis: PageAnalysis;
  try {
    analysis = await dependencies.analyzeTab(tab.id, batch.id);
  } catch (error) {
    if (errorMessage(error) !== 'PAGE_COMMAND_TIMEOUT') {
      return saveFailure(batch, errorMessage(error), dependencies);
    }
    try {
      analysis = await dependencies.analyzeTab(tab.id, batch.id);
    } catch (retryError) {
      return saveFailure(batch, errorMessage(retryError), dependencies);
    }
  }

  if (analysis.form.readiness === 'login_required') {
    return saveManualGate(
      batch,
      'login_required',
      analysis.form.message || 'LOGIN_REQUIRED',
      dependencies
    );
  }
  if (analysis.form.readiness === 'captcha_required') {
    return saveManualGate(
      batch,
      'captcha_required',
      analysis.form.message || 'CAPTCHA_REQUIRED',
      dependencies
    );
  }
  await observeTargetLibrarySafely(dependencies, item.url, {
    loginRequired: false,
    captchaRequired: false,
  });
  if (!analysis.page.title.trim() || !analysis.page.excerpt.trim()) {
    return saveFailure(batch, 'TARGET_PAGE_CONTEXT_MISSING', dependencies);
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
    // The mode determines whether the URL belongs in the body, Website field,
    // or neither surface.
    websiteUrl:
      batch.settings.linkMode === 'comment-only'
        ? ''
        : promotedWebsiteUrl(batch),
    requireInlineAnchor: usesInlineAnchor(batch.settings.linkMode),
  };
  const target: PageSubmissionExpectation = {
    url: item.analysis.page.url,
    editorLabel: item.analysis.form.editorLabel,
    submitLabel: item.analysis.form.submitLabel,
    hasWebsiteField: item.analysis.form.hasWebsiteField,
  };

  try {
    const preparation = await dependencies.prepareTabSubmission(
      tab.id,
      input,
      target,
      batch.id,
      item.analysis.form.frame
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
  try {
    const comment = await dependencies.generateComment(keys, {
      provider: requested.settings.provider,
      websiteProfile: {
        ...(requested.websiteProfile as NonNullable<
          BatchSnapshot['websiteProfile']
        >),
        url: promotedWebsiteUrl(requested),
      },
      targetPage: item.analysis.page,
      linkMode: requested.settings.linkMode,
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
      batch.id,
      item.analysis?.form.frame
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

// A manual stop can preserve a post-click item so it is never submitted
// twice. If its worker tab was closed in the meantime, reopen the target and
// verify the existing attempt instead of retrying a command against a dead id.
async function reopenVerificationTarget(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const next = updateBatchProgress(
    batch,
    {
      workerTabId: null,
      item: {
        status: 'opening',
        partialPageAllowed: false,
        message: RESUME_VERIFICATION_REQUIRED,
      },
    },
    dependencies.now()
  );
  await dependencies.setBatch(next);
  return 'continue';
}

async function advanceDispatchedClick(
  batch: BatchSnapshot,
  dependencies: BatchRunnerDependencies
): Promise<BatchStepResult> {
  const item = currentItem(batch);
  if (!item.prepared) {
    return saveUnconfirmedSubmission(batch, dependencies);
  }
  const tab =
    batch.workerTabId === undefined
      ? null
      : await dependencies.getWorkerTab(batch.workerTabId, batch.id);
  if (!tab) return reopenVerificationTarget(batch, dependencies);
  if (
    tab?.status === 'loading' &&
    dependencies.now() - item.updatedAt < TARGET_LOAD_GRACE_MS
  ) {
    return 'wait';
  }
  const location = tab ? tabLocation(tab) : '';
  const gateStatus = manualGateStatus(location);
  if (gateStatus) {
    return saveManualGate(
      batch,
      gateStatus,
      gateStatus === 'captcha_required' ? 'CAPTCHA_REQUIRED' : 'LOGIN_REQUIRED',
      dependencies,
      true
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
        return saveManualGate(
          batch,
          redirectAnalysis.form.readiness,
          redirectAnalysis.form.message ||
            (redirectAnalysis.form.readiness === 'captcha_required'
              ? 'CAPTCHA_REQUIRED'
              : 'LOGIN_REQUIRED'),
          dependencies,
          true
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
  if (!item.prepared) {
    return saveUnconfirmedSubmission(batch, dependencies);
  }
  const tab =
    batch.workerTabId === undefined
      ? null
      : await dependencies.getWorkerTab(batch.workerTabId, batch.id);
  if (!tab) return reopenVerificationTarget(batch, dependencies);
  if (tab?.status === 'loading' && item.message !== PARTIAL_PAGE_READY) {
    return 'wait';
  }
  try {
    const result = await dependencies.verifyTabSubmission(
      tab.id,
      item.prepared,
      item.prepared.expected.url,
      batch.id
    );
    return saveSubmissionResult(batch, result, dependencies, true);
  } catch (error) {
    // A tab that left the submission page is a real signal and stays terminal.
    // Anything else (command timeout, injection race) retries on later wakes:
    // the batch is left unwritten so item.updatedAt keeps anchoring the window
    // at the moment verification began.
    if (
      errorMessage(error) !== 'PAGE_CHANGED_SINCE_SUBMISSION' &&
      dependencies.now() - item.updatedAt < VERIFY_RETRY_WINDOW_MS
    ) {
      return 'wait';
    }
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

  const item = currentItem(batch);
  // The list is checked before any submission click. That covers an item that
  // was paused/stopped and resumed after a user added it to the filter list,
  // while preserving click-dispatched/verifying items for idempotent result
  // verification instead of changing a comment that may already be posted.
  if (
    filterableItemStatuses.has(item.status) &&
    (await dependencies.isTargetFiltered?.(item.url))
  ) {
    return skipFilteredTarget(batch, dependencies);
  }
  if (item.status === 'queued' && dependencies.getTargetLibraryGateState) {
    const known = await targetLibraryGateStateSafely(dependencies, item.url);
    if (known.captchaRequired) {
      return saveManualGate(
        batch,
        'captcha_required',
        'OUTBOUND_LINK_LIBRARY_CAPTCHA_REQUIRED',
        dependencies
      );
    }
    if (known.loginRequired) {
      return saveManualGate(
        batch,
        'login_required',
        'OUTBOUND_LINK_LIBRARY_LOGIN_REQUIRED',
        dependencies
      );
    }
  }

  switch (item.status) {
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
