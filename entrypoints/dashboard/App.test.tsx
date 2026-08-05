import type { OutboundLinkLibraryEntry } from '@/storage/outbound-link-library';
import type { ExtensionSettings, ProviderApiKeys, SiteProfile } from '@/types';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreatePromotingSiteDialog,
  NewPlanDialog,
  OutboundLinkLibraryPage,
  SettingsDrawer,
} from './App';

let container: HTMLDivElement;
let root: Root;

const site: SiteProfile = {
  id: 'site-promoting',
  label: 'Promoting site',
  websiteUrl: 'https://promoting.example',
  displayName: '',
  email: '',
  linkMode: 'a-tag-newline',
};

const settings: ExtensionSettings = {
  provider: 'deepseek',
  sites: [site],
  activeSiteId: site.id,
  locale: 'zh-CN',
};

function entry(
  id: string,
  url = `https://${id}.example/article-${id}`
): OutboundLinkLibraryEntry {
  return {
    id,
    domain: new URL(url).hostname.replace(/^www\./, ''),
    url,
    tags: [],
    followStatus: 'unknown',
    loginRequired: null,
    captchaRequired: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  expect(found).toBeInstanceOf(HTMLButtonElement);
  return found as HTMLButtonElement;
}

async function click(target: Element): Promise<void> {
  await act(async () => {
    (target as HTMLElement).click();
  });
}

async function enterInput(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value'
  )?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function enterTextarea(textarea: HTMLTextAreaElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value'
  )?.set;
  await act(async () => {
    setValue?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('dashboard library and plan flow components', () => {
  it('imports selected complete library URLs into the existing plan text and resets selector selection', async () => {
    const entries = [
      entry('blog', 'https://blog.example/posts/123'),
      entry('forum', 'https://forum.example/thread/456'),
    ];
    await act(async () => {
      root.render(
        <NewPlanDialog
          open
          settings={settings}
          busy={false}
          source="plans"
          outboundLinkLibrary={entries}
          outboundLinkLibraryLoading={false}
          initialTargetText="https://existing.example"
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onCreatePromotingSite={vi.fn()}
          onOpenOutboundLibrary={vi.fn()}
        />
      );
    });

    const textarea = container.querySelector<HTMLTextAreaElement>(
      '.new-plan-dialog textarea'
    );
    expect(textarea?.value).toBe('https://existing.example');
    await click(button('从外链库选择'));

    const blogCheckbox = container.querySelector<HTMLInputElement>(
      'input[aria-label="从外链库选择 https://blog.example/posts/123"]'
    );
    expect(blogCheckbox).not.toBeNull();
    await click(blogCheckbox as HTMLInputElement);
    await click(button('导入到计划'));

    expect(textarea?.value).toBe(
      'https://existing.example\nhttps://blog.example/posts/123'
    );
    expect(
      container.querySelector('.outbound-link-selector-dialog')
    ).toBeNull();

    await click(button('从外链库选择'));
    expect(
      container.querySelector<HTMLButtonElement>('button.primary-button')
        ?.disabled
    ).toBe(true);
    const selectorCancel = Array.from(
      container.querySelectorAll('.outbound-link-selector-dialog button')
    ).find((candidate) => candidate.textContent?.trim() === '取消');
    expect(selectorCancel).toBeDefined();
    await click(selectorCancel as HTMLButtonElement);
    expect(textarea?.value).toBe(
      'https://existing.example\nhttps://blog.example/posts/123'
    );

    await enterInput(
      container.querySelector<HTMLInputElement>('.new-plan-form-grid input')!,
      'Old plan'
    );
    await enterInput(
      container.querySelector<HTMLInputElement>('.batch-size-field input')!,
      '42'
    );
    await act(async () => {
      root.render(
        <NewPlanDialog
          open
          settings={settings}
          busy={false}
          source="plans"
          outboundLinkLibrary={entries}
          outboundLinkLibraryLoading={false}
          initialTargetText="https://existing.example"
          nestedDialogOpen
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onCreatePromotingSite={vi.fn()}
          onOpenOutboundLibrary={vi.fn()}
        />
      );
    });
    expect(
      container.querySelector<HTMLInputElement>('.new-plan-form-grid input')
        ?.value
    ).toBe('Old plan');
    expect(
      container.querySelector<HTMLInputElement>('.batch-size-field input')
        ?.value
    ).toBe('42');

    await act(async () => {
      root.render(
        <NewPlanDialog
          open={false}
          settings={settings}
          busy={false}
          source="plans"
          outboundLinkLibrary={entries}
          outboundLinkLibraryLoading={false}
          initialTargetText="https://fresh.example"
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onCreatePromotingSite={vi.fn()}
          onOpenOutboundLibrary={vi.fn()}
        />
      );
    });
    await act(async () => {
      root.render(
        <NewPlanDialog
          open
          settings={settings}
          busy={false}
          source="plans"
          outboundLinkLibrary={entries}
          outboundLinkLibraryLoading={false}
          initialTargetText="https://fresh.example"
          onClose={vi.fn()}
          onCreate={vi.fn()}
          onCreatePromotingSite={vi.fn()}
          onOpenOutboundLibrary={vi.fn()}
        />
      );
    });
    expect(
      container.querySelector<HTMLInputElement>('.new-plan-form-grid input')
        ?.value
    ).toBe('');
    expect(
      container.querySelector<HTMLTextAreaElement>('.new-plan-dialog textarea')
        ?.value
    ).toBe('https://fresh.example');
    expect(
      container.querySelector<HTMLInputElement>('.batch-size-field input')
        ?.value
    ).toBe('30');
  });

  it('keeps library selection controls independent across pages', async () => {
    const entries = Array.from({ length: 55 }, (_, index) =>
      entry(`domain-${index + 1}`)
    );
    const onToggleSelected = vi.fn();
    await act(async () => {
      root.render(
        <OutboundLinkLibraryPage
          entries={entries}
          loading={false}
          refreshing={false}
          onRefresh={vi.fn()}
          onEntriesChange={vi.fn()}
          onToast={vi.fn()}
          selectedIds={new Set(['domain-1'])}
          onToggleSelected={onToggleSelected}
          onCreatePlan={vi.fn()}
        />
      );
    });

    const pageCheckbox = container.querySelector<HTMLInputElement>(
      '.outbound-library-selection-bar input[type="checkbox"]'
    );
    expect(pageCheckbox?.checked).toBe(false);
    await click(pageCheckbox as HTMLInputElement);
    expect(onToggleSelected).toHaveBeenCalledWith('domain-2');
    expect(onToggleSelected).toHaveBeenCalledWith('domain-50');

    await click(button('下一页'));
    expect(
      container.querySelector(
        'input[aria-label="从外链库选择 https://domain-55.example/article-domain-55"]'
      )
    ).not.toBeNull();
    expect(
      container.querySelector(
        'input[aria-label="从外链库选择 https://domain-1.example/article-domain-1"]'
      )
    ).toBeNull();
  });

  it('keeps site input errors in the shared promoting-site dialog', async () => {
    const onCreate = vi.fn(async () => site);
    await act(async () => {
      root.render(
        <CreatePromotingSiteDialog
          open
          settings={settings}
          busy={false}
          onClose={vi.fn()}
          onCreate={onCreate}
        />
      );
    });

    await click(button('新建推广网站'));
    expect(container.textContent).toContain('请填写推广网站名称。');
    expect(container.textContent).toContain('请填写推广网站 URL。');

    await enterInput(
      container.querySelector<HTMLInputElement>('#promoting-site-label')!,
      'New site'
    );
    await enterInput(
      container.querySelector<HTMLInputElement>('#promoting-site-url')!,
      'example.com'
    );
    await click(button('新建推广网站'));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'New site', websiteUrl: 'example.com' })
    );
  });
});

