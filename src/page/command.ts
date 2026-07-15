import { formPlanSchema } from '@/api/form-planner';
import {
  analyzePageDocument,
  clickPreparedSubmissionDocument,
  prepareSubmissionDocument,
  revealPlannedCommentFormDocument,
  verifySubmissionDocument,
} from './dom';
import type {
  PageAnalysis,
  PageSubmissionBaseline,
  PageSubmissionExpectation,
  PageSubmissionInput,
  PageSubmissionPreparation,
  PageSubmissionResult,
  PreparedPageSubmission,
} from './types';

export const PAGE_COMMAND_MESSAGE_TYPE = 'comment-link-assistant:page-command';

export type PageCommand =
  | { type: 'analyze' }
  | { type: 'form.reveal'; snapshotId: string; candidateId: string }
  | {
      type: 'submit.prepare';
      input: PageSubmissionInput;
      expected: PageSubmissionExpectation;
    }
  | { type: 'submit.click'; prepared: PreparedPageSubmission }
  | {
      type: 'verify';
      fingerprint: string;
      baseline: PageSubmissionBaseline;
      expectedUrl: string;
    };

export interface PageCommandMessage {
  type: typeof PAGE_COMMAND_MESSAGE_TYPE;
  command: PageCommand;
}

export type PageCommandResult =
  | { type: 'analysis'; analysis: PageAnalysis }
  | { type: 'form.reveal'; clicked: boolean }
  | { type: 'preparation'; preparation: PageSubmissionPreparation }
  | { type: 'submission'; result: PageSubmissionResult }
  | { type: 'error'; message: string };

export function isPageCommand(value: unknown): value is PageCommand {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'analyze') return true;
  if (record.type === 'form.reveal') {
    return (
      typeof record.snapshotId === 'string' &&
      typeof record.candidateId === 'string'
    );
  }
  if (record.type === 'verify') {
    return (
      typeof record.fingerprint === 'string' &&
      typeof record.expectedUrl === 'string' &&
      isBaseline(record.baseline)
    );
  }
  if (record.type === 'submit.click') return isPrepared(record.prepared);
  if (
    record.type !== 'submit.prepare' ||
    !record.input ||
    typeof record.input !== 'object'
  ) {
    return false;
  }
  const input = record.input as Record<string, unknown>;
  return (
    typeof input.comment === 'string' &&
    typeof input.websiteUrl === 'string' &&
    (input.displayName === undefined ||
      typeof input.displayName === 'string') &&
    (input.email === undefined || typeof input.email === 'string') &&
    isExpectation(record.expected)
  );
}

function isBaseline(value: unknown): value is PageSubmissionBaseline {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.feedbackMessages) &&
    record.feedbackMessages.every((message) => typeof message === 'string') &&
    typeof record.renderedComment === 'boolean'
  );
}

function isExpectation(value: unknown): value is PageSubmissionExpectation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.url === 'string' &&
    typeof record.editorLabel === 'string' &&
    typeof record.submitLabel === 'string' &&
    typeof record.hasWebsiteField === 'boolean' &&
    (record.formPlan === undefined ||
      formPlanSchema.safeParse(record.formPlan).success)
  );
}

function isPrepared(value: unknown): value is PreparedPageSubmission {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.fingerprint === 'string' &&
    typeof record.comment === 'string' &&
    typeof record.domToken === 'string' &&
    isBaseline(record.baseline) &&
    isExpectation(record.expected)
  );
}

export function isPageCommandMessage(
  value: unknown
): value is PageCommandMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.type === PAGE_COMMAND_MESSAGE_TYPE && isPageCommand(record.command)
  );
}

export async function runPageCommand(
  document: Document,
  command: PageCommand
): Promise<PageCommandResult> {
  if (command.type === 'analyze') {
    return { type: 'analysis', analysis: analyzePageDocument(document) };
  }
  if (command.type === 'form.reveal') {
    return {
      type: 'form.reveal',
      clicked: revealPlannedCommentFormDocument(
        document,
        command.snapshotId,
        command.candidateId
      ),
    };
  }
  if (command.type === 'verify') {
    if (
      !isAllowedSubmissionReturnUrl(document.location.href, command.expectedUrl)
    ) {
      return {
        type: 'submission',
        result: {
          status: 'unknown',
          message: 'COMMENT_SUBMISSION_UNCONFIRMED',
          fingerprint: command.fingerprint,
          clickOccurred: true,
        },
      };
    }
    const result = verifySubmissionDocument(
      document,
      command.fingerprint,
      command.baseline
    );
    if (
      result.status === 'unknown' &&
      hasNewWordPressCommentAnchor(document.location.href, command.expectedUrl)
    ) {
      return {
        type: 'submission',
        result: {
          status: 'submitted_not_visible',
          message: 'COMMENT_SUBMITTED_NOT_VISIBLE',
          fingerprint: command.fingerprint,
          clickOccurred: true,
        },
      };
    }
    return { type: 'submission', result };
  }
  if (command.type === 'submit.prepare') {
    return {
      type: 'preparation',
      preparation: await prepareSubmissionDocument(
        document,
        command.input,
        command.expected
      ),
    };
  }
  return {
    type: 'submission',
    result: await clickPreparedSubmissionDocument(document, command.prepared),
  };
}

function isAllowedSubmissionReturnUrl(
  currentValue: string,
  expectedValue: string
): boolean {
  let current: URL;
  let expected: URL;
  try {
    current = new URL(currentValue);
    expected = new URL(expectedValue);
  } catch {
    return false;
  }
  return (
    (current.protocol === 'http:' || current.protocol === 'https:') &&
    (expected.protocol === 'http:' || expected.protocol === 'https:') &&
    current.origin === expected.origin
  );
}

function hasNewWordPressCommentAnchor(
  currentValue: string,
  expectedValue: string
): boolean {
  try {
    const current = new URL(currentValue);
    const expected = new URL(expectedValue);
    return (
      current.origin === expected.origin &&
      current.pathname === expected.pathname &&
      !/^#comment-\d+$/i.test(expected.hash) &&
      /^#comment-\d+$/i.test(current.hash)
    );
  } catch {
    return false;
  }
}
