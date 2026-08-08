import { describe, expect, it, vi } from 'vitest';
import type { PendingModerationCheck } from './db';
import {
  type ModerationRecheckStore,
  PendingModerationRecheckCoordinator,
  type PublicCommentPort,
  addManualModerationEntry,
  loadManualModerationEntries,
  recheckManualModerationEntry,
} from './moderation-recheck';

function storeFor(
  selected: PendingModerationCheck[]
): ModerationRecheckStore & {
  recordModerationCheck: ReturnType<typeof vi.fn>;
} {
  return {
    getPendingModerationChecks: vi.fn().mockResolvedValue(selected),
    recordModerationCheck: vi.fn().mockResolvedValue(null),
  };
}

function portFor(
  visibility: 'visible' | 'not_visible' | 'link_stripped' | 'inconclusive'
): PublicCommentPort & { check: ReturnType<typeof vi.fn> } {
  return {
    check: vi.fn().mockResolvedValue({
      visibility,
      method: 'html',
      message: 'TEST',
      checkedAt: 1,
    }),
  };
}

function memoryStorage() {
  const state: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key: string) => ({ [key]: state[key] })),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(state, values);
    }),
  };
}

const baseCheck: PendingModerationCheck = {
  targetId: 'target-1',
  attemptId: 'attempt-1',
  planId: 'plan-1',
  promotingSiteId: 'site-1',
  url: 'https://blog.example/one',
  targetWebsiteUrl: 'https://product.example',
  fingerprint: 'A useful generated comment about the pricing table',
  criterion: { kind: 'link', websiteUrl: 'https://product.example' },
  checkCount: 0,
};

/**
 * The success criterion belongs to the task that created the comment. Rebuilding
 * it downstream from the plan's promoted URL is what recorded every
 * `comment-only` comment as a terminal `link_stripped` failure.
 */
describe('the success criterion travels with the task', () => {
  it('hands the queued criterion to the public read unchanged', async () => {
    const port = portFor('visible');
    await new PendingModerationRecheckCoordinator(
      storeFor([baseCheck]),
      port
    ).run();

    expect(port.check).toHaveBeenCalledWith(
      expect.objectContaining({
        criterion: { kind: 'link', websiteUrl: 'https://product.example' },
        fingerprint: baseCheck.fingerprint,
      })
    );
  });

  it('asks only about visibility for a comment-only target', async () => {
    const port = portFor('visible');
    const store = storeFor([
      { ...baseCheck, criterion: { kind: 'comment_only' } },
    ]);
    await new PendingModerationRecheckCoordinator(store, port).run();

    expect(port.check).toHaveBeenCalledWith(
      expect.objectContaining({ criterion: { kind: 'comment_only' } })
    );
    expect(store.recordModerationCheck).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'published' })
    );
  });

  it('reads the receipt page and the receipt comment id when they exist', async () => {
    const port = portFor('visible');
    await new PendingModerationRecheckCoordinator(
      storeFor([
        {
          ...baseCheck,
          receiptUrl: 'https://blog.example/one/comment-page-2/#comment-88',
          commentId: '88',
        },
      ]),
      port
    ).run();

    expect(port.check).toHaveBeenCalledWith(
      expect.objectContaining({
        pageUrl: 'https://blog.example/one/comment-page-2/#comment-88',
        commentId: '88',
      })
    );
  });
});

/**
 * A manual entry carries no comment text, so a pasted `#comment-<id>`
 * permalink is the only thing that can attribute a comment on that page to the
 * user. Without it nothing on the page may be settled.
 */
describe('manually added entries', () => {
  it('flags an entry whose URL identifies no comment', async () => {
    const storage = memoryStorage();
    const entry = await addManualModerationEntry(
      {
        pageUrl: 'https://blog.example/article',
        targetWebsiteUrl: 'https://product.example/',
      },
      storage as never,
      100,
      () => 'manual-1'
    );

    expect(entry.needsCommentPermalink).toBe(true);
    expect(entry.commentId).toBeUndefined();
  });

  it('flags an entry stored before the permalink was ever asked for', async () => {
    // The field is derived from the comment id, so a row written by an earlier
    // version must not read back as "identified".
    const storage = memoryStorage();
    await storage.set({
      'comment-link-assistant.manual-moderation-entries': [
        {
          id: 'legacy-1',
          pageUrl: 'https://blog.example/article',
          targetWebsiteUrl: 'https://product.example',
          status: 'pending_moderation',
          checkCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const [entry] = await loadManualModerationEntries(storage as never);
    expect(entry?.needsCommentPermalink).toBe(true);
  });

  it('takes the comment id from a pasted permalink', async () => {
    const storage = memoryStorage();
    await expect(
      addManualModerationEntry(
        {
          pageUrl: 'https://blog.example/article#comment-42',
          targetWebsiteUrl: 'https://product.example/',
        },
        storage as never,
        100,
        () => 'manual-1'
      )
    ).resolves.toMatchObject({
      commentId: '42',
      needsCommentPermalink: false,
    });
  });

  it('never settles an unidentified entry as a terminal failure', async () => {
    const storage = memoryStorage();
    await addManualModerationEntry(
      {
        pageUrl: 'https://blog.example/article',
        targetWebsiteUrl: 'https://product.example/',
      },
      storage as never,
      100,
      () => 'manual-1'
    );

    await expect(
      recheckManualModerationEntry(
        'manual-1',
        portFor('link_stripped'),
        storage as never
      )
    ).resolves.toMatchObject({ status: 'pending_moderation' });
  });

  it('settles an identified entry whose link the site removed', async () => {
    const storage = memoryStorage();
    await addManualModerationEntry(
      {
        pageUrl: 'https://blog.example/article#comment-42',
        targetWebsiteUrl: 'https://product.example/',
      },
      storage as never,
      100,
      () => 'manual-1'
    );

    await expect(
      recheckManualModerationEntry(
        'manual-1',
        portFor('link_stripped'),
        storage as never
      )
    ).resolves.toMatchObject({ status: 'link_stripped' });
  });
});
