import {
  completeCurrentItem,
  createBatch,
  updateBatchProgress,
} from '@/batch/state';
import { BATCH_STORAGE_KEY } from '@/storage/batch';
import { HISTORY_STORAGE_KEY } from '@/storage/batch-history';
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

  it('shows a submitted comment as a successful terminal result', async () => {
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

    expect(container.textContent).toContain('batchStatusSubmitted');
    expect(container.querySelector('.status-submitted')).not.toBeNull();
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
    expect(findButton('batchHistoryRetryFailed')).toBeDefined();
    expect(findButton('batchHistoryRetryUrl')).toBeDefined();
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
