export interface TargetTextCandidate {
  value: string;
  lineNumber: number;
}

export interface TargetTextParseResult {
  candidates: TargetTextCandidate[];
  invalidLineNumbers: number[];
}

function parseCsvCells(line: string): { cells: string[]; malformed: boolean } {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  return { cells, malformed: quoted };
}

function isCsvHeader(cells: string[]): boolean {
  const headers = new Set([
    'url',
    'urls',
    'link',
    'links',
    'target',
    'target_url',
    'target url',
    '\u7f51\u5740',
    '\u76ee\u6807\u7f51\u5740',
  ]);
  return cells.some((cell) => headers.has(cell.trim().toLowerCase()));
}

function looksLikeLooseHttpTarget(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^https?:\/\//i.test(trimmed) ||
    /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(trimmed)
  );
}

function firstUnquotedComma(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      return index;
    }
  }
  return -1;
}

function commaIsPartOfUrlQuery(line: string, commaIndex: number): boolean {
  const queryIndex = line.indexOf('?');
  const hashIndex = line.indexOf('#');
  const urlSuffixIndex = [queryIndex, hashIndex]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  return urlSuffixIndex !== undefined && commaIndex > urlSuffixIndex;
}

/**
 * Parses the paste/TXT/CSV surface once so the dashboard preview and the
 * background use the same row semantics. A normal CSV row contributes only
 * HTTP(S) cells; non-URL cells are treated as labels/metadata. For backwards
 * compatibility, an unquoted comma in a URL query/fragment stays part of the
 * URL. CSV URLs containing commas should be quoted.
 */
export function parseDashboardTargetRows(text: string): TargetTextParseResult {
  const candidates: TargetTextCandidate[] = [];
  const invalidLineNumbers: number[] = [];

  for (const [index, sourceLine] of text.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = sourceLine.trim();
    if (!line) continue;

    const commaIndex = firstUnquotedComma(line);
    if (commaIndex < 0) {
      const values = line.split(/\s+/).filter(Boolean);
      if (values.every((value) => looksLikeLooseHttpTarget(value))) {
        candidates.push(...values.map((value) => ({ value, lineNumber })));
      } else {
        invalidLineNumbers.push(lineNumber);
      }
      continue;
    }

    if (/^https?:\/\//i.test(line) && commaIsPartOfUrlQuery(line, commaIndex)) {
      candidates.push({ value: line, lineNumber });
      continue;
    }

    const parsed = parseCsvCells(line);
    if (parsed.malformed) {
      invalidLineNumbers.push(lineNumber);
      continue;
    }
    if (isCsvHeader(parsed.cells)) continue;
    const urls = parsed.cells.filter((cell) => looksLikeLooseHttpTarget(cell));
    if (urls.length === 0) {
      invalidLineNumbers.push(lineNumber);
      continue;
    }
    candidates.push(...urls.map((value) => ({ value, lineNumber })));
  }

  return { candidates, invalidLineNumbers };
}
