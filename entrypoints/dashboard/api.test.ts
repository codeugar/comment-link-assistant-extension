import type { Plan } from '@/dashboard/model';
import type { ExtensionSettings, SiteProfile } from '@/types';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboardRequest, syncPreviewSettings } from './api';

describe('dashboard preview API state', () => {
  afterEach(() => {
    globalThis.history.replaceState({}, '', '/');
  });

  it('uses the synchronized promoting site when creating a preview plan', async () => {
    globalThis.history.replaceState({}, '', '/?preview');
    const site: SiteProfile = {
      id: 'site-preview-new',
      label: 'New Preview Site',
      websiteUrl: 'https://new-preview.example',
      displayName: '',
      email: '',
      linkMode: 'a-tag-newline',
    };
    const settings: ExtensionSettings = {
      provider: 'deepseek',
      sites: [site],
      activeSiteId: site.id,
      locale: 'zh-CN',
    };

    syncPreviewSettings(settings);
    const plan = await dashboardRequest<Plan>({
      type: 'plan.create',
      name: 'Preview plan with new site',
      siteId: site.id,
      targetText: 'https://target.example',
      chunkSize: 30,
    });

    expect(plan.promotingSiteId).toBe(site.id);
    expect(plan.promotingSiteLabel).toBe(site.label);
    expect(plan.promotingWebsiteUrl).toBe(site.websiteUrl);
  });
});
