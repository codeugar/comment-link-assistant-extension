import {
  completeCurrentItem,
  createBatch,
  filterQueuedItems,
  pauseCurrentItem,
  stopBatch,
  updateBatchProgress,
} from '@/batch/state';
import { BATCH_STORAGE_KEY, getBatch } from '@/storage/batch';
import { HISTORY_STORAGE_KEY } from '@/storage/batch-history';
import { FILTER_LIST_STORAGE_KEY } from '@/storage/filter-list';
import { PLANS_STORAGE_KEY } from '@/storage/plans';
import {
  PROVIDER_API_KEYS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
} from '@/storage/settings';
import type { WriteSession } from '@/write/types';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import App from './App';

let container: HTMLDivElement;
let root: Root;

async function renderSidePanel(): Promise<void> {
  await act(async () => {
    root.render(<App />);
  });
  await vi.waitFor(() => {
    expect(container.querySelector('.loading')).toBeNull();
  });
}

async function clickButton(label: string): Promise<void> {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function enterTextareaValue(
  textarea: HTMLTextAreaElement,
  value: string
) {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  await act(async () => {
    setValue?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  await fakeBrowser.reset();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  chrome.storage.local.setAccessLevel = vi.fn(async () => undefined);
  chrome.storage.session.setAccessLevel = vi.fn(async () => undefined);
  vi.spyOn(chrome.i18n, 'getMessage').mockImplementation((key: string) => key);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('side panel navigation', () => {
  it('points an idle panel at the dashboard, with no local run controls', async () => {
    await renderSidePanel();

    expect(container.textContent).toContain('batchIdleTitle');
    expect(container.querySelector('.target-editor')).toBeNull();
    expect(container.querySelector('.workspace-panel')).toBeNull();
    expect(container.textContent).not.toContain('settingsTitle');
    expect(
      Array.from(container.querySelectorAll('button')).some(
        (candidate) => candidate.textContent?.trim() === 'openSettings'
      )
    ).toBe(false);
  });

  it('always shows a prominent open-dashboard action', async () => {
    await renderSidePanel();

    expect(container.querySelector('.dashboard-link')).not.toBeNull();
  });

  it('opens the full dashboard in an extension tab', async () => {
    const createTab = vi
      .spyOn(chrome.tabs, 'create')
      .mockImplementation(
        (async () => ({ id: 42 }) as chrome.tabs.Tab) as never
      );

    await renderSidePanel();
    await clickButton('openDashboard');

    expect(createTab).toHaveBeenCalledWith({
      url: chrome.runtime.getURL('dashboard.html'),
    });
  });

  // Every way of putting a link on someone else's page belongs to the dashboard,
  // where the promoted site is chosen for the plan. No button here may ask the
  // background to begin, retry, or rerun a run.
  it('never asks the background to start a run, from any state', async () => {
    const finished = completeCurrentItem(
      createBatch({
        targetText: 'https://blog.example/one',
        settings: {
          provider: 'deepseek',
          websiteUrl: 'https://product.example',
          displayName: '',
          email: '',
          linkMode: 'prefer-website-field',
        },
        now: 1,
      }),
      'failed',
      'BOOM',
      2
    );
    await chrome.storage.local.set({
      [BATCH_STORAGE_KEY]: finished,
      [HISTORY_STORAGE_KEY]: [
        {
          id: 'hist-1',
          settings: finished.settings,
          createdAt: 1,
          archivedAt: 2,
          counts: { submitted: 0, failed: 1, total: 1 },
          items: [
            { url: 'https://blog.example/one', status: 'failed', message: 'x' },
          ],
        },
      ],
      [PLANS_STORAGE_KEY]: {
        seed: {
          siteId: 'seed',
          chunkSize: 1,
          chunks: [
            { id: 'c0', urls: ['https://a.example/1'], status: 'pending' },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });
    const sendMessage = vi.spyOn(chrome.runtime, 'sendMessage');

    await renderSidePanel();
    for (const button of Array.from(container.querySelectorAll('button'))) {
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    }

    const startTypes = new Set([
      'batch.start',
      'batch.preview',
      'batch.retry-items',
      'batch.retry-from-history',
      'plan.run-next',
    ]);
    for (const [message] of sendMessage.mock.calls) {
      expect(startTypes).not.toContain(
        (message as unknown as { type: string }).type
      );
    }
  });

  it('resumes a stopped run in place instead of sending the operator to the dashboard', async () => {
    const stopped = stopBatch(
      createBatch({
        targetText: 'https://blog.example/one\nhttps://blog.example/two',
        settings: {
          provider: 'deepseek',
          websiteUrl: 'https://product.example',
          displayName: '',
          email: '',
          linkMode: 'prefer-website-field',
        },
        now: 1,
      }),
      2
    );
    await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: stopped });
    const sendMessage = vi
      .spyOn(chrome.runtime, 'sendMessage')
      .mockImplementation((async (message: unknown) => {
        const typed = message as { type: string };
        if (typed.type !== 'batch.resume') {
          throw new Error('UNEXPECTED_MESSAGE');
        }
        return {
          ok: true,
          data: {
            type: 'batch.resume',
            data: { ...stopped, status: 'running' },
          },
        };
      }) as never);

    await renderSidePanel();
    await clickButton('resumeStoppedBatch');

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({ type: 'batch.resume' });
    });
  });

  it('offers no resume once a run finished every target', async () => {
    let finished = createBatch({
      targetText: 'https://blog.example/one',
      settings: {
        provider: 'deepseek',
        websiteUrl: 'https://product.example',
        displayName: '',
        email: '',
        linkMode: 'prefer-website-field',
      },
      now: 1,
    });
    finished = completeCurrentItem(finished, 'submitted', '', 2);
    await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: finished });

    await renderSidePanel();

    expect(
      Array.from(container.querySelectorAll('button')).some(
        (candidate) => candidate.textContent?.trim() === 'resumeStoppedBatch'
      )
    ).toBe(false);
  });

  it('shows the current configured model after an older batch completes', async () => {
    const completed = completeCurrentItem(
      createBatch({
        targetText: 'https://blog.example/post',
        settings: {
          provider: 'deepseek',
          websiteUrl: 'https://product.example',
          displayName: '',
          email: '',
          linkMode: 'prefer-website-field',
        },
      }),
      'failed',
      'OLD_BATCH'
    );
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: {
        ...completed.settings,
        provider: 'kie-gemini',
      },
      [PROVIDER_API_KEYS_STORAGE_KEY]: {
        deepseekApiKey: 'deepseek-key',
        kieApiKey: 'kie-key',
      },
      [BATCH_STORAGE_KEY]: completed,
    });

    await renderSidePanel();

    expect(container.querySelector('.model-strip')?.textContent).toContain(
      'providerKieGemini'
    );
  });

  it('explains when a possible form could not be mapped safely', async () => {
    const completed = completeCurrentItem(
      createBatch({
        targetText: 'https://blog.example/post',
        settings: {
          provider: 'deepseek',
          websiteUrl: 'https://product.example',
          displayName: '',
          email: '',
          linkMode: 'prefer-website-field',
        },
      }),
      'no_form',
      'FORM_PLAN_NEEDS_REVIEW'
    );
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: completed.settings,
      [BATCH_STORAGE_KEY]: completed,
    });

    await renderSidePanel();

    expect(container.textContent).toContain('formNeedsReview');
  });

  it('shows and copies the raw diagnostic for a failed website', async () => {
    const completed = completeCurrentItem(
      createBatch({
        targetText:
          'https://www.learnalanguage.com/blog/italian-greetings-how-are-you-in-italian/',
        settings: {
          provider: 'deepseek',
          websiteUrl: 'https://product.example',
          displayName: '',
          email: '',
          linkMode: 'prefer-website-field',
        },
      }),
      'failed',
      'FORM_PLAN_INVALID_SCHEMA'
    );
    const writeText = vi.fn<(text: string) => Promise<void>>(
      async () => undefined
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: completed.settings,
      [BATCH_STORAGE_KEY]: completed,
    });

    await renderSidePanel();

    expect(container.textContent).toContain('FORM_PLAN_INVALID_SCHEMA');
    await clickButton('copyDiagnostics');
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]?.[0]).toContain('FORM_PLAN_INVALID_SCHEMA');
    expect(writeText.mock.calls[0]?.[0]).toContain('learnalanguage.com');
  });

  it.each([
    ['no_form', 'FORM_PLAN_NEEDS_REVIEW'],
    [
      'validation_error',
      'Target rejected this comment because email is required',
    ],
  ] as const)(
    'shows stored %s detail and diagnostic copy action',
    async (status, message) => {
      const completed = completeCurrentItem(
        createBatch({
          targetText: 'https://blog.example/post',
          settings: {
            provider: 'deepseek',
            websiteUrl: 'https://product.example',
            displayName: '',
            email: '',
            linkMode: 'prefer-website-field',
          },
        }),
        status,
        message
      );
      await chrome.storage.local.set({
        [SETTINGS_STORAGE_KEY]: completed.settings,
        [BATCH_STORAGE_KEY]: completed,
      });

      await renderSidePanel();

      expect(container.textContent).toContain(message);
      expect(container.textContent).toContain('copyDiagnostics');
    }
  );

  it.each([
    ['login_required', 'LOGIN_REQUIRED'],
    ['captcha_required', 'CAPTCHA_REQUIRED'],
  ] as const)(
    'shows terminal %s detail and diagnostic copy action',
    async (status, message) => {
      const completed = completeCurrentItem(
        createBatch({
          targetText: 'https://blog.example/post',
          settings: {
            provider: 'deepseek',
            websiteUrl: 'https://product.example',
            displayName: '',
            email: '',
            linkMode: 'prefer-website-field',
          },
        }),
        status,
        message
      );
      await chrome.storage.local.set({
        [SETTINGS_STORAGE_KEY]: completed.settings,
        [BATCH_STORAGE_KEY]: completed,
      });

      await renderSidePanel();

      expect(container.textContent).toContain(message);
      expect(container.textContent).toContain('copyDiagnostics');
    }
  );

  it('migrates a paused pre-submit login target and continues without a skip action', async () => {
    const paused = pauseCurrentItem(
      createBatch({
        id: 'batch-skip-gate',
        targetText: 'https://blog.example/private\nhttps://forum.example/open',
        settings: {
          provider: 'deepseek',
          websiteUrl: 'https://product.example',
          displayName: '',
          email: '',
          linkMode: 'prefer-website-field',
        },
        now: 1_000,
      }),
      'login_required',
      'LOGIN_REQUIRED',
      2_000
    );
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: paused.settings,
      [BATCH_STORAGE_KEY]: paused,
    });
    await expect(getBatch()).resolves.toMatchObject({
      status: 'running',
      currentIndex: 1,
    });
    await renderSidePanel();

    expect(
      Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'skipCurrentTarget'
      )
    ).toBeUndefined();
    expect(container.textContent).toContain('batchStatusLoginRequired');
    expect(container.textContent).toContain('batchSkippedLoginDescription');
  });

  it('does not offer skip for an unconfirmed post-click result', async () => {
    let batch = updateBatchProgress(
      createBatch({
        targetText: 'https://blog.example/post',
        settings: {
          provider: 'deepseek',
          websiteUrl: 'https://product.example',
          displayName: '',
          email: '',
          linkMode: 'prefer-website-field',
        },
      }),
      {
        item: {
          status: 'prepared',
          prepared: {
            fingerprint: 'fingerprint',
            comment: 'Comment',
            domToken: 'token',
            baseline: { feedbackMessages: [], renderedComment: false },
            expected: {
              url: 'https://blog.example/post',
              editorLabel: 'Comment',
              submitLabel: 'Post',
              hasWebsiteField: false,
            },
          },
        },
      }
    );
    batch = completeCurrentItem(
      batch,
      'unconfirmed',
      'LOGIN_REQUIRED_AFTER_CLICK'
    );
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: batch.settings,
      [BATCH_STORAGE_KEY]: batch,
    });

    await renderSidePanel();

    expect(
      Array.from(container.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'skipCurrentTarget'
      )
    ).toBeUndefined();
  });

  it.each([
    ['LOGIN_REQUIRED_SKIPPED', 'batchSkippedLoginDescription'],
    ['CAPTCHA_REQUIRED_SKIPPED', 'batchSkippedCaptchaDescription'],
  ] as const)('explains skipped manual gate %s', async (message, copy) => {
    const completed = completeCurrentItem(
      createBatch({
        targetText: 'https://blog.example/post',
        settings: {
          provider: 'deepseek',
          websiteUrl: 'https://product.example',
          displayName: '',
          email: '',
          linkMode: 'prefer-website-field',
        },
      }),
      'failed',
      message
    );
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: completed.settings,
      [BATCH_STORAGE_KEY]: completed,
    });

    await renderSidePanel();

    expect(container.textContent).toContain(copy);
    expect(container.textContent).toContain(message);
  });

  it('explains when a planned action is blocked as unsafe', async () => {
    const completed = completeCurrentItem(
      createBatch({
        targetText: 'https://blog.example/post',
        settings: {
          provider: 'deepseek',
          websiteUrl: 'https://product.example',
          displayName: '',
          email: '',
          linkMode: 'prefer-website-field',
        },
      }),
      'validation_error',
      'FORM_PLAN_UNSAFE_SUBMIT'
    );
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: completed.settings,
      [BATCH_STORAGE_KEY]: completed,
    });

    await renderSidePanel();

    expect(container.textContent).toContain('unsafeSubmitBlocked');
  });

  it('migrates a legacy submitted comment to an unconfirmed result', async () => {
    const completed = completeCurrentItem(
      createBatch({
        targetText: 'https://blog.example/post',
        settings: {
          provider: 'deepseek',
          websiteUrl: 'https://product.example',
          displayName: '',
          email: '',
          linkMode: 'prefer-website-field',
        },
      }),
      'submitted',
      'COMMENT_SUBMITTED'
    );
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: completed.settings,
      [BATCH_STORAGE_KEY]: completed,
    });

    await renderSidePanel();

    expect(container.textContent).toContain('batchStatusUnconfirmed');
    expect(container.querySelector('.status-unconfirmed')).not.toBeNull();
  });

  it('shows the current website as an expanded persistent node timeline', async () => {
    let running = createBatch({
      id: 'batch-flow',
      targetText: 'https://blog.example/post\nhttps://forum.example/discussion',
      settings: {
        provider: 'deepseek',
        websiteUrl: 'https://product.example',
        displayName: '',
        email: '',
        linkMode: 'inline',
      },
      now: 1_000,
    });
    running = updateBatchProgress(
      running,
      { item: { status: 'opening' } },
      1_100
    );
    running = updateBatchProgress(
      running,
      { item: { status: 'analyzing' } },
      1_200
    );
    running = updateBatchProgress(
      running,
      {
        item: {
          status: 'generating',
          comment: 'A useful generated comment',
        },
      },
      1_300
    );
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: running.settings,
      [BATCH_STORAGE_KEY]: running,
    });

    await renderSidePanel();

    const currentFlow = container.querySelector(
      '[data-site-id="batch-flow:0"]'
    );
    expect(currentFlow).not.toBeNull();
    expect(currentFlow).toHaveProperty('open', true);
    expect(currentFlow?.textContent).toContain('batchStatusQueued');
    expect(currentFlow?.textContent).toContain('batchStatusOpening');
    expect(currentFlow?.textContent).toContain('batchStatusAnalyzing');
    expect(currentFlow?.textContent).toContain('batchStatusGenerating');
    expect(currentFlow?.textContent).toContain('A useful generated comment');
    expect(currentFlow?.querySelector('.activity-loop')).not.toBeNull();

    const advanced = completeCurrentItem(
      running,
      'submitted',
      'COMMENT_SUBMITTED',
      1_400
    );
    await act(async () => {
      await chrome.storage.local.set({ [BATCH_STORAGE_KEY]: advanced });
    });
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-site-id="batch-flow:1"]')
      ).toHaveProperty('open', true);
    });
    expect(currentFlow).toHaveProperty('open', false);
  });
});

