import { MAX_ANCHOR_TEXT_LENGTH } from '@/anchor/types';
import { escapeHtml } from '@/api/client';
import type { WriteLinkFormat } from './types';

const LINK_PLACEHOLDER = '{LINK}';
const LINK_PLACEHOLDER_PATTERN = /\{LINK\}/g;

export interface RenderDraftOptions {
  websiteUrl: string;
  /** The application-chosen anchor wording. Falls back to `websiteTitle`, then
   *  the site's hostname — same order as `inlineAnchorLabel` in client.ts. */
  anchorText?: string | null;
  websiteTitle?: string;
  format: WriteLinkFormat;
}

function placeholderCount(template: string): number {
  return (template.match(LINK_PLACEHOLDER_PATTERN) ?? []).length;
}

function tidyText(value: string): string {
  return value
    .replace(/[ \t]+([,.;:!?，。；：！？])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n')
    .trim();
}

function resolveAnchorLabel(options: RenderDraftOptions): string {
  const given = options.anchorText
    ?.trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_ANCHOR_TEXT_LENGTH);
  if (given) return given;
  const title = options.websiteTitle
    ?.trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_ANCHOR_TEXT_LENGTH);
  if (title) return title;
  try {
    return new URL(options.websiteUrl).hostname.replace(/^www\./, '');
  } catch {
    return 'Website';
  }
}

/** BBCode has no escape mechanism for `]`, which would otherwise close the
 *  `[url=...]` tag early; fold it (and its visual sibling `[`) onto a
 *  fullwidth lookalike instead of dropping it silently. */
function bbcodeSafeLabel(label: string): string {
  return label.replace(/\[/g, '［').replace(/\]/g, '］');
}

/** Markdown link labels break on an unescaped `]`; backslash-escape both
 *  square brackets so the label cannot terminate `[label]` early. */
function markdownSafeLabel(label: string): string {
  return label.replace(/([[\]])/g, '\\$1');
}

/**
 * Turns the model's `{LINK}`-carrying template into the final comment text for
 * one link format. The template is never re-validated here — that already
 * happened in `src/api/client.ts` — this only ever substitutes a known-good
 * href and an application-chosen anchor label.
 */
export function renderDraft(
  template: string,
  options: RenderDraftOptions
): string {
  const count = placeholderCount(template);
  if (options.format === 'none') {
    if (count === 0) return tidyText(template);
    if (count !== 1) throw new Error('WRITE_TEMPLATE_INVALID');
    return tidyText(template.replace(LINK_PLACEHOLDER, ''));
  }
  if (count !== 1) throw new Error('WRITE_TEMPLATE_INVALID');

  if (options.format === 'bare-url') {
    return tidyText(template.replace(LINK_PLACEHOLDER, options.websiteUrl));
  }

  const label = resolveAnchorLabel(options);
  const anchor =
    options.format === 'bbcode'
      ? `[url=${options.websiteUrl}]${bbcodeSafeLabel(label)}[/url]`
      : options.format === 'markdown'
        ? `[${markdownSafeLabel(label)}](${options.websiteUrl})`
        : `<a href="${escapeHtml(options.websiteUrl)}">${escapeHtml(label)}</a>`;
  return template.replace(LINK_PLACEHOLDER, anchor);
}
