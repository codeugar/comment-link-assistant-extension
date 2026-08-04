import { normalizeOutboundLinkDomain } from '@/storage/outbound-link-library';
import { parseDashboardTargetRows } from './target-import';

export interface ParsedPlanUrls {
  valid: string[];
  duplicates: string[];
  invalid: string[];
}

/**
 * Keep the dashboard preview and the plan service on the same target-row
 * parser while applying the dashboard's HTTP(S) URL rules.
 */
export function parsePlanUrls(text: string): ParsedPlanUrls {
  const parsedRows = parseDashboardTargetRows(text);
  const valid: string[] = [];
  const duplicates: string[] = [];
  const invalid = parsedRows.invalidLineNumbers.map(
    (lineNumber) => `line:${lineNumber}`
  );
  const seen = new Set<string>();

  for (const { value: candidate } of parsedRows.candidates) {
    try {
      const trimmed = candidate.trim();
      if (
        /^[a-z][a-z\d+.-]*:/i.test(trimmed) &&
        !/^https?:\/\//i.test(trimmed)
      ) {
        throw new Error('URL_NOT_ALLOWED');
      }
      const url = new URL(
        /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
      );
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        !url.hostname ||
        candidate.length > 2_048
      ) {
        invalid.push(candidate);
        continue;
      }
      url.hash = '';
      const normalized = url.href.replace(/\/$/, '');
      if (seen.has(normalized)) duplicates.push(candidate);
      else {
        seen.add(normalized);
        valid.push(normalized);
      }
    } catch {
      invalid.push(candidate);
    }
  }
  return { valid, duplicates, invalid };
}

export function outboundDomainToTargetUrl(domain: string): string {
  return `https://${normalizeOutboundLinkDomain(domain)}`;
}

/**
 * Append library domains without replacing user input. When the current text
 * is valid, use the existing plan parser to normalize and deduplicate the
 * complete text. If it contains an invalid line, preserve that editable text
 * and only avoid adding URLs already recognized as valid.
 */
export function appendOutboundDomainsToTargetText(
  currentText: string,
  domains: readonly string[]
): string {
  const urls = [
    ...new Set(
      domains.flatMap((domain) => {
        try {
          return [outboundDomainToTargetUrl(domain)];
        } catch {
          return [];
        }
      })
    ),
  ];
  return appendNormalizedTargetText(currentText, urls.join('\n'));
}

export function appendNormalizedTargetText(
  currentText: string,
  additionalText: string
): string {
  if (!additionalText.trim()) return currentText;

  const current = parsePlanUrls(currentText);
  const additions = parsePlanUrls(additionalText).valid;
  if (current.invalid.length === 0) {
    return [
      ...current.valid,
      ...additions.filter((url) => !current.valid.includes(url)),
    ].join('\n');
  }

  const existing = new Set(current.valid);
  return [currentText.trim(), ...additions.filter((url) => !existing.has(url))]
    .filter(Boolean)
    .join('\n');
}
