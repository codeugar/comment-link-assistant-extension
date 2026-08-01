import { hasWordPressModerationReceipt } from './receipts';
import type {
  LinkFollowStatus,
  LinkFollowSurface,
  LinkFollowVerification,
  PageSubmissionResult,
} from './types';

export interface LinkFollowOptions {
  targetUrl: string;
  fingerprint: string;
}

const COMMENT_ANCHOR = /^#comment-(\d+)$/i;
const COMMENT_CONTAINER_SELECTOR = [
  '[class*="comment"]',
  '[id*="comment"]',
  '[class*="reply"]',
  '[id*="reply"]',
].join(', ');
const AUTHOR_SURFACE_SELECTOR = [
  '.comment-author',
  '.url',
  '[class*="author"]',
  '[rel="author"]',
].join(', ');
const BODY_SURFACE_SELECTOR = [
  '.comment-content',
  '.comment-body',
  '.comment-text',
  '.comment-content-wrap',
].join(', ');

export function extractPromotedUrl(comment: string): string | null {
  const match = comment.match(/<a\s+href=(["'])([\s\S]*?)\1/i);
  const href = match?.[2]?.replace(/[\r\n\t ]+$/, '') ?? '';
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

export function verifyLinkFollow(
  document: Document,
  options: LinkFollowOptions
): LinkFollowVerification {
  const href = document.location?.href;
  if (href) {
    try {
      if (hasWordPressModerationReceipt(new URL(href))) {
        return pendingModeration();
      }
    } catch {
      // Fall through to DOM scan.
    }
  }

  const container = findCommentContainer(document, options.fingerprint);
  if (!container) {
    return notFound();
  }

  let bodyMatch: LinkFollowVerification | null = null;
  for (const anchor of container.querySelectorAll('a[href]')) {
    const anchorHref = anchor.getAttribute('href') ?? '';
    if (!hrefMatchesTarget(anchorHref, options.targetUrl)) continue;
    const rel = anchor.getAttribute('rel') ?? '';
    const verification: LinkFollowVerification = {
      status: classifyRel(rel),
      rel: rel || null,
      href: anchorHref,
      surface: linkSurface(anchor),
    };
    if (verification.surface === 'comment_body') return verification;
    bodyMatch ??= verification;
  }

  return bodyMatch ?? linkStripped();
}

function pendingModeration(): LinkFollowVerification {
  return {
    status: 'pending_moderation',
    rel: null,
    href: null,
    surface: 'unknown',
  };
}

function notFound(): LinkFollowVerification {
  return {
    status: 'not_found',
    rel: null,
    href: null,
    surface: 'unknown',
  };
}

function linkStripped(): LinkFollowVerification {
  return {
    status: 'link_stripped',
    rel: null,
    href: null,
    surface: 'comment_body',
  };
}

function classifyRel(
  rel: string
): Exclude<
  LinkFollowStatus,
  'link_stripped' | 'pending_moderation' | 'not_found'
> {
  const tokens = rel.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.includes('nofollow')) return 'nofollow';
  if (tokens.includes('ugc')) return 'ugc';
  return 'dofollow';
}

function hrefMatchesTarget(href: string, targetUrl: string): boolean {
  const normalizedHref = href.trim().replace(/[\r\n\t ]+/g, '');
  try {
    const url = new URL(normalizedHref, targetUrl);
    const target = new URL(targetUrl);
    return (
      comparableHostname(url.hostname) === comparableHostname(target.hostname)
    );
  } catch {
    return normalizedHref.includes(
      comparableHostname(new URL(targetUrl).hostname)
    );
  }
}

function comparableHostname(hostname: string): string {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

function linkSurface(anchor: Element): LinkFollowSurface {
  if (anchor.closest(BODY_SURFACE_SELECTOR)) return 'comment_body';
  if (anchor.closest(AUTHOR_SURFACE_SELECTOR)) return 'author_url';
  return 'unknown';
}

function findCommentContainer(
  document: Document,
  fingerprint: string
): Element | null {
  const hashMatch = document.location.hash.match(COMMENT_ANCHOR);
  if (hashMatch) {
    const byId = document.getElementById(`comment-${hashMatch[1]}`);
    if (byId) return byId;
  }

  if (!fingerprint.trim()) return null;
  for (const candidate of document.querySelectorAll(
    COMMENT_CONTAINER_SELECTOR
  )) {
    if (
      candidate.matches('form, textarea, input, [contenteditable="true"]') ||
      candidate.querySelector('form, textarea, input, [contenteditable="true"]')
    ) {
      continue;
    }
    const text = normalizeWhitespace(candidate.textContent ?? '');
    if (text.includes(normalizeWhitespace(fingerprint))) {
      return candidate;
    }
  }
  return null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function attachLinkFollow(
  result: PageSubmissionResult,
  document: Document,
  targetUrl?: string,
  fingerprint?: string
): PageSubmissionResult {
  if (result.status !== 'submitted' || !targetUrl || !fingerprint) {
    return result;
  }
  return {
    ...result,
    linkFollow: verifyLinkFollow(document, { targetUrl, fingerprint }),
  };
}

export { attachLinkFollow };
