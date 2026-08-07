import type { ModerationCheckResult } from '@/page/types';
import {
  type PublicCommentCheck,
  type PublicCommentQuery,
  checkPublicComment,
} from '@/verify/public-comment';
import type { PendingModerationCheck, RecordModerationCheckInput } from './db';
import type { PlanTarget } from './model';

export const PENDING_MODERATION_RECHECK_ALARM =
  'comment-link-assistant.pending-moderation-recheck';
export const PENDING_MODERATION_RECHECK_INTERVAL_MINUTES = 6 * 60;
export const MAX_PENDING_MODERATION_CHECKS_PER_RUN = 12;
export const MODERATION_RECHECK_SETTINGS_STORAGE_KEY =
  'comment-link-assistant.moderation-recheck-settings';
export const MODERATION_RECHECK_LAST_RUN_STORAGE_KEY =
  'comment-link-assistant.moderation-recheck-last-run';
export const MANUAL_MODERATION_ENTRIES_STORAGE_KEY =
  'comment-link-assistant.manual-moderation-entries';

export interface ModerationRecheckSettings {
  intervalMinutes: number;
  maxChecksPerRun: number;
}

export const DEFAULT_MODERATION_RECHECK_SETTINGS: ModerationRecheckSettings = {
  intervalMinutes: PENDING_MODERATION_RECHECK_INTERVAL_MINUTES,
  maxChecksPerRun: MAX_PENDING_MODERATION_CHECKS_PER_RUN,
};

export interface ModerationRecheckLastRun extends ModerationRecheckRunResult {
  startedAt: number;
  completedAt: number;
}

export interface ManualModerationEntry {
  id: string;
  pageUrl: string;
  targetWebsiteUrl: string;
  /** WordPress comment id, when the submit receipt captured one. */
  commentId?: string;
  status: 'pending_moderation' | 'published' | 'link_stripped';
  checkCount: number;
  lastCheckAt?: number;
  lastCheckMessage?: string;
  publishedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ModerationQueueItem {
  id: string;
  source: 'plan' | 'manual';
  targetId?: string;
  attemptId?: string;
  planId?: string;
  url: string;
  fingerprint: string;
  targetWebsiteUrl?: string;
  checkCount: number;
  lastCheckAt?: number;
  lastCheckMessage?: string;
}

export interface ModerationPublishedRecord {
  id: string;
  source: 'plan' | 'manual';
  targetId?: string;
  planId?: string;
  url: string;
  fingerprint: string;
  targetWebsiteUrl?: string;
  checkCount: number;
  publishedAt: number;
  message: string;
}

export interface ModerationRecheckDashboardData {
  settings: ModerationRecheckSettings;
  nextRunAt?: number;
  running: boolean;
  lastRun?: ModerationRecheckLastRun;
  pending: ModerationQueueItem[];
  published: ModerationPublishedRecord[];
}

type StoragePort = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

function normalizeModerationRecheckSettings(
  value: unknown
): ModerationRecheckSettings {
  const candidate = value as Partial<ModerationRecheckSettings> | null;
  const intervalMinutes = Number(candidate?.intervalMinutes);
  const maxChecksPerRun = Number(candidate?.maxChecksPerRun);
  return {
    intervalMinutes:
      Number.isFinite(intervalMinutes) && intervalMinutes >= 60
        ? Math.min(10_080, Math.floor(intervalMinutes))
        : DEFAULT_MODERATION_RECHECK_SETTINGS.intervalMinutes,
    maxChecksPerRun:
      Number.isFinite(maxChecksPerRun) && maxChecksPerRun >= 1
        ? Math.min(100, Math.floor(maxChecksPerRun))
        : DEFAULT_MODERATION_RECHECK_SETTINGS.maxChecksPerRun,
  };
}

export async function loadModerationRecheckSettings(
  storage: StoragePort = chrome.storage.local
): Promise<ModerationRecheckSettings> {
  const stored = await storage.get(MODERATION_RECHECK_SETTINGS_STORAGE_KEY);
  return normalizeModerationRecheckSettings(
    stored[MODERATION_RECHECK_SETTINGS_STORAGE_KEY]
  );
}

export async function saveModerationRecheckSettings(
  settings: ModerationRecheckSettings,
  storage: StoragePort = chrome.storage.local
): Promise<ModerationRecheckSettings> {
  const normalized = normalizeModerationRecheckSettings(settings);
  await storage.set({
    [MODERATION_RECHECK_SETTINGS_STORAGE_KEY]: normalized,
  });
  return normalized;
}

export async function loadModerationRecheckLastRun(
  storage: StoragePort = chrome.storage.local
): Promise<ModerationRecheckLastRun | undefined> {
  const stored = await storage.get(MODERATION_RECHECK_LAST_RUN_STORAGE_KEY);
  const value = stored[MODERATION_RECHECK_LAST_RUN_STORAGE_KEY];
  if (!value || typeof value !== 'object') return undefined;
  return value as ModerationRecheckLastRun;
}

export async function saveModerationRecheckLastRun(
  result: ModerationRecheckLastRun,
  storage: StoragePort = chrome.storage.local
): Promise<void> {
  await storage.set({ [MODERATION_RECHECK_LAST_RUN_STORAGE_KEY]: result });
}

function normalizedHttpUrl(value: string, preserveHash = false): string {
  const url = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error('MODERATION_RECHECK_URL_INVALID');
  }
  if (!preserveHash) url.hash = '';
  return url.href.replace(/\/$/, '');
}

