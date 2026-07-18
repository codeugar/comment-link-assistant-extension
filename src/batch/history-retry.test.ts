import type { BatchHistoryEntry } from '@/storage/batch-history';
import { describe, expect, it, vi } from 'vitest';
import {
  type HistoryRetryDependencies,
  planHistoryRetry,
  runHistoryRetry,
} from './history-retry';
import type { BatchSnapshot } from './types';

const settings = {
  provider: 'deepseek' as const,
  websiteUrl: 'https://product.example',
  displayName: 'Alex',
  email: '',
  linkMode: 'inline' as const,
};

function entry(overrides: Partial<BatchHistoryEntry> = {}): BatchHistoryEntry {
  return {
    id: 'entry-1',
    settings,
    createdAt: 1_000,
    archivedAt: 2_000,
    counts: { submitted: 1, failed: 2, total: 3 },
    items: [
      { url: 'https://a.example/1', status: 'submitted', message: '' },
      { url: 'https://b.example/2', status: 'failed', message: 'BOOM' },
      { url: 'https://c.example/3', status: 'no_form', message: 'NF' },
    ],
    ...overrides,
  };
}

describe('planHistoryRetry', () => {
  it('throws when the id is unknown', () => {
    expect(() => planHistoryRetry([entry()], 'missing')).toThrow(
      'HISTORY_ENTRY_NOT_FOUND'
    );
  });

  it('defaults to every failed url when urls are omitted', () => {
    expect(planHistoryRetry([entry()], 'entry-1')).toEqual({
      settings,
      urls: ['https://b.example/2', 'https://c.example/3'],
    });
  });

  it('throws when the entry has no failed urls', () => {
    const clean = entry({
      items: [{ url: 'https://a.example/1', status: 'submitted', message: '' }],
      counts: { submitted: 1, failed: 0, total: 1 },
    });
    expect(() => planHistoryRetry([clean], 'entry-1')).toThrow(
      'HISTORY_NO_FAILED_ITEMS'
    );
  });

  it('accepts provided urls that belong to the entry', () => {
    expect(
      planHistoryRetry([entry()], 'entry-1', ['https://b.example/2'])
    ).toEqual({
      settings,
      urls: ['https://b.example/2'],
    });
  });

  it('rejects provided urls that are not in the entry', () => {
    expect(() =>
      planHistoryRetry([entry()], 'entry-1', ['https://x.example/9'])
    ).toThrow('HISTORY_URL_NOT_FOUND');
  });

  it('rejects an empty provided url list', () => {
    expect(() => planHistoryRetry([entry()], 'entry-1', [])).toThrow(
      'HISTORY_NO_FAILED_ITEMS'
    );
  });
});

describe('runHistoryRetry', () => {
  function makeDeps(current: BatchSnapshot | null) {
    const started = { id: 'new-batch' } as unknown as BatchSnapshot;
    const deps: HistoryRetryDependencies & { started: BatchSnapshot } = {
      started,
      getBatchHistory: vi.fn(async () => [entry()]),
      getBatch: vi.fn(async () => current),
      archiveBatch: vi.fn(async () => undefined),
      clearBatch: vi.fn(async () => undefined),
      startBatch: vi.fn(async () => started),
    };
    return deps;
  }

  it('rejects when a batch is already running', async () => {
    const deps = makeDeps({ status: 'running' } as BatchSnapshot);
    await expect(runHistoryRetry(deps, 'entry-1')).rejects.toThrow(
      'BATCH_ALREADY_ACTIVE'
    );
    expect(deps.archiveBatch).not.toHaveBeenCalled();
    expect(deps.startBatch).not.toHaveBeenCalled();
  });

  it('rejects when a batch is paused', async () => {
    const deps = makeDeps({ status: 'paused' } as BatchSnapshot);
    await expect(runHistoryRetry(deps, 'entry-1')).rejects.toThrow(
      'BATCH_ALREADY_ACTIVE'
    );
  });

  it('archives and clears a terminal current batch, then starts with entry settings', async () => {
    const current = { status: 'completed' } as BatchSnapshot;
    const deps = makeDeps(current);

    const result = await runHistoryRetry(deps, 'entry-1');

    expect(deps.archiveBatch).toHaveBeenCalledWith(current);
    expect(deps.clearBatch).toHaveBeenCalledOnce();
    expect(deps.startBatch).toHaveBeenCalledWith(
      'https://b.example/2\nhttps://c.example/3',
      settings
    );
    expect(result).toBe(deps.started);
  });

  it('starts directly when there is no current batch', async () => {
    const deps = makeDeps(null);

    await runHistoryRetry(deps, 'entry-1', ['https://b.example/2']);

    expect(deps.archiveBatch).not.toHaveBeenCalled();
    expect(deps.clearBatch).not.toHaveBeenCalled();
    expect(deps.startBatch).toHaveBeenCalledWith(
      'https://b.example/2',
      settings
    );
  });
});
