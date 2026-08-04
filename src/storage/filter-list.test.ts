import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  FILTER_LIST_STORAGE_KEY,
  FilterListError,
  addFilterListEntry,
  addFilterListEntryWithResult,
  findMatchingFilterEntry,
  getFilterList,
  getMatchingFilterEntry,
  normalizeFilterDomain,
  normalizeFilterUrl,
  removeFilterListEntry,
} from './filter-list';

describe('filter list storage', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('normalizes precise URL filters and removes fragments', () => {
    expect(
      normalizeFilterUrl(' HTTPS://WWW.Example.com:443/post/?b=2&a=1#reply ')
    ).toBe('https://www.example.com/post/?b=2&a=1');
  });

  it('normalizes the www domain alias and supports a URL as domain input', () => {
    expect(normalizeFilterDomain('www.Example.com.')).toBe('example.com');
    expect(normalizeFilterDomain('https://blog.example.com/a-post')).toBe(
      'blog.example.com'
    );
  });

  it('persists, de-duplicates and removes entries', async () => {
    const first = await addFilterListEntry({
      value: 'https://blog.example.com/post#comment',
      now: 1_000,
    });
    const duplicate = await addFilterListEntry({
      value: 'https://blog.example.com/post',
      now: 2_000,
    });

    expect(duplicate).toEqual(first);
    expect(await getFilterList()).toEqual([
      expect.objectContaining({
        id: first.id,
        kind: 'url',
        value: 'https://blog.example.com/post',
        createdAt: 1_000,
      }),
    ]);
    expect(await removeFilterListEntry(first.id)).toBe(true);
    expect(await removeFilterListEntry(first.id)).toBe(false);
    expect(await getFilterList()).toEqual([]);
  });

  it('atomically reports an earlier queued duplicate as pre-existing', async () => {
    const manual = addFilterListEntry({
      kind: 'url',
      value: 'https://blog.example.com/post',
    });
    const deleteFlow = addFilterListEntryWithResult({
      kind: 'url',
      value: 'https://blog.example.com/post',
    });

    const [manualEntry, result] = await Promise.all([manual, deleteFlow]);

    expect(result).toEqual({ entry: manualEntry, created: false });
    expect(await getFilterList()).toEqual([manualEntry]);
  });
  it('marks a newly persisted filter entry as created', async () => {
    const result = await addFilterListEntryWithResult({
      kind: 'domain',
      value: 'new.example',
    });

    expect(result.created).toBe(true);
    expect(await getFilterList()).toEqual([result.entry]);
  });

  it('normalizes and de-duplicates automatic domain filters', async () => {
    const first = await addFilterListEntryWithResult({
      kind: 'domain',
      value: 'https://www.Example.com/post-a',
      now: 1_000,
    });
    const duplicate = await addFilterListEntryWithResult({
      kind: 'domain',
      value: 'www.example.com',
      now: 2_000,
    });

    expect(first).toMatchObject({
      created: true,
      entry: { kind: 'domain', value: 'example.com', createdAt: 1_000 },
    });
    expect(duplicate).toEqual({ entry: first.entry, created: false });
    expect(await getFilterList()).toEqual([first.entry]);
    expect(
      await getMatchingFilterEntry('https://child.example.com/post-b')
    ).toEqual(first.entry);
  });

  it('serializes overlapping remove and add mutations', async () => {
    const stale = await addFilterListEntry({
      kind: 'domain',
      value: 'stale.example',
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
      const removing = removeFilterListEntry(stale.id);
      await firstWriteStarted;
      const adding = addFilterListEntry({
        kind: 'domain',
        value: 'kept.example',
      });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(writeCount).toBe(1);

      releaseFirstWrite();
      firstWriteReleased = true;
      const [removed, added] = await Promise.all([removing, adding]);

      expect(removed).toBe(true);
      expect(added).toMatchObject({ value: 'kept.example' });
      expect(await getFilterList()).toEqual([
        expect.objectContaining({
          kind: 'domain',
          value: 'kept.example',
        }),
      ]);
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
        addFilterListEntry({ kind: 'domain', value: 'failed.example' })
      ).rejects.toThrow('WRITE_FAILED');
      await addFilterListEntry({ kind: 'domain', value: 'next.example' });

      expect(await getFilterList()).toEqual([
        expect.objectContaining({
          kind: 'domain',
          value: 'next.example',
        }),
      ]);
    } finally {
      setSpy.mockRestore();
    }
  });

  it('matches a full URL exactly and a domain across subdomains', async () => {
    const exact = await addFilterListEntry({
      kind: 'url',
      value: 'https://blog.example.com/post?ref=one',
    });
    const domain = await addFilterListEntry({
      kind: 'domain',
      value: 'www.blocked.example',
    });
    const entries = await getFilterList();

    expect(
      findMatchingFilterEntry(
        'https://blog.example.com/post?ref=one#comment',
        entries
      )
    ).toEqual(exact);
    expect(
      findMatchingFilterEntry('https://blog.example.com/post?ref=two', entries)
    ).toBeNull();
    expect(
      findMatchingFilterEntry('https://child.blocked.example/article', entries)
    ).toEqual(domain);
    expect(
      await getMatchingFilterEntry('https://blocked.example/another-post')
    ).toEqual(domain);
  });

  it('treats malformed storage as empty and rejects invalid entries', async () => {
    await chrome.storage.local.set({
      [FILTER_LIST_STORAGE_KEY]: [{ bad: true }],
    });
    expect(await getFilterList()).toEqual([]);
    await expect(
      addFilterListEntry({ kind: 'url', value: 'javascript:alert(1)' })
    ).rejects.toBeInstanceOf(FilterListError);
    await expect(
      addFilterListEntry({ kind: 'domain', value: 'example.com/path' })
    ).rejects.toMatchObject({ code: 'FILTER_ENTRY_INVALID' });
  });
});