describe('settings drawer', () => {
  const apiKeys: ProviderApiKeys = {
    deepseekApiKey: 'existing-key',
    kieApiKey: '',
  };

  it('prefills the provider, API keys, and active site, and proposes edits on save', async () => {
    const onSave = vi.fn<
      (settings: ExtensionSettings, apiKeys: ProviderApiKeys) => Promise<void>
    >(async () => undefined);
    await act(async () => {
      root.render(
        <SettingsDrawer
          open
          settings={settings}
          apiKeys={apiKeys}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );
    });

    const deepseekInput = container.querySelector<HTMLInputElement>(
      '#settings-deepseek-key'
    );
    expect(deepseekInput?.value).toBe('existing-key');
    const siteLabelInput = container.querySelector<HTMLInputElement>(
      '#settings-site-label'
    );
    expect(siteLabelInput?.value).toBe(site.label);
    const siteUrlInput =
      container.querySelector<HTMLInputElement>('#settings-site-url');
    expect(siteUrlInput?.value).toBe(site.websiteUrl);

    await enterInput(siteLabelInput as HTMLInputElement, 'Renamed site');
    await click(button('保存设置'));

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const [savedSettings, savedApiKeys] = onSave.mock.calls[0] as [
      ExtensionSettings,
      ProviderApiKeys,
    ];
    expect(
      savedSettings.sites.find((candidate) => candidate.id === site.id)?.label
    ).toBe('Renamed site');
    expect(savedApiKeys.deepseekApiKey).toBe('existing-key');
  });

  it('disables removing the last site and re-enables it once another exists', async () => {
    await act(async () => {
      root.render(
        <SettingsDrawer
          open
          settings={settings}
          apiKeys={apiKeys}
          onClose={vi.fn()}
          onSave={vi.fn(async () => undefined)}
        />
      );
    });

    expect(button('删除网站').disabled).toBe(true);
    await click(button('新增网站'));
    expect(button('删除网站').disabled).toBe(false);
  });

  it('shows an inline error and keeps the drawer open when saving fails', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('SAVE_FAILED');
    });
    await act(async () => {
      root.render(
        <SettingsDrawer
          open
          settings={settings}
          apiKeys={apiKeys}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );
    });

    await click(button('保存设置'));

    await vi.waitFor(() => {
      expect(container.textContent).toContain('设置无法保存');
    });
    expect(container.querySelector('.settings-drawer')).not.toBeNull();
  });
});
