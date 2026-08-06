import {
  ANCHOR_BUCKETS,
  ANCHOR_TARGET_TOTAL,
  type AnchorPlan,
  MAX_ANCHOR_POOL_ENTRIES,
  MAX_ANCHOR_TEXT_LENGTH,
  createDefaultAnchorPlan,
} from '@/anchor/types';
import { z } from 'zod';

export const ANCHOR_PLAN_STORAGE_KEY = 'comment-link-assistant.anchor-plan';

// Matches the promoting-site cap in src/dashboard/promoting-site.ts.
const MAX_SITES_WITH_ANCHOR_PLANS = 20;

export type AnchorPlansMap = Record<string, AnchorPlan>;

function bucketRecord<T extends z.ZodTypeAny>(value: T) {
  return z
    .object(
      Object.fromEntries(ANCHOR_BUCKETS.map((bucket) => [bucket, value])) as {
        [K in (typeof ANCHOR_BUCKETS)[number]]: T;
      }
    )
    .strict();
}

const anchorTextSchema = z.string().trim().min(1).max(MAX_ANCHOR_TEXT_LENGTH);

export const anchorPlanSchema: z.ZodType<AnchorPlan> = z
  .object({
    siteId: z.string().min(1).max(200),
    targets: bucketRecord(z.number().int().min(0).max(100)).refine(
      (targets) =>
        Object.values(targets).reduce((sum, value) => sum + value, 0) ===
        ANCHOR_TARGET_TOTAL,
      'Anchor targets must add up to 100'
    ),
    pools: bucketRecord(z.array(anchorTextSchema).max(MAX_ANCHOR_POOL_ENTRIES)),
    cursor: bucketRecord(z.number().int().nonnegative()),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const anchorPlansSchema = z
  .record(z.string(), anchorPlanSchema)
  .refine((map) => Object.keys(map).length <= MAX_SITES_WITH_ANCHOR_PLANS);

export function parseStoredAnchorPlans(value: unknown): AnchorPlansMap | null {
  const parsed = anchorPlansSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function getAnchorPlans(): Promise<AnchorPlansMap> {
  const stored = await chrome.storage.local.get(ANCHOR_PLAN_STORAGE_KEY);
  return parseStoredAnchorPlans(stored[ANCHOR_PLAN_STORAGE_KEY]) ?? {};
}

export async function setAnchorPlans(plans: AnchorPlansMap): Promise<void> {
  const parsed = anchorPlansSchema.parse(plans);
  await chrome.storage.local.set({ [ANCHOR_PLAN_STORAGE_KEY]: parsed });
}

/** Returns the stored plan, or a default one so callers never branch on
 *  "this site has not been configured yet". A default plan has empty pools,
 *  which anchor selection reads as "no ratio control for this site". */
export async function getAnchorPlan(
  siteId: string,
  now: number = Date.now()
): Promise<AnchorPlan> {
  const plans = await getAnchorPlans();
  return plans[siteId] ?? createDefaultAnchorPlan(siteId, now);
}

export async function saveAnchorPlan(plan: AnchorPlan): Promise<void> {
  const parsed = anchorPlanSchema.parse(plan);
  const plans = await getAnchorPlans();
  await setAnchorPlans({ ...plans, [parsed.siteId]: parsed });
}

export async function deleteAnchorPlan(siteId: string): Promise<void> {
  const plans = await getAnchorPlans();
  if (!(siteId in plans)) return;
  const next = { ...plans };
  delete next[siteId];
  await setAnchorPlans(next);
}
