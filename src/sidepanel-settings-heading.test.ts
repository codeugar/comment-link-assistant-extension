import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(
  resolve(process.cwd(), 'entrypoints/sidepanel/styles.css'),
  'utf8'
);

describe('settings heading layout', () => {
  // The generic .section-heading grid reserves a 26px step-number column. The
  // settings panel has no step number, so without an override its heading text
  // is squeezed into the 26px track and renders one word per line.
  it('collapses the unused step-number column in the settings panel', () => {
    const override =
      styles.match(/\.settings-panel\s+\.section-heading\s*\{([^}]*)\}/)?.[1] ??
      '';
    expect(override).toMatch(/grid-template-columns:\s*1fr\s*;/);
  });
});
