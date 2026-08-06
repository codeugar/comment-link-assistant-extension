import {
  DEFAULT_ANCHOR_TARGETS,
  createDefaultAnchorPlan,
} from '@/anchor/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  deleteAnchorPlan,
  getAnchorPlan,
  getAnchorPlans,
  parseStoredAnchorPlans,
  saveAnchorPlan,
} from './anchor-plan';

describe('anchor plan storage', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('returns a default plan with empty pools for an unconfigured site', async () => {
    const plan = await getAnchorPlan('site-1', 1_000);

    expect(plan.targets).toEqual(DEFAULT_ANCHOR_TARGETS);
    expect(plan.pools.brand).toEqual([]);
    expect(await getAnchorPlans()).toEqual({});
  });

  it('persists, reads back and deletes a plan', async () => {
    const plan = createDefaultAnchorPlan('site-1', 1_000);
    plan.pools.brand = ['Example'];
    plan.cursor.brand = 3;
    await saveAnchorPlan(plan);

    expect(await getAnchorPlan('site-1')).toEqual(plan);

    await deleteAnchorPlan('site-1');
    expect(await getAnchorPlans()).toEqual({});
  });

  it('rejects targets that do not add up to 100', async () => {
    const plan = createDefaultAnchorPlan('site-1', 1_000);
    plan.targets.brand = 31;

    await expect(saveAnchorPlan(plan)).rejects.toThrow();
  });

  it('accepts any split that adds up to 100, including a single bucket', async () => {
    const plan = createDefaultAnchorPlan('site-1', 1_000);
    plan.targets = {
      brand: 100,
      naked: 0,
      exact: 0,
      partial: 0,
      generic: 0,
      natural: 0,
    };

    await expect(saveAnchorPlan(plan)).resolves.toBeUndefined();
  });

  it('rejects an anchor text longer than the stored limit', async () => {
    const plan = createDefaultAnchorPlan('site-1', 1_000);
    plan.pools.exact = ['x'.repeat(81)];

    await expect(saveAnchorPlan(plan)).rejects.toThrow();
  });

  it('reads a stored value that is not a plans map as absent', () => {
    expect(parseStoredAnchorPlans({ 'site-1': { targets: {} } })).toBeNull();
    expect(parseStoredAnchorPlans('nonsense')).toBeNull();
  });
});
