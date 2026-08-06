import { describe, expect, it } from 'vitest';
import {
  GENERIC_ANCHOR_PRESETS,
  suggestGenericAnchors,
} from './generic-presets';
import {
  anchorTargetTotal,
  bareUrlAnchorVariants,
  formatAnchorPool,
  normalizeAnchorTargets,
  parseAnchorPool,
} from './plan-form';
import { type AnchorBucketTargets, DEFAULT_ANCHOR_TARGETS } from './types';

describe('anchor pool editing', () => {
  it('reads one entry per line, dropping blanks and duplicates', () => {
    expect(
      parseAnchorPool('  Example \n\nexample app\n\n  EXAMPLE  \nExample App')
    ).toEqual(['Example', 'example app']);
  });

  it('collapses inner whitespace and caps an overlong entry', () => {
    expect(parseAnchorPool('AI   video    generator')).toEqual([
      'AI video generator',
    ]);
    expect(parseAnchorPool('x'.repeat(200))[0]).toHaveLength(80);
  });

  it('stops at the stored pool limit', () => {
    const lines = Array.from({ length: 60 }, (_, index) => `entry ${index}`);
    expect(parseAnchorPool(lines.join('\n'))).toHaveLength(50);
  });

  it('round-trips a pool back into the textarea', () => {
    const pool = ['Example', 'Example App'];
    expect(parseAnchorPool(formatAnchorPool(pool))).toEqual(pool);
  });
});

describe('anchor target normalization', () => {
  it('leaves a mix that already adds up to 100 untouched', () => {
    expect(normalizeAnchorTargets(DEFAULT_ANCHOR_TARGETS)).toEqual(
      DEFAULT_ANCHOR_TARGETS
    );
  });

  it('rescales an over-100 mix while keeping the relative sizes', () => {
    const targets: AnchorBucketTargets = {
      brand: 60,
      naked: 40,
      exact: 40,
      partial: 30,
      generic: 20,
      natural: 10,
    };

    const normalized = normalizeAnchorTargets(targets);

    expect(anchorTargetTotal(normalized)).toBe(100);
    expect(normalized).toEqual(DEFAULT_ANCHOR_TARGETS);
  });

  it('tops an under-100 mix back up to exactly 100', () => {
    const normalized = normalizeAnchorTargets({
      brand: 10,
      naked: 10,
      exact: 10,
      partial: 0,
      generic: 0,
      natural: 0,
    });

    expect(anchorTargetTotal(normalized)).toBe(100);
    expect(normalized.partial).toBe(0);
  });

  it('falls back to an even split when every bucket is zero', () => {
    const normalized = normalizeAnchorTargets({
      brand: 0,
      naked: 0,
      exact: 0,
      partial: 0,
      generic: 0,
      natural: 0,
    });

    expect(anchorTargetTotal(normalized)).toBe(100);
  });
});

describe('bare URL anchor variants', () => {
  it('offers the canonical, bare-host and www spellings', () => {
    expect(bareUrlAnchorVariants('https://example.com')).toEqual([
      'https://example.com',
      'example.com',
      'www.example.com',
    ]);
  });

  it('keeps a path and does not duplicate an already-www host', () => {
    expect(bareUrlAnchorVariants('https://www.example.com/tools/')).toEqual([
      'https://www.example.com/tools',
      'example.com/tools',
      'www.example.com/tools',
    ]);
  });

  it('offers nothing for a website URL that is not set or not http', () => {
    expect(bareUrlAnchorVariants('')).toEqual([]);
    expect(bareUrlAnchorVariants('javascript:alert(1)')).toEqual([]);
  });
});

describe('generic anchor suggestions', () => {
  it('never re-offers wording the pool already has', () => {
    const drawn = suggestGenericAnchors(['this website', 'LEARN MORE'], 4);

    expect(drawn).not.toContain('this website');
    expect(drawn).not.toContain('learn more');
    expect(drawn).toHaveLength(4);
    expect(new Set(drawn).size).toBe(4);
  });

  it('returns what is left when the pool has nearly everything', () => {
    const drawn = suggestGenericAnchors(
      ['this website', 'this page'],
      1_000,
      () => 0
    );

    expect(drawn).toHaveLength(GENERIC_ANCHOR_PRESETS.length - 2);
  });
});
