import { z } from 'zod';

export const OUTBOUND_LINK_LIBRARY_STORAGE_KEY =
  'comment-link-assistant.outbound-link-library';

export const OUTBOUND_LINK_TAGS = [
  'dofollow',
  'nofollow',
  'login_required',
  'captcha_required',
] as const;

export type OutboundLinkTag = (typeof OUTBOUND_LINK_TAGS)[number];

export interface OutboundLinkLibraryEntry {
  id: string;
  url: string;
  tags: OutboundLinkTag[];
  createdAt: number;
  updatedAt: number;
}

export interface AddOutboundLinkLibraryEntryInput {
  url: string;
  tags?: readonly OutboundLinkTag[];
  now?: number;
}

export interface AddOutboundLinkLibraryEntryResult {
  entry: OutboundLinkLibraryEntry;
  created: boolean;
}

export interface UpdateOutboundLinkLibraryEntryInput {
  id: string;
  url?: string;
  tags?: readonly OutboundLinkTag[];
  now?: number;
}

export class OutboundLinkLibraryError extends Error {
  constructor(
    readonly code:
      | 'OUTBOUND_LINK_ENTRY_INVALID'
      | 'OUTBOUND_LINK_ENTRY_LIMIT_EXCEEDED'
      | 'OUTBOUND_LINK_ENTRY_DUPLICATE'
      | 'OUTBOUND_LINK_TAG_CONFLICT',
    message = code
  ) {
    super(message);
    this.name = 'OutboundLinkLibraryError';
  }
}

const MAX_OUTBOUND_LINK_ENTRIES = 10_000;
const MAX_OUTBOUND_LINK_URL_LENGTH = 2_048;

const outboundLinkTagSchema = z.enum(OUTBOUND_LINK_TAGS);

