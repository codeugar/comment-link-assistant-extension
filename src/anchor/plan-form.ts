import {
  ANCHOR_BUCKETS,
  ANCHOR_TARGET_TOTAL,
  type AnchorBucket,
  type AnchorBucketTargets,
  MAX_ANCHOR_POOL_ENTRIES,
  MAX_ANCHOR_TEXT_LENGTH,
} from './types';

/** Editing a pool as one entry per line keeps the form a plain textarea. */
export function parseAnchorPool(value: string): string[] {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const line of value.split(/\r?\n/)) {
    const entry = line
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, MAX_ANCHOR_TEXT_LENGTH);
    if (!entry) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= MAX_ANCHOR_POOL_ENTRIES) break;
  }
  return entries;
}

export function formatAnchorPool(pool: readonly string[]): string {
  return pool.join('\n');
}

export function anchorTargetTotal(targets: AnchorBucketTargets): number {
  return ANCHOR_BUCKETS.reduce((sum, bucket) => sum + targets[bucket], 0);
}

/**
 * Rescales the entered percentages so they add up to 100, keeping their
 * relative sizes. Whole percentages rarely divide evenly, so the leftover
 * points go to the buckets with the largest fractional remainder — the same
 * largest-remainder rule the picker itself converges on.
 */
export function normalizeAnchorTargets(
  targets: AnchorBucketTargets
): AnchorBucketTargets {
  const total = anchorTargetTotal(targets);
  if (total === ANCHOR_TARGET_TOTAL) return { ...targets };
  if (total <= 0) {
    const even = Math.floor(ANCHOR_TARGET_TOTAL / ANCHOR_BUCKETS.length);
    const scaled = Object.fromEntries(
      ANCHOR_BUCKETS.map((bucket) => [bucket, even])
    ) as AnchorBucketTargets;
    return distributeRemainder(
      scaled,
      ANCHOR_BUCKETS.map((bucket) => ({ bucket, remainder: 0 }))
    );
  }

  const scaled = {} as AnchorBucketTargets;
  const remainders: { bucket: AnchorBucket; remainder: number }[] = [];
  for (const bucket of ANCHOR_BUCKETS) {
    const exact = (targets[bucket] / total) * ANCHOR_TARGET_TOTAL;
    scaled[bucket] = Math.floor(exact);
    remainders.push({ bucket, remainder: exact - Math.floor(exact) });
  }
  return distributeRemainder(scaled, remainders);
}

function distributeRemainder(
  scaled: AnchorBucketTargets,
  remainders: { bucket: AnchorBucket; remainder: number }[]
): AnchorBucketTargets {
  const next = { ...scaled };
  let short = ANCHOR_TARGET_TOTAL - anchorTargetTotal(next);
  const ordered = [...remainders].sort(
    (left, right) =>
      right.remainder - left.remainder ||
      ANCHOR_BUCKETS.indexOf(left.bucket) - ANCHOR_BUCKETS.indexOf(right.bucket)
  );
  let index = 0;
  while (short > 0 && ordered.length > 0) {
    const entry = ordered[index % ordered.length];
    if (entry) next[entry.bucket] += 1;
    short -= 1;
    index += 1;
  }
  return next;
}

/**
 * The bare-URL spellings worth rotating between. A mix that always uses the
 * identical string is as recognizable as one that always uses the same keyword.
 */
export function bareUrlAnchorVariants(websiteUrl: string): string[] {
  let url: URL;
  try {
    url = new URL(websiteUrl.trim());
  } catch {
    return [];
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];
  const bareHost = url.hostname.replace(/^www\./, '');
  const path = url.pathname === '/' ? '' : url.pathname;
  const canonical = `${url.protocol}//${url.host}${path}`.replace(/\/$/, '');
  const variants = [
    canonical,
    `${bareHost}${path}`.replace(/\/$/, ''),
    `www.${bareHost}${path}`.replace(/\/$/, ''),
  ];
  return [...new Set(variants)].filter(
    (variant) => variant.length <= MAX_ANCHOR_TEXT_LENGTH
  );
}
