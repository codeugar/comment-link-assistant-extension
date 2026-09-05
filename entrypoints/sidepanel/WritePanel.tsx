import type { AnchorBucket } from '@/anchor/types';
import { TextLoop } from '@/components/core/text-loop';
import { translate } from '@/i18n';
import { sendToBackground } from '@/runtime/messages';
import type { ExtensionSettings } from '@/types';
import { WRITE_LINK_FORMATS } from '@/write/types';
import type { WriteDraft, WriteLinkFormat, WriteSession } from '@/write/types';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { friendlyError } from './App';

export const WRITE_SITE_STORAGE_KEY = 'comment-link-assistant.write-site';

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return url;
  }
}

function siteDisplayLabel(site: ExtensionSettings['sites'][number]): string {
  return site.label || hostnameOf(site.websiteUrl) || translate('siteUnnamed');
}

function formatLabel(format: WriteLinkFormat): string {
  switch (format) {
    case 'bbcode':
      return translate('writeFormatBbcode');
    case 'markdown':
      return translate('writeFormatMarkdown');
    case 'bare-url':
      return translate('writeFormatBareUrl');
    case 'html':
      return translate('writeFormatHtml');
    case 'none':
      return translate('writeFormatNone');
  }
}

function anchorBucketLabel(bucket: AnchorBucket): string {
  switch (bucket) {
    case 'brand':
      return translate('anchorBucketBrand');
    case 'naked':
      return translate('anchorBucketNaked');
    case 'exact':
      return translate('anchorBucketExact');
    case 'partial':
      return translate('anchorBucketPartial');
    case 'generic':
      return translate('anchorBucketGeneric');
    case 'natural':
      return translate('anchorBucketNatural');
  }
}

function writeFriendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const code = raw.split(':', 1)[0];
  if (code === 'SITE_NOT_FOUND') return translate('writeErrorSiteNotFound');
  if (code === 'PAGE_NOT_SUPPORTED') return translate('writePageNotSupported');
  if (code === 'WRITE_CONTEXT_EMPTY') {
    return translate('writeErrorContextEmpty');
  }
  if (code === 'WRITE_SESSION_STALE') {
    return translate('writeErrorSessionStale');
  }
  return friendlyError(error);
}

type TimelineEntry =
  | { kind: 'turn'; at: number; turn: WriteSession['turns'][number] }
  | { kind: 'draft'; at: number; draft: WriteDraft };

function buildTimeline(session: WriteSession): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...session.turns.map((turn) => ({
      kind: 'turn' as const,
      at: turn.at,
      turn,
    })),
    ...session.drafts.map((draft) => ({
      kind: 'draft' as const,
      at: draft.createdAt,
      draft,
    })),
  ];
  entries.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    // A draft is produced by the assistant turn that shares its timestamp,
    // so the turn that explains it always renders first.
    if (a.kind === b.kind) return 0;
    return a.kind === 'turn' ? -1 : 1;
  });
  return entries;
}

function contextMeta(context: WriteSession['context']): string {
  if (context.source === 'selection') {
    const length = context.selection?.length ?? 0;
    return translate('writeContextMetaSelection', [String(length)]);
  }
  const length = (context.title + context.firstPost).length;
  return translate('writeContextMetaTitleFirstPost', [String(length)]);
}

interface WritePanelProps {
  settings: ExtensionSettings;
}

interface SentMeta {
  addToRecheck: boolean;
  recheckError?: string;
}

