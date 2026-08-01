import { isDueToday, nextPendingChunk, planProgress } from '@/batch/plan';
import type { BatchItem, BatchItemStatus, BatchSnapshot } from '@/batch/types';
import { parseTargetUrls } from '@/batch/urls';
import { TextLoop } from '@/components/core/text-loop';
import { translate } from '@/i18n';
import { sendToBackground } from '@/runtime/messages';
import { requestBatchOriginPermissions } from '@/runtime/permissions';
import { BATCH_STORAGE_KEY, getBatch } from '@/storage/batch';
import {
  type BatchHistoryEntry,
  HISTORY_STORAGE_KEY,
  getBatchHistory,
  isFailedHistoryStatus,
} from '@/storage/batch-history';
import { findMatchingFilterEntry, getFilterList } from '@/storage/filter-list';
import { PLANS_STORAGE_KEY, type PlansMap, getPlans } from '@/storage/plans';
import {
  DEFAULT_SETTINGS,
  extensionSettingsSchema,
  getActiveSite,
  getProviderApiKeys,
  getSettings,
  setSettings as persistSettings,
  restrictStorageToTrustedContexts,
  setProviderApiKeys,
} from '@/storage/settings';
import type { ExtensionSettings, ProviderApiKeys, SiteProfile } from '@/types';
import { type WebsiteProfile, normalizeWebsiteUrl } from '@/website/profile';
import { ChartLineUp } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';

type BusyState =
  | 'idle'
  | 'preparing'
  | 'refreshing'
  | 'starting'
  | 'continuing'
  | 'skipping'
  | 'stopping'
  | 'opening'
  | 'resetting'
  | 'retrying'
  | 'planning';

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
    case 'submitted':
      return translate('batchStatusSubmitted');
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
  return null;
}

type BatchDiagnosticItem = Pick<BatchItem, 'url' | 'status' | 'message'> & {
  updatedAt?: number;
};

