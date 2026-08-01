import type { BatchSettingsSnapshot } from '@/batch/types';
import type { CommentProvider, SiteProfile } from '@/types';
import type { Plan } from './model';

type PromotingWebsiteSnapshot = Pick<
  Plan,
  'promotingSiteId' | 'promotingSiteLabel' | 'promotingWebsiteUrl'
>;

/**
 * Builds a run snapshot from the plan's immutable promoting-website fields.
 *
 * Site profiles remain the source of optional commenter identity settings, but
 * they must never replace a plan's URL or label: a user can edit or remove a
 * site profile after a plan has been saved. In that case, a plan can still run
 * against the originally saved website with conservative identity defaults.
 */
export function buildPlanBatchSettingsSnapshot(
  plan: PromotingWebsiteSnapshot,
  provider: CommentProvider,
  sites: readonly SiteProfile[]
): BatchSettingsSnapshot {
  const configuredSite = sites.find((site) => site.id === plan.promotingSiteId);

  return {
    provider,
    websiteUrl: plan.promotingWebsiteUrl,
    displayName: configuredSite?.displayName ?? '',
    email: configuredSite?.email ?? '',
    linkMode: configuredSite?.linkMode ?? 'prefer-website-field',
    siteId: plan.promotingSiteId,
    siteLabel: plan.promotingSiteLabel,
  };
}