export default function WritePanel({ settings }: WritePanelProps) {
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [activeTabUrl, setActiveTabUrl] = useState('');
  const [activeTabTitle, setActiveTabTitle] = useState('');
  const [activeTabSupported, setActiveTabSupported] = useState(true);

  const [session, setSession] = useState<WriteSession | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [format, setFormat] = useState<WriteLinkFormat>('bbcode');

  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [messageText, setMessageText] = useState('');

  const [copiedDraftId, setCopiedDraftId] = useState<string | null>(null);
  const [editingAnchorId, setEditingAnchorId] = useState<string | null>(null);
  const [anchorDraft, setAnchorDraft] = useState('');
  const [recheckChecked, setRecheckChecked] = useState<Record<string, boolean>>(
    {}
  );
  const [sentMeta, setSentMeta] = useState<Record<string, SentMeta>>({});

  const [error, setError] = useState('');

  const siteInitialized = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follows the active tab: the write conversation belongs to whatever tab
  // is on screen, not to the sidepanel's own lifetime.
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (disposed) return;
        if (!tab || typeof tab.id !== 'number') {
          setActiveTabId(null);
          setActiveTabUrl('');
          setActiveTabTitle('');
          setActiveTabSupported(false);
          return;
        }
        setActiveTabId(tab.id);
        setActiveTabUrl(tab.url ?? '');
        setActiveTabTitle(tab.title ?? '');
        setActiveTabSupported(/^https?:/i.test(tab.url ?? ''));
      } catch {
        if (!disposed) setActiveTabSupported(false);
      }
    }
    void refresh();
    const onActivated = () => void refresh();
    const onUpdated = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo
    ) => {
      if (changeInfo.status === 'complete') void refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      disposed = true;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  useEffect(() => {
    if (activeTabId === null) {
      setSession(null);
      return;
    }
    let disposed = false;
    (async () => {
      try {
        const response = await sendToBackground({
          type: 'write.get',
          tabId: activeTabId,
        });
        if (!disposed) setSession(response.data);
      } catch {
        if (!disposed) setSession(null);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [activeTabId]);

  // Restores the last-used promoted site once, from the session-scoped
  // storage the start chip writes to.
  useEffect(() => {
    if (siteInitialized.current) return;
    if (settings.sites.length === 0) return;
    siteInitialized.current = true;
    (async () => {
      let stored: string | undefined;
      try {
        const result = await chrome.storage.session.get(WRITE_SITE_STORAGE_KEY);
        stored = result[WRITE_SITE_STORAGE_KEY];
      } catch {
        stored = undefined;
      }
      if (stored && settings.sites.some((site) => site.id === stored)) {
        setSiteId(stored);
        return;
      }
      if (settings.sites.some((site) => site.id === settings.activeSiteId)) {
        setSiteId(settings.activeSiteId);
        return;
      }
      setSiteId(settings.sites[0]?.id ?? null);
    })();
  }, [settings]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    []
  );

  async function selectSite(nextSiteId: string) {
    setSiteId(nextSiteId);
    try {
      await chrome.storage.session.set({
        [WRITE_SITE_STORAGE_KEY]: nextSiteId,
      });
    } catch {
      // Non-fatal: the chip just won't remember the pick for next time.
    }
  }

  async function selectFormat(nextFormat: WriteLinkFormat) {
    if (!session) {
      setFormat(nextFormat);
      return;
    }
    setError('');
    try {
      const response = await sendToBackground({
        type: 'write.setFormat',
        tabId: session.tabId,
        format: nextFormat,
      });
      setSession(response.data);
    } catch (caught) {
      setError(writeFriendlyError(caught));
    }
  }

  async function handleStart() {
    if (!siteId) return;
    setStarting(true);
    setError('');
    try {
      const response = await sendToBackground({
        type: 'write.start',
        siteId,
        format,
      });
      setSession(response.data);
    } catch (caught) {
      setError(writeFriendlyError(caught));
    } finally {
      setStarting(false);
    }
  }

  async function handleReset() {
    if (activeTabId === null) return;
    setError('');
    try {
      await sendToBackground({ type: 'write.reset', tabId: activeTabId });
    } catch (caught) {
      setError(writeFriendlyError(caught));
      return;
    }
    setSession(null);
    setMessageText('');
  }

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !session) return;
    setSending(true);
    setError('');
    try {
      const response = await sendToBackground({
        type: 'write.send',
        tabId: session.tabId,
        text: trimmed,
      });
      setSession(response.data);
      setMessageText('');
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : '';
      setError(writeFriendlyError(caught));
      if (message.startsWith('WRITE_SESSION_STALE')) setSession(null);
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(messageText);
    }
  }

  async function handleCopy(draft: WriteDraft) {
    try {
      await navigator.clipboard.writeText(draft.rendered);
      setCopiedDraftId(draft.id);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        setCopiedDraftId((current) => (current === draft.id ? null : current));
      }, 1_500);
    } catch {
      setError(translate('generatedCommentCopyFailed'));
    }
  }

  async function handleMarkSent(draft: WriteDraft) {
    if (!session) return;
    const addToRecheck = recheckChecked[draft.id] ?? true;
    setError('');
    try {
      const response = await sendToBackground({
        type: 'write.markSent',
        tabId: session.tabId,
        draftId: draft.id,
        addToRecheck,
      });
      setSession(response.data);
      setSentMeta((current) => ({
        ...current,
        [draft.id]: { addToRecheck, recheckError: response.data.recheckError },
      }));
    } catch (caught) {
      setError(writeFriendlyError(caught));
    }
  }

  function startEditingAnchor(draft: WriteDraft) {
    setEditingAnchorId(draft.id);
    setAnchorDraft(draft.anchorText ?? '');
  }

  async function commitAnchor(draft: WriteDraft) {
    if (!session) {
      setEditingAnchorId(null);
      return;
    }
    setError('');
    try {
      const response = await sendToBackground({
        type: 'write.setAnchor',
        tabId: session.tabId,
        draftId: draft.id,
        anchorText: anchorDraft,
      });
      setSession(response.data);
    } catch (caught) {
      setError(writeFriendlyError(caught));
    } finally {
      setEditingAnchorId(null);
    }
  }

  const timeline = session ? buildTimeline(session) : [];
  const firstAssistantAt = session?.turns.find(
    (turn) => turn.role === 'assistant'
  )?.at;
  let metaShown = false;

  return (
    <section className="write-panel">
      <div className="write-panel-header">
        <button
          type="button"
          className="text-button"
          onClick={() => void handleReset()}
        >
          {translate('writeNewConversation')}
        </button>
      </div>

      <div className="write-context-strip">
        <label className="write-chip">
          <span className="write-chip-label">
            {translate('writeSiteChipLabel')}
          </span>
          <select
            value={siteId ?? ''}
            disabled={Boolean(session)}
            onChange={(event) => void selectSite(event.target.value)}
          >
            {settings.sites.map((site) => (
              <option key={site.id} value={site.id}>
                {siteDisplayLabel(site)}
              </option>
            ))}
          </select>
        </label>
        <label className="write-chip">
          <span className="write-chip-label">
            {translate('writeFormatChipLabel')}
          </span>
          <select
            value={session ? session.format : format}
            onChange={(event) =>
              void selectFormat(event.target.value as WriteLinkFormat)
            }
          >
            {WRITE_LINK_FORMATS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {formatLabel(candidate)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="write-page-line">
        {activeTabSupported && activeTabUrl ? (
          <>
            <strong>{hostnameOf(activeTabUrl)}</strong>
            {activeTabTitle ? ` · ${activeTabTitle}` : null}
          </>
        ) : (
          translate('writePageNotSupported')
        )}
      </p>

      <div className="write-timeline">
        {!session ? (
          <div className="write-start-card">
            <p className="eyebrow">{translate('writeStartEyebrow')}</p>
            <h2>{translate('writeStartTitle')}</h2>
            <p>{translate('writeStartDescription')}</p>
            <button
              type="button"
              className="primary-button full-width-button"
              disabled={starting || !siteId || !activeTabSupported}
              onClick={() => void handleStart()}
            >
              {starting
                ? translate('writeStartButtonBusy')
                : translate('writeStartButton')}
            </button>
            <p className="write-start-hint">{translate('writeStartHint')}</p>
          </div>
        ) : (
          timeline.map((entry) => {
            if (entry.kind === 'turn') {
              const showMeta =
                !metaShown &&
                entry.turn.role === 'assistant' &&
                entry.turn.at === firstAssistantAt;
              if (showMeta) metaShown = true;
              return (
                <div
                  key={`turn:${entry.turn.role}:${entry.at}:${entry.turn.text.slice(0, 8)}`}
                  className={
                    entry.turn.role === 'assistant'
                      ? 'write-turn-assistant'
                      : 'write-turn-user-row'
                  }
                >
                  {entry.turn.role === 'assistant' ? (
                    <>
                      <div className="write-assistant-label">
                        <span className="write-assistant-mark" />
                        {translate('writeAssistantLabel')}
                      </div>
                      <p>{entry.turn.text}</p>
                      {showMeta ? (
                        <span className="write-context-meta">
                          {contextMeta(session.context)}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <div className="write-turn-user">{entry.turn.text}</div>
                  )}
                </div>
              );
            }
            const draft = entry.draft;
            const isEditingAnchor = editingAnchorId === draft.id;
            const meta = sentMeta[draft.id];
            return (
              <article key={draft.id} className="write-draft">
                <header className="write-draft-header">
                  <span>
                    {translate('writeDraftVersion', [String(draft.version)])}
                  </span>
                  <span className="write-draft-format">
                    {draft.format.toUpperCase()}
                  </span>
                </header>
                <div className="write-draft-body">{draft.rendered}</div>
                {draft.format !== 'none' ? (
                  <div className="write-draft-anchor-row">
                    <span className="write-anchor-label">
                      {translate('writeAnchorLabel')}
                    </span>
                    {draft.anchorBucket ? (
                      <span className="write-anchor-bucket">
                        {anchorBucketLabel(draft.anchorBucket)}
                      </span>
                    ) : null}
                    {isEditingAnchor ? (
                      <input
                        ref={(node) => node?.focus()}
                        value={anchorDraft}
                        onChange={(event) => setAnchorDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void commitAnchor(draft);
                          } else if (event.key === 'Escape') {
                            setEditingAnchorId(null);
                          }
                        }}
                        onBlur={() => void commitAnchor(draft)}
                      />
                    ) : (
                      <button
                        type="button"
                        className="write-anchor-text"
                        onClick={() => startEditingAnchor(draft)}
                      >
                        {draft.anchorText}
                      </button>
                    )}
                  </div>
                ) : null}
                {draft.sentAt ? (
                  <div className="write-draft-sent-band">
                    {meta?.addToRecheck
                      ? translate('writeSentRecordedWithRecheck', [
                          hostnameOf(session.pageUrl),
                        ])
                      : translate('writeSentRecorded', [
                          hostnameOf(session.pageUrl),
                        ])}
                    {meta?.recheckError
                      ? translate('writeRecheckFailedSuffix')
                      : null}
                  </div>
                ) : (
                  <div className="write-draft-footer">
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => void handleCopy(draft)}
                    >
                      {copiedDraftId === draft.id
                        ? translate('writeCopied')
                        : translate('writeCopy')}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void handleMarkSent(draft)}
                    >
                      {translate('writeMarkSent')}
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        void sendMessage(translate('writeRewritePrompt'))
                      }
                    >
                      {translate('writeRewrite')}
                    </button>
                    {draft.format !== 'none' ? (
                      <label className="write-recheck-toggle">
                        <input
                          type="checkbox"
                          checked={recheckChecked[draft.id] ?? true}
                          onChange={(event) =>
                            setRecheckChecked((current) => ({
                              ...current,
                              [draft.id]: event.target.checked,
                            }))
                          }
                        />
                        {translate('writeAddToRecheck')}
                      </label>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })
        )}
        {sending ? (
          <div className="write-turn-assistant write-thinking-row">
            <div className="write-assistant-label">
              <span className="write-assistant-mark" />
              {translate('writeAssistantLabel')}
            </div>
            <TextLoop interval={1.4}>
              {[
                <span key="context">{translate('writeThinkingContext')}</span>,
                <span key="angle">{translate('writeThinkingAngle')}</span>,
                <span key="draft">{translate('writeThinkingDraft')}</span>,
              ]}
            </TextLoop>
          </div>
        ) : null}
      </div>

      {session ? (
        <div className="write-composer">
          {session.context.selection ? (
            <span className="write-selection-chip">
              {translate('writeSelectionChip', [
                String(session.context.selection.length),
              ])}
            </span>
          ) : null}
          <div className="write-composer-row">
            <textarea
              value={messageText}
              disabled={sending}
              rows={Math.min(4, Math.max(1, messageText.split('\n').length))}
              placeholder={
                session.drafts.length > 0
                  ? translate('writeComposerPlaceholderNext')
                  : translate('writeComposerPlaceholderFirst')
              }
              onChange={(event) => setMessageText(event.target.value)}
              onKeyDown={handleComposerKeyDown}
            />
            <button
              type="button"
              aria-label={translate('writeSend')}
              className="write-send-button"
              disabled={sending || !messageText.trim()}
              onClick={() => void sendMessage(messageText)}
            >
              ↑
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="toast error-toast">{error}</p> : null}
    </section>
  );
}
