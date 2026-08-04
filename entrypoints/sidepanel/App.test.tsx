import {
  completeCurrentItem,
  createBatch,
  filterQueuedItems,
  pauseCurrentItem,
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

async function enterInputValue(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('filter-list preflight', () => {
  const filteredTarget = 'https://blocked.example/comment';

  it('starts a fully filtered batch without configuration, profile, or an origin prompt', async () => {
    const filteredBatch = filterQueuedItems(
      createBatch({
        id: 'filtered-batch',
        targetText: filteredTarget,
        settings: {
          provider: 'deepseek',
          websiteUrl: 'https://product.example',
          displayName: '',
          email: '',
          linkMode: 'prefer-website-field',
        },
        now: 1,
      }),
      [filteredTarget],
      'FILTER_LIST_MATCHED',
      2
    );
    await chrome.storage.local.set({
      [FILTER_LIST_STORAGE_KEY]: [
        {
          id: 'filter-exact',
          kind: 'url',
          value: filteredTarget,
          createdAt: 1,
        },
      ],
    });
    const requestPermissions = vi.spyOn(chrome.permissions, 'request');
    const sendMessage = vi
      .spyOn(chrome.runtime, 'sendMessage')
      .mockImplementation((async (message: unknown) => {
        const typed = message as { type: string };
        if (typed.type !== 'batch.start') {
          throw new Error('UNEXPECTED_MESSAGE');
        }
        return {
          ok: true,
          data: { type: 'batch.start', data: filteredBatch },
        };
      }) as never);

    await renderSidePanel();
    const targetEditor =
      container.querySelector<HTMLTextAreaElement>('.target-editor');
    if (!targetEditor) throw new Error('TARGET_EDITOR_NOT_FOUND');
    await enterTextareaValue(targetEditor, filteredTarget);
    await clickButton('prepareBatch');

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledTimes(1);
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'batch.start',
        targetText: filteredTarget,
      })
    );
    const startMessage = sendMessage.mock.calls[0]?.[0] as unknown as Record<
      string,
      unknown
    >;
    expect(startMessage).not.toHaveProperty('websiteProfile');
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(container.textContent).toContain('batchStatusFiltered');
  });
});
describe('side panel navigation', () => {
  it('opens on the target queue and uses a separate settings page', async () => {
    await renderSidePanel();

    expect(container.textContent).toContain('batchSetupTitle');
    expect(container.textContent).not.toContain('settingsTitle');

    await clickButton('openSettings');
    expect(container.textContent).toContain('settingsTitle');
    expect(container.textContent).not.toContain('batchSetupTitle');

    await clickButton('backToQueue');
    expect(container.textContent).toContain('batchSetupTitle');
    expect(container.textContent).not.toContain('settingsTitle');
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

  it('saves incomplete settings and stays on the settings page', async () => {
    await renderSidePanel();
    await clickButton('openSettings');

    const websiteInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="websiteUrlPlaceholder"]'
    );
    expect(websiteInput).not.toBeNull();
    if (!websiteInput) return;
    await enterInputValue(websiteInput, 'https:seed-audio1.com');

    await clickButton('saveSettings');

    await vi.waitFor(() => {
      expect(container.textContent).toContain('settingsSaved');
    });
    expect(container.textContent).toContain('settingsTitle');
    expect(container.textContent).not.toContain('batchSetupTitle');
  });

  it('shows a settings-specific message when local saving fails', async () => {
    await renderSidePanel();
    await clickButton('openSettings');
    vi.spyOn(chrome.storage.local, 'set').mockRejectedValueOnce(
      new Error('STORAGE_WRITE_FAILED')
    );

    await clickButton('saveSettings');

    await vi.waitFor(() => {
      expect(container.textContent).toContain('settingsSaveFailed');
    });
    expect(container.textContent).not.toContain('commentFailed');
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

describe('website context refresh', () => {
  const cachedProfile = {
    url: 'https://product.example/',
    title: 'Cached profile title',
    description: 'Cached profile description',
  };
  const refreshedProfile = {
    url: 'https://product.example/',
    title: 'Refreshed profile title',
    description: 'Refreshed profile description',
  };

  async function showWebsiteContext() {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: {
        provider: 'deepseek',
        websiteUrl: 'https://product.example',
        displayName: '',
        email: '',
        linkMode: 'prefer-website-field',
      },
      [PROVIDER_API_KEYS_STORAGE_KEY]: {
        deepseekApiKey: 'deepseek-key',
        kieApiKey: '',
      },
    });
    vi.spyOn(chrome.permissions, 'request').mockImplementation(
      (async () => true) as never
    );
    const sendMessage = vi
      .spyOn(chrome.runtime, 'sendMessage')
      .mockImplementation((async (message: unknown) => {
        const typed = message as { type: string; refresh?: boolean };
        if (typed.type !== 'batch.preview') {
          throw new Error('UNEXPECTED_MESSAGE');
        }
        return {
          ok: true,
          data: {
            type: 'batch.preview',
            data: typed.refresh === true ? refreshedProfile : cachedProfile,
          },
        };
      }) as never);

    await renderSidePanel();
    const targetEditor =
      container.querySelector<HTMLTextAreaElement>('.target-editor');
    expect(targetEditor).not.toBeNull();
    if (!targetEditor) throw new Error('TARGET_EDITOR_NOT_FOUND');
    await enterTextareaValue(targetEditor, 'https://blog.example/post');
    await clickButton('prepareBatch');
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Cached profile title');
    });
    return sendMessage;
  }

  it('shows a refresh button next to the website context', async () => {
    await showWebsiteContext();

    const refreshButton = Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === 'refreshWebsiteProfile'
    );
    expect(refreshButton).toBeDefined();
  });

  it('refetches the profile past the cache and shows the fresh metadata', async () => {
    const sendMessage = await showWebsiteContext();

    await clickButton('refreshWebsiteProfile');

    await vi.waitFor(() => {
      expect(container.textContent).toContain('Refreshed profile title');
    });
    expect(container.textContent).not.toContain('Cached profile title');
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'batch.preview', refresh: true })
    );
  });
});

