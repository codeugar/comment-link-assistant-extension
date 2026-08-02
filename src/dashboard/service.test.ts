import {
  completeCurrentItem,
  createBatch,
  retryItems,
  stopBatch,
  updateBatchProgress,
} from '@/batch/state';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { DashboardDataError, createDashboardRepository } from './db';
import {
  DASHBOARD_REVISION_STORAGE_KEY,
  DashboardService,
  parseDashboardTargetText,
  shouldSettlePlanBatch,
} from './service';

const batchSettings = {
  provider: 'deepseek' as const,
  websiteUrl: 'https://product.example/',
  displayName: 'Alex',
  email: '',
  linkMode: 'inline' as const,
  siteId: 'site-1',
  siteLabel: 'Product',
};

function testService(now = 10_000) {
  let identifier = 0;
  const repository = createDashboardRepository({
    databaseName: `dashboard-service-${Math.random()}`,
    indexedDB: new IDBFactory(),
    now: () => now,
    idFactory: () => `id-${++identifier}`,
  });
  const service = new DashboardService({
    repository,
    storage: chrome.storage.local,
    now: () => now,
  });
  return { service, repository };
}

async function createTwoTargetPlan(service: DashboardService) {
  return service.createPlan({
    name: 'July plan',
    promotingSiteId: 'site-1',
    promotingSiteLabel: 'Product',
    promotingWebsiteUrl: 'https://product.example',
    targetText: 'https://blog.example/one\nhttps://forum.example/two',
    chunkSize: 2,
  });
}

