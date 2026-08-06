import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  MAX_ANCHOR_TEXT_ROWS,
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
    expect(ledger.texts).toEqual([]);
  });

  it('counts a confirmed comment straight into the published tally', async () => {
    await recordAnchorPublished('site-1', 'brand', undefined, 1_000);
    await recordAnchorPublished('site-1', 'brand', undefined, 2_000);
    await recordAnchorPublished('site-1', 'exact', undefined, 3_000);

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
      undefined,
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
      undefined,
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
      undefined,
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
    await recordAnchorPublished('site-1', 'brand', undefined, 1_000);

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
      undefined,
      1_000
    );
    await recordAnchorPending(
      'site-1',
      'exact',
      'https://blog.example/post',
      undefined,
      2_000
    );

    const ledger = await getAnchorLedger('site-1');
    expect(ledger.pending).toEqual([
      { bucket: 'exact', targetUrl: 'https://blog.example/post', at: 2_000 },
    ]);
  });

  it('keeps the tally of each site separate', async () => {
    await recordAnchorPublished('site-1', 'brand', undefined, 1_000);
    await recordAnchorPublished('site-2', 'exact', undefined, 2_000);

    expect((await getAnchorLedger('site-1')).published.exact).toBe(0);
    expect((await getAnchorLedger('site-2')).published.brand).toBe(0);
  });

  it('tallies each exact wording alongside its bucket', async () => {
    await recordAnchorPublished('site-1', 'brand', 'Seed Audio', 1_000);
    await recordAnchorPublished('site-1', 'brand', 'seed  audio', 2_000);
    await recordAnchorPublished('site-1', 'brand', 'Seed Audio app', 3_000);
    await recordAnchorPublished('site-1', 'exact', 'AI video generator', 4_000);

    const ledger = await getAnchorLedger('site-1');
    // Case and repeated spacing are the same wording, so they share a row.
    expect(ledger.texts).toEqual([
      { bucket: 'brand', text: 'Seed Audio', count: 2, lastAt: 2_000 },
      { bucket: 'brand', text: 'Seed Audio app', count: 1, lastAt: 3_000 },
      { bucket: 'exact', text: 'AI video generator', count: 1, lastAt: 4_000 },
    ]);
    expect(ledger.published.brand).toBe(3);
  });

  it('keeps the same wording apart when two buckets use it', async () => {
    await recordAnchorPublished('site-1', 'generic', 'this page', 1_000);
    await recordAnchorPublished('site-1', 'natural', 'this page', 2_000);

    const ledger = await getAnchorLedger('site-1');
    expect(ledger.texts).toEqual([
      { bucket: 'generic', text: 'this page', count: 1, lastAt: 1_000 },
      { bucket: 'natural', text: 'this page', count: 1, lastAt: 2_000 },
    ]);
  });

  it('credits the wording only once moderation confirms it', async () => {
    await recordAnchorPending(
      'site-1',
      'naked',
      'https://blog.example/post',
      'example.com',
      1_000
    );

    const held = await getAnchorLedger('site-1');
    expect(held.texts).toEqual([]);
    expect(held.pending[0]).toEqual({
      bucket: 'naked',
      targetUrl: 'https://blog.example/post',
      at: 1_000,
      text: 'example.com',
    });

    const settled = await resolveAnchorPending(
      'site-1',
      'https://blog.example/post',
      'published',
      2_000
    );
    expect(settled.texts).toEqual([
      { bucket: 'naked', text: 'example.com', count: 1, lastAt: 2_000 },
    ]);
  });

  it('leaves no wording row behind for a moderated comment that never appeared', async () => {
    await recordAnchorPending(
      'site-1',
      'generic',
      'https://blog.example/post',
      'this resource',
      1_000
    );

    const settled = await resolveAnchorPending(
      'site-1',
      'https://blog.example/post',
      'dropped',
      2_000
    );

    expect(settled.texts).toEqual([]);
  });

  it('still counts the bucket when the wording is unknown', async () => {
    await recordAnchorPublished('site-1', 'brand', undefined, 1_000);
    await recordAnchorPublished('site-1', 'brand', '   ', 2_000);

    const ledger = await getAnchorLedger('site-1');
    expect(ledger.published.brand).toBe(2);
    expect(ledger.texts).toEqual([]);
  });

  it('drops the least-used wording once the row ceiling is reached', async () => {
    // Fill the list, then make one row clearly worth keeping.
    for (let index = 0; index < MAX_ANCHOR_TEXT_ROWS; index += 1) {
      await recordAnchorPublished('site-1', 'brand', `word-${index}`, 1_000);
    }
    await recordAnchorPublished('site-1', 'brand', 'word-0', 2_000);

    await recordAnchorPublished('site-1', 'brand', 'newcomer', 3_000);

    const ledger = await getAnchorLedger('site-1');
    expect(ledger.texts).toHaveLength(MAX_ANCHOR_TEXT_ROWS);
    const texts = ledger.texts.map((row) => row.text);
    expect(texts).toContain('newcomer');
    expect(texts).toContain('word-0');
    expect(texts).not.toContain('word-1');
    // Bucket totals never lose an entry to the ceiling.
    expect(ledger.published.brand).toBe(MAX_ANCHOR_TEXT_ROWS + 2);
  });

  it('reads a ledger stored before wording was tracked', async () => {
    await fakeBrowser.storage.local.set({
      'comment-link-assistant.anchor-ledger': {
        'site-1': {
          siteId: 'site-1',
          published: {
            brand: 4,
            naked: 0,
            exact: 0,
            partial: 0,
            generic: 0,
            natural: 0,
          },
          pending: [
            { bucket: 'brand', targetUrl: 'https://blog.example/old', at: 1 },
          ],
          updatedAt: 1,
        },
      },
    });

    const ledger = await getAnchorLedger('site-1');
    expect(ledger.published.brand).toBe(4);
    expect(ledger.texts).toEqual([]);
    expect(ledger.pending).toHaveLength(1);
  });
});
