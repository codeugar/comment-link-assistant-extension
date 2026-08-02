import type {
  ModerationQueueItem,
  ModerationRecheckDashboardData,
  ModerationRecheckSettings,
} from '@/dashboard/moderation-recheck';
import { sendToBackground } from '@/runtime/messages';
import { requestBatchOriginPermissions } from '@/runtime/permissions';
import {
  ArrowClockwise,
  ArrowSquareOut,
  CheckCircle,
  ClockCountdown,
  Eye,
  FloppyDisk,
  Hourglass,
  Plus,
  SpinnerGap,
  WarningCircle,
} from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import { locale } from './copy';

const zh = {
  eyebrow: '评论公开状态',
  title: '定时复查看板',
  description: '只读取待审核页面；检测到评论公开后自动标记为“已显示”。',
  refresh: '刷新',
  runNow: '立即复查',
  add: '新增',
  addTitle: '新增定时复查',
  pageUrl: '评论所在页面 URL',
  pageUrlPlaceholder: 'https://example.com/article/#comment-123',
  targetWebsiteUrl: '目标网站 URL',
  targetWebsiteUrlPlaceholder: 'https://target.example',
  addToQueue: '加入定时复查',
  added: '已加入定时复查列表',
  duplicate: '这组页面和目标网站已经在待复查列表中',
  invalidUrl: '请输入有效的 HTTP(S) URL',
  cancel: '取消',
  recheckOne: '复查这一条',
  running: '正在复查',
  pending: '待复查',
  nextRun: '下次复查',
  lastChecked: '最近扫描',
  published: '已转为显示',
  never: '尚未运行',
  notScheduled: '等待调度',
  queueTitle: '待显示评论',
  historyTitle: '待显示 → 已显示历史',
  settingsTitle: '复查设置',
  interval: '复查周期（小时）',
  batchSize: '单轮最多检查',
  save: '保存设置',
  saved: '设置已保存',
  url: '目标网址',
  fingerprint: '评论指纹 / 目标网站',
  checks: '检查次数',
  result: '最近结果',
  time: '时间',
  open: '打开页面',
  noPending: '当前没有等待显示的评论。',
  noHistory: '还没有由定时复查确认“已显示”的记录。',
  selected: '选中 {0} 条',
  scanSummary: '检查 {0} 条，新增显示 {1} 条，仍待显示 {2} 条',
  loadFailed: '复查看板数据读取失败',
  actionFailed: '操作失败，请稍后重试',
  unavailable: '页面暂不可检查（网络、登录或页面限制）',
  login: '页面要求登录，保持待显示',
  captcha: '页面要求验证码，保持待显示',
  notVisible: '尚未检测到公开评论',
  nowVisible: '已检测到公开评论',
};

const en: typeof zh = {
  eyebrow: 'Public comment status',
  title: 'Moderation recheck',
  description:
    'Reads moderation-pending pages only and marks a comment published when it becomes public.',
  refresh: 'Refresh',
  runNow: 'Check now',
  add: 'Add',
  addTitle: 'Add scheduled recheck',
  pageUrl: 'Comment page URL',
  pageUrlPlaceholder: 'https://example.com/article/#comment-123',
  targetWebsiteUrl: 'Target website URL',
  targetWebsiteUrlPlaceholder: 'https://target.example',
  addToQueue: 'Add to scheduled checks',
  added: 'Added to the scheduled recheck queue',
  duplicate: 'That page and target website are already pending',
  invalidUrl: 'Enter valid HTTP(S) URLs',
  cancel: 'Cancel',
  recheckOne: 'Recheck this item',
  running: 'Checking',
  pending: 'Pending checks',
  nextRun: 'Next check',
  lastChecked: 'Last scan',
  published: 'Now published',
  never: 'Not run yet',
  notScheduled: 'Not scheduled',
  queueTitle: 'Pending publication',
  historyTitle: 'Pending → published history',
  settingsTitle: 'Recheck settings',
  interval: 'Interval (hours)',
  batchSize: 'Maximum per run',
  save: 'Save settings',
  saved: 'Settings saved',
  url: 'Target URL',
  fingerprint: 'Fingerprint / target website',
  checks: 'Checks',
  result: 'Latest result',
  time: 'Time',
  open: 'Open page',
  noPending: 'No comments are currently awaiting publication.',
  noHistory: 'No comments have changed from pending to published yet.',
  selected: '{0} selected',
  scanSummary: '{0} checked, {1} published, {2} still pending',
  loadFailed: 'Could not load moderation recheck data',
  actionFailed: 'Action failed. Please try again.',
  unavailable: 'Page unavailable (network, login, or page restriction)',
  login: 'Login required; kept pending',
  captcha: 'CAPTCHA required; kept pending',
  notVisible: 'Public comment not detected yet',
  nowVisible: 'Public comment detected',
};

