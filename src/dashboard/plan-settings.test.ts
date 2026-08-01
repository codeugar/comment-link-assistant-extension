import { describe, expect, it } from 'vitest';
import type { Plan } from './model';
import { buildPlanBatchSettingsSnapshot } from './plan-settings';

const plan: Pick<
  Plan,
  'promotingSiteId' | 'promotingSiteLabel' | 'promotingWebsiteUrl'
> = {
  promotingSiteId: 'site-seed',
  promotingSiteLabel: 'Seed Studio',
  promotingWebsiteUrl: 'https://seed.example/original',
};

describe('buildPlanBatchSettingsSnapshot', () => {
  it('keeps the saved promoting website URL and label after its site is edited', () => {
    const snapshot = buildPlanBatchSettingsSnapshot(plan, 'deepseek', [
      {
        id: 'site-seed',
        label: 'Renamed site',
        websiteUrl: 'https://different.example',
        displayName: 'Updated author',
        email: 'updated@example.test',
        linkMode: 'inline',
      },
    ]);

    expect(snapshot).toEqual({
      provider: 'deepseek',
      websiteUrl: 'https://seed.example/original',
      displayName: 'Updated author',
      email: 'updated@example.test',
      linkMode: 'inline',
      siteId: 'site-seed',
      siteLabel: 'Seed Studio',
    });
  });

  it('can run a saved plan after the matching site profile is deleted', () => {
    expect(buildPlanBatchSettingsSnapshot(plan, 'kie-gemini', [])).toEqual({
      provider: 'kie-gemini',
      websiteUrl: 'https://seed.example/original',
      displayName: '',
      email: '',
      linkMode: 'prefer-website-field',
      siteId: 'site-seed',
      siteLabel: 'Seed Studio',
    });
  });
});
