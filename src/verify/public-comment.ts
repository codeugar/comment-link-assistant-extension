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
// An anonymous read is a whole page held in memory inside the service worker.
// Past a few megabytes the response is not a comment thread any more.
const MAX_READ_CHARS = 4_000_000;
const COMMENT_NODE_ID = /id=["']?(?:div-)?comment-(\d+)/gi;
const ANCHOR_HREF =
  /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
// Where a comment list ends on a WordPress page: the reply form, or the page
// furniture that follows it.
const COMMENT_LIST_END_MARKERS = [
  'id="respond"',
  "id='respond'",
  'class="comment-respond"',
  "class='comment-respond'",
  'id="commentform"',
  "id='commentform'",
  '<footer',
  '</main>',
];

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

/** The author byline's URL, which WordPress renders as a link on the comment's
 *  display name whenever the commenter filled in the website field. */
function isPromotedAuthorUrl(
  authorUrl: unknown,
  websiteUrl: string,
  base: string
): boolean {
  if (typeof authorUrl !== 'string' || !authorUrl.trim()) return false;
  const expected = comparableUrl(websiteUrl);
  return Boolean(expected) && comparableUrl(authorUrl, base) === expected;
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
  // The newest comment is usually the last one, so there is no next comment to
  // stop at and the block would otherwise run into the reply form, the sidebar
  // and the footer — where an unrelated link to the promoted site (a "recent
  // comments" widget, for one) would be read as this comment's link.
  for (const marker of COMMENT_LIST_END_MARKERS) {
    const index = html.indexOf(marker, start + 1);
    if (index >= 0 && index < end) end = index;
  }
  return html.slice(start, Math.min(end, start + COMMENT_BLOCK_MAX_CHARS));
}

/** The comments region, or null when the page has no recognizable one. Falling
 *  back to the whole document would let the article's own outbound links stand
 *  in for a comment that was never published. */
function commentsRegion(html: string): string | null {
  for (const marker of COMMENTS_REGION_MARKERS) {
    const index = html.indexOf(marker);
    if (index >= 0) return html.slice(index);
  }
  return null;
}

/**
 * WordPress hands an author a private view of their own held comment through
 * `?unapproved=<id>&moderation-hash=<hash>` — no cookie required, so even this
 * module's session-less read would see it. Reading that URL would prove nothing
 * about the public page, so the parameters are dropped before every request.
 */
function publicPageUrl(value: string): string {
  try {
    const url = new URL(value);
    url.searchParams.delete('unapproved');
    url.searchParams.delete('moderation-hash');
    return url.href;
  } catch {
    return value;
  }
}

interface AnonymousRead {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * One anonymous request, headers and body read under a single deadline. The
 * timeout has to cover the body: a server that answers `200` and then stalls
 * mid-stream would otherwise leave the read pending forever, and this module is
 * awaited inline by the batch runner.
 */
async function readAnonymously(url: string): Promise<AnonymousRead | null> {
  if (typeof fetch !== 'function') return null;
  const controller =
    typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), READ_TIMEOUT_MS)
    : null;
  try {
    const response = await fetch(publicPageUrl(url), {
      // The whole point of this module: no session, no cached copy of a page
      // that was rendered for the author.
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      ...(controller ? { signal: controller.signal } : {}),
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: body.slice(0, MAX_READ_CHARS),
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
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

/**
 * The comment REST route reports the comment id we hold. It answers for the
 * install that serves the origin, which is not necessarily the install that
 * serves the target page (WordPress in a subdirectory, or a different site at
 * the root), so the returned `link` has to point back at our page before the
 * verdict may be trusted.
 */
function restCommentBelongsToPage(link: unknown, pageUrl: string): boolean {
  if (typeof link !== 'string' || !link) return false;
  const commentPage = comparableUrl(link.replace(/#.*$/, ''), pageUrl);
  const expected = comparableUrl(publicPageUrl(pageUrl));
  if (!commentPage || !expected) return false;
  // Paginated comment pages hang a /comment-page-N/ segment off the permalink,
  // and either side may be the one carrying it.
  return (
    commentPage === expected ||
    commentPage.startsWith(`${expected}/`) ||
    expected.startsWith(`${commentPage}/`)
  );
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
  const payload = parseJson(response.body);
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
    link?: unknown;
    author_url?: unknown;
    content?: { rendered?: unknown };
  };
  if (!restCommentBelongsToPage(record.link, query.pageUrl)) return null;
  if (typeof record.status === 'string' && record.status !== 'approved') {
    return check('not_visible', 'wp_rest', 'PUBLIC_COMMENT_REST_NOT_APPROVED');
  }
  const rendered =
    typeof record.content?.rendered === 'string' ? record.content.rendered : '';
  // The promoted link lives in the comment body or on the author byline,
  // depending on the site's link mode. Either surface counts: both are a live
  // link to the promoted site rendered inside this comment.
  const linked =
    containsPromotedLink(rendered, query.websiteUrl, query.pageUrl) ||
    isPromotedAuthorUrl(record.author_url, query.websiteUrl, query.pageUrl);
  return linked
    ? check('visible', 'wp_rest', 'PUBLIC_COMMENT_REST_VISIBLE')
    : check('link_stripped', 'wp_rest', 'PUBLIC_COMMENT_REST_LINK_STRIPPED');
}

async function checkViaHtml(
  query: PublicCommentQuery
): Promise<PublicCommentCheck | null> {
  const response = await readAnonymously(query.pageUrl);
  if (!response?.ok) return null;
  const html = response.body;
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
  // site inside the comments region is this comment. Outside that region the
  // page's own links prove nothing, so an unrecognizable page decides nothing.
  const region = commentsRegion(html);
  if (region === null) {
    return check('inconclusive', 'html', 'PUBLIC_COMMENT_HTML_NO_REGION');
  }
  return containsPromotedLink(region, query.websiteUrl, query.pageUrl)
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
