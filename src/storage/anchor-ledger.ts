import {
  ANCHOR_BUCKETS,
  type AnchorBucket,
  MAX_ANCHOR_TEXT_LENGTH,
} from '@/anchor/types';
import { z } from 'zod';

export const ANCHOR_LEDGER_STORAGE_KEY = 'comment-link-assistant.anchor-ledger';

const MAX_SITES_WITH_ANCHOR_LEDGERS = 20;
// A comment awaiting review that is never seen again eventually falls off the
// back of this list. Dropping it is the honest outcome: publication was never
// confirmed, so it must not count toward the site's live anchor profile.
const MAX_PENDING_ENTRIES = 500;
// Per-wording rows are a breakdown of `published`, not the source of it. Pools
// hold at most 50 entries per bucket and only the natural bucket writes free
// wording, so this ceiling is far above a real site; when it is reached the
// least-used rows go first and the bucket totals stay correct regardless.
export const MAX_ANCHOR_TEXT_ROWS = 500;

export interface AnchorPendingEntry {
  bucket: AnchorBucket;
  targetUrl: string;
  at: number;
  /** Wording the comment actually carried. Absent on rows written before the
   *  ledger recorded wording. */
  text?: string;
}

/** How often one exact wording has gone live for a site. */
export interface AnchorTextTally {
  bucket: AnchorBucket;
  text: string;
  count: number;
  lastAt: number;
}

/**
 * The running anchor-text profile of one promoted site.
 *
 * `published` is a permanent tally that only ever grows — it survives batch
 * history pruning, so the ratio is measured over the site's whole lifetime
 * rather than the current batch. Comments still awaiting moderation are kept as
 * rows instead of a second counter, so the pending tally is always derived from
 * entries that actually exist and can never drift away from them.
 */
export interface AnchorLedger {
  siteId: string;
  published: Record<AnchorBucket, number>;
  pending: AnchorPendingEntry[];
  /**
   * Which exact wording went out, and how often. A breakdown of `published`
   * that starts empty on ledgers written before it existed, so its sum can
   * legitimately trail the bucket totals — the totals stay authoritative.
   */
  texts: AnchorTextTally[];
  updatedAt: number;
}

export type AnchorLedgersMap = Record<string, AnchorLedger>;