function c(key: keyof typeof zh, values: Array<string | number> = []): string {
  const template = (locale() === 'zh-CN' ? zh : en)[key];
  return values.reduce<string>(
    (text, value, index) => text.replaceAll(`{${index}}`, String(value)),
    template
  );
}

function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return c('never');
  return new Intl.DateTimeFormat(locale(), {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function displayTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./i, '')}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function resultCopy(message?: string): string {
  if (!message) return c('notVisible');
  if (message.includes('LOGIN_REQUIRED')) return c('login');
  if (message.includes('CAPTCHA_REQUIRED')) return c('captcha');
  if (message.includes('UNAVAILABLE')) return c('unavailable');
  if (message.includes('PUBLISHED')) return c('nowVisible');
  return c('notVisible');
}

export function ModerationRecheckPage() {
  const [data, setData] = useState<ModerationRecheckDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'refresh' | 'run' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [intervalHours, setIntervalHours] = useState(6);
  const [maxChecks, setMaxChecks] = useState(12);
  const [addOpen, setAddOpen] = useState(false);
  const [pageUrl, setPageUrl] = useState('');
  const [targetWebsiteUrl, setTargetWebsiteUrl] = useState('');
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setBusy('refresh');
    setError('');
    try {
      const response = await sendToBackground({
        type: 'moderation.getDashboard',
      });
      setData(response.data);
      setIntervalHours(response.data.settings.intervalMinutes / 60);
      setMaxChecks(response.data.settings.maxChecksPerRun);
    } catch {
      setError(c('loadFailed'));
    } finally {
      setLoading(false);
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runNow = async () => {
    setBusy('run');
    setError('');
    setNotice('');
    try {
      const response = await sendToBackground({ type: 'moderation.runNow' });
      setNotice(
        c('scanSummary', [
          response.data.checked,
          response.data.published,
          response.data.stillPending,
        ])
      );
      await load();
    } catch {
      setError(c('actionFailed'));
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setError('');
    setNotice('');
    const settings: ModerationRecheckSettings = {
      intervalMinutes: Math.round(intervalHours * 60),
      maxChecksPerRun: Math.round(maxChecks),
    };
    try {
      const response = await sendToBackground({
        type: 'moderation.updateSettings',
        settings,
      });
      setData(response.data);
      setIntervalHours(response.data.settings.intervalMinutes / 60);
      setMaxChecks(response.data.settings.maxChecksPerRun);
      setNotice(c('saved'));
    } catch {
      setError(c('actionFailed'));
    } finally {
      setBusy(null);
    }
  };

  const addEntry = async () => {
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const page = new URL(pageUrl.trim());
      const target = new URL(targetWebsiteUrl.trim());
      if (
        !['http:', 'https:'].includes(page.protocol) ||
        !['http:', 'https:'].includes(target.protocol)
      ) {
        throw new Error('INVALID_URL');
      }
      const allowed = await requestBatchOriginPermissions([page.href]);
      if (!allowed) throw new Error('PERMISSION_DENIED');
      const response = await sendToBackground({
        type: 'moderation.addManual',
        pageUrl: page.href,
        targetWebsiteUrl: target.href,
      });
      setData(response.data);
      setPageUrl('');
      setTargetWebsiteUrl('');
      setAddOpen(false);
      setNotice(c('added'));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '';
      setError(
        message.includes('ENTRY_EXISTS') ? c('duplicate') : c('invalidUrl')
      );
    } finally {
      setBusy(null);
    }
  };

  const recheckOne = async (item: ModerationQueueItem) => {
    setRowBusy(item.id);
    setError('');
    setNotice('');
    try {
      const allowed = await requestBatchOriginPermissions([item.url]);
      if (!allowed) throw new Error('PERMISSION_DENIED');
      if (item.source === 'manual') {
        const response = await sendToBackground({
          type: 'moderation.recheckManual',
          entryId: item.id,
        });
        setData(response.data);
        setNotice(
          response.data.published.some(
            (candidate) =>
              candidate.source === 'manual' && candidate.id === item.id
          )
            ? c('nowVisible')
            : c('notVisible')
        );
      } else if (item.planId && item.targetId) {
        const response = await sendToBackground({
          type: 'moderation.recheckTarget',
          planId: item.planId,
          targetId: item.targetId,
        });
        setNotice(
          response.data.status === 'published'
            ? c('nowVisible')
            : c('notVisible')
        );
        await load();
      }
    } catch {
      setError(c('actionFailed'));
    } finally {
      setRowBusy(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="moderation-page moderation-loading">
        <SpinnerGap size={28} className="is-spinning" aria-hidden />
      </div>
    );
  }

  return (
    <main className="moderation-page">
      <header className="page-header">
        <div>
          <p className="page-eyebrow">{c('eyebrow')}</p>
          <h1>{c('title')}</h1>
          <p className="moderation-description">{c('description')}</p>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy)}
            onClick={() => setAddOpen(true)}
          >
            <Plus size={17} weight="bold" />
            {c('add')}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={Boolean(busy)}
            onClick={() => void load(true)}
          >
            <ArrowClockwise
              size={17}
              className={busy === 'refresh' ? 'is-spinning' : ''}
            />
            {c('refresh')}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(busy) || data?.running}
            onClick={() => void runNow()}
          >
            {busy === 'run' || data?.running ? (
              <SpinnerGap size={17} className="is-spinning" />
            ) : (
              <Eye size={17} />
            )}
            {busy === 'run' || data?.running ? c('running') : c('runNow')}
          </button>
        </div>
      </header>

      {error ? (
        <div className="moderation-banner is-error">
          <WarningCircle size={18} weight="fill" /> {error}
        </div>
      ) : null}
      {notice ? (
        <div className="moderation-banner is-success">
          <CheckCircle size={18} weight="fill" /> {notice}
        </div>
      ) : null}

      <section className="moderation-metrics" aria-label={c('title')}>
        <article>
          <Hourglass size={25} />
          <span>{c('pending')}</span>
          <strong>{data?.pending.length ?? 0}</strong>
        </article>
        <article>
          <ClockCountdown size={25} />
          <span>{c('nextRun')}</span>
          <strong>
            {data?.nextRunAt
              ? formatTimestamp(data.nextRunAt)
              : c('notScheduled')}
          </strong>
        </article>
        <article>
          <ArrowClockwise size={25} />
          <span>{c('lastChecked')}</span>
          <strong>{formatTimestamp(data?.lastRun?.completedAt)}</strong>
        </article>
        <article>
          <CheckCircle size={25} />
          <span>{c('published')}</span>
          <strong>{data?.published.length ?? 0}</strong>
        </article>
      </section>

      <div className="moderation-grid">
        <section className="moderation-panel moderation-queue-panel">
          <div className="moderation-panel-heading">
            <div>
              <p className="page-eyebrow">
                {c('selected', [data?.pending.length ?? 0])}
              </p>
              <h2>{c('queueTitle')}</h2>
            </div>
          </div>
          {data?.pending.length ? (
            <div className="moderation-table-wrap">
              <table className="moderation-table">
                <thead>
                  <tr>
                    <th>{c('url')}</th>
                    <th>{c('fingerprint')}</th>
                    <th>{c('checks')}</th>
                    <th>{c('result')}</th>
                    <th>{c('time')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.pending.map((item) => (
                    <tr key={item.targetId}>
                      <td>
                        <strong>{displayTarget(item.url)}</strong>
                      </td>
                      <td>
                        <code title={item.fingerprint}>{item.fingerprint}</code>
                      </td>
                      <td>{item.checkCount}</td>
                      <td>{resultCopy(item.lastCheckMessage)}</td>
                      <td>{formatTimestamp(item.lastCheckAt)}</td>
                      <td>
                        <span className="moderation-row-actions">
                          <button
                            type="button"
                            title={c('recheckOne')}
                            aria-label={c('recheckOne')}
                            disabled={rowBusy === item.id}
                            onClick={() => void recheckOne(item)}
                          >
                            {rowBusy === item.id ? (
                              <SpinnerGap size={17} className="is-spinning" />
                            ) : (
                              <Eye size={17} />
                            )}
                          </button>
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noreferrer"
                            title={c('open')}
                          >
                            <ArrowSquareOut size={17} />
                          </a>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="moderation-empty">{c('noPending')}</p>
          )}
        </section>

        <aside className="moderation-panel moderation-settings-panel">
          <div className="moderation-panel-heading">
            <h2>{c('settingsTitle')}</h2>
          </div>
          <label>
            <span>{c('interval')}</span>
            <input
              type="number"
              min="1"
              max="168"
              step="1"
              value={intervalHours}
              onChange={(event) => setIntervalHours(Number(event.target.value))}
            />
          </label>
          <label>
            <span>{c('batchSize')}</span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              value={maxChecks}
              onChange={(event) => setMaxChecks(Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={Boolean(busy)}
            onClick={() => void save()}
          >
            {busy === 'save' ? (
              <SpinnerGap size={17} className="is-spinning" />
            ) : (
              <FloppyDisk size={17} />
            )}
            {c('save')}
          </button>
          {data?.lastRun ? (
            <p className="moderation-last-summary">
              {c('scanSummary', [
                data.lastRun.checked,
                data.lastRun.published,
                data.lastRun.stillPending,
              ])}
            </p>
          ) : null}
        </aside>
      </div>

      <section className="moderation-panel moderation-history-panel">
        <div className="moderation-panel-heading">
          <h2>{c('historyTitle')}</h2>
        </div>
        {data?.published.length ? (
          <div className="moderation-table-wrap">
            <table className="moderation-table">
              <thead>
                <tr>
                  <th>{c('url')}</th>
                  <th>{c('fingerprint')}</th>
                  <th>{c('checks')}</th>
                  <th>{c('time')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.published.map((item) => (
                  <tr key={`${item.targetId}:${item.publishedAt}`}>
                    <td>
                      <strong>{displayTarget(item.url)}</strong>
                    </td>
                    <td>
                      <code title={item.fingerprint}>{item.fingerprint}</code>
                    </td>
                    <td>{item.checkCount}</td>
                    <td>{formatTimestamp(item.publishedAt)}</td>
                    <td>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        title={c('open')}
                      >
                        <ArrowSquareOut size={17} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="moderation-empty">{c('noHistory')}</p>
        )}
      </section>

      {addOpen ? (
        <div className="moderation-dialog-backdrop" role="presentation">
          <form
            className="moderation-dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void addEntry();
            }}
          >
            <div className="moderation-dialog-heading">
              <h2>{c('addTitle')}</h2>
              <button
                type="button"
                className="text-button"
                onClick={() => setAddOpen(false)}
              >
                {c('cancel')}
              </button>
            </div>
            <label>
              <span>{c('pageUrl')}</span>
              <input
                type="url"
                required
                value={pageUrl}
                placeholder={c('pageUrlPlaceholder')}
                onChange={(event) => setPageUrl(event.target.value)}
              />
            </label>
            <label>
              <span>{c('targetWebsiteUrl')}</span>
              <input
                type="url"
                required
                value={targetWebsiteUrl}
                placeholder={c('targetWebsiteUrlPlaceholder')}
                onChange={(event) => setTargetWebsiteUrl(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="primary-button"
              disabled={Boolean(busy)}
            >
              {busy === 'save' ? (
                <SpinnerGap size={17} className="is-spinning" />
              ) : (
                <Plus size={17} />
              )}
              {c('addToQueue')}
            </button>
          </form>
        </div>
      ) : null}
    </main>
  );
}
