/**
 * Reads a comment the way a stranger reads it.
 *
 * Everything the submitting tab can observe is contaminated: WordPress renders
 * a held comment to its own author (and to anyone carrying the author cookie),
 * so "I can see it" proves acceptance, never publication. The only evidence
 * that a comment is public is a request that carries no session at all — no
 * cookies, no cache — asking the site for the comment and finding the promoted
 * link inside it.
 *
 * Three reads, in order of exactness:
 *   1. `wp-json/wp/v2/comments/<id>` — the public REST route only ever returns
 *      approved comments, so a 404 is a decisive "no visitor sees this".
 *   2. the page HTML, sliced down to the comment node with that id.
 *   3. the page HTML's comments region, when no id was ever captured.
 *
 * A read that cannot be completed is `inconclusive`, never `not_visible`:
 * "could not check" is not a verdict, and callers must keep such an item
 * queued instead of writing a state from it.
 */

const READ_TIMEOUT_MS = 15_000;
// A comment node plus its markup; enough to slice one comment out of a page
// with hundreds without materializing the neighbours.
const COMMENT_BLOCK_MAX_CHARS = 20_000;
const COMMENT_NODE_ID = /id=["']?(?:div-)?comment-(\d+)/gi;
const ANCHOR_HREF =
  /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const COMMENTS_REGION_MARKERS = [
  'id="comments"',
  "id='comments'",
  'class="comment-list"',
  "class='comment-list'",
  'id="comment-list"',
  'commentlist',
];

export type PublicCommentVisibility =
  /** The comment is public and the promoted link is inside it. */
  | 'visible'
  /** The comment is public, but its link is gone. */
  | 'link_stripped'
  /** The site answered, and no visitor can see this comment. */
  | 'not_visible'
  /** The site could not be read. Not a verdict. */
  | 'inconclusive';

export type PublicCommentMethod = 'wp_rest' | 'html' | 'none';

export interface PublicCommentQuery {
  /** Page to read. A receipt URL is preferred: WordPress resolves it to the
   *  right comment page by itself. */
  pageUrl: string;
  /** The promoted site the comment is supposed to link to. */
  websiteUrl: string;
  /** Server-assigned comment id, when the submit receipt carried one. */
  commentId?: string;
}

export interface PublicCommentCheck {
  visibility: PublicCommentVisibility;
  method: PublicCommentMethod;
  message: string;
  checkedAt: number;
}

function check(
  visibility: PublicCommentVisibility,
  method: PublicCommentMethod,
  message: string
): PublicCommentCheck {
  return { visibility, method, message, checkedAt: Date.now() };
}

/** Compares hosts and paths only: a link is the same link whether the site
 *  renders it http/https, with or without `www`, with or without a trailing
 *  slash — and WordPress rewrites all of those. */
function comparableUrl(value: string, base?: string): string | null {
  let url: URL;
  try {
    url = base ? new URL(value.trim(), base) : new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.host.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '');
  return `${host}${path}`;
}

function containsPromotedLink(
  html: string,
  websiteUrl: string,
  base: string
): boolean {
  const expected = comparableUrl(websiteUrl);
  if (!expected) return false;
  for (const match of html.matchAll(ANCHOR_HREF)) {
    const href = match[1] ?? match[2] ?? match[3] ?? '';
    // A generated link can carry a trailing newline inside the attribute; the
    // URL parser drops it, and so must the comparison.
    if (comparableUrl(href, base) === expected) return true;
  }
  return false;
}

/** The markup of one comment node, or null when the page does not contain it.
 *  The block ends at the next *different* comment: WordPress stamps the same id
 *  on both the list item and its inner body (`comment-9` / `div-comment-9`), and
 *  stopping at that inner div would cut the comment text away. */
function commentBlock(html: string, commentId: string): string | null {
  const anchor = new RegExp(`id=["']?(?:div-)?comment-${commentId}\\b`, 'i');
  const start = html.search(anchor);
  if (start < 0) return null;
  const boundary = new RegExp(COMMENT_NODE_ID.source, 'gi');
  boundary.lastIndex = start + 1;
  let end = html.length;
  for (let match = boundary.exec(html); match; match = boundary.exec(html)) {
    if (match[1] === commentId) continue;
    end = match.index;
    break;
  }
  return html.slice(start, Math.min(end, start + COMMENT_BLOCK_MAX_CHARS));
}

function commentsRegion(html: string): string {
  for (const marker of COMMENTS_REGION_MARKERS) {
    const index = html.indexOf(marker);
    if (index >= 0) return html.slice(index);
  }
  return html;
}

async function readAnonymously(url: string): Promise<Response | null> {
  if (typeof fetch !== 'function') return null;
  const controller =
    typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), READ_TIMEOUT_MS)
    : null;
  try {
    return await fetch(url, {
      // The whole point of this module: no session, no cached copy of a page
      // that was rendered for the author.
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function restCommentEndpoint(
  pageUrl: string,
  commentId: string
): string | null {
  try {
    const url = new URL(pageUrl);
    return `${url.origin}/wp-json/wp/v2/comments/${commentId}`;
  } catch {
    return null;
  }
}

/** Returns null when this route cannot decide, so the caller falls through to
 *  reading the page itself. */
async function checkViaRest(
  query: PublicCommentQuery
): Promise<PublicCommentCheck | null> {
  if (!query.commentId) return null;
  const endpoint = restCommentEndpoint(query.pageUrl, query.commentId);
  if (!endpoint) return null;
  const response = await readAnonymously(endpoint);
  if (!response) return null;
  const payload = await readJson(response);
  const code =
    payload && typeof payload === 'object' && 'code' in payload
      ? String((payload as { code: unknown }).code)
      : '';
  if (!response.ok) {
    // Only WordPress's own comment errors decide anything. A security plugin
    // that walls off the whole REST API answers 401 for every id, published or
    // not (`itsec_rest_api_access_restricted` is one such), so anything that is
    // not a comment-route error falls through to reading the page.
    if (code.startsWith('rest_comment')) {
      return check(
        'not_visible',
        'wp_rest',
        'PUBLIC_COMMENT_REST_NOT_APPROVED'
      );
    }
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as {
    status?: unknown;
    content?: { rendered?: unknown };
  };
  if (typeof record.status === 'string' && record.status !== 'approved') {
    return check('not_visible', 'wp_rest', 'PUBLIC_COMMENT_REST_NOT_APPROVED');
  }
  const rendered =
    typeof record.content?.rendered === 'string' ? record.content.rendered : '';
  return containsPromotedLink(rendered, query.websiteUrl, query.pageUrl)
    ? check('visible', 'wp_rest', 'PUBLIC_COMMENT_REST_VISIBLE')
    : check('link_stripped', 'wp_rest', 'PUBLIC_COMMENT_REST_LINK_STRIPPED');
}

async function checkViaHtml(
  query: PublicCommentQuery
): Promise<PublicCommentCheck | null> {
  const response = await readAnonymously(query.pageUrl);
  if (!response?.ok) return null;
  let html: string;
  try {
    html = await response.text();
  } catch {
    return null;
  }
  if (query.commentId) {
    const block = commentBlock(html, query.commentId);
    if (!block) {
      return check('not_visible', 'html', 'PUBLIC_COMMENT_HTML_NOT_FOUND');
    }
    return containsPromotedLink(block, query.websiteUrl, query.pageUrl)
      ? check('visible', 'html', 'PUBLIC_COMMENT_HTML_VISIBLE')
      : check('link_stripped', 'html', 'PUBLIC_COMMENT_HTML_LINK_STRIPPED');
  }
  // Without an id the promoted link itself is the handle. One comment per page
  // per promoted site is the rule this extension follows, so a link to that
  // site inside the comments region is this comment.
  return containsPromotedLink(
    commentsRegion(html),
    query.websiteUrl,
    query.pageUrl
  )
    ? check('visible', 'html', 'PUBLIC_COMMENT_HTML_VISIBLE')
    : check('not_visible', 'html', 'PUBLIC_COMMENT_HTML_NOT_FOUND');
}

export async function checkPublicComment(
  query: PublicCommentQuery
): Promise<PublicCommentCheck> {
  if (!query.pageUrl || !query.websiteUrl) {
    return check('inconclusive', 'none', 'PUBLIC_COMMENT_QUERY_INCOMPLETE');
  }
  const rest = await checkViaRest(query);
  if (rest) return rest;
  const html = await checkViaHtml(query);
  if (html) return html;
  return check('inconclusive', 'none', 'PUBLIC_COMMENT_CHECK_UNAVAILABLE');
}
