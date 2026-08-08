import type { PublicCommentCheck } from '@/verify/public-comment';

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
  /** Refuse the click unless the body contains exactly one anchor to websiteUrl. */
  requireInlineAnchor?: boolean;
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
  /** Canonical Website field value to re-check after dynamic form rerenders. */
  websiteUrl?: string;
  domToken: string;
  baseline: PageSubmissionBaseline;
  expected: PageSubmissionExpectation;
}

export type PageSubmissionPreparation =
  | { ok: true; prepared: PreparedPageSubmission }
  | { ok: false; result: PageSubmissionResult };

export type SubmissionStatus =
  | 'published'
  | 'pending_moderation'
  // Public, and the promoted link is gone. Terminal on purpose: waiting longer
  // cannot bring a stripped link back, so it must never sit in the re-check
  // queue behind comments that still might go live.
  | 'link_stripped'
  | 'unconfirmed'
  // Kept only to decode result messages produced by an older content script
  // during an extension update. New code never emits this ambiguous status.
  | 'submitted'
  | 'login_required'
  | 'captcha_required'
  | 'validation_error';

/** What the server handed back when it took the comment. The comment id is the
 *  only exact handle a later anonymous re-read has on this specific comment. */
export interface SubmissionReceipt {
  /** The URL the submit landed on; WordPress resolves it to the right comment
   *  page on its own, so it is the best page to re-read. */
  url: string;
  commentId?: string;
}

/**
 * How the submitting session learned the site took the comment. Acceptance is
 * never publication: WordPress deliberately renders a held comment to its own
 * author, so evidence collected inside the submitting session cannot prove that
 * a visitor sees anything. Only an anonymous read can.
 */
export type SubmissionAcceptance = 'server_receipt' | 'rendered_locally';

export interface PageSubmissionResult {
  status: SubmissionStatus;
  message: string;
  fingerprint: string;
  clickOccurred: boolean;
  linkFollow?: LinkFollowVerification;
  /** Set when the site accepted the comment, saying how that was learned. */
  acceptance?: SubmissionAcceptance;
  receipt?: SubmissionReceipt;
  /** The anonymous read that decided `published` versus `pending_moderation`. */
  publicCheck?: PublicCommentCheck;
}

/** Result of a read-only follow-up check for an already submitted comment. */
export interface ModerationCheckResult {
  status:
    | 'published'
    | 'pending_moderation'
    | 'link_stripped'
    | 'login_required'
    | 'captcha_required';
  message: string;
  fingerprint: string;
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
