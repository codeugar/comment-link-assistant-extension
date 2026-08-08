import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingModerationCheck } from './db';
import {
  MAX_PENDING_MODERATION_CHECKS_PER_RUN,
  type ModerationRecheckStore,
  PENDING_MODERATION_RECHECK_ALARM,
  PENDING_MODERATION_RECHECK_INTERVAL_MINUTES,
  PendingModerationRecheckCoordinator,
  type PublicCommentPort,
  addManualModerationEntry,
  armPendingModerationRecheckAlarm,
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
    promotingSiteId: 'site-1',
    url: 'https://blog.example/one',
    targetWebsiteUrl: 'https://product.example',
    fingerprint: 'A useful generated comment',
    criterion: { kind: 'link', websiteUrl: 'https://product.example' },
    checkCount: 0,
  },
  {
    targetId: 'target-2',
    attemptId: 'attempt-2',
    planId: 'plan-1',
    promotingSiteId: 'site-1',
    url: 'https://blog.example/two',
    targetWebsiteUrl: 'https://product.example',
    fingerprint: 'Another useful generated comment',
    criterion: { kind: 'link', websiteUrl: 'https://product.example' },
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

function portFor(
  visibility:
    | 'visible'
    | 'not_visible'
    | 'link_stripped'
    | 'inconclusive' = 'not_visible'
): PublicCommentPort & { check: ReturnType<typeof vi.fn> } {
  return {
    check: vi.fn().mockResolvedValue({
      visibility,
      method: 'wp_rest',
      message: 'PUBLIC_COMMENT_CHECK',
      checkedAt: 1_700_000_000_000,
    }),
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
    const port = portFor('visible');
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
      recheckManualModerationEntry('manual-1', port, storage as never)
    ).resolves.toMatchObject({
      status: 'published',
      checkCount: 1,
    });
    // The pasted permalink already names the comment, so the check is exact.
    expect(port.check).toHaveBeenCalledWith({
      pageUrl: 'https://blog.example/article#comment-42',
      criterion: { kind: 'link', websiteUrl: 'https://product.example' },
      commentId: '42',
    });
    expect(await loadManualModerationEntries(storage as never)).toEqual([
      expect.objectContaining({ id: 'manual-1', status: 'published' }),
    ]);
  });

  it('checks every durable pending record without opening a tab', async () => {
    const store = storeFor();
    const port = portFor();
    const scanner = new PendingModerationRecheckCoordinator(
      store,
      port,
      MAX_PENDING_MODERATION_CHECKS_PER_RUN
    );

    await expect(scanner.run()).resolves.toEqual({
      selected: 2,
      checked: 2,
      published: 0,
      linkStripped: 0,
      stillPending: 2,
    });
    expect(store.getPendingModerationChecks).toHaveBeenCalledWith(
      MAX_PENDING_MODERATION_CHECKS_PER_RUN
    );
    expect(port.check).toHaveBeenCalledTimes(2);
  });

  it('keeps a not-yet-rendered comment pending and records the check metadata', async () => {
    const store = storeFor([checks[0]!]);
    const port = portFor('not_visible');

    await new PendingModerationRecheckCoordinator(store, port).run();

    expect(store.recordModerationCheck).toHaveBeenCalledWith({
      targetId: 'target-1',
      attemptId: 'attempt-1',
      status: 'pending_moderation',
      message: 'COMMENT_PENDING_MODERATION_NOT_VISIBLE',
    });
  });

  it('settles a public comment whose link was stripped instead of re-queuing it', async () => {
    const store = storeFor([{ ...checks[0]!, commentId: '4242' }]);
    const port = portFor('link_stripped');

    await expect(
      new PendingModerationRecheckCoordinator(store, port).run()
    ).resolves.toMatchObject({ linkStripped: 1, stillPending: 0 });

    expect(store.recordModerationCheck).toHaveBeenCalledWith({
      targetId: 'target-1',
      attemptId: 'attempt-1',
      status: 'link_stripped',
      message: 'COMMENT_PUBLIC_LINK_STRIPPED',
    });
  });

  it('publishes a held comment once an anonymous reader can see it', async () => {
    const store = storeFor([
      {
        ...checks[0]!,
        commentId: '4242',
        receiptUrl: 'https://blog.example/one#comment-4242',
      },
    ]);
    const port = portFor('visible');

    await new PendingModerationRecheckCoordinator(store, port).run();

    expect(store.recordModerationCheck).toHaveBeenCalledWith({
      targetId: 'target-1',
      attemptId: 'attempt-1',
      status: 'published',
      message: 'COMMENT_PUBLISHED_PUBLIC_CHECK',
    });
    // Addressed by the id the server assigned, on the receipt URL.
    expect(port.check).toHaveBeenCalledWith({
      pageUrl: 'https://blog.example/one#comment-4242',
      criterion: checks[0]!.criterion,
      fingerprint: checks[0]!.fingerprint,
      commentId: '4242',
    });
  });

  it('keeps an unreadable page pending instead of recording a verdict', async () => {
    const store = storeFor([checks[0]!]);
    const port = portFor('inconclusive');

    await new PendingModerationRecheckCoordinator(store, port).run();

    expect(store.recordModerationCheck).toHaveBeenCalledWith({
      targetId: 'target-1',
      attemptId: 'attempt-1',
      status: 'pending_moderation',
      message: 'COMMENT_PENDING_MODERATION_RECHECK_UNAVAILABLE',
    });
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
    const scanner = new PendingModerationRecheckCoordinator(store, portFor());

    const first = scanner.run();
    const second = scanner.run();
    expect(second).toBe(first);
    release?.();
    await expect(first).resolves.toMatchObject({ selected: 0 });
    expect(store.getPendingModerationChecks).toHaveBeenCalledOnce();
  });
});
