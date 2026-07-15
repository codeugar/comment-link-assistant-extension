import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  DEFAULT_PROVIDER_API_KEYS,
  DEFAULT_SETTINGS,
  PROVIDER_API_KEYS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  getProviderApiKeys,
  getSettings,
  setProviderApiKeys,
  setSettings,
} from './settings';

describe('extension settings', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('starts with no backend configuration and no provider keys', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).not.toHaveProperty('backendUrl');
    expect(await getProviderApiKeys()).toEqual(DEFAULT_PROVIDER_API_KEYS);
  });

  it('validates, normalizes, and persists public settings', async () => {
    const settings = await setSettings({
      provider: 'kie-gemini',
      websiteUrl: ' https://product.example/ ',
      displayName: '  Alex  ',
      email: ' alex@example.com ',
      linkMode: 'inline',
    });

    expect(settings).toEqual({
      provider: 'kie-gemini',
      websiteUrl: 'https://product.example',
      displayName: 'Alex',
      email: 'alex@example.com',
      linkMode: 'inline',
    });
    expect(await getSettings()).toEqual(settings);
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
    expect(await getProviderApiKeys()).toEqual(keys);
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);

    const stored = await chrome.storage.local.get([
      SETTINGS_STORAGE_KEY,
      PROVIDER_API_KEYS_STORAGE_KEY,
    ]);
    expect(stored[SETTINGS_STORAGE_KEY]).toBeUndefined();
    expect(stored[PROVIDER_API_KEYS_STORAGE_KEY]).toEqual(keys);
  });

  it('allows an unused provider key to stay empty', async () => {
    await expect(
      setProviderApiKeys({ deepseekApiKey: 'deepseek-key', kieApiKey: '' })
    ).resolves.toEqual({
      deepseekApiKey: 'deepseek-key',
      kieApiKey: '',
    });
  });

  it('rejects non-http website URLs at the user-input boundary', async () => {
    await expect(
      setSettings({
        ...DEFAULT_SETTINGS,
        websiteUrl: 'file:///tmp/site.html',
      })
    ).rejects.toThrow();

    await expect(
      setSettings({
        ...DEFAULT_SETTINGS,
        websiteUrl: 'https://user:password@product.example',
      })
    ).rejects.toThrow();
  });

  it('rejects oversized settings and keys before storage', async () => {
    await expect(
      setSettings({
        ...DEFAULT_SETTINGS,
        displayName: 'x'.repeat(201),
      })
    ).rejects.toThrow();
    await expect(
      setProviderApiKeys({
        deepseekApiKey: 'x'.repeat(4_097),
        kieApiKey: '',
      })
    ).rejects.toThrow();
  });

  it('falls back safely when stored settings or keys are invalid', async () => {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: {
        ...DEFAULT_SETTINGS,
        provider: 'unknown-provider',
      },
      [PROVIDER_API_KEYS_STORAGE_KEY]: {
        deepseekApiKey: 123,
        kieApiKey: 'kie-key',
      },
    });

    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await getProviderApiKeys()).toEqual(DEFAULT_PROVIDER_API_KEYS);
  });

  it('strips unknown fields from public settings and provider keys', async () => {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: {
        ...DEFAULT_SETTINGS,
        backendUrl: 'https://must-not-escape.example',
      },
      [PROVIDER_API_KEYS_STORAGE_KEY]: {
        deepseekApiKey: 'deepseek-key',
        kieApiKey: '',
        backendAccessToken: 'must-not-escape',
      },
    });

    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await getSettings()).not.toHaveProperty('backendUrl');
    expect(await getProviderApiKeys()).toEqual({
      deepseekApiKey: 'deepseek-key',
      kieApiKey: '',
    });
    expect(await getProviderApiKeys()).not.toHaveProperty('backendAccessToken');
  });
});
