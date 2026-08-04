export const COMMENT_PROVIDERS = ['deepseek', 'kie-gemini'] as const;

export type CommentProvider = (typeof COMMENT_PROVIDERS)[number];

export const UI_LOCALES = ['zh-CN', 'en'] as const;

export type UiLocale = (typeof UI_LOCALES)[number];

export const LINK_MODES = [
  'a-tag-newline',
  'prefer-website-field',
  'comment-only',
  // Kept solely to read settings and batches written by earlier releases.
  'inline',
] as const;

export type LinkMode = (typeof LINK_MODES)[number];

export function usesInlineAnchor(linkMode: LinkMode): boolean {
  return linkMode === 'a-tag-newline' || linkMode === 'inline';
}

export interface SiteProfile {
  id: string;
  label: string;
  websiteUrl: string;
  displayName: string;
  email: string;
  linkMode: LinkMode;
}

export interface ExtensionSettings {
  provider: CommentProvider;
  sites: SiteProfile[];
  activeSiteId: string;
  /** Persisted UI language. Missing values from older settings default to zh-CN. */
  locale?: UiLocale;
}

export interface ProviderApiKeys {
  deepseekApiKey: string;
  kieApiKey: string;
}
