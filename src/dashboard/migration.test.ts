import {
  completeCurrentItem,
  createBatch,
  pauseCurrentItem,
} from '@/batch/state';
import type { BatchSnapshot } from '@/batch/types';
import type { BatchHistoryEntry } from '@/storage/batch-history';
import type { PlansMap } from '@/storage/plans';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createDashboardRepository } from './db';
import {
  LEGACY_DASHBOARD_MIGRATION_MARKER,
  buildLegacyMigrationBundle,
  migrateLegacyDashboardData,
} from './migration';

const baseSettings = {
  provider: 'deepseek' as const,
  websiteUrl: 'https://product.example',
  displayName: 'Alex',
  email: '',
  linkMode: 'inline' as const,
};

function legacyPlans(): PlansMap {
  return {
    primary: {
      siteId: 'primary',
      chunkSize: 2,
      chunks: [
        {
          id: 'primary:0',
          urls: ['https://pending.example/post'],
          status: 'pending',
        },
        {
          id: 'primary:1',
          urls: [
            'https://success.example/post',
            'https://unknown.example/post',
          ],
          status: 'done',
          batchId: 'history-linked',
          startedAt: 2_000,
          completedAt: 3_000,
        },
        {
          id: 'primary:2',
          urls: ['https://interrupted.example/post'],
          status: 'started',
          batchId: 'missing-runtime-batch',
          startedAt: 4_000,
        },
      ],
      createdAt: 1_000,
      updatedAt: 5_000,
    },
    secondary: {
      siteId: 'secondary',
      chunkSize: 30,
      chunks: [
        {
          id: 'secondary:0',
          urls: ['https://manual.example/post'],
          status: 'started',
          batchId: 'current-linked',
          startedAt: 6_000,
        },
      ],
      createdAt: 5_500,
      updatedAt: 6_100,
    },
  };
}

function history(): BatchHistoryEntry[] {
  return [
    {
      id: 'history-linked',
      settings: {
        ...baseSettings,
        siteId: 'primary',
        siteLabel: 'Primary product',
      },
      createdAt: 2_000,
      archivedAt: 3_000,
      counts: { submitted: 1, failed: 0, total: 2 },
      items: [
        {
          url: 'https://success.example/post',
          status: 'submitted',
          message: 'OK',
        },
      ],
    },
    {
      id: 'history-orphan',
      settings: baseSettings,
      createdAt: 500,
      archivedAt: 700,
      counts: { submitted: 0, failed: 1, total: 1 },
      items: [
        {
          url: 'https://orphan.example/post',
          status: 'failed',
          message: 'LEGACY_FAILURE',
        },
      ],
    },
  ];
}

function currentBatch(): BatchSnapshot {
  let batch = createBatch({
    id: 'current-linked',
    targetText: 'https://manual.example/post',
    settings: {
      ...baseSettings,
      websiteUrl: 'https://secondary.example',
      siteId: 'secondary',
      siteLabel: 'Secondary product',
    },
    now: 6_000,
  });
  batch = pauseCurrentItem(
    batch,
    'captcha_required',
    'CAPTCHA_REQUIRED',
    6_100
  );
  return batch;
}

