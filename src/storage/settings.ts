import type { ExtensionSettings, ProviderApiKeys } from '@/types';
import { z } from 'zod';

export const SETTINGS_STORAGE_KEY = 'comment-link-assistant.settings';
export const PROVIDER_API_KEYS_STORAGE_KEY =
  'comment-link-assistant.provider-api-keys';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  provider: 'deepseek',
  websiteUrl: '',
  displayName: '',
  email: '',
  linkMode: 'prefer-website-field',
};

export const DEFAULT_PROVIDER_API_KEYS: ProviderApiKeys = {
  deepseekApiKey: '',
  kieApiKey: '',
};

const httpUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    );
  }, 'URL must use http or https')
  .transform((value) => value.replace(/\/+$/, ''));

const optionalHttpUrlSchema = z.union([
  z.string().trim().length(0),
  httpUrlSchema,
]);

const optionalEmailSchema = z
  .string()
  .trim()
  .max(320)
  .refine(
    (value) => value === '' || z.string().email().safeParse(value).success,
    'Invalid email address'
  );

export const extensionSettingsSchema = z.object({
  provider: z.enum(['deepseek', 'kie-gemini']),
  websiteUrl: optionalHttpUrlSchema,
  displayName: z.string().trim().max(200),
  email: optionalEmailSchema,
  linkMode: z.enum(['prefer-website-field', 'inline']),
});

const providerApiKeysSchema = z.object({
  deepseekApiKey: z.string().trim().max(4_096),
  kieApiKey: z.string().trim().max(4_096),
});

export async function restrictStorageToTrustedContexts(): Promise<void> {
  await Promise.all([
    chrome.storage.local.setAccessLevel({
      accessLevel: 'TRUSTED_CONTEXTS',
    }),
    chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_CONTEXTS',
    }),
  ]);
}

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  const parsed = extensionSettingsSchema.safeParse(
    stored[SETTINGS_STORAGE_KEY]
  );
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
}

export async function setSettings(
  settings: ExtensionSettings
): Promise<ExtensionSettings> {
  const parsed = extensionSettingsSchema.parse(settings);
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: parsed });
  return parsed;
}

export async function getProviderApiKeys(): Promise<ProviderApiKeys> {
  const stored = await chrome.storage.local.get(PROVIDER_API_KEYS_STORAGE_KEY);
  const parsed = providerApiKeysSchema.safeParse(
    stored[PROVIDER_API_KEYS_STORAGE_KEY]
  );
  return parsed.success ? parsed.data : { ...DEFAULT_PROVIDER_API_KEYS };
}

export async function setProviderApiKeys(
  keys: ProviderApiKeys
): Promise<ProviderApiKeys> {
  const parsed = providerApiKeysSchema.parse(keys);
  await chrome.storage.local.set({
    [PROVIDER_API_KEYS_STORAGE_KEY]: parsed,
  });
  return parsed;
}
