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

export const OUTBOUND_LINK_FOLLOW_STATUSES = [
  'unknown',
  'dofollow',
  'nofollow',
] as const;

export type OutboundLinkFollowStatus =
  (typeof OUTBOUND_LINK_FOLLOW_STATUSES)[number];

export interface OutboundLinkLibraryEntry {
  id: string;
  /** Canonical hostname. `url` remains as a compatibility alias for old UI. */
  domain: string;
  url: string;
  tags: OutboundLinkTag[];
  followStatus: OutboundLinkFollowStatus;
  loginRequired: boolean | null;
  captchaRequired: boolean | null;
  createdAt: number;
  updatedAt: number;
}

export interface AddOutboundLinkLibraryEntryInput {
  url: string;
  domain?: string;
  tags?: readonly OutboundLinkTag[];
  followStatus?: OutboundLinkFollowStatus;
  loginRequired?: boolean | null;
  captchaRequired?: boolean | null;
  now?: number;
}

export interface AddOutboundLinkLibraryEntryResult {
  entry: OutboundLinkLibraryEntry;
  created: boolean;
}

export interface UpdateOutboundLinkLibraryEntryInput {
  id: string;
  url?: string;
  domain?: string;
  tags?: readonly OutboundLinkTag[];
  followStatus?: OutboundLinkFollowStatus;
  loginRequired?: boolean | null;
  captchaRequired?: boolean | null;
  now?: number;
}

export interface UpsertOutboundLinkLibraryEntryInput
  extends Omit<AddOutboundLinkLibraryEntryInput, 'url'> {
  domain: string;
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
    domain: z.string().min(1).max(253),
    url: z.string().min(1).max(MAX_OUTBOUND_LINK_URL_LENGTH),
    tags: z.array(outboundLinkTagSchema).max(OUTBOUND_LINK_TAGS.length),
    followStatus: z.enum(OUTBOUND_LINK_FOLLOW_STATUSES),
    loginRequired: z.boolean().nullable(),
    captchaRequired: z.boolean().nullable(),
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
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_INVALID');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    !url.hostname ||
    url.hostname.includes('..')
  ) {
    throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_INVALID');
  }
  return url;
}

