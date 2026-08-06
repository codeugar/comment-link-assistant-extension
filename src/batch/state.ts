import type {
  BatchItem,
  BatchItemStatus,
  BatchSettingsSnapshot,
  BatchSnapshot,
} from './types';
import { batchSnapshotSchema } from './types';
import { parseTargetUrls } from './urls';

const progressStatuses = new Set<BatchItemStatus>([
  'queued',
  'opening',
  'analyzing',
  'generating',
  'prepared',
  'click_dispatched',
  'verifying',
]);

const pauseStatuses = [
  'login_required',
  'captcha_required',
] as const satisfies readonly BatchItemStatus[];

const completionStatuses = [
  'published',
  'pending_moderation',
  'unconfirmed',
  'submitted',
  'login_required',
  'captcha_required',
  'no_form',
  'validation_error',
  'failed',
  'filtered',
] as const satisfies readonly BatchItemStatus[];

export const RETRYABLE_ITEM_STATUSES = [
  'failed',
  'no_form',
  'validation_error',
  'login_required',
  'captcha_required',
  'stopped',
] as const satisfies readonly BatchItemStatus[];

const retryableItemStatuses = new Set<BatchItemStatus>(RETRYABLE_ITEM_STATUSES);

// Terminal states the cursor skips over: an item already settled here (either
// this run or a prior one that a retry left behind) never runs again.
const terminalItemStatuses = new Set<BatchItemStatus>([
  'published',
  'pending_moderation',
  'unconfirmed',
  'submitted',
  'login_required',
  'captcha_required',
  'no_form',
  'validation_error',
  'failed',
  'filtered',
  'stopped',
]);

type PauseStatus = (typeof pauseStatuses)[number];
type CompletionStatus = (typeof completionStatuses)[number];

export interface CreateBatchInput {
  id?: string;
  targetText: string;
  settings: BatchSettingsSnapshot;
  now?: number;
}

export interface BatchItemProgressUpdate {
  url?: BatchItem['url'];
  status?: Extract<
    BatchItemStatus,
    | 'queued'
    | 'opening'
    | 'analyzing'
    | 'generating'
    | 'prepared'
    | 'click_dispatched'
    | 'verifying'
  >;
  analysis?: BatchItem['analysis'];
  comment?: BatchItem['comment'];
  commentFingerprint?: BatchItem['commentFingerprint'];
  prepared?: BatchItem['prepared'];
  partialPageAllowed?: BatchItem['partialPageAllowed'];
  anchor?: BatchItem['anchor'];
  message?: string;
}

export interface BatchProgressUpdate {
  websiteProfile?: BatchSnapshot['websiteProfile'];
  workerTabId?: number | null;
  item?: BatchItemProgressUpdate;
}

function timestamp(value?: number): number {
  return value ?? Date.now();
}

function boundedMessage(value: string): string {
  return value.slice(0, 500);
}

function currentItem(batch: BatchSnapshot): BatchItem {
  const item = batch.items[batch.currentIndex];
  if (!item) throw new Error('BATCH_CURRENT_ITEM_MISSING');
  return item;
}

function requireRunning(batch: BatchSnapshot): void {
  if (batch.status !== 'running') throw new Error('BATCH_NOT_RUNNING');
}

function replaceCurrentItem(
  batch: BatchSnapshot,
  item: BatchItem
): BatchItem[] {
  return batch.items.map((existing, index) =>
    index === batch.currentIndex ? item : existing
  );
}

function appendStatusEvent(
  item: BatchItem,
  status: BatchItemStatus,
  message: string,
  at: number
): BatchItem['events'] {
  const previous = item.events.at(-1);
  if (previous?.status === status) return item.events;
  return [
    ...item.events,
    { status, message: boundedMessage(message), at },
  ].slice(-32);
}

function legalSnapshot(batch: BatchSnapshot): BatchSnapshot {
  return batchSnapshotSchema.parse(batch);
}

