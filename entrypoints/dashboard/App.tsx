import type { BatchItem, BatchSnapshot } from '@/batch/types';
import type {
  DashboardSummary,
  Plan,
  PlanBatch,
  RecentFailureSummary,
  ScheduledBatchSummary,
  TargetHostSummary,
} from '@/dashboard/model';
import { parseDashboardTargetRows } from '@/dashboard/target-import';
import { translate } from '@/i18n';
import {
  type DashboardSummaryView,
  sendToBackground,
} from '@/runtime/messages';
import { requestBatchOriginPermissions } from '@/runtime/permissions';
import { BATCH_STORAGE_KEY } from '@/storage/batch';
import {
  type FilterEntryKind,
  type FilterListEntry,
  findMatchingFilterEntry,
} from '@/storage/filter-list';
import {
  OUTBOUND_LINK_LIBRARY_STORAGE_KEY,
  OUTBOUND_LINK_TAGS,
  type OutboundLinkLibraryEntry,
  type OutboundLinkTag,
  normalizeOutboundLinkUrl,
} from '@/storage/outbound-link-library';
import type { ExtensionSettings } from '@/types';
import { normalizeWebsiteUrl } from '@/website/profile';
import {
  Archive,
  ArrowClockwise,
  ArrowSquareOut,
  CalendarBlank,
  CaretDown,
  Check,
  CheckCircle,
  CircleNotch,
  ClipboardText,
  ClockCountdown,
  Copy,
  Database,
  Eye,
  FileText,
  FunnelSimple,
  GearSix,
  GlobeHemisphereWest,
  House,
  LinkSimple,
  ListBullets,
  PencilSimple,
  Play,
  Plus,
  Pulse,
  SpinnerGap,
  Stop,
  Trash,
  UploadSimple,
  Warning,
  WarningCircle,
  WifiHigh,
  X,
} from '@phosphor-icons/react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import {
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ModerationRecheckPage } from './ModerationRecheckPage';
import {
  DASHBOARD_REVISION_KEY,
  dashboardRequest,
  isPreviewMode,
  loadActiveBatch,
  loadDashboardSummary,
  loadPlans,
  loadSettings,
} from './api';
import { locale, t } from './copy';
import type {
  PlanDetail,
  PlanTarget,
  PlanTargetWithAttempts,
  PlanTargetsPage,
} from './native-types';

type Route =
  | { page: 'dashboard' }
  | { page: 'moderation' }
  | { page: 'plans'; planId?: string };

type IconComponent = PhosphorIcon;

interface Toast {
  id: number;
  kind: 'success' | 'error';
  message: string;
}

interface ParsedUrls {
  valid: string[];
  duplicates: string[];
  invalid: string[];
}

const PAGE_SIZE = 100;

const EMPTY_SUMMARY: DashboardSummaryView = {
  activePlanCount: 0,
  counts: {
    total: 0,
    processed: 0,
    submitted: 0,
    failed: 0,
    pending: 0,
    running: 0,
    blocked: 0,
    interrupted: 0,
    filtered: 0,
    unknown: 0,
  },
  todaySchedule: [],
  nextSchedule: [],
  promotingSites: [],
  targetHosts: [],
  recentFailures: [],
  activeRun: null,
};

function readRoute(): Route {
  const hash = globalThis.location?.hash || '#/dashboard';
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'plans') {
    return { page: 'plans', planId: parts[1] };
  }
  if (parts[0] === 'moderation') return { page: 'moderation' };
  return { page: 'dashboard' };
}

function navigate(route: Route) {
  if (route.page === 'dashboard') globalThis.location.hash = '#/dashboard';
  else if (route.page === 'moderation') {
    globalThis.location.hash = '#/moderation';
  } else {
    globalThis.location.hash = route.planId
      ? `#/plans/${encodeURIComponent(route.planId)}`
      : '#/plans';
  }
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    if (!globalThis.location.hash) navigate({ page: 'dashboard' });
    const onHashChange = () => setRoute(readRoute());
    globalThis.addEventListener('hashchange', onHashChange);
    return () => globalThis.removeEventListener('hashchange', onHashChange);
  }, []);
  return route;
}

function displayDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

function displayTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./i, '')}${
      parsed.pathname === '/' ? '' : parsed.pathname
    }`;
  } catch {
    return url;
  }
}

function formatDate(timestamp = Date.now()): string {
  return new Intl.DateTimeFormat(locale(), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(timestamp);
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return '—';
  return new Intl.DateTimeFormat(locale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function formatShortDate(timestamp?: number): string {
  if (!timestamp) return t('waitingToRun');
  return new Intl.DateTimeFormat(locale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

function planBatchCount(plan: Plan): number {
  return Math.max(1, Math.ceil(plan.targetCount / plan.chunkSize));
}

function completedBatchCount(plan: Plan): number {
  if (plan.targetCount === 0) return 0;
  return Math.min(
    planBatchCount(plan),
    Math.floor(plan.processedCount / plan.chunkSize)
  );
}

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
}

function isFailedTarget(status: string): boolean {
  return (
    status === 'failed' || status === 'no_form' || status === 'validation_error'
  );
}

function isFinishedBatch(status: PlanBatch['status']): boolean {
  return status === 'completed' || status === 'completed_with_errors';
}

function planStatusCopy(status: Plan['status']): string {
  if (status === 'completed') return t('completed');
  if (status === 'archived') return t('archived');
  return t('active');
}

function batchStatusCopy(status: PlanBatch['status']): string {
  if (status === 'completed') return t('completed');
  if (status === 'completed_with_errors') return t('completedWithErrors');
  if (status === 'running') return t('running');
  if (status === 'blocked') return t('blocked');
  if (status === 'interrupted') return t('interrupted');
  return t('nextBatch');
}

function targetStatusCopy(status: string): string {
  switch (status) {
    case 'published':
      return t('publishedStatus');
    case 'pending_moderation':
      return t('pendingModerationStatus');
    case 'unconfirmed':
      return t('unconfirmedStatus');
    case 'submitted':
      return t('unconfirmedStatus');
    case 'failed':
      return t('failedStatus');
    case 'filtered':
      return t('filteredStatus');
    case 'no_form':
      return t('noFormStatus');
    case 'validation_error':
      return t('validationErrorStatus');
    case 'running':
      return t('running');
    case 'queued':
      return t('queuedStatus');
    case 'opening':
      return t('openingStatus');
    case 'analyzing':
      return t('analyzingStatus');
    case 'generating':
      return t('generatingStatus');
    case 'prepared':
      return t('preparedStatus');
    case 'click_dispatched':
      return t('submittingStatus');
    case 'verifying':
      return t('verifyingStatus');
    case 'blocked':
      return t('blocked');
    case 'login_required':
      return t('loginRequiredStatus');
    case 'captcha_required':
      return t('captchaRequiredStatus');
    case 'interrupted':
    case 'stopped':
      return t('stoppedStatus');
    case 'unknown':
      return t('unknownStatus');
    default:
      return t('pendingStatus');
  }
}

function friendlyReason(target: PlanTargetWithAttempts): string {
  const errorCode = target.lastError?.code || target.latestMessage;
  if (errorCode === 'COMMENT_BODY_LINK_REQUIRED') {
    return t('commentBodyLinkRequiredReason');
  }
  if (target.lastError?.friendlyMessage) {
    return target.lastError.friendlyMessage;
  }
  if (target.status === 'no_form') return t('noCommentFormReason');
  if (target.status === 'validation_error') return t('validationReason');
  if (target.status === 'blocked') return t('unknownErrorReason');
  return target.latestMessage || t('genericFailureReason');
}

function parseUrlInput(text: string): ParsedUrls {
  const parsedRows = parseDashboardTargetRows(text);
  const valid: string[] = [];
  const duplicates: string[] = [];
  const invalid = parsedRows.invalidLineNumbers.map(
    (lineNumber) => `line:${lineNumber}`
  );
  const seen = new Set<string>();
  for (const { value: candidate } of parsedRows.candidates) {
    try {
      const url = new URL(candidate);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        candidate.length > 2_048
      ) {
        invalid.push(candidate);
        continue;
      }
      url.hash = '';
      const normalized = url.href.replace(/\/$/, '');
      if (seen.has(normalized)) duplicates.push(candidate);
      else {
        seen.add(normalized);
        valid.push(normalized);
      }
    } catch {
      invalid.push(candidate);
    }
  }
  return { valid, duplicates, invalid };
}

function batchCounts(batch: BatchSnapshot | null) {
  if (!batch) {
    return { total: 0, processed: 0, submitted: 0, failed: 0, remaining: 0 };
  }
  let submitted = 0;
  let unconfirmed = 0;
  let failed = 0;
  for (const item of batch.items) {
    if (item.status === 'published' || item.status === 'pending_moderation') {
      submitted += 1;
    } else if (item.status === 'unconfirmed' || item.status === 'submitted') {
      unconfirmed += 1;
    } else if (isFailedTarget(item.status)) failed += 1;
  }
  const processed = submitted + unconfirmed + failed;
  return {
    total: batch.items.length,
    processed,
    submitted,
    failed,
    remaining: Math.max(0, batch.items.length - processed),
  };
}

function planMatchesBatch(plan: Plan | undefined, batch: BatchSnapshot | null) {
  if (!plan || !batch) return false;
  return (
    batch.settings.siteId === plan.promotingSiteId ||
    batch.settings.websiteUrl.replace(/\/+$/, '') ===
      plan.promotingWebsiteUrl.replace(/\/+$/, '')
  );
}

function currentBatchItem(batch: BatchSnapshot | null): BatchItem | undefined {
  if (!batch) return undefined;
  return batch.items[Math.min(batch.currentIndex, batch.items.length - 1)];
}

async function loadAllBatchTargets(
  planId: string,
  batchId: string
): Promise<PlanTargetWithAttempts[]> {
  const first = await dashboardRequest<PlanTargetsPage>({
    type: 'plan.getTargets',
    planId,
    batchId,
    page: 1,
    pageSize: PAGE_SIZE,
  });
  if (first.totalPages <= 1) return first.items;
  const remaining = await Promise.all(
    Array.from({ length: first.totalPages - 1 }, (_, index) =>
      dashboardRequest<PlanTargetsPage>({
        type: 'plan.getTargets',
        planId,
        batchId,
        page: index + 2,
        pageSize: PAGE_SIZE,
      })
    )
  );
  return [first, ...remaining].flatMap((page) => page.items);
}

async function filterPermissionUrls(
  plan: Plan,
  urls: readonly string[]
): Promise<string[]> {
  if (urls.length === 0) return [];
  if (isPreviewMode()) return [plan.promotingWebsiteUrl, ...urls];
  const { data: filters } = await sendToBackground({ type: 'filter.list' });
  const runnableUrls = urls.filter(
    (url) => !findMatchingFilterEntry(url, filters)
  );
  return runnableUrls.length > 0
    ? [plan.promotingWebsiteUrl, ...runnableUrls]
    : [];
}

async function resolvePermissionUrls(
  plan: Plan,
  action: 'run' | 'resume' | 'retry',
  targetIds: string[] = [],
  knownUrls: string[] = []
): Promise<string[]> {
  if (knownUrls.length > 0) {
    return filterPermissionUrls(plan, knownUrls);
  }
  const detail = await dashboardRequest<PlanDetail>({
    type: 'plan.getDetail',
    planId: plan.id,
  });
  const preferredBatch =
    action === 'run'
      ? detail.batches.find((batch) => batch.status === 'pending')
      : detail.batches.find((batch) =>
          ['interrupted', 'blocked', 'running'].includes(batch.status)
        );
  const batches =
    action === 'retry'
      ? detail.batches
      : preferredBatch
        ? [preferredBatch]
        : [];
  const targetPages = await Promise.all(
    batches.map((batch) => loadAllBatchTargets(plan.id, batch.id))
  );
  const allTargets = targetPages.flat();
  const selected =
    targetIds.length > 0
      ? allTargets.filter((target) => targetIds.includes(target.id))
      : allTargets;
  return filterPermissionUrls(
    plan,
    selected.map((target) => target.url)
  );
}

function IconButton({
  label,
  children,
  onClick,
  disabled,
  className = '',
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: IconComponent;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">
        <Icon size={27} aria-hidden />
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <LinkSimple size={25} weight="bold" />
    </span>
  );
}

function Sidebar({
  route,
  settingsOpen,
  filterListOpen,
  outboundLinkLibraryOpen,
  onOpenFilterList,
  onOpenOutboundLinkLibrary,
  onOpenSettings,
}: {
  route: Route;
  settingsOpen: boolean;
  filterListOpen: boolean;
  outboundLinkLibraryOpen: boolean;
  onOpenFilterList: () => void;
  onOpenOutboundLinkLibrary: () => void;
  onOpenSettings: () => void;
}) {
  const isConnected = !isPreviewMode();
  return (
    <aside className="app-sidebar">
      <div className="sidebar-brand">
        <BrandMark />
        <span>{t('appName')}</span>
      </div>
      <nav className="main-navigation" aria-label={t('appName')}>
        <button
          type="button"
          className={route.page === 'dashboard' ? 'is-active' : ''}
          aria-current={route.page === 'dashboard' ? 'page' : undefined}
          onClick={() => navigate({ page: 'dashboard' })}
        >
          <House
            size={22}
            weight={route.page === 'dashboard' ? 'fill' : 'regular'}
          />
          <span>{t('dashboard')}</span>
        </button>
        <button
          type="button"
          className={route.page === 'plans' ? 'is-active' : ''}
          aria-current={route.page === 'plans' ? 'page' : undefined}
          onClick={() => navigate({ page: 'plans' })}
        >
          <ClipboardText
            size={22}
            weight={route.page === 'plans' ? 'fill' : 'regular'}
          />
          <span>{t('plans')}</span>
        </button>
        <button
          type="button"
          className={route.page === 'moderation' ? 'is-active' : ''}
          aria-current={route.page === 'moderation' ? 'page' : undefined}
          onClick={() => navigate({ page: 'moderation' })}
        >
          <ClockCountdown
            size={22}
            weight={route.page === 'moderation' ? 'fill' : 'regular'}
          />
          <span>{locale() === 'zh-CN' ? '定时复查' : 'Rechecks'}</span>
        </button>
        <button
          type="button"
          className={filterListOpen ? 'is-active' : ''}
          aria-expanded={filterListOpen}
          aria-controls="filter-list-drawer"
          onClick={onOpenFilterList}
        >
          <FunnelSimple
            size={22}
            weight={filterListOpen ? 'fill' : 'regular'}
          />
          <span>{t('filterList')}</span>
        </button>
        <button
          type="button"
          className={outboundLinkLibraryOpen ? 'is-active' : ''}
          aria-expanded={outboundLinkLibraryOpen}
          aria-controls="outbound-link-library-drawer"
          aria-label={t('outboundLinkLibrary')}
          onClick={onOpenOutboundLinkLibrary}
        >
          <LinkSimple
            size={22}
            weight={outboundLinkLibraryOpen ? 'fill' : 'regular'}
          />
          <span>{t('outboundLinkLibrary')}</span>
        </button>
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-meta">
        <p className={isConnected ? 'connection-ok' : 'connection-preview'}>
          <WifiHigh size={17} weight="fill" aria-hidden />
          <span>{isConnected ? t('connected') : t('disconnected')}</span>
        </p>
        <small>{t('version')} 0.4.0</small>
      </div>
      <button
        type="button"
        className={`settings-navigation ${settingsOpen ? 'is-active' : ''}`}
        onClick={onOpenSettings}
        aria-expanded={settingsOpen}
      >
        <GearSix size={22} />
        <span>{t('settings')}</span>
      </button>
    </aside>
  );
}

function PageHeader({
  title,
  eyebrow,
  refreshing,
  onRefresh,
  actions,
}: {
  title: string;
  eyebrow?: string;
  refreshing: boolean;
  onRefresh: () => void;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="page-eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
      </div>
      <div className="page-header-actions">
        <time dateTime={new Date().toISOString()}>{formatDate()}</time>
        {actions}
        <IconButton
          label={refreshing ? t('refreshing') : t('refresh')}
          onClick={onRefresh}
          disabled={refreshing}
        >
          <ArrowClockwise
            size={20}
            className={refreshing ? 'is-spinning' : ''}
          />
        </IconButton>
      </div>
    </header>
  );
}

function MetricCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: IconComponent;
  tone: 'red' | 'green' | 'neutral';
}) {
  return (
    <article className={`metric-card tone-${tone}`}>
      <div>
        <p>{label}</p>
        <strong>{value.toLocaleString()}</strong>
      </div>
      <span>
        <Icon size={27} weight="duotone" aria-hidden />
      </span>
    </article>
  );
}

function ScheduleRow({
  item,
  next,
  running,
  busy,
  onRun,
}: {
  item: ScheduledBatchSummary;
  next?: ScheduledBatchSummary;
  running: boolean;
  busy: boolean;
  onRun: (planId: string, resume: boolean) => void;
}) {
  const batchTotal = Math.max(
    item.batchSequence,
    next?.batchSequence ?? item.batchSequence
  );
  const actionable =
    item.batchStatus === 'pending' || item.batchStatus === 'interrupted';
  const isRunning = running || item.batchStatus === 'running';
  const statusTone = isRunning
    ? 'running'
    : item.batchStatus === 'blocked'
      ? 'blocked'
      : isFinishedBatch(item.batchStatus)
        ? 'complete'
        : 'pending';
  const statusLabel = isRunning
    ? t('running')
    : item.batchStatus === 'blocked'
      ? t('blocked')
      : item.batchStatus === 'completed_with_errors'
        ? t('completedWithErrors')
        : item.batchStatus === 'completed'
          ? t('completed')
          : item.batchStatus === 'interrupted'
            ? t('interrupted')
            : t('waitingToRun');
  return (
    <article className="schedule-row">
      <span className="site-avatar">
        <Pulse size={26} weight="bold" aria-hidden />
      </span>
      <div className="schedule-plan">
        <strong>{item.planName}</strong>
        <p>
          {t('batchProgress', [item.batchSequence, batchTotal])}
          <span aria-hidden="true"> · </span>
          {t('linkCount', [item.targetCount])}
        </p>
      </div>
      <div className="schedule-next">
        <span>{t('nextBatch')}</span>
        <strong>
          {next
            ? `${t('batchNumber', [next.batchSequence])} · ${t('linkCount', [
                next.targetCount,
              ])}`
            : t('noNextBatch')}
        </strong>
      </div>
      <span className={`status-dot-copy ${statusTone}`}>
        <span aria-hidden="true" />
        {statusLabel}
      </span>
      <div className="schedule-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => navigate({ page: 'plans', planId: item.planId })}
        >
          {t('viewDetail')}
        </button>
        <button
          type="button"
          className="primary-button compact-button"
          onClick={() => onRun(item.planId, item.batchStatus === 'interrupted')}
          disabled={busy || isRunning || !actionable}
        >
          {busy ? (
            <SpinnerGap size={17} className="is-spinning" aria-hidden />
          ) : (
            <Play size={17} weight="fill" aria-hidden />
          )}
          {isRunning
            ? t('running')
            : item.batchStatus === 'interrupted'
              ? t('resumeBatch')
              : t('runBatch')}
        </button>
      </div>
    </article>
  );
}

function RunStageList({ currentStatus }: { currentStatus?: string }) {
  const stages = [
    ['opening', t('openingStatus')],
    ['analyzing', t('analyzingStatus')],
    ['generating', t('generatingStatus')],
    ['click_dispatched', t('submittingStatus')],
    ['verifying', t('verifyingStatus')],
  ] as const;
  const statusOrder = [
    'queued',
    'opening',
    'analyzing',
    'generating',
    'prepared',
    'click_dispatched',
    'verifying',
    'submitted',
  ];
  const currentIndex = Math.max(
    0,
    statusOrder.indexOf(currentStatus ?? 'queued')
  );
  return (
    <ol className="run-stages">
      {stages.map(([status, label], index) => {
        const stageIndex = statusOrder.indexOf(status);
        const complete =
          currentStatus === 'submitted' || stageIndex < currentIndex;
        const active = stageIndex === currentIndex;
        return (
          <li
            key={status}
            className={complete ? 'is-complete' : active ? 'is-active' : ''}
          >
            <span className="stage-marker">
              {complete ? (
                <Check size={14} weight="bold" aria-hidden />
              ) : active ? (
                <CircleNotch size={15} className="is-spinning" aria-hidden />
              ) : (
                index + 1
              )}
            </span>
            <span>{label}</span>
            {active ? (
              <small>{targetStatusCopy(currentStatus ?? '')}</small>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function LiveMonitor({
  batch,
  plan,
  run,
  busy,
  onOpenCurrent,
  onStop,
  onResume,
  condensed = false,
}: {
  batch: BatchSnapshot | null;
  plan?: Plan;
  run: DashboardSummaryView['activeRun'];
  busy: boolean;
  onOpenCurrent: () => void;
  onStop: () => void;
  onResume?: () => void;
  condensed?: boolean;
}) {
  const active = Boolean(
    batch &&
      (batch.status === 'running' || batch.status === 'paused') &&
      (run ? !plan || run.planId === plan.id : !plan)
  );
  const item = active ? currentBatchItem(batch) : undefined;
  const counts = batchCounts(active ? batch : null);
  const blocked = batch?.status === 'paused';
  return (
    <section
      className={`live-monitor ${condensed ? 'is-condensed' : ''}`}
      aria-labelledby={condensed ? 'plan-live-title' : 'dashboard-live-title'}
    >
      <div className="section-title-row">
        <div className="section-title">
          <span />
          <h2 id={condensed ? 'plan-live-title' : 'dashboard-live-title'}>
            {condensed ? t('currentBatch') : t('liveRun')}
          </h2>
        </div>
        {active ? (
          <span className={`live-badge ${blocked ? 'blocked' : ''}`}>
            <span />
            {blocked ? t('blocked') : t('running')}
          </span>
        ) : null}
      </div>

      {!active || !batch ? (
        <EmptyState
          icon={Pulse}
          title={t('noActiveRun')}
          description={t('noActiveRunHint')}
        />
      ) : (
        <div className="live-monitor-body" aria-live="polite">
          <div className="current-target-card">
            <span>{t('currentTarget')}</span>
            <strong title={item?.url}>{displayTarget(item?.url ?? '—')}</strong>
            <small>
              {run?.planName ??
                (locale() === 'zh-CN'
                  ? '\u5feb\u901f\u6279\u6b21'
                  : 'Quick batch')}
            </small>
          </div>

          <div className="monitor-progress">
            <div>
              <span>{t('planProgress')}</span>
              <strong>
                {counts.processed} / {counts.total}{' '}
                {t('linkCount', ['']).trim()}
              </strong>
            </div>
            <progress value={counts.processed} max={counts.total || 1} />
            <ul>
              <li>
                <span>{t('submitted')}</span>
                <strong>{counts.submitted}</strong>
              </li>
              <li>
                <span>{t('failed')}</span>
                <strong className="text-danger">{counts.failed}</strong>
              </li>
              <li>
                <span>{t('remaining')}</span>
                <strong>{counts.remaining}</strong>
              </li>
            </ul>
          </div>

          <div className="monitor-stage">
            <h3>{t('runStage')}</h3>
            <RunStageList currentStatus={item?.status} />
          </div>

          <div className="monitor-actions">
            <button
              type="button"
              className="primary-button"
              onClick={onOpenCurrent}
              disabled={busy}
            >
              <ArrowSquareOut size={18} aria-hidden />
              {t('openCurrent')}
            </button>
            {blocked && onResume ? (
              <button
                type="button"
                className="secondary-button"
                onClick={onResume}
                disabled={busy}
              >
                <Play size={18} weight="fill" aria-hidden />
                {t('continueBatch')}
              </button>
            ) : (
              <button
                type="button"
                className="danger-button"
                onClick={onStop}
                disabled={busy}
              >
                <Stop size={18} weight="fill" aria-hidden />
                {t('stopBatch')}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function WebsiteStatistics({ summary }: { summary: DashboardSummary }) {
  const [dimension, setDimension] = useState<'promoting' | 'targets'>(
    'promoting'
  );
  const rows =
    dimension === 'promoting'
      ? summary.promotingSites.map((item) => ({
          key: item.siteId,
          label: item.siteLabel || displayDomain(item.websiteUrl),
          sublabel: displayDomain(item.websiteUrl),
          total: item.total,
          processed: item.processed,
          submitted: item.submitted,
          failed: item.failed,
        }))
      : summary.targetHosts.map((item: TargetHostSummary) => ({
          key: item.host,
          label: item.host,
          sublabel: '',
          total: item.total,
          processed: item.processed,
          submitted: item.submitted,
          failed: item.failed,
        }));
  return (
    <section className="paper-section stats-section">
      <div className="section-title-row">
        <div className="section-title">
          <span />
          <h2>{t('websiteStats')}</h2>
        </div>
        <fieldset className="segmented-control">
          <legend className="sr-only">{t('websiteStats')}</legend>
          <button
            type="button"
            className={dimension === 'promoting' ? 'is-active' : ''}
            aria-pressed={dimension === 'promoting'}
            onClick={() => setDimension('promoting')}
          >
            {t('promotingSites')}
          </button>
          <button
            type="button"
            className={dimension === 'targets' ? 'is-active' : ''}
            aria-pressed={dimension === 'targets'}
            onClick={() => setDimension('targets')}
          >
            {t('targetDomains')}
          </button>
        </fieldset>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={GlobeHemisphereWest}
          title={t('websiteStats')}
          description={t('noScheduleHint')}
        />
      ) : (
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead>
              <tr>
                <th>{t('website')}</th>
                <th>{t('planProgress')}</th>
                <th>{t('processed')}</th>
                <th>{t('submitted')}</th>
                <th>{t('failed')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <span className="table-site-mark">
                      <LinkSimple size={15} weight="bold" aria-hidden />
                    </span>
                    <span>
                      <strong>{row.label}</strong>
                      {row.sublabel ? <small>{row.sublabel}</small> : null}
                    </span>
                  </td>
                  <td>
                    <div className="inline-progress">
                      <progress value={row.processed} max={row.total || 1} />
                      <span>{percent(row.processed, row.total)}%</span>
                    </div>
                  </td>
                  <td>
                    {row.processed}/{row.total}
                  </td>
                  <td className="text-success">{row.submitted}</td>
                  <td className={row.failed > 0 ? 'text-danger' : ''}>
                    {row.failed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RecentFailures({
  failures,
  onOpen,
}: {
  failures: RecentFailureSummary[];
  onOpen: (failure: RecentFailureSummary) => void;
}) {
  return (
    <section className="paper-section failures-section">
      <div className="section-title-row">
        <div className="section-title">
          <span />
          <h2>{t('recentFailures')}</h2>
        </div>
        {failures.length > 0 ? (
          <button
            type="button"
            className="text-button"
            onClick={() =>
              navigate({ page: 'plans', planId: failures[0]?.planId })
            }
          >
            {t('allFailures')}
          </button>
        ) : null}
      </div>
      {failures.length === 0 ? (
        <EmptyState
          icon={CheckCircle}
          title={t('noFailures')}
          description={t('noActiveRunHint')}
        />
      ) : (
        <ul className="failure-list">
          {failures.slice(0, 5).map((failure) => (
            <li key={`${failure.targetId}-${failure.updatedAt}`}>
              <button type="button" onClick={() => onOpen(failure)}>
                <WarningCircle size={20} weight="fill" aria-hidden />
                <span>
                  <strong title={failure.url}>
                    {displayTarget(failure.url)}
                  </strong>
                  <small>
                    {failure.planName}
                    <span aria-hidden="true"> · </span>
                    {failure.error?.friendlyMessage ??
                      targetStatusCopy(failure.status)}
                  </small>
                </span>
                <time dateTime={new Date(failure.updatedAt).toISOString()}>
                  {formatTime(failure.updatedAt)}
                </time>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DashboardPage({
  summary,
  plans,
  batch,
  refreshing,
  busyAction,
  onRefresh,
  onRunPlan,
  onOpenFailure,
  onBatchCommand,
}: {
  summary: DashboardSummaryView;
  plans: Plan[];
  batch: BatchSnapshot | null;
  refreshing: boolean;
  busyAction: string | null;
  onRefresh: () => void;
  onRunPlan: (planId: string, resume?: boolean) => void;
  onOpenFailure: (failure: RecentFailureSummary) => void;
  onBatchCommand: (type: 'batch.open-current' | 'batch.stop') => void;
}) {
  const activeRun = summary.activeRun;
  const activePlan = activeRun
    ? plans.find((plan) => plan.id === activeRun.planId)
    : undefined;
  const actionableToday = summary.todaySchedule.find(
    (item) =>
      item.batchStatus === 'pending' || item.batchStatus === 'interrupted'
  );
  return (
    <div className="dashboard-page">
      <PageHeader
        title={t('dashboardTitle')}
        refreshing={refreshing}
        onRefresh={onRefresh}
      />
      <section className="metric-grid" aria-label={t('dashboardTitle')}>
        <MetricCard
          label={t('activePlans')}
          value={summary.activePlanCount}
          icon={CalendarBlank}
          tone="red"
        />
        <MetricCard
          label={t('processed')}
          value={summary.counts.processed}
          icon={FileText}
          tone="neutral"
        />
        <MetricCard
          label={t('submitted')}
          value={summary.counts.submitted}
          icon={CheckCircle}
          tone="green"
        />
        <MetricCard
          label={t('failed')}
          value={summary.counts.failed}
          icon={WarningCircle}
          tone="red"
        />
      </section>

      <div className="dashboard-primary-grid">
        <section className="paper-section schedule-section">
          <div className="section-title-row">
            <div className="section-title">
              <span />
              <h2>{t('todaySchedule')}</h2>
            </div>
            {actionableToday ? (
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  const scheduled = actionableToday;
                  onRunPlan(
                    scheduled.planId,
                    scheduled.batchStatus === 'interrupted'
                  );
                }}
                disabled={
                  Boolean(busyAction) || Boolean(batch?.status === 'running')
                }
              >
                <Play size={18} weight="fill" aria-hidden />
                {t('runToday')}
              </button>
            ) : null}
          </div>
          {summary.todaySchedule.length === 0 ? (
            <EmptyState
              icon={CalendarBlank}
              title={t('noSchedule')}
              description={t('noScheduleHint')}
            />
          ) : (
            <div className="schedule-list">
              {summary.todaySchedule.map((item) => (
                <ScheduleRow
                  key={item.batchId}
                  item={item}
                  next={summary.nextSchedule.find(
                    (candidate) => candidate.planId === item.planId
                  )}
                  running={Boolean(
                    activePlan?.id === item.planId &&
                      (batch?.status === 'running' ||
                        batch?.status === 'paused')
                  )}
                  busy={busyAction === `run:${item.planId}`}
                  onRun={onRunPlan}
                />
              ))}
            </div>
          )}
        </section>
        <LiveMonitor
          batch={batch}
          plan={activePlan}
          run={activeRun}
          busy={Boolean(busyAction)}
          onOpenCurrent={() => onBatchCommand('batch.open-current')}
          onStop={() => onBatchCommand('batch.stop')}
          onResume={
            activeRun ? () => onRunPlan(activeRun.planId, true) : undefined
          }
        />
      </div>

      <div className="dashboard-secondary-grid">
        <WebsiteStatistics summary={summary} />
        <RecentFailures
          failures={summary.recentFailures}
          onOpen={onOpenFailure}
        />
      </div>
    </div>
  );
}

function PlanProgress({ plan }: { plan: Plan }) {
  const progress = percent(plan.processedCount, plan.targetCount);
  return (
    <div className="plan-card-progress">
      <progress value={plan.processedCount} max={plan.targetCount || 1} />
      <span>
        {plan.processedCount}/{plan.targetCount}
      </span>
      <strong>{progress}%</strong>
    </div>
  );
}

function PlanList({
  plans,
  selectedPlanId,
  onNewPlan,
  onSelectPlan,
}: {
  plans: Plan[];
  selectedPlanId?: string;
  onNewPlan: () => void;
  onSelectPlan: (planId: string) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const visiblePlans = plans.filter(
    (plan) => showArchived || plan.status !== 'archived'
  );
  return (
    <aside className="plan-list-pane">
      <div className="plan-list-header">
        <div>
          <h2>{t('planList')}</h2>
          <p>{t('planCount', [visiblePlans.length])}</p>
        </div>
        <button type="button" className="text-button" onClick={onNewPlan}>
          <Plus size={17} weight="bold" aria-hidden />
          {t('newPlan')}
        </button>
      </div>
      <label className="archive-filter">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
        />
        <span>{t('archived')}</span>
      </label>
      {visiblePlans.length === 0 ? (
        <EmptyState
          icon={ClipboardText}
          title={t('emptyPlanTitle')}
          description={t('emptyPlanHint')}
          action={
            <button
              type="button"
              className="primary-button"
              onClick={onNewPlan}
            >
              <Plus size={17} weight="bold" aria-hidden />
              {t('newPlan')}
            </button>
          }
        />
      ) : (
        <ol className="plan-list">
          {visiblePlans.map((plan, index) => (
            <li key={plan.id}>
              <button
                type="button"
                className={selectedPlanId === plan.id ? 'is-active' : ''}
                onClick={() => onSelectPlan(plan.id)}
              >
                <span className="plan-list-index">{index + 1}</span>
                <span className="plan-list-copy">
                  <span>
                    <strong>{plan.name}</strong>
                    <small className={`plan-status status-${plan.status}`}>
                      {planStatusCopy(plan.status)}
                    </small>
                  </span>
                  <small>{t('linkCount', [plan.targetCount])}</small>
                  <PlanProgress plan={plan} />
                </span>
                <CaretDown size={17} className="plan-list-caret" aria-hidden />
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function TargetStatusBadge({ status }: { status: string }) {
  const failed = isFailedTarget(status);
  const success = status === 'published';
  const moderation = status === 'pending_moderation';
  const unconfirmed = status === 'unconfirmed' || status === 'submitted';
  const filtered = status === 'filtered';
  const blocked =
    status === 'blocked' ||
    status === 'login_required' ||
    status === 'captcha_required';
  return (
    <span
      className={`target-status ${
        success
          ? 'success'
          : moderation
            ? 'moderation'
            : unconfirmed
              ? 'unconfirmed'
              : failed
                ? 'failed'
                : filtered
                  ? 'filtered'
                  : blocked
                    ? 'blocked'
                    : status === 'running' ||
                        status === 'generating' ||
                        status === 'opening' ||
                        status === 'analyzing'
                      ? 'running'
                      : 'pending'
      }`}
    >
      {success ? (
        <CheckCircle size={15} weight="fill" aria-hidden />
      ) : moderation ? (
        <ClockCountdown size={15} weight="fill" aria-hidden />
      ) : unconfirmed ? (
        <Warning size={15} weight="fill" aria-hidden />
      ) : filtered ? (
        <FunnelSimple size={15} weight="fill" aria-hidden />
      ) : failed ? (
        <WarningCircle size={15} weight="fill" aria-hidden />
      ) : blocked ? (
        <Warning size={15} weight="fill" aria-hidden />
      ) : status === 'running' ||
        status === 'generating' ||
        status === 'opening' ||
        status === 'analyzing' ? (
        <SpinnerGap size={15} className="is-spinning" aria-hidden />
      ) : (
        <ClockCountdown size={15} aria-hidden />
      )}
      {targetStatusCopy(status)}
    </span>
  );
}

type OutboundLinkTagsByUrl = ReadonlyMap<string, readonly OutboundLinkTag[]>;

function targetOutboundLinkTags(
  url: string,
  tagsByUrl: OutboundLinkTagsByUrl
): readonly OutboundLinkTag[] {
  try {
    return tagsByUrl.get(normalizeOutboundLinkUrl(url)) ?? [];
  } catch {
    // Legacy target rows can contain a malformed URL. They cannot match an
    // exact library entry, but should not make the whole target table fail.
    return [];
  }
}

function TargetOutboundLinkAttributes({
  tags,
  loading,
}: {
  tags: readonly OutboundLinkTag[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <span
        className="target-link-attributes-loading"
        aria-label={t('loading')}
      >
        ...
      </span>
    );
  }

  const followTag = tags.find(
    (tag) => tag === 'dofollow' || tag === 'nofollow'
  );
  const handlingTags = tags.filter(
    (tag) => tag !== 'dofollow' && tag !== 'nofollow'
  );

  return (
    <div className="outbound-link-tag-chips target-link-attribute-chips">
      {followTag ? (
        <span className={`outbound-link-tag is-${followTag}`}>
          {outboundLinkTagCopy(followTag)}
        </span>
      ) : (
        <span className="target-link-attributes-unmarked">
          {t('outboundLinkUnmarked')}
        </span>
      )}
      {handlingTags.map((tag) => (
        <span key={tag} className={`outbound-link-tag is-${tag}`}>
          {outboundLinkTagCopy(tag)}
        </span>
      ))}
    </div>
  );
}

function TargetTable({
  page,
  readOnly,
  canDelete,
  loading,
  outboundLinkLibraryLoading,
  outboundLinkTagsByUrl,
  selectedIds,
  onToggleSelected,
  onOpenFailure,
  onRecheckTarget,
  onDeleteTarget,
  recheckingTargetId,
  onPageChange,
}: {
  page: PlanTargetsPage | null;
  loading: boolean;
  outboundLinkLibraryLoading: boolean;
  outboundLinkTagsByUrl: OutboundLinkTagsByUrl;
  readOnly: boolean;
  canDelete: boolean;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onOpenFailure: (target: PlanTargetWithAttempts) => void;
  onRecheckTarget: (target: PlanTargetWithAttempts) => void;
  onDeleteTarget: (target: PlanTargetWithAttempts) => void;
  recheckingTargetId: string | null;
  onPageChange: (page: number) => void;
}) {
  if (loading) {
    return (
      <div className="inline-loading" aria-live="polite">
        <SpinnerGap size={21} className="is-spinning" aria-hidden />
        {t('loading')}
      </div>
    );
  }
  if (!page || page.items.length === 0) {
    return (
      <EmptyState
        icon={ListBullets}
        title={t('noTargets')}
        description={t('noScheduleHint')}
      />
    );
  }
  return (
    <>
      <div className="target-table-wrap">
        <table className="target-table" aria-busy={outboundLinkLibraryLoading}>
          <thead>
            <tr>
              <th className="target-select-column">
                <span className="sr-only">{t('selectTarget')}</span>
              </th>
              <th>{t('itemNumber')}</th>
              <th>{t('targetAddress')}</th>
              <th>{t('status')}</th>
              <th className="target-link-attributes-column">
                {t('outboundLinkAttributes')}
              </th>
              <th>{t('updatedAt')}</th>
              <th className="target-action-column">
                <span className="sr-only">{t('targetActions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((target) => {
              const failed = isFailedTarget(target.status);
              const canRetry = failed && !readOnly;
              const tags = targetOutboundLinkTags(
                target.url,
                outboundLinkTagsByUrl
              );
              return (
                <tr
                  key={target.id}
                  className={`${failed ? 'has-error' : ''} ${
                    target.status === 'running' ? 'is-current' : ''
                  }`}
                >
                  <td className="target-select-column">
                    {canRetry ? (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(target.id)}
                        onChange={() => onToggleSelected(target.id)}
                        aria-label={`${t('selectTarget')} ${target.url}`}
                      />
                    ) : null}
                  </td>
                  <td>{target.sequence}</td>
                  <td>
                    <button
                      type="button"
                      className="target-link"
                      title={target.url}
                      onClick={() => onOpenFailure(target)}
                    >
                      {displayTarget(target.url)}
                    </button>
                  </td>
                  <td>
                    <TargetStatusBadge status={target.status} />
                  </td>
                  <td className="target-link-attributes-column">
                    <TargetOutboundLinkAttributes
                      tags={tags}
                      loading={outboundLinkLibraryLoading}
                    />
                  </td>
                  <td>
                    <time dateTime={new Date(target.updatedAt).toISOString()}>
                      {formatTime(target.updatedAt)}
                    </time>
                  </td>
                  <td className="target-action-column">
                    <span className="target-row-actions">
                      {target.attempts?.some(
                        (attempt) =>
                          attempt.commentFingerprint || attempt.comment
                      ) ? (
                        <IconButton
                          label={
                            locale() === 'zh-CN'
                              ? `复查评论：${displayTarget(target.url)}`
                              : `Recheck comment: ${displayTarget(target.url)}`
                          }
                          className="target-recheck-button"
                          onClick={() => onRecheckTarget(target)}
                          disabled={recheckingTargetId === target.id}
                        >
                          {recheckingTargetId === target.id ? (
                            <SpinnerGap size={16} className="is-spinning" />
                          ) : (
                            <Eye size={16} aria-hidden />
                          )}
                        </IconButton>
                      ) : null}
                      {!readOnly ? (
                        <IconButton
                          label={
                            canDelete
                              ? t('deleteTargetAction', [
                                  displayTarget(target.url),
                                ])
                              : t('deleteTargetUnavailable')
                          }
                          className="target-delete-button"
                          onClick={() => onDeleteTarget(target)}
                          disabled={!canDelete}
                        >
                          <Trash size={16} aria-hidden />
                        </IconButton>
                      ) : null}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {page.totalPages > 1 ? (
        <nav className="pagination" aria-label={t('targets')}>
          <button
            type="button"
            className="secondary-button"
            disabled={page.page <= 1}
            onClick={() => onPageChange(page.page - 1)}
          >
            {t('previousPage')}
          </button>
          <span>{t('pageOf', [page.page, page.totalPages])}</span>
          <button
            type="button"
            className="secondary-button"
            disabled={page.page >= page.totalPages}
            onClick={() => onPageChange(page.page + 1)}
          >
            {t('nextPage')}
          </button>
        </nav>
      ) : null}
    </>
  );
}

function BatchAccordion({
  batch,
  expanded,
  page,
  loading,
  outboundLinkLibraryLoading,
  outboundLinkTagsByUrl,
  selectedIds,
  onToggle,
  readOnly,
  onToggleSelected,
  onOpenFailure,
  onRecheckTarget,
  onDeleteTarget,
  recheckingTargetId,
  onPageChange,
}: {
  batch: PlanBatch;
  expanded: boolean;
  page: PlanTargetsPage | null;
  loading: boolean;
  outboundLinkLibraryLoading: boolean;
  outboundLinkTagsByUrl: OutboundLinkTagsByUrl;
  readOnly: boolean;
  selectedIds: Set<string>;
  onToggle: () => void;
  onToggleSelected: (id: string) => void;
  onOpenFailure: (target: PlanTargetWithAttempts) => void;
  onRecheckTarget: (target: PlanTargetWithAttempts) => void;
  onDeleteTarget: (target: PlanTargetWithAttempts) => void;
  recheckingTargetId: string | null;
  onPageChange: (page: number) => void;
}) {
  const finished = isFinishedBatch(batch.status);
  const running = batch.status === 'running';
  const canDelete =
    !readOnly && !['running', 'blocked', 'interrupted'].includes(batch.status);
  return (
    <section
      className={`batch-card status-${batch.status} ${
        expanded ? 'is-expanded' : ''
      }`}
    >
      <button
        type="button"
        className="batch-card-header"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span
          className={`batch-state-icon ${
            finished ? 'complete' : running ? 'running' : ''
          }`}
        >
          {finished ? (
            <Check size={17} weight="bold" aria-hidden />
          ) : running ? (
            batch.sequence
          ) : (
            batch.sequence
          )}
        </span>
        <span className="batch-card-copy">
          <strong>{t('batchNumber', [batch.sequence])}</strong>
          <small>{batchStatusCopy(batch.status)}</small>
        </span>
        <span className="batch-count">
          {batch.processedCount}/{batch.targetCount}
        </span>
        <CaretDown size={19} className="batch-caret" aria-hidden />
      </button>
      {expanded ? (
        <div className="batch-card-content">
          <TargetTable
            page={page}
            loading={loading}
            outboundLinkLibraryLoading={outboundLinkLibraryLoading}
            outboundLinkTagsByUrl={outboundLinkTagsByUrl}
            readOnly={readOnly}
            canDelete={canDelete}
            selectedIds={selectedIds}
            onToggleSelected={onToggleSelected}
            onOpenFailure={onOpenFailure}
            onRecheckTarget={onRecheckTarget}
            onDeleteTarget={onDeleteTarget}
            recheckingTargetId={recheckingTargetId}
            onPageChange={onPageChange}
          />
        </div>
      ) : null}
    </section>
  );
}

function PlanDetailPane({
  detail,
  targetPage,
  targetsLoading,
  outboundLinkLibrary,
  outboundLinkLibraryLoading,
  expandedBatchId,
  selectedTargetIds,
  onResume,
  busyAction,
  onExpandBatch,
  onPageChange,
  onToggleSelected,
  onOpenFailure,
  onRecheckTarget,
  onDeleteTarget,
  onRetrySelected,
  onRun,
  onRename,
  onArchive,
  onDelete,
}: {
  detail: PlanDetail;
  targetPage: PlanTargetsPage | null;
  targetsLoading: boolean;
  outboundLinkLibrary: OutboundLinkLibraryEntry[];
  outboundLinkLibraryLoading: boolean;
  expandedBatchId?: string;
  selectedTargetIds: Set<string>;
  onResume: () => void;
  busyAction: string | null;
  onExpandBatch: (batchId: string) => void;
  onPageChange: (page: number) => void;
  onToggleSelected: (id: string) => void;
  onOpenFailure: (target: PlanTargetWithAttempts) => void;
  onRecheckTarget: (target: PlanTargetWithAttempts) => void;
  onDeleteTarget: (target: PlanTargetWithAttempts) => void;
  onRetrySelected: () => void;
  onRun: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const { plan, batches } = detail;
  const planPercent = percent(plan.processedCount, plan.targetCount);
  const interruptedBatch = batches.find(
    (batch) => batch.status === 'interrupted'
  );
  const pendingBatch = batches.find((batch) => batch.status === 'pending');
  const actionBatch = interruptedBatch ?? pendingBatch;
  const canRun = plan.status === 'active' && Boolean(actionBatch);
  const readOnly = plan.status === 'archived';
  const outboundLinkTagsByUrl = useMemo(
    () =>
      new Map<string, readonly OutboundLinkTag[]>(
        outboundLinkLibrary.map((entry) => [entry.url, entry.tags])
      ),
    [outboundLinkLibrary]
  );
  return (
    <main className="plan-detail-pane">
      <div className="plan-detail-heading">
        <div>
          <p className="page-eyebrow">{t('planDetail')}</p>
          <h1>{plan.name}</h1>
          <p>
            {t('linksAndBatch', [
              plan.targetCount,
              plan.chunkSize,
              plan.processedCount,
            ])}
          </p>
          <p className="plan-landing-url">
            <LinkSimple size={15} aria-hidden />
            <span>{t('promotingWebsite')}</span>
            <a
              href={plan.promotingWebsiteUrl}
              target="_blank"
              rel="noreferrer"
              title={plan.promotingWebsiteUrl}
            >
              {displayTarget(plan.promotingWebsiteUrl)}
            </a>
          </p>
        </div>
        <div className="plan-detail-actions">
          {plan.status !== 'archived' ? (
            <>
              <button
                type="button"
                className="secondary-button"
                onClick={onRename}
                disabled={Boolean(busyAction)}
              >
                <PencilSimple size={17} aria-hidden />
                {t('renamePlan')}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={onArchive}
                disabled={Boolean(busyAction)}
              >
                <Archive size={17} aria-hidden />
                {t('archivePlan')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="danger-text-button"
              onClick={onDelete}
              disabled={Boolean(busyAction)}
            >
              <Trash size={17} aria-hidden />
              {t('deleteForever')}
            </button>
          )}
        </div>
      </div>
      <div className="detail-progress">
        <progress value={plan.processedCount} max={plan.targetCount || 1} />
        <strong>{planPercent}%</strong>
        <span>
          {plan.processedCount}/{plan.targetCount}
        </span>
      </div>
      {canRun ? (
        <div className="plan-run-strip">
          <span>
            <CalendarBlank size={20} weight="duotone" aria-hidden />
            {t('nextRunCard', [
              actionBatch?.sequence ?? 1,
              actionBatch?.targetCount ?? plan.chunkSize,
            ])}
          </span>
          <button
            type="button"
            className="primary-button"
            onClick={interruptedBatch ? onResume : onRun}
            disabled={Boolean(busyAction)}
          >
            {busyAction?.startsWith('run:') ||
            busyAction?.startsWith('resume:') ? (
              <SpinnerGap size={17} className="is-spinning" aria-hidden />
            ) : (
              <Play size={17} weight="fill" aria-hidden />
            )}
            {interruptedBatch ? t('resumeBatch') : t('startNextBatch')}
          </button>
        </div>
      ) : null}

      <div className="batch-list">
        {batches.map((batch) => (
          <BatchAccordion
            key={batch.id}
            batch={batch}
            expanded={batch.id === expandedBatchId}
            page={batch.id === expandedBatchId ? targetPage : null}
            loading={batch.id === expandedBatchId && targetsLoading}
            outboundLinkLibraryLoading={outboundLinkLibraryLoading}
            outboundLinkTagsByUrl={outboundLinkTagsByUrl}
            readOnly={readOnly}
            selectedIds={selectedTargetIds}
            onToggle={() => onExpandBatch(batch.id)}
            onToggleSelected={onToggleSelected}
            onOpenFailure={onOpenFailure}
            onRecheckTarget={onRecheckTarget}
            onDeleteTarget={onDeleteTarget}
            recheckingTargetId={
              busyAction?.startsWith('recheck-target:')
                ? busyAction.slice('recheck-target:'.length)
                : null
            }
            onPageChange={onPageChange}
          />
        ))}
      </div>
      {!readOnly && selectedTargetIds.size > 0 ? (
        <div className="selection-bar" aria-live="polite">
          <span>{t('linkCount', [selectedTargetIds.size])}</span>
          <button
            type="button"
            className="primary-button"
            onClick={onRetrySelected}
            disabled={Boolean(busyAction)}
          >
            <ArrowClockwise size={17} aria-hidden />
            {t('retrySelected')}
          </button>
        </div>
      ) : null}
    </main>
  );
}

function PlansPage({
  plans,
  selectedPlanId,
  batch,
  activeRun,
  refreshing,
  busyAction,
  outboundLinkLibrary,
  outboundLinkLibraryLoading,
  onRefresh,
  onNewPlan,
  onRenamePlan,
  onOpenFailure,
  onRecheckTarget,
  onDeleteTarget,
  onRunPlan,
  onArchivePlan,
  onDeletePlan,
  onRetryTargets,
  onBatchCommand,
  onResume,
}: {
  plans: Plan[];
  selectedPlanId?: string;
  batch: BatchSnapshot | null;
  activeRun: DashboardSummaryView['activeRun'];
  refreshing: boolean;
  busyAction: string | null;
  outboundLinkLibrary: OutboundLinkLibraryEntry[];
  outboundLinkLibraryLoading: boolean;
  onRefresh: () => void;
  onNewPlan: () => void;
  onRenamePlan: (plan: Plan) => void;
  onOpenFailure: (target: PlanTargetWithAttempts) => void;
  onRecheckTarget: (target: PlanTargetWithAttempts) => void;
  onDeleteTarget: (target: PlanTargetWithAttempts) => void;
  onRunPlan: (planId: string, resume?: boolean) => void;
  onArchivePlan: (plan: Plan) => void;
  onDeletePlan: (plan: Plan) => void;
  onRetryTargets: (
    planId: string,
    targetIds: string[],
    knownUrls: string[]
  ) => void;
  onBatchCommand: (type: 'batch.open-current' | 'batch.stop') => void;
  onResume: (planId: string) => void;
}) {
  const [activePlanId, setActivePlanId] = useState<string | undefined>(
    selectedPlanId
  );
  useEffect(() => {
    setActivePlanId(selectedPlanId);
  }, [selectedPlanId]);
  const selectedPlan =
    plans.find((plan) => plan.id === activePlanId) ??
    plans.find((plan) => plan.status !== 'archived') ??
    plans[0];
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [expandedBatchId, setExpandedBatchId] = useState<string>();
  const [targetPage, setTargetPage] = useState<PlanTargetsPage | null>(null);
  const [targetPageNumber, setTargetPageNumber] = useState(1);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(
    new Set()
  );

  useEffect(() => {
    if (!selectedPlan) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailError('');
    dashboardRequest<PlanDetail>({
      type: 'plan.getDetail',
      planId: selectedPlan.id,
    })
      .then((nextDetail) => {
        if (cancelled) return;
        setDetail(nextDetail);
        const preferred =
          nextDetail.batches.find((item) =>
            ['running', 'blocked', 'interrupted'].includes(item.status)
          ) ??
          nextDetail.batches.find((item) => item.status === 'pending') ??
          nextDetail.batches.at(-1);
        setExpandedBatchId(preferred?.id);
        setTargetPageNumber(1);
        setSelectedTargetIds(new Set());
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDetailError(
            error instanceof Error ? error.message : t('loadFailed')
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPlan?.id, refreshing]);

  useEffect(() => {
    if (!selectedPlan || !expandedBatchId) {
      setTargetPage(null);
      return;
    }
    let cancelled = false;
    setTargetsLoading(true);
    dashboardRequest<PlanTargetsPage>({
      type: 'plan.getTargets',
      planId: selectedPlan.id,
      batchId: expandedBatchId,
      page: targetPageNumber,
      pageSize: PAGE_SIZE,
    })
      .then((nextPage) => {
        if (!cancelled) setTargetPage(nextPage);
      })
      .catch(() => {
        if (!cancelled) setTargetPage(null);
      })
      .finally(() => {
        if (!cancelled) setTargetsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPlan?.id, expandedBatchId, targetPageNumber, refreshing]);

  const handleExpandBatch = (batchId: string) => {
    setExpandedBatchId((current) =>
      current === batchId ? undefined : batchId
    );
    setTargetPageNumber(1);
    setSelectedTargetIds(new Set());
  };

  return (
    <div className="plans-page">
      <PageHeader
        title={t('plansTitle')}
        refreshing={refreshing}
        onRefresh={onRefresh}
        actions={
          <button type="button" className="primary-button" onClick={onNewPlan}>
            <Plus size={18} weight="bold" aria-hidden />
            {t('newPlan')}
          </button>
        }
      />
      <div className="plan-workspace">
        <PlanList
          plans={plans}
          selectedPlanId={selectedPlan?.id}
          onNewPlan={onNewPlan}
          onSelectPlan={(planId) => {
            setActivePlanId(planId);
            navigate({ page: 'plans', planId });
          }}
        />
        {!selectedPlan ? (
          <main className="plan-detail-pane empty-detail">
            <EmptyState
              icon={ClipboardText}
              title={t('emptyPlanTitle')}
              description={t('emptyPlanHint')}
              action={
                <button
                  type="button"
                  className="primary-button"
                  onClick={onNewPlan}
                >
                  <Plus size={17} aria-hidden />
                  {t('newPlan')}
                </button>
              }
            />
          </main>
        ) : detailError ? (
          <main className="plan-detail-pane empty-detail">
            <EmptyState
              icon={WarningCircle}
              title={t('loadFailed')}
              description={detailError}
            />
          </main>
        ) : !detail ? (
          <main className="plan-detail-pane inline-loading detail-loading">
            <SpinnerGap size={25} className="is-spinning" aria-hidden />
            {t('loading')}
          </main>
        ) : (
          <PlanDetailPane
            detail={detail}
            targetPage={targetPage}
            targetsLoading={targetsLoading}
            outboundLinkLibrary={outboundLinkLibrary}
            outboundLinkLibraryLoading={outboundLinkLibraryLoading}
            expandedBatchId={expandedBatchId}
            selectedTargetIds={selectedTargetIds}
            busyAction={busyAction}
            onExpandBatch={handleExpandBatch}
            onPageChange={setTargetPageNumber}
            onToggleSelected={(targetId) =>
              setSelectedTargetIds((current) => {
                const next = new Set(current);
                if (next.has(targetId)) next.delete(targetId);
                else next.add(targetId);
                return next;
              })
            }
            onOpenFailure={onOpenFailure}
            onRecheckTarget={onRecheckTarget}
            onDeleteTarget={onDeleteTarget}
            onRetrySelected={() => {
              const selectedUrls =
                targetPage?.items
                  .filter((target) => selectedTargetIds.has(target.id))
                  .map((target) => target.url) ?? [];
              onRetryTargets(
                selectedPlan.id,
                [...selectedTargetIds],
                selectedUrls
              );
            }}
            onRun={() => onRunPlan(selectedPlan.id)}
            onResume={() => onResume(selectedPlan.id)}
            onRename={() => onRenamePlan(detail.plan)}
            onArchive={() => onArchivePlan(detail.plan)}
            onDelete={() => onDeletePlan(detail.plan)}
          />
        )}
        <aside className="plan-monitor-pane">
          <LiveMonitor
            condensed
            batch={batch}
            plan={selectedPlan}
            run={activeRun}
            busy={Boolean(busyAction)}
            onOpenCurrent={() => onBatchCommand('batch.open-current')}
            onStop={() => onBatchCommand('batch.stop')}
            onResume={() => onResume(selectedPlan.id)}
          />
          {detail ? (
            <div className="next-batch-card">
              <Database size={25} weight="duotone" aria-hidden />
              <div>
                <strong>
                  {t('nextRunCard', [
                    detail.batches.find((item) => item.status === 'pending')
                      ?.sequence ?? detail.batches.length,
                    detail.batches.find((item) => item.status === 'pending')
                      ?.targetCount ?? detail.plan.chunkSize,
                  ])}
                </strong>
                <p>{t('expectedStart')}</p>
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function SettingsDrawer({
  open,
  settings,
  onClose,
}: {
  open: boolean;
  settings: ExtensionSettings;
  onClose: () => void;
}) {
  const drawerRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    drawerRef.current?.focus();
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const openSidePanel = async () => {
    if (isPreviewMode() || !chrome.sidePanel?.open) return;
    const window = await chrome.windows.getCurrent();
    if (window.id !== undefined) {
      await chrome.sidePanel.open({ windowId: window.id });
    }
  };

  if (!open) return null;
  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <dialog
        open
        ref={drawerRef}
        className="settings-drawer"
        aria-modal="true"
        aria-labelledby="settings-drawer-title"
        tabIndex={-1}
      >
        <div className="drawer-heading">
          <div>
            <p className="page-eyebrow">{t('settings')}</p>
            <h2 id="settings-drawer-title">{t('settingsTitle')}</h2>
          </div>
          <IconButton label={t('close')} onClick={onClose}>
            <X size={21} />
          </IconButton>
        </div>
        <p className="drawer-description">{t('settingsDescription')}</p>
        <dl className="settings-summary">
          <div>
            <dt>
              <Database size={19} aria-hidden />
              {t('provider')}
            </dt>
            <dd>
              {settings.provider === 'deepseek' ? 'DeepSeek' : 'KIE Gemini'}
            </dd>
          </div>
          <div>
            <dt>
              <GlobeHemisphereWest size={19} aria-hidden />
              {t('configuredSites')}
            </dt>
            <dd>{settings.sites.length}</dd>
          </div>
          <div>
            <dt>
              <FileText size={19} aria-hidden />
              {t('language')}
            </dt>
            <dd>{t('followsBrowser')}</dd>
          </div>
          <div>
            <dt>
              <ArrowClockwise size={19} aria-hidden />
              {t('autoRefresh')}
            </dt>
            <dd>{t('realtimeRefresh')}</dd>
          </div>
        </dl>
        <section className="settings-sites">
          <h3>{t('configuredSites')}</h3>
          <ul>
            {settings.sites.map((site) => (
              <li key={site.id}>
                <span className="table-site-mark">
                  <LinkSimple size={15} aria-hidden />
                </span>
                <span>
                  <strong>
                    {site.label ||
                      displayDomain(site.websiteUrl) ||
                      t('unknownSite')}
                  </strong>
                  <small>{site.websiteUrl || '—'}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <button
          type="button"
          className="primary-button drawer-primary-action"
          onClick={openSidePanel}
          disabled={isPreviewMode()}
        >
          <ArrowSquareOut size={18} aria-hidden />
          {t('openSidePanel')}
        </button>
      </dialog>
    </div>
  );
}

function filterEntryKindCopy(kind: FilterEntryKind): string {
  return kind === 'domain' ? t('filterKindDomain') : t('filterKindUrl');
}

function FilterListDrawer({
  open,
  onClose,
  onToast,
}: {
  open: boolean;
  onClose: () => void;
  onToast: (message: string, kind?: Toast['kind']) => void;
}) {
  const drawerRef = useRef<HTMLDialogElement>(null);
  const [entries, setEntries] = useState<FilterListEntry[]>([]);
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<FilterEntryKind>('url');
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    drawerRef.current?.focus();

    if (isPreviewMode()) {
      return () => globalThis.removeEventListener('keydown', onKeyDown);
    }

    setLoading(true);
    void sendToBackground({ type: 'filter.list' })
      .then((result) => {
        if (!cancelled) setEntries(result.data);
      })
      .catch(() => {
        if (!cancelled) onToast(t('filterListLoadFailed'), 'error');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      globalThis.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, onToast, open]);

  const addEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextValue = value.trim();
    if (!nextValue || busyKey) return;

    setBusyKey('filter-add');
    try {
      if (isPreviewMode()) {
        const entry: FilterListEntry = {
          id: `demo-filter-${Date.now()}`,
          kind,
          value: nextValue,
          createdAt: Date.now(),
        };
        setEntries((current) => [...current, entry]);
      } else {
        const result = await sendToBackground({
          type: 'filter.add',
          value: nextValue,
          kind,
        });
        setEntries((current) => {
          const withoutExisting = current.filter(
            (entry) => entry.id !== result.data.id
          );
          return [...withoutExisting, result.data];
        });
      }
      setValue('');
      onToast(t('filterEntryAdded'));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      onToast(
        message.includes('FILTER_ENTRY_INVALID')
          ? t('filterValueInvalid')
          : t('actionFailed'),
        'error'
      );
    } finally {
      setBusyKey(null);
    }
  };

  const removeEntry = async (entry: FilterListEntry) => {
    if (busyKey) return;
    setBusyKey(`filter-remove:${entry.id}`);
    try {
      if (isPreviewMode()) {
        setEntries((current) => current.filter((item) => item.id !== entry.id));
      } else {
        const result = await sendToBackground({
          type: 'filter.remove',
          id: entry.id,
        });
        if (result.data) {
          setEntries((current) =>
            current.filter((item) => item.id !== entry.id)
          );
        }
      }
      onToast(t('filterEntryRemoved'));
    } catch {
      onToast(t('actionFailed'), 'error');
    } finally {
      setBusyKey(null);
    }
  };

  if (!open) return null;
  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <dialog
        open
        ref={drawerRef}
        id="filter-list-drawer"
        className="filter-list-drawer"
        aria-modal="true"
        aria-labelledby="filter-list-title"
        tabIndex={-1}
      >
        <div className="drawer-heading">
          <div>
            <p className="page-eyebrow">{t('filterList')}</p>
            <h2 id="filter-list-title">{t('filterListTitle')}</h2>
          </div>
          <IconButton label={t('close')} onClick={onClose}>
            <X size={21} />
          </IconButton>
        </div>
        <p className="drawer-description">{t('filterListDescription')}</p>

        <form className="filter-add-form" onSubmit={addEntry}>
          <label className="filter-value-field">
            <span>{t('filterValue')}</span>
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={t('filterValuePlaceholder')}
              maxLength={2_048}
              disabled={Boolean(busyKey)}
            />
          </label>
          <label className="filter-kind-field">
            <span>{t('filterMatchType')}</span>
            <select
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as FilterEntryKind)
              }
              disabled={Boolean(busyKey)}
            >
              <option value="url">{t('filterKindUrl')}</option>
              <option value="domain">{t('filterKindDomain')}</option>
            </select>
          </label>
          <button
            type="submit"
            className="primary-button filter-add-button"
            disabled={!value.trim() || Boolean(busyKey)}
          >
            {busyKey === 'filter-add' ? (
              <SpinnerGap size={18} className="is-spinning" aria-hidden />
            ) : (
              <Plus size={18} weight="bold" aria-hidden />
            )}
            {t('addFilterEntry')}
          </button>
        </form>

        <section
          className="filter-list-content"
          aria-labelledby="filter-list-entries"
        >
          <div className="filter-list-content-heading">
            <h3 id="filter-list-entries">
              {t('filterEntries', [entries.length])}
            </h3>
            <span>{t('filterListAutoSkip')}</span>
          </div>
          {loading ? (
            <div className="filter-list-loading" aria-live="polite">
              <SpinnerGap size={20} className="is-spinning" aria-hidden />
              <span>{t('loading')}</span>
            </div>
          ) : entries.length === 0 ? (
            <div className="filter-list-empty">
              <FunnelSimple size={24} aria-hidden />
              <strong>{t('filterListEmptyTitle')}</strong>
              <p>{t('filterListEmptyHint')}</p>
            </div>
          ) : (
            <ul className="filter-entry-list">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <span className={`filter-kind-badge is-${entry.kind}`}>
                    {filterEntryKindCopy(entry.kind)}
                  </span>
                  <div className="filter-entry-copy">
                    <strong title={entry.value}>{entry.value}</strong>
                    <small>
                      {t('filterCreatedAt', [formatShortDate(entry.createdAt)])}
                    </small>
                  </div>
                  <IconButton
                    label={t('removeFilterEntry', [entry.value])}
                    className="filter-remove-button"
                    onClick={() => removeEntry(entry)}
                    disabled={Boolean(busyKey)}
                  >
                    {busyKey === `filter-remove:${entry.id}` ? (
                      <SpinnerGap size={17} className="is-spinning" />
                    ) : (
                      <Trash size={17} />
                    )}
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </section>
      </dialog>
    </div>
  );
}
function outboundLinkTagCopy(tag: OutboundLinkTag): string {
  switch (tag) {
    case 'dofollow':
      return t('outboundLinkTagDofollow');
    case 'nofollow':
      return t('outboundLinkTagNofollow');
    case 'login_required':
      return t('outboundLinkTagLoginRequired');
    case 'captcha_required':
      return t('outboundLinkTagCaptchaRequired');
  }
}

function toggleOutboundLinkTag(
  current: readonly OutboundLinkTag[],
  tag: OutboundLinkTag
): OutboundLinkTag[] {
  const next = new Set(current);
  if (next.has(tag)) {
    next.delete(tag);
  } else {
    if (tag === 'dofollow') next.delete('nofollow');
    if (tag === 'nofollow') next.delete('dofollow');
    next.add(tag);
  }
  return OUTBOUND_LINK_TAGS.filter((candidate) => next.has(candidate));
}

function sameOutboundLinkTags(
  left: readonly OutboundLinkTag[],
  right: readonly OutboundLinkTag[]
): boolean {
  return (
    left.length === right.length &&
    left.every((tag, index) => tag === right[index])
  );
}

function outboundLinkLibraryErrorCopy(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('OUTBOUND_LINK_ENTRY_INVALID')) {
    return t('outboundLinkUrlInvalid');
  }
  if (message.includes('OUTBOUND_LINK_ENTRY_DUPLICATE')) {
    return t('outboundLinkDuplicate');
  }
  if (message.includes('OUTBOUND_LINK_TAG_CONFLICT')) {
    return t('outboundLinkTagConflict');
  }
  return t('actionFailed');
}

function OutboundLinkTagPicker({
  tags,
  onChange,
  disabled = false,
}: {
  tags: readonly OutboundLinkTag[];
  onChange: (tags: OutboundLinkTag[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="outbound-link-tag-picker" disabled={disabled}>
      <legend>{t('outboundLinkTags')}</legend>
      <div className="outbound-link-tag-options">
        {OUTBOUND_LINK_TAGS.map((tag) => {
          const selected = tags.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={selected}
              className={`outbound-link-tag is-${tag}${
                selected ? ' is-selected' : ''
              }`}
              onClick={() => onChange(toggleOutboundLinkTag(tags, tag))}
            >
              {outboundLinkTagCopy(tag)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function OutboundLinkTagChips({
  tags,
}: {
  tags: readonly OutboundLinkTag[];
}) {
  if (tags.length === 0) {
    return (
      <span className="outbound-link-no-tags">{t('outboundLinkNoTags')}</span>
    );
  }
  return (
    <div className="outbound-link-tag-chips">
      {tags.map((tag) => (
        <span key={tag} className={`outbound-link-tag is-${tag}`}>
          {outboundLinkTagCopy(tag)}
        </span>
      ))}
    </div>
  );
}

function OutboundLinkLibraryDrawer({
  open,
  entries,
  loading,
  onEntriesChange,
  onClose,
  onToast,
}: {
  open: boolean;
  entries: OutboundLinkLibraryEntry[];
  loading: boolean;
  onEntriesChange: (
    updater: (current: OutboundLinkLibraryEntry[]) => OutboundLinkLibraryEntry[]
  ) => void;
  onClose: () => void;
  onToast: (message: string, kind?: Toast['kind']) => void;
}) {
  const drawerRef = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState<OutboundLinkTag[]>([]);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [editTags, setEditTags] = useState<OutboundLinkTag[]>([]);

  const resetEditing = () => {
    setEditingId(null);
    setEditUrl('');
    setEditTags([]);
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    drawerRef.current?.focus();
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  const addEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!url.trim() || busyKey) return;

    setBusyKey('outbound-link-add');
    try {
      const normalizedUrl = normalizeOutboundLinkUrl(url);
      if (entries.some((entry) => entry.url === normalizedUrl)) {
        onToast(t('outboundLinkAlreadyExists'), 'error');
        return;
      }
      if (isPreviewMode()) {
        const now = Date.now();
        onEntriesChange((current) => [
          ...current,
          {
            id: `demo-outbound-link-${now}`,
            url: normalizedUrl,
            tags,
            createdAt: now,
            updatedAt: now,
          },
        ]);
      } else {
        const result = await sendToBackground({
          type: 'link-library.add',
          url: normalizedUrl,
          tags,
        });
        onEntriesChange((current) => {
          const withoutExisting = current.filter(
            (entry) => entry.id !== result.data.id
          );
          return [...withoutExisting, result.data];
        });
      }
      setUrl('');
      setTags([]);
      onToast(t('outboundLinkSaved'));
    } catch (error) {
      onToast(outboundLinkLibraryErrorCopy(error), 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const beginEdit = (entry: OutboundLinkLibraryEntry) => {
    if (busyKey) return;
    setEditingId(entry.id);
    setEditUrl(entry.url);
    setEditTags(entry.tags);
  };

  const saveEntry = async (
    event: FormEvent<HTMLFormElement>,
    entry: OutboundLinkLibraryEntry
  ) => {
    event.preventDefault();
    if (!editUrl.trim() || busyKey) return;

    setBusyKey(`outbound-link-save:${entry.id}`);
    try {
      const normalizedUrl = normalizeOutboundLinkUrl(editUrl);
      if (
        normalizedUrl === entry.url &&
        sameOutboundLinkTags(editTags, entry.tags)
      ) {
        resetEditing();
        return;
      }

      if (isPreviewMode()) {
        if (
          entries.some(
            (candidate) =>
              candidate.id !== entry.id && candidate.url === normalizedUrl
          )
        ) {
          throw new Error('OUTBOUND_LINK_ENTRY_DUPLICATE');
        }
        const updated: OutboundLinkLibraryEntry = {
          ...entry,
          url: normalizedUrl,
          tags: editTags,
          updatedAt: Date.now(),
        };
        onEntriesChange((current) =>
          current.map((candidate) =>
            candidate.id === entry.id ? updated : candidate
          )
        );
      } else {
        const result = await sendToBackground({
          type: 'link-library.update',
          id: entry.id,
          url: normalizedUrl,
          tags: editTags,
        });
        const updatedEntry = result.data;
        if (!updatedEntry) {
          onEntriesChange((current) =>
            current.filter((candidate) => candidate.id !== entry.id)
          );
          resetEditing();
          onToast(t('outboundLinkNotFound'), 'error');
          return;
        }
        onEntriesChange((current) =>
          current.map((candidate) =>
            candidate.id === entry.id ? updatedEntry : candidate
          )
        );
      }
      resetEditing();
      onToast(t('outboundLinkUpdated'));
    } catch (error) {
      onToast(outboundLinkLibraryErrorCopy(error), 'error');
    } finally {
      setBusyKey(null);
    }
  };

  const removeEntry = async (entry: OutboundLinkLibraryEntry) => {
    if (busyKey) return;
    setBusyKey(`outbound-link-remove:${entry.id}`);
    try {
      if (isPreviewMode()) {
        onEntriesChange((current) =>
          current.filter((candidate) => candidate.id !== entry.id)
        );
      } else {
        const result = await sendToBackground({
          type: 'link-library.remove',
          id: entry.id,
        });
        onEntriesChange((current) =>
          current.filter((candidate) => candidate.id !== entry.id)
        );
        if (!result.data) {
          if (editingId === entry.id) resetEditing();
          onToast(t('outboundLinkNotFound'), 'error');
          return;
        }
      }
      if (editingId === entry.id) resetEditing();
      onToast(t('outboundLinkRemoved'));
    } catch (error) {
      onToast(outboundLinkLibraryErrorCopy(error), 'error');
    } finally {
      setBusyKey(null);
    }
  };

  if (!open) return null;
  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <dialog
        open
        ref={drawerRef}
        id="outbound-link-library-drawer"
        className="outbound-link-library-drawer"
        aria-modal="true"
        aria-labelledby="outbound-link-library-title"
        tabIndex={-1}
      >
        <div className="drawer-heading">
          <div>
            <p className="page-eyebrow">{t('outboundLinkLibrary')}</p>
            <h2 id="outbound-link-library-title">
              {t('outboundLinkLibraryTitle')}
            </h2>
          </div>
          <IconButton label={t('close')} onClick={onClose}>
            <X size={21} />
          </IconButton>
        </div>
        <p className="drawer-description">
          {t('outboundLinkLibraryDescription')}
        </p>

        <form className="outbound-link-add-form" onSubmit={addEntry}>
          <label className="outbound-link-url-field">
            <span>{t('outboundLinkUrl')}</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={t('outboundLinkUrlPlaceholder')}
              maxLength={2_048}
              inputMode="url"
              disabled={Boolean(busyKey)}
            />
          </label>
          <OutboundLinkTagPicker
            tags={tags}
            onChange={setTags}
            disabled={Boolean(busyKey)}
          />
          <button
            type="submit"
            className="primary-button outbound-link-add-button"
            disabled={!url.trim() || Boolean(busyKey)}
          >
            {busyKey === 'outbound-link-add' ? (
              <SpinnerGap size={18} className="is-spinning" aria-hidden />
            ) : (
              <Plus size={18} weight="bold" aria-hidden />
            )}
            {t('outboundLinkAdd')}
          </button>
        </form>

        <section
          className="outbound-link-library-content"
          aria-labelledby="outbound-link-library-entries"
        >
          <div className="outbound-link-library-content-heading">
            <h3 id="outbound-link-library-entries">
              {t('outboundLinkEntries', [entries.length])}
            </h3>
            <span>{t('outboundLinkManualOnly')}</span>
          </div>
          {loading ? (
            <div className="outbound-link-library-loading" aria-live="polite">
              <SpinnerGap size={20} className="is-spinning" aria-hidden />
              <span>{t('loading')}</span>
            </div>
          ) : entries.length === 0 ? (
            <div className="outbound-link-library-empty">
              <LinkSimple size={24} aria-hidden />
              <strong>{t('outboundLinkEmptyTitle')}</strong>
              <p>{t('outboundLinkEmptyHint')}</p>
            </div>
          ) : (
            <ul className="outbound-link-entry-list">
              {entries.map((entry) =>
                editingId === entry.id ? (
                  <li key={entry.id} className="is-editing">
                    <form
                      className="outbound-link-edit-form"
                      onSubmit={(event) => saveEntry(event, entry)}
                    >
                      <label className="outbound-link-url-field">
                        <span>{t('outboundLinkUrl')}</span>
                        <input
                          value={editUrl}
                          onChange={(event) => setEditUrl(event.target.value)}
                          maxLength={2_048}
                          inputMode="url"
                          disabled={Boolean(busyKey)}
                        />
                      </label>
                      <OutboundLinkTagPicker
                        tags={editTags}
                        onChange={setEditTags}
                        disabled={Boolean(busyKey)}
                      />
                      <div className="outbound-link-edit-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={Boolean(busyKey)}
                          onClick={resetEditing}
                        >
                          {t('cancelEdit')}
                        </button>
                        <button
                          type="submit"
                          className="primary-button"
                          disabled={!editUrl.trim() || Boolean(busyKey)}
                        >
                          {busyKey === `outbound-link-save:${entry.id}` ? (
                            <SpinnerGap
                              size={17}
                              className="is-spinning"
                              aria-hidden
                            />
                          ) : null}
                          {t('outboundLinkSave')}
                        </button>
                      </div>
                    </form>
                  </li>
                ) : (
                  <li key={entry.id}>
                    <div className="outbound-link-entry-copy">
                      <strong title={entry.url}>{entry.url}</strong>
                      <OutboundLinkTagChips tags={entry.tags} />
                      <small>
                        {t('outboundLinkUpdatedAt', [
                          formatShortDate(entry.updatedAt),
                        ])}
                      </small>
                    </div>
                    <div className="outbound-link-entry-actions">
                      <IconButton
                        label={t('editOutboundLinkEntry', [entry.url])}
                        className="outbound-link-edit-button"
                        onClick={() => beginEdit(entry)}
                        disabled={Boolean(busyKey)}
                      >
                        <PencilSimple size={17} />
                      </IconButton>
                      <IconButton
                        label={t('removeOutboundLinkEntry', [entry.url])}
                        className="outbound-link-remove-button"
                        onClick={() => removeEntry(entry)}
                        disabled={Boolean(busyKey)}
                      >
                        {busyKey === `outbound-link-remove:${entry.id}` ? (
                          <SpinnerGap size={17} className="is-spinning" />
                        ) : (
                          <Trash size={17} />
                        )}
                      </IconButton>
                    </div>
                  </li>
                )
              )}
            </ul>
          )}
        </section>
      </dialog>
    </div>
  );
}
function NewPlanDialog({
  open,
  settings,
  busy,
  onClose,
  onCreate,
}: {
  open: boolean;
  settings: ExtensionSettings;
  busy: boolean;
  onClose: () => void;
  onCreate: (input: {
    name: string;
    siteId: string;
    targetText: string;
    chunkSize: number;
  }) => void;
}) {
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState(settings.activeSiteId);
  const [targetText, setTargetText] = useState('');
  const [chunkSize, setChunkSize] = useState(30);
  const [fileName, setFileName] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openedRef = useRef(false);
  const parsed = useMemo(() => parseUrlInput(targetText), [targetText]);
  const selectedSite = settings.sites.find((site) => site.id === siteId);
  const normalizedPromotingWebsiteUrl = useMemo(() => {
    if (!selectedSite?.websiteUrl.trim()) return null;
    try {
      return normalizeWebsiteUrl(selectedSite.websiteUrl);
    } catch {
      return null;
    }
  }, [selectedSite?.websiteUrl]);
  const tooMany = parsed.valid.length > 2_000;
  const canSubmit =
    name.trim().length > 0 &&
    selectedSite !== undefined &&
    normalizedPromotingWebsiteUrl !== null &&
    parsed.valid.length > 0 &&
    parsed.invalid.length === 0 &&
    !tooMany &&
    !busy;

  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;
    const nextSiteId = settings.activeSiteId || settings.sites[0]?.id || '';
    setSiteId(nextSiteId);
  }, [open, settings]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    dialogRef.current?.focus();
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);
  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setFileName(file.name);
    setTargetText((current) =>
      current.trim() ? `${current.trim()}\n${content.trim()}` : content.trim()
    );
    event.target.value = '';
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || !normalizedPromotingWebsiteUrl) return;
    onCreate({
      name: name.trim(),
      siteId,
      targetText: parsed.valid.join('\n'),
      chunkSize,
    });
  };

  if (!open) return null;
  return (
    <div className="dialog-backdrop">
      <dialog
        open
        ref={dialogRef}
        className="new-plan-dialog"
        aria-modal="true"
        aria-labelledby="new-plan-title"
        tabIndex={-1}
      >
        <form onSubmit={submit}>
          <div className="drawer-heading">
            <div>
              <p className="page-eyebrow">{t('plans')}</p>
              <h2 id="new-plan-title">{t('newPlan')}</h2>
            </div>
            <IconButton label={t('close')} onClick={onClose}>
              <X size={21} />
            </IconButton>
          </div>

          <div className="new-plan-form-grid">
            <label className="form-field">
              <span>{t('planName')}</span>
              <input
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('planNamePlaceholder')}
              />
            </label>
            <label className="form-field">
              <span>{t('promotingWebsite')}</span>
              <select
                value={siteId}
                onChange={(event) => setSiteId(event.target.value)}
              >
                {settings.sites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.label ||
                      displayDomain(site.websiteUrl) ||
                      t('unknownSite')}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field batch-size-field">
              <span>{t('batchSize')}</span>
              <input
                type="number"
                min={1}
                max={200}
                value={chunkSize}
                onChange={(event) =>
                  setChunkSize(
                    Math.max(
                      1,
                      Math.min(200, Math.floor(Number(event.target.value) || 1))
                    )
                  )
                }
              />
            </label>
          </div>

          <label className="form-field">
            <span>{t('targetUrls')}</span>
            <textarea
              value={targetText}
              onChange={(event) => setTargetText(event.target.value)}
              placeholder={t('targetUrlsPlaceholder')}
              rows={9}
            />
          </label>
          <div className="file-import-row">
            <label className="file-button">
              <UploadSimple size={18} aria-hidden />
              <span>{t('importFile')}</span>
              <input
                type="file"
                accept=".txt,.csv,text/plain,text/csv"
                onChange={readFile}
              />
            </label>
            <span>{fileName || t('fileHint')}</span>
          </div>

          <section className="url-preview" aria-labelledby="url-preview-title">
            <div className="url-preview-heading">
              <h3 id="url-preview-title">{t('preview')}</h3>
              <dl>
                <div>
                  <dt>{t('validLinks')}</dt>
                  <dd>{parsed.valid.length}</dd>
                </div>
                <div>
                  <dt>{t('duplicateLinks')}</dt>
                  <dd>{parsed.duplicates.length}</dd>
                </div>
                <div className={parsed.invalid.length > 0 ? 'has-error' : ''}>
                  <dt>{t('invalidLinks')}</dt>
                  <dd>{parsed.invalid.length}</dd>
                </div>
                <div>
                  <dt>{t('batches')}</dt>
                  <dd>
                    {Math.ceil(
                      Math.min(2_000, parsed.valid.length) / chunkSize
                    ) || 0}
                  </dd>
                </div>
              </dl>
            </div>
            {parsed.valid.length > 0 ? (
              <ol>
                {parsed.valid.slice(0, 6).map((url, index) => (
                  <li key={url}>
                    <span>{index + 1}</span>
                    <span title={url}>{displayTarget(url)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p>{t('targetUrlsPlaceholder')}</p>
            )}
            {parsed.valid.length > 6 ? (
              <small>{t('showMore', [parsed.valid.length - 6])}</small>
            ) : null}
          </section>

          <div className="form-messages" aria-live="polite">
            {!normalizedPromotingWebsiteUrl ? (
              <p className="form-error">{t('invalidConfiguredWebsite')}</p>
            ) : null}
            {parsed.invalid.length > 0 ? (
              <p className="form-error">{t('invalidInput')}</p>
            ) : null}
            {tooMany ? <p className="form-error">{t('tooManyLinks')}</p> : null}
          </div>

          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
              disabled={busy}
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={!canSubmit}
            >
              {busy ? (
                <SpinnerGap size={18} className="is-spinning" aria-hidden />
              ) : (
                <Check size={18} weight="bold" aria-hidden />
              )}
              {busy ? t('creatingPlan') : t('createPlan')}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function RenamePlanDialog({
  plan,
  busy,
  onClose,
  onSave,
}: {
  plan: Plan | null;
  busy: boolean;
  onClose: () => void;
  onSave: (input: { planId: string; name: string }) => void;
}) {
  const [name, setName] = useState('');

  useEffect(() => {
    setName(plan?.name ?? '');
  }, [plan]);

  useEffect(() => {
    if (!plan) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [plan, busy, onClose]);

  if (!plan || plan.status === 'archived') return null;
  const normalizedName = name.trim();
  const canSave =
    normalizedName.length > 0 && normalizedName !== plan.name && !busy;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    onSave({ planId: plan.id, name: normalizedName });
  };

  return (
    <div className="dialog-backdrop">
      <dialog
        open
        className="rename-plan-dialog"
        aria-modal="true"
        aria-labelledby="rename-plan-title"
      >
        <form onSubmit={submit}>
          <div className="drawer-heading">
            <div>
              <p className="page-eyebrow">{t('plans')}</p>
              <h2 id="rename-plan-title">{t('renamePlanTitle')}</h2>
            </div>
            <IconButton label={t('close')} onClick={onClose} disabled={busy}>
              <X size={21} />
            </IconButton>
          </div>

          <label className="form-field">
            <span>{t('planName')}</span>
            <input
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('planNamePlaceholder')}
            />
          </label>

          <div className="dialog-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
              disabled={busy}
            >
              {t('cancel')}
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={!canSave}
            >
              {busy ? (
                <SpinnerGap size={18} className="is-spinning" aria-hidden />
              ) : (
                <Check size={18} weight="bold" aria-hidden />
              )}
              {t('savePlanName')}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function ConfirmDeleteTargetDialog({
  target,
  busy,
  onCancel,
  onConfirm,
}: {
  target: PlanTargetWithAttempts | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (addToFilter: boolean) => void;
}) {
  const [addToFilter, setAddToFilter] = useState(false);

  useEffect(() => {
    setAddToFilter(false);
  }, [target?.id]);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [target, onCancel]);

  if (!target) return null;

  return (
    <div className="dialog-backdrop">
      <div
        className="confirm-dialog target-delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-target-title"
        aria-describedby="delete-target-description"
      >
        <span className="confirm-danger-icon">
          <WarningCircle size={29} weight="fill" aria-hidden />
        </span>
        <h2 id="delete-target-title">{t('deleteTargetTitle')}</h2>
        <p id="delete-target-description">{t('deleteTargetDescription')}</p>
        <strong className="target-delete-url" title={target.url}>
          {target.url}
        </strong>
        <p className="target-delete-published-hint">
          {t('deleteTargetPublishedHint')}
        </p>
        <label className="target-delete-filter-option">
          <input
            type="checkbox"
            checked={addToFilter}
            onChange={(event) => setAddToFilter(event.target.checked)}
            disabled={busy}
          />
          <span>
            <strong>{t('addToFilterList')}</strong>
            <small>{t('addToFilterListHint')}</small>
          </span>
        </label>
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onCancel}
            disabled={busy}
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={() => onConfirm(addToFilter)}
            disabled={busy}
          >
            {busy ? (
              <SpinnerGap size={18} className="is-spinning" aria-hidden />
            ) : (
              <Trash size={18} aria-hidden />
            )}
            {t('confirmTargetDelete')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmDeleteDialog({
  plan,
  busy,
  onCancel,
  onConfirm,
}: {
  plan: Plan | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!plan) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [plan, onCancel]);
  if (!plan) return null;

  return (
    <div className="dialog-backdrop">
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        aria-describedby="delete-description"
      >
        <span className="confirm-danger-icon">
          <WarningCircle size={29} weight="fill" aria-hidden />
        </span>
        <h2 id="delete-title">{t('deleteConfirmTitle')}</h2>
        <p id="delete-description">{t('deleteConfirm')}</p>
        <strong>{plan.name}</strong>
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onCancel}
            disabled={busy}
          >
            {t('cancel')}
          </button>
          <button
            type="button"
            className="danger-button"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (
              <SpinnerGap size={18} className="is-spinning" aria-hidden />
            ) : (
              <Trash size={18} aria-hidden />
            )}
            {t('confirmDelete')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TargetDetailDrawer({
  target,
  busy,
  onClose,
  readOnly,
  onRetry,
  onToast,
}: {
  target: PlanTargetWithAttempts | null;
  busy: boolean;
  readOnly: boolean;
  onClose: () => void;
  onRetry: (target: PlanTargetWithAttempts) => void;
  onToast: (message: string, kind?: Toast['kind']) => void;
}) {
  useEffect(() => {
    if (!target) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, [target, onClose]);

  if (!target) return null;
  const error = target.lastError;
  const attempts = target.attempts ?? [];
  const failed = isFailedTarget(target.status);
  const attemptComments = attempts
    .map((attempt) => attempt.comment?.trim())
    .filter((comment): comment is string => Boolean(comment));
  const diagnostic = [
    `URL: ${target.url}`,
    `Status: ${target.status}`,
    `Error code: ${error?.code ?? 'UNKNOWN'}`,
    `Message: ${error?.message ?? target.latestMessage}`,
    `Updated: ${new Date(target.updatedAt).toISOString()}`,
    `Attempts: ${target.attemptCount}`,
    ...(attemptComments.length > 0
      ? [`Written content: ${attemptComments.join('\n\n')}`]
      : []),
  ].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagnostic);
      onToast(t('diagnosticsCopied'));
    } catch {
      onToast(t('copyFailed'), 'error');
    }
  };

  return (
    <div
      className="drawer-backdrop target-detail-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <dialog
        open
        className="target-detail-drawer"
        aria-labelledby="target-detail-drawer-title"
      >
        <div className="drawer-heading">
          <div>
            <p className="page-eyebrow">{t('linkProcessDetail')}</p>
            <h2 id="target-detail-drawer-title">{t('linkProcessDetail')}</h2>
          </div>
          <IconButton label={t('close')} onClick={onClose}>
            <X size={21} />
          </IconButton>
        </div>
        <div className={`target-detail-card ${failed ? 'has-error' : ''}`}>
          {failed ? (
            <WarningCircle size={23} weight="fill" aria-hidden />
          ) : (
            <LinkSimple size={23} weight="bold" aria-hidden />
          )}
          <div>
            <strong title={target.url}>{displayTarget(target.url)}</strong>
            <small>{target.host}</small>
          </div>
          <TargetStatusBadge status={target.status} />
        </div>
        <section
          className={`target-detail-result ${failed ? 'has-error' : ''}`}
        >
          <h3>{failed ? t('friendlyReason') : t('latestUpdate')}</h3>
          <p>{failed ? friendlyReason(target) : target.latestMessage || '—'}</p>
        </section>
        <dl className="target-detail-metadata">
          <div>
            <dt>{t('status')}</dt>
            <dd>{targetStatusCopy(target.status)}</dd>
          </div>
          <div>
            <dt>{t('updatedAt')}</dt>
            <dd>{formatTime(target.updatedAt)}</dd>
          </div>
          <div>
            <dt>{t('attempts', [target.attemptCount])}</dt>
            <dd>{attempts.length}</dd>
          </div>
          {error ? (
            <div>
              <dt>{t('errorCode')}</dt>
              <dd>
                <code>{error.code}</code>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>{t('originalMessage')}</dt>
            <dd>{error?.message ?? (target.latestMessage || '—')}</dd>
          </div>
        </dl>
        <section className="attempt-timeline">
          <h3>{t('processingFlow')}</h3>
          {attempts.length === 0 ? (
            <p>{t('unknownErrorReason')}</p>
          ) : (
            attempts.map((attempt) => (
              <article key={attempt.id}>
                <header>
                  <strong>{t('attempts', [attempt.attemptNumber])}</strong>
                  <TargetStatusBadge status={attempt.status} />
                </header>
                {attempt.timeline.length === 0 ? (
                  <p>{t('unknownErrorReason')}</p>
                ) : (
                  <ol>
                    {attempt.timeline.map((event, index) => (
                      <li key={`${event.stage}-${event.at}-${index}`}>
                        <span />
                        <div>
                          <strong>{targetStatusCopy(event.stage)}</strong>
                          <p>{event.message}</p>
                        </div>
                        <time dateTime={new Date(event.at).toISOString()}>
                          {formatTime(event.at)}
                        </time>
                      </li>
                    ))}
                  </ol>
                )}
                {attempt.comment ? (
                  <section className="attempt-written-content">
                    <h4>{t('writtenContent')}</h4>
                    <p>{attempt.comment}</p>
                  </section>
                ) : null}
              </article>
            ))
          )}
          {attempts.length > 0 && attemptComments.length === 0 ? (
            <p className="no-written-content">{t('noWrittenContent')}</p>
          ) : null}
        </section>
        <div className="target-detail-actions">
          <button type="button" className="secondary-button" onClick={copy}>
            <Copy size={18} aria-hidden />
            {t('copyDiagnostics')}
          </button>
          {!readOnly && failed ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => onRetry(target)}
              disabled={busy}
            >
              {busy ? (
                <SpinnerGap size={18} className="is-spinning" aria-hidden />
              ) : (
                <ArrowClockwise size={18} aria-hidden />
              )}
              {t('retry')}
            </button>
          ) : null}
        </div>
      </dialog>
    </div>
  );
}
function ToastRegion({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toast-region" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          {toast.kind === 'success' ? (
            <CheckCircle size={19} weight="fill" aria-hidden />
          ) : (
            <WarningCircle size={19} weight="fill" aria-hidden />
          )}
          <span>{toast.message}</span>
          <IconButton label={t('close')} onClick={() => onDismiss(toast.id)}>
            <X size={16} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const [summary, setSummary] = useState<DashboardSummaryView>(EMPTY_SUMMARY);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [settings, setSettings] = useState<ExtensionSettings>({
    provider: 'deepseek',
    activeSiteId: '',
    sites: [],
  });
  const [batch, setBatch] = useState<BatchSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filterListOpen, setFilterListOpen] = useState(false);
  const [outboundLinkLibraryOpen, setOutboundLinkLibraryOpen] = useState(false);
  const [outboundLinkLibrary, setOutboundLinkLibrary] = useState<
    OutboundLinkLibraryEntry[]
  >([]);
  const [outboundLinkLibraryLoading, setOutboundLinkLibraryLoading] = useState(
    () => !isPreviewMode()
  );
  const [newPlanOpen, setNewPlanOpen] = useState(false);
  const [planToRename, setPlanToRename] = useState<Plan | null>(null);
  const [selectedError, setSelectedError] =
    useState<PlanTargetWithAttempts | null>(null);
  const [deletePlan, setDeletePlan] = useState<Plan | null>(null);
  const [targetToDelete, setTargetToDelete] =
    useState<PlanTargetWithAttempts | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const refreshToken = useRef(0);
  const outboundLinkLibraryLoadToken = useRef(0);

  const refreshOutboundLinkLibrary = useCallback(async () => {
    const token = ++outboundLinkLibraryLoadToken.current;
    if (isPreviewMode()) {
      if (token === outboundLinkLibraryLoadToken.current) {
        setOutboundLinkLibraryLoading(false);
      }
      return;
    }

    setOutboundLinkLibraryLoading(true);
    try {
      const result = await sendToBackground({ type: 'link-library.list' });
      if (token === outboundLinkLibraryLoadToken.current) {
        setOutboundLinkLibrary(result.data);
      }
    } catch {
      if (token === outboundLinkLibraryLoadToken.current) {
        setOutboundLinkLibrary([]);
      }
    } finally {
      if (token === outboundLinkLibraryLoadToken.current) {
        setOutboundLinkLibraryLoading(false);
      }
    }
  }, []);

  const pushToast = useCallback(
    (message: string, kind: Toast['kind'] = 'success') => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current, { id, kind, message }].slice(-3));
      globalThis.setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, 4_500);
    },
    []
  );

  const refresh = useCallback(async (initial = false) => {
    const token = ++refreshToken.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setLoadError('');
    try {
      const [nextSummary, nextPlans, nextSettings, nextBatch] =
        await Promise.all([
          loadDashboardSummary(),
          loadPlans(),
          loadSettings(),
          loadActiveBatch(),
        ]);
      if (token !== refreshToken.current) return;
      setSummary(nextSummary);
      setPlans(nextPlans);
      setSettings(nextSettings);
      setBatch(nextBatch);
    } catch (error) {
      if (token !== refreshToken.current) return;
      setLoadError(error instanceof Error ? error.message : t('loadFailed'));
    } finally {
      if (token === refreshToken.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale();
    document.title = t('appName');
    refresh(true);
  }, [refresh]);

  useEffect(() => {
    void refreshOutboundLinkLibrary();
  }, [refreshOutboundLinkLibrary]);

  useEffect(() => {
    if (isPreviewMode() || !chrome.storage?.onChanged) return;
    let dashboardRefreshTimer:
      | ReturnType<typeof globalThis.setTimeout>
      | undefined;
    const onStorageChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string
    ) => {
      if (areaName !== 'local') return;
      if (changes[BATCH_STORAGE_KEY]) {
        loadActiveBatch()
          .then(setBatch)
          .catch(() => undefined);
      }
      if (changes[OUTBOUND_LINK_LIBRARY_STORAGE_KEY]) {
        void refreshOutboundLinkLibrary();
      }
      if (changes[DASHBOARD_REVISION_KEY]) {
        if (dashboardRefreshTimer) {
          globalThis.clearTimeout(dashboardRefreshTimer);
        }
        dashboardRefreshTimer = globalThis.setTimeout(() => refresh(), 120);
      }
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => {
      chrome.storage.onChanged.removeListener(onStorageChanged);
      if (dashboardRefreshTimer) globalThis.clearTimeout(dashboardRefreshTimer);
    };
  }, [refresh, refreshOutboundLinkLibrary]);

  useEffect(() => {
    if (
      route.page === 'plans' &&
      !route.planId &&
      plans.length > 0 &&
      !loading
    ) {
      const firstPlan =
        plans.find((plan) => plan.status !== 'archived') ?? plans[0];
      if (firstPlan) navigate({ page: 'plans', planId: firstPlan.id });
    }
  }, [route, plans, loading]);

  const openRecentFailure = useCallback(
    async (failure: RecentFailureSummary) => {
      setBusyAction(`failure:${failure.targetId}`);
      try {
        const targets = await loadAllBatchTargets(
          failure.planId,
          failure.batchId
        );
        const target = targets.find(
          (candidate) => candidate.id === failure.targetId
        );
        if (!target) throw new Error('PLAN_TARGET_NOT_FOUND');
        setSelectedError(target);
      } catch {
        pushToast(t('actionFailed'), 'error');
      } finally {
        setBusyAction(null);
      }
    },
    [pushToast]
  );

  const runAction = useCallback(
    async (
      key: string,
      message: Parameters<typeof dashboardRequest>[0],
      successMessage?: string
    ) => {
      setBusyAction(key);
      try {
        await dashboardRequest(message);
        if (successMessage) pushToast(successMessage);
        await refresh();
      } catch (error) {
        const messageText =
          error instanceof Error && error.message.includes('PLAN_ACTIVE_EXISTS')
            ? t('duplicateActiveSite')
            : t('actionFailed');
        pushToast(messageText, 'error');
      } finally {
        setBusyAction(null);
      }
    },
    [pushToast, refresh]
  );

  const runAuthorizedPlanAction = useCallback(
    async (
      planId: string,
      action: 'run' | 'resume' | 'retry',
      targetIds: string[] = [],
      knownUrls: string[] = []
    ) => {
      const plan = plans.find((candidate) => candidate.id === planId);
      if (!plan || plan.status === 'archived') return;
      const key = `${action}:${planId}`;
      setBusyAction(key);
      try {
        const permissionUrls = await resolvePermissionUrls(
          plan,
          action,
          targetIds,
          knownUrls
        );
        const allowed =
          isPreviewMode() ||
          permissionUrls.length === 0 ||
          (await requestBatchOriginPermissions(permissionUrls));
        if (!allowed) {
          pushToast(translate('permissionDenied'), 'error');
          return;
        }
        if (action === 'run') {
          await dashboardRequest({ type: 'plan.runNext', planId });
        } else if (action === 'resume') {
          await dashboardRequest({ type: 'plan.resume', planId });
        } else {
          await dashboardRequest({
            type: 'plan.retryTargets',
            planId,
            targetIds,
          });
          setSelectedError(null);
        }
        pushToast(action === 'retry' ? t('retryStarted') : t('startedSuccess'));
        await refresh();
      } catch {
        pushToast(t('actionFailed'), 'error');
      } finally {
        setBusyAction(null);
      }
    },
    [plans, pushToast, refresh]
  );

  const runPlan = (planId: string, resume = false) =>
    runAuthorizedPlanAction(planId, resume ? 'resume' : 'run');

  const runBatchCommand = (type: 'batch.open-current' | 'batch.stop') =>
    runAction(
      type,
      { type },
      type === 'batch.stop' ? t('stoppedSuccess') : undefined
    );

  const createPlan = async (input: {
    name: string;
    siteId: string;
    targetText: string;
    chunkSize: number;
  }) => {
    setBusyAction('create');
    try {
      const created = await dashboardRequest<Plan>({
        type: 'plan.create',
        ...input,
      });
      setNewPlanOpen(false);
      pushToast(t('planCreated'));
      await refresh();
      navigate({ page: 'plans', planId: created.id });
    } catch (error) {
      const errorText =
        error instanceof Error &&
        (error.message.includes('PLAN_ACTIVE_EXISTS') ||
          error.message.includes('PLAN_SITE_CONFLICT'))
          ? t('duplicateActiveSite')
          : t('actionFailed');
      pushToast(errorText, 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const renamePlan = async (input: { planId: string; name: string }) => {
    const key = 'rename:' + input.planId;
    setBusyAction(key);
    try {
      await dashboardRequest<Plan>({
        type: 'plan.rename',
        ...input,
      });
      setPlanToRename(null);
      pushToast(t('planRenamed'));
      await refresh();
    } catch {
      pushToast(t('actionFailed'), 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const retryTargets = (
    planId: string,
    targetIds: string[],
    knownUrls: string[] = []
  ) => {
    if (targetIds.length === 0) return;
    runAuthorizedPlanAction(planId, 'retry', targetIds, knownUrls);
  };
  const deleteTarget = async (
    target: PlanTargetWithAttempts,
    addToFilter: boolean
  ) => {
    const key = `delete-target:${target.id}`;
    setBusyAction(key);
    try {
      await dashboardRequest<PlanTarget>({
        type: 'plan.deleteTarget',
        planId: target.planId,
        targetId: target.id,
        addToFilter,
      });
      setTargetToDelete(null);
      setSelectedError((current) =>
        current?.id === target.id ? null : current
      );
      pushToast(
        addToFilter ? t('targetDeletedAndFiltered') : t('targetDeleted')
      );
      await refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : '';
      pushToast(
        errorMessage.includes('BATCH_ALREADY_ACTIVE')
          ? t('deleteTargetUnavailable')
          : t('actionFailed'),
        'error'
      );
    } finally {
      setBusyAction(null);
    }
  };

  const recheckTarget = async (target: PlanTargetWithAttempts) => {
    const key = `recheck-target:${target.id}`;
    setBusyAction(key);
    try {
      const allowed =
        isPreviewMode() || (await requestBatchOriginPermissions([target.url]));
      if (!allowed) {
        pushToast(translate('permissionDenied'), 'error');
        return;
      }
      const response = await sendToBackground({
        type: 'moderation.recheckTarget',
        planId: target.planId,
        targetId: target.id,
      });
      pushToast(
        response.data.status === 'published'
          ? locale() === 'zh-CN'
            ? '已检测到公开评论，状态已更新为“已显示”'
            : 'Public comment found; status updated to Published'
          : locale() === 'zh-CN'
            ? '本次没有检测到公开评论，原状态保持不变'
            : 'Public comment not found; the previous status was preserved'
      );
      await refresh();
    } catch {
      pushToast(t('actionFailed'), 'error');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="app-shell">
      <Sidebar
        route={route}
        settingsOpen={settingsOpen}
        filterListOpen={filterListOpen}
        outboundLinkLibraryOpen={outboundLinkLibraryOpen}
        onOpenFilterList={() => {
          setSettingsOpen(false);
          setOutboundLinkLibraryOpen(false);
          setFilterListOpen(true);
        }}
        onOpenOutboundLinkLibrary={() => {
          setSettingsOpen(false);
          setFilterListOpen(false);
          setOutboundLinkLibraryOpen(true);
        }}
        onOpenSettings={() => {
          setFilterListOpen(false);
          setOutboundLinkLibraryOpen(false);
          setSettingsOpen(true);
        }}
      />
      <div className="app-content">
        {loading ? (
          <div className="page-loading" aria-live="polite">
            <BrandMark />
            <SpinnerGap size={27} className="is-spinning" aria-hidden />
            <span>{t('loading')}</span>
          </div>
        ) : loadError ? (
          <div className="page-error">
            <EmptyState
              icon={WarningCircle}
              title={t('loadFailed')}
              description={loadError}
              action={
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => refresh()}
                >
                  <ArrowClockwise size={17} aria-hidden />
                  {t('refresh')}
                </button>
              }
            />
          </div>
        ) : route.page === 'dashboard' ? (
          <DashboardPage
            summary={summary}
            plans={plans}
            batch={batch}
            refreshing={refreshing}
            busyAction={busyAction}
            onRefresh={() => refresh()}
            onRunPlan={runPlan}
            onOpenFailure={openRecentFailure}
            onBatchCommand={runBatchCommand}
          />
        ) : route.page === 'moderation' ? (
          <ModerationRecheckPage />
        ) : (
          <PlansPage
            plans={plans}
            selectedPlanId={route.planId}
            batch={batch}
            activeRun={summary.activeRun}
            refreshing={refreshing}
            busyAction={busyAction}
            outboundLinkLibrary={outboundLinkLibrary}
            outboundLinkLibraryLoading={outboundLinkLibraryLoading}
            onRefresh={() => refresh()}
            onNewPlan={() => setNewPlanOpen(true)}
            onRenamePlan={setPlanToRename}
            onOpenFailure={setSelectedError}
            onRecheckTarget={recheckTarget}
            onDeleteTarget={setTargetToDelete}
            onRunPlan={runPlan}
            onArchivePlan={(plan) =>
              runAction(
                `archive:${plan.id}`,
                { type: 'plan.archive', planId: plan.id },
                t('archiveSuccess')
              )
            }
            onDeletePlan={setDeletePlan}
            onRetryTargets={retryTargets}
            onBatchCommand={runBatchCommand}
            onResume={(planId) => runPlan(planId, true)}
          />
        )}
      </div>

      <FilterListDrawer
        open={filterListOpen}
        onClose={() => setFilterListOpen(false)}
        onToast={pushToast}
      />
      <OutboundLinkLibraryDrawer
        open={outboundLinkLibraryOpen}
        entries={outboundLinkLibrary}
        loading={outboundLinkLibraryLoading}
        onEntriesChange={setOutboundLinkLibrary}
        onClose={() => setOutboundLinkLibraryOpen(false)}
        onToast={pushToast}
      />
      <SettingsDrawer
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
      />
      <NewPlanDialog
        open={newPlanOpen}
        settings={settings}
        busy={busyAction === 'create'}
        onClose={() => setNewPlanOpen(false)}
        onCreate={createPlan}
      />
      <RenamePlanDialog
        plan={planToRename}
        busy={Boolean(
          planToRename && busyAction === 'rename:' + planToRename.id
        )}
        onClose={() => setPlanToRename(null)}
        onSave={renamePlan}
      />
      <ConfirmDeleteDialog
        plan={deletePlan}
        busy={Boolean(deletePlan && busyAction === `delete:${deletePlan.id}`)}
        onCancel={() => setDeletePlan(null)}
        onConfirm={() => {
          if (!deletePlan) return;
          const planId = deletePlan.id;
          runAction(
            `delete:${planId}`,
            { type: 'plan.deletePermanently', planId },
            t('deleteSuccess')
          ).then(() => {
            setDeletePlan(null);
            navigate({ page: 'plans' });
          });
        }}
      />
      <ConfirmDeleteTargetDialog
        target={targetToDelete}
        busy={Boolean(
          targetToDelete && busyAction === `delete-target:${targetToDelete.id}`
        )}
        onCancel={() => setTargetToDelete(null)}
        onConfirm={(addToFilter) => {
          if (targetToDelete) void deleteTarget(targetToDelete, addToFilter);
        }}
      />
      <TargetDetailDrawer
        target={selectedError}
        busy={Boolean(
          selectedError && busyAction === `retry:${selectedError.planId}`
        )}
        readOnly={Boolean(
          selectedError &&
            plans.find((plan) => plan.id === selectedError.planId)?.status ===
              'archived'
        )}
        onClose={() => setSelectedError(null)}
        onRetry={(target) =>
          retryTargets(target.planId, [target.id], [target.url])
        }
        onToast={pushToast}
      />
      <ToastRegion
        toasts={toasts}
        onDismiss={(id) =>
          setToasts((current) => current.filter((toast) => toast.id !== id))
        }
      />
    </div>
  );
}
