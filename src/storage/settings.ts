import type { BatchSettingsSnapshot } from '@/batch/types';
import type {
  CommentProvider,
  ExtensionSettings,
  ProviderApiKeys,
  SiteProfile,
} from '@/types';
import { UI_LOCALES } from '@/types';
import { z } from 'zod';

export const SETTINGS_STORAGE_KEY = 'comment-link-assistant.settings';
export const PROVIDER_API_KEYS_STORAGE_KEY =
  'comment-link-assistant.provider-api-keys';
export const DEFAULT_UI_LOCALE = 'zh-CN' as const;

const DEFAULT_SITE_ID = 'site-1';

function createDefaultSite(): SiteProfile {
  return {
    id: DEFAULT_SITE_ID,
    label: '',
    websiteUrl: '',
    displayName: '',
    email: '',
    linkMode: 'a-tag-newline',
  };
}

export function createDefaultSettings(): ExtensionSettings {
  return {
    provider: 'deepseek',
    sites: [createDefaultSite()],
    activeSiteId: DEFAULT_SITE_ID,
    locale: DEFAULT_UI_LOCALE,
  };
}

export const DEFAULT_SETTINGS: ExtensionSettings = createDefaultSettings();

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

const siteProfileSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    label: z.string().trim().max(100),
    websiteUrl: optionalHttpUrlSchema,
    displayName: z.string().trim().max(200),
    email: optionalEmailSchema,
    linkMode: z.enum([
      'a-tag-newline',
      'prefer-website-field',
      'comment-only',
      'inline',
    ]),
  })
  .strict();

export const extensionSettingsSchema = z
  .object({
    provider: z.enum(['deepseek', 'kie-gemini']),
    sites: z.array(siteProfileSchema).min(1).max(20),
    activeSiteId: z.string().trim().min(1).max(200),
    locale: z.enum(UI_LOCALES).default(DEFAULT_UI_LOCALE),
  })
  .superRefine((settings, context) => {
    if (!settings.sites.some((site) => site.id === settings.activeSiteId)) {
      context.addIssue({
        code: 'custom',
        message: 'activeSiteId must reference an existing site',
        path: ['activeSiteId'],
      });
    }
  });

function hostnameLabel(websiteUrl: string): string {
  const trimmed = websiteUrl.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function normalizeLegacyLinkModes(
  settings: ExtensionSettings
): ExtensionSettings {
  let changed = false;
  const sites = settings.sites.map((site) => {
    if (site.linkMode !== 'inline') return site;
    changed = true;
    return { ...site, linkMode: 'a-tag-newline' as const };
  });
  return changed ? { ...settings, sites } : settings;
}

// Turns the pre-multi-site flat settings shape ({provider, websiteUrl, ...})
// into a one-site configuration. Mirrors addLegacyItemEvents in storage/batch.ts.
function migrateLegacySettings(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const legacy = value as Record<string, unknown>;
  if (Object.hasOwn(legacy, 'sites') || !Object.hasOwn(legacy, 'websiteUrl')) {
    return value;
  }
  const websiteUrl =
    typeof legacy.websiteUrl === 'string' ? legacy.websiteUrl : '';
  return {
    provider: legacy.provider,
    sites: [
      {
        id: DEFAULT_SITE_ID,
        label: hostnameLabel(websiteUrl),
        websiteUrl,
        displayName:
          typeof legacy.displayName === 'string' ? legacy.displayName : '',
        email: typeof legacy.email === 'string' ? legacy.email : '',
        linkMode: legacy.linkMode,
      },
    ],
    activeSiteId: DEFAULT_SITE_ID,
  };
}

export function getActiveSite(settings: ExtensionSettings): SiteProfile {
  return (
    settings.sites.find((site) => site.id === settings.activeSiteId) ??
    settings.sites[0] ??
    createDefaultSite()
  );
}

export function buildBatchSettingsSnapshot(
  provider: CommentProvider,
  site: SiteProfile
): BatchSettingsSnapshot {
  return {
    provider,
    websiteUrl: site.websiteUrl,
    displayName: site.displayName,
    email: site.email,
    linkMode: site.linkMode,
    siteId: site.id,
    siteLabel: site.label,
  };
}

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
  const value = stored[SETTINGS_STORAGE_KEY];
  const parsed = extensionSettingsSchema.safeParse(value);
  if (parsed.success) {
    const normalized = normalizeLegacyLinkModes(parsed.data);
    if (
      normalized !== parsed.data ||
      !value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, 'locale')
    ) {
      await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized });
    }
    return normalized;
  }

  const migrated = migrateLegacySettings(value);
  if (migrated !== value) {
    const remigrated = extensionSettingsSchema.safeParse(migrated);
    if (remigrated.success) {
      const normalized = normalizeLegacyLinkModes(remigrated.data);
      await chrome.storage.local.set({
        [SETTINGS_STORAGE_KEY]: normalized,
      });
      return normalized;
    }
  }
  return createDefaultSettings();
}

export async function setSettings(
  settings: ExtensionSettings
): Promise<ExtensionSettings> {
  const parsed = extensionSettingsSchema.parse(settings);
  const normalized = normalizeLegacyLinkModes(parsed);
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: normalized });
  return normalized;
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
