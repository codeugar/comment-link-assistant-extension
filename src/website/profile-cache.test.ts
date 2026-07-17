import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { normalizeWebsiteUrl } from './profile';
import {
  WEBSITE_PROFILE_CACHE_STORAGE_KEY,
  WEBSITE_PROFILE_CACHE_TTL_MS,
  loadWebsiteProfile,
} from './profile-cache';

const KEY = normalizeWebsiteUrl('https://example.com');

function htmlResponse(title: string, description: string): Response {
  return new Response(
    `<title>${title}</title><meta name="description" content="${description}">`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

async function seedCache(
  entries: Record<string, { profile: unknown; fetchedAt: number }>
) {
  await chrome.storage.local.set({
    [WEBSITE_PROFILE_CACHE_STORAGE_KEY]: entries,
  });
}

async function readStoredCache(): Promise<Record<string, unknown>> {
  const stored = await chrome.storage.local.get(
    WEBSITE_PROFILE_CACHE_STORAGE_KEY
  );
  return (stored[WEBSITE_PROFILE_CACHE_STORAGE_KEY] ?? {}) as Record<
    string,
    unknown
  >;
}

describe('website profile cache', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('returns the cached profile without fetching on a fresh hit', async () => {
    const cachedProfile = {
      url: KEY,
      title: 'Cached title',
      description: 'Cached description',
    };
    await seedCache({ [KEY]: { profile: cachedProfile, fetchedAt: 1_000 } });
    const fetchMock = vi.fn();

    const profile = await loadWebsiteProfile('https://example.com', {
      now: () => 1_000 + WEBSITE_PROFILE_CACHE_TTL_MS - 1,
      fetchImplementation: fetchMock,
    });

    expect(profile).toEqual(cachedProfile);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches and persists on a cache miss', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(htmlResponse('Fetched title', 'Fetched description'));

    const profile = await loadWebsiteProfile('https://example.com', {
      now: () => 5_000,
      fetchImplementation: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(profile).toMatchObject({
      title: 'Fetched title',
      description: 'Fetched description',
    });

    const cache = await readStoredCache();
    expect(cache[KEY]).toEqual({ profile, fetchedAt: 5_000 });
  });

  it('refetches when the cached entry is older than the TTL', async () => {
    const staleProfile = {
      url: KEY,
      title: 'Stale title',
      description: 'Stale description',
    };
    await seedCache({ [KEY]: { profile: staleProfile, fetchedAt: 0 } });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(htmlResponse('Fresh title', 'Fresh description'));

    const profile = await loadWebsiteProfile('https://example.com', {
      now: () => WEBSITE_PROFILE_CACHE_TTL_MS,
      fetchImplementation: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(profile).toMatchObject({ title: 'Fresh title' });

    const cache = await readStoredCache();
    expect(cache[KEY]).toMatchObject({
      fetchedAt: WEBSITE_PROFILE_CACHE_TTL_MS,
    });
  });

  it('bypasses a fresh cache entry when refresh is requested', async () => {
    const cachedProfile = {
      url: KEY,
      title: 'Cached title',
      description: 'Cached description',
    };
    await seedCache({ [KEY]: { profile: cachedProfile, fetchedAt: 1_000 } });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        htmlResponse('Refreshed title', 'Refreshed description')
      );

    const profile = await loadWebsiteProfile('https://example.com', {
      refresh: true,
      now: () => 1_000,
      fetchImplementation: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(profile).toMatchObject({ title: 'Refreshed title' });
  });

  it('propagates a fetch failure and leaves any existing cache entry untouched', async () => {
    const existingProfile = {
      url: KEY,
      title: 'Existing title',
      description: 'Existing description',
    };
    await seedCache({ [KEY]: { profile: existingProfile, fetchedAt: 0 } });
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('WEBSITE_FETCH_FAILED_500'));

    await expect(
      loadWebsiteProfile('https://example.com', {
        now: () => WEBSITE_PROFILE_CACHE_TTL_MS,
        fetchImplementation: fetchMock,
      })
    ).rejects.toThrow('WEBSITE_FETCH_FAILED_500');

    const cache = await readStoredCache();
    expect(cache[KEY]).toEqual({ profile: existingProfile, fetchedAt: 0 });
  });

  it('treats corrupt stored cache data as empty', async () => {
    await chrome.storage.local.set({
      [WEBSITE_PROFILE_CACHE_STORAGE_KEY]: 'not-a-valid-cache',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        htmlResponse('Recovered title', 'Recovered description')
      );

    const profile = await loadWebsiteProfile('https://example.com', {
      now: () => 10_000,
      fetchImplementation: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(profile).toMatchObject({ title: 'Recovered title' });

    const cache = await readStoredCache();
    expect(cache[KEY]).toMatchObject({ fetchedAt: 10_000 });
  });

  it('prunes expired entries and caps the cache at 50, evicting the oldest', async () => {
    const now = WEBSITE_PROFILE_CACHE_TTL_MS + 100_000;
    const seed: Record<string, { profile: unknown; fetchedAt: number }> = {};
    for (let i = 0; i < 50; i += 1) {
      seed[`https://site-${i}.example/`] = {
        profile: {
          url: `https://site-${i}.example/`,
          title: `Title ${i}`,
          description: `Description ${i}`,
        },
        fetchedAt: now - i * 1_000,
      };
    }
    seed['https://expired.example/'] = {
      profile: {
        url: 'https://expired.example/',
        title: 'Expired title',
        description: 'Expired description',
      },
      fetchedAt: 0,
    };
    await seedCache(seed);

    const fetchMock = vi
      .fn()
      .mockResolvedValue(htmlResponse('New title', 'New description'));

    await loadWebsiteProfile('https://new-site.example', {
      now: () => now,
      fetchImplementation: fetchMock,
    });

    const cache = await readStoredCache();
    const keys = Object.keys(cache);

    expect(keys).not.toContain('https://expired.example/');
    expect(keys).toHaveLength(50);
    expect(cache['https://site-49.example/']).toBeUndefined();
    expect(cache['https://site-0.example/']).toBeDefined();
    expect(
      cache[normalizeWebsiteUrl('https://new-site.example')]
    ).toBeDefined();
  });
});
