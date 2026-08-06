export const ANCHOR_BUCKETS = [
  'brand',
  'naked',
  'exact',
  'partial',
  'generic',
  'natural',
] as const;

export type AnchorBucket = (typeof ANCHOR_BUCKETS)[number];

export type AnchorBucketTargets = Record<AnchorBucket, number>;

export type AnchorBucketPools = Record<AnchorBucket, string[]>;

export type AnchorBucketCursors = Record<AnchorBucket, number>;

/** Per-promoted-site anchor mix: the targets, the wording, and where the
 *  rotation inside each bucket currently sits. */
export interface AnchorPlan {
  siteId: string;
  /** Whole percentages that must add up to 100 across every bucket. */
  targets: AnchorBucketTargets;
  /** Candidate anchor texts. The natural bucket's pool is a fallback only:
   *  its wording is normally written per comment at generation time. */
  pools: AnchorBucketPools;
  cursor: AnchorBucketCursors;
  updatedAt: number;
}

export const DEFAULT_ANCHOR_TARGETS: AnchorBucketTargets = {
  brand: 30,
  naked: 20,
  exact: 20,
  partial: 15,
  generic: 10,
  natural: 5,
};

export const ANCHOR_TARGET_TOTAL = 100;
export const MAX_ANCHOR_POOL_ENTRIES = 50;
export const MAX_ANCHOR_TEXT_LENGTH = 80;

export function emptyAnchorPools(): AnchorBucketPools {
  return {
    brand: [],
    naked: [],
    exact: [],
    partial: [],
    generic: [],
    natural: [],
  };
}

export function emptyAnchorCursors(): AnchorBucketCursors {
  return { brand: 0, naked: 0, exact: 0, partial: 0, generic: 0, natural: 0 };
}

export function createDefaultAnchorPlan(
  siteId: string,
  now: number
): AnchorPlan {
  return {
    siteId,
    targets: { ...DEFAULT_ANCHOR_TARGETS },
    pools: emptyAnchorPools(),
    cursor: emptyAnchorCursors(),
    updatedAt: now,
  };
}