export function createBatch(input: CreateBatchInput): BatchSnapshot {
  const now = timestamp(input.now);
  const id = input.id ?? globalThis.crypto.randomUUID();
  const urls = parseTargetUrls(input.targetText);
  const settings: BatchSettingsSnapshot = {
    provider: input.settings.provider,
    websiteUrl: input.settings.websiteUrl,
    displayName: input.settings.displayName,
    email: input.settings.email,
    linkMode: input.settings.linkMode,
    ...(input.settings.siteId !== undefined
      ? { siteId: input.settings.siteId }
      : {}),
    ...(input.settings.siteLabel !== undefined
      ? { siteLabel: input.settings.siteLabel }
      : {}),
  };

  return legalSnapshot({
    id,
    status: 'running',
    settings,
    items: urls.map((url, index) => ({
      id: `${id}:${index}`,
      url,
      status: 'queued',
      analysis: null,
      comment: null,
      commentFingerprint: null,
      prepared: null,
      events: [{ status: 'queued', message: '', at: now }],
      message: '',
      createdAt: now,
      updatedAt: now,
    })),
    currentIndex: 0,
    websiteProfile: null,
    createdAt: now,
    updatedAt: now,
  });
}
/**
 * Applies persisted filters to still-queued items before a batch wakes. It is
 * also used at initial creation so a fully filtered batch completes without
 * requesting target-site permissions, opening tabs, or calling a provider.
 */
export function filterQueuedItems(
  batch: BatchSnapshot,
  filteredUrls: Iterable<string>,
  message = 'FILTER_LIST_MATCHED',
  at?: number
): BatchSnapshot {
  requireRunning(batch);
  const urls = new Set(filteredUrls);
  if (urls.size === 0) return batch;

  const now = timestamp(at);
  const items = batch.items.map((item) => {
    if (item.status !== 'queued' || !urls.has(item.url)) return item;
    return {
      ...item,
      status: 'filtered' as const,
      analysis: null,
      comment: null,
      commentFingerprint: null,
      prepared: null,
      partialPageAllowed: false,
      message: boundedMessage(message),
      events: appendStatusEvent(item, 'filtered', message, now),
      updatedAt: now,
    };
  });

  const nextIndex = items.findIndex(
    (item) => !terminalItemStatuses.has(item.status)
  );

  return legalSnapshot({
    ...batch,
    status: nextIndex === -1 ? 'completed' : 'running',
    items,
    currentIndex: nextIndex === -1 ? items.length : nextIndex,
    updatedAt: now,
  });
}

export function updateBatchProgress(
  batch: BatchSnapshot,
  update: BatchProgressUpdate,
  at?: number
): BatchSnapshot {
  requireRunning(batch);
  const now = timestamp(at);
  let items = batch.items;

  if (update.item) {
    const item = currentItem(batch);
    if (update.item.status && !progressStatuses.has(update.item.status)) {
      throw new Error('BATCH_ITEM_PROGRESS_INVALID');
    }
    const status = update.item.status ?? item.status;
    const message = update.item.message ?? item.message;
    items = replaceCurrentItem(batch, {
      ...item,
      ...update.item,
      events: appendStatusEvent(item, status, message, now),
      updatedAt: now,
    });
  }

  const next: BatchSnapshot = {
    ...batch,
    items,
    updatedAt: now,
  };

  if (Object.hasOwn(update, 'websiteProfile')) {
    next.websiteProfile = update.websiteProfile ?? null;
  }
  if (update.workerTabId === null) {
    Reflect.deleteProperty(next, 'workerTabId');
  } else if (update.workerTabId !== undefined) {
    next.workerTabId = update.workerTabId;
  }

  return legalSnapshot(next);
}

export function pauseCurrentItem(
  batch: BatchSnapshot,
  status: PauseStatus,
  message = '',
  at?: number
): BatchSnapshot {
  requireRunning(batch);
  const now = timestamp(at);
  const item = currentItem(batch);

  return legalSnapshot({
    ...batch,
    status: 'paused',
    items: replaceCurrentItem(batch, {
      ...item,
      status,
      message: boundedMessage(message),
      events: appendStatusEvent(item, status, message, now),
      updatedAt: now,
    }),
    updatedAt: now,
  });
}

