import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  deleteWriteSession,
  getWriteSession,
  isWriteSessionStale,
  listWriteSessions,
  setWriteSession,
} from './session-store';
import type { WriteSession } from './types';

function makeSession(overrides: Partial<WriteSession> = {}): WriteSession {
  return {
    tabId: 1,
    pageUrl: 'https://forum.example/thread/1',
    siteId: 'site-1',
    format: 'markdown',
    context: {
      url: 'https://forum.example/thread/1',
      title: 'A thread',
      language: 'en',
      selection: null,
      firstPost: 'The opening post.',
      replyCount: 2,
      source: 'first-post',
    },
    turns: [],
    drafts: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('write session store', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('round-trips a session keyed by tab id', async () => {
    await setWriteSession(makeSession());

    const found = await getWriteSession(1);
    expect(found?.pageUrl).toBe('https://forum.example/thread/1');
    expect(await getWriteSession(2)).toBeNull();
  });

  it('deletes a session', async () => {
    await setWriteSession(makeSession());
    await deleteWriteSession(1);
    expect(await getWriteSession(1)).toBeNull();
  });

  it('deleting a missing session is a no-op', async () => {
    await expect(deleteWriteSession(99)).resolves.toBeUndefined();
  });

  it('lists every stored session', async () => {
    await setWriteSession(makeSession({ tabId: 1 }));
    await setWriteSession(makeSession({ tabId: 2 }));

    const all = await listWriteSessions();
    expect(all.map((session) => session.tabId).sort()).toEqual([1, 2]);
  });

  it('keeps only the most recently updated sessions past the cap', async () => {
    for (let tabId = 1; tabId <= 25; tabId += 1) {
      await setWriteSession(makeSession({ tabId, updatedAt: tabId }));
    }

    const all = await listWriteSessions();
    expect(all.length).toBeLessThanOrEqual(20);
    expect(await getWriteSession(25)).not.toBeNull();
    expect(await getWriteSession(1)).toBeNull();
  });

  it('treats a session as stale once the tab navigates to a different page', () => {
    const session = makeSession({ pageUrl: 'https://forum.example/thread/1' });
    expect(
      isWriteSessionStale(session, 'https://forum.example/thread/1#reply-2')
    ).toBe(false);
    expect(isWriteSessionStale(session, 'https://forum.example/thread/2')).toBe(
      true
    );
  });

  it('treats an unparsable current URL as stale', () => {
    const session = makeSession();
    expect(isWriteSessionStale(session, 'not a url')).toBe(true);
  });
});
