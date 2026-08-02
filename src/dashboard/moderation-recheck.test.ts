import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingModerationCheck } from './db';
import {
  MAX_PENDING_MODERATION_CHECKS_PER_RUN,
  type ModerationRecheckStore,
  type ModerationVerificationTabPort,
  PENDING_MODERATION_RECHECK_ALARM,
  PENDING_MODERATION_RECHECK_INTERVAL_MINUTES,
  PendingModerationRecheckCoordinator,
  addManualModerationEntry,
  armPendingModerationRecheckAlarm,
  createChromeModerationVerificationTabPort,
  loadManualModerationEntries,
  loadModerationRecheckSettings,
  recheckManualModerationEntry,
  saveModerationRecheckSettings,
} from './moderation-recheck';

const checks: PendingModerationCheck[] = [
  {
    targetId: 'target-1',
    attemptId: 'attempt-1',
    planId: 'plan-1',
    url: 'https://blog.example/one',
    targetWebsiteUrl: 'https://product.example',
    fingerprint: 'A useful generated comment',
    checkCount: 0,
  },
  {
    targetId: 'target-2',
    attemptId: 'attempt-2',
    planId: 'plan-1',
    url: 'https://blog.example/two',
    targetWebsiteUrl: 'https://product.example',
    fingerprint: 'Another useful generated comment',
    checkCount: 0,
  },
];

function storeFor(
  selected: PendingModerationCheck[] = checks
): ModerationRecheckStore & {
  getPendingModerationChecks: ReturnType<typeof vi.fn>;
  recordModerationCheck: ReturnType<typeof vi.fn>;
} {
  return {
    getPendingModerationChecks: vi.fn().mockResolvedValue(selected),
    recordModerationCheck: vi.fn().mockResolvedValue(null),
  };
}

