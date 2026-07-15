import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(
  resolve(process.cwd(), 'entrypoints/sidepanel/styles.css'),
  'utf8'
);

describe('side panel scroll layout', () => {
  it('fills the persistent panel and uses the shell as the only vertical scroller', () => {
    const viewportRule =
      styles.match(/html\s*,\s*body\s*,\s*#root\s*\{([^}]*)\}/)?.[1] ?? '';
    const shellRule = styles.match(/\.shell\s*\{([^}]*)\}/)?.[1] ?? '';
    const verticalScrollers = Array.from(
      styles.matchAll(/([^{}]+)\{[^{}]*overflow-y:\s*(?:auto|scroll)/g)
    ).map((match) => match[1]?.trim());

    expect(viewportRule).toMatch(/height:\s*100%/);
    expect(viewportRule).toMatch(/overflow:\s*hidden/);
    expect(shellRule).toMatch(/height:\s*100vh/);
    expect(shellRule).toMatch(/overscroll-behavior-y:\s*contain/);
    expect(verticalScrollers).toEqual(['.shell']);
  });
});
