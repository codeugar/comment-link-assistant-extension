import type { PlanChunk, SitePlan } from '@/storage/plans';
import { describe, expect, it } from 'vitest';
import {
  isDueToday,
  markChunkDone,
  markChunkStarted,
  nextPendingChunk,
  planProgress,
  splitIntoChunks,
} from './plan';

function chunk(
  id: string,
  urls: string[],
  overrides: Partial<PlanChunk> = {}
): PlanChunk {
  return { id, urls, status: 'pending', ...overrides };
}

function plan(
  chunks: PlanChunk[],
  overrides: Partial<SitePlan> = {}
): SitePlan {
  return {
    siteId: 'site-1',
    chunkSize: 2,
    chunks,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('splitIntoChunks', () => {
  it('splits into exact multiples', () => {
    expect(splitIntoChunks(['a', 'b', 'c', 'd'], 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('keeps a trailing remainder chunk', () => {
    expect(splitIntoChunks(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });

  it('returns a single chunk when the size exceeds the count', () => {
    expect(splitIntoChunks(['a', 'b'], 30)).toEqual([['a', 'b']]);
  });

  it('returns nothing for an empty list', () => {
    expect(splitIntoChunks([], 2)).toEqual([]);
  });
});

describe('nextPendingChunk', () => {
  it('returns the first pending chunk after done ones', () => {
    const target = plan([
      chunk('c0', ['a'], { status: 'done' }),
      chunk('c1', ['b']),
      chunk('c2', ['c']),
    ]);
    expect(nextPendingChunk(target)?.id).toBe('c1');
  });

  it('returns null when nothing is pending', () => {
    expect(
      nextPendingChunk(plan([chunk('c0', ['a'], { status: 'done' })]))
    ).toBeNull();
  });
});

describe('isDueToday', () => {
  const now = new Date(2026, 6, 20, 10, 0, 0).getTime();

  it('is due when a pending chunk exists and none started today', () => {
    expect(isDueToday(plan([chunk('c0', ['a'])]), now)).toBe(true);
  });

  it('is not due when a chunk already started earlier today', () => {
    const earlierToday = new Date(2026, 6, 20, 8, 0, 0).getTime();
    const target = plan([
      chunk('c0', ['a'], { status: 'done', startedAt: earlierToday }),
      chunk('c1', ['b']),
    ]);
    expect(isDueToday(target, now)).toBe(false);
  });

  it('is due again the next local day', () => {
    const yesterday = new Date(2026, 6, 19, 20, 0, 0).getTime();
    const target = plan([
      chunk('c0', ['a'], { status: 'done', startedAt: yesterday }),
      chunk('c1', ['b']),
    ]);
    expect(isDueToday(target, now)).toBe(true);
  });

  it('is not due when no pending chunk remains', () => {
    const yesterday = new Date(2026, 6, 19, 20, 0, 0).getTime();
    const target = plan([
      chunk('c0', ['a'], { status: 'done', startedAt: yesterday }),
    ]);
    expect(isDueToday(target, now)).toBe(false);
  });
});

describe('markChunkStarted / markChunkDone', () => {
  it('marks a pending chunk started with its batch id without mutating input', () => {
    const target = plan([chunk('c0', ['a']), chunk('c1', ['b'])]);
    const next = markChunkStarted(target, 'c0', 'batch-9', 5_000);

    expect(next.chunks[0]).toMatchObject({
      status: 'started',
      batchId: 'batch-9',
      startedAt: 5_000,
    });
    expect(next.updatedAt).toBe(5_000);
    expect(target.chunks[0]?.status).toBe('pending');
  });

  it('marks the started chunk done by batch id', () => {
    let target = plan([chunk('c0', ['a']), chunk('c1', ['b'])]);
    target = markChunkStarted(target, 'c0', 'batch-9', 5_000);
    const done = markChunkDone(target, 'batch-9', 6_000);

    expect(done.chunks[0]).toMatchObject({
      status: 'done',
      completedAt: 6_000,
    });
    expect(done.updatedAt).toBe(6_000);
  });

  it('is a no-op when no started chunk matches the batch id', () => {
    const target = plan([chunk('c0', ['a'])]);
    expect(markChunkDone(target, 'unknown', 6_000)).toBe(target);
  });
});

describe('planProgress', () => {
  it('counts done chunks against the total', () => {
    const target = plan([
      chunk('c0', ['a'], { status: 'done' }),
      chunk('c1', ['b'], { status: 'started' }),
      chunk('c2', ['c']),
    ]);
    expect(planProgress(target)).toEqual({ done: 1, total: 3 });
  });
});
