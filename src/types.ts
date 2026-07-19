export const COMMENT_PROVIDERS = ['deepseek', 'kie-gemini'] as const;

export type CommentProvider = (typeof COMMENT_PROVIDERS)[number];

export const LINK_MODES = ['prefer-website-field', 'inline'] as const;

export type LinkMode = (typeof LINK_MODES)[number];

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
}

export interface ProviderApiKeys {
  deepseekApiKey: string;
  kieApiKey: string;
}
