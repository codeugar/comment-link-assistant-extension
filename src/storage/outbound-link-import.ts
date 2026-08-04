import {
  type OutboundLinkFollowStatus,
  normalizeOutboundLinkDomain,
} from './outbound-link-library';

export interface ParsedOutboundLinkImportRow {
  lineNumber: number;
  domain: string;
  followStatus?: OutboundLinkFollowStatus;
  loginRequired?: boolean;
  captchaRequired?: boolean;
  error?: string;
}

export interface OutboundLinkImportResult {
  rows: ParsedOutboundLinkImportRow[];
  invalidRows: ParsedOutboundLinkImportRow[];
  headerDetected: boolean;
}

const MAX_IMPORT_ROWS = 10_000;
const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
type SpreadsheetModule = typeof import('xlsx');
type SpreadsheetWorkbook = ReturnType<SpreadsheetModule['read']>;
const HEADER_ALIASES = {
  domain: new Set([
    'domain',
    'host',
    'url',
    'website',
    'blog',
    '博客网站域名',
    '域名',
    '网址',
  ]),
  follow: new Set(['dofollow', '是否dofollow', 'follow', 'followstatus']),
  login: new Set(['login', 'loginrequired', '是否需要登录', '需要登录']),
  captcha: new Set(['captcha', 'captcharequired', '是否captcha', '验证码']),
};

function normalizedCell(value: unknown): string {
  return String(value ?? '').trim();
}

function headerKind(value: string): keyof typeof HEADER_ALIASES | null {
  const normalized = value.toLowerCase().replace(/[\s_\-]/g, '');
  for (const [kind, aliases] of Object.entries(HEADER_ALIASES) as Array<
    [keyof typeof HEADER_ALIASES, Set<string>]
  >) {
    if (aliases.has(normalized)) return kind;
  }
  return null;
}

function parseBoolean(value: string): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[\s_\-]/g, '');
  if (
    ['1', 'true', 'yes', 'y', '是', '需要', '有', 'dofollow'].includes(
      normalized
    )
  ) {
    return true;
  }
  if (
    [
      '0',
      'false',
      'no',
      'n',
      '否',
      '不需要',
      '无',
      '无需登录',
      '匿名',
      '匿名评论',
      '无需人机验证',
      'nofollow',
    ].includes(normalized)
  ) {
    return false;
  }
  return undefined;
}

function parseFollowStatus(
  value: string
): OutboundLinkFollowStatus | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[\s_\-]/g, '');
  if (['dofollow', 'yes', 'true', '1', '是', '有'].includes(normalized)) {
    return 'dofollow';
  }
  if (['nofollow', 'no', 'false', '0', '否', '无'].includes(normalized)) {
    return 'nofollow';
  }
  return undefined;
}

function splitCsvLine(line: string): string[] {
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
  return cells;
}

function rowsFromText(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) =>
      line.includes(',') ? splitCsvLine(line) : line.split(/\t+/)
    );
}

async function loadSpreadsheetModule(): Promise<SpreadsheetModule> {
  return import('xlsx');
}

function firstNonEmptySheetRows(
  XLSX: SpreadsheetModule,
  workbook: SpreadsheetWorkbook
): unknown[][] {
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
    });
    if (
      rows.some((row) => row.some((cell) => normalizedCell(cell).length > 0))
    ) {
      return rows;
    }
  }
  return [];
}

