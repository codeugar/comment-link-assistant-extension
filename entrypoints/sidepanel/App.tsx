import { hasResumableItems } from '@/batch/state';
import {
  type BatchItem,
  type BatchItemStatus,
  type BatchSnapshot,
  batchSnapshotSchema,
} from '@/batch/types';
import { TextLoop } from '@/components/core/text-loop';
import { DEFAULT_UI_LOCALE, setUiLocale, translate } from '@/i18n';
import { sendToBackground } from '@/runtime/messages';
import { BATCH_STORAGE_KEY, getBatch } from '@/storage/batch';
import {
  type BatchHistoryEntry,
  HISTORY_STORAGE_KEY,
  getBatchHistory,
  isFailedHistoryStatus,
} from '@/storage/batch-history';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  extensionSettingsSchema,
  getSettings,
  restrictStorageToTrustedContexts,
} from '@/storage/settings';
import type { ExtensionSettings } from '@/types';
import { ChartLineUp } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

// The sidepanel observes a run and works the manual gates it stops at. It never
// starts one: every surface that puts a link on someone else's page lives in the
// dashboard, where the promoted site is chosen explicitly and recorded on the
// plan. Keeping one entry point is what stops a run from promoting a site the
// operator did not pick for it.
type BusyState =
  | 'idle'
  | 'continuing'
  | 'skipping'
  | 'stopping'
  | 'resuming'
  | 'opening'
  | 'resetting';

function providerLabel(provider: ExtensionSettings['provider']): string {
  return translate(
    provider === 'deepseek' ? 'providerDeepSeek' : 'providerKieGemini'
  );
}

function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.split(':', 1)[0];
  if (code.startsWith('TARGET_URL_')) return translate('invalidTargetUrls');
  if (code === 'DEEPSEEK_API_KEY_REQUIRED') {
    return translate('missingDeepSeekApiKey');
  }
  if (code === 'KIE_API_KEY_REQUIRED') {
    return translate('missingKieApiKey');
  }
  if (code === 'WEBSITE_URL_REQUIRED') return translate('missingSettings');
  if (code.includes('PERMISSION')) return translate('permissionDenied');
  if (
    code.includes('WEBSITE_FETCH') ||
    code === 'WEBSITE_META_NOT_FOUND' ||
    code === 'WEBSITE_RESPONSE_NOT_HTML'
  ) {
    return translate('websiteProfileFailed');
  }
  if (code.includes('WEBSITE_URL')) return translate('invalidWebsiteUrl');
  return translate('commentFailed');
}

function batchItemStatusCopy(status: BatchItemStatus): string {
  switch (status) {
    case 'queued':
      return translate('batchStatusQueued');
    case 'opening':
      return translate('batchStatusOpening');
    case 'analyzing':
      return translate('batchStatusAnalyzing');
    case 'generating':
      return translate('batchStatusGenerating');
    case 'prepared':
      return translate('batchStatusPrepared');
    case 'click_dispatched':
      return translate('batchStatusSubmitting');
    case 'verifying':
      return translate('batchStatusVerifying');
    case 'published':
      return translate('batchStatusPublished');
    case 'pending_moderation':
      return translate('batchStatusPendingModeration');
    case 'link_stripped':
      return translate('batchStatusLinkStripped');
    case 'unconfirmed':
      return translate('batchStatusUnconfirmed');
    case 'submitted':
      return translate('batchStatusUnconfirmed');
    case 'login_required':
      return translate('batchStatusLoginRequired');
    case 'captcha_required':
      return translate('batchStatusCaptchaRequired');
    case 'no_form':
      return translate('batchStatusNoForm');
    case 'validation_error':
      return translate('batchStatusValidationError');
    case 'failed':
      return translate('batchStatusFailed');
    case 'filtered':
      return translate('batchStatusFiltered');
    case 'stopped':
      return translate('batchStatusStopped');
  }
}