describe('site flow list', () => {
  const retrySettings = {
    provider: 'deepseek' as const,
    websiteUrl: 'https://product.example',
    displayName: '',
    email: '',
    linkMode: 'prefer-website-field' as const,
  };

  function twoItemBatch() {
    return createBatch({
      id: 'batch-retry',
      targetText: 'https://blog.example/one\nhttps://forum.example/two',
      settings: retrySettings,
      now: 1_000,
    });
  }

  it('opens each site-flow target URL in a separate tab', async () => {
    const batch = twoItemBatch();
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: batch.settings,
      [BATCH_STORAGE_KEY]: batch,
    });

    await renderSidePanel();

    const link = container.querySelector<HTMLAnchorElement>(
      '.site-flow-target-link'
    );
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('https://blog.example/one');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noopener');
  });
});

describe('batch history', () => {
  const historyEntry = {
    id: 'hist-1',
    settings: {
      provider: 'deepseek' as const,
      websiteUrl: 'https://product.example',
      displayName: '',
      email: '',
      linkMode: 'prefer-website-field' as const,
    },
    createdAt: 1_000,
    archivedAt: 2_000,
    counts: { submitted: 2, failed: 1, total: 3 },
    items: [
      { url: 'https://blog.example/one', status: 'submitted', message: '' },
      { url: 'https://blog.example/two', status: 'submitted', message: '' },
      { url: 'https://forum.example/three', status: 'failed', message: 'BOOM' },
    ],
  };

  function findButton(label: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label
    );
  }

  function mockRetryResponse() {
    const running = createBatch({
      id: 'hist-run',
      targetText: 'https://forum.example/three',
      settings: historyEntry.settings,
      now: 5_000,
    });
    return vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation((async (
      message: unknown
    ) => {
      const typed = message as { type: string };
      if (typed.type !== 'batch.retry-from-history') {
        throw new Error('UNEXPECTED_MESSAGE');
      }
      return {
        ok: true,
        data: { type: 'batch.retry-from-history', data: running },
      };
    }) as never);
  }

  it('renders archived batches with site, summary, and failed urls', async () => {
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: [historyEntry] });

    await renderSidePanel();

    expect(container.textContent).toContain('batchHistoryTitle');
    expect(container.textContent).toContain('product.example');
    expect(container.textContent).toContain('forum.example/three');
    expect(container.textContent).toContain('batchStatusFailed');
    expect(container.textContent).toContain('BOOM');
    expect(findButton('copyDiagnostics')).toBeDefined();
  });

  it('copies diagnostic detail for an archived failed item', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(
      async () => undefined
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: [historyEntry] });

    await renderSidePanel();
    await clickButton('copyDiagnostics');

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('Error: BOOM')
    );
    expect(writeText.mock.calls[0]?.[0]).toContain('Status: failed');
  });

  it('shows an empty hint when there is no history', async () => {
    await renderSidePanel();

    expect(container.textContent).toContain('batchHistoryEmpty');
  });
});

