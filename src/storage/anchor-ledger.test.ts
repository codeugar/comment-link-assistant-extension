import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  getAnchorLedger,
  recordAnchorPending,
  recordAnchorPublished,
  resolveAnchorPending,
} from './anchor-ledger';

describe('anchor ledger storage', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('starts every bucket at zero for an unseen site', async () => {
    const ledger = await getAnchorLedger('site-1', 1_000);

    expect(ledger.published).toEqual({
      brand: 0,
      naked: 0,
      exact: 0,
      partial: 0,
      generic: 0,
      natural: 0,
    });
    expect(ledger.pending).toEqual([]);
  });

  it('counts a confirmed comment straight into the published tally', async () => {
    await recordAnchorPublished('site-1', 'brand', 1_000);
    await recordAnchorPublished('site-1', 'brand', 2_000);
    await recordAnchorPublished('site-1', 'exact', 3_000);

    const ledger = await getAnchorLedger('site-1');
    expect(ledger.published.brand).toBe(2);
    expect(ledger.published.exact).toBe(1);
    expect(ledger.pending).toEqual([]);
  });

  it('holds a moderated comment out of the published tally until it is confirmed', async () => {
    await recordAnchorPending(
      'site-1',
      'naked',
      'https://blog.example/post',
      1_000
    );

    const held = await getAnchorLedger('site-1');
    expect(held.published.naked).toBe(0);
    expect(held.pending).toEqual([
      { bucket: 'naked', targetUrl: 'https://blog.example/post', at: 1_000 },
    ]);

    const settled = await resolveAnchorPending(
      'site-1',
      'https://blog.example/post',
      'published',
      2_000
    );
    expect(settled.published.naked).toBe(1);
    expect(settled.pending).toEqual([]);
  });

  it('discards a moderated comment that never appeared', async () => {
    await recordAnchorPending(
      'site-1',
      'generic',
      'https://blog.example/post',
      1_000
    );

    const settled = await resolveAnchorPending(
      'site-1',
      'https://blog.example/post',
      'dropped',
      2_000
    );

    expect(settled.published.generic).toBe(0);
    expect(settled.pending).toEqual([]);
  });

  it('matches a recheck back to its pending row across fragment and trailing-slash differences', async () => {
    await recordAnchorPending(
      'site-1',
      'partial',
      'https://blog.example/post/',
      1_000
    );

    const settled = await resolveAnchorPending(
      'site-1',
      'https://blog.example/post#comment-42',
      'published',
      2_000
    );

    expect(settled.published.partial).toBe(1);
    expect(settled.pending).toEqual([]);
  });

  it('ignores a recheck for a target it never held', async () => {
    await recordAnchorPublished('site-1', 'brand', 1_000);

    const settled = await resolveAnchorPending(
      'site-1',
      'https://blog.example/other',
      'published',
      2_000
    );

    expect(settled.published.brand).toBe(1);
    expect(settled.published.naked).toBe(0);
  });

  it('replaces an earlier pending row for the same target instead of double counting', async () => {
    await recordAnchorPending(
      'site-1',
      'brand',
      'https://blog.example/post',
      1_000
    );
    await recordAnchorPending(
      'site-1',
      'exact',
      'https://blog.example/post',
      2_000
    );

    const ledger = await getAnchorLedger('site-1');
    expect(ledger.pending).toEqual([
      { bucket: 'exact', targetUrl: 'https://blog.example/post', at: 2_000 },
    ]);
  });

  it('keeps the tally of each site separate', async () => {
    await recordAnchorPublished('site-1', 'brand', 1_000);
    await recordAnchorPublished('site-2', 'exact', 2_000);

    expect((await getAnchorLedger('site-1')).published.exact).toBe(0);
    expect((await getAnchorLedger('site-2')).published.brand).toBe(0);
  });
});