export async function loadManualModerationEntries(
  storage: StoragePort = chrome.storage.local
): Promise<ManualModerationEntry[]> {
  const stored = await storage.get(MANUAL_MODERATION_ENTRIES_STORAGE_KEY);
  const entries = stored[MANUAL_MODERATION_ENTRIES_STORAGE_KEY];
  return Array.isArray(entries) ? (entries as ManualModerationEntry[]) : [];
}

export async function addManualModerationEntry(
  input: { pageUrl: string; targetWebsiteUrl: string },
  storage: StoragePort = chrome.storage.local,
  now = Date.now(),
  idFactory: () => string = () => crypto.randomUUID()
): Promise<ManualModerationEntry> {
  const pageUrl = normalizedHttpUrl(input.pageUrl, true);
  const targetWebsiteUrl = normalizedHttpUrl(input.targetWebsiteUrl);
  const entries = await loadManualModerationEntries(storage);
  if (
    entries.some(
      (entry) =>
        entry.pageUrl === pageUrl &&
        entry.targetWebsiteUrl === targetWebsiteUrl &&
        entry.status === 'pending_moderation'
    )
  ) {
    throw new Error('MODERATION_RECHECK_ENTRY_EXISTS');
  }
  const entry: ManualModerationEntry = {
    id: idFactory(),
    pageUrl,
    targetWebsiteUrl,
    status: 'pending_moderation',
    checkCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await storage.set({
    [MANUAL_MODERATION_ENTRIES_STORAGE_KEY]: [entry, ...entries].slice(0, 500),
  });
  return entry;
}

async function recordManualModerationResult(
  entryId: string,
  result: Pick<ModerationCheckResult, 'status' | 'message'>,
  storage: StoragePort = chrome.storage.local,
  at = Date.now()
): Promise<ManualModerationEntry> {
  const entries = await loadManualModerationEntries(storage);
  const original = entries.find((entry) => entry.id === entryId);
  if (!original) throw new Error('MODERATION_RECHECK_ENTRY_NOT_FOUND');
  const published = result.status === 'published';
  // A stripped link settles the entry too: the comment is public, just useless.
  const settled =
    result.status === 'published' || result.status === 'link_stripped'
      ? result.status
      : null;
  const updated: ManualModerationEntry = {
    ...original,
    status: settled ?? 'pending_moderation',
    checkCount: original.checkCount + 1,
    lastCheckAt: at,
    lastCheckMessage: result.message,
    updatedAt: at,
    ...(published ? { publishedAt: at } : {}),
  };
  await storage.set({
    [MANUAL_MODERATION_ENTRIES_STORAGE_KEY]: entries.map((entry) =>
      entry.id === entryId ? updated : entry
    ),
  });
  return updated;
}

export interface ModerationRecheckStore {
  getPendingModerationChecks(limit?: number): Promise<PendingModerationCheck[]>;
  recordModerationCheck(
    input: RecordModerationCheckInput
  ): Promise<PlanTarget | null>;
}

/**
 * Reads the target page as an anonymous visitor. No tab, no session: a comment
 * counts as published here for the same reason it does at submit time — someone
 * who is not its author can see it.
 */
export interface PublicCommentPort {
  check(query: PublicCommentQuery): Promise<PublicCommentCheck>;
}

export function createPublicCommentPort(): PublicCommentPort {
  return { check: (query) => checkPublicComment(query) };
}

/** Maps a public read onto the states this job records. Only `visible` and
 *  `link_stripped` are decisions; everything else keeps the item queued. */
export function moderationResultFromPublicCheck(
  check: PublicCommentCheck,
  fingerprint = ''
): ModerationCheckResult {
  if (check.visibility === 'visible') {
    return {
      status: 'published',
      message: 'COMMENT_PUBLISHED_PUBLIC_CHECK',
      fingerprint,
    };
  }
  // The comment is public with no link in it. Re-checking it forever would
  // never change the answer, so this leaves the queue.
  if (check.visibility === 'link_stripped') {
    return {
      status: 'link_stripped',
      message: 'COMMENT_PUBLIC_LINK_STRIPPED',
      fingerprint,
    };
  }
  return {
    status: 'pending_moderation',
    message:
      check.visibility === 'not_visible'
        ? 'COMMENT_PENDING_MODERATION_NOT_VISIBLE'
        : 'COMMENT_PENDING_MODERATION_RECHECK_UNAVAILABLE',
    fingerprint,
  };
}

export async function recheckManualModerationEntry(
  entryId: string,
  port: PublicCommentPort,
  storage: StoragePort = chrome.storage.local
): Promise<ManualModerationEntry> {
  const entry = (await loadManualModerationEntries(storage)).find(
    (candidate) => candidate.id === entryId
  );
  if (!entry) throw new Error('MODERATION_RECHECK_ENTRY_NOT_FOUND');
  try {
    const check = await port.check({
      pageUrl: entry.pageUrl,
      websiteUrl: entry.targetWebsiteUrl,
      ...(entry.commentId ? { commentId: entry.commentId } : {}),
    });
    return await recordManualModerationResult(
      entry.id,
      moderationResultFromPublicCheck(check),
      storage
    );
  } catch {
    return await recordManualModerationResult(
      entry.id,
      {
        status: 'pending_moderation',
        message: 'COMMENT_PENDING_MODERATION_RECHECK_UNAVAILABLE',
      },
      storage
    );
  }
}

export async function runManualModerationRechecks(
  port: PublicCommentPort,
  limit: number,
  storage: StoragePort = chrome.storage.local
): Promise<ModerationRecheckRunResult> {
  if (!Number.isFinite(limit) || limit <= 0) {
    return {
      selected: 0,
      checked: 0,
      published: 0,
      linkStripped: 0,
      stillPending: 0,
    };
  }
  const selected = (await loadManualModerationEntries(storage))
    .filter((entry) => entry.status === 'pending_moderation')
    .sort(
      (left, right) =>
        (left.lastCheckAt ?? 0) - (right.lastCheckAt ?? 0) ||
        left.createdAt - right.createdAt
    )
    .slice(0, Math.max(1, Math.min(100, Math.floor(limit))));
  const summary: ModerationRecheckRunResult = {
    selected: selected.length,
    checked: 0,
    published: 0,
    linkStripped: 0,
    stillPending: 0,
  };
  for (const entry of selected) {
    const result = await recheckManualModerationEntry(entry.id, port, storage);
    summary.checked += 1;
    if (result.status === 'published') summary.published += 1;
    else if (result.status === 'link_stripped') summary.linkStripped += 1;
    else summary.stillPending += 1;
  }
  return summary;
}

export interface ModerationRecheckRunResult {
  selected: number;
  checked: number;
  published: number;
  /** Public, but with the promoted link removed. Counted apart from published:
   *  the comment landed and the link did not. */
  linkStripped: number;
  stillPending: number;
}

type AlarmPort = Pick<typeof chrome.alarms, 'create' | 'get'>;

/** Keeps a six-hour recurring alarm even when there are no pending records. */
export async function armPendingModerationRecheckAlarm(
  alarms: AlarmPort = chrome.alarms,
  settings: ModerationRecheckSettings = DEFAULT_MODERATION_RECHECK_SETTINGS
): Promise<void> {
  const existing = await alarms.get(PENDING_MODERATION_RECHECK_ALARM);
  // Recreating an existing alarm resets its next fire to six hours from every
  // service-worker restart. Keep a matching schedule intact instead.
  if (existing?.periodInMinutes === settings.intervalMinutes) {
    return;
  }
  await alarms.create(PENDING_MODERATION_RECHECK_ALARM, {
    delayInMinutes: settings.intervalMinutes,
    periodInMinutes: settings.intervalMinutes,
  });
}

function pendingMessage(result: ModerationCheckResult): string {
  if (result.status === 'login_required') {
    return 'COMMENT_PENDING_MODERATION_RECHECK_LOGIN_REQUIRED';
  }
  if (result.status === 'captcha_required') {
    return 'COMMENT_PENDING_MODERATION_RECHECK_CAPTCHA_REQUIRED';
  }
  return result.message || 'COMMENT_PENDING_MODERATION_NOT_VISIBLE';
}

function unavailableInput(
  check: PendingModerationCheck
): RecordModerationCheckInput {
  return {
    targetId: check.targetId,
    attemptId: check.attemptId,
    status: 'pending_moderation',
    message: 'COMMENT_PENDING_MODERATION_RECHECK_UNAVAILABLE',
  };
}

/**
 * Called once a held comment is confirmed live. This is where a link that was
 * only provisional becomes part of the promoted site's real anchor mix.
 */
export type ModerationPublishedListener = (
  check: PendingModerationCheck
) => Promise<void>;

/** Called once a comment turns out to be public without its link, so the mix
 *  slot it was holding can be released instead of waiting forever. */
export type ModerationLinkStrippedListener = (
  check: PendingModerationCheck
) => Promise<void>;

export class PendingModerationRecheckCoordinator {
  private running: Promise<ModerationRecheckRunResult> | null = null;

  constructor(
    private readonly store: ModerationRecheckStore,
    private readonly port: PublicCommentPort,
    private readonly limit = MAX_PENDING_MODERATION_CHECKS_PER_RUN,
    private readonly onPublished?: ModerationPublishedListener,
    private readonly onLinkStripped?: ModerationLinkStrippedListener
  ) {}

  run(): Promise<ModerationRecheckRunResult> {
    if (!this.running) {
      this.running = this.runOnce().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runOnce(): Promise<ModerationRecheckRunResult> {
    const checks = await this.store.getPendingModerationChecks(this.limit);
    const result: ModerationRecheckRunResult = {
      selected: checks.length,
      checked: 0,
      published: 0,
      linkStripped: 0,
      stillPending: 0,
    };
    if (checks.length === 0) return result;

    // No tab is opened at all: each check is a plain anonymous request.
    for (const check of checks) {
      try {
        const verification = moderationResultFromPublicCheck(
          await this.port.check({
            // The receipt URL resolves to the right comment page by itself.
            pageUrl: check.receiptUrl ?? check.url,
            websiteUrl: check.targetWebsiteUrl,
            ...(check.commentId ? { commentId: check.commentId } : {}),
          }),
          check.fingerprint
        );
        result.checked += 1;
        if (verification.status === 'published') {
          await this.store.recordModerationCheck({
            targetId: check.targetId,
            attemptId: check.attemptId,
            status: 'published',
            message: verification.message,
          });
          // A listener failure must not turn a confirmed publication back
          // into a pending one.
          await this.onPublished?.(check).catch(() => undefined);
          result.published += 1;
        } else if (verification.status === 'link_stripped') {
          // Terminal: the comment is public and carries no link. It leaves the
          // queue without ever counting toward the promoted site's anchor mix.
          await this.store.recordModerationCheck({
            targetId: check.targetId,
            attemptId: check.attemptId,
            status: 'link_stripped',
            message: verification.message,
          });
          await this.onLinkStripped?.(check).catch(() => undefined);
          result.linkStripped += 1;
        } else {
          await this.store.recordModerationCheck({
            targetId: check.targetId,
            attemptId: check.attemptId,
            status: 'pending_moderation',
            message: pendingMessage(verification),
          });
          result.stillPending += 1;
        }
      } catch {
        // An unreadable page preserves the pending state: "could not check"
        // is never recorded as a verdict. This job has no submit operation.
        await this.store.recordModerationCheck(unavailableInput(check));
        result.stillPending += 1;
      }
    }
    return result;
  }
}
