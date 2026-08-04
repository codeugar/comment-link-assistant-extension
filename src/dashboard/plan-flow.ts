export type NewPlanSource = 'dashboard' | 'plans' | 'outbound-library';

export function shouldClearOutboundSelectionAfterPlanCreate(
  source: NewPlanSource
): boolean {
  return source === 'outbound-library';
}
