import type { ModerationCheckResult } from '@/page/types';
import { checkTabForPublishedComment } from '@/runtime/page-commands';
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
const TAB_LOAD_TIMEOUT_MS = 20_000;

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
  status: 'pending_moderation' | 'published';
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
  const updated: ManualModerationEntry = {
    ...original,
    status: published ? 'published' : 'pending_moderation',
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

/** A scanner-owned tab is reused for every target in one bounded scan. */
export interface ModerationVerificationTabPort {
  create(url: string): Promise<number>;
  navigate(tabId: number, url: string): Promise<void>;
  check(
    tabId: number,
    fingerprint: string,
    targetWebsiteUrl?: string
  ): Promise<ModerationCheckResult>;
  close(tabId: number): Promise<void>;
}

export async function recheckManualModerationEntry(
  entryId: string,
  tabs: ModerationVerificationTabPort,
  storage: StoragePort = chrome.storage.local
): Promise<ManualModerationEntry> {
  const entry = (await loadManualModerationEntries(storage)).find(
    (candidate) => candidate.id === entryId
  );
  if (!entry) throw new Error('MODERATION_RECHECK_ENTRY_NOT_FOUND');
  let tabId: number | null = null;
  try {
    tabId = await tabs.create(entry.pageUrl);
    const result = await tabs.check(tabId, '', entry.targetWebsiteUrl);
    return await recordManualModerationResult(entry.id, result, storage);
  } catch {
    return await recordManualModerationResult(
      entry.id,
      {
        status: 'pending_moderation',
        message: 'COMMENT_PENDING_MODERATION_RECHECK_UNAVAILABLE',
      },
      storage
    );
  } finally {
    if (tabId !== null) await tabs.close(tabId).catch(() => undefined);
  }
}

export async function runManualModerationRechecks(
  tabs: ModerationVerificationTabPort,
  limit: number,
  storage: StoragePort = chrome.storage.local
): Promise<ModerationRecheckRunResult> {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { selected: 0, checked: 0, published: 0, stillPending: 0 };
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
    stillPending: 0,
  };
  for (const entry of selected) {
    const result = await recheckManualModerationEntry(entry.id, tabs, storage);
    summary.checked += 1;
    if (result.status === 'published') summary.published += 1;
    else summary.stillPending += 1;
  }
  return summary;
}

export interface ModerationRecheckRunResult {
  selected: number;
  checked: number;
  published: number;
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

function waitForTabComplete(
  tabId: number,
  timeoutMs = TAB_LOAD_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error('MODERATION_RECHECK_LOAD_TIMEOUT')),
      timeoutMs
    );
    const onUpdated = (
      updatedTabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    void chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === 'complete') finish();
      },
      () => finish(new Error('MODERATION_RECHECK_TAB_UNAVAILABLE'))
    );
  });
}

/**
 * The only Chrome adapter used by the scanner. It opens an inactive, owned
 * verification tab, navigates it read-only, and always lets the caller close it.
 */
export function createChromeModerationVerificationTabPort(): ModerationVerificationTabPort {
  return {
    async create(url: string): Promise<number> {
      const tab = await chrome.tabs.create({ active: false, url });
      if (typeof tab.id !== 'number') {
        throw new Error('MODERATION_RECHECK_TAB_CREATE_FAILED');
      }
      try {
        await waitForTabComplete(tab.id);
        return tab.id;
      } catch (error) {
        // The coordinator only receives an id after create resolves. Reclaim a
        // tab whose first navigation failed before it can reach that finally.
        await chrome.tabs.remove(tab.id).catch(() => undefined);
        throw error;
      }
    },
    async navigate(tabId: number, url: string): Promise<void> {
      await chrome.tabs.update(tabId, { url });
      await waitForTabComplete(tabId);
    },
    check: checkTabForPublishedComment,
    async close(tabId: number): Promise<void> {
      await chrome.tabs.remove(tabId);
    },
  };
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

export class PendingModerationRecheckCoordinator {
  private running: Promise<ModerationRecheckRunResult> | null = null;

  constructor(
    private readonly store: ModerationRecheckStore,
    private readonly tabs: ModerationVerificationTabPort,
    private readonly limit = MAX_PENDING_MODERATION_CHECKS_PER_RUN
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
      stillPending: 0,
    };
    if (checks.length === 0) return result;

    let tabId: number | null = null;
    try {
      for (const check of checks) {
        try {
          if (tabId === null) tabId = await this.tabs.create(check.url);
          else await this.tabs.navigate(tabId, check.url);
          const verification = await this.tabs.check(
            tabId,
            check.fingerprint,
            check.targetWebsiteUrl
          );
          result.checked += 1;
          if (verification.status === 'published') {
            await this.store.recordModerationCheck({
              targetId: check.targetId,
              attemptId: check.attemptId,
              status: 'published',
              message: verification.message,
            });
            result.published += 1;
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
          // Network failures, restricted pages, and missing forms all preserve
          // the pending state. This job intentionally has no submit operation.
          await this.store.recordModerationCheck(unavailableInput(check));
          result.stillPending += 1;
        }
      }
    } finally {
      if (tabId !== null) await this.tabs.close(tabId).catch(() => undefined);
    }
    return result;
  }
}
