import {
  completeCurrentItem,
  createBatch,
  retryItems,
  stopBatch,
  updateBatchProgress,
} from '@/batch/state';
import type { BatchSnapshot } from '@/batch/types';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_DB_VERSION,
  DASHBOARD_STORE_NAMES,
  DashboardDataError,
  createDashboardRepository,
} from './db';
import type { CreatePlanInput, PlanDetail } from './model';

const settings = {
  provider: 'deepseek' as const,
  websiteUrl: 'https://product.example',
  displayName: 'Alex',
  email: '',
  linkMode: 'inline' as const,
  siteId: 'site-1',
  siteLabel: 'Product',
};

function repository(now = 10_000) {
  const indexedDB = new IDBFactory();
  let id = 0;
  const repo = createDashboardRepository({
    databaseName: `dashboard-test-${Math.random()}`,
    indexedDB,
    now: () => now,
    idFactory: () => `id-${++id}`,
  });
  return { repo, indexedDB };
}

function planInput(overrides: Partial<CreatePlanInput> = {}): CreatePlanInput {
  return {
    name: 'July comments',
    promotingSiteId: 'site-1',
    promotingSiteLabel: 'Product',
    promotingWebsiteUrl: 'https://product.example',
    urls: [
      'https://blog.example/one',
      'https://forum.example/two',
      'https://docs.example/three',
    ],
    chunkSize: 2,
    now: 10_000,
    ...overrides,
  };
}

