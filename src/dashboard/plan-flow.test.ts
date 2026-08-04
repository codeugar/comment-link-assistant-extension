import { describe, expect, it } from 'vitest';
import { shouldClearOutboundSelectionAfterPlanCreate } from './plan-flow';

describe('new plan source state', () => {
  it('only clears library selection after a plan starts from the library page', () => {
    expect(
      shouldClearOutboundSelectionAfterPlanCreate('outbound-library')
    ).toBe(true);
    expect(shouldClearOutboundSelectionAfterPlanCreate('dashboard')).toBe(
      false
    );
    expect(shouldClearOutboundSelectionAfterPlanCreate('plans')).toBe(false);
  });
});
