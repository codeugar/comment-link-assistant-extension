import type { PlansMap, SitePlan } from '@/storage/plans';
import type { CommentProvider, ExtensionSettings, SiteProfile } from '@/types';
import { describe, expect, it, vi } from 'vitest';
import { type PlanRunDependencies, runPlanNext } from './plan-runner';
import type { BatchSnapshot } from './types';

const site: SiteProfile = {
  id: 'seed',
  label: 'Seed',
  websiteUrl: 'https://seed.example',
  displayName: 'Seed',
  email: '',
  linkMode: 'inline',
};

const settings: ExtensionSettings = {
  provider: 'deepseek',
  sites: [site],
  activeSiteId: 'seed',
};

function planFor(overrides: Partial<SitePlan> = {}): SitePlan {
  return {
    siteId: 'seed',
    chunkSize: 2,
    chunks: [
      {
        id: 'c0',
        urls: ['https://a.example/1', 'https://a.example/2'],
        status: 'pending',
      },
      { id: 'c1', urls: ['https://b.example/1'], status: 'pending' },
    ],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeDeps(
  options: {
    plans?: PlansMap;
    current?: BatchSnapshot | null;
    getSettings?: PlanRunDependencies['getSettings'];
  } = {}
) {
  const started = { id: 'new-batch' } as unknown as BatchSnapshot;
  const plans = options.plans ?? { seed: planFor() };
  const current = options.current ?? null;
  const deps = {
    started,
    getPlans: vi.fn(async () => plans),
    getSettings: options.getSettings ?? vi.fn(async () => settings),
    getBatch: vi.fn(async () => current),
    archiveBatch: vi.fn(async () => undefined),
    clearBatch: vi.fn(async () => undefined),
    startBatch: vi.fn(async () => started),
    savePlan: vi.fn(async () => undefined),
    buildSnapshot: vi.fn(
      (provider: CommentProvider, resolved: SiteProfile) => ({
        provider,
        websiteUrl: resolved.websiteUrl,
        displayName: resolved.displayName,
        email: resolved.email,
        linkMode: resolved.linkMode,
        siteId: resolved.id,
        siteLabel: resolved.label,
      })
    ),
    now: () => 5_000,
  } satisfies PlanRunDependencies & { started: BatchSnapshot };
  return deps;
}

describe('runPlanNext', () => {
  it('starts the next pending chunk and marks it started', async () => {
    const deps = makeDeps();

    const result = await runPlanNext(deps, 'seed');

    expect(deps.startBatch).toHaveBeenCalledWith(
      'https://a.example/1\nhttps://a.example/2',
      expect.objectContaining({
        siteId: 'seed',
        websiteUrl: 'https://seed.example',
      })
    );
    expect(deps.savePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        chunks: expect.arrayContaining([
          expect.objectContaining({
            id: 'c0',
            status: 'started',
            batchId: 'new-batch',
            startedAt: 5_000,
          }),
        ]),
      })
    );
    expect(result).toBe(deps.started);
  });

  it('throws PLAN_NOT_FOUND for an unknown site', async () => {
    await expect(runPlanNext(makeDeps({ plans: {} }), 'seed')).rejects.toThrow(
      'PLAN_NOT_FOUND'
    );
  });

  it('throws PLAN_NO_PENDING_CHUNK when all chunks are done', async () => {
    const deps = makeDeps({
      plans: {
        seed: planFor({
          chunks: [{ id: 'c0', urls: ['https://a.example/1'], status: 'done' }],
        }),
      },
    });
    await expect(runPlanNext(deps, 'seed')).rejects.toThrow(
      'PLAN_NO_PENDING_CHUNK'
    );
  });

  it('throws PLAN_SITE_MISSING when the site was deleted', async () => {
    const deps = makeDeps({
      getSettings: vi.fn(async () => ({
        provider: 'deepseek' as const,
        sites: [{ ...site, id: 'other' }],
        activeSiteId: 'other',
      })),
    });
    await expect(runPlanNext(deps, 'seed')).rejects.toThrow(
      'PLAN_SITE_MISSING'
    );
  });

  it('rejects when a batch is already running', async () => {
    const deps = makeDeps({ current: { status: 'running' } as BatchSnapshot });
    await expect(runPlanNext(deps, 'seed')).rejects.toThrow(
      'BATCH_ALREADY_ACTIVE'
    );
    expect(deps.startBatch).not.toHaveBeenCalled();
    expect(deps.savePlan).not.toHaveBeenCalled();
  });

  it('archives and clears a terminal current batch before starting', async () => {
    const current = { status: 'completed', id: 'old' } as BatchSnapshot;
    const deps = makeDeps({ current });

    await runPlanNext(deps, 'seed');

    expect(deps.archiveBatch).toHaveBeenCalledWith(current);
    expect(deps.clearBatch).toHaveBeenCalledOnce();
    expect(deps.startBatch).toHaveBeenCalled();
  });
});