describe('multi-site profiles', () => {
  const twoSiteSettings = {
    provider: 'deepseek' as const,
    sites: [
      {
        id: 'seed',
        label: 'Seed Audio',
        websiteUrl: 'https://seedaudio.example',
        displayName: 'Seed',
        email: '',
        linkMode: 'prefer-website-field' as const,
      },
      {
        id: 'muse',
        label: 'Museimage',
        websiteUrl: 'https://museimage.example',
        displayName: 'Muse',
        email: '',
        linkMode: 'inline' as const,
      },
    ],
    activeSiteId: 'seed',
  };

  async function selectOption(select: HTMLSelectElement, value: string) {
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      'value'
    )?.set;
    await act(async () => {
      setValue?.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  async function seed(keys = true) {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: twoSiteSettings,
      ...(keys
        ? {
            [PROVIDER_API_KEYS_STORAGE_KEY]: {
              deepseekApiKey: 'deepseek-key',
              kieApiKey: '',
            },
          }
        : {}),
    });
  }

  it('labels a history entry with its archived site label', async () => {
    const entry = {
      id: 'hist-site',
      settings: {
        provider: 'deepseek' as const,
        websiteUrl: 'https://seedaudio.example',
        displayName: '',
        email: '',
        linkMode: 'inline' as const,
        siteId: 'seed',
        siteLabel: 'Seed Audio',
      },
      createdAt: 1,
      archivedAt: 2,
      counts: { submitted: 1, failed: 1, total: 2 },
      items: [
        { url: 'https://blog.example/a', status: 'submitted', message: '' },
        { url: 'https://blog.example/b', status: 'failed', message: 'x' },
      ],
    };
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: [entry] });

    await renderSidePanel();

    expect(container.textContent).toContain('Seed Audio');
  });
});

