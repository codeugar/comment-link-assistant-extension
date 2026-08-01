import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  OUTBOUND_LINK_LIBRARY_STORAGE_KEY,
  OutboundLinkLibraryError,
  addOutboundLinkLibraryEntry,
  addOutboundLinkLibraryEntryWithResult,
  getOutboundLinkLibrary,
  normalizeOutboundLinkTags,
  normalizeOutboundLinkUrl,
  parseStoredOutboundLinkLibrary,
  removeOutboundLinkLibraryEntry,
  updateOutboundLinkLibraryEntry,
} from './outbound-link-library';

describe('outbound-link library storage', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('normalizes exact URL rows and stores tags in a stable order', () => {
    expect(
      normalizeOutboundLinkUrl(
        ' HTTPS://WWW.Example.com:443/post/?b=2&a=1#comment '
      )
    ).toBe('https://www.example.com/post/?b=2&a=1');
    expect(
      normalizeOutboundLinkTags([
        'captcha_required',
        'dofollow',
        'dofollow',
        'login_required',
      ])
    ).toEqual(['dofollow', 'login_required', 'captcha_required']);
  });

  it('rejects invalid URL values and mutually exclusive link tags', () => {
    expect(() => normalizeOutboundLinkUrl('javascript:alert(1)')).toThrow(
      OutboundLinkLibraryError
    );
    expect(() =>
      normalizeOutboundLinkUrl('https://user:pass@example.com')
    ).toThrow('OUTBOUND_LINK_ENTRY_INVALID');
    expect(() => normalizeOutboundLinkTags(['dofollow', 'nofollow'])).toThrow(
      'OUTBOUND_LINK_TAG_CONFLICT'
    );
    expect(() => normalizeOutboundLinkTags(['unknown'] as never)).toThrow(
      'OUTBOUND_LINK_ENTRY_INVALID'
    );
  });

  it('persists, de-duplicates and removes exact URL entries', async () => {
    const first = await addOutboundLinkLibraryEntry({
      url: 'https://blog.example.com/post#comment',
      tags: ['dofollow', 'login_required'],
      now: 1_000,
    });
    const duplicate = await addOutboundLinkLibraryEntryWithResult({
      url: 'HTTPS://blog.example.com:443/post',
      tags: ['captcha_required'],
      now: 2_000,
    });

    expect(duplicate).toEqual({ entry: first, created: false });
    expect(await getOutboundLinkLibrary()).toEqual([
      {
        id: first.id,
        url: 'https://blog.example.com/post',
        tags: ['dofollow', 'login_required'],
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ]);
    expect(await removeOutboundLinkLibraryEntry(first.id)).toBe(true);
    expect(await removeOutboundLinkLibraryEntry(first.id)).toBe(false);
    expect(await getOutboundLinkLibrary()).toEqual([]);
  });

  it('serializes duplicate adds and reports only the later call as existing', async () => {
    const first = addOutboundLinkLibraryEntryWithResult({
      url: 'https://blog.example.com/post#first',
      tags: ['dofollow'],
    });
    const second = addOutboundLinkLibraryEntryWithResult({
      url: 'https://blog.example.com/post',
      tags: ['nofollow'],
    });

    const [created, existing] = await Promise.all([first, second]);
    expect(created.created).toBe(true);
    expect(existing).toEqual({ entry: created.entry, created: false });
    expect(await getOutboundLinkLibrary()).toEqual([created.entry]);
  });

  it('updates URL and tags while preserving the original creation timestamp', async () => {
    const entry = await addOutboundLinkLibraryEntry({
      url: 'https://blog.example.com/old',
      tags: ['dofollow'],
      now: 1_000,
    });

    const tagsUpdated = await updateOutboundLinkLibraryEntry({
      id: entry.id,
      tags: ['captcha_required', 'nofollow'],
      now: 2_000,
    });
    expect(tagsUpdated).toEqual({
      ...entry,
      tags: ['nofollow', 'captcha_required'],
      updatedAt: 2_000,
    });

    const urlUpdated = await updateOutboundLinkLibraryEntry({
      id: entry.id,
      url: ' HTTPS://blog.example.com:443/new#reply ',
      now: 3_000,
    });
    expect(urlUpdated).toEqual({
      ...entry,
      url: 'https://blog.example.com/new',
      tags: ['nofollow', 'captcha_required'],
      updatedAt: 3_000,
    });
  });

  it('rejects a URL update that would collide with another library row', async () => {
    const first = await addOutboundLinkLibraryEntry({
      url: 'https://blog.example.com/one',
      now: 1_000,
    });
    const second = await addOutboundLinkLibraryEntry({
      url: 'https://blog.example.com/two',
      now: 1_000,
    });

    await expect(
      updateOutboundLinkLibraryEntry({
        id: second.id,
        url: `${first.url}#comment`,
      })
    ).rejects.toMatchObject({ code: 'OUTBOUND_LINK_ENTRY_DUPLICATE' });
    expect(await getOutboundLinkLibrary()).toEqual([first, second]);
  });

  it('returns null for a missing update and rejects an empty update', async () => {
    await expect(
      updateOutboundLinkLibraryEntry({ id: 'missing', tags: [] })
    ).resolves.toBeNull();
    await expect(
      updateOutboundLinkLibraryEntry({ id: 'missing' })
    ).rejects.toMatchObject({ code: 'OUTBOUND_LINK_ENTRY_INVALID' });
  });

  it('rejects conflicting tag writes without changing the stored entry', async () => {
    const entry = await addOutboundLinkLibraryEntry({
      url: 'https://blog.example.com/post',
      tags: ['dofollow'],
      now: 1_000,
    });

    await expect(
      updateOutboundLinkLibraryEntry({
        id: entry.id,
        tags: ['dofollow', 'nofollow'],
        now: 2_000,
      })
    ).rejects.toMatchObject({ code: 'OUTBOUND_LINK_TAG_CONFLICT' });
    await expect(
      addOutboundLinkLibraryEntry({
        url: 'https://different.example/post',
        tags: ['dofollow', 'nofollow'],
      })
    ).rejects.toMatchObject({ code: 'OUTBOUND_LINK_TAG_CONFLICT' });
    expect(await getOutboundLinkLibrary()).toEqual([entry]);
  });

  it('keeps valid persisted rows when adjacent storage data is malformed', async () => {
    await chrome.storage.local.set({
      [OUTBOUND_LINK_LIBRARY_STORAGE_KEY]: [
        {
          id: 'valid',
          url: ' HTTPS://blog.example.com:443/post#comment ',
          tags: ['captcha_required', 'dofollow', 'dofollow'],
          createdAt: 1_000,
          updatedAt: 2_000,
        },
        { id: 'broken' },
        {
          id: 'valid',
          url: 'https://blog.example.com/duplicate-id',
          tags: [],
          createdAt: 3_000,
          updatedAt: 3_000,
        },
        {
          id: 'conflicting-tags',
          url: 'https://blog.example.com/conflict',
          tags: ['dofollow', 'nofollow'],
          createdAt: 1_000,
          updatedAt: 2_000,
        },
        {
          id: 'duplicate-url',
          url: 'https://blog.example.com/post',
          tags: ['nofollow'],
          createdAt: 3_000,
          updatedAt: 3_000,
        },
      ],
    });

    expect(await getOutboundLinkLibrary()).toEqual([
      {
        id: 'valid',
        url: 'https://blog.example.com/post',
        tags: ['dofollow', 'captcha_required'],
        createdAt: 1_000,
        updatedAt: 2_000,
      },
    ]);
    expect(parseStoredOutboundLinkLibrary({ malformed: true })).toBeNull();
  });

  it('serializes overlapping remove and add mutations', async () => {
    const stale = await addOutboundLinkLibraryEntry({
      url: 'https://stale.example/post',
    });
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    let releaseFirstWrite = () => {};
    const firstWriteMayContinue = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let signalFirstWrite = () => {};
    const firstWriteStarted = new Promise<void>((resolve) => {
      signalFirstWrite = resolve;
    });
    let writeCount = 0;
    const setSpy = vi
      .spyOn(chrome.storage.local, 'set')
      .mockImplementation(async (items) => {
        writeCount += 1;
        if (writeCount === 1) {
          signalFirstWrite();
          await firstWriteMayContinue;
        }
        await originalSet(items);
      });

    let firstWriteReleased = false;
    try {
      const removing = removeOutboundLinkLibraryEntry(stale.id);
      await firstWriteStarted;
      const adding = addOutboundLinkLibraryEntry({
        url: 'https://kept.example/post',
        tags: ['login_required'],
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writeCount).toBe(1);

      releaseFirstWrite();
      firstWriteReleased = true;
      const [removed, added] = await Promise.all([removing, adding]);

      expect(removed).toBe(true);
      expect(added).toMatchObject({
        url: 'https://kept.example/post',
        tags: ['login_required'],
      });
      expect(await getOutboundLinkLibrary()).toEqual([added]);
    } finally {
      if (!firstWriteReleased) releaseFirstWrite();
      setSpy.mockRestore();
    }
  });

  it('continues queued mutations after a storage write fails', async () => {
    const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
    let writeCount = 0;
    const setSpy = vi
      .spyOn(chrome.storage.local, 'set')
      .mockImplementation(async (items) => {
        writeCount += 1;
        if (writeCount === 1) throw new Error('WRITE_FAILED');
        await originalSet(items);
      });

    try {
      await expect(
        addOutboundLinkLibraryEntry({ url: 'https://failed.example/post' })
      ).rejects.toThrow('WRITE_FAILED');
      await addOutboundLinkLibraryEntry({ url: 'https://next.example/post' });

      expect(await getOutboundLinkLibrary()).toEqual([
        expect.objectContaining({ url: 'https://next.example/post' }),
      ]);
    } finally {
      setSpy.mockRestore();
    }
  });
});
