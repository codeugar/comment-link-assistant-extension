import { z } from 'zod';

export const FILTER_LIST_STORAGE_KEY = 'comment-link-assistant.filter-list';

export const FILTER_ENTRY_KINDS = ['url', 'domain'] as const;

export type FilterEntryKind = (typeof FILTER_ENTRY_KINDS)[number];

export interface FilterListEntry {
  id: string;
  kind: FilterEntryKind;
  value: string;
  createdAt: number;
}

export interface AddFilterListEntryInput {
  value: string;
  kind?: FilterEntryKind;
  now?: number;
}
export interface AddFilterListEntryResult {
  entry: FilterListEntry;
  created: boolean;
}

export class FilterListError extends Error {
  constructor(
    readonly code: 'FILTER_ENTRY_INVALID' | 'FILTER_ENTRY_LIMIT_EXCEEDED',
    message = code
  ) {
    super(message);
    this.name = 'FilterListError';
  }
}

const MAX_FILTER_ENTRIES = 2_000;
const MAX_FILTER_VALUE_LENGTH = 2_048;

const filterEntrySchema: z.ZodType<FilterListEntry> = z
  .object({
    id: z.string().min(1).max(200),
    kind: z.enum(FILTER_ENTRY_KINDS),
    value: z.string().min(1).max(MAX_FILTER_VALUE_LENGTH),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

const filterListSchema = z.array(filterEntrySchema).max(MAX_FILTER_ENTRIES);

// chrome.storage.local has no compare-and-swap transaction. Keep every
// read-modify-write mutation in one in-memory queue so an overlapping add or
// remove reads the result of the preceding operation instead of overwriting it.
let filterListMutationTail: Promise<void> = Promise.resolve();

function serializeFilterListMutation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const run = filterListMutationTail.then(operation, operation);
  // A rejected write must not permanently block the next user action.
  filterListMutationTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function validHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new FilterListError('FILTER_ENTRY_INVALID');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
  ) {
    throw new FilterListError('FILTER_ENTRY_INVALID');
  }
  return url;
}

/**
 * Keeps a URL blacklist precise: protocol, path and query string remain part
 * of the key, while fragments (which never identify a distinct page target)
 * are removed. URL() also normalizes case, default ports and a bare origin's
 * trailing slash consistently with batch target parsing.
 */
export function normalizeFilterUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FILTER_VALUE_LENGTH) {
    throw new FilterListError('FILTER_ENTRY_INVALID');
  }
  const url = validHttpUrl(trimmed);
  url.hash = '';
  return url.toString();
}

/**
 * Domain entries intentionally cover the hostname and its subdomains. `www`
 * is only a presentation alias, so www.example.com and example.com normalize
 * to the same filter value.
 */
export function normalizeFilterDomain(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FILTER_VALUE_LENGTH) {
    throw new FilterListError('FILTER_ENTRY_INVALID');
  }

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  if (!hasScheme && /[/?#@]/.test(trimmed)) {
    throw new FilterListError('FILTER_ENTRY_INVALID');
  }

  const url = validHttpUrl(hasScheme ? trimmed : `https://${trimmed}`);
  const hostname = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
  if (!hostname) throw new FilterListError('FILTER_ENTRY_INVALID');
  return hostname;
}

function inferKind(value: string): FilterEntryKind {
  return /^https?:\/\//i.test(value.trim()) ? 'url' : 'domain';
}

function entryValue(value: string, kind: FilterEntryKind): string {
  return kind === 'url'
    ? normalizeFilterUrl(value)
    : normalizeFilterDomain(value);
}

function createEntryId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  if (id) return id;
  return `filter-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function parseStoredFilterList(
  value: unknown
): FilterListEntry[] | null {
  const parsed = filterListSchema.safeParse(value);
  if (!parsed.success) return null;

  // Re-normalize stored values as a defensive migration boundary. A malformed
  // old entry should not disable a valid list, but it is ignored rather than
  // guessing what it was meant to match.
  const normalized: FilterListEntry[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.data) {
    try {
      const next = { ...entry, value: entryValue(entry.value, entry.kind) };
      const key = `${next.kind}:${next.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        normalized.push(next);
      }
    } catch {
      // Ignore only the corrupted record; all other persisted filters remain
      // active and deterministic.
    }
  }
  return normalized;
}

export async function getFilterList(): Promise<FilterListEntry[]> {
  const stored = await chrome.storage.local.get(FILTER_LIST_STORAGE_KEY);
  return parseStoredFilterList(stored[FILTER_LIST_STORAGE_KEY]) ?? [];
}

async function setFilterList(entries: FilterListEntry[]): Promise<void> {
  const parsed = filterListSchema.parse(entries);
  await chrome.storage.local.set({ [FILTER_LIST_STORAGE_KEY]: parsed });
}

export async function addFilterListEntryWithResult(
  input: AddFilterListEntryInput
): Promise<AddFilterListEntryResult> {
  const kind = input.kind ?? inferKind(input.value);
  const value = entryValue(input.value, kind);
  return serializeFilterListMutation(async () => {
    const entries = await getFilterList();
    const existing = entries.find(
      (entry) => entry.kind === kind && entry.value === value
    );
    if (existing) return { entry: existing, created: false };
    if (entries.length >= MAX_FILTER_ENTRIES) {
      throw new FilterListError('FILTER_ENTRY_LIMIT_EXCEEDED');
    }
    const entry: FilterListEntry = {
      id: createEntryId(),
      kind,
      value,
      createdAt: input.now ?? Date.now(),
    };
    await setFilterList([...entries, entry]);
    return { entry, created: true };
  });
}

export async function addFilterListEntry(
  input: AddFilterListEntryInput
): Promise<FilterListEntry> {
  return (await addFilterListEntryWithResult(input)).entry;
}

export async function removeFilterListEntry(id: string): Promise<boolean> {
  const normalizedId = id.trim();
  if (!normalizedId) return false;
  return serializeFilterListMutation(async () => {
    const entries = await getFilterList();
    const next = entries.filter((entry) => entry.id !== normalizedId);
    if (next.length === entries.length) return false;
    await setFilterList(next);
    return true;
  });
}

export function findMatchingFilterEntry(
  targetUrl: string,
  entries: readonly FilterListEntry[]
): FilterListEntry | null {
  let normalizedUrl: string;
  let hostname: string;
  try {
    normalizedUrl = normalizeFilterUrl(targetUrl);
    hostname = normalizeFilterDomain(new URL(normalizedUrl).hostname);
  } catch {
    return null;
  }

  return (
    entries.find(
      (entry) => entry.kind === 'url' && entry.value === normalizedUrl
    ) ??
    entries.find(
      (entry) =>
        entry.kind === 'domain' &&
        (hostname === entry.value || hostname.endsWith(`.${entry.value}`))
    ) ??
    null
  );
}

export async function getMatchingFilterEntry(
  targetUrl: string
): Promise<FilterListEntry | null> {
  return findMatchingFilterEntry(targetUrl, await getFilterList());
}

export async function isTargetFiltered(targetUrl: string): Promise<boolean> {
  return Boolean(await getMatchingFilterEntry(targetUrl));
}
