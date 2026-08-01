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

// A comment form that lives inside a cross-origin iframe the extension can
// still script (given host permission). Carried on the summary so the command
// layer knows to run submit/click inside the frame instead of the top document.
export interface CommentFrameReference {
  kind: 'jetpack';
  url: string;
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
  frame?: CommentFrameReference;
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
  | 'submitted'
  | 'login_required'
  | 'captcha_required'
  | 'validation_error';

export interface PageSubmissionResult {
  status: SubmissionStatus;
  message: string;
  fingerprint: string;
  clickOccurred: boolean;
  linkFollow?: LinkFollowVerification;
}

export type LinkFollowStatus =
  | 'dofollow'
  | 'nofollow'
  | 'ugc'
  | 'link_stripped'
  | 'pending_moderation'
  | 'not_found';

export type LinkFollowSurface = 'comment_body' | 'author_url' | 'unknown';

export interface LinkFollowVerification {
  status: LinkFollowStatus;
  rel: string | null;
  href: string | null;
  surface: LinkFollowSurface;
}