function parseRows(rawRows: unknown[][]): OutboundLinkImportResult {
  const rows = rawRows
    .slice(0, MAX_IMPORT_ROWS + 1)
    .map((row) => row.map(normalizedCell));
  const first = rows[0] ?? [];
  const headerKinds = first.map(headerKind);
  const headerDetected = headerKinds.some(Boolean);
  const headerIndex = (kind: keyof typeof HEADER_ALIASES, fallback: number) => {
    const index = headerKinds.findIndex((candidate) => candidate === kind);
    return index >= 0 ? index : fallback;
  };
  const columnIndexes = {
    // A header can name only the required domain column. Missing optional
    // columns still follow the documented positional order.
    domain: headerIndex('domain', 0),
    follow: headerIndex('follow', 1),
    login: headerIndex('login', 2),
    captcha: headerIndex('captcha', 3),
  };
  const sourceRows = headerDetected ? rows.slice(1) : rows;
  const parsed: ParsedOutboundLinkImportRow[] = [];
  for (const [index, row] of sourceRows.entries()) {
    const lineNumber = headerDetected ? index + 2 : index + 1;
    const domainCell = row[columnIndexes.domain] ?? '';
    if (!domainCell) {
      parsed.push({ lineNumber, domain: '', error: 'DOMAIN_REQUIRED' });
      continue;
    }
    let domain: string;
    try {
      domain = normalizeOutboundLinkDomain(domainCell);
    } catch {
      parsed.push({ lineNumber, domain: domainCell, error: 'DOMAIN_INVALID' });
      continue;
    }
    const followCell =
      columnIndexes.follow >= 0 ? (row[columnIndexes.follow] ?? '') : '';
    const loginCell =
      columnIndexes.login >= 0 ? (row[columnIndexes.login] ?? '') : '';
    const captchaCell =
      columnIndexes.captcha >= 0 ? (row[columnIndexes.captcha] ?? '') : '';
    const followStatus = parseFollowStatus(followCell);
    const loginValue = parseBoolean(loginCell);
    const captchaValue = parseBoolean(captchaCell);
    const invalidBoolean =
      (followCell && !followStatus) ||
      (loginCell && loginValue === undefined) ||
      (captchaCell && captchaValue === undefined);
    if (invalidBoolean) {
      parsed.push({ domain, lineNumber, error: 'ATTRIBUTE_INVALID' });
      continue;
    }
    parsed.push({
      domain,
      lineNumber,
      ...(followStatus ? { followStatus } : {}),
      ...(loginValue !== undefined ? { loginRequired: loginValue } : {}),
      ...(captchaValue !== undefined ? { captchaRequired: captchaValue } : {}),
    });
  }
  return {
    rows: parsed.filter((row) => !row.error),
    invalidRows: parsed.filter((row) => Boolean(row.error)),
    headerDetected,
  };
}

export function parseOutboundLinkImportText(
  text: string
): OutboundLinkImportResult {
  return parseRows(rowsFromText(text));
}

export async function parseOutboundLinkImportFile(
  file: File
): Promise<OutboundLinkImportResult> {
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error('OUTBOUND_LINK_IMPORT_FILE_TOO_LARGE');
  }
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const XLSX = await loadSpreadsheetModule();
    const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), {
      type: 'array',
      cellDates: false,
      sheetRows: MAX_IMPORT_ROWS + 1,
    });
    const rows = firstNonEmptySheetRows(XLSX, workbook);
    return parseRows(rows);
  }
  return parseOutboundLinkImportText(await file.text());
}

export function parseTargetFileRows(text: string): string[] {
  const rows = rowsFromText(text);
  const first = normalizedCell(rows[0]?.[0]).toLowerCase();
  const sourceRows = [
    'url',
    'urls',
    'link',
    'target',
    'target_url',
    '网址',
    '目标网址',
  ].includes(first)
    ? rows.slice(1)
    : rows;
  return sourceRows.map((row) => row[0] ?? '').filter(Boolean);
}

export async function parseTargetFile(file: File): Promise<string[]> {
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new Error('TARGET_IMPORT_FILE_TOO_LARGE');
  }
  const name = file.name.toLowerCase();
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
    // Preserve the original text so the shared plan parser can still find a
    // URL/domain in any CSV column and report the original line number.
    return [await file.text()];
  }
  const XLSX = await loadSpreadsheetModule();
  const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), {
    type: 'array',
    sheetRows: MAX_IMPORT_ROWS,
  });
  const rows = firstNonEmptySheetRows(XLSX, workbook);
  const targetHeaders = [
    'url',
    'urls',
    'link',
    'target',
    'target_url',
    '网址',
    '目标网址',
  ];
  const headerRow = rows[0] ?? [];
  const headerIndex = headerRow.findIndex((cell) =>
    targetHeaders.includes(normalizedCell(cell).toLowerCase())
  );
  const columnIndex = headerIndex >= 0 ? headerIndex : 0;
  return (headerIndex >= 0 ? rows.slice(1) : rows)
    .map((row) => normalizedCell(row[columnIndex]))
    .filter(Boolean);
}