describe('write comment tab', () => {
  const writeSettings = {
    provider: 'deepseek' as const,
    sites: [
      {
        id: 'site-1',
        label: 'Seedance',
        websiteUrl: 'https://seedance.example',
        displayName: '',
        email: '',
        linkMode: 'inline' as const,
      },
      {
        id: 'site-2',
        label: 'Museimage',
        websiteUrl: 'https://museimage.example',
        displayName: '',
        email: '',
        linkMode: 'inline' as const,
      },
    ],
    activeSiteId: 'site-1',
  };

  async function seedWriteSettings(): Promise<void> {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: writeSettings,
      [PROVIDER_API_KEYS_STORAGE_KEY]: {
        deepseekApiKey: 'deepseek-key',
        kieApiKey: '',
      },
    });
  }

  async function activateTab(
    url = 'https://forum.example/thread'
  ): Promise<number> {
    const tab = await fakeBrowser.tabs.create({
      url,
      active: true,
      title: 'Forum thread title',
    });
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([
      tab,
    ] as unknown as chrome.tabs.Tab[]);
    return tab.id as number;
  }

  function mockBackground(
    handlers: Record<string, (message: never) => unknown>
  ) {
    return vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation((async (
      message: unknown
    ) => {
      const typed = message as { type: string };
      const handler = handlers[typed.type];
      if (!handler) throw new Error(`UNEXPECTED_MESSAGE:${typed.type}`);
      return {
        ok: true,
        data: { type: typed.type, data: await handler(message as never) },
      };
    }) as never);
  }

  function makeSession(overrides: Partial<WriteSession> = {}): WriteSession {
    return {
      tabId: 1,
      pageUrl: 'https://forum.example/thread',
      siteId: 'site-1',
      format: 'markdown',
      context: {
        url: 'https://forum.example/thread',
        title: 'Forum thread title',
        language: 'en',
        selection: null,
        firstPost: 'This is the opening post of the thread.',
        replyCount: 3,
        source: 'first-post',
      },
      turns: [{ role: 'assistant', text: 'What angle interests you?', at: 1 }],
      drafts: [],
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    };
  }

  function findWritePanelWrapperHidden(): boolean {
    const panel = container.querySelector('.write-panel');
    return Boolean(panel?.parentElement?.hasAttribute('hidden'));
  }

  function findRunTabWrapperHidden(): boolean {
    const strip = container.querySelector('.model-strip');
    return Boolean(strip?.parentElement?.hasAttribute('hidden'));
  }

  it('switches between the 运行 and 写评论 tabs', async () => {
    await seedWriteSettings();
    await activateTab();
    mockBackground({ 'write.get': async () => null });

    await renderSidePanel();

    const tabButtons = Array.from(
      container.querySelectorAll('button[role="tab"]')
    );
    expect(tabButtons).toHaveLength(2);

    await clickButton('sidepanelTabRun');
    expect(findRunTabWrapperHidden()).toBe(false);
    expect(findWritePanelWrapperHidden()).toBe(true);

    await clickButton('sidepanelTabWrite');
    expect(findWritePanelWrapperHidden()).toBe(false);
    expect(findRunTabWrapperHidden()).toBe(true);
  });

  it('renders the site/format chips in the start state and starts a session with the selected values', async () => {
    await seedWriteSettings();
    await activateTab();
    const session = makeSession();
    const sendMessage = mockBackground({
      'write.get': async () => null,
      'write.start': async () => session,
    });

    await renderSidePanel();
    await clickButton('sidepanelTabWrite');

    const selects = Array.from(
      container.querySelectorAll('.write-chip select')
    ) as HTMLSelectElement[];
    expect(selects).toHaveLength(2);
    const [siteSelect, formatSelect] = selects;

    async function selectOption(select: HTMLSelectElement, value: string) {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value'
      )?.set;
      await act(async () => {
        setValue?.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    await selectOption(siteSelect, 'site-2');
    await selectOption(formatSelect, 'html');

    expect(container.textContent).toContain('writeStartTitle');
    await clickButton('writeStartButton');

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'write.start',
        siteId: 'site-2',
        format: 'html',
      });
    });
  });

  it('renders a draft card, copies the rendered text, and marks it sent with the recheck checkbox state', async () => {
    await seedWriteSettings();
    await activateTab();
    const draft = {
      id: 'draft-1',
      version: 1,
      template: 'Worth a look at {LINK}.',
      anchorBucket: 'partial' as const,
      anchorText: 'a useful resource',
      rendered: '[a useful resource](https://seedance.example)',
      format: 'markdown' as const,
      createdAt: 1,
    };
    const session = makeSession({ drafts: [draft] });
    const sentSession = {
      ...session,
      drafts: [{ ...draft, sentAt: 2 }],
    };

    const writeText = vi.fn<(text: string) => Promise<void>>(
      async () => undefined
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const sendMessage = mockBackground({
      'write.get': async () => session,
      'write.markSent': async (message: {
        draftId: string;
        addToRecheck: boolean;
      }) => ({ ...sentSession, recheckError: undefined }),
    });

    await renderSidePanel();
    await clickButton('sidepanelTabWrite');

    await vi.waitFor(() => {
      expect(container.querySelector('.write-draft')).not.toBeNull();
    });
    expect(container.textContent).toContain('writeDraftVersion');
    expect(container.textContent).toContain(draft.anchorText);

    await clickButton('writeCopy');
    expect(writeText).toHaveBeenCalledWith(draft.rendered);

    // Uncheck "同时加入待复查" before marking the draft sent.
    const recheckCheckbox = container.querySelector(
      '.write-recheck-toggle input'
    ) as HTMLInputElement;
    expect(recheckCheckbox.checked).toBe(true);
    await act(async () => {
      recheckCheckbox.click();
    });

    await clickButton('writeMarkSent');

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'write.markSent',
        tabId: session.tabId,
        draftId: draft.id,
        addToRecheck: false,
      });
    });
  });

  it('shows the start state again once the session comes back stale', async () => {
    await seedWriteSettings();
    await activateTab();
    const session = makeSession();
    mockBackground({
      'write.get': async () => session,
      'write.send': async () => {
        throw new Error('WRITE_SESSION_STALE:the page moved on');
      },
    });

    await renderSidePanel();
    await clickButton('sidepanelTabWrite');

    await vi.waitFor(() => {
      expect(container.querySelector('.write-composer')).not.toBeNull();
    });

    const textarea = container.querySelector(
      '.write-composer textarea'
    ) as HTMLTextAreaElement;
    await enterTextareaValue(textarea, 'keep going');
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector('.write-start-card')).not.toBeNull();
    });
    expect(container.textContent).toContain('writeErrorSessionStale');
  });
});
