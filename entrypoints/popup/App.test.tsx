import { completeCurrentItem, createBatch } from '@/batch/state';
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

async function renderPopup(): Promise<void> {
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

describe('popup navigation', () => {
  it('opens on the target queue and uses a separate settings page', async () => {
    await renderPopup();

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
    await renderPopup();
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
    await renderPopup();
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

    await renderPopup();

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

    await renderPopup();

    expect(container.textContent).toContain('formNeedsReview');
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

    await renderPopup();

    expect(container.textContent).toContain('unsafeSubmitBlocked');
  });
});
