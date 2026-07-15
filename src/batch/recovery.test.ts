import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { BATCH_RECOVERY_ALARM, armBatchRecoveryAlarm } from './recovery';

describe('batch recovery alarm', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('uses a repeating alarm so an in-flight wake cannot consume recovery', async () => {
    const create = vi.spyOn(chrome.alarms, 'create');

    await armBatchRecoveryAlarm();

    expect(create).toHaveBeenCalledWith(BATCH_RECOVERY_ALARM, {
      delayInMinutes: 0.5,
      periodInMinutes: 0.5,
    });
  });
});
