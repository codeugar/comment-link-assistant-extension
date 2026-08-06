import { emptyAnchorLedger } from '@/storage/anchor-ledger';
import { describe, expect, it } from 'vitest';
import {
  type AnchorBucketCounts,
  pickAnchorText,
  selectAnchor,
  selectAnchorBucket,
} from './select';
import {
  ANCHOR_BUCKETS,
  type AnchorBucket,
  type AnchorPlan,
  createDefaultAnchorPlan,
} from './types';

function planWithEveryPoolFilled(): AnchorPlan {
  const plan = createDefaultAnchorPlan('site-1', 1_000);
  for (const bucket of ANCHOR_BUCKETS) {
    plan.pools[bucket] = [`${bucket}-text`];
  }
  return plan;
}

function zeroCounts(): AnchorBucketCounts {
  return { brand: 0, naked: 0, exact: 0, partial: 0, generic: 0, natural: 0 };
}

/** Replays the picker, feeding each pick straight back in as history. */
function runPicks(plan: AnchorPlan, rounds: number): AnchorBucket[] {
  const counts = zeroCounts();
  const picked: AnchorBucket[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const bucket = selectAnchorBucket(plan, counts);
    if (!bucket) break;
    counts[bucket] += 1;
    picked.push(bucket);
  }
  return picked;
}

function tally(picked: readonly AnchorBucket[]): AnchorBucketCounts {
  const counts = zeroCounts();
  for (const bucket of picked) counts[bucket] += 1;
  return counts;
}

describe('anchor bucket selection', () => {
  it('lands exactly on the configured mix over a full cycle', () => {
    expect(tally(runPicks(planWithEveryPoolFilled(), 20))).toEqual({
      brand: 6,
      naked: 4,
      exact: 4,
      partial: 3,
      generic: 2,
      natural: 1,
    });
  });

  it('spreads each bucket out instead of emitting it in a block', () => {
    expect(runPicks(planWithEveryPoolFilled(), 7)).toEqual([
      'brand',
      'naked',
      'exact',
      'partial',
      'brand',
      'generic',
      'naked',
    ]);
  });

  it('opens with the largest share when there is no history at all', () => {
    expect(selectAnchorBucket(planWithEveryPoolFilled(), zeroCounts())).toBe(
      'brand'
    );
  });

  it('picks the bucket furthest behind its share', () => {
    const counts: AnchorBucketCounts = {
      brand: 30,
      naked: 20,
      exact: 5,
      partial: 15,
      generic: 10,
      natural: 5,
    };

    expect(selectAnchorBucket(planWithEveryPoolFilled(), counts)).toBe('exact');
  });

  it('pulls a mix back toward an edited target without recomputing history', () => {
    const plan = planWithEveryPoolFilled();
    plan.targets = {
      brand: 10,
      naked: 10,
      exact: 60,
      partial: 10,
      generic: 10,
      natural: 0,
    };
    // A history built under the previous 30/20/20/15/10/5 split.
    const counts: AnchorBucketCounts = {
      brand: 30,
      naked: 20,
      exact: 20,
      partial: 15,
      generic: 10,
      natural: 5,
    };

    expect(selectAnchorBucket(plan, counts)).toBe('exact');
  });

  it('renormalizes the remaining targets when a bucket has no text', () => {
    const plan = createDefaultAnchorPlan('site-1', 1_000);
    plan.pools.brand = ['Example'];
    plan.pools.exact = ['AI video generator'];
    plan.targets.natural = 0;

    // brand 30 and exact 20 renormalize to 60/40, so 10 picks split 6/4 and no
    // pick leaks into a bucket that has nothing to say.
    expect(tally(runPicks(plan, 10))).toEqual({
      brand: 6,
      naked: 0,
      exact: 4,
      partial: 0,
      generic: 0,
      natural: 0,
    });
  });

  it('keeps the natural bucket available on an empty fallback pool', () => {
    const plan = createDefaultAnchorPlan('site-1', 1_000);
    plan.targets = {
      brand: 0,
      naked: 0,
      exact: 0,
      partial: 0,
      generic: 0,
      natural: 100,
    };

    expect(selectAnchorBucket(plan, zeroCounts())).toBe('natural');
  });

  it('skips a bucket the caller excluded after it failed to produce text', () => {
    const plan = planWithEveryPoolFilled();

    expect(selectAnchorBucket(plan, zeroCounts(), ['brand'])).toBe('naked');
  });

  it('reports no selection when the site has no anchor mix configured', () => {
    const plan = createDefaultAnchorPlan('site-1', 1_000);
    plan.targets.natural = 0;
    plan.targets.brand = 35;

    expect(selectAnchorBucket(plan, zeroCounts())).toBeNull();
    expect(selectAnchor(plan, emptyAnchorLedger('site-1', 1_000))).toBeNull();
  });
});

describe('anchor text rotation', () => {
  it('advances through a pool before repeating an entry', () => {
    let plan = createDefaultAnchorPlan('site-1', 1_000);
    plan.pools.brand = ['Example', 'Example App', 'Example Studio'];

    const drawn: (string | null)[] = [];
    for (let round = 0; round < 4; round += 1) {
      const pick = pickAnchorText(plan, 'brand');
      drawn.push(pick.text);
      plan = { ...plan, cursor: pick.cursor };
    }

    expect(drawn).toEqual([
      'Example',
      'Example App',
      'Example Studio',
      'Example',
    ]);
  });

  it('stays in range after the pool shrinks under a stored cursor', () => {
    const plan = createDefaultAnchorPlan('site-1', 1_000);
    plan.pools.brand = ['Example'];
    plan.cursor.brand = 7;

    expect(pickAnchorText(plan, 'brand')).toEqual({
      text: 'Example',
      cursor: { ...plan.cursor, brand: 0 },
    });
  });
});

describe('anchor selection counts', () => {
  it('counts a comment awaiting moderation toward the next pick', () => {
    const plan = planWithEveryPoolFilled();
    const ledger = emptyAnchorLedger('site-1', 1_000);
    ledger.pending = [
      { bucket: 'brand', targetUrl: 'https://blog.example/a', at: 1_000 },
    ];

    // Without the pending row the opening pick would be brand again.
    expect(selectAnchor(plan, ledger)?.bucket).toBe('naked');
  });

  it('draws pool text for a pool-backed bucket and defers wording for natural', () => {
    const plan = planWithEveryPoolFilled();
    const ledger = emptyAnchorLedger('site-1', 1_000);

    expect(selectAnchor(plan, ledger)).toEqual({
      bucket: 'brand',
      text: 'brand-text',
      cursor: { ...plan.cursor, brand: 0 },
    });

    plan.targets = {
      brand: 0,
      naked: 0,
      exact: 0,
      partial: 0,
      generic: 0,
      natural: 100,
    };
    expect(selectAnchor(plan, ledger)).toEqual({
      bucket: 'natural',
      text: null,
      cursor: plan.cursor,
    });
  });
});
