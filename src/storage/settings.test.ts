import type { SiteProfile } from '@/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  DEFAULT_PROVIDER_API_KEYS,
  DEFAULT_SETTINGS,
  PROVIDER_API_KEYS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  buildBatchSettingsSnapshot,
  getActiveSite,
  getProviderApiKeys,
  getSettings,
  setProviderApiKeys,
  setSettings,
} from './settings';

function site(overrides: Partial<SiteProfile> = {}): SiteProfile {
  return {
    id: 'site-1',
    label: 'Product',
    websiteUrl: 'https://product.example',
    displayName: 'Alex',
    email: 'alex@example.com',
    linkMode: 'inline',
    ...overrides,
  };
}

describe('extension settings', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('defaults to a single empty site with no provider keys', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.sites).toHaveLength(1);
    expect(DEFAULT_SETTINGS.activeSiteId).toBe(DEFAULT_SETTINGS.sites[0]?.id);
    expect(await getProviderApiKeys()).toEqual(DEFAULT_PROVIDER_API_KEYS);
  });

  it('validates, normalizes, and persists a multi-site configuration', async () => {
    const saved = await setSettings({
      provider: 'kie-gemini',
      sites: [
        site({
          id: 'a',
          label: '  Product  ',
          websiteUrl: ' https://product.example/ ',
          displayName: '  Alex  ',
          email: ' alex@example.com ',
        }),
        site({
          id: 'b',
          label: 'Museimage',
          websiteUrl: 'https://muse.example',
        }),
      ],
      activeSiteId: 'b',
    });

    expect(saved.sites[0]).toEqual(
      site({ id: 'a', label: 'Product', websiteUrl: 'https://product.example' })
    );
    expect(saved.activeSiteId).toBe('b');
    expect(await getSettings()).toEqual(saved);
  });

  it('rejects an activeSiteId that does not reference a site', async () => {
    await expect(
      setSettings({
        provider: 'deepseek',
        sites: [site({ id: 'a' })],
        activeSiteId: 'missing',
      })
    ).rejects.toThrow();
  });

  it('rejects an empty site list', async () => {
    await expect(
      setSettings({ provider: 'deepseek', sites: [], activeSiteId: 'a' })
    ).rejects.toThrow();
  });

  it('rejects a non-http site URL and an oversized label', async () => {
    await expect(
      setSettings({
        provider: 'deepseek',
        sites: [site({ id: 'a', websiteUrl: 'file:///tmp/site.html' })],
        activeSiteId: 'a',
      })
    ).rejects.toThrow();

    await expect(
      setSettings({
        provider: 'deepseek',
        sites: [site({ id: 'a', label: 'x'.repeat(101) })],
        activeSiteId: 'a',
      })
    ).rejects.toThrow();
  });

  it('migrates a legacy flat configuration into a single labelled site', async () => {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: {
        provider: 'kie-gemini',
        websiteUrl: 'https://www.product.example/',
        displayName: 'Alex',
        email: 'alex@example.com',
        linkMode: 'inline',
      },
    });

    const migrated = await getSettings();
    expect(migrated).toEqual({
      provider: 'kie-gemini',
      sites: [
        {
          id: 'site-1',
          label: 'product.example',
          websiteUrl: 'https://www.product.example',
          displayName: 'Alex',
          email: 'alex@example.com',
          linkMode: 'inline',
        },
      ],
      activeSiteId: 'site-1',
    });
    // Migration is persisted so later reads and writes see the new shape.
    expect(
      (await chrome.storage.local.get(SETTINGS_STORAGE_KEY))[
        SETTINGS_STORAGE_KEY
      ]
    ).toMatchObject({ sites: [{ id: 'site-1' }], activeSiteId: 'site-1' });
  });

  it('passes an already-migrated configuration through unchanged', async () => {
    const next = {
      provider: 'deepseek' as const,
      sites: [site({ id: 'only' })],
      activeSiteId: 'only',
    };
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });

    expect(await getSettings()).toEqual(next);
  });

  it('falls back to defaults for invalid stored settings', async () => {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: { provider: 'unknown-provider' },
    });
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('resolves the active site and falls back to the first site', () => {
    const settings = {
      provider: 'deepseek' as const,
      sites: [site({ id: 'a' }), site({ id: 'b', label: 'B' })],
      activeSiteId: 'b',
    };
    expect(getActiveSite(settings).id).toBe('b');
    expect(getActiveSite({ ...settings, activeSiteId: 'gone' }).id).toBe('a');
  });

  it('builds a batch settings snapshot carrying site provenance', () => {
    expect(
      buildBatchSettingsSnapshot('kie-gemini', site({ id: 'x', label: 'Muse' }))
    ).toEqual({
      provider: 'kie-gemini',
      websiteUrl: 'https://product.example',
      displayName: 'Alex',
      email: 'alex@example.com',
      linkMode: 'inline',
      siteId: 'x',
      siteLabel: 'Muse',
    });
  });

  it('stores both provider keys separately from public settings', async () => {
    const keys = await setProviderApiKeys({
      deepseekApiKey: '  deepseek-key  ',
      kieApiKey: '  kie-key  ',
    });

    expect(keys).toEqual({
      deepseekApiKey: 'deepseek-key',
      kieApiKey: 'kie-key',
    });
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    const stored = await chrome.storage.local.get([
      SETTINGS_STORAGE_KEY,
      PROVIDER_API_KEYS_STORAGE_KEY,
    ]);
    expect(stored[SETTINGS_STORAGE_KEY]).toBeUndefined();
    expect(stored[PROVIDER_API_KEYS_STORAGE_KEY]).toEqual(keys);
  });

  it('rejects oversized keys before storage', async () => {
    await expect(
      setProviderApiKeys({ deepseekApiKey: 'x'.repeat(4_097), kieApiKey: '' })
    ).rejects.toThrow();
  });
});
