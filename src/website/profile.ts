import { decodeHtmlEntities, readHtmlAttributes } from '@/html';

export interface WebsiteProfile {
  url: string;
  title: string;
  description: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_HTML_LENGTH = 1_000_000;

function readMetaContent(html: string, keys: string[]): string {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = readHtmlAttributes(match[0]);
    const key = (attributes.name ?? attributes.property ?? '').toLowerCase();
    if (wanted.has(key) && attributes.content?.trim()) {
      return attributes.content.trim();
    }
  }
  return '';
}

function readTitle(html: string): string {
  const metaTitle = readMetaContent(html, ['og:title', 'twitter:title']);
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return decodeHtmlEntities(titleMatch?.[1] ?? '') || metaTitle;
}

export function extractWebsiteProfile(
  html: string,
  url: string
): WebsiteProfile {
  const head = html.slice(0, MAX_HTML_LENGTH);
  return {
    url,
    title: readTitle(head).slice(0, 500),
    description: readMetaContent(head, [
      'description',
      'og:description',
      'twitter:description',
    ]).slice(0, 2_000),
  };
}

export function normalizeWebsiteUrl(value: string): string {
  const trimmed = value.trim();
  const withProtocol = /^https?:/i.test(trimmed)
    ? trimmed.replace(/^(https?):\/{0,2}/i, '$1://')
    : `https://${trimmed}`;
  const url = new URL(withProtocol);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WEBSITE_URL_INVALID');
  }
  if (url.username || url.password) throw new Error('WEBSITE_URL_INVALID');
  url.hash = '';
  return url.toString();
}

export function originPermissionPattern(value: string): string {
  const url = new URL(normalizeWebsiteUrl(value));
  return `${url.protocol}//${url.host}/*`;
}

export async function fetchWebsiteProfile(
  value: string,
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<WebsiteProfile> {
  const url = normalizeWebsiteUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) {
      throw new Error(`WEBSITE_FETCH_FAILED_${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (
      contentType &&
      !/text\/html|application\/xhtml\+xml/i.test(contentType)
    ) {
      throw new Error('WEBSITE_RESPONSE_NOT_HTML');
    }
    const finalUrl = normalizeWebsiteUrl(response.url || url);
    if (!isSafeWebsiteRedirect(url, finalUrl)) {
      throw new Error('WEBSITE_REDIRECT_UNSUPPORTED');
    }
    const profile = extractWebsiteProfile(await response.text(), finalUrl);
    if (!profile.title || !profile.description) {
      throw new Error('WEBSITE_META_NOT_FOUND');
    }
    return profile;
  } finally {
    clearTimeout(timeout);
  }
}

export function isSafeWebsiteRedirect(
  sourceValue: string,
  targetValue: string
): boolean {
  try {
    const source = new URL(sourceValue);
    const target = new URL(targetValue);
    const hostname = (value: string) => value.replace(/^www\./i, '');
    return (
      (source.protocol === target.protocol ||
        (source.protocol === 'http:' && target.protocol === 'https:')) &&
      hostname(source.hostname) === hostname(target.hostname) &&
      source.port === target.port &&
      source.username === target.username &&
      source.password === target.password
    );
  } catch {
    return false;
  }
}
