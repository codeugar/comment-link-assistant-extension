import { completeCurrentItem, createBatch } from '@/batch/state';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { createDashboardRepository } from './db';

const settings = {
  provider: 'deepseek' as const,
  websiteUrl: 'https://product.example',
  displayName: 'Alex',
  email: '',
  linkMode: 'inline' as const,
  siteId: 'site-1',
  siteLabel: 'Product',
};

describe('pending moderation persistence', () => {
  it('retains verification data and updates target plus attempt history when published', async () => {
    const repo = createDashboardRepository({
      databaseName: `moderation-recheck-${Math.random()}`,
      indexedDB: new IDBFactory(),
      now: () => 100,
      idFactory: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    });
    const detail = await repo.createPlan({
      name: 'Moderation checks',
      promotingSiteId: 'site-1',
      promotingSiteLabel: 'Product',
      promotingWebsiteUrl: 'https://product.example',
      urls: ['https://blog.example/post'],
      chunkSize: 1,
      now: 100,
    });
    const batch = detail.batches[0]!;
    const target = (await repo.getBatchTargets(batch.id))[0]!;
    const started = await repo.startBatchRun(detail.plan.id, batch.id, {
      externalBatchId: 'runtime-moderation',
      at: 200,
    });
    let snapshot = createBatch({
      id: 'runtime-moderation',
      targetText: target.url,
      settings,
      now: 200,
    });
    snapshot = completeCurrentItem(
      snapshot,
      'pending_moderation',
      'COMMENT_PENDING_WORDPRESS_MODERATION',
      201
    );
    snapshot = {
      ...snapshot,
      items: snapshot.items.map((item) => ({
        ...item,
        comment: 'A useful generated comment for moderation.',
      })),
    };
    await repo.syncBatchSnapshot(detail.plan.id, batch.id, snapshot, {
      runId: started.run.id,
    });

    const [check] = await repo.getPendingModerationChecks();
    expect(check).toMatchObject({
      targetId: target.id,
      planId: detail.plan.id,
      url: target.url,
      targetWebsiteUrl: detail.plan.promotingWebsiteUrl,
      fingerprint: 'A useful generated comment for moderation.',
      checkCount: 0,
    });
    const initialAttempt = (await repo.getAttempts(target.id))[0]!;
    expect(initialAttempt.commentFingerprint).toBe(
      'A useful generated comment for moderation.'
    );

    await repo.recordModerationCheck({
      targetId: check!.targetId,
      attemptId: check!.attemptId,
      status: 'pending_moderation',
      message: 'COMMENT_PENDING_MODERATION_NOT_VISIBLE',
      at: 300,
    });
    expect(await repo.getTarget(detail.plan.id, target.id)).toMatchObject({
      status: 'pending_moderation',
      latestMessage: 'COMMENT_PENDING_WORDPRESS_MODERATION',
      lastModerationCheckAt: 300,
      lastModerationCheckMessage: 'COMMENT_PENDING_MODERATION_NOT_VISIBLE',
    });
    expect(await repo.getPendingModerationChecks()).toEqual([
      expect.objectContaining({
        targetId: target.id,
        checkCount: 1,
        lastCheckAt: 300,
        lastCheckMessage: 'COMMENT_PENDING_MODERATION_NOT_VISIBLE',
      }),
    ]);

    await repo.recordModerationCheck({
      targetId: check!.targetId,
      attemptId: check!.attemptId,
      status: 'published',
      message: 'COMMENT_PUBLISHED_RENDERED_FINGERPRINT',
      at: 400,
    });
    expect(await repo.getTarget(detail.plan.id, target.id)).toMatchObject({
      status: 'published',
      latestMessage: 'COMMENT_PUBLISHED_RENDERED_FINGERPRINT',
      lastModerationCheckAt: 400,
    });
    expect((await repo.getAttempts(target.id))[0]).toMatchObject({
      status: 'published',
      timeline: expect.arrayContaining([
        expect.objectContaining({
          stage: 'moderation_recheck',
          status: 'pending_moderation',
        }),
        expect.objectContaining({
          stage: 'moderation_recheck',
          status: 'published',
        }),
      ]),
    });
    expect(await repo.getRecentModerationTransitions()).toEqual([
      expect.objectContaining({
        targetId: target.id,
        planId: detail.plan.id,
        url: target.url,
        checkCount: 2,
        publishedAt: 400,
        message: 'COMMENT_PUBLISHED_RENDERED_FINGERPRINT',
      }),
    ]);
    await repo.recordModerationCheck({
      targetId: check!.targetId,
      attemptId: check!.attemptId,
      status: 'pending_moderation',
      message: 'COMMENT_PENDING_MODERATION_NOT_VISIBLE',
      preserveCurrentStatus: true,
      at: 500,
    });
    expect(await repo.getTarget(detail.plan.id, target.id)).toMatchObject({
      status: 'published',
      lastModerationCheckAt: 500,
      lastModerationCheckMessage: 'COMMENT_PENDING_MODERATION_NOT_VISIBLE',
    });
    expect(
      (await repo.getAttempts(target.id))[0]?.timeline.at(-1)
    ).toMatchObject({
      stage: 'moderation_recheck',
      status: 'pending_moderation',
      at: 500,
    });
    expect((await repo.getPlanDetail(detail.plan.id))?.plan).toMatchObject({
      submittedCount: 1,
      unknownCount: 0,
    });
  });

  it('queues unconfirmed submissions and keeps them unconfirmed until the URL appears', async () => {
    const repo = createDashboardRepository({
      databaseName: `unconfirmed-recheck-${Math.random()}`,
      indexedDB: new IDBFactory(),
      now: () => 100,
      idFactory: (() => {
        let id = 0;
        return () => `unconfirmed-${++id}`;
      })(),
    });
    const detail = await repo.createPlan({
      name: 'Unconfirmed checks',
      promotingSiteId: 'site-1',
      promotingSiteLabel: 'Product',
      promotingWebsiteUrl: 'https://product.example',
      urls: ['https://blog.example/unconfirmed'],
      chunkSize: 1,
      now: 100,
    });
    const batch = detail.batches[0]!;
    const target = (await repo.getBatchTargets(batch.id))[0]!;
    const started = await repo.startBatchRun(detail.plan.id, batch.id, {
      externalBatchId: 'runtime-unconfirmed',
      at: 200,
    });
    let snapshot = createBatch({
      id: 'runtime-unconfirmed',
      targetText: target.url,
      settings,
      now: 200,
    });
    snapshot = completeCurrentItem(
      snapshot,
      'unconfirmed',
      'COMMENT_SUBMISSION_UNCONFIRMED',
      201
    );
    snapshot = {
      ...snapshot,
      items: snapshot.items.map((item) => ({
        ...item,
        comment: 'A generated comment whose result is not confirmed.',
      })),
    };
    await repo.syncBatchSnapshot(detail.plan.id, batch.id, snapshot, {
      runId: started.run.id,
    });

    const [check] = await repo.getPendingModerationChecks();
    expect(check).toMatchObject({
      targetId: target.id,
      url: target.url,
      targetWebsiteUrl: detail.plan.promotingWebsiteUrl,
    });

    await repo.recordModerationCheck({
      targetId: check!.targetId,
      attemptId: check!.attemptId,
      status: 'pending_moderation',
      message: 'COMMENT_PENDING_MODERATION_NOT_VISIBLE',
      at: 300,
    });
    expect(await repo.getTarget(detail.plan.id, target.id)).toMatchObject({
      status: 'unconfirmed',
      lastModerationCheckAt: 300,
    });
    expect((await repo.getAttempts(target.id))[0]).toMatchObject({
      status: 'unconfirmed',
    });
    expect(await repo.getPendingModerationChecks()).toHaveLength(1);

    await repo.recordModerationCheck({
      targetId: check!.targetId,
      attemptId: check!.attemptId,
      status: 'published',
      message: 'COMMENT_PUBLISHED_RENDERED_TARGET_URL',
      at: 400,
    });
    expect(await repo.getTarget(detail.plan.id, target.id)).toMatchObject({
      status: 'published',
      latestMessage: 'COMMENT_PUBLISHED_RENDERED_TARGET_URL',
    });
    expect(await repo.getPendingModerationChecks()).toHaveLength(0);
  });
});
