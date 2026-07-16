import {
  completeCurrentItem,
  createBatch,
  updateBatchProgress,
} from '@/batch/state';
import { BATCH_STORAGE_KEY } from '@/storage/batch';
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
