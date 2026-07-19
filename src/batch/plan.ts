import type { PlanChunk, SitePlan } from '@/storage/plans';

// Splits an already-parsed, deduped URL list (see parseTargetUrls) into
// day-sized chunks. Each chunk later feeds one batch.
export function splitIntoChunks(urls: string[], size: number): string[][] {
  if (size < 1) throw new Error('PLAN_CHUNK_SIZE_INVALID');
  const chunks: string[][] = [];
  for (let index = 0; index < urls.length; index += size) {
    chunks.push(urls.slice(index, index + size));
  }
  return chunks;
}

export function nextPendingChunk(plan: SitePlan): PlanChunk | null {
  return plan.chunks.find((chunk) => chunk.status === 'pending') ?? null;
}

function isSameLocalDay(a: number, b: number): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

// Due iff there is still a pending chunk to run AND nothing in this plan was
// started on the same local calendar day as `now` (one chunk per day, manual).
export function isDueToday(plan: SitePlan, now: number): boolean {
  if (!nextPendingChunk(plan)) return false;
  return !plan.chunks.some(
    (chunk) =>
      chunk.startedAt !== undefined && isSameLocalDay(chunk.startedAt, now)
  );
}

export function planProgress(plan: SitePlan): { done: number; total: number } {
  return {
    done: plan.chunks.filter((chunk) => chunk.status === 'done').length,
    total: plan.chunks.length,
  };
}

export function markChunkStarted(
  plan: SitePlan,
  chunkId: string,
  batchId: string,
  at: number
): SitePlan {
  return {
    ...plan,
    chunks: plan.chunks.map((chunk) =>
      chunk.id === chunkId
        ? { ...chunk, status: 'started', batchId, startedAt: at }
        : chunk
    ),
    updatedAt: at,
  };
}

// Settles whichever chunk a finished batch was running. No-op (same reference)
// when no started chunk owns this batch id, so it is safe to call on every
// terminal transition.
export function markChunkDone(
  plan: SitePlan,
  batchId: string,
  at: number
): SitePlan {
  const target = plan.chunks.find(
    (chunk) => chunk.status === 'started' && chunk.batchId === batchId
  );
  if (!target) return plan;
  return {
    ...plan,
    chunks: plan.chunks.map((chunk) =>
      chunk === target ? { ...chunk, status: 'done', completedAt: at } : chunk
    ),
    updatedAt: at,
  };
}
