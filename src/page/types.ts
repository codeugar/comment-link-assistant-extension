export type PageReadiness =
  | 'ready'
  | 'login_required'
  | 'captcha_required'
  | 'not_found';

export interface TargetPageContext {
  url: string;
  title: string;
  description: string;
  excerpt: string;
  language: string;
  hasWebsiteField: boolean;
}

export interface CommentFormSummary {
  readiness: PageReadiness;
  editorLabel: string;
  submitLabel: string;
  hasNameField: boolean;
  hasEmailField: boolean;
  hasWebsiteField: boolean;
  requiresWebsiteField?: boolean;
  message: string;
}

export interface PageAnalysis {
  page: TargetPageContext;
  form: CommentFormSummary;
}

export interface PageSubmissionInput {
  comment: string;
  displayName?: string;
  email?: string;
  websiteUrl: string;
}

export interface PageSubmissionExpectation {
  url: string;
  editorLabel: string;
  submitLabel: string;
  hasWebsiteField: boolean;
}

export interface PageSubmissionTarget extends PageSubmissionExpectation {
  tabId: number;
  fillWebsiteField: boolean;
}

export interface PageSubmissionBaseline {
  feedbackMessages: string[];
  renderedComment: boolean;
}

export interface PreparedPageSubmission {
  fingerprint: string;
  comment: string;
  domToken: string;
  baseline: PageSubmissionBaseline;
  expected: PageSubmissionExpectation;
}

export type PageSubmissionPreparation =
  | { ok: true; prepared: PreparedPageSubmission }
  | { ok: false; result: PageSubmissionResult };

export type SubmissionStatus =
  | 'published'
  | 'submitted_not_visible'
  | 'login_required'
  | 'captcha_required'
  | 'validation_error'
  | 'unknown';

export interface PageSubmissionResult {
  status: SubmissionStatus;
  message: string;
  fingerprint: string;
  clickOccurred: boolean;
}
