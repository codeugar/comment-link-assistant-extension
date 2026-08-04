import type { BatchSnapshot } from '@/batch/types';
import { batchSnapshotSchema } from '@/batch/types';

export const BATCH_STORAGE_KEY = 'comment-link-assistant.batch';

function addLegacyItemEvents(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const snapshot = value as Record<string, unknown>;
  if (!Array.isArray(snapshot.items)) return value;
  let changed = false;
  const items = snapshot.items.map((item) => {
    if (!item || typeof item !== 'object' || Object.hasOwn(item, 'events')) {
      return item;
    }
    const legacy = item as Record<string, unknown>;
    changed = true;
    return {
      ...legacy,
      events: [
        {
          status: legacy.status,
          message: typeof legacy.message === 'string' ? legacy.message : '',
          at: legacy.updatedAt,
        },
      ],
    };
  });
  return changed ? { ...snapshot, items } : value;
}

// Prior releases used `submitted` for every post-click outcome, including a
// click with no receipt. Those records cannot be retroactively classified as
// public or held for moderation, so retain them as an explicit unknown result.
function migrateLegacySubmissionStatuses(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const snapshot = value as Record<string, unknown>;
  if (!Array.isArray(snapshot.items)) return value;
  let changed = false;
  const items = snapshot.items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const record = item as Record<string, unknown>;
    const status =
      record.status === 'submitted' ? 'unconfirmed' : record.status;
    const message =
      record.status === 'submitted'
        ? 'COMMENT_SUBMISSION_UNCONFIRMED'
        : record.message;
    const events = Array.isArray(record.events)
      ? record.events.map((event) => {
          if (!event || typeof event !== 'object') return event;
          const eventRecord = event as Record<string, unknown>;
          if (eventRecord.status !== 'submitted') return event;
          changed = true;
          return {
            ...eventRecord,
            status: 'unconfirmed',
            message: 'COMMENT_SUBMISSION_UNCONFIRMED',
          };
        })
      : record.events;
    if (status === record.status && events === record.events) return item;
    changed = true;
    return { ...record, status, message, events };
  });
  return changed ? { ...snapshot, items } : value;
}

// Login/CAPTCHA pauses from pre-auto-skip releases must not strand the queue
// after an update. A gate with a prepared submission may have already clicked,
// so retain it as an unconfirmed result; a gate before preparation remains an
// explicit skipped gate and can be retried after the library flag is cleared.
function migrateLegacyManualGatePause(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const snapshot = value as Record<string, unknown>;
  if (snapshot.status !== 'paused' || !Array.isArray(snapshot.items)) {
    return value;
  }
  const currentIndex =
    typeof snapshot.currentIndex === 'number' ? snapshot.currentIndex : -1;
  const items = snapshot.items.map((item) => item);
  const current = items[currentIndex];
  if (!current || typeof current !== 'object') return value;
  const record = current as Record<string, unknown>;
  if (
    record.status !== 'login_required' &&
    record.status !== 'captcha_required'
  ) {
    return value;
  }

  const clicked = Boolean(record.prepared);
  const status = clicked ? 'unconfirmed' : record.status;
  const message = clicked
    ? 'LEGACY_PAUSED_GATE_UNCONFIRMED'
    : record.status === 'login_required'
      ? 'LOGIN_REQUIRED_SKIPPED'
      : 'CAPTCHA_REQUIRED_SKIPPED';
  const updatedAt =
    typeof record.updatedAt === 'number' ? record.updatedAt : Date.now();
  const events = Array.isArray(record.events)
    ? [...record.events, { status, message, at: updatedAt }].slice(-32)
    : [{ status, message, at: updatedAt }];
  items[currentIndex] = {
    ...record,
    status,
    analysis: null,
    comment: null,
    commentFingerprint: null,
    prepared: null,
    partialPageAllowed: false,
    message,
    events,
    updatedAt,
  };

  const terminalStatuses = new Set([
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
  let nextIndex = currentIndex + 1;
  while (nextIndex < items.length) {
    const candidate = items[nextIndex];
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !terminalStatuses.has(
        (candidate as Record<string, unknown>).status as string
      )
    ) {
      break;
    }
    nextIndex += 1;
  }
  return {
    ...snapshot,
    status: nextIndex === items.length ? 'completed' : 'running',
    items,
    currentIndex: nextIndex === items.length ? items.length : nextIndex,
    updatedAt,
  };
}

export async function getBatch(): Promise<BatchSnapshot | null> {
  const stored = await chrome.storage.local.get(BATCH_STORAGE_KEY);
  const value = stored[BATCH_STORAGE_KEY];
  const withEvents = addLegacyItemEvents(value);
  const withSubmissionMigration = migrateLegacySubmissionStatuses(withEvents);
  const migrated = migrateLegacyManualGatePause(withSubmissionMigration);
  const migratedBatch = batchSnapshotSchema.safeParse(migrated);
  if (!migratedBatch.success) return null;
  if (migrated !== value) {
    await chrome.storage.local.set({
      [BATCH_STORAGE_KEY]: migratedBatch.data,
    });
  }
  return migratedBatch.data;
}

export async function setBatch(batch: BatchSnapshot): Promise<BatchSnapshot> {
  const parsed = batchSnapshotSchema.parse(batch);
  await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: parsed });
  return parsed;
}

export async function clearBatch(): Promise<void> {
  await chrome.storage.local.remove(BATCH_STORAGE_KEY);
}
