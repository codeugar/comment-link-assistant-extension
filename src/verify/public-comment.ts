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
 * The page comes first, REST second, and only when the page asks for it:
 *   1. One anonymous read of the page itself, parsed as a DOM so the comment
 *      node can be addressed directly instead of sliced out of raw text.
 *   2. Only when that HTML does not decide — the node was never found, or was
 *      found but its body never rendered — and only when a server-assigned
 *      `commentId` exists to ask about: `wp-json/wp/v2/comments/<id>`, at a
 *      root discovered from the page's own `<link rel="https://api.w.org/">`
 *      tag or `Link` response header. A root guessed from the page's origin
 *      can belong to an entirely different WordPress install (a subdirectory
 *      site, or nothing at all), so one is never assumed — an undiscoverable
 *      root simply skips REST rather than asking the wrong site.
 *
 * A read that cannot be completed is `inconclusive`, never `not_visible`:
 * "could not check" is not a verdict, and callers must keep such an item
 * queued instead of writing a state from it.
 */

import { type HTMLElement, parse } from 'node-html-parser';

const READ_TIMEOUT_MS = 15_000;
// An anonymous read is a whole page held in memory inside the service worker.
// Past a few megabytes the response is not a comment thread any more.
const MAX_READ_CHARS = 4_000_000;
// A node's body counts as unrendered below this many normalized characters.
// A comment shell whose body is filled in by JavaScript holds nothing but
// markup; a generated comment clears this by an order of magnitude. Erring
// high only ever costs another re-check, which is the safe direction: the
// alternative is reading an empty shell as a comment whose link was stripped.
const MIN_RENDERED_CHARS = 20;
// wptexturize rewrites quotes and dashes on render, so only a short, stable
// prefix of the stored fingerprint can be expected to survive byte-for-byte
// after normalization.
const FINGERPRINT_MAX_CHARS = 40;

// A "comment node" per WordPress core's `Walker_Comment`: the list item
// (`comment-9`) and its inner body (`div-comment-9`) carry the same numeric
// id, so both ends of the pattern are anchored — a prefix match would treat
// `comment-author-88`, an id themes stamp on elements *inside* a comment, as
// another comment and truncate the one being searched for.
const COMMENT_NODE_ID = /^(?:div-)?comment-(\d+)$/;

const REST_ROOT_REL = 'https://api.w.org/';
const LINK_HEADER_ROOT = /<([^>]+)>\s*;\s*rel="https:\/\/api\.w\.org\/"/;

export type PublicCommentCriterion =
  | { kind: 'link'; websiteUrl: string }
  | { kind: 'comment_only' };

export interface PublicCommentQuery {
  /** Page to read. A receipt URL is preferred: WordPress resolves it to the
   *  right comment page by itself. */
  pageUrl: string;
  /** Server-assigned comment id, when the submit receipt carried one. */
  commentId?: string;
  /** A slice of the submitted comment's own text, used to find it on the page
   *  when no id was ever captured. */
  fingerprint?: string;
  /** What "visible" means for this submission — a bare comment, or one that
   *  must carry the promoted link. */
  criterion: PublicCommentCriterion;
}

export type PublicCommentVisibility =
  /** The comment is public and satisfies the criterion. */
  | 'visible'
  /** The comment is public, but its link is gone. */
  | 'link_stripped'
  /** The site answered, and no visitor can see this comment. */
  | 'not_visible'
  /** The site could not be read, or nothing on the page could be attributed
   *  to this submission. Not a verdict. */
  | 'inconclusive';

export type PublicCommentMethod = 'wp_rest' | 'html' | 'none';

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

/**
 * Decodes entities and folds the result down to bare words: lowercase,
 * `[a-z0-9\s]` only, whitespace collapsed. `wptexturize` turns `'` into
 * `&#8217;` and `--` into `&#8212;` on render, so a byte-for-byte match
 * against the stored text never works — stripping punctuation on both sides
 * is what makes the two comparable at all. Parsing the string is what decodes
 * the entities; the page's own text already arrives decoded this way, so
 * running a plain string through the same step is a harmless no-op.
 */
