import type { BatchSnapshot } from './types';

export interface IdleArchiveDependencies {
  getBatch(): Promise<BatchSnapshot | null>;
  archiveBatch(snapshot: BatchSnapshot): Promise<void>;
  clearBatch(): Promise<void>;
  // Optional settle hook run just before a finished batch is archived (e.g. to
  // mark its plan chunk done). No-op for callers that do not need it.
  onArchive?(snapshot: BatchSnapshot): Promise<void>;
}

// Ensures no batch is in flight, moving a finished one to history and clearing
// it so a fresh run can take its place. Shared by history reruns and plan runs.
// If the caller's start step later throws, the terminal batch is already
// preserved in history rather than silently overwritten.
export async function ensureIdleAndArchive(
  deps: IdleArchiveDependencies
): Promise<void> {
  const current = await deps.getBatch();
  if (current?.status === 'running' || current?.status === 'paused') {
    throw new Error('BATCH_ALREADY_ACTIVE');
  }
  if (current) {
    await deps.onArchive?.(current);
    await deps.archiveBatch(current);
    await deps.clearBatch();
  }
}