describe('batch item retry', () => {
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

  function mockRetryResponse() {
    return vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation((async (
      message: unknown
    ) => {
      const typed = message as { type: string };
      if (typed.type !== 'batch.retry-items') {
        throw new Error('UNEXPECTED_MESSAGE');
      }
      return {
        ok: true,
        data: { type: 'batch.retry-items', data: twoItemBatch() },
      };
    }) as never);
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

  it('offers a per-row retry on a failed item and sends its id', async () => {
    let batch = twoItemBatch();
    batch = completeCurrentItem(batch, 'submitted', 'COMMENT_SUBMITTED', 2_000);
    batch = completeCurrentItem(batch, 'failed', 'FORM_PLAN_INVALID', 3_000);
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: batch.settings,
      [BATCH_STORAGE_KEY]: batch,
    });
    const sendMessage = mockRetryResponse();

    await renderSidePanel();

    await clickButton('batchRetryItem');

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'batch.retry-items',
        itemIds: ['batch-retry:1'],
      })
    );
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('batchRetryItem');
    });
  });

  it('offers a batch-level retry that sends every failed id', async () => {
    let batch = twoItemBatch();
    batch = completeCurrentItem(batch, 'no_form', 'NO_FORM', 2_000);
    batch = completeCurrentItem(batch, 'failed', 'BOOM', 3_000);
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: batch.settings,
      [BATCH_STORAGE_KEY]: batch,
    });
    const sendMessage = mockRetryResponse();

    await renderSidePanel();

    await clickButton('batchRetryFailed');

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'batch.retry-items',
        itemIds: ['batch-retry:0', 'batch-retry:1'],
      })
    );
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('batchRetryFailed');
    });
  });

  it('shows retry error code instead of generic comment submission failure', async () => {
    let batch = twoItemBatch();
    batch = completeCurrentItem(batch, 'no_form', 'NO_FORM', 2_000);
    batch = completeCurrentItem(batch, 'failed', 'BOOM', 3_000);
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: batch.settings,
      [BATCH_STORAGE_KEY]: batch,
    });
    vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation((async () => ({
      ok: false,
      error: {
        code: 'BATCH_RETRY_UNAVAILABLE',
        message: 'BATCH_RETRY_UNAVAILABLE',
      },
    })) as never);

    await renderSidePanel();
    await clickButton('batchRetryFailed');

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        'batchRetryItem: BATCH_RETRY_UNAVAILABLE'
      );
    });
    expect(container.textContent).not.toContain('commentFailed');
  });

  it('hides the batch-level retry when nothing failed', async () => {
    let batch = twoItemBatch();
    batch = completeCurrentItem(batch, 'submitted', 'COMMENT_SUBMITTED', 2_000);
    batch = completeCurrentItem(batch, 'submitted', 'COMMENT_SUBMITTED', 3_000);
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: batch.settings,
      [BATCH_STORAGE_KEY]: batch,
    });

    await renderSidePanel();

    expect(container.textContent).not.toContain('batchRetryFailed');
    expect(container.textContent).not.toContain('batchRetryItem');
  });

  it('does not offer retry while the batch is still running', async () => {
    let batch = twoItemBatch();
    batch = completeCurrentItem(batch, 'failed', 'BOOM', 2_000);
    expect(batch.status).toBe('running');
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: batch.settings,
      [BATCH_STORAGE_KEY]: batch,
    });

    await renderSidePanel();

    expect(container.textContent).not.toContain('batchRetryItem');
    expect(container.textContent).not.toContain('batchRetryFailed');
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
    expect(findButton('batchHistoryRetryFailed')).toBeDefined();
    expect(findButton('batchHistoryRetryUrl')).toBeDefined();
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
    expect(findButton('batchHistoryRetryUrl')).toBeUndefined();
  });

  it('retries a single archived url', async () => {
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: [historyEntry] });
    const sendMessage = mockRetryResponse();

    await renderSidePanel();
    await clickButton('batchHistoryRetryUrl');

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'batch.retry-from-history',
        historyId: 'hist-1',
        urls: ['https://forum.example/three'],
      })
    );
  });

  it('retries all failed urls of an entry without listing them', async () => {
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: [historyEntry] });
    const sendMessage = mockRetryResponse();

    await renderSidePanel();
    await clickButton('batchHistoryRetryFailed');

    const call = sendMessage.mock.calls.find(
      ([message]) =>
        (message as { type?: string }).type === 'batch.retry-from-history'
    );
    expect(call?.[0]).toMatchObject({
      type: 'batch.retry-from-history',
      historyId: 'hist-1',
    });
    expect((call?.[0] as { urls?: string[] }).urls).toBeUndefined();
  });

  it('disables history retry while a batch is active', async () => {
    const running = createBatch({
      id: 'active-batch',
      targetText: 'https://blog.example/live',
      settings: historyEntry.settings,
      now: 4_000,
    });
    await chrome.storage.local.set({
      [BATCH_STORAGE_KEY]: running,
      [HISTORY_STORAGE_KEY]: [historyEntry],
    });

    await renderSidePanel();

    expect(findButton('batchHistoryRetryUrl')?.disabled).toBe(true);
    expect(findButton('batchHistoryRetryFailed')?.disabled).toBe(true);
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

  function findButton(label: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label
    );
  }

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

  it('switches the edited fields when the settings site selector changes', async () => {
    await seed();
    await renderSidePanel();
    await clickButton('openSettings');

    const websiteInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="websiteUrlPlaceholder"]'
    );
    expect(websiteInput?.value).toBe('https://seedaudio.example');

    const siteSelect = container.querySelector<HTMLSelectElement>(
      '.site-manager select'
    );
    if (!siteSelect) throw new Error('SITE_SELECT_NOT_FOUND');
    await selectOption(siteSelect, 'muse');

    expect(websiteInput?.value).toBe('https://museimage.example');
  });

  it('disables remove for a single site and enables it after adding one', async () => {
    await renderSidePanel();
    await clickButton('openSettings');

    expect(findButton('siteRemove')?.disabled).toBe(true);
    await clickButton('siteAdd');
    expect(findButton('siteRemove')?.disabled).toBe(false);
  });

  it('persists an edited multi-site configuration on save', async () => {
    await seed();
    await renderSidePanel();
    await clickButton('openSettings');

    const siteSelect = container.querySelector<HTMLSelectElement>(
      '.site-manager select'
    );
    if (!siteSelect) throw new Error('SITE_SELECT_NOT_FOUND');
    await selectOption(siteSelect, 'muse');
    const labelInput = container.querySelector<HTMLInputElement>(
      'input[placeholder="siteLabelPlaceholder"]'
    );
    if (!labelInput) throw new Error('LABEL_INPUT_NOT_FOUND');
    await enterInputValue(labelInput, 'Muse Renamed');

    await clickButton('saveSettings');

    await vi.waitFor(() => {
      expect(container.textContent).toContain('settingsSaved');
    });
    const stored = (await chrome.storage.local.get(SETTINGS_STORAGE_KEY))[
      SETTINGS_STORAGE_KEY
    ] as { sites: Array<{ id: string; label: string }> };
    expect(stored.sites).toHaveLength(2);
    expect(stored.sites.find((site) => site.id === 'muse')?.label).toBe(
      'Muse Renamed'
    );
  });

  it('starts a batch for the site chosen in the setup picker', async () => {
    await seed();
    vi.spyOn(chrome.permissions, 'request').mockImplementation(
      (async () => true) as never
    );
    const profile = {
      url: 'https://museimage.example/',
      title: 'Museimage profile',
      description: 'A useful description',
    };
    const runningBatch = createBatch({
      id: 'batch-muse',
      targetText: 'https://blog.example/post',
      settings: {
        provider: 'deepseek',
        websiteUrl: 'https://museimage.example',
        displayName: '',
        email: '',
        linkMode: 'inline',
      },
      now: 1,
    });
    const sendMessage = vi
      .spyOn(chrome.runtime, 'sendMessage')
      .mockImplementation((async (message: unknown) => {
        const typed = message as { type: string };
        if (typed.type === 'batch.preview') {
          return { ok: true, data: { type: 'batch.preview', data: profile } };
        }
        if (typed.type === 'batch.start') {
          return {
            ok: true,
            data: { type: 'batch.start', data: runningBatch },
          };
        }
        throw new Error('UNEXPECTED_MESSAGE');
      }) as never);

    await renderSidePanel();

    const setupSelect = container.querySelector<HTMLSelectElement>(
      '.workspace-panel select'
    );
    if (!setupSelect) throw new Error('SETUP_SELECT_NOT_FOUND');
    await selectOption(setupSelect, 'muse');

    const targetEditor =
      container.querySelector<HTMLTextAreaElement>('.target-editor');
    if (!targetEditor) throw new Error('TARGET_EDITOR_NOT_FOUND');
    await enterTextareaValue(targetEditor, 'https://blog.example/post');

    await clickButton('prepareBatch');
    await vi.waitFor(() => {
      expect(container.textContent).toContain('Museimage profile');
    });
    await clickButton('confirmAndStartBatch');

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'batch.start', siteId: 'muse' })
      );
    });
  });

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

