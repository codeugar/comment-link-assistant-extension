import enMessages from '../public/_locales/en/messages.json';
import zhMessages from '../public/_locales/zh_CN/messages.json';
import type { UiLocale } from './types';

export const DEFAULT_UI_LOCALE: UiLocale = 'zh-CN';

export const MESSAGE_KEYS = [
  'extensionName',
  'extensionDescription',
  'settingsTitle',
  'languageLabel',
  'languageChinese',
  'languageEnglish',
  'deepSeekApiKeyLabel',
  'deepSeekApiKeyPlaceholder',
  'kieApiKeyLabel',
  'kieApiKeyPlaceholder',
  'providerLabel',
  'providerDeepSeek',
  'providerKieGemini',
  'websiteUrlLabel',
  'websiteUrlPlaceholder',
  'displayNameLabel',
  'displayNamePlaceholder',
  'emailLabel',
  'emailPlaceholder',
  'linkModeLabel',
  'linkModeATagNewline',
  'linkModePreferWebsiteField',
  'linkModeCommentOnly',
  'anchorMixTitle',
  'anchorMixDescription',
  'anchorMixTotalLabel',
  'anchorMixTotalInvalid',
  'anchorMixNormalize',
  'anchorMixActualLabel',
  'anchorMixPendingLabel',
  'anchorMixNoLinksYet',
  'anchorMixPoolPlaceholder',
  'anchorMixPoolEmpty',
  'anchorMixFillBareUrl',
  'anchorMixFillBareUrlUnavailable',
  'anchorMixSuggestGeneric',
  'anchorMixGenerateNatural',
  'anchorMixGeneratingNatural',
  'anchorMixGenerateNaturalFailed',
  'anchorMixNaturalHint',
  'anchorMixSaveFailed',
  'anchorBucketBrand',
  'anchorBucketBrandHint',
  'anchorBucketNaked',
  'anchorBucketNakedHint',
  'anchorBucketExact',
  'anchorBucketExactHint',
  'anchorBucketPartial',
  'anchorBucketPartialHint',
  'anchorBucketGeneric',
  'anchorBucketGenericHint',
  'anchorBucketNatural',
  'anchorBucketNaturalHint',
  'saveSettings',
  'settingsSaved',
  'settingsSaveFailed',
  'scanPage',
  'generateComment',
  'submitComment',
  'analyzingPage',
  'generatingComment',
  'fillingForm',
  'submittingComment',
  'verifyingSubmission',
  'loginRequired',
  'loginRequiredDescription',
  'noCommentForm',
  'commentGenerated',
  'commentSubmitted',
  'commentFailed',
  'missingSettings',
  'invalidWebsiteUrl',
  'websiteProfileFailed',
  'missingDeepSeekApiKey',
  'missingKieApiKey',
  'openSettings',
  'openDashboard',
  'dashboardOpenFailed',
  'backToQueue',
  'workflowEyebrow',
  'settingsDescription',
  'currentPageLabel',
  'formReady',
  'websiteFieldFound',
  'websiteFieldMissing',
  'captchaRequired',
  'captchaRequiredDescription',
  'draftLabel',
  'draftHint',
  'submitConfirmation',
  'submissionUnconfirmed',
  'commentPublishedByAnchor',
  'commentPublishedByFingerprint',
  'commentPendingWordPressModeration',
  'commentPendingModerationFeedback',
  'permissionDenied',
  'apiKeySecurityNote',
  'pageChangedSinceGeneration',
  'batchSetupTitle',
  'batchSetupDescription',
  'targetUrlsLabel',
  'targetUrlsPlaceholder',
  'targetUrlsHint',
  'invalidTargetUrls',
  'prepareBatch',
  'preparingBatch',
  'batchReviewTitle',
  'websiteProfileTitle',
  'refreshWebsiteProfile',
  'refreshingWebsiteProfile',
  'metaTitleLabel',
  'metaDescriptionLabel',
  'targetUrlsSummary',
  'batchConfirmationNotice',
  'confirmAndStartBatch',
  'startingBatch',
  'batchProgressTitle',
  'batchProgressCount',
  'currentTargetLabel',
  'queueDetailsLabel',
  'continueBatch',
  'skipCurrentTarget',
  'stopBatch',
  'stopBatchHint',
  'openCurrentTarget',
  'batchPausedLoginDescription',
  'batchPausedCaptchaDescription',
  'batchSkippedLoginDescription',
  'batchSkippedCaptchaDescription',
  'batchCompletedTitle',
  'batchStoppedTitle',
  'batchSummary',
  'startNewBatch',
  'batchRetryItem',
  'batchRetryFailed',
  'batchHistoryTitle',
  'batchHistoryRetryFailed',
  'batchHistoryRetryUrl',
  'batchHistoryEmpty',
  'siteSelectorLabel',
  'siteAdd',
  'siteRemove',
  'siteLabelField',
  'siteLabelPlaceholder',
  'siteUnnamed',
  'batchStatusQueued',
  'batchStatusOpening',
  'batchStatusAnalyzing',
  'batchStatusGenerating',
  'batchStatusPrepared',
  'batchStatusSubmitting',
  'batchStatusVerifying',
  'batchStatusPublished',
  'batchStatusPendingModeration',
  'batchStatusUnconfirmed',
  'batchStatusSubmitted',
  'batchStatusLoginRequired',
  'batchStatusCaptchaRequired',
  'batchStatusNoForm',
  'batchStatusValidationError',
  'batchStatusFailed',
  'batchStatusFiltered',
  'batchStatusStopped',
  'crossOriginCommentFrameUnsupported',
  'displayNameRequiredForTarget',
  'emailRequiredForTarget',
  'formNeedsReview',
  'requiredFieldNotMapped',
  'websiteRequiredForTarget',
  'commentBodyLinkRequired',
  'unsafeSubmitBlocked',
  'commentFormRevealed',
  'commentFormRevealDispatched',
  'siteFlowTitle',
  'backgroundWorkerNotice',
  'generatedCommentLabel',
  'copyGeneratedComment',
  'generatedCommentCopied',
  'generatedCommentCopyFailed',
  'copyDiagnostics',
  'diagnosticsCopied',
  'diagnosticsCopyFailed',
  'activityOpeningTarget',
  'activityWaitingForPage',
  'activityAnalyzingContent',
  'activityMappingForm',
  'activityGeneratingContext',
  'activityWritingComment',
  'activityPreparingFields',
  'activityCheckingSubmit',
  'activitySubmitting',
  'activityWaitingResponse',
  'activityVerifyingPage',
  'activityReadingFeedback',
  'planTitle',
  'planCreate',
  'planCreated',
  'planChunkSize',
  'planPreviewSummary',
  'planDueBanner',
  'planRunNext',
  'planDoneToday',
  'planProgress',
  'planDelete',
  'planEmpty',
] as const;

