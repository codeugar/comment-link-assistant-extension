import { z } from 'zod';
import {
  type WebsiteProfile,
  fetchWebsiteProfile,
  normalizeWebsiteUrl,
} from './profile';

export const WEBSITE_PROFILE_CACHE_STORAGE_KEY =
  'comment-link-assistant.website-profile-cache';

export const WEBSITE_PROFILE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const WEBSITE_PROFILE_CACHE_MAX_ENTRIES = 50;

const cacheEntrySchema = z.object({
  profile: z.object({
    url: z.string().min(1).max(2_048),
    title: z.string().max(500),
    description: z.string().max(2_000),
  }),
  fetchedAt: z.number().int().nonnegative(),
});

const cacheSchema = z.record(z.string(), cacheEntrySchema);

type WebsiteProfileCache = z.infer<typeof cacheSchema>;

async function readCache(): Promise<WebsiteProfileCache> {
  const stored = await chrome.storage.local.get(
    WEBSITE_PROFILE_CACHE_STORAGE_KEY
  );
  const parsed = cacheSchema.safeParse(
    stored[WEBSITE_PROFILE_CACHE_STORAGE_KEY]
  );
  return parsed.success ? parsed.data : {};
}

function isFresh(fetchedAt: number, now: number): boolean {
  return now - fetchedAt < WEBSITE_PROFILE_CACHE_TTL_MS;
}

function pruneCache(
  cache: WebsiteProfileCache,
  now: number
): WebsiteProfileCache {
  const entries = Object.entries(cache).filter(([, entry]) =>
    isFresh(entry.fetchedAt, now)
  );
  entries.sort(([, a], [, b]) => b.fetchedAt - a.fetchedAt);
  return Object.fromEntries(
    entries.slice(0, WEBSITE_PROFILE_CACHE_MAX_ENTRIES)
  );
}

export interface LoadWebsiteProfileOptions {
  refresh?: boolean;
  now?: () => number;
  fetchImplementation?: typeof fetch;
}

export async function loadWebsiteProfile(
  value: string,
  options: LoadWebsiteProfileOptions = {}
): Promise<WebsiteProfile> {
  const key = normalizeWebsiteUrl(value);
  const now = options.now ?? Date.now;
  const cache = await readCache();

  const cached = cache[key];
  if (!options.refresh && cached && isFresh(cached.fetchedAt, now())) {
    return cached.profile;
  }

  const profile = await fetchWebsiteProfile(value, options.fetchImplementation);
  const fetchedAt = now();
  await chrome.storage.local.set({
    [WEBSITE_PROFILE_CACHE_STORAGE_KEY]: pruneCache(
      { ...cache, [key]: { profile, fetchedAt } },
      fetchedAt
    ),
  });
  return profile;
}
