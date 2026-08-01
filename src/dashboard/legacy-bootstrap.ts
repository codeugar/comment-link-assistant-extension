import type { BatchHistoryEntry } from '@/storage/batch-history';
import {
  HISTORY_STORAGE_KEY,
  parseStoredBatchHistory,
} from '@/storage/batch-history';
import type { PlansMap } from '@/storage/plans';
import { PLANS_STORAGE_KEY, parseStoredPlans } from '@/storage/plans';

export interface LegacyDashboardStorageSources {
  plans: PlansMap;
  history: BatchHistoryEntry[];
  hasStoredPlans: boolean;
}

export interface LegacyDashboardStorageResult {
  removeLegacyPlans: boolean;
}

type LegacyDashboardStoragePort = Pick<
  chrome.storage.StorageArea,
  'get' | 'remove'
>;

function parseLegacyDashboardStorage(
  stored: Record<string, unknown>
): LegacyDashboardStorageSources {
  const storedPlans = stored[PLANS_STORAGE_KEY];
  const storedHistory = stored[HISTORY_STORAGE_KEY];
  const plans = storedPlans === undefined ? {} : parseStoredPlans(storedPlans);
  const history =
    storedHistory === undefined ? [] : parseStoredBatchHistory(storedHistory);
  if (!plans || !history) {
    throw new Error('DASHBOARD_MIGRATION_LEGACY_SOURCE_INVALID');
  }
  return {
    plans,
    history,
    hasStoredPlans: storedPlans !== undefined,
  };
}

/**
 * Runs migration work only after both legacy payloads validate. The caller can
 * request removal of the old plan definition key after the IndexedDB import,
 * but malformed legacy data is never treated as an empty payload or cleaned up.
 */
export async function processLegacyDashboardStorage<
  T extends LegacyDashboardStorageResult,
>(
  storage: LegacyDashboardStoragePort,
  process: (sources: LegacyDashboardStorageSources) => Promise<T>
): Promise<T> {
  const stored = await storage.get([PLANS_STORAGE_KEY, HISTORY_STORAGE_KEY]);
  const sources = parseLegacyDashboardStorage(stored);
  const result = await process(sources);
  if (result.removeLegacyPlans && sources.hasStoredPlans) {
    await storage.remove(PLANS_STORAGE_KEY);
  }
  return result;
}