describe('site link plans', () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const twoSiteSettings = {
    provider: 'deepseek' as const,
    sites: [
      {
        id: 'seed',
        label: 'Seed Audio',
        websiteUrl: 'https://seedaudio.example',
        displayName: '',
        email: '',
        linkMode: 'prefer-website-field' as const,
      },
      {
        id: 'muse',
        label: 'Museimage',
        websiteUrl: 'https://muse.example',
        displayName: '',
        email: '',
        linkMode: 'inline' as const,
      },
    ],
    activeSiteId: 'seed',
  };

  function findButton(label: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label
    );
  }

  function mockPlanResponse(
    type: string,
    data: unknown
  ): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation((async (
      message: unknown
    ) => {
      if ((message as { type: string }).type !== type) {
        throw new Error('UNEXPECTED_MESSAGE');
      }
      return { ok: true, data: { type, data } };
    }) as never);
  }

  it('shows a due banner and runs the next chunk', async () => {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: twoSiteSettings,
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
    const running = createBatch({
      id: 'plan-run',
      targetText: 'https://a.example/1',
      settings: {
        provider: 'deepseek',
        websiteUrl: 'https://seedaudio.example',
        displayName: '',
        email: '',
        linkMode: 'prefer-website-field',
      },
      now: 1,
    });
    const sendMessage = mockPlanResponse('plan.run-next', running);

    await renderSidePanel();

    expect(container.textContent).toContain('planDueBanner');
    expect(container.textContent).toContain('Seed Audio');
    await clickButton('planRunNext');

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'plan.run-next', siteId: 'seed' })
    );
  });

  it('shows the done-today line when today’s chunk already ran', async () => {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: twoSiteSettings,
      [PLANS_STORAGE_KEY]: {
        seed: {
          siteId: 'seed',
          chunkSize: 1,
          chunks: [
            {
              id: 'c0',
              urls: ['https://a.example/1'],
              status: 'done',
              batchId: 'b',
              startedAt: Date.now(),
              completedAt: Date.now(),
            },
            { id: 'c1', urls: ['https://a.example/2'], status: 'pending' },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      },
    });

    await renderSidePanel();

    expect(container.textContent).toContain('planDoneToday');
    expect(container.textContent).not.toContain('planDueBanner');
  });

  it('hides the due banner while a batch is running', async () => {
    const running = createBatch({
      id: 'active',
      targetText: 'https://blog.example/live',
      settings: {
        provider: 'deepseek',
        websiteUrl: 'https://seedaudio.example',
        displayName: '',
        email: '',
        linkMode: 'prefer-website-field',
      },
      now: 1,
    });
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: twoSiteSettings,
      [BATCH_STORAGE_KEY]: running,
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

    await renderSidePanel();

    expect(container.textContent).not.toContain('planDueBanner');
  });
});