function normalizeText(raw: string): string {
  return parse(raw)
    .text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
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

/** Whether an `a[href]` inside `container` resolves to `websiteUrl`. Used both
 *  on a comment node parsed from the page and on a REST comment body parsed
 *  on its own. */
function containsPromotedLink(
  container: HTMLElement,
  websiteUrl: string,
  base: string
): boolean {
  const expected = comparableUrl(websiteUrl);
  if (!expected) return false;
  for (const anchor of container.querySelectorAll('a[href]')) {
    // A generated link can carry a trailing newline inside the attribute; the
    // URL parser drops it, and so must the comparison.
    const href = anchor.getAttribute('href') ?? '';
    if (comparableUrl(href, base) === expected) return true;
  }
  return false;
}

/**
 * WordPress hands an author a private view of their own held comment through
 * `?unapproved=<id>&moderation-hash=<hash>` — no cookie required, so even this
 * module's session-less read would see it. Reading that URL would prove
 * nothing about the public page, so the parameters are dropped, and a
 * cache-busting parameter is added so a CDN cannot answer from a copy
 * rendered before the comment existed.
 */
function anonymousPageUrl(value: string): string {
  try {
    const url = new URL(value);
    url.searchParams.delete('unapproved');
    url.searchParams.delete('moderation-hash');
    url.searchParams.set('_pc', Date.now().toString(36));
    return url.href;
  } catch {
    return value;
  }
}

interface AnonymousRead {
  ok: boolean;
  body: string;
  headers: Headers;
}

/**
 * One anonymous request, headers and body read under a single deadline. The
 * timeout has to cover the body: a server that answers `200` and then stalls
 * mid-stream would otherwise leave the read pending forever, and this module
 * is awaited inline by the batch runner. Takes the exact URL to request — the
 * page read adds its own cache-busting parameter before calling this, the
 * REST read does not, because the endpoint has to match exactly what the
 * page's own `<link>` tag published.
 */
async function readAnonymously(url: string): Promise<AnonymousRead | null> {
  if (typeof fetch !== 'function') return null;
  const controller =
    typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), READ_TIMEOUT_MS)
    : null;
  try {
    const response = await fetch(url, {
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
      body: body.slice(0, MAX_READ_CHARS),
      headers: response.headers,
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

/** The comments region, or null when the page has no recognizable one.
 *  Searching the whole document for a fingerprint would let a sidebar or
 *  footer link — or an unrelated older comment — stand in for one that was
 *  never published. */
function findCommentsRegion(root: HTMLElement): HTMLElement | null {
  return root.querySelector(
    '#comments, .comment-list, #comment-list, .commentlist'
  );
}

/** `#comment-<id>`, preferring it over `#div-comment-<id>`: WordPress core
 *  stamps the same id on both the list item and its inner body, and the list
 *  item is the one whose descendants include a reply nested underneath it —
 *  the inner body does not, because the reply sits as its sibling. Losing
 *  that would mean the removal in `pruneNestedReplies` below has nothing to
 *  do, and a reply's own link could be read as this comment's. */
function findCommentNodeById(
  root: HTMLElement,
  commentId: string
): HTMLElement | null {
  return (
    root.querySelector(`#comment-${commentId}`) ??
    root.querySelector(`#div-comment-${commentId}`) ??
    null
  );
}

/** Every comment node inside `region`, in document order, one per numeric id
 *  — the list-item form when both it and the inner body form are present, by
 *  the same document-order argument as `findCommentNodeById`. */
function collectCommentNodes(region: HTMLElement): HTMLElement[] {
  const seenIds = new Set<string>();
  const nodes: HTMLElement[] = [];
  for (const element of region.querySelectorAll('[id]')) {
    const match = element.id.match(COMMENT_NODE_ID);
    if (!match) continue;
    const number = match[1];
    if (seenIds.has(number)) continue;
    seenIds.add(number);
    nodes.push(element);
  }
  return nodes;
}

/** Removes comments nested inside `node` — a reply hangs its own
 *  `comment-<n>` / `div-comment-<n>` pair under the parent it replies to, and
 *  without this its text and links would be read as belonging to `node`
 *  itself. `node`'s own inner wrapper carries the same id and is left alone;
 *  only a *different* number is a nested comment. */
function pruneNestedReplies(node: HTMLElement, ownId: string): void {
  for (const element of node.querySelectorAll('[id]')) {
    const match = element.id.match(COMMENT_NODE_ID);
    if (match && match[1] !== ownId) element.remove();
  }
}

/** The verdict a found, rendered node produces for `criterion` — never
 *  `not_visible`: a node on the page is definitionally visible, so the only
 *  question left is whether it satisfies the criterion. */
function verdictFromNode(
  node: HTMLElement,
  criterion: PublicCommentCriterion,
  pageUrl: string
): PublicCommentCheck {
  if (criterion.kind === 'comment_only') {
    return check('visible', 'html', 'PUBLIC_COMMENT_HTML_VISIBLE');
  }
  return containsPromotedLink(node, criterion.websiteUrl, pageUrl)
    ? check('visible', 'html', 'PUBLIC_COMMENT_HTML_VISIBLE')
    : check('link_stripped', 'html', 'PUBLIC_COMMENT_HTML_LINK_STRIPPED');
}

/** Prunes nested replies out of `node`, then either its verdict or the
 *  `'unrendered'` sentinel when its body never made it into the HTML — some
 *  themes render the comment shell server-side and fill the body in with
 *  JavaScript, and an empty shell proves nothing either way. */
function evaluateCommentNode(
  node: HTMLElement,
  ownId: string,
  criterion: PublicCommentCriterion,
  pageUrl: string
): PublicCommentCheck | 'unrendered' {
  pruneNestedReplies(node, ownId);
  if (normalizeText(node.text).length < MIN_RENDERED_CHARS) return 'unrendered';
  return verdictFromNode(node, criterion, pageUrl);
}

/**
 * Without a comment id, the fingerprint is the only handle — and several
 * comments on the page can share enough generic text (a short reply, a common
 * phrase) to all contain it. A candidate only counts as ours once it also
 * satisfies the criterion: a fingerprint match that lacks the promoted link
 * proves nothing (it may be someone else's comment that merely reads
 * similarly), so the search keeps going rather than reporting a stranger's
 * comment as `link_stripped`. `comment_only` has no second condition, so the
 * first textual match settles it.
 */
function findCommentNodeByFingerprint(
  region: HTMLElement,
  fingerprint: string,
  criterion: PublicCommentCriterion,
  pageUrl: string
): PublicCommentCheck | 'unrendered' | null {
  const needle = normalizeText(fingerprint).slice(0, FINGERPRINT_MAX_CHARS);
  if (!needle) return null;
  let sawUnrendered = false;
  for (const node of collectCommentNodes(region)) {
    const match = node.id.match(COMMENT_NODE_ID);
    if (!match) continue;
    if (!normalizeText(node.text).includes(needle)) continue;
    const result = evaluateCommentNode(node, match[1], criterion, pageUrl);
    if (result === 'unrendered') {
      sawUnrendered = true;
      continue;
    }
    if (result.visibility === 'visible') return result;
  }
  return sawUnrendered ? 'unrendered' : null;
}

function normalizeRestRoot(root: string): string {
  return root.endsWith('/') ? root : `${root}/`;
}

/**
 * The REST root the page publishes about itself, from its `<link
 * rel="https://api.w.org/">` tag or the equivalent `Link` response header.
 * `origin + '/wp-json/'` is not used: WordPress in a subdirectory answers
 * from whatever install serves the bare origin, which can be a different
 * site entirely, and guessing wrong would mean asking that site about a
 * comment id that means nothing to it.
 */
function discoverRestRoot(
  root: HTMLElement,
  headers: Headers,
  pageUrl: string
): string | null {
  const tagHref = root
    .querySelector(`link[rel="${REST_ROOT_REL}"]`)
    ?.getAttribute('href');
  if (tagHref?.trim()) {
    try {
      return normalizeRestRoot(new URL(tagHref.trim(), pageUrl).href);
    } catch {
      // fall through to the header
    }
  }
  const linkHeader = headers.get('Link');
  const headerMatch = linkHeader?.match(LINK_HEADER_ROOT);
  if (headerMatch) {
    try {
      return normalizeRestRoot(new URL(headerMatch[1].trim(), pageUrl).href);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * `wp-json/wp/v2/comments/<id>` at the discovered root. Only reached when the
 * page's HTML did not decide and a `commentId` exists to ask about; a root
 * that cannot be discovered skips REST entirely rather than guessing one.
 */
async function checkViaRest(
  root: HTMLElement,
  headers: Headers,
  pageUrl: string,
  commentId: string,
  criterion: PublicCommentCriterion
): Promise<PublicCommentCheck | null> {
  const restRoot = discoverRestRoot(root, headers, pageUrl);
  if (!restRoot) return null;
  const response = await readAnonymously(
    `${restRoot}wp/v2/comments/${commentId}`
  );
  if (!response) return null;
  const payload = parseJson(response.body);
  const code =
    payload && typeof payload === 'object' && 'code' in payload
      ? String((payload as { code: unknown }).code)
      : '';
  if (!response.ok) {
    // Only WordPress's own comment errors decide anything, and they may be
    // trusted precisely because the root came from the page itself. A
    // security plugin that walls off the whole REST API answers the same
    // error for every id, published or not, so anything that is not a
    // comment-route error falls through instead of deciding "not visible".
    return code.startsWith('rest_comment')
      ? check('not_visible', 'wp_rest', 'PUBLIC_COMMENT_REST_NOT_APPROVED')
      : null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as {
    status?: unknown;
    author_url?: unknown;
    content?: { rendered?: unknown };
  };
  if (typeof record.status === 'string' && record.status !== 'approved') {
    return check('not_visible', 'wp_rest', 'PUBLIC_COMMENT_REST_NOT_APPROVED');
  }
  if (criterion.kind === 'comment_only') {
    return check('visible', 'wp_rest', 'PUBLIC_COMMENT_REST_VISIBLE');
  }
  const rendered =
    typeof record.content?.rendered === 'string' ? record.content.rendered : '';
  // The promoted link lives in the comment body or on the author byline,
  // depending on the site's link mode. Either surface counts: both are a live
  // link to the promoted site rendered inside this comment.
  const linked =
    containsPromotedLink(parse(rendered), criterion.websiteUrl, pageUrl) ||
    isPromotedAuthorUrl(record.author_url, criterion.websiteUrl, pageUrl);
  return linked
    ? check('visible', 'wp_rest', 'PUBLIC_COMMENT_REST_VISIBLE')
    : check('link_stripped', 'wp_rest', 'PUBLIC_COMMENT_REST_LINK_STRIPPED');
}

export async function checkPublicComment(
  query: PublicCommentQuery
): Promise<PublicCommentCheck> {
  if (!query.pageUrl) {
    return check('inconclusive', 'none', 'PUBLIC_COMMENT_QUERY_INCOMPLETE');
  }
  if (!query.commentId && !query.fingerprint) {
    // Nothing on the page can be attributed to this submission without one.
    return check('inconclusive', 'none', 'PUBLIC_COMMENT_QUERY_INCOMPLETE');
  }

  const page = await readAnonymously(anonymousPageUrl(query.pageUrl));
  if (!page || !page.ok) {
    // Never guess a REST root from an unread page.
    return check('inconclusive', 'none', 'PUBLIC_COMMENT_PAGE_UNREADABLE');
  }

  const root = parse(page.body);
  const region = findCommentsRegion(root);

  let htmlResult: PublicCommentCheck | 'unrendered' | null = null;
  if (query.commentId) {
    const node = findCommentNodeById(root, query.commentId);
    htmlResult = node
      ? evaluateCommentNode(
          node,
          query.commentId,
          query.criterion,
          query.pageUrl
        )
      : null;
  } else if (query.fingerprint && region) {
    htmlResult = findCommentNodeByFingerprint(
      region,
      query.fingerprint,
      query.criterion,
      query.pageUrl
    );
  }

  if (htmlResult && htmlResult !== 'unrendered') return htmlResult;

  if (query.commentId) {
    const rest = await checkViaRest(
      root,
      page.headers,
      query.pageUrl,
      query.commentId,
      query.criterion
    );
    if (rest) return rest;
  }

  if (htmlResult === 'unrendered') {
    return check('inconclusive', 'html', 'PUBLIC_COMMENT_HTML_UNRENDERED');
  }
  if (region) {
    return check('not_visible', 'html', 'PUBLIC_COMMENT_HTML_NOT_FOUND');
  }
  return check('inconclusive', 'html', 'PUBLIC_COMMENT_HTML_NO_REGION');
}
