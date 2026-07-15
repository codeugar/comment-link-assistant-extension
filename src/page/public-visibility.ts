import { decodeHtmlEntities, readHtmlAttributes } from '@/html';
import { isSafeWebsiteRedirect, normalizeWebsiteUrl } from '@/website/profile';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PUBLIC_PAGE_BYTES = 2_000_000;
const COMMENT_DESCRIPTOR =
  /(?:^|[\s_-])(?:comment(?:s|list|body|content|text|thread)?|repl(?:y|ies))(?:$|[\s_-]|\d)/i;
const NON_PUBLIC_DESCRIPTOR =
  /(?:^|[\s_-])(?:form|editor|draft|pending|moderat(?:e|ed|ion)?|preview)(?:$|[\s_-])/i;
const HIDDEN_CLASS = /(?:^|\s)(?:hidden|invisible|screen-reader-text)(?:\s|$)/i;
const EXCLUDED_TAGS = new Set([
  'button',
  'form',
  'input',
  'noscript',
  'script',
  'select',
  'style',
  'template',
  'textarea',
]);
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

interface HtmlFrame {
  tag: string;
  hidden: boolean;
  withinPublicComment: boolean;
}

function comparableText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/&[a-z][a-z\d]+;/gi, ' ')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function* htmlTokens(html: string): Generator<string> {
  let index = 0;
  while (index < html.length) {
    if (html[index] !== '<') {
      const nextTag = html.indexOf('<', index);
      const end = nextTag === -1 ? html.length : nextTag;
      yield html.slice(index, end);
      index = end;
      continue;
    }

    if (html.startsWith('<!--', index)) {
      const commentEnd = html.indexOf('-->', index + 4);
      const end = commentEnd === -1 ? html.length : commentEnd + 3;
      yield html.slice(index, end);
      index = end;
      continue;
    }

    let quote = '';
    let end = index + 1;
    for (; end < html.length; end += 1) {
      const character = html[end];
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        end += 1;
        break;
      }
    }
    yield html.slice(index, end);
    index = end;
  }
}

function visiblePublicCommentText(html: string): string {
  const stack: HtmlFrame[] = [];
  const parts: string[] = [];

  for (const token of htmlTokens(html)) {
    if (!token.startsWith('<')) {
      const frame = stack.at(-1);
      if (frame?.withinPublicComment && !frame.hidden) parts.push(token);
      continue;
    }

    const closing = token.match(/^<\s*\/\s*([\w:-]+)/);
    if (closing) {
      const tag = closing[1]?.toLowerCase();
      while (stack.length > 0) {
        if (stack.pop()?.tag === tag) break;
      }
      continue;
    }

    const opening = token.match(/^<\s*([\w:-]+)/);
    if (!opening || /^<\s*[!?]/.test(token)) continue;
    const tag = opening[1]?.toLowerCase() ?? '';
    const attributes = readHtmlAttributes(token);
    const descriptor = `${attributes.id ?? ''} ${attributes.class ?? ''}`;
    const parent = stack.at(-1);
    const excluded = EXCLUDED_TAGS.has(tag);
    const nonPublic = NON_PUBLIC_DESCRIPTOR.test(descriptor);
    const hidden = Boolean(
      parent?.hidden ||
        excluded ||
        nonPublic ||
        /(?:\s|<)hidden(?:\s|=|\/?>)/i.test(token) ||
        attributes['aria-hidden']?.toLowerCase() === 'true' ||
        /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(
          attributes.style ?? ''
        ) ||
        HIDDEN_CLASS.test(attributes.class ?? '')
    );
    const startsPublicComment =
      tag !== 'body' &&
      tag !== 'html' &&
      COMMENT_DESCRIPTOR.test(descriptor) &&
      !nonPublic;
    const withinPublicComment = Boolean(
      !excluded &&
        !nonPublic &&
        (parent?.withinPublicComment || startsPublicComment)
    );

    if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(token)) {
      stack.push({ tag, hidden, withinPublicComment });
    }
  }

  return parts.join(' ');
}

export function publicCommentHtmlContainsFingerprint(
  html: string,
  fingerprint: string
): boolean {
  const expected = comparableText(fingerprint);
  return (
    expected.length > 0 &&
    comparableText(visiblePublicCommentText(html)).includes(expected)
  );
}

async function readBoundedText(
  response: Response,
  maxBytes = MAX_PUBLIC_PAGE_BYTES
): Promise<string | null> {
  const declaredLength = Number.parseInt(
    response.headers.get('content-length') ?? '',
    10
  );
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return null;

  if (!response.body) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength <= maxBytes ? text : null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function fetchPublicPageContainsFingerprint(
  value: string,
  fingerprint: string,
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<boolean> {
  const url = normalizeWebsiteUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      method: 'GET',
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok) return false;
    const contentType = response.headers.get('content-type') ?? '';
    if (
      contentType &&
      !/text\/html|application\/xhtml\+xml/i.test(contentType)
    ) {
      return false;
    }
    const finalUrl = normalizeWebsiteUrl(response.url || url);
    if (!isSafeWebsiteRedirect(url, finalUrl)) return false;
    const html = await readBoundedText(response);
    return html === null
      ? false
      : publicCommentHtmlContainsFingerprint(html, fingerprint);
  } finally {
    clearTimeout(timeout);
  }
}
