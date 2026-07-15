import type { BatchSnapshot } from './types';

interface OpenCurrentTargetDependencies {
  getActiveRunner(): Promise<void> | null;
  getBatch(): Promise<BatchSnapshot | null>;
  setBatch(batch: BatchSnapshot): Promise<BatchSnapshot>;
  getBatchStopIntent(): Promise<boolean>;
  activateTab(batchId: string, tabId: number): Promise<boolean>;
  createTab(batchId: string, url: string): Promise<number | null>;
  requestBatchWake(): void;
  isStopRequested(): boolean;
  now(): number;
}

interface RemovedWorkerTabDependencies {
  getBatch(): Promise<BatchSnapshot | null>;
  requestBatchWake(): void;
}

export async function openCurrentTargetSafely(
  dependencies: OpenCurrentTargetDependencies
): Promise<BatchSnapshot | null> {
  await dependencies.getActiveRunner()?.catch(() => undefined);
  const batch = await dependencies.getBatch();
  if (!batch) throw new Error('BATCH_NOT_FOUND');
  const item = batch.items[batch.currentIndex];
  if (!item) return batch;

  if (
    batch.workerTabId !== undefined &&
    (await dependencies.activateTab(batch.id, batch.workerTabId))
  ) {
    return (await dependencies.getBatch()) ?? batch;
  }

  if (batch.status === 'running') {
    dependencies.requestBatchWake();
    return (await dependencies.getBatch()) ?? batch;
  }
  if (batch.status !== 'paused') {
    return (await dependencies.getBatch()) ?? batch;
  }

  const tabId = await dependencies.createTab(batch.id, item.url);
  if (tabId === null) throw new Error('WORKER_TAB_CREATE_FAILED');
  if (await dependencies.getBatchStopIntent()) {
    return dependencies.getBatch();
  }

  const latest = await dependencies.getBatch();
  const latestItem = latest?.items[latest.currentIndex];
  if (
    !latest ||
    dependencies.isStopRequested() ||
    latest.id !== batch.id ||
    latest.status !== 'paused' ||
    latest.currentIndex !== batch.currentIndex ||
    latestItem?.id !== item.id
  ) {
    return latest;
  }

  return dependencies.setBatch({
    ...latest,
    workerTabId: tabId,
    updatedAt: dependencies.now(),
  });
}

export async function handleRemovedWorkerTabSafely(
  tabId: number,
  dependencies: RemovedWorkerTabDependencies
): Promise<void> {
  const batch = await dependencies.getBatch();
  if (batch?.workerTabId === tabId) dependencies.requestBatchWake();
}
