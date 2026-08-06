/**
 * Wording for the generic bucket — anchors that describe the destination
 * without naming it or carrying a keyword. Deliberately not split by language:
 * the mix is chosen per promoted site, not per target page, and a site whose
 * targets are in one language can simply keep the entries that suit it.
 */
export const GENERIC_ANCHOR_PRESETS = [
  'this website',
  'this page',
  'this resource',
  'this guide',
  'this write-up',
  'this overview',
  'learn more',
  'read more',
  'more details',
  'more on this',
  'see here',
  'have a look',
  'a closer look',
  'further reading',
  'the full breakdown',
  '这个网站',
  '这个页面',
  '这份指南',
  '了解更多',
  '查看详情',
  '更多内容',
  '延伸阅读',
  '完整介绍',
] as const;

/**
 * Draws entries that are not already in the pool, so repeated clicks keep
 * adding new wording instead of re-offering what the user already has.
 */
export function suggestGenericAnchors(
  existing: readonly string[],
  count: number,
  pick: (max: number) => number = (max) => Math.floor(Math.random() * max)
): string[] {
  const taken = new Set(existing.map((entry) => entry.trim().toLowerCase()));
  const available = GENERIC_ANCHOR_PRESETS.filter(
    (preset) => !taken.has(preset.toLowerCase())
  );
  const drawn: string[] = [];
  const pool = [...available];
  while (drawn.length < count && pool.length > 0) {
    const [entry] = pool.splice(pick(pool.length), 1);
    if (entry) drawn.push(entry);
  }
  return drawn;
}