/**
 * Library rows represent canonical hostnames. The input may be a bare domain,
 * a URL, or a URL with a path; paths are intentionally discarded because the
 * library describes site-level behavior.
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
  return url.hostname.toLowerCase().replace(/^www\./i, '');
}

export function normalizeOutboundLinkDomain(value: string): string {
  return normalizeOutboundLinkUrl(value);
}

function tagsForEntry(
  followStatus: OutboundLinkFollowStatus,
  loginRequired: boolean | null,
  captchaRequired: boolean | null
): OutboundLinkTag[] {
  const tags: OutboundLinkTag[] = [];
  if (followStatus === 'dofollow') tags.push('dofollow');
  if (followStatus === 'nofollow') tags.push('nofollow');
  if (loginRequired === true) tags.push('login_required');
  if (captchaRequired === true) tags.push('captcha_required');
  return tags;
}

function fieldsFromTags(tags: readonly OutboundLinkTag[]): {
  followStatus: OutboundLinkFollowStatus;
  loginRequired: boolean | null;
  captchaRequired: boolean | null;
} {
  return {
    followStatus: tags.includes('dofollow')
      ? 'dofollow'
      : tags.includes('nofollow')
        ? 'nofollow'
        : 'unknown',
    loginRequired: tags.includes('login_required') ? true : null,
    captchaRequired: tags.includes('captcha_required') ? true : null,
  };
}

function normalizeFollowStatus(value: unknown): OutboundLinkFollowStatus {
  if (
    OUTBOUND_LINK_FOLLOW_STATUSES.includes(value as OutboundLinkFollowStatus)
  ) {
    return value as OutboundLinkFollowStatus;
  }
  throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_INVALID');
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

function hasOwn(
  value: object,
  key:
    | 'url'
    | 'domain'
    | 'tags'
    | 'followStatus'
    | 'loginRequired'
    | 'captchaRequired'
): boolean {
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
    try {
      if (!storedEntry || typeof storedEntry !== 'object') continue;
      const candidate = storedEntry as Record<string, unknown>;
      const id = typeof candidate.id === 'string' ? candidate.id : '';
      const sourceDomain =
        typeof candidate.domain === 'string'
          ? candidate.domain
          : typeof candidate.url === 'string'
            ? candidate.url
            : '';
      const domain = normalizeOutboundLinkDomain(sourceDomain);
      const createdAt =
        typeof candidate.createdAt === 'number' &&
        Number.isInteger(candidate.createdAt) &&
        candidate.createdAt >= 0
          ? candidate.createdAt
          : 0;
      const updatedAt =
        typeof candidate.updatedAt === 'number' &&
        Number.isInteger(candidate.updatedAt) &&
        candidate.updatedAt >= 0
          ? candidate.updatedAt
          : createdAt;
      const legacyTags = Array.isArray(candidate.tags)
        ? normalizeOutboundLinkTags(candidate.tags)
        : [];
      const legacyFields = fieldsFromTags(legacyTags);
      const followStatus = OUTBOUND_LINK_FOLLOW_STATUSES.includes(
        candidate.followStatus as OutboundLinkFollowStatus
      )
        ? (candidate.followStatus as OutboundLinkFollowStatus)
        : legacyFields.followStatus;
      const loginRequired =
        typeof candidate.loginRequired === 'boolean'
          ? candidate.loginRequired
          : legacyFields.loginRequired;
      const captchaRequired =
        typeof candidate.captchaRequired === 'boolean'
          ? candidate.captchaRequired
          : legacyFields.captchaRequired;
      const entry: OutboundLinkLibraryEntry = {
        id: id || createEntryId(),
        domain,
        url: domain,
        tags: tagsForEntry(followStatus, loginRequired, captchaRequired),
        followStatus,
        loginRequired,
        captchaRequired,
        createdAt,
        updatedAt,
      };
      const parsed = outboundLinkLibraryEntrySchema.safeParse(entry);
      if (!parsed.success) continue;
      const existingIndex = entries.findIndex(
        (candidate) => candidate.domain === entry.domain
      );
      if (existingIndex >= 0) {
        const existing = entries[existingIndex];
        if (entry.updatedAt >= existing.updatedAt) {
          entries[existingIndex] = entry;
        }
        continue;
      }
      if (ids.has(entry.id) || urls.has(entry.domain)) continue;
      ids.add(entry.id);
      urls.add(entry.domain);
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
  const raw = stored[OUTBOUND_LINK_LIBRARY_STORAGE_KEY];
  const parsed = parseStoredOutboundLinkLibrary(raw) ?? [];
  if (Array.isArray(raw) && JSON.stringify(raw) !== JSON.stringify(parsed)) {
    await chrome.storage.local.set({
      [OUTBOUND_LINK_LIBRARY_STORAGE_KEY]: parsed,
    });
  }
  return parsed;
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
  const domain = normalizeOutboundLinkDomain(input.domain ?? input.url);
  const tags = normalizeOutboundLinkTags(input.tags ?? []);
  const legacyFields = fieldsFromTags(tags);
  const followStatus =
    input.followStatus === undefined
      ? legacyFields.followStatus
      : normalizeFollowStatus(input.followStatus);
  const loginRequired =
    input.loginRequired === undefined
      ? legacyFields.loginRequired
      : input.loginRequired;
  const captchaRequired =
    input.captchaRequired === undefined
      ? legacyFields.captchaRequired
      : input.captchaRequired;

  return serializeOutboundLinkLibraryMutation(async () => {
    const entries = await getOutboundLinkLibrary();
    const existing = entries.find((entry) => entry.domain === domain);
    const hasMetadataUpdate =
      input.followStatus !== undefined ||
      input.loginRequired !== undefined ||
      input.captchaRequired !== undefined ||
      input.now !== undefined;
    if (existing && !hasMetadataUpdate) {
      return { entry: existing, created: false };
    }
    if (existing) {
      const updated: OutboundLinkLibraryEntry = {
        ...existing,
        followStatus:
          input.followStatus === undefined
            ? existing.followStatus
            : followStatus,
        loginRequired:
          input.loginRequired === undefined
            ? existing.loginRequired
            : loginRequired,
        captchaRequired:
          input.captchaRequired === undefined
            ? existing.captchaRequired
            : captchaRequired,
        tags: tagsForEntry(
          input.followStatus === undefined
            ? existing.followStatus
            : followStatus,
          input.loginRequired === undefined
            ? existing.loginRequired
            : loginRequired,
          input.captchaRequired === undefined
            ? existing.captchaRequired
            : captchaRequired
        ),
        updatedAt: input.now ?? Date.now(),
      };
      await setOutboundLinkLibrary(
        entries.map((entry) => (entry.id === existing.id ? updated : entry))
      );
      return { entry: updated, created: false };
    }
    if (entries.length >= MAX_OUTBOUND_LINK_ENTRIES) {
      throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_LIMIT_EXCEEDED');
    }

    const now = input.now ?? Date.now();
    const entry: OutboundLinkLibraryEntry = {
      id: createEntryId(),
      domain,
      url: domain,
      tags: tagsForEntry(followStatus, loginRequired, captchaRequired),
      followStatus,
      loginRequired,
      captchaRequired,
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

  const updatesUrl = hasOwn(input, 'url') || hasOwn(input, 'domain');
  const updatesTags = hasOwn(input, 'tags');
  const updatesFollowStatus = Object.hasOwn(input, 'followStatus');
  const updatesLoginRequired = Object.hasOwn(input, 'loginRequired');
  const updatesCaptchaRequired = Object.hasOwn(input, 'captchaRequired');
  if (
    !updatesUrl &&
    !updatesTags &&
    !updatesFollowStatus &&
    !updatesLoginRequired &&
    !updatesCaptchaRequired
  ) {
    throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_INVALID');
  }

  const url = updatesUrl
    ? normalizeOutboundLinkDomain((input.domain ?? input.url) as string)
    : undefined;
  const tags = updatesTags ? normalizeOutboundLinkTags(input.tags) : undefined;

  return serializeOutboundLinkLibraryMutation(async () => {
    const entries = await getOutboundLinkLibrary();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) return null;

    const current = entries[index];
    const nextUrl = url ?? current.domain;
    const duplicate = entries.find(
      (entry) => entry.id !== id && entry.domain === nextUrl
    );
    if (duplicate) {
      throw new OutboundLinkLibraryError('OUTBOUND_LINK_ENTRY_DUPLICATE');
    }

    const legacyFields = tags ? fieldsFromTags(tags) : undefined;
    const nextFollowStatus = updatesFollowStatus
      ? normalizeFollowStatus(input.followStatus)
      : (legacyFields?.followStatus ?? current.followStatus);
    const nextLoginRequired = updatesLoginRequired
      ? (input.loginRequired ?? null)
      : (legacyFields?.loginRequired ?? current.loginRequired);
    const nextCaptchaRequired = updatesCaptchaRequired
      ? (input.captchaRequired ?? null)
      : (legacyFields?.captchaRequired ?? current.captchaRequired);
    const updated: OutboundLinkLibraryEntry = {
      ...current,
      domain: nextUrl,
      url: nextUrl,
      tags: tagsForEntry(
        nextFollowStatus,
        nextLoginRequired,
        nextCaptchaRequired
      ),
      followStatus: nextFollowStatus,
      loginRequired: nextLoginRequired,
      captchaRequired: nextCaptchaRequired,
      updatedAt: input.now ?? Date.now(),
    };
    const next = entries.map((entry, entryIndex) =>
      entryIndex === index ? updated : entry
    );
    await setOutboundLinkLibrary(next);
    return updated;
  });
}

export async function upsertOutboundLinkLibraryEntry(
  input: UpsertOutboundLinkLibraryEntryInput
): Promise<OutboundLinkLibraryEntry> {
  return (
    await addOutboundLinkLibraryEntryWithResult({
      ...input,
      url: input.domain,
    })
  ).entry;
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