export function completeCurrentItem(
  batch: BatchSnapshot,
  status: CompletionStatus,
  message = '',
  at?: number
): BatchSnapshot {
  requireRunning(batch);
  const now = timestamp(at);
  const item = currentItem(batch);

  // Advance past items that are already terminal. In the normal sequential
  // flow every later item is still 'queued', so this stops immediately at
  // currentIndex + 1 and behaves exactly as before. After a retry has rewound
  // the cursor, earlier-processed items remain terminal and are skipped so the
  // batch only completes once every item has settled.
  let nextIndex = batch.currentIndex + 1;
  while (nextIndex < batch.items.length) {
    const candidate = batch.items[nextIndex];
    if (!candidate || !terminalItemStatuses.has(candidate.status)) break;
    nextIndex += 1;
  }

  return legalSnapshot({
    ...batch,
    status: nextIndex === batch.items.length ? 'completed' : 'running',
    items: replaceCurrentItem(batch, {
      ...item,
      status,
      analysis: null,
      prepared: null,
      message: boundedMessage(message),
      events: appendStatusEvent(item, status, message, now),
      updatedAt: now,
    }),
    currentIndex: nextIndex,
    updatedAt: now,
  });
}

// Rebuilds a terminal batch into a fresh run of the selected items. Their
// prior analysis/comment/prepared payloads are cleared so each retried target
// is regenerated from scratch; untouched items keep their recorded outcome.
export function retryItems(
  batch: BatchSnapshot,
  itemIds: string[],
  at?: number
): BatchSnapshot {
  if (batch.status !== 'completed' && batch.status !== 'stopped') {
    throw new Error('BATCH_RETRY_UNAVAILABLE');
  }
  const targetIds = new Set(itemIds);
  if (targetIds.size === 0) throw new Error('BATCH_ITEM_NOT_RETRYABLE');

  const retryIndices: number[] = [];
  batch.items.forEach((item, index) => {
    if (targetIds.has(item.id)) retryIndices.push(index);
  });
  const everyTargetRetryable =
    retryIndices.length === targetIds.size &&
    retryIndices.every((index) => {
      const item = batch.items[index];
      return Boolean(item && retryableItemStatuses.has(item.status));
    });
  if (!everyTargetRetryable) throw new Error('BATCH_ITEM_NOT_RETRYABLE');

  const now = timestamp(at);
  const retrySet = new Set(retryIndices);
  const items = batch.items.map((item, index) =>
    retrySet.has(index)
      ? {
          ...item,
          status: 'queued' as const,
          analysis: null,
          comment: null,
          commentFingerprint: null,
          prepared: null,
          message: '',
          events: appendStatusEvent(item, 'queued', 'BATCH_ITEM_RETRY', now),
          updatedAt: now,
        }
      : item
  );

  const next: BatchSnapshot = {
    ...batch,
    status: 'running',
    items,
    currentIndex: Math.min(...retryIndices),
    updatedAt: now,
  };
  // The worker tab from the finished run was closed at terminal; force a fresh
  // one rather than trusting a stale id.
  Reflect.deleteProperty(next, 'workerTabId');
  return legalSnapshot(next);
}

export function resumeBatch(batch: BatchSnapshot, at?: number): BatchSnapshot {
  if (batch.status !== 'paused') return batch;

  const now = timestamp(at);
  const item = currentItem(batch);
  if (item.status !== 'login_required' && item.status !== 'captcha_required') {
    throw new Error('BATCH_PAUSE_STATE_INVALID');
  }

  return legalSnapshot({
    ...batch,
    status: 'running',
    items: replaceCurrentItem(batch, {
      ...item,
      status: 'opening',
      message: item.prepared
        ? 'BATCH_RESUME_VERIFICATION_REQUIRED'
        : 'BATCH_RESUME_TARGET_REQUIRED',
      events: appendStatusEvent(
        item,
        'opening',
        item.prepared
          ? 'BATCH_RESUME_VERIFICATION_REQUIRED'
          : 'BATCH_RESUME_TARGET_REQUIRED',
        now
      ),
      updatedAt: now,
    }),
    updatedAt: now,
  });
}

