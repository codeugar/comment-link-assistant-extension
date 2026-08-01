import { HISTORY_STORAGE_KEY } from '@/storage/batch-history';
import { PLANS_STORAGE_KEY } from '@/storage/plans';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { processLegacyDashboardStorage } from './legacy-bootstrap';

describe('legacy dashboard storage bootstrap', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('keeps malformed legacy payloads intact instead of treating them as empty', async () => {
    const storage = {
      get: vi.fn().mockResolvedValue({
        [PLANS_STORAGE_KEY]: { malformed: true },
        [HISTORY_STORAGE_KEY]: [],
      }),
      remove: vi.fn(),
    };
    const migrate = vi.fn();

    await expect(
      processLegacyDashboardStorage(storage, async (sources) => {
        migrate(sources);
        return { removeLegacyPlans: true };
      })
    ).rejects.toThrow('DASHBOARD_MIGRATION_LEGACY_SOURCE_INVALID');

    expect(migrate).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('removes only migrated plan definitions and retains legacy history', async () => {
    const storage = {
      get: vi.fn().mockResolvedValue({
        [PLANS_STORAGE_KEY]: {},
        [HISTORY_STORAGE_KEY]: [],
      }),
      remove: vi.fn(),
    };

    await processLegacyDashboardStorage(storage, async () => ({
      removeLegacyPlans: true,
    }));

    expect(storage.remove).toHaveBeenCalledWith(PLANS_STORAGE_KEY);
    expect(storage.remove).not.toHaveBeenCalledWith(HISTORY_STORAGE_KEY);
  });
});