describe('dashboard service', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('parses pasted text and CSV, normalizes, and deduplicates URLs', () => {
    expect(
      parseDashboardTargetText(
        [
          '\u7f51\u5740,\u6807\u9898',
          'url,label',
          '"https://blog.example/one#comments","Blog"',
          '2,https://forum.example/two',
          'https://docs.example/three?tags=a,b',
          'https://blog.example/one',
        ].join('\n')
      )
    ).toEqual([
      'https://blog.example/one',
      'https://forum.example/two',
      'https://docs.example/three?tags=a,b',
    ]);
  });

  it('keeps the redirected active link attached to its plan target', async () => {
    const { service } = testService();
    const detail = await createTwoTargetPlan(service);
    const batch = detail.batches[0]!;
    let snapshot = createBatch({
      id: 'summary-redirect-1',
      targetText: 'https://blog.example/one\nhttps://forum.example/two',
      settings: batchSettings,
      now: 10_000,
    });

    await service.startBatchRun(detail.plan.id, batch.id, snapshot);
    snapshot = updateBatchProgress(
      snapshot,
      {
        item: {
          url: 'https://blog.example/one/canonical',
          status: 'opening',
        },
      },
      10_001
    );
    await service.syncActiveBatch(snapshot);

    expect(
      (await service.getSummary(snapshot)).activeRun?.currentTarget
    ).toMatchObject({
      url: 'https://blog.example/one',
      status: 'running',
    });
  });

  it('renames a plan and bumps the dashboard revision', async () => {
    const { service } = testService();
    const detail = await createTwoTargetPlan(service);
    const before = await chrome.storage.local.get(
      DASHBOARD_REVISION_STORAGE_KEY
    );

    const renamed = await service.renamePlan(detail.plan.id, '  August plan  ');

    expect(renamed).toMatchObject({
      id: detail.plan.id,
      name: 'August plan',
    });
    expect((await service.getPlanDetail(detail.plan.id)).plan.name).toBe(
      'August plan'
    );
    const after = await chrome.storage.local.get(
      DASHBOARD_REVISION_STORAGE_KEY
    );
    expect(after[DASHBOARD_REVISION_STORAGE_KEY]).toEqual(expect.any(Number));
    expect(after[DASHBOARD_REVISION_STORAGE_KEY]).not.toBe(
      before[DASHBOARD_REVISION_STORAGE_KEY]
    );
  });

  it('blocks deletion during the active-run registration window', async () => {
    const { service } = testService();
    const detail = await createTwoTargetPlan(service);
    const batch = detail.batches[0]!;
    const target = (await service.getBatchTargets(batch.id))[0]!;

    await service.restoreActiveRunReference({
      kind: 'plan',
      planId: detail.plan.id,
      batchId: batch.id,
      runId: 'activating-run',
      externalBatchId: 'activating-snapshot',
    });

    await expect(
      service.deleteTarget(detail.plan.id, target.id)
    ).rejects.toMatchObject({ code: 'BATCH_ALREADY_ACTIVE' });
    expect(await service.getTarget(detail.plan.id, target.id)).toMatchObject({
      id: target.id,
    });
  });
  it('accepts 2,000 targets and rejects the 2,001st', () => {
    const urls = Array.from(
      { length: 2_000 },
      (_, index) => `https://blog${index}.example/post`
    );
    expect(parseDashboardTargetText(urls.join('\n'))).toHaveLength(2_000);
    expect(() =>
      parseDashboardTargetText(
        [...urls, 'https://overflow.example/post'].join('\n')
      )
    ).toThrowError(
      expect.objectContaining<Partial<DashboardDataError>>({
        code: 'PLAN_TARGET_LIMIT_EXCEEDED',
      })
    );
  });

  it('keeps a stopped batch interrupted, then settles after a resumed run', async () => {
    const { service, repository } = testService();
    const detail = await createTwoTargetPlan(service);
    const planBatch = detail.batches[0]!;
    let snapshot = createBatch({
      id: 'external-batch-1',
      targetText: 'https://blog.example/one\nhttps://forum.example/two',
      settings: batchSettings,
      now: 10_000,
    });

    await service.startBatchRun(detail.plan.id, planBatch.id, snapshot);
    snapshot = stopBatch(snapshot, 11_000);
    await service.syncActiveBatch(snapshot);

    const interrupted = await repository.getPlanDetail(detail.plan.id);
    expect(interrupted?.batches[0]).toMatchObject({
      status: 'interrupted',
      processedCount: 0,
    });
    expect(interrupted?.plan.processedCount).toBe(0);
    expect(await service.getActiveRunReference()).not.toBeNull();
    expect(shouldSettlePlanBatch(snapshot)).toBe(false);

    snapshot = retryItems(
      snapshot,
      snapshot.items.map((item) => item.id),
      12_000
    );
    await service.resumeBatchRun(detail.plan.id, planBatch.id, snapshot);
    snapshot = completeCurrentItem(
      snapshot,
      'published',
      'COMMENT_SUBMITTED',
      13_000
    );
    snapshot = completeCurrentItem(
      snapshot,
      'failed',
      'COMMENT_SUBMISSION_UNCONFIRMED',
      14_000
    );
    await service.syncActiveBatch(snapshot);

    const settled = await repository.getPlanDetail(detail.plan.id);
    expect(settled?.plan).toMatchObject({
      status: 'completed',
      processedCount: 2,
      submittedCount: 1,
      failedCount: 1,
    });
    expect(settled?.batches[0]).toMatchObject({
      status: 'completed_with_errors',
      processedCount: 2,
    });
    expect(shouldSettlePlanBatch(snapshot)).toBe(true);
    expect(await service.getActiveRunReference()).toBeNull();

    const targets = await service.getTargets(detail.plan.id, {
      page: 1,
      pageSize: 100,
    });
    expect(targets.items).toHaveLength(2);
    expect(targets.items.every((target) => target.attempts.length === 2)).toBe(
      true
    );
    const stored = await chrome.storage.local.get(
      DASHBOARD_REVISION_STORAGE_KEY
    );
    expect(stored[DASHBOARD_REVISION_STORAGE_KEY]).toEqual(expect.any(Number));

    await service.close();
  });

  it('persists a quick batch as a standalone run with its final diagnostic', async () => {
    const { service, repository } = testService();
    let snapshot = createBatch({
      id: 'quick-batch-1',
      targetText: 'https://quick.example/post',
      settings: batchSettings,
      now: 10_000,
    });

    const run = await service.startStandaloneBatchRun(snapshot);
    expect(await service.getActiveRunReference()).toEqual({
      kind: 'standalone',
      runId: run.id,
      externalBatchId: snapshot.id,
    });

    snapshot = completeCurrentItem(
      snapshot,
      'failed',
      'Email field must be valid',
      10_100
    );
    await service.syncActiveBatch(snapshot);

    expect(await service.getActiveRunReference()).toBeNull();
    expect(await repository.getRun(run.id)).toMatchObject({
      status: 'completed_with_errors',
      externalBatchId: snapshot.id,
    });
    expect(await repository.getRunAttempts(run.id)).toMatchObject([
      {
        url: 'https://quick.example/post',
        status: 'failed',
        error: {
          code: 'FAILED',
          message: 'Email field must be valid',
        },
      },
    ]);
  });
  it('re-registers a stopped standalone batch when its persisted run reference is stale', async () => {
    const { service: originalService } = testService();
    let snapshot = createBatch({
      id: 'quick-batch-stale-reference',
      targetText: 'https://quick.example/post',
      settings: batchSettings,
      now: 10_000,
    });

    await originalService.startStandaloneBatchRun(snapshot);
    snapshot = stopBatch(snapshot, 10_100);

    // This represents IndexedDB being cleared or upgraded while storage.local
    // still contains the quick batch reference created above.
    const { service, repository } = testService();
    await expect(service.syncActiveBatch(snapshot)).resolves.toBe(true);

    const active = await service.getActiveRunReference();
    expect(active).toMatchObject({
      kind: 'standalone',
      externalBatchId: snapshot.id,
    });
    if (!active || active.kind !== 'standalone') {
      throw new Error('Expected the standalone run to be restored');
    }
    expect(await repository.getRun(active.runId)).toMatchObject({
      status: 'interrupted',
      externalBatchId: snapshot.id,
    });

    await originalService.close();
    await service.close();
  });

  it('clears a freshly written standalone reference when its run vanishes before sync', async () => {
    const { service, repository } = testService();
    const snapshot = createBatch({
      id: 'quick-batch-vanished-during-start',
      targetText: 'https://quick.example/post',
      settings: batchSettings,
      now: 10_000,
    });
    vi.spyOn(repository, 'syncStandaloneBatchSnapshot').mockRejectedValueOnce(
      new DashboardDataError('RUN_NOT_FOUND')
    );

    await expect(
      service.startStandaloneBatchRun(snapshot)
    ).rejects.toMatchObject({
      code: 'RUN_NOT_FOUND',
    });
    expect(await service.getActiveRunReference()).toBeNull();

    await service.close();
  });
});
