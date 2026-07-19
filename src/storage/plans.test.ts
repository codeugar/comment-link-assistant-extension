import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  PLANS_STORAGE_KEY,
  type SitePlan,
  deletePlan,
  getPlans,
  savePlan,
} from './plans';

function plan(siteId: string, overrides: Partial<SitePlan> = {}): SitePlan {
  return {
    siteId,
    chunkSize: 30,
    chunks: [
      { id: `${siteId}:0`, urls: ['https://a.example/1'], status: 'pending' },
    ],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('plans storage', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('returns an empty map when nothing is stored', async () => {
    expect(await getPlans()).toEqual({});
  });

  it('saves and reads a plan per site', async () => {
    await savePlan(plan('seed'));
    await savePlan(plan('muse'));

    const plans = await getPlans();
    expect(Object.keys(plans).sort()).toEqual(['muse', 'seed']);
    expect(plans.seed?.siteId).toBe('seed');
  });

  it('replaces the existing plan for the same site', async () => {
    await savePlan(plan('seed', { chunkSize: 30 }));
    await savePlan(plan('seed', { chunkSize: 10 }));

    const plans = await getPlans();
    expect(Object.keys(plans)).toEqual(['seed']);
    expect(plans.seed?.chunkSize).toBe(10);
  });

  it('deletes a single plan and leaves the others', async () => {
    await savePlan(plan('seed'));
    await savePlan(plan('muse'));
    await deletePlan('seed');

    expect(Object.keys(await getPlans())).toEqual(['muse']);
  });

  it('treats invalid stored data as an empty map', async () => {
    await chrome.storage.local.set({ [PLANS_STORAGE_KEY]: [1, 2, 3] });
    expect(await getPlans()).toEqual({});
  });

  it('rejects an out-of-range chunk size on save', async () => {
    await expect(savePlan(plan('seed', { chunkSize: 0 }))).rejects.toThrow();
    await expect(savePlan(plan('seed', { chunkSize: 201 }))).rejects.toThrow();
  });
});