export type MessageKey = (typeof MESSAGE_KEYS)[number];

type MessageCatalog = Record<string, { message: string }>;

const catalogs: Record<UiLocale, MessageCatalog> = {
  en: enMessages,
  'zh-CN': zhMessages,
};

let activeLocale: UiLocale = DEFAULT_UI_LOCALE;

export function getUiLocale(): UiLocale {
  return activeLocale;
}

export function setUiLocale(locale: UiLocale): void {
  activeLocale = locale;
}

function applySubstitutions(
  message: string,
  substitutions?: string | string[]
): string {
  if (!substitutions) return message;
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  return values.reduce(
    (result, value, index) => result.replaceAll(`$${index + 1}`, value),
    message
  );
}

export function translate(
  key: MessageKey,
  substitutions?: string | string[]
): string {
  // Keep the lightweight test/browser shim behavior where getMessage returns
  // the key itself, while real rendering always uses the explicitly selected
  // catalog below. Chrome returns an empty string for a missing message.
  if (typeof chrome !== 'undefined' && chrome.i18n?.getMessage) {
    try {
      const browserMessage = chrome.i18n.getMessage(key, substitutions);
      if (browserMessage === key) return browserMessage;
    } catch {
      // The browser shim used by unit tests does not implement i18n.
    }
  }
  const localized = catalogs[activeLocale][key]?.message;
  const fallback = catalogs[DEFAULT_UI_LOCALE][key]?.message;
  return applySubstitutions(localized || fallback || key, substitutions);
}
