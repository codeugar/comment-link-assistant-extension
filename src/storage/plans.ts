import { z } from 'zod';

export const PLANS_STORAGE_KEY = 'comment-link-assistant.plans';

const MAX_SITES_WITH_PLANS = 10;

export type PlanChunkStatus = 'pending' | 'started' | 'done';

export interface PlanChunk {
  id: string;
  urls: string[];
  status: PlanChunkStatus;
  batchId?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface SitePlan {
  siteId: string;
  chunkSize: number;
  chunks: PlanChunk[];
  createdAt: number;
  updatedAt: number;
}

export type PlansMap = Record<string, SitePlan>;

const planChunkSchema: z.ZodType<PlanChunk> = z
  .object({
    id: z.string().min(1).max(200),
    urls: z.array(z.string().min(1).max(2_048)).min(1).max(200),
    status: z.enum(['pending', 'started', 'done']),
    batchId: z.string().min(1).max(200).optional(),
    startedAt: z.number().int().nonnegative().optional(),
    completedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

const sitePlanSchema: z.ZodType<SitePlan> = z
  .object({
    siteId: z.string().min(1).max(200),
    // A chunk feeds one batch, and batches cap at 200 items.
    chunkSize: z.number().int().min(1).max(200),
    // Up to the full 200-URL dump split one-per-batch.
    chunks: z.array(planChunkSchema).min(1).max(200),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

const plansSchema = z
  .record(z.string(), sitePlanSchema)
  .refine((map) => Object.keys(map).length <= MAX_SITES_WITH_PLANS);

export function parseStoredPlans(value: unknown): PlansMap | null {
  const parsed = plansSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function getPlans(): Promise<PlansMap> {
  const stored = await chrome.storage.local.get(PLANS_STORAGE_KEY);
  return parseStoredPlans(stored[PLANS_STORAGE_KEY]) ?? {};
}

export async function setPlans(plans: PlansMap): Promise<void> {
  const parsed = plansSchema.parse(plans);
  await chrome.storage.local.set({ [PLANS_STORAGE_KEY]: parsed });
}

export async function savePlan(plan: SitePlan): Promise<void> {
  const parsed = sitePlanSchema.parse(plan);
  const plans = await getPlans();
  await setPlans({ ...plans, [parsed.siteId]: parsed });
}

export async function deletePlan(siteId: string): Promise<void> {
  const plans = await getPlans();
  if (!(siteId in plans)) return;
  const next = { ...plans };
  delete next[siteId];
  await setPlans(next);
}
