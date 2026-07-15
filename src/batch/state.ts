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
  'submitted_not_visible',
  'no_form',
  'validation_error',
  'unknown',
  'failed',
] as const satisfies readonly BatchItemStatus[];

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
  formPlanRefreshes?: BatchItem['formPlanRefreshes'];
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
    items = replaceCurrentItem(batch, {
      ...item,
      ...update.item,
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
  const nextIndex = batch.currentIndex + 1;

  return legalSnapshot({
    ...batch,
    status: nextIndex === batch.items.length ? 'completed' : 'running',
    items: replaceCurrentItem(batch, {
      ...item,
      status,
      analysis: null,
      comment: null,
      prepared: null,
      message: boundedMessage(message),
      updatedAt: now,
    }),
    currentIndex: nextIndex,
    updatedAt: now,
  });
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
      updatedAt: now,
    }),
    updatedAt: now,
  });
}

const preservedStopStatuses = new Set<BatchItemStatus>([
  'click_dispatched',
  'verifying',
  'published',
  'submitted_not_visible',
  'no_form',
  'validation_error',
  'unknown',
  'failed',
  'stopped',
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
        : { ...item, status: 'stopped', updatedAt: now }
    ),
    updatedAt: now,
  });
}