function tabsFor(
  status: 'published' | 'pending_moderation' = 'pending_moderation'
): ModerationVerificationTabPort & {
  create: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  check: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn().mockResolvedValue(91),
    navigate: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue({
      status,
      message:
        status === 'published'
          ? 'COMMENT_PUBLISHED_RENDERED_FINGERPRINT'
          : 'COMMENT_PENDING_MODERATION_NOT_VISIBLE',
      fingerprint: checks[0]!.fingerprint,
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('pending moderation recheck', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('schedules the bounded recheck every six hours', async () => {
    const create = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue(undefined);
    await armPendingModerationRecheckAlarm({ create, get } as never);

    expect(create).toHaveBeenCalledWith(PENDING_MODERATION_RECHECK_ALARM, {
      delayInMinutes: PENDING_MODERATION_RECHECK_INTERVAL_MINUTES,
      periodInMinutes: PENDING_MODERATION_RECHECK_INTERVAL_MINUTES,
    });
  });

  it('keeps an existing six-hour alarm without resetting its next fire', async () => {
    const create = vi.fn();
    const get = vi.fn().mockResolvedValue({
      name: PENDING_MODERATION_RECHECK_ALARM,
      scheduledTime: 9_999,
      periodInMinutes: PENDING_MODERATION_RECHECK_INTERVAL_MINUTES,
    });

    await armPendingModerationRecheckAlarm({ create, get } as never);

    expect(get).toHaveBeenCalledWith(PENDING_MODERATION_RECHECK_ALARM);
    expect(create).not.toHaveBeenCalled();
  });

  it('persists bounded dashboard scheduling settings', async () => {
    const state: Record<string, unknown> = {};
    const storage = {
      get: vi.fn(async (key: string) => ({ [key]: state[key] })),
      set: vi.fn(async (values: Record<string, unknown>) => {
        Object.assign(state, values);
      }),
    };

    await expect(
      saveModerationRecheckSettings(
        { intervalMinutes: 120, maxChecksPerRun: 25 },
        storage as never
      )
    ).resolves.toEqual({ intervalMinutes: 120, maxChecksPerRun: 25 });
    await expect(
      loadModerationRecheckSettings(storage as never)
    ).resolves.toEqual({ intervalMinutes: 120, maxChecksPerRun: 25 });
  });

  it('adds and checks a manual page plus target-website pair', async () => {
    const state: Record<string, unknown> = {};
    const storage = {
      get: vi.fn(async (key: string) => ({ [key]: state[key] })),
      set: vi.fn(async (values: Record<string, unknown>) => {
        Object.assign(state, values);
      }),
    };
    const tabs = tabsFor('published');
    const entry = await addManualModerationEntry(
      {
        pageUrl: 'https://blog.example/article#comment-42',
        targetWebsiteUrl: 'https://product.example/',
      },
      storage as never,
      100,
      () => 'manual-1'
    );

    expect(entry).toMatchObject({
      id: 'manual-1',
      pageUrl: 'https://blog.example/article#comment-42',
      targetWebsiteUrl: 'https://product.example',
      status: 'pending_moderation',
    });
    await expect(
      recheckManualModerationEntry('manual-1', tabs, storage as never)
    ).resolves.toMatchObject({
      status: 'published',
      checkCount: 1,
    });
    expect(tabs.check).toHaveBeenCalledWith(91, '', 'https://product.example');
    expect(await loadManualModerationEntries(storage as never)).toEqual([
      expect.objectContaining({ id: 'manual-1', status: 'published' }),
    ]);
  });

  it('selects only the durable pending records and reuses one verification tab', async () => {
    const store = storeFor();
    const tabs = tabsFor();
    const scanner = new PendingModerationRecheckCoordinator(
      store,
      tabs,
      MAX_PENDING_MODERATION_CHECKS_PER_RUN
    );

    await expect(scanner.run()).resolves.toEqual({
      selected: 2,
      checked: 2,
      published: 0,
      stillPending: 2,
    });
    expect(store.getPendingModerationChecks).toHaveBeenCalledWith(
      MAX_PENDING_MODERATION_CHECKS_PER_RUN
    );
    expect(tabs.create).toHaveBeenCalledOnce();
    expect(tabs.navigate).toHaveBeenCalledWith(91, checks[1]!.url);
    expect(tabs.check).toHaveBeenCalledTimes(2);
    expect(tabs.close).toHaveBeenCalledWith(91);
  });

  it('keeps a not-yet-rendered comment pending and records the check metadata', async () => {
    const store = storeFor([checks[0]!]);
    const tabs = tabsFor('pending_moderation');

    await new PendingModerationRecheckCoordinator(store, tabs).run();

    expect(store.recordModerationCheck).toHaveBeenCalledWith({
      targetId: 'target-1',
      attemptId: 'attempt-1',
      status: 'pending_moderation',
      message: 'COMMENT_PENDING_MODERATION_NOT_VISIBLE',
    });
  });

  it('transitions a publicly rendered fingerprint to published without a submit command', async () => {
    const store = storeFor([checks[0]!]);
    const tabs = tabsFor('published');

    await new PendingModerationRecheckCoordinator(store, tabs).run();

    expect(store.recordModerationCheck).toHaveBeenCalledWith({
      targetId: 'target-1',
      attemptId: 'attempt-1',
      status: 'published',
      message: 'COMMENT_PUBLISHED_RENDERED_FINGERPRINT',
    });
    expect(tabs.check).toHaveBeenCalledWith(
      91,
      checks[0]!.fingerprint,
      checks[0]!.targetWebsiteUrl
    );
  });

  it('closes a scanner-owned tab when its initial load fails', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      tabs: {
        create: vi.fn().mockResolvedValue({ id: 92, status: 'loading' }),
        get: vi.fn().mockRejectedValue(new Error('network unavailable')),
        remove,
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });

    await expect(
      createChromeModerationVerificationTabPort().create(
        'https://blog.example/unavailable'
      )
    ).rejects.toThrow('MODERATION_RECHECK_TAB_UNAVAILABLE');
    expect(remove).toHaveBeenCalledWith(92);
  });

  it('coalesces overlapping alarms into one scan', async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = storeFor([]);
    store.getPendingModerationChecks.mockImplementation(async () => {
      await waiting;
      return [];
    });
    const scanner = new PendingModerationRecheckCoordinator(store, tabsFor());

    const first = scanner.run();
    const second = scanner.run();
    expect(second).toBe(first);
    release?.();
    await expect(first).resolves.toMatchObject({ selected: 0 });
    expect(store.getPendingModerationChecks).toHaveBeenCalledOnce();
  });
});