export const anchorLedgerSchema: z.ZodType<AnchorLedger> = z
  .object({
    siteId: z.string().min(1).max(200),
    published: z
      .object(
        Object.fromEntries(
          ANCHOR_BUCKETS.map((bucket) => [
            bucket,
            z.number().int().nonnegative(),
          ])
        ) as Record<AnchorBucket, z.ZodNumber>
      )
      .strict(),
    pending: z
      .array(
        z
          .object({
            bucket: z.enum(ANCHOR_BUCKETS),
            targetUrl: z.string().min(1).max(2_048),
            at: z.number().int().nonnegative(),
            text: z.string().min(1).max(MAX_ANCHOR_TEXT_LENGTH).optional(),
          })
          .strict()
      )
      .max(MAX_PENDING_ENTRIES),
    // Defaulted rather than required, so a ledger stored before wording was
    // tracked still parses instead of failing the whole map back to empty.
    texts: z
      .array(
        z
          .object({
            bucket: z.enum(ANCHOR_BUCKETS),
            text: z.string().min(1).max(MAX_ANCHOR_TEXT_LENGTH),
            count: z.number().int().positive(),
            lastAt: z.number().int().nonnegative(),
          })
          .strict()
      )
      .max(MAX_ANCHOR_TEXT_ROWS)
      .default([]),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const anchorLedgersSchema = z
  .record(z.string(), anchorLedgerSchema)
  .refine((map) => Object.keys(map).length <= MAX_SITES_WITH_ANCHOR_LEDGERS);

export function emptyAnchorLedger(siteId: string, now: number): AnchorLedger {
  return {
    siteId,
    published: {
      brand: 0,
      naked: 0,
      exact: 0,
      partial: 0,
      generic: 0,
      natural: 0,
    },
    pending: [],
    texts: [],
    updatedAt: now,
  };
}

/** Comparable form for merging the same wording written with different case or
 *  spacing into one row. */
export function comparableAnchorText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function creditAnchorText(
  texts: readonly AnchorTextTally[],
  bucket: AnchorBucket,
  text: string | undefined,
  now: number
): AnchorTextTally[] {
  const wording = text?.trim().replace(/\s+/g, ' ').slice(0, 80) ?? '';
  if (!wording) return [...texts];
  const key = comparableAnchorText(wording);
  const index = texts.findIndex(
    (row) => row.bucket === bucket && comparableAnchorText(row.text) === key
  );
  if (index >= 0) {
    const next = [...texts];
    const row = next[index] as AnchorTextTally;
    next[index] = { ...row, count: row.count + 1, lastAt: now };
    return next;
  }
  const next = [...texts, { bucket, text: wording, count: 1, lastAt: now }];
  if (next.length <= MAX_ANCHOR_TEXT_ROWS) return next;
  // Over the ceiling the rows that explain the least go first, oldest before
  // newer at the same count.
  const weakest = next.reduce((lowest, row) =>
    row.count < lowest.count ||
    (row.count === lowest.count && row.lastAt < lowest.lastAt)
      ? row
      : lowest
  );
  return next.filter((row) => row !== weakest);
}

/** Comparable form for matching a moderation recheck back to its pending row. */
export function comparableLedgerUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

export function parseStoredAnchorLedgers(
  value: unknown
): AnchorLedgersMap | null {
  const parsed = anchorLedgersSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function getAnchorLedgers(): Promise<AnchorLedgersMap> {
  const stored = await chrome.storage.local.get(ANCHOR_LEDGER_STORAGE_KEY);
  return parseStoredAnchorLedgers(stored[ANCHOR_LEDGER_STORAGE_KEY]) ?? {};
}

export async function setAnchorLedgers(
  ledgers: AnchorLedgersMap
): Promise<void> {
  const parsed = anchorLedgersSchema.parse(ledgers);
  await chrome.storage.local.set({ [ANCHOR_LEDGER_STORAGE_KEY]: parsed });
}

export async function getAnchorLedger(
  siteId: string,
  now: number = Date.now()
): Promise<AnchorLedger> {
  const ledgers = await getAnchorLedgers();
  return ledgers[siteId] ?? emptyAnchorLedger(siteId, now);
}

async function updateAnchorLedger(
  siteId: string,
  now: number,
  update: (ledger: AnchorLedger) => AnchorLedger
): Promise<AnchorLedger> {
  const ledgers = await getAnchorLedgers();
  const current = ledgers[siteId] ?? emptyAnchorLedger(siteId, now);
  const next = { ...update(current), updatedAt: now };
  await setAnchorLedgers({ ...ledgers, [siteId]: next });
  return next;
}

/** Records a comment confirmed live on the target page. */
export function recordAnchorPublished(
  siteId: string,
  bucket: AnchorBucket,
  text?: string,
  now: number = Date.now()
): Promise<AnchorLedger> {
  return updateAnchorLedger(siteId, now, (ledger) => ({
    ...ledger,
    published: { ...ledger.published, [bucket]: ledger.published[bucket] + 1 },
    texts: creditAnchorText(ledger.texts, bucket, text, now),
  }));
}

/**
 * Records a comment accepted but held for review. It counts toward bucket
 * selection right away — otherwise a run whose targets all moderate would keep
 * picking the same bucket — but never toward the published profile until a
 * recheck confirms it.
 */
export function recordAnchorPending(
  siteId: string,
  bucket: AnchorBucket,
  targetUrl: string,
  text?: string,
  now: number = Date.now()
): Promise<AnchorLedger> {
  const wording = text?.trim().replace(/\s+/g, ' ').slice(0, 80) || undefined;
  return updateAnchorLedger(siteId, now, (ledger) => ({
    ...ledger,
    pending: [
      ...ledger.pending.filter(
        (entry) =>
          comparableLedgerUrl(entry.targetUrl) !==
          comparableLedgerUrl(targetUrl)
      ),
      { bucket, targetUrl, at: now, ...(wording ? { text: wording } : {}) },
    ].slice(-MAX_PENDING_ENTRIES),
  }));
}

/**
 * Settles a pending row once moderation resolves. `published` promotes it into
 * the permanent tally; `dropped` discards it, which is what a comment that was
 * rejected or silently never appeared deserves.
 */
export function resolveAnchorPending(
  siteId: string,
  targetUrl: string,
  outcome: 'published' | 'dropped',
  now: number = Date.now()
): Promise<AnchorLedger> {
  const wanted = comparableLedgerUrl(targetUrl);
  return updateAnchorLedger(siteId, now, (ledger) => {
    const entry = ledger.pending.find(
      (candidate) => comparableLedgerUrl(candidate.targetUrl) === wanted
    );
    if (!entry) return ledger;
    const pending = ledger.pending.filter(
      (candidate) => comparableLedgerUrl(candidate.targetUrl) !== wanted
    );
    if (outcome === 'dropped') return { ...ledger, pending };
    return {
      ...ledger,
      published: {
        ...ledger.published,
        [entry.bucket]: ledger.published[entry.bucket] + 1,
      },
      pending,
      texts: creditAnchorText(ledger.texts, entry.bucket, entry.text, now),
    };
  });
}

export async function deleteAnchorLedger(siteId: string): Promise<void> {
  const ledgers = await getAnchorLedgers();
  if (!(siteId in ledgers)) return;
  const next = { ...ledgers };
  delete next[siteId];
  await setAnchorLedgers(next);
}