function batchItemMessageCopy(message: string): string | null {
  if (message === 'CROSS_ORIGIN_COMMENT_FRAME_UNSUPPORTED') {
    return translate('crossOriginCommentFrameUnsupported');
  }
  if (message === 'TARGET_PAGE_UNREACHABLE') {
    return translate('targetPageUnreachable');
  }
  if (message === 'DISPLAY_NAME_REQUIRED') {
    return translate('displayNameRequiredForTarget');
  }
  if (message === 'EMAIL_REQUIRED') {
    return translate('emailRequiredForTarget');
  }
  if (message === 'FORM_PLAN_NEEDS_REVIEW') {
    return translate('formNeedsReview');
  }
  if (message === 'FORM_PLAN_REQUIRED_FIELD_MISSING') {
    return translate('requiredFieldNotMapped');
  }
  if (message === 'WEBSITE_REQUIRED') {
    return translate('websiteRequiredForTarget');
  }
  if (message === 'COMMENT_BODY_LINK_REQUIRED') {
    return translate('commentBodyLinkRequired');
  }
  if (message === 'FORM_PLAN_UNSAFE_SUBMIT') {
    return translate('unsafeSubmitBlocked');
  }
  if (message === 'COMMENT_FORM_REVEALED') {
    return translate('commentFormRevealed');
  }
  if (message === 'COMMENT_FORM_REVEAL_DISPATCHED') {
    return translate('commentFormRevealDispatched');
  }
  if (message === 'LOGIN_REQUIRED_SKIPPED') {
    return translate('batchSkippedLoginDescription');
  }
  if (message === 'CAPTCHA_REQUIRED_SKIPPED') {
    return translate('batchSkippedCaptchaDescription');
  }
  if (message === 'COMMENT_PUBLISHED_COMMENT_ANCHOR') {
    return translate('commentPublishedByAnchor');
  }
  if (message === 'COMMENT_PUBLISHED_RENDERED_FINGERPRINT') {
    return translate('commentPublishedByFingerprint');
  }
  if (message === 'COMMENT_PENDING_WORDPRESS_MODERATION') {
    return translate('commentPendingWordPressModeration');
  }
  if (message === 'COMMENT_PENDING_MODERATION_FEEDBACK') {
    return translate('commentPendingModerationFeedback');
  }
  if (message === 'COMMENT_SUBMISSION_UNCONFIRMED') {
    return translate('submissionUnconfirmed');
  }
  if (message === 'COMMENT_PUBLISHED_PUBLIC_CHECK') {
    return translate('commentPublishedByPublicCheck');
  }
  if (message === 'COMMENT_ACCEPTED_AWAITING_PUBLIC_CHECK') {
    return translate('commentAcceptedAwaitingPublicCheck');
  }
  if (message === 'COMMENT_ACCEPTED_NOT_PUBLIC_YET') {
    return translate('commentAcceptedNotPublicYet');
  }
  if (message === 'COMMENT_PUBLIC_CHECK_INCONCLUSIVE') {
    return translate('commentPublicCheckInconclusive');
  }
  if (message === 'COMMENT_NOT_PUBLIC') {
    return translate('commentNotPublic');
  }
  if (message === 'COMMENT_PUBLIC_LINK_STRIPPED') {
    return translate('commentPublicLinkStripped');
  }
  return null;
}

type BatchDiagnosticItem = Pick<BatchItem, 'url' | 'status' | 'message'> & {
  updatedAt?: number;
};

const failureDetailStatuses = new Set<BatchItemStatus>([
  'failed',
  'no_form',
  'validation_error',
  'link_stripped',
  'login_required',
  'captcha_required',
]);

function failureDetailFor(
  item: Pick<BatchItem, 'status' | 'message'>
): { message: string; friendly: string | null } | null {
  if (!failureDetailStatuses.has(item.status)) return null;
  const message = item.message.trim();
  if (!message) return null;
  return { message, friendly: batchItemMessageCopy(message) };
}

function batchItemDiagnostic(item: BatchDiagnosticItem): string {
  const lines = [
    `URL: ${item.url}`,
    `Status: ${item.status}`,
    `Error: ${item.message}`,
  ];
  if (item.updatedAt !== undefined) {
    lines.push(`Updated: ${new Date(item.updatedAt).toISOString()}`);
  }
  return lines.join('\n');
}

function pauseCopy(status?: BatchItemStatus): string {
  if (status === 'login_required') {
    return translate('batchPausedLoginDescription');
  }
  return translate('batchPausedCaptchaDescription');
}

function displayTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

function batchSummary(batch: BatchSnapshot): [string, string, string, string] {
  let published = 0;
  let pendingModeration = 0;
  let unconfirmed = 0;
  let failed = 0;

  for (const item of batch.items) {
    if (item.status === 'published') published += 1;
    else if (item.status === 'pending_moderation') pendingModeration += 1;
    else if (item.status === 'unconfirmed' || item.status === 'submitted') {
      unconfirmed += 1;
    } else if (
      item.status === 'no_form' ||
      item.status === 'validation_error' ||
      item.status === 'failed' ||
      // The comment is public and its link is not: nothing was gained.
      item.status === 'link_stripped'
    ) {
      failed += 1;
    }
  }

  return [
    String(published),
    String(pendingModeration),
    String(unconfirmed),
    String(failed),
  ];
}

function formatEventTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function activityCopy(status: BatchItemStatus): string[] {
  switch (status) {
    case 'opening':
      return [
        translate('activityOpeningTarget'),
        translate('activityWaitingForPage'),
      ];
    case 'analyzing':
      return [
        translate('activityAnalyzingContent'),
        translate('activityMappingForm'),
      ];
    case 'generating':
      return [
        translate('activityGeneratingContext'),
        translate('activityWritingComment'),
      ];
    case 'prepared':
      return [
        translate('activityPreparingFields'),
        translate('activityCheckingSubmit'),
      ];
    case 'click_dispatched':
      return [
        translate('activitySubmitting'),
        translate('activityWaitingResponse'),
      ];
    case 'verifying':
      return [
        translate('activityVerifyingPage'),
        translate('activityReadingFeedback'),
      ];
    default:
      return [batchItemStatusCopy(status)];
  }
}

function isTerminalItem(item: BatchItem): boolean {
  return [
    'submitted',
    'published',
    'pending_moderation',
    'link_stripped',
    'unconfirmed',
    'no_form',
    'validation_error',
    'failed',
    'filtered',
    'stopped',
  ].includes(item.status);
}