const failureDetailStatuses = new Set<BatchItemStatus>([
  'failed',
  'no_form',
  'validation_error',
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

function friendlyRetryError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.split(':', 1)[0] || 'UNKNOWN_ERROR';
  // Retry failures originate in the batch state machine rather than comment
  // submission. Keep the machine-readable code visible until locale-specific
  // retry explanations are available.
  return `${translate('batchRetryItem')}: ${code}`;
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

function batchSummary(batch: BatchSnapshot): [string, string] {
  let submitted = 0;
  let failed = 0;

  for (const item of batch.items) {
    if (item.status === 'submitted') submitted += 1;
    else if (
      item.status === 'no_form' ||
      item.status === 'validation_error' ||
      item.status === 'failed'
    ) {
      failed += 1;
    }
  }

  return [String(submitted), String(failed)];
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
    'no_form',
    'validation_error',
    'failed',
    'filtered',
    'stopped',
  ].includes(item.status);
}

/**
 * The background remains the source of truth and repeats this check at batch
 * creation time. The sidepanel performs it first solely to avoid asking for
 * permissions, a website profile, or provider credentials for links that will
 * be skipped anyway.
 */
async function runnableTargetsFor(targetText: string): Promise<string[]> {
  const targets = parseTargetUrls(targetText);
  const filters = await getFilterList();
  return targets.filter((target) => !findMatchingFilterEntry(target, filters));
}

export default function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [apiKeys, setApiKeys] = useState<ProviderApiKeys>({
    deepseekApiKey: '',
    kieApiKey: '',
  });
  const [loaded, setLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState<BusyState>('idle');
  const [batch, setBatch] = useState<BatchSnapshot | null>(null);
  const [targetText, setTargetText] = useState('');
  const [websiteProfile, setWebsiteProfile] = useState<WebsiteProfile | null>(
    null
  );
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState<BatchHistoryEntry[]>([]);
  const [plans, setPlans] = useState<PlansMap>({});
  const [manuallyExpandedItemIds, setManuallyExpandedItemIds] = useState<
    Set<string>
  >(() => new Set());

  useEffect(() => {
    void Promise.all([
      restrictStorageToTrustedContexts(),
      getSettings(),
      getProviderApiKeys(),
      getBatch(),
      getBatchHistory(),
      getPlans(),
    ]).then(
      ([
        ,
        storedSettings,
        storedKeys,
        storedBatch,
        storedHistory,
        storedPlans,
      ]) => {
        setSettings(storedSettings);
        setApiKeys(storedKeys);
        setBatch(storedBatch);
        setHistory(storedHistory);
        setPlans(storedPlans);
        setLoaded(true);
      }
    );

    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== 'local') return;
      if (changes[BATCH_STORAGE_KEY]) void getBatch().then(setBatch);
      if (changes[HISTORY_STORAGE_KEY]) void getBatchHistory().then(setHistory);
      if (changes[PLANS_STORAGE_KEY]) void getPlans().then(setPlans);
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }, []);

  const activeSite = getActiveSite(settings);

  const configured = useMemo(
    () =>
      Boolean(
        activeSite.websiteUrl &&
          (settings.provider === 'deepseek'
            ? apiKeys.deepseekApiKey
            : apiKeys.kieApiKey)
      ),
    [apiKeys, settings.provider, activeSite.websiteUrl]
  );

  const targets = useMemo(() => {
    try {
      return parseTargetUrls(targetText);
    } catch {
      return [];
    }
  }, [targetText]);

  const siteLabelById = (siteId: string): string => {
    const site = settings.sites.find((candidate) => candidate.id === siteId);
    if (!site) return siteId;
    return site.label || displayTarget(site.websiteUrl) || siteId;
  };
  const planEntries = Object.values(plans);
  const duePlans = planEntries.filter((plan) => isDueToday(plan, Date.now()));
  const ranTodayPlans = planEntries.filter(
    (plan) => !isDueToday(plan, Date.now()) && nextPendingChunk(plan) !== null
  );

  const batchIsActive =
    batch?.status === 'running' || batch?.status === 'paused';
  const batchIsTerminal =
    batch?.status === 'completed' || batch?.status === 'stopped';
  const canRetryItem = (item: BatchItem): boolean =>
    batchIsTerminal &&
    (item.status === 'failed' ||
      item.status === 'no_form' ||
      item.status === 'validation_error');
  const retryableItemIds = batch
    ? batch.items.filter(canRetryItem).map((item) => item.id)
    : [];
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
            'no_form',
            'validation_error',
            'failed',
            'filtered',
          ].includes(item.status)
        ).length
      : batch.currentIndex
    : 0;

  const updateProvider = (provider: ExtensionSettings['provider']) =>
    setSettings((current) => ({ ...current, provider }));

  const selectActiveSite = (siteId: string) =>
    setSettings((current) => ({ ...current, activeSiteId: siteId }));

  const updateActiveSiteField = <Key extends keyof SiteProfile>(
    key: Key,
    value: SiteProfile[Key]
  ) =>
    setSettings((current) => ({
      ...current,
      sites: current.sites.map((site) =>
        site.id === current.activeSiteId ? { ...site, [key]: value } : site
      ),
    }));

  const addSite = () =>
    setSettings((current) => {
      const site: SiteProfile = {
        id: globalThis.crypto.randomUUID(),
        label: '',
        websiteUrl: '',
        displayName: '',
        email: '',
        linkMode: 'prefer-website-field',
      };
      return {
        ...current,
        sites: [...current.sites, site],
        activeSiteId: site.id,
      };
    });

  const removeActiveSite = () =>
    setSettings((current) => {
      if (current.sites.length <= 1) return current;
      const remaining = current.sites.filter(
        (site) => site.id !== current.activeSiteId
      );
      return {
        ...current,
        sites: remaining,
        activeSiteId: remaining[0]?.id ?? current.activeSiteId,
      };
    });

  const updateApiKey = <Key extends keyof ProviderApiKeys>(
    key: Key,
    value: ProviderApiKeys[Key]
  ) => setApiKeys((current) => ({ ...current, [key]: value }));

  async function persistConfiguration(permissionUrls?: string[]) {
    const normalized = extensionSettingsSchema.parse({
      ...settings,
      sites: settings.sites.map((site) => ({
        ...site,
        websiteUrl: site.websiteUrl.trim()
          ? normalizeWebsiteUrl(site.websiteUrl)
          : '',
      })),
    });
    if (permissionUrls) {
      const selectedKey =
        settings.provider === 'deepseek'
          ? apiKeys.deepseekApiKey
          : apiKeys.kieApiKey;
      if (!selectedKey.trim()) {
        throw new Error(
          settings.provider === 'deepseek'
            ? 'DEEPSEEK_API_KEY_REQUIRED'
            : 'KIE_API_KEY_REQUIRED'
        );
      }
      if (!getActiveSite(normalized).websiteUrl) {
        throw new Error('WEBSITE_URL_REQUIRED');
      }
      const granted = await requestBatchOriginPermissions(permissionUrls);
      if (!granted) throw new Error('ORIGIN_PERMISSION_DENIED');
    }
    const normalizedKeys = await setProviderApiKeys(apiKeys);
    await persistSettings(normalized);
    setSettings(normalized);
    setApiKeys(normalizedKeys);
    return normalized;
  }

  async function saveConfiguration() {
    setError('');
    setNotice('');
    try {
      await persistConfiguration();
      setWebsiteProfile(null);
      setNotice(translate('settingsSaved'));
    } catch (caught) {
      const raw = caught instanceof Error ? caught.message : String(caught);
      if (
        raw.includes('websiteUrl') ||
        raw.includes('WEBSITE_URL') ||
        raw.toLowerCase().includes('invalid url')
      ) {
        setError(translate('invalidWebsiteUrl'));
      } else setError(translate('settingsSaveFailed'));
    }
  }

  async function prepareBatch() {
    setBusy('preparing');
    setError('');
    setNotice('');
    try {
      const runnableTargets = await runnableTargetsFor(targetText);
      if (runnableTargets.length === 0) {
        const response = await sendToBackground({
          type: 'batch.start',
          targetText,
          siteId: settings.activeSiteId,
        });
        if (response.type !== 'batch.start') {
          throw new Error('BATCH_START_FAILED');
        }
        setBatch(response.data);
        setWebsiteProfile(null);
        return;
      }
      if (!configured) {
        setSettingsOpen(true);
        setError(translate('missingSettings'));
        return;
      }
      const normalizedWebsiteUrl = normalizeWebsiteUrl(activeSite.websiteUrl);
      const normalized = await persistConfiguration([normalizedWebsiteUrl]);
      const response = await sendToBackground({
        type: 'batch.preview',
        websiteUrl: getActiveSite(normalized).websiteUrl,
      });
      if (response.type !== 'batch.preview') {
        throw new Error('BATCH_PREVIEW_FAILED');
      }
      setWebsiteProfile(response.data);
    } catch (caught) {
      const raw = caught instanceof Error ? caught.message : String(caught);
      if (raw.includes('websiteUrl')) {
        setError(translate('invalidWebsiteUrl'));
      } else if (raw.includes('TARGET_URL_')) {
        setError(translate('invalidTargetUrls'));
      } else setError(friendlyError(caught));
    } finally {
      setBusy('idle');
    }
  }

  async function refreshWebsiteProfile() {
    setBusy('refreshing');
    setError('');
    setNotice('');
    try {
      const response = await sendToBackground({
        type: 'batch.preview',
        websiteUrl: activeSite.websiteUrl,
        refresh: true,
      });
      if (response.type !== 'batch.preview') {
        throw new Error('BATCH_PREVIEW_FAILED');
      }
      setWebsiteProfile(response.data);
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy('idle');
    }
  }

  async function startBatch() {
    setBusy('starting');
    setError('');
    setNotice('');
    try {
      const runnableTargets = await runnableTargetsFor(targetText);
      if (runnableTargets.length > 0 && !websiteProfile) return;

      if (runnableTargets.length > 0) {
        const normalizedWebsiteUrl = normalizeWebsiteUrl(activeSite.websiteUrl);
        await persistConfiguration([normalizedWebsiteUrl, ...runnableTargets]);
      }

      const response = await sendToBackground({
        type: 'batch.start',
        targetText,
        ...(runnableTargets.length > 0 && websiteProfile
          ? { websiteProfile }
          : {}),
        siteId: settings.activeSiteId,
      });
      if (response.type !== 'batch.start') {
        throw new Error('BATCH_START_FAILED');
      }
      setBatch(response.data);
      setWebsiteProfile(null);
    } catch (caught) {
      const raw = caught instanceof Error ? caught.message : String(caught);
      if (raw.includes('websiteUrl')) {
        setError(translate('invalidWebsiteUrl'));
      } else if (raw.includes('TARGET_URL_')) {
        setError(translate('invalidTargetUrls'));
      } else setError(friendlyError(caught));
    } finally {
      setBusy('idle');
    }
  }

  async function runBatchCommand(
    type:
      | 'batch.continue'
      | 'batch.skip-current'
      | 'batch.stop'
      | 'batch.reset'
      | 'batch.open-current',
    nextBusy: Exclude<BusyState, 'idle' | 'preparing' | 'starting'>
  ) {
    setBusy(nextBusy);
    setError('');
    setNotice('');
    try {
      const response = await sendToBackground({ type });
      if (response.type !== type) throw new Error('BATCH_COMMAND_FAILED');
      setBatch(response.data);
      if (type === 'batch.reset') {
        setTargetText('');
        setWebsiteProfile(null);
      }
    } catch (caught) {
      setError(friendlyError(caught));
    } finally {
      setBusy('idle');
    }
  }

  async function retryBatchItems(itemIds: string[]) {
    if (itemIds.length === 0) return;
    setBusy('retrying');
    setError('');
    setNotice('');
    try {
      const response = await sendToBackground({
        type: 'batch.retry-items',
        itemIds,
      });
      if (response.type !== 'batch.retry-items') {
        throw new Error('BATCH_COMMAND_FAILED');
      }
      setBatch(response.data);
    } catch (caught) {
      setError(friendlyRetryError(caught));
    } finally {
      setBusy('idle');
    }
  }

  async function retryFromHistory(historyId: string, urls?: string[]) {
    if (batchIsActive) return;
    setBusy('retrying');
    setError('');
    setNotice('');
    try {
      const response = await sendToBackground(
        urls
          ? { type: 'batch.retry-from-history', historyId, urls }
          : { type: 'batch.retry-from-history', historyId }
      );
      if (response.type !== 'batch.retry-from-history') {
        throw new Error('BATCH_COMMAND_FAILED');
      }
      setBatch(response.data);
      setWebsiteProfile(null);
      setTargetText('');
    } catch (caught) {
      setError(friendlyRetryError(caught));
    } finally {
      setBusy('idle');
    }
  }

  async function runPlan(siteId: string) {
    if (batchIsActive) return;
    setBusy('planning');
    setError('');
    setNotice('');
    try {
      const response = await sendToBackground({
        type: 'plan.run-next',
        siteId,
      });
      if (response.type !== 'plan.run-next') {
        throw new Error('PLAN_RUN_FAILED');
      }
      setBatch(response.data);
      setWebsiteProfile(null);
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
          {!settingsOpen ? (
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
          ) : null}
          <button
            type="button"
            className="text-button"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            {translate(settingsOpen ? 'backToQueue' : 'openSettings')}
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

      {!settingsOpen &&
      !batchIsActive &&
      (duePlans.length > 0 || ranTodayPlans.length > 0) ? (
        <section className="plan-due-banners" aria-live="polite">
          {duePlans.map((plan) => {
            const { done, total } = planProgress(plan);
            const chunk = nextPendingChunk(plan);
            return (
              <div key={plan.siteId} className="plan-due-banner">
                <p>
                  {translate('planDueBanner', [
                    siteLabelById(plan.siteId),
                    String(done + 1),
                    String(total),
                    String(chunk?.urls.length ?? 0),
                  ])}
                </p>
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy !== 'idle'}
                  onClick={() => runPlan(plan.siteId)}
                >
                  {translate('planRunNext')}
                </button>
              </div>
            );
          })}
          {ranTodayPlans.map((plan) => (
            <p key={plan.siteId} className="plan-done-today">
              {translate('planDoneToday', [siteLabelById(plan.siteId)])}
            </p>
          ))}
        </section>
      ) : null}

      {settingsOpen ? (
        <section
          className="panel settings-panel"
          aria-labelledby="settings-title"
        >
          <div className="section-heading">
            <div>
              <h2 id="settings-title">{translate('settingsTitle')}</h2>
              <p>{translate('settingsDescription')}</p>
            </div>
          </div>

          <div className="form-grid">
            <label className="field field-wide">
              <span>{translate('deepSeekApiKeyLabel')}</span>
              <input
                type="password"
                value={apiKeys.deepseekApiKey}
                disabled={batchIsActive}
                onChange={(event) =>
                  updateApiKey('deepseekApiKey', event.target.value)
                }
                placeholder={translate('deepSeekApiKeyPlaceholder')}
                autoComplete="off"
              />
            </label>
            <label className="field field-wide">
              <span>{translate('kieApiKeyLabel')}</span>
              <input
                type="password"
                value={apiKeys.kieApiKey}
                disabled={batchIsActive}
                onChange={(event) =>
                  updateApiKey('kieApiKey', event.target.value)
                }
                placeholder={translate('kieApiKeyPlaceholder')}
                autoComplete="off"
              />
            </label>
            <div className="field field-wide site-manager">
              <span>{translate('siteSelectorLabel')}</span>
              <div className="site-manager-controls">
                <select
                  value={settings.activeSiteId}
                  disabled={batchIsActive}
                  onChange={(event) => {
                    selectActiveSite(event.target.value);
                    setWebsiteProfile(null);
                  }}
                >
                  {settings.sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.label ||
                        displayTarget(site.websiteUrl) ||
                        translate('siteUnnamed')}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="text-button"
                  disabled={batchIsActive}
                  onClick={addSite}
                >
                  {translate('siteAdd')}
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={batchIsActive || settings.sites.length <= 1}
                  onClick={removeActiveSite}
                >
                  {translate('siteRemove')}
                </button>
              </div>
            </div>
            <label className="field field-wide">
              <span>{translate('siteLabelField')}</span>
              <input
                value={activeSite.label}
                disabled={batchIsActive}
                onChange={(event) =>
                  updateActiveSiteField('label', event.target.value)
                }
                placeholder={translate('siteLabelPlaceholder')}
              />
            </label>
            <label className="field field-wide">
              <span>{translate('websiteUrlLabel')}</span>
              <input
                value={activeSite.websiteUrl}
                disabled={batchIsActive}
                onChange={(event) => {
                  updateActiveSiteField('websiteUrl', event.target.value);
                  setWebsiteProfile(null);
                }}
                placeholder={translate('websiteUrlPlaceholder')}
                inputMode="url"
              />
            </label>
            <label className="field">
              <span>{translate('providerLabel')}</span>
              <select
                value={settings.provider}
                disabled={batchIsActive}
                onChange={(event) =>
                  updateProvider(
                    event.target.value as ExtensionSettings['provider']
                  )
                }
              >
                <option value="deepseek">
                  {translate('providerDeepSeek')}
                </option>
                <option value="kie-gemini">
                  {translate('providerKieGemini')}
                </option>
              </select>
            </label>
            <label className="field">
              <span>{translate('linkModeLabel')}</span>
              <select
                value={activeSite.linkMode}
                disabled={batchIsActive}
                onChange={(event) =>
                  updateActiveSiteField(
                    'linkMode',
                    event.target.value as SiteProfile['linkMode']
                  )
                }
              >
                <option value="prefer-website-field">
                  {translate('linkModePreferWebsiteField')}
                </option>
                <option value="inline">{translate('linkModeInline')}</option>
              </select>
            </label>
            <label className="field">
              <span>{translate('displayNameLabel')}</span>
              <input
                value={activeSite.displayName}
                disabled={batchIsActive}
                onChange={(event) =>
                  updateActiveSiteField('displayName', event.target.value)
                }
                placeholder={translate('displayNamePlaceholder')}
              />
            </label>
            <label className="field">
              <span>{translate('emailLabel')}</span>
              <input
                type="email"
                value={activeSite.email}
                disabled={batchIsActive}
                onChange={(event) =>
                  updateActiveSiteField('email', event.target.value)
                }
                placeholder={translate('emailPlaceholder')}
              />
            </label>
          </div>
          <p className="security-note">{translate('apiKeySecurityNote')}</p>
          <button
            type="button"
            className="primary-button"
            disabled={batchIsActive || busy !== 'idle'}
            onClick={saveConfiguration}
          >
            {translate('saveSettings')}
          </button>
        </section>
      ) : !batch ? (
        <>
          <section className="panel workspace-panel">
            <div className="section-heading">
              <p className="step-number">01</p>
              <div>
                <h2>{translate('batchSetupTitle')}</h2>
                <p>{translate('batchSetupDescription')}</p>
              </div>
            </div>

            <label className="field">
              <span>{translate('siteSelectorLabel')}</span>
              <select
                value={settings.activeSiteId}
                onChange={(event) => {
                  selectActiveSite(event.target.value);
                  setWebsiteProfile(null);
                }}
              >
                {settings.sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.label ||
                      displayTarget(site.websiteUrl) ||
                      translate('siteUnnamed')}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>{translate('targetUrlsLabel')}</span>
              <textarea
                className="target-editor"
                value={targetText}
                onChange={(event) => {
                  setTargetText(event.target.value);
                  setWebsiteProfile(null);
                }}
                placeholder={translate('targetUrlsPlaceholder')}
                rows={7}
              />
              <small className="field-hint">
                {translate('targetUrlsHint')}
              </small>
            </label>

            <button
              type="button"
              className="primary-button full-width-button"
              disabled={busy !== 'idle'}
              onClick={prepareBatch}
            >
              {busy === 'preparing'
                ? translate('preparingBatch')
                : translate('prepareBatch')}
            </button>
          </section>

          {websiteProfile ? (
            <section className="panel review-panel">
              <div className="section-heading">
                <p className="step-number">02</p>
                <div>
                  <h2>{translate('batchReviewTitle')}</h2>
                  <p>
                    {translate('targetUrlsSummary', String(targets.length))}
                  </p>
                </div>
              </div>

              <div className="profile-card">
                <div className="profile-card-heading">
                  <p className="profile-label">
                    {translate('websiteProfileTitle')}
                  </p>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy !== 'idle'}
                    onClick={refreshWebsiteProfile}
                  >
                    {busy === 'refreshing'
                      ? translate('refreshingWebsiteProfile')
                      : translate('refreshWebsiteProfile')}
                  </button>
                </div>
                <dl>
                  <div>
                    <dt>{translate('websiteUrlLabel')}</dt>
                    <dd>{websiteProfile.url}</dd>
                  </div>
                  <div>
                    <dt>{translate('metaTitleLabel')}</dt>
                    <dd>{websiteProfile.title}</dd>
                  </div>
                  <div>
                    <dt>{translate('metaDescriptionLabel')}</dt>
                    <dd>{websiteProfile.description}</dd>
                  </div>
                </dl>
              </div>

              <p className="confirmation-note">
                {translate('batchConfirmationNotice', String(targets.length))}
              </p>
              <button
                type="button"
                className="publish-button full-width-button"
                disabled={busy !== 'idle'}
                onClick={startBatch}
              >
                {busy === 'starting'
                  ? translate('startingBatch')
                  : translate('confirmAndStartBatch')}
              </button>
            </section>
          ) : null}
        </>
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
              {retryableItemIds.length > 0 ? (
                <button
                  type="button"
                  className="secondary-button full-width-button"
                  disabled={busy !== 'idle'}
                  onClick={() => retryBatchItems(retryableItemIds)}
                >
                  {translate('batchRetryFailed')}
                </button>
              ) : null}
              <button
                type="button"
                className="primary-button full-width-button"
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

                    {failureDetail || canRetryItem(item) ? (
                      <div className="site-diagnostics">
                        {failureDetail ? (
                          <>
                            <code>{failureDetail.message}</code>
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => copyDiagnostics(item)}
                            >
                              {translate('copyDiagnostics')}
                            </button>
                          </>
                        ) : null}
                        {canRetryItem(item) ? (
                          <button
                            type="button"
                            className="text-button"
                            disabled={busy !== 'idle'}
                            onClick={() => retryBatchItems([item.id])}
                          >
                            {translate('batchRetryItem')}
                          </button>
                        ) : null}
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

      {!settingsOpen ? (
        <section
          className="panel history-panel"
          aria-labelledby="history-title"
        >
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
                              String(entry.counts.submitted),
                              String(entry.counts.failed),
                            ])}
                          </small>
                          <time
                            dateTime={new Date(entry.archivedAt).toISOString()}
                          >
                            {formatEventTime(entry.archivedAt)}
                          </time>
                        </summary>
                        {entry.counts.failed > 0 ? (
                          <button
                            type="button"
                            className="secondary-button full-width-button"
                            disabled={busy !== 'idle' || batchIsActive}
                            onClick={() => retryFromHistory(entry.id)}
                          >
                            {translate('batchHistoryRetryFailed')}
                          </button>
                        ) : null}
                        <ul className="history-failed-list">
                          {failedItems.map((item) => {
                            const failureDetail = failureDetailFor(item);
                            return (
                              <li
                                key={item.url}
                                className="history-failed-item"
                              >
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
                                <div className="history-failed-actions">
                                  {failureDetail ? (
                                    <button
                                      type="button"
                                      className="text-button"
                                      onClick={() => copyDiagnostics(item)}
                                    >
                                      {translate('copyDiagnostics')}
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="text-button"
                                    disabled={busy !== 'idle' || batchIsActive}
                                    onClick={() =>
                                      retryFromHistory(entry.id, [item.url])
                                    }
                                  >
                                    {translate('batchHistoryRetryUrl')}
                                  </button>
                                </div>
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
      ) : null}

      {notice ? <p className="toast success-toast">{notice}</p> : null}
      {error ? <p className="toast error-toast">{error}</p> : null}
    </main>
  );
}
