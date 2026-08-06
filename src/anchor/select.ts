import type { AnchorLedger } from '@/storage/anchor-ledger';
import {
  ANCHOR_BUCKETS,
  type AnchorBucket,
  type AnchorBucketCursors,
  type AnchorPlan,
} from './types';

export type AnchorBucketCounts = Record<AnchorBucket, number>;

export interface AnchorSelection {
  bucket: AnchorBucket;
  /**
   * The anchor text to render, or null when the bucket's wording is authored
   * during comment generation rather than drawn from a pool.
   */
  text: string | null;
  /** Cursors to persist so the next pick continues the rotation. */
  cursor: AnchorBucketCursors;
}

/**
 * Counts that drive the next pick. A comment held for moderation counts here
 * even though it is not part of the published profile yet: a run whose targets
 * all moderate would otherwise see an unchanging tally and pick the same bucket
 * for every remaining target.
 */
export function anchorSelectionCounts(
  ledger: AnchorLedger
): AnchorBucketCounts {
  const counts = { ...ledger.published };
  for (const entry of ledger.pending) {
    counts[entry.bucket] += 1;
  }
  return counts;
}

function bucketHasText(plan: AnchorPlan, bucket: AnchorBucket): boolean {
  // The natural bucket is written per comment, so it stays available even with
  // an empty fallback pool.
  return bucket === 'natural' || plan.pools[bucket].length > 0;
}

/**
 * Picks the bucket that is furthest behind its share.
 *
 * `weight * (n + 1) - count` reads as "how many links this bucket should hold
 * once the next one lands, minus how many it holds now". Taking the largest
 * value each time drives the running mix toward the targets and pulls it back
 * whenever it drifts — including after the targets themselves are edited, since
 * nothing about the history has to be recomputed.
 *
 * Buckets with no target share and buckets with nothing to say are dropped, and
 * the remaining targets are renormalized over what is left, so an empty bucket
 * cannot silently hold back everyone else's share.
 */
export function selectAnchorBucket(
  plan: AnchorPlan,
  counts: AnchorBucketCounts,
  exclude: readonly AnchorBucket[] = []
): AnchorBucket | null {
  const eligible = ANCHOR_BUCKETS.filter(
    (bucket) =>
      plan.targets[bucket] > 0 &&
      bucketHasText(plan, bucket) &&
      !exclude.includes(bucket)
  );
  if (eligible.length === 0) return null;

  const targetTotal = eligible.reduce(
    (sum, bucket) => sum + plan.targets[bucket],
    0
  );
  const total = eligible.reduce((sum, bucket) => sum + counts[bucket], 0);

  let best: AnchorBucket | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const bucket of eligible) {
    const weight = plan.targets[bucket] / targetTotal;
    const score = weight * (total + 1) - counts[bucket];
    // ANCHOR_BUCKETS order breaks a tie, which keeps the sequence reproducible
    // for a given history.
    if (score > bestScore) {
      best = bucket;
      bestScore = score;
    }
  }
  return best;
}

/** Draws the next text from a bucket, rotating so one entry is not reused. */
export function pickAnchorText(
  plan: AnchorPlan,
  bucket: AnchorBucket
): { text: string | null; cursor: AnchorBucketCursors } {
  const pool = plan.pools[bucket];
  if (pool.length === 0) return { text: null, cursor: plan.cursor };
  const index = plan.cursor[bucket] % pool.length;
  return {
    text: pool[index] ?? null,
    cursor: { ...plan.cursor, [bucket]: (index + 1) % pool.length },
  };
}

/**
 * Chooses the bucket and wording for the next link. Returns null when the site
 * has no anchor mix configured, which leaves the caller on its existing default
 * anchor text and keeps the ledger untouched.
 */
export function selectAnchor(
  plan: AnchorPlan,
  ledger: AnchorLedger,
  exclude: readonly AnchorBucket[] = []
): AnchorSelection | null {
  const bucket = selectAnchorBucket(
    plan,
    anchorSelectionCounts(ledger),
    exclude
  );
  if (!bucket) return null;
  // The natural bucket asks the model for wording during generation; its pool
  // is only consulted if that falls through.
  if (bucket === 'natural') {
    return { bucket, text: null, cursor: plan.cursor };
  }
  const { text, cursor } = pickAnchorText(plan, bucket);
  return { bucket, text, cursor };
}