/**
 * Settles a pre-submit manual gate without pretending it was filtered. This is
 * intentionally unavailable after a click was dispatched: that path must
 * resume verification so a potentially published comment is never lost or
 * submitted again.
 */
export function skipCurrentManualGate(
  batch: BatchSnapshot,
  at?: number
): BatchSnapshot {
  if (batch.status !== 'paused') {
    throw new Error('BATCH_SKIP_UNAVAILABLE');
  }

  const item = currentItem(batch);
  if (
    (item.status !== 'login_required' && item.status !== 'captcha_required') ||
    item.prepared
  ) {
    throw new Error('BATCH_SKIP_UNAVAILABLE');
  }

  // completeCurrentItem deliberately operates only on a running batch. The
  // transition is internal and immediately settles this exact paused item.
  const running: BatchSnapshot = { ...batch, status: 'running' };
  const message =
    item.status === 'login_required'
      ? 'LOGIN_REQUIRED_SKIPPED'
      : 'CAPTCHA_REQUIRED_SKIPPED';
  const completed = completeCurrentItem(running, item.status, message, at);
  const completedItem = completed.items[batch.currentIndex];
  if (!completedItem) return completed;
  const events = [
    ...completedItem.events,
    { status: item.status, message, at: timestamp(at) },
  ].slice(-32);
  return legalSnapshot({
    ...completed,
    items: completed.items.map((candidate, index) =>
      index === batch.currentIndex ? { ...candidate, events } : candidate
    ),
  });
}

const preservedStopStatuses = new Set<BatchItemStatus>([
  'click_dispatched',
  'verifying',
  'published',
  'pending_moderation',
  'unconfirmed',
  'submitted',
  'no_form',
  'validation_error',
  'failed',
  'filtered',
  'stopped',
]);

const settledItemStatuses = new Set<BatchItemStatus>([
  'published',
  'pending_moderation',
  'unconfirmed',
  'submitted',
  'login_required',
  'captcha_required',
  'no_form',
  'validation_error',
  'failed',
  'filtered',
]);

export function stopBatch(batch: BatchSnapshot, at?: number): BatchSnapshot {
  if (batch.status === 'stopped' || batch.status === 'completed') return batch;

  const now = timestamp(at);
  return legalSnapshot({
    ...batch,
    status: 'stopped',
    items: batch.items.map((item) =>
      preservedStopStatuses.has(item.status)
        ? item
        : {
            ...item,
            status: 'stopped',
            events: appendStatusEvent(item, 'stopped', '', now),
            updatedAt: now,
          }
    ),
    updatedAt: now,
  });
}

// Resumes every unresolved item from a manually stopped batch without
// re-submitting a comment whose click was already dispatched. A stopped item
// was never terminal; it is restarted from the queue. In contrast,
// click_dispatched and verifying deliberately retain their state and prepared
// submission payload so the runner can verify the original click instead of
// clicking the form a second time.
export function resumeStoppedBatch(
  batch: BatchSnapshot,
  at?: number
): BatchSnapshot {
  if (batch.status !== 'stopped') {
    throw new Error('BATCH_RESUME_UNAVAILABLE');
  }

  const unresolvedIndices = batch.items.flatMap((item, index) =>
    settledItemStatuses.has(item.status) ? [] : [index]
  );
  if (unresolvedIndices.length === 0) {
    throw new Error('BATCH_NOT_RUNNABLE');
  }

  const now = timestamp(at);
  const items = batch.items.map((item) => {
    if (settledItemStatuses.has(item.status)) return item;
    if (item.status === 'click_dispatched' || item.status === 'verifying') {
      return item;
    }
    return {
      ...item,
      status: 'queued' as const,
      analysis: null,
      comment: null,
      commentFingerprint: null,
      prepared: null,
      partialPageAllowed: false,
      message: '',
      events: appendStatusEvent(item, 'queued', 'BATCH_RESUME', now),
      updatedAt: now,
    };
  });

  return legalSnapshot({
    ...batch,
    status: 'running',
    items,
    currentIndex: Math.min(...unresolvedIndices),
    updatedAt: now,
  });
}