async function open(indexedDB: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function completedFirstBatch(
  detail: PlanDetail,
  repo: ReturnType<typeof createDashboardRepository>,
  at = 20_000
): Promise<BatchSnapshot> {
  const batch = detail.batches[0]!;
  const targets = await repo.getBatchTargets(batch.id);
  const start = await repo.startBatchRun(detail.plan.id, batch.id, {
    externalBatchId: 'runtime-1',
    at,
  });
  let snapshot = createBatch({
    id: 'runtime-1',
    targetText: targets.map((target) => target.url).join('\n'),
    settings,
    now: at,
  });
  snapshot = completeCurrentItem(
    snapshot,
    'published',
    'COMMENT_SUBMITTED',
    at + 1
  );
  snapshot = {
    ...snapshot,
    items: snapshot.items.map((item, index) =>
      index === 0 ? { ...item, comment: 'A helpful generated comment.' } : item
    ),
  };
  snapshot = completeCurrentItem(snapshot, 'failed', 'NETWORK', at + 2);
  await repo.syncBatchSnapshot(detail.plan.id, batch.id, snapshot, {
    runId: start.run.id,
  });
  return snapshot;
}

describe('DashboardRepository schema and plans', () => {
  it('creates the six v1 object stores', async () => {
    const { repo, indexedDB } = repository();
    await repo.setMeta('probe', true);

    const database = await open(indexedDB, repo.databaseName);
    expect(database.version).toBe(DASHBOARD_DB_VERSION);
    expect([...database.objectStoreNames].sort()).toEqual(
      Object.values(DASHBOARD_STORE_NAMES).sort()
    );
    database.close();
    await repo.close();
  });

  it('normalizes, deduplicates, chunks, and pages up to 2,000 targets', async () => {
    const { repo } = repository();
    const urls = Array.from(
      { length: 2_000 },
      (_, index) => `https://blog${index}.example/post#comments`
    );
    urls.push('https://blog0.example/post');
    const detail = await repo.createPlan(planInput({ urls, chunkSize: 200 }));

    expect(detail.plan.targetCount).toBe(2_000);
    expect(detail.batches).toHaveLength(10);
    expect(detail.batches.at(-1)?.targetCount).toBe(200);
    const page = await repo.getTargets(detail.plan.id, { page: 20 });
    expect(page.items).toHaveLength(100);
    expect(page.total).toBe(2_000);
    expect(page.totalPages).toBe(20);
    expect(page.items[0]?.sequence).toBe(1_901);
    expect(page.items[0]?.url).not.toContain('#');

    await expect(
      repo.createPlan(
        planInput({
          promotingSiteId: 'too-many',
          urls: Array.from(
            { length: 2_001 },
            (_, index) => `https://overflow${index}.example/post`
          ),
        })
      )
    ).rejects.toMatchObject({
      code: 'PLAN_TARGET_LIMIT_EXCEEDED',
    });
  }, 15_000);

  it('caps chunks and target pages and reports invalid URL positions', async () => {
    const { repo } = repository();
    await expect(
      repo.createPlan(planInput({ chunkSize: 201 }))
    ).rejects.toMatchObject({ code: 'PLAN_CHUNK_SIZE_INVALID' });
    await expect(
      repo.createPlan(
        planInput({
          urls: ['https://ok.example', 'file:///not-allowed'],
        })
      )
    ).rejects.toMatchObject({
      code: 'PLAN_TARGET_URL_INVALID',
      message: 'PLAN_TARGET_URL_INVALID:2',
    });

    const detail = await repo.createPlan(planInput());
    await expect(
      repo.getTargets(detail.plan.id, { pageSize: 101 })
    ).rejects.toMatchObject({ code: 'TARGET_PAGE_INVALID' });
  });

  it('allows multiple plans for the same promoting website', async () => {
    const { repo } = repository();
    const first = await repo.createPlan(planInput());
    const second = await repo.createPlan(
      planInput({
        name: 'Second',
        promotingSiteId: 'site-2',
        promotingSiteLabel: 'Same website, another profile',
        promotingWebsiteUrl: 'HTTPS://PRODUCT.EXAMPLE/#dashboard',
        now: 11_000,
      })
    );
    expect(second.plan.status).toBe('active');
    expect(await repo.listPlans()).toHaveLength(2);
    expect((await repo.listPlans()).map((plan) => plan.id)).toEqual([
      second.plan.id,
      first.plan.id,
    ]);
  });

  it('renames an active plan without changing batches or targets', async () => {
    const { repo } = repository();
    const detail = await repo.createPlan(planInput());
    const targetsBefore = await repo.getTargets(detail.plan.id);
    const renamed = await repo.renamePlan(
      detail.plan.id,
      '  August comments  ',
      12_000
    );

    expect(renamed).toMatchObject({
      id: detail.plan.id,
      name: 'August comments',
      targetCount: detail.plan.targetCount,
      updatedAt: 12_000,
    });
    expect((await repo.getPlanDetail(detail.plan.id))?.batches).toEqual(
      detail.batches
    );
    expect(await repo.getTargets(detail.plan.id)).toMatchObject({
      total: targetsBefore.total,
      items: targetsBefore.items,
    });

    await expect(repo.renamePlan(detail.plan.id, '  ')).rejects.toMatchObject({
      code: 'PLAN_NAME_INVALID',
    });
    await repo.archivePlan(detail.plan.id);
    await expect(
      repo.renamePlan(detail.plan.id, 'Archived name')
    ).rejects.toMatchObject({ code: 'PLAN_ARCHIVED' });
  });

  it('removes one target, its attempts, and recalculates its batch and plan', async () => {
    const { repo } = repository();
    const detail = await repo.createPlan(planInput());
    await completedFirstBatch(detail, repo);
    const firstBatch = detail.batches[0]!;
    const failed = (
      await repo.getTargets(detail.plan.id, {
        batchId: firstBatch.id,
      })
    ).items.find((target) => target.status === 'failed')!;
    expect(await repo.getAttempts(failed.id)).toHaveLength(1);

    await expect(
      repo.deleteTarget(detail.plan.id, failed.id, 22_000)
    ).resolves.toMatchObject({ id: failed.id, url: failed.url });

    expect(await repo.getAttempts(failed.id)).toEqual([]);
    expect(await repo.getTarget(detail.plan.id, failed.id)).toBeNull();
    expect(await repo.getTargets(detail.plan.id)).toMatchObject({
      total: 2,
      items: expect.not.arrayContaining([
        expect.objectContaining({ id: failed.id }),
      ]),
    });
    const updated = await repo.getPlanDetail(detail.plan.id);
    expect(updated?.plan).toMatchObject({
      status: 'active',
      targetCount: 2,
      processedCount: 1,
      submittedCount: 1,
      failedCount: 0,
    });
    expect(
      updated?.batches.find((batch) => batch.id === firstBatch.id)
    ).toMatchObject({
      status: 'completed',
      targetCount: 1,
      processedCount: 1,
      failedCount: 0,
    });
  });

  it('rejects deleting targets from a live or resumable batch', async () => {
    const { repo } = repository();
    const detail = await repo.createPlan(planInput());
    const batch = detail.batches[0]!;
    const target = (await repo.getBatchTargets(batch.id))[0]!;

    await repo.startBatchRun(detail.plan.id, batch.id, {
      externalBatchId: 'target-delete-live-run',
    });
    await expect(
      repo.deleteTarget(detail.plan.id, target.id)
    ).rejects.toMatchObject({ code: 'BATCH_ALREADY_ACTIVE' });
    expect(await repo.getTarget(detail.plan.id, target.id)).toMatchObject({
      id: target.id,
    });

    await repo.markBatchInterrupted(detail.plan.id, batch.id);
    await expect(
      repo.deleteTarget(detail.plan.id, target.id)
    ).rejects.toMatchObject({ code: 'BATCH_ALREADY_ACTIVE' });
  });
  it('requires archiving before permanent deletion and cascades records', async () => {
    const { repo } = repository();
    const detail = await repo.createPlan(planInput());
    await expect(
      repo.deletePlanPermanently(detail.plan.id)
    ).rejects.toMatchObject({ code: 'PLAN_DELETE_REQUIRES_ARCHIVE' });

    await repo.archivePlan(detail.plan.id);
    await repo.deletePlanPermanently(detail.plan.id);
    expect(await repo.getPlanDetail(detail.plan.id)).toBeNull();
    expect(await repo.getTargets(detail.plan.id)).toMatchObject({
      total: 0,
      items: [],
    });
  });
});

describe('DashboardRepository execution semantics', () => {
  it('syncs latest results, errors, attempts, schedules, and summary groups', async () => {
    const { repo } = repository();
    const detail = await repo.createPlan(planInput());
    await completedFirstBatch(detail, repo);

    const updated = await repo.getPlanDetail(detail.plan.id);
    expect(updated?.plan).toMatchObject({
      status: 'active',
      processedCount: 2,
      submittedCount: 1,
      failedCount: 1,
    });
    expect(updated?.batches[0]).toMatchObject({
      status: 'completed_with_errors',
      processedCount: 2,
      failedCount: 1,
    });
    const firstPage = await repo.getTargets(detail.plan.id, {
      batchId: detail.batches[0]?.id,
    });
    expect(firstPage.items.map((target) => target.status)).toEqual([
      'published',
      'failed',
    ]);
    expect(firstPage.items[1]?.lastError).toMatchObject({
      code: 'NETWORK',
      message: 'NETWORK',
    });
    expect(await repo.getAttempts(firstPage.items[1]!.id)).toMatchObject([
      { attemptNumber: 1, status: 'failed' },
    ]);
    expect(await repo.getAttempts(firstPage.items[0]!.id)).toMatchObject([
      {
        attemptNumber: 1,
        status: 'published',
        comment: 'A helpful generated comment.',
      },
    ]);

    const summary = await repo.getDashboardSummary({ now: 20_003 });
    expect(summary).toMatchObject({
      activePlanCount: 1,
      counts: {
        total: 3,
        processed: 2,
        submitted: 1,
        failed: 1,
      },
      recentFailures: [
        {
          targetId: firstPage.items[1]?.id,
          status: 'failed',
        },
      ],
    });
    expect(summary.promotingSites[0]).toMatchObject({
      siteId: 'site-1',
      total: 3,
      processed: 2,
    });
    expect(
      summary.targetHosts.find((group) => group.host === 'forum.example')
    ).toMatchObject({ failed: 1 });
    expect(summary.todaySchedule[0]?.batchSequence).toBe(1);
    expect(summary.nextSchedule[0]?.batchSequence).toBe(2);
  });

  it('counts filtered targets in promoting-site and target-host summary groups', async () => {
    const { repo } = repository();
    const detail = await repo.createPlan(
      planInput({
        urls: ['https://filtered.example/one', 'https://submitted.example/two'],
        chunkSize: 2,
      })
    );
    const batch = detail.batches[0]!;
    const started = await repo.startBatchRun(detail.plan.id, batch.id, {
      externalBatchId: 'filtered-summary-1',
      at: 20_000,
    });
    let snapshot = createBatch({
      id: 'filtered-summary-1',
      targetText: 'https://filtered.example/one\nhttps://submitted.example/two',
      settings,
      now: 20_000,
    });
    snapshot = completeCurrentItem(
      snapshot,
      'filtered',
      'FILTER_LIST_MATCHED',
      20_001
    );
    snapshot = completeCurrentItem(
      snapshot,
      'published',
      'COMMENT_SUBMITTED',
      20_002
    );
    await repo.syncBatchSnapshot(detail.plan.id, batch.id, snapshot, {
      runId: started.run.id,
    });

    const summary = await repo.getDashboardSummary({ now: 20_003 });
    expect(summary.counts).toMatchObject({
      total: 2,
      processed: 2,
      submitted: 1,
      filtered: 1,
    });
    expect(summary.promotingSites[0]).toMatchObject({
      siteId: 'site-1',
      total: 2,
      processed: 2,
      submitted: 1,
      filtered: 1,
    });
    expect(
      summary.targetHosts.find((group) => group.host === 'filtered.example')
    ).toMatchObject({
      total: 1,
      processed: 1,
      filtered: 1,
    });
  });

  it('keeps a submitted target completed when an equally-timed running snapshot arrives late', async () => {
    const { repo } = repository();
    const detail = await repo.createPlan(
      planInput({
        urls: ['https://blog.example/one'],
        chunkSize: 1,
      })
    );
    const batch = detail.batches[0]!;
    const started = await repo.startBatchRun(detail.plan.id, batch.id, {
      externalBatchId: 'monotonic-1',
      at: 20_000,
    });
    let stale = createBatch({
      id: 'monotonic-1',
      targetText: 'https://blog.example/one',
      settings,
      now: 20_000,
    });
    stale = updateBatchProgress(stale, { item: { status: 'opening' } }, 20_001);
    const submitted = completeCurrentItem(
      stale,
      'published',
      'COMMENT_SUBMITTED',
      20_001
    );

    await repo.syncBatchSnapshot(detail.plan.id, batch.id, submitted, {
      runId: started.run.id,
    });
    await repo.syncBatchSnapshot(detail.plan.id, batch.id, stale, {
      runId: started.run.id,
    });

    expect((await repo.getTargets(detail.plan.id)).items[0]).toMatchObject({
      status: 'published',
      latestMessage: 'COMMENT_SUBMITTED',
    });
    expect(
      (await repo.getPlanDetail(detail.plan.id))?.batches[0]
    ).toMatchObject({
      status: 'completed',
      processedCount: 1,
      submittedCount: 1,
    });
    expect(await repo.getRun(started.run.id)).toMatchObject({
      status: 'completed',
    });
  });

  it('matches a redirected snapshot item to its original plan target', async () => {
    const { repo } = repository();
    const detail = await repo.createPlan(
      planInput({
        urls: ['https://blog.example/one'],
        chunkSize: 1,
      })
    );
    const batch = detail.batches[0]!;
    const started = await repo.startBatchRun(detail.plan.id, batch.id, {
      externalBatchId: 'redirected-1',
      at: 20_000,
    });
    let snapshot = createBatch({
      id: 'redirected-1',
      targetText: 'https://blog.example/one',
      settings,
      now: 20_000,
    });
    snapshot = updateBatchProgress(
      snapshot,
      {
        item: {
          url: 'https://blog.example/one/canonical',
          status: 'opening',
        },
      },
      20_001
    );
    snapshot = completeCurrentItem(
      snapshot,
      'published',
      'COMMENT_SUBMITTED',
      20_002
    );

    await repo.syncBatchSnapshot(detail.plan.id, batch.id, snapshot, {
      runId: started.run.id,
    });

    const target = (await repo.getTargets(detail.plan.id)).items[0]!;
    expect(target).toMatchObject({
      url: 'https://blog.example/one',
      status: 'published',
    });
    expect(await repo.getAttempts(target.id)).toMatchObject([
      {
        url: 'https://blog.example/one',
        status: 'published',
      },
    ]);
  });

  it('enforces one new batch per local day and keeps the next batch ordered', async () => {
    const morning = new Date(2026, 6, 29, 9).getTime();
    const evening = new Date(2026, 6, 29, 18).getTime();
    const tomorrow = new Date(2026, 6, 30, 9).getTime();
    const { repo } = repository(morning);
    const detail = await repo.createPlan(
      planInput({ now: morning, chunkSize: 1 })
    );
    const first = detail.batches[0]!;
    const start = await repo.startBatchRun(detail.plan.id, first.id, {
      externalBatchId: 'daily-1',
      at: morning,
    });
    let snapshot = createBatch({
      id: 'daily-1',
      targetText: (await repo.getBatchTargets(first.id))[0]!.url,
      settings,
      now: morning,
    });
    snapshot = completeCurrentItem(snapshot, 'published', 'OK', morning + 1);
    await repo.syncBatchSnapshot(detail.plan.id, first.id, snapshot, {
      runId: start.run.id,
    });

    expect(await repo.getNextRunnableBatch(detail.plan.id, evening)).toBeNull();
    expect(
      (await repo.getNextRunnableBatch(detail.plan.id, tomorrow))?.sequence
    ).toBe(2);
    await expect(
      repo.startBatchRun(detail.plan.id, detail.batches[1]!.id, { at: evening })
    ).rejects.toMatchObject({ code: 'BATCH_ALREADY_STARTED_TODAY' });
  });

  it('does not count stopped targets and resumes only unresolved links', async () => {
    const { repo } = repository();
    const detail = await repo.createPlan(
      planInput({ urls: planInput().urls.slice(0, 2), chunkSize: 2 })
    );
    const batch = detail.batches[0]!;
    const start = await repo.startBatchRun(detail.plan.id, batch.id, {
      externalBatchId: 'stopped-1',
      at: 20_000,
    });
    let snapshot = createBatch({
      id: 'stopped-1',
      targetText: (await repo.getBatchTargets(batch.id))
        .map((target) => target.url)
        .join('\n'),
      settings,
      now: 20_000,
    });
    snapshot = completeCurrentItem(snapshot, 'published', 'OK', 20_001);
    snapshot = stopBatch(snapshot, 20_002);
    await repo.syncBatchSnapshot(detail.plan.id, batch.id, snapshot, {
      runId: start.run.id,
    });

    const interrupted = await repo.getPlanDetail(detail.plan.id);
    expect(interrupted?.plan).toMatchObject({
      processedCount: 1,
      submittedCount: 1,
      failedCount: 0,
    });
    expect(interrupted?.batches[0]?.status).toBe('interrupted');
    const resumed = await repo.resumeBatchRun(detail.plan.id, batch.id, {
      externalBatchId: 'resumed-1',
      at: 21_000,
    });
    expect(resumed.targets).toHaveLength(1);
    expect(resumed.targets[0]?.url).toContain('forum.example');
  });

  it('retries failures without adding targets or double-counting results', async () => {
    const { repo } = repository();
    const detail = await repo.createPlan(
      planInput({ urls: planInput().urls.slice(0, 2) })
    );
    const terminal = await completedFirstBatch(detail, repo);
    const targets = (
      await repo.getTargets(detail.plan.id, {
        batchId: detail.batches[0]!.id,
      })
    ).items;
    const failed = targets.find((target) => target.status === 'failed')!;
    const retry = await repo.prepareRetry(
      detail.plan.id,
      [failed.id, failed.id],
      { externalBatchId: terminal.id, at: 30_000 }
    );
    let retriedSnapshot = retryItems(terminal, [terminal.items[1]!.id], 30_000);
    await repo.syncBatchSnapshot(
      detail.plan.id,
      detail.batches[0]!.id,
      retriedSnapshot,
      { runId: retry.run.id }
    );
    retriedSnapshot = completeCurrentItem(
      retriedSnapshot,
      'published',
      'OK_AFTER_RETRY',
      30_001
    );
    await repo.syncBatchSnapshot(
      detail.plan.id,
      detail.batches[0]!.id,
      retriedSnapshot,
      { runId: retry.run.id }
    );

    const updated = await repo.getPlanDetail(detail.plan.id);
    expect(updated?.plan).toMatchObject({
      targetCount: 2,
      processedCount: 2,
      submittedCount: 2,
      failedCount: 0,
    });
    const retriedTarget = (await repo.getTargets(detail.plan.id)).items.find(
      (target) => target.id === failed.id
    )!;
    expect(retriedTarget.attemptCount).toBe(2);
    expect(await repo.getAttempts(failed.id)).toHaveLength(2);
  });

  it('keeps completed plans while allowing another plan for the same website', async () => {
    const { repo } = repository();
    const detail = await repo.createPlan(
      planInput({ urls: ['https://one.example/post'], chunkSize: 1 })
    );
    const batch = detail.batches[0]!;
    const start = await repo.startBatchRun(detail.plan.id, batch.id, {
      externalBatchId: 'complete-1',
      at: 20_000,
    });
    let snapshot = createBatch({
      id: 'complete-1',
      targetText: 'https://one.example/post',
      settings,
      now: 20_000,
    });
    snapshot = completeCurrentItem(snapshot, 'published', 'OK', 20_001);
    await repo.syncBatchSnapshot(detail.plan.id, batch.id, snapshot, {
      runId: start.run.id,
    });

    expect((await repo.getPlanDetail(detail.plan.id))?.plan.status).toBe(
      'completed'
    );
    const next = await repo.createPlan(
      planInput({ name: 'Next plan', now: 30_000 })
    );
    expect(next.plan.status).toBe('active');
    expect(await repo.listPlans()).toHaveLength(2);
  });
});
