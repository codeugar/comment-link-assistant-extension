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

// True when the current URL alone proves the comment was accepted: same origin,
// on the expected permalink (or its comment-page variant), carrying either the
// moderation receipt or a newly added `#comment-<id>` anchor.
export function hasWordPressSubmitReceipt(
  currentValue: string,
  expectedValue: string
): boolean {
  let current: URL;
  let expected: URL;
  try {
    current = new URL(currentValue);
    expected = new URL(expectedValue);
  } catch {
    return false;
  }
  if (current.origin !== expected.origin) return false;
  if (!matchesWordPressCommentPathname(current.pathname, expected.pathname)) {
    return false;
  }
  return (
    hasWordPressModerationReceipt(current) ||
    hasNewWordPressCommentAnchor(current, expected)
  );
}
