import { describe, expect, it } from 'vitest';
import {
  PLAN_TARGET_STATUSES,
  type PlanTargetStatus,
  isFailedTargetStatus,
  isRetryableTargetStatus,
} from './model';

/**
 * "Did this target produce a backlink?" and "is there any point running it
 * again?" are separate questions. One set answered both until `link_stripped`
 * arrived, which is the first status where the answers diverge: it failed, and
 * re-running it would post a second comment under a comment that is already
 * public.
 */
describe('failed versus retryable target statuses', () => {
  it('counts a stripped link as a failure', () => {
    expect(isFailedTargetStatus('link_stripped')).toBe(true);
  });

  it('never offers a stripped link for retry', () => {
    expect(isRetryableTargetStatus('link_stripped')).toBe(false);
  });

  it('offers the statuses a fresh attempt can still fix', () => {
    expect(isRetryableTargetStatus('no_form')).toBe(true);
    expect(isRetryableTargetStatus('validation_error')).toBe(true);
    expect(isRetryableTargetStatus('failed')).toBe(true);
  });

  it('never offers a target that already carries a public comment', () => {
    expect(isRetryableTargetStatus('published')).toBe(false);
    expect(isRetryableTargetStatus('pending_moderation')).toBe(false);
    expect(isRetryableTargetStatus('unconfirmed')).toBe(false);
    expect(isRetryableTargetStatus('submitted')).toBe(false);
  });

  it('keeps every retryable status inside the failed set', () => {
    // Retry is offered from the failed list in the UI, so a status that is
    // retryable but not failed could never be reached.
    for (const status of PLAN_TARGET_STATUSES as readonly PlanTargetStatus[]) {
      if (isRetryableTargetStatus(status)) {
        expect(isFailedTargetStatus(status)).toBe(true);
      }
    }
  });
});
