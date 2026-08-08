// WordPress redirect receipts after `wp-comments-post.php`: deterministic,
// language-proof evidence that a comment was accepted, readable from the URL
// alone. This module is dependency-free on purpose — it is shared by the
// background (runtime/page-commands.ts) and the content script (page/command.ts).
//
// - Approved comment: redirect to `<permalink>#comment-<id>`.
// - Held for moderation: redirect to `?unapproved=<id>&moderation-hash=<hash>`.
// - Blogs with paginated comments insert `/comment-page-<n>/` into the
//   permalink pathname on both redirect shapes.

const COMMENT_ANCHOR = /^#comment-\d+$/i;
const COMMENT_PAGE_SUFFIX = /^\/comment-page-\d+$/i;

export type WordPressSubmitReceipt = 'published' | 'pending_moderation';

function comparablePathname(pathname: string): string {
  return pathname === '/' ? pathname : pathname.replace(/\/+$/, '');
}

// The expected permalink pathname, or its `/comment-page-<n>/` variant.
export function matchesWordPressCommentPathname(
  currentPathname: string,
  expectedPathname: string
): boolean {
  const current = comparablePathname(currentPathname);
  const expected = comparablePathname(expectedPathname);
  if (current === expected) return true;
  const base = expected === '/' ? '' : expected;
  return (
    current.startsWith(base) &&
    COMMENT_PAGE_SUFFIX.test(current.slice(base.length))
  );
}

export function hasWordPressModerationReceipt(url: URL): boolean {
  return (
    url.searchParams.has('unapproved') &&
    url.searchParams.has('moderation-hash')
  );
}

export function hasNewWordPressCommentAnchor(
  currentUrl: URL,
  expectedUrl: URL
): boolean {
  return (
    !COMMENT_ANCHOR.test(expectedUrl.hash) &&
    COMMENT_ANCHOR.test(currentUrl.hash)
  );
}

// Identifies the specific result proved by a WordPress redirect. Keeping the
// receipt type instead of reducing it to a boolean lets callers distinguish a
// publicly rendered comment from one the site accepted for moderation.
export function getWordPressSubmitReceipt(
  currentValue: string,
  expectedValue: string
): WordPressSubmitReceipt | null {
  let current: URL;
  let expected: URL;
  try {
    current = new URL(currentValue);
    expected = new URL(expectedValue);
  } catch {
    return null;
  }
  if (current.origin !== expected.origin) return null;
  if (!matchesWordPressCommentPathname(current.pathname, expected.pathname)) {
    return null;
  }
  if (hasWordPressModerationReceipt(current)) return 'pending_moderation';
  if (hasNewWordPressCommentAnchor(current, expected)) return 'published';
  return null;
}

/** A receipt plus the two things a later anonymous re-read needs: the page to
 *  read, and the id the server gave the comment. */
export interface WordPressReceipt {
  type: WordPressSubmitReceipt;
  url: string;
  commentId?: string;
}

const NUMERIC_COMMENT_ID = /^\d+$/;

function readCommentId(url: URL, type: WordPressSubmitReceipt): string | null {
  const raw =
    type === 'pending_moderation'
      ? (url.searchParams.get('unapproved') ?? '')
      : url.hash.replace(/^#comment-/i, '');
  return NUMERIC_COMMENT_ID.test(raw) ? raw : null;
}

/**
 * The receipt with its comment id, when the redirect carried one. A receipt
 * whose id is not a plain number is kept id-less rather than guessed at: a
 * wrong id would address someone else's comment on the re-read.
 */
export function readWordPressSubmitReceipt(
  currentValue: string,
  expectedValue: string
): WordPressReceipt | null {
  const type = getWordPressSubmitReceipt(currentValue, expectedValue);
  if (!type) return null;
  let current: URL;
  try {
    current = new URL(currentValue);
  } catch {
    return null;
  }
  const commentId = readCommentId(current, type);
  return {
    type,
    url: currentValue,
    ...(commentId ? { commentId } : {}),
  };
}

// True when the current URL alone proves the comment was accepted: same origin,
// on the expected permalink (or its comment-page variant), carrying either the
// moderation receipt or a newly added `#comment-<id>` anchor.
export function hasWordPressSubmitReceipt(
  currentValue: string,
  expectedValue: string
): boolean {
  return getWordPressSubmitReceipt(currentValue, expectedValue) !== null;
}
