import { type BatchSnapshot, batchSnapshotSchema } from './types';

interface TerminalWorkerCleanupDependencies {
  closeWorkerTab(batchId: string, tabId: number): Promise<boolean>;
  setBatch(batch: BatchSnapshot): Promise<BatchSnapshot>;
  now(): number;
}

export async function closeTerminalBatchWorker(
  batch: BatchSnapshot,
  dependencies: TerminalWorkerCleanupDependencies
): Promise<BatchSnapshot> {
  if (
    (batch.status !== 'completed' && batch.status !== 'stopped') ||
    batch.workerTabId === undefined
  ) {
    return batch;
  }

  await dependencies.closeWorkerTab(batch.id, batch.workerTabId);
  const next = { ...batch, updatedAt: dependencies.now() };
  Reflect.deleteProperty(next, 'workerTabId');
  return dependencies.setBatch(batchSnapshotSchema.parse(next));
}