const outboundLinkLibraryEntrySchema: z.ZodType<OutboundLinkLibraryEntry> = z
  .object({
    id: z.string().min(1).max(200),
    url: z.string().min(1).max(MAX_OUTBOUND_LINK_URL_LENGTH),
    tags: z.array(outboundLinkTagSchema).max(OUTBOUND_LINK_TAGS.length),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

const outboundLinkLibrarySchema = z
  .array(outboundLinkLibraryEntrySchema)
  .max(MAX_OUTBOUND_LINK_ENTRIES);

// chrome.storage.local has no compare-and-swap transaction. Keep every
// read-modify-write mutation in one in-memory queue so overlapping writes do
// not discard a link or its manual tags.
let outboundLinkLibraryMutationTail: Promise<void> = Promise.resolve();

function serializeOutboundLinkLibraryMutation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const run = outboundLinkLibraryMutationTail.then(operation, operation);
  // A rejected write must not permanently block the next user action.
  outboundLinkLibraryMutationTail = run.then(
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
    throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_INVALID');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password
  ) {
    throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_INVALID');
  }
  return url;
}

/**
 * Library rows represent exact target URLs. Fragments are removed because they
 * do not identify a distinct comment target, while protocol, path and query
 * remain part of the key.
 */
export function normalizeOutboundLinkUrl(value: string): string {
  if (typeof value !== 'string') {
    throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_INVALID');
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_OUTBOUND_LINK_URL_LENGTH) {
    throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_INVALID');
  }
  const url = validHttpUrl(trimmed);
  url.hash = '';
  return url.toString();
}

/**
 * Tags are stored in a stable order to keep storage deterministic. A target
 * cannot be both dofollow and nofollow at the same time.
 */
export function normalizeOutboundLinkTags(value: unknown): OutboundLinkTag[] {
  if (!Array.isArray(value) || value.length > OUTBOUND_LINK_TAGS.length) {
    throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_INVALID');
  }

  const tags = new Set<OutboundLinkTag>();
  for (const tag of value) {
    const parsed = outboundLinkTagSchema.safeParse(tag);
    if (!parsed.success) {
      throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_INVALID');
    }
    tags.add(parsed.data);
  }

  if (tags.has('dofollow') && tags.has('nofollow')) {
    throw new OutboundLinkLibraryError('OUTBOUND_LINK_TAG_CONFLICT');
  }

  return OUTBOUND_LINK_TAGS.filter((tag) => tags.has(tag));
}

function createEntryId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  if (id) return id;
  return `outbound-link-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function hasOwn(value: object, key: 'url' | 'tags'): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Invalid persisted rows are ignored independently so one stale or manually
 * corrupted row cannot hide the rest of the outbound-link library.
 */
export function parseStoredOutboundLinkLibrary(
  value: unknown
): OutboundLinkLibraryEntry[] | null {
  if (!Array.isArray(value)) return null;

  const entries: OutboundLinkLibraryEntry[] = [];
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const storedEntry of value.slice(0, MAX_OUTBOUND_LINK_ENTRIES)) {
    const parsed = outboundLinkLibraryEntrySchema.safeParse(storedEntry);
    if (!parsed.success) continue;

    try {
      const entry: OutboundLinkLibraryEntry = {
        ...parsed.data,
        url: normalizeOutboundLinkUrl(parsed.data.url),
        tags: normalizeOutboundLinkTags(parsed.data.tags),
      };
      if (ids.has(entry.id) || urls.has(entry.url)) continue;
      ids.add(entry.id);
      urls.add(entry.url);
      entries.push(entry);
    } catch {
      // Ignore only the malformed record; all other persisted links remain.
    }
  }
  return entries;
}

export async function getOutboundLinkLibrary(): Promise<
  OutboundLinkLibraryEntry[]
> {
  const stored = await chrome.storage.local.get(
    OUTBOUND_LINK_LIBRARY_STORAGE_KEY
  );
  return (
    parseStoredOutboundLinkLibrary(stored[OUTBOUND_LINK_LIBRARY_STORAGE_KEY]) ??
    []
  );
}

async function setOutboundLinkLibrary(
  entries: OutboundLinkLibraryEntry[]
): Promise<void> {
  const parsed = outboundLinkLibrarySchema.parse(entries);
  await chrome.storage.local.set({
    [OUTBOUND_LINK_LIBRARY_STORAGE_KEY]: parsed,
  });
}

export async function addOutboundLinkLibraryEntryWithResult(
  input: AddOutboundLinkLibraryEntryInput
): Promise<AddOutboundLinkLibraryEntryResult> {
  const url = normalizeOutboundLinkUrl(input.url);
  const tags = normalizeOutboundLinkTags(input.tags ?? []);

  return serializeOutboundLinkLibraryMutation(async () => {
    const entries = await getOutboundLinkLibrary();
    const existing = entries.find((entry) => entry.url === url);
    if (existing) return { entry: existing, created: false };
    if (entries.length >= MAX_OUTBOUND_LINK_ENTRIES) {
      throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_LIMIT_EXCEEDED');
    }

    const now = input.now ?? Date.now();
    const entry: OutboundLinkLibraryEntry = {
      id: createEntryId(),
      url,
      tags,
      createdAt: now,
      updatedAt: now,
    };
    await setOutboundLinkLibrary([...entries, entry]);
    return { entry, created: true };
  });
}

export async function addOutboundLinkLibraryEntry(
  input: AddOutboundLinkLibraryEntryInput
): Promise<OutboundLinkLibraryEntry> {
  return (await addOutboundLinkLibraryEntryWithResult(input)).entry;
}

export async function updateOutboundLinkLibraryEntry(
  input: UpdateOutboundLinkLibraryEntryInput
): Promise<OutboundLinkLibraryEntry | null> {
  const id = input.id.trim();
  if (!id) throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_INVALID');

  const updatesUrl = hasOwn(input, 'url');
  const updatesTags = hasOwn(input, 'tags');
  if (!updatesUrl && !updatesTags) {
    throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_INVALID');
  }

  const url = updatesUrl
    ? normalizeOutboundLinkUrl(input.url as string)
    : undefined;
  const tags = updatesTags ? normalizeOutboundLinkTags(input.tags) : undefined;

  return serializeOutboundLinkLibraryMutation(async () => {
    const entries = await getOutboundLinkLibrary();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) return null;

    const current = entries[index];
    const nextUrl = url ?? current.url;
    const duplicate = entries.find(
      (entry) => entry.id !== id && entry.url === nextUrl
    );
    if (duplicate) {
      throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_DUPLICATE');
    }

    const updated: OutboundLinkLibraryEntry = {
      ...current,
      url: nextUrl,
      tags: tags ?? current.tags,
      updatedAt: input.now ?? Date.now(),
    };
    const next = entries.map((entry, entryIndex) =>
      entryIndex === index ? updated : entry
    );
    await setOutboundLinkLibrary(next);
    return updated;
  });
}

export async function removeOutboundLinkLibraryEntry(
  id: string
): Promise<boolean> {
  const normalizedId = id.trim();
  if (!normalizedId) return false;

  return serializeOutboundLinkLibraryMutation(async () => {
    const entries = await getOutboundLinkLibrary();
    const next = entries.filter((entry) => entry.id !== normalizedId);
    if (next.length === entries.length) return false;
    await setOutboundLinkLibrary(next);
    return true;
  });
}