export default function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<BusyState>('idle');
  const [batch, setBatch] = useState<BatchSnapshot | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState<BatchHistoryEntry[]>([]);
  const [manuallyExpandedItemIds, setManuallyExpandedItemIds] = useState<
    Set<string>
  >(() => new Set());

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      restrictStorageToTrustedContexts(),
      getSettings(),
      getBatch(),
      getBatchHistory(),
    ]).then(([, storedSettings, storedBatch, storedHistory]) => {
      setSettings(storedSettings);
      setUiLocale(storedSettings.locale ?? DEFAULT_UI_LOCALE);
      setBatch(storedBatch);
      setHistory(storedHistory);
      setLoaded(true);
      if (!disposed) chrome.storage.onChanged.addListener(onStorageChanged);
    });

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== 'local') return;
      if (changes[BATCH_STORAGE_KEY]) {
        const changedBatch = batchSnapshotSchema.safeParse(
          changes[BATCH_STORAGE_KEY].newValue
        );
        if (changedBatch.success) {
          setBatch(changedBatch.data);
        } else {
          void getBatch().then(setBatch);
        }
      }
      if (changes[HISTORY_STORAGE_KEY]) void getBatchHistory().then(setHistory);
      if (changes[SETTINGS_STORAGE_KEY]) {
        const changedSettings = extensionSettingsSchema.safeParse(
          changes[SETTINGS_STORAGE_KEY].newValue
        );
        const applySettings = (nextSettings: ExtensionSettings) => {
          setUiLocale(nextSettings.locale ?? DEFAULT_UI_LOCALE);
          setSettings(nextSettings);
        };
        if (changedSettings.success) {
          applySettings(changedSettings.data);
        } else {
          void getSettings().then(applySettings);
        }
      }
    };
    return () => {
      disposed = true;
      chrome.storage.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  const batchIsActive =
    batch?.status === 'running' || batch?.status === 'paused';
  // hasResumableItems is the same check resumeStoppedBatch runs, so the button
  // is only offered when the request behind it can actually succeed.
  const canResumeStopped =
    batch?.status === 'stopped' && hasResumableItems(batch);
  const currentItem =
    batch && batch.currentIndex < batch.items.length
      ? batch.items[batch.currentIndex]
      : null;
  const canSkipCurrentManualGate =
    currentItem !== null &&
    currentItem.prepared === null &&
    (currentItem.status === 'login_required' ||
      currentItem.status === 'captcha_required');
  const currentPosition = batch
    ? batch.status === 'completed'
      ? batch.items.length
      : Math.min(batch.currentIndex + 1, batch.items.length)
    : 0;
  const completedBeforeCurrent = batch
    ? batch.status === 'completed' || batch.status === 'stopped'
      ? batch.items.filter((item) =>
          [
            'submitted',
            'published',
            'pending_moderation',
            'link_stripped',
            'unconfirmed',
            'no_form',
            'validation_error',
            'failed',
            'filtered',
          ].includes(item.status)
        ).length
      : batch.currentIndex
    : 0;

  async function runBatchCommand(
    type:
      | 'batch.continue'
      | 'batch.skip-current'
      | 'batch.stop'
      | 'batch.resume'
      | 'batch.reset'
      | 'batch.open-current',
    nextBusy: Exclude<BusyState, 'idle'>
  ) {
    setBusy(nextBusy);
    setError('');
    setNotice('');
    try {
      const response = await sendToBackground({ type });
      if (response.type !== type) throw new Error('BATCH_COMMAND_FAILED');
      setBatch(response.data);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy('idle');
    }
  }

  async function copyGeneratedComment(comment: string) {
    try {
      await navigator.clipboard.writeText(comment);
      setNotice(translate('generatedCommentCopied'));
      setError('');
    } catch {
      setError(translate('generatedCommentCopyFailed'));
    }
  }

  async function openDashboard() {
    setError('');
    try {
      await chrome.tabs.create({
        url: chrome.runtime.getURL('dashboard.html'),
      });
    } catch {
      setError(translate('dashboardOpenFailed'));
    }
  }

  async function copyDiagnostics(item: BatchDiagnosticItem) {
    try {
      await navigator.clipboard.writeText(batchItemDiagnostic(item));
      setNotice(translate('diagnosticsCopied'));
      setError('');
    } catch {
      setError(translate('diagnosticsCopyFailed'));
    }
  }

  if (!loaded) {
    return <main className="shell loading">{translate('analyzingPage')}</main>;
  }

  return (
    <main className="shell">
      <header className="masthead">
        <div className="brand-mark" aria-hidden="true">
          <span />
          <span />
        </div>
        <div className="brand-copy">
          <p className="eyebrow">{translate('workflowEyebrow')}</p>
          <h1>{translate('extensionName')}</h1>
        </div>
        <div className="masthead-actions">
          <button
            type="button"
            className="dashboard-link"
            aria-label={translate('openDashboard')}
            title={translate('openDashboard')}
            onClick={openDashboard}
          >
            <ChartLineUp size={15} weight="bold" aria-hidden="true" />
            {translate('openDashboard')}
          </button>
        </div>
      </header>

      <div className="model-strip">
        <span className="model-dot" />
        <span>
          {providerLabel(
            batchIsActive ? batch.settings.provider : settings.provider
          )}
        </span>
      </div>

      {!batch ? (
        <section className="panel idle-panel">
          <h2>{translate('batchIdleTitle')}</h2>
          <p>{translate('batchIdleDescription')}</p>
          <button
            type="button"
            className="primary-button full-width-button"
            onClick={openDashboard}
          >
            {translate('openDashboard')}
          </button>
        </section>
      ) : (
        <section className="panel batch-panel">
          <div className="batch-heading">
            <div>
              <p className="step-number">01</p>
              <h2>
                {batch.status === 'completed'
                  ? translate('batchCompletedTitle')
                  : batch.status === 'stopped'
                    ? translate('batchStoppedTitle')
                    : translate('batchProgressTitle')}
              </h2>
            </div>
            <strong>
              {translate('batchProgressCount', [
                String(currentPosition),
                String(batch.items.length),
              ])}
            </strong>
          </div>

          <progress
            className="batch-progress"
            max={batch.items.length}
            value={completedBeforeCurrent}
          />

          {batch.status === 'paused' && currentItem ? (
            <div className="pause-card" aria-live="polite">
              <p>{pauseCopy(currentItem.status)}</p>
              <div className="action-row">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy !== 'idle'}
                  onClick={() =>
                    runBatchCommand('batch.open-current', 'opening')
                  }
                >
                  {translate('openCurrentTarget')}
                </button>
                {canSkipCurrentManualGate ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy !== 'idle'}
                    onClick={() =>
                      runBatchCommand('batch.skip-current', 'skipping')
                    }
                  >
                    {translate('skipCurrentTarget')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy !== 'idle'}
                  onClick={() =>
                    runBatchCommand('batch.continue', 'continuing')
                  }
                >
                  {translate('continueBatch')}
                </button>
              </div>
            </div>
          ) : null}

          {batch.status === 'running' ? (
            <div className="action-row">
              <button
                type="button"
                className="secondary-button"
                disabled={busy !== 'idle'}
                onClick={() => runBatchCommand('batch.open-current', 'opening')}
              >
                {translate('openCurrentTarget')}
              </button>
              <button
                type="button"
                className="secondary-button stop-button"
                disabled={busy !== 'idle'}
                onClick={() => runBatchCommand('batch.stop', 'stopping')}
              >
                {translate('stopBatch')}
              </button>
            </div>
          ) : null}

          {batch.status === 'paused' ? (
            <button
              type="button"
              className="secondary-button stop-button full-width-button"
              disabled={busy !== 'idle'}
              onClick={() => runBatchCommand('batch.stop', 'stopping')}
            >
              {translate('stopBatch')}
            </button>
          ) : null}

          {batchIsActive ? (
            <p className="stop-hint">{translate('stopBatchHint')}</p>
          ) : (
            <>
              <p className="batch-summary">
                {translate('batchSummary', batchSummary(batch))}
              </p>
              {canResumeStopped ? (
                <>
                  <button
                    type="button"
                    className="primary-button full-width-button"
                    disabled={busy !== 'idle'}
                    onClick={() => runBatchCommand('batch.resume', 'resuming')}
                  >
                    {translate('resumeStoppedBatch')}
                  </button>
                  <p className="stop-hint">
                    {translate('resumeStoppedBatchHint')}
                  </p>
                </>
              ) : null}
              <button
                type="button"
                className={`${canResumeStopped ? 'secondary-button' : 'primary-button'} full-width-button`}
                disabled={busy !== 'idle'}
                onClick={() => runBatchCommand('batch.reset', 'resetting')}
              >
                {translate('startNewBatch')}
              </button>
            </>
          )}

          <section
            className="site-flow-section"
            aria-labelledby="site-flow-title"
          >
            <div className="site-flow-heading">
              <h3 id="site-flow-title">{translate('siteFlowTitle')}</h3>
              <span>{translate('backgroundWorkerNotice')}</span>
            </div>
            <div className="site-flow-list">
              {batch.items.map((item) => {
                const isCurrent = currentItem?.id === item.id;
                const detail = batchItemMessageCopy(item.message);
                const failureDetail = failureDetailFor(item);
                return (
                  <details
                    key={item.id}
                    data-site-id={item.id}
                    className={`site-flow-card status-${item.status}${
                      isCurrent ? ' is-current' : ''
                    }${isTerminalItem(item) ? ' is-terminal' : ''}`}
                    open={isCurrent || manuallyExpandedItemIds.has(item.id)}
                    onToggle={(event) => {
                      if (isCurrent) return;
                      const open = event.currentTarget.open;
                      setManuallyExpandedItemIds((current) => {
                        const next = new Set(current);
                        if (open) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      });
                    }}
                  >
                    <summary>
                      <span className="queue-index" aria-hidden="true" />
                      <span className="site-flow-summary-copy">
                        <a
                          className="site-flow-target-link"
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={item.url}
                          onClick={(event) => event.stopPropagation()}
                        >
                          {displayTarget(item.url)}
                        </a>
                        <small>{batchItemStatusCopy(item.status)}</small>
                      </span>
                      <time dateTime={new Date(item.updatedAt).toISOString()}>
                        {formatEventTime(item.updatedAt)}
                      </time>
                    </summary>

                    {isCurrent && batchIsActive ? (
                      <div className="live-activity" aria-live="polite">
                        <span className="live-dot" aria-hidden="true" />
                        <TextLoop
                          key={`${item.id}:${item.status}`}
                          className="activity-loop"
                          interval={2.2}
                        >
                          {activityCopy(item.status).map((copy) => (
                            <span key={copy}>{copy}</span>
                          ))}
                        </TextLoop>
                      </div>
                    ) : null}

                    <ol className="node-timeline">
                      {item.events.map((event, index) => {
                        const eventDetail = batchItemMessageCopy(event.message);
                        return (
                          <li key={`${event.status}:${event.at}:${index}`}>
                            <span className="node-marker" aria-hidden="true" />
                            <div>
                              <strong>
                                {batchItemStatusCopy(event.status)}
                              </strong>
                              {eventDetail ? <p>{eventDetail}</p> : null}
                            </div>
                            <time dateTime={new Date(event.at).toISOString()}>
                              {formatEventTime(event.at)}
                            </time>
                          </li>
                        );
                      })}
                    </ol>

                    {detail ? (
                      <p className="site-result-detail">{detail}</p>
                    ) : null}

                    {failureDetail ? (
                      <div className="site-diagnostics">
                        <code>{failureDetail.message}</code>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => copyDiagnostics(item)}
                        >
                          {translate('copyDiagnostics')}
                        </button>
                      </div>
                    ) : null}

                    {item.comment ? (
                      <details className="generated-comment">
                        <summary>{translate('generatedCommentLabel')}</summary>
                        <p>{item.comment}</p>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            copyGeneratedComment(item.comment ?? '')
                          }
                        >
                          {translate('copyGeneratedComment')}
                        </button>
                      </details>
                    ) : null}
                  </details>
                );
              })}
            </div>
          </section>
        </section>
      )}

      <section className="panel history-panel" aria-labelledby="history-title">
        <details className="history-section">
          <summary>
            <h3 id="history-title">{translate('batchHistoryTitle')}</h3>
          </summary>
          {history.length === 0 ? (
            <p className="history-empty">{translate('batchHistoryEmpty')}</p>
          ) : (
            <ul className="history-list">
              {history.map((entry) => {
                const failedItems = entry.items.filter((item) =>
                  isFailedHistoryStatus(item.status)
                );
                return (
                  <li key={entry.id}>
                    <details className="history-entry">
                      <summary>
                        <span className="history-entry-site">
                          {entry.settings.siteLabel ||
                            displayTarget(entry.settings.websiteUrl)}
                        </span>
                        <small>
                          {translate('batchSummary', [
                            String(entry.counts.published ?? 0),
                            String(entry.counts.pendingModeration ?? 0),
                            String(
                              entry.counts.unconfirmed ??
                                entry.counts.submitted ??
                                0
                            ),
                            String(entry.counts.failed),
                          ])}
                        </small>
                        <time
                          dateTime={new Date(entry.archivedAt).toISOString()}
                        >
                          {formatEventTime(entry.archivedAt)}
                        </time>
                      </summary>
                      <ul className="history-failed-list">
                        {failedItems.map((item) => {
                          const failureDetail = failureDetailFor(item);
                          return (
                            <li key={item.url} className="history-failed-item">
                              <div className="history-failed-copy">
                                <span title={item.url}>
                                  {displayTarget(item.url)}
                                </span>
                                <small>
                                  {batchItemStatusCopy(item.status)}
                                </small>
                                {failureDetail?.friendly ? (
                                  <p>{failureDetail.friendly}</p>
                                ) : null}
                                {failureDetail ? (
                                  <code>{failureDetail.message}</code>
                                ) : null}
                              </div>
                              {failureDetail ? (
                                <div className="history-failed-actions">
                                  <button
                                    type="button"
                                    className="text-button"
                                    onClick={() => copyDiagnostics(item)}
                                  >
                                    {translate('copyDiagnostics')}
                                  </button>
                                </div>
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
        </details>
      </section>

      {notice ? <p className="toast success-toast">{notice}</p> : null}
      {error ? <p className="toast error-toast">{error}</p> : null}
    </main>
  );
}
