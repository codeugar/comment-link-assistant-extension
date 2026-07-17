import {
  normalizeWebsiteUrl,
  originPermissionPattern,
} from '@/website/profile';

// Jetpack-comments blogs render their form inside a jetpack.wordpress.com frame.
// Bundle its origin into every batch request/check so the frame is scriptable,
// prompted once alongside the target-site permissions rather than mid-run.
const JETPACK_COMMENT_ORIGIN = 'https://jetpack.wordpress.com/*';

export async function requestOriginPermissions(
  urls: string[]
): Promise<boolean> {
  const origins = permissionOrigins(urls);
  if (origins.length === 0) return true;
  return chrome.permissions.request({ origins });
}

export async function hasOriginPermissions(urls: string[]): Promise<boolean> {
  const origins = permissionOrigins(urls);
  return origins.length === 0 || chrome.permissions.contains({ origins });
}

export async function requestBatchOriginPermissions(
  targetUrls: string[]
): Promise<boolean> {
  const origins = batchPermissionOrigins(targetUrls);
  if (origins.length === 0) return true;
  return chrome.permissions.request({ origins });
}

export async function hasBatchOriginPermissions(
  targetUrls: string[]
): Promise<boolean> {
  const origins = batchPermissionOrigins(targetUrls);
  return origins.length === 0 || chrome.permissions.contains({ origins });
}

function permissionOrigins(urls: string[]): string[] {
  return Array.from(new Set(urls.filter(Boolean).map(originPermissionPattern)));
}

function batchPermissionOrigins(targetUrls: string[]): string[] {
  return Array.from(
    new Set([
      ...targetUrls.flatMap(targetPermissionOrigins),
      JETPACK_COMMENT_ORIGIN,
    ])
  );
}

function targetPermissionOrigins(value: string): string[] {
  const url = new URL(normalizeWebsiteUrl(value));
  if (isLocalOrIpHostname(url.hostname)) {
    return [originPermissionPattern(value)];
  }

  const protocols =
    url.protocol === 'http:' ? (['http:', 'https:'] as const) : [url.protocol];
  const hostnames = [url.hostname];
  const hostnameVariant = wwwHostnameVariant(url.hostname);
  if (hostnameVariant) hostnames.push(hostnameVariant);

  return hostnames.flatMap((hostname) =>
    protocols.map(
      (protocol) =>
        `${protocol}//${hostname}${url.port ? `:${url.port}` : ''}/*`
    )
  );
}

function wwwHostnameVariant(hostname: string): string | null {
  if (hostname.startsWith('www.')) return hostname.slice(4);
  return hostname.includes('.') ? `www.${hostname}` : null;
}

function isLocalOrIpHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.includes(':') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)
  );
}
