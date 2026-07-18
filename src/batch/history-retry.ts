import {
  type BatchHistoryEntry,
  isFailedHistoryStatus,
} from '@/storage/batch-history';
import type { BatchSettingsSnapshot, BatchSnapshot } from './types';

export interface HistoryRetryPlan {
  settings: BatchSettingsSnapshot;
  urls: string[];
}

// Resolves which archived urls a retry should re-run, using the entry's own
// recorded settings so the new batch keeps the original site/persona.
export function planHistoryRetry(
  history: BatchHistoryEntry[],
  historyId: string,
  urls?: string[]
): HistoryRetryPlan {
  const entry = history.find((candidate) => candidate.id === historyId);
  if (!entry) throw new Error('HISTORY_ENTRY_NOT_FOUND');

  let targetUrls: string[];
  if (urls === undefined) {
    targetUrls = entry.items
      .filter((item) => isFailedHistoryStatus(item.status))
      .map((item) => item.url);
  } else {
    const known = new Set(entry.items.map((item) => item.url));
    if (!urls.every((url) => known.has(url))) {
      throw new Error('HISTORY_URL_NOT_FOUND');
    }
    targetUrls = urls;
  }

  if (targetUrls.length === 0) throw new Error('HISTORY_NO_FAILED_ITEMS');
  return { settings: entry.settings, urls: targetUrls };
}

export interface HistoryRetryDependencies {
  getBatchHistory(): Promise<BatchHistoryEntry[]>;
  getBatch(): Promise<BatchSnapshot | null>;
  archiveBatch(snapshot: BatchSnapshot): Promise<void>;
  clearBatch(): Promise<void>;
  startBatch(
    targetText: string,
    settings: BatchSettingsSnapshot
  ): Promise<BatchSnapshot>;
}

export async function runHistoryRetry(
  dependencies: HistoryRetryDependencies,
  historyId: string,
  urls?: string[]
): Promise<BatchSnapshot> {
  const history = await dependencies.getBatchHistory();
  const plan = planHistoryRetry(history, historyId, urls);

  const current = await dependencies.getBatch();
  if (current?.status === 'running' || current?.status === 'paused') {
    throw new Error('BATCH_ALREADY_ACTIVE');
  }
  // A finished current batch is moved to history and cleared before the new run
  // takes its place. If the start below throws, the terminal batch is already
  // preserved in history rather than silently overwritten.
  if (current) {
    await dependencies.archiveBatch(current);
    await dependencies.clearBatch();
  }

  return dependencies.startBatch(plan.urls.join('\n'), plan.settings);
}
