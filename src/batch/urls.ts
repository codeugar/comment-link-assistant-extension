export const MAX_BATCH_TARGETS = 200;
const MAX_TARGET_TEXT_LENGTH = 100_000;

export class TargetUrlError extends Error {
  readonly code = 'TARGET_URL_INVALID' as const;

  constructor(
    readonly lineNumber: number,
    readonly value: string
  ) {
    super(
      lineNumber === 0
        ? 'TARGET_URL_INVALID: at least one target URL is required'
        : `TARGET_URL_INVALID: line ${lineNumber}`
    );
    this.name = 'TargetUrlError';
  }
}

export class TargetUrlLimitError extends Error {
  readonly code = 'TARGET_URL_LIMIT_EXCEEDED' as const;

  constructor() {
    super(`TARGET_URL_LIMIT_EXCEEDED: maximum ${MAX_BATCH_TARGETS} targets`);
    this.name = 'TargetUrlLimitError';
  }
}

function normalizeTargetUrl(value: string, lineNumber: number): string {
  if (value.length > 2_048) throw new TargetUrlError(lineNumber, value);
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TargetUrlError(lineNumber, value);
    }
    if (url.username || url.password) {
      throw new TargetUrlError(lineNumber, value);
    }
    url.hash = '';
    return url.toString();
  } catch (error) {
    if (error instanceof TargetUrlError) throw error;
    throw new TargetUrlError(lineNumber, value);
  }
}

export function parseTargetUrls(text: string): string[] {
  if (text.length > MAX_TARGET_TEXT_LENGTH) throw new TargetUrlLimitError();
  const targets: string[] = [];
  const seen = new Set<string>();

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const value = line.trim();
    if (!value) continue;

    const normalized = normalizeTargetUrl(value, index + 1);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    targets.push(normalized);
    if (targets.length > MAX_BATCH_TARGETS) throw new TargetUrlLimitError();
  }

  if (targets.length === 0) throw new TargetUrlError(0, '');
  return targets;
}