describe('legacy dashboard migration', () => {
  it('builds deterministic plans, batches, targets, runs, and attempts', () => {
    const first = buildLegacyMigrationBundle(
      legacyPlans(),
      history(),
      currentBatch()
    );
    const second = buildLegacyMigrationBundle(
      legacyPlans(),
      history(),
      currentBatch()
    );
    expect(second).toEqual(first);
    expect(first.plans).toHaveLength(2);
    expect(first.batches).toHaveLength(4);
    expect(first.targets).toHaveLength(5);

    const byUrl = new Map(first.targets.map((target) => [target.url, target]));
    expect(byUrl.get('https://pending.example/post')).toMatchObject({
      status: 'pending',
      attemptCount: 0,
    });
    expect(byUrl.get('https://success.example/post')).toMatchObject({
      status: 'unconfirmed',
      attemptCount: 1,
    });
    expect(byUrl.get('https://unknown.example/post')).toMatchObject({
      status: 'unknown',
      attemptCount: 0,
    });
    expect(byUrl.get('https://interrupted.example/post')).toMatchObject({
      status: 'interrupted',
      attemptCount: 0,
    });
    expect(byUrl.get('https://manual.example/post')).toMatchObject({
      status: 'blocked',
      attemptCount: 1,
    });

    const primary = first.plans.find(
      (plan) => plan.promotingSiteId === 'primary'
    );
    expect(primary).toMatchObject({
      promotingSiteLabel: 'Primary product',
      status: 'active',
      targetCount: 4,
      processedCount: 1,
      submittedCount: 0,
      unknownCount: 2,
    });
    const current = first.batches.find(
      (batch) => batch.externalBatchId === 'current-linked'
    );
    expect(current?.status).toBe('blocked');
    const missing = first.batches.find(
      (batch) => batch.externalBatchId === 'missing-runtime-batch'
    );
    expect(missing?.status).toBe('interrupted');

    const orphanRun = first.runs.find(
      (run) => run.externalBatchId === 'history-orphan'
    );
    expect(orphanRun).toMatchObject({
      status: 'completed_with_errors',
    });
    expect(
      first.attempts.find((attempt) => attempt.runId === orphanRun?.id)
    ).toMatchObject({
      status: 'failed',
      error: {
        code: 'FAILED',
        message: 'LEGACY_FAILURE',
      },
    });
  });

  it('imports atomically, marks completion, and is idempotent', async () => {
    const indexedDB = new IDBFactory();
    const repo = createDashboardRepository({
      indexedDB,
      databaseName: 'migration-idempotency',
      now: () => 9_000,
      idFactory: () => 'unused',
    });
    const first = await migrateLegacyDashboardData(
      repo,
      legacyPlans(),
      history(),
      currentBatch(),
      9_000
    );
    const second = await migrateLegacyDashboardData(
      repo,
      legacyPlans(),
      history(),
      currentBatch(),
      9_100
    );

    expect(first).toMatchObject({
      imported: true,
      verified: true,
      markerKey: LEGACY_DASHBOARD_MIGRATION_MARKER,
      activeRunReference: {
        planId: expect.any(String),
        batchId: expect.any(String),
        runId: expect.any(String),
        externalBatchId: 'current-linked',
      },
      counts: {
        plans: 2,
        batches: 4,
        targets: 5,
      },
    });
    expect(second).toMatchObject({
      imported: false,
      verified: true,
      counts: first.counts,
    });
    // The marker means this bundle was not imported, so its deterministic
    // legacy run ID must never overwrite the real active-run reference.
    expect(second.activeRunReference).toBeNull();
    expect(await repo.listPlans()).toHaveLength(2);
    expect(await repo.getMeta(LEGACY_DASHBOARD_MIGRATION_MARKER)).toMatchObject(
      {
        completed: true,
        counts: first.counts,
      }
    );
    const summary = await repo.getDashboardSummary({ now: 9_100 });
    expect(summary.counts).toMatchObject({
      total: 5,
      processed: 2,
      submitted: 0,
      failed: 0,
      unknown: 2,
      interrupted: 1,
      blocked: 1,
      pending: 1,
    });
  });

  it('tracks an unassociated active quick batch as a standalone run', async () => {
    const indexedDB = new IDBFactory();
    const repo = createDashboardRepository({
      indexedDB,
      databaseName: 'migration-standalone-active',
      now: () => 9_000,
      idFactory: () => 'unused',
    });
    let quick = createBatch({
      id: 'quick-active',
      targetText: 'https://quick.example/post',
      settings: baseSettings,
      now: 8_000,
    });
    quick = pauseCurrentItem(
      quick,
      'captcha_required',
      'CAPTCHA_REQUIRED',
      8_100
    );

    const result = await migrateLegacyDashboardData(repo, {}, [], quick, 9_000);

    expect(result.activeRunReference).toMatchObject({
      kind: 'standalone',
      externalBatchId: quick.id,
      runId: expect.any(String),
    });
    const runId = result.activeRunReference?.runId;
    expect(runId).toBeTruthy();
    expect(await repo.getRun(runId!)).toMatchObject({
      externalBatchId: quick.id,
      status: 'blocked',
    });
    expect(await repo.getRun(runId!)).not.toHaveProperty('planId');
    expect(await repo.getRun(runId!)).not.toHaveProperty('batchId');
  });

  it('uses current detailed results instead of guessing success', () => {
    let current = createBatch({
      id: 'history-linked',
      targetText: 'https://success.example/post\nhttps://unknown.example/post',
      settings: {
        ...baseSettings,
        siteId: 'primary',
        siteLabel: 'Primary product',
      },
      now: 2_000,
    });
    current = completeCurrentItem(
      current,
      'validation_error',
      'REQUIRED_FIELD',
      2_100
    );
    current = completeCurrentItem(current, 'submitted', 'OK', 2_200);

    const bundle = buildLegacyMigrationBundle(
      legacyPlans(),
      history(),
      current
    );
    const targets = bundle.targets.filter(
      (target) => target.batchSequence === 2
    );
    expect(targets.map((target) => target.status)).toEqual([
      'validation_error',
      'unconfirmed',
    ]);
    expect(
      targets.find((target) => target.status === 'validation_error')?.lastError
    ).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'REQUIRED_FIELD',
    });
  });
});
