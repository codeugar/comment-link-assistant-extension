import type { LinkMode, SiteProfile } from '@/types';
import { normalizeWebsiteUrl } from '@/website/profile';
import { z } from 'zod';

export interface PromotingSiteFormValues {
  label: string;
  websiteUrl: string;
  displayName: string;
  email: string;
  linkMode: LinkMode;
}

export type PromotingSiteField = keyof PromotingSiteFormValues;

export interface PromotingSiteValidation {
  fieldErrors: Partial<Record<PromotingSiteField, string>>;
  formError?: 'SITE_LIMIT' | 'SITE_DUPLICATE';
  site?: SiteProfile;
}

const CREATEABLE_LINK_MODES = new Set<LinkMode>([
  'a-tag-newline',
  'prefer-website-field',
  'comment-only',
]);

function createSiteId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `site-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}

function normalizePromotingSiteUrl(value: string): string {
  const normalized = normalizeWebsiteUrl(value);
  const url = new URL(normalized);
  url.protocol = 'https:';
  const canonical = url.toString();
  return url.pathname === '/' && !url.search
    ? canonical.replace(/\/$/, '')
    : canonical;
}

export function validatePromotingSiteInput(
  values: PromotingSiteFormValues,
  existingSites: readonly SiteProfile[],
  id = createSiteId()
): PromotingSiteValidation {
  const fieldErrors: Partial<Record<PromotingSiteField, string>> = {};
  const label = values.label.trim();
  const websiteInput = values.websiteUrl.trim();
  const displayName = values.displayName.trim();
  const email = values.email.trim();

  if (!label) fieldErrors.label = 'SITE_NAME_REQUIRED';
  else if (label.length > 100) fieldErrors.label = 'SITE_NAME_TOO_LONG';

  if (!websiteInput) {
    fieldErrors.websiteUrl = 'SITE_URL_REQUIRED';
  }

  let websiteUrl = '';
  if (websiteInput) {
    try {
      websiteUrl = normalizePromotingSiteUrl(websiteInput);
    } catch {
      fieldErrors.websiteUrl = 'SITE_URL_INVALID';
    }
  }

  if (
    email &&
    (!z.string().max(320).safeParse(email).success ||
      !z.string().email().safeParse(email).success)
  ) {
    fieldErrors.email = 'SITE_EMAIL_INVALID';
  }

  if (!CREATEABLE_LINK_MODES.has(values.linkMode)) {
    fieldErrors.linkMode = 'SITE_LINK_MODE_INVALID';
  }

  if (Object.keys(fieldErrors).length > 0) return { fieldErrors };
  if (existingSites.length >= 20) {
    return { fieldErrors, formError: 'SITE_LIMIT' };
  }

  const duplicate = existingSites.some((site) => {
    try {
      return normalizePromotingSiteUrl(site.websiteUrl) === websiteUrl;
    } catch {
      return false;
    }
  });
  if (duplicate) return { fieldErrors, formError: 'SITE_DUPLICATE' };

  return {
    fieldErrors,
    site: {
      id,
      label,
      websiteUrl,
      displayName,
      email,
      linkMode: values.linkMode,
    },
  };
}
