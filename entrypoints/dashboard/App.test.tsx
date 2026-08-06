import type { Plan, PlanBatch, PlanDetail } from '@/dashboard/model';
import type { AnchorTextTally } from '@/storage/anchor-ledger';
import type { DataBackupFile } from '@/storage/data-backup';
import type { OutboundLinkLibraryEntry } from '@/storage/outbound-link-library';
import type { ExtensionSettings, ProviderApiKeys, SiteProfile } from '@/types';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnchorTextBreakdown,
  CreatePromotingSiteDialog,
  EditPlanDialog,
  NewPlanDialog,
  OutboundLinkLibraryPage,
  SettingsDrawer,
  SitesPage,
  naturalAnchorFailureCopy,
} from './App';
import { t } from './copy';

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

function sampleBackup(): DataBackupFile {
  return {
    formatVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    appVersion: '0.5.1',
    data: {
      settings,
      providerApiKeys: { deepseekApiKey: 'existing-key', kieApiKey: '' },
      outboundLinkLibrary: [entry('backup-link')],
      filterList: [],
      anchorPlans: {},
      anchorLedgers: {},
      batchHistory: [],
      dashboard: {
        plans: [],
        batches: [],
        targets: [],
        runs: [],
        attempts: [],
        meta: [],
      },
    },
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

async function selectFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
  });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function waitUntil(
  predicate: () => boolean,
  maxAttempts = 20
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error('Timed out waiting for expected update');
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

  it('shows parsed row URLs and friendly error copy after importing a file', async () => {
    await act(async () => {
      root.render(
        <OutboundLinkLibraryPage
          entries={[]}
          loading={false}
          refreshing={false}
          onRefresh={vi.fn()}
          onEntriesChange={vi.fn()}
          onToast={vi.fn()}
          selectedIds={new Set()}
          onToggleSelected={vi.fn()}
          onCreatePlan={vi.fn()}
        />
      );
    });

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();

    const csv = [
      'https://example.com/post-1,是,否,否',
      ',是,否,否',
      'https://example.com/post-2,否,是,是',
    ].join('\n');
    const file = new File([csv], 'links.csv', { type: 'text/csv' });
    await selectFile(fileInput as HTMLInputElement, file);

    await waitUntil(() =>
      Boolean(container.textContent?.includes('https://example.com/post-1'))
    );

    expect(container.textContent).toContain('https://example.com/post-1');
    expect(container.textContent).toContain('https://example.com/post-2');

    const expectedRowError = t('outboundLinkImportRowError', [
      2,
      t('outboundLinkImportErrorUrlRequired'),
    ]);
    expect(container.textContent).toContain(expectedRowError);
    expect(container.textContent).not.toContain('URL_REQUIRED');
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

  it('prefills the provider and API keys, and proposes edits on save', async () => {
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
          onExportData={vi.fn(async () => sampleBackup())}
          onImportData={vi.fn(async () => undefined)}
          onImportComplete={vi.fn()}
          onToast={vi.fn()}
        />
      );
    });

    const deepseekInput = container.querySelector<HTMLInputElement>(
      '#settings-deepseek-key'
    );
    expect(deepseekInput?.value).toBe('existing-key');
    expect(
      container.querySelector<HTMLSelectElement>('#settings-provider')?.value
    ).toBe('deepseek');

    await enterInput(deepseekInput as HTMLInputElement, 'rotated-key');
    await click(button('保存设置'));

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const [savedSettings, savedApiKeys] = onSave.mock.calls[0] as [
      ExtensionSettings,
      ProviderApiKeys,
    ];
    expect(savedSettings.sites).toHaveLength(1);
    expect(savedApiKeys.deepseekApiKey).toBe('rotated-key');
  });

  it('no longer edits site profiles, which moved to the websites page', async () => {
    await act(async () => {
      root.render(
        <SettingsDrawer
          open
          settings={settings}
          apiKeys={apiKeys}
          onClose={vi.fn()}
          onSave={vi.fn(async () => undefined)}
          onExportData={vi.fn(async () => sampleBackup())}
          onImportData={vi.fn(async () => undefined)}
          onImportComplete={vi.fn()}
          onToast={vi.fn()}
        />
      );
    });

    for (const selector of [
      '#settings-site-select',
      '#settings-site-label',
      '#settings-site-url',
      '#settings-site-display-name',
      '#settings-site-email',
      '#settings-site-link-mode',
      '.anchor-mix',
    ]) {
      expect(container.querySelector(selector)).toBeNull();
    }
    expect(container.querySelector('#settings-provider')).not.toBeNull();
    expect(container.querySelector('#settings-locale')).not.toBeNull();
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
          onExportData={vi.fn(async () => sampleBackup())}
          onImportData={vi.fn(async () => undefined)}
          onImportComplete={vi.fn()}
          onToast={vi.fn()}
        />
      );
    });

    await click(button('保存设置'));

    await vi.waitFor(() => {
      expect(container.textContent).toContain('设置无法保存');
    });
    expect(container.querySelector('.settings-drawer')).not.toBeNull();
  });

  it('imports a backup file after showing a confirm dialog with a summary', async () => {
    const backup = sampleBackup();
    const onImportData = vi.fn(async () => undefined);
    const onImportComplete = vi.fn();
    const onToast = vi.fn();
    await act(async () => {
      root.render(
        <SettingsDrawer
          open
          settings={settings}
          apiKeys={apiKeys}
          onClose={vi.fn()}
          onSave={vi.fn(async () => undefined)}
          onExportData={vi.fn(async () => backup)}
          onImportData={onImportData}
          onImportComplete={onImportComplete}
          onToast={onToast}
        />
      );
    });

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    const file = new File([JSON.stringify(backup)], 'backup.json', {
      type: 'application/json',
    });
    await selectFile(fileInput as HTMLInputElement, file);

    await waitUntil(() =>
      Boolean(container.querySelector('.data-backup-confirm-dialog'))
    );
    expect(container.textContent).toContain(
      t('dataBackupSummaryOutboundLinks', [1])
    );

    await click(button(t('dataBackupImportConfirmAction')));

    await vi.waitFor(() => {
      expect(onImportData).toHaveBeenCalledWith(backup);
    });
    expect(onImportComplete).toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith(t('dataBackupImportSuccess'));
    expect(container.querySelector('.data-backup-confirm-dialog')).toBeNull();
  });

  it('cancels a pending import without calling onImportData', async () => {
    const backup = sampleBackup();
    const onImportData = vi.fn(async () => undefined);
    await act(async () => {
      root.render(
        <SettingsDrawer
          open
          settings={settings}
          apiKeys={apiKeys}
          onClose={vi.fn()}
          onSave={vi.fn(async () => undefined)}
          onExportData={vi.fn(async () => backup)}
          onImportData={onImportData}
          onImportComplete={vi.fn()}
          onToast={vi.fn()}
        />
      );
    });

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File([JSON.stringify(backup)], 'backup.json', {
      type: 'application/json',
    });
    await selectFile(fileInput as HTMLInputElement, file);

    await waitUntil(() =>
      Boolean(container.querySelector('.data-backup-confirm-dialog'))
    );
    await click(button(t('cancel')));

    expect(container.querySelector('.data-backup-confirm-dialog')).toBeNull();
    expect(onImportData).not.toHaveBeenCalled();
  });

  it('shows an error toast for an invalid backup file', async () => {
    const onToast = vi.fn();
    await act(async () => {
      root.render(
        <SettingsDrawer
          open
          settings={settings}
          apiKeys={apiKeys}
          onClose={vi.fn()}
          onSave={vi.fn(async () => undefined)}
          onExportData={vi.fn(async () => sampleBackup())}
          onImportData={vi.fn(async () => undefined)}
          onImportComplete={vi.fn()}
          onToast={onToast}
        />
      );
    });

    const fileInput =
      container.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(['not json'], 'backup.json', {
      type: 'application/json',
    });
    await selectFile(fileInput as HTMLInputElement, file);

    await vi.waitFor(() => {
      expect(onToast).toHaveBeenCalledWith(
        t('dataBackupImportInvalid'),
        'error'
      );
    });
    expect(container.querySelector('.data-backup-confirm-dialog')).toBeNull();
  });
});

describe('websites page', () => {
  const secondSite: SiteProfile = {
    id: 'site-secondary',
    label: 'Secondary site',
    websiteUrl: 'https://secondary.example',
    displayName: '',
    email: '',
    linkMode: 'comment-only',
  };

  async function renderSitesPage(
    props: Partial<Parameters<typeof SitesPage>[0]> = {}
  ) {
    const onSave = vi.fn<(next: ExtensionSettings) => Promise<void>>(
      async () => undefined
    );
    await act(async () => {
      root.render(
        <SitesPage
          settings={settings}
          refreshing={false}
          onRefresh={vi.fn()}
          onSave={onSave}
          onToast={vi.fn()}
          {...props}
        />
      );
    });
    return onSave;
  }

  it('edits the selected site profile and saves a normalized website URL', async () => {
    const onSave = await renderSitesPage();

    const labelInput = container.querySelector<HTMLInputElement>('#site-label');
    expect(labelInput?.value).toBe(site.label);
    const urlInput = container.querySelector<HTMLInputElement>('#site-url');
    expect(urlInput?.value).toBe(site.websiteUrl);

    await enterInput(labelInput as HTMLInputElement, 'Renamed site');
    await enterInput(urlInput as HTMLInputElement, 'promoting.example/');
    await click(button('保存网站'));

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const [saved] = onSave.mock.calls[0] as [ExtensionSettings];
    const savedSite = saved.sites.find((candidate) => candidate.id === site.id);
    expect(savedSite?.label).toBe('Renamed site');
    expect(savedSite?.websiteUrl).toBe('https://promoting.example');
  });

  it('disables removing the last site and re-enables it once another exists', async () => {
    await renderSitesPage();

    expect(button('删除网站').disabled).toBe(true);
    await click(button('新增网站'));
    expect(button('删除网站').disabled).toBe(false);
  });

  it('moves the default to a surviving site when the default one is deleted', async () => {
    const onSave = await renderSitesPage({
      settings: { ...settings, sites: [site, secondSite] },
    });

    // The first site is the default and is selected on load.
    await click(button('删除网站'));
    await click(button('保存网站'));

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const [saved] = onSave.mock.calls[0] as [ExtensionSettings];
    expect(saved.sites.map((candidate) => candidate.id)).toEqual([
      secondSite.id,
    ]);
    expect(saved.activeSiteId).toBe(secondSite.id);
  });

  it('promotes another site to the default without touching the rest of the profile', async () => {
    const onSave = await renderSitesPage({
      settings: { ...settings, sites: [site, secondSite] },
    });

    const secondEntry = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.sites-list button')
    ).find((candidate) => candidate.textContent?.includes(secondSite.label));
    await click(secondEntry as HTMLButtonElement);
    await click(button('设为默认网站'));
    await click(button('保存网站'));

    await vi.waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
    const [saved] = onSave.mock.calls[0] as [ExtensionSettings];
    expect(saved.activeSiteId).toBe(secondSite.id);
    expect(saved.sites).toHaveLength(2);
  });

  it('only offers the anchor mix for link modes that put the link in the comment body', async () => {
    await renderSitesPage({
      settings: { ...settings, sites: [site, secondSite] },
    });

    // The default site uses a-tag-newline, so the editor is present.
    expect(
      container.querySelector('.anchor-mix .anchor-mix-row')
    ).not.toBeNull();

    const linkMode =
      container.querySelector<HTMLSelectElement>('#site-link-mode');
    expect(linkMode?.value).toBe('a-tag-newline');
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        'value'
      )?.set;
      setValue?.call(linkMode, 'comment-only');
      linkMode?.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.querySelector('.anchor-mix .anchor-mix-row')).toBeNull();
    expect(container.textContent).toContain('只有把链接写进评论正文');
  });

  it('keeps in-progress edits when a background settings refresh arrives', async () => {
    await renderSitesPage();

    const labelInput = container.querySelector<HTMLInputElement>('#site-label');
    await enterInput(labelInput as HTMLInputElement, 'Edited but unsaved');

    await act(async () => {
      root.render(
        <SitesPage
          settings={{ ...settings, sites: [{ ...site }] }}
          refreshing={false}
          onRefresh={vi.fn()}
          onSave={vi.fn(async () => undefined)}
          onToast={vi.fn()}
        />
      );
    });

    expect(
      container.querySelector<HTMLInputElement>('#site-label')?.value
    ).toBe('Edited but unsaved');
  });
  it('lets a multi-word anchor be typed a character at a time', async () => {
    await renderSitesPage();

    await waitUntil(
      () => container.querySelector('#anchor-pool-brand') !== null
    );
    const pool =
      container.querySelector<HTMLTextAreaElement>('#anchor-pool-brand');

    // Re-rendering the parsed pool on every keystroke would swallow the
    // trailing space and the trailing newline, so neither a phrase nor a
    // second line could ever be typed.
    await enterTextarea(pool as HTMLTextAreaElement, 'AI ');
    expect(pool?.value).toBe('AI ');
    await enterTextarea(pool as HTMLTextAreaElement, 'AI video generator\n');
    expect(pool?.value).toBe('AI video generator\n');
    await enterTextarea(
      pool as HTMLTextAreaElement,
      'AI video generator\nseedance 2.5'
    );
    expect(pool?.value).toBe('AI video generator\nseedance 2.5');

    // Leaving the field is where the wording settles.
    await act(async () => {
      pool?.focus();
      pool?.blur();
    });
    expect(pool?.value).toBe('AI video generator\nseedance 2.5');
  });
});

describe('natural anchor fallback failures', () => {
  // The background answers with a code; each one needs a different fix, so a
  // single "check your key and URL" line would leave the user guessing.
  it.each([
    ['WEBSITE_URL_REQUIRED:WEBSITE_URL_REQUIRED', '先填好网站链接'],
    ['DEEPSEEK_API_KEY_REQUIRED:DEEPSEEK_API_KEY_REQUIRED', 'API Key'],
    ['KIE_API_KEY_REQUIRED:KIE_API_KEY_REQUIRED', 'API Key'],
    ['WEBSITE_FETCH_FAILED_403:WEBSITE_FETCH_FAILED_403', '读不到网站信息'],
    ['WEBSITE_META_NOT_FOUND:WEBSITE_META_NOT_FOUND', '读不到网站信息'],
    ['TypeError: Failed to fetch', '需要授权访问'],
  ])('maps %s to specific copy', (message, expected) => {
    expect(naturalAnchorFailureCopy(new Error(message))).toContain(expected);
  });

  it('falls back to the generic message for an unrecognized failure', () => {
    expect(naturalAnchorFailureCopy(new Error('SOMETHING_ELSE'))).toBe(
      '生成兜底词失败，请检查模型 API Key 和网站链接。'
    );
  });
});

describe('edit plan dialog', () => {
  function plan(overrides: Partial<Plan> = {}): Plan {
    return {
      id: 'plan-1',
      name: 'July comments',
      promotingSiteId: site.id,
      promotingSiteLabel: site.label,
      promotingWebsiteUrl: site.websiteUrl,
      status: 'active',
      chunkSize: 30,
      targetCount: 60,
      processedCount: 30,
      submittedCount: 28,
      failedCount: 2,
      unknownCount: 0,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    };
  }

  function batch(sequence: number, status: PlanBatch['status']): PlanBatch {
    return {
      id: `plan-1:batch:${sequence}`,
      planId: 'plan-1',
      sequence,
      status,
      targetCount: 30,
      processedCount: status === 'pending' ? 0 : 30,
      submittedCount: status === 'pending' ? 0 : 28,
      failedCount: status === 'pending' ? 0 : 2,
      unknownCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  const detail: PlanDetail = {
    plan: plan(),
    batches: [batch(1, 'completed_with_errors'), batch(2, 'pending')],
  };

  async function renderDialog(next: PlanDetail = detail) {
    const onSave =
      vi.fn<
        (input: {
          planId: string;
          name?: string;
          chunkSize?: number;
        }) => void
      >();
    await act(async () => {
      root.render(
        <EditPlanDialog
          detail={next}
          busy={false}
          onClose={vi.fn()}
          onSave={onSave}
        />
      );
    });
    return onSave;
  }

  it('previews how the untouched tail would be re-split', async () => {
    await renderDialog();

    // 30 links are still waiting; at 10 per batch that is 3 batches.
    expect(container.textContent).toContain('还剩 30 条待处理，将分成 1 批');
    await enterInput(
      container.querySelector<HTMLInputElement>('#edit-plan-chunk-size')!,
      '10'
    );
    expect(container.textContent).toContain('还剩 30 条待处理，将分成 3 批');
  });

  it('sends only the field that changed', async () => {
    const onSave = await renderDialog();

    await enterInput(
      container.querySelector<HTMLInputElement>('#edit-plan-chunk-size')!,
      '10'
    );
    await click(button('保存'));

    expect(onSave).toHaveBeenCalledWith({
      planId: 'plan-1',
      name: undefined,
      chunkSize: 10,
    });
  });

  it('keeps save disabled until something actually changes', async () => {
    await renderDialog();

    expect(button('保存').disabled).toBe(true);
    await enterInput(
      container.querySelector<HTMLInputElement>('#edit-plan-name')!,
      'August comments'
    );
    expect(button('保存').disabled).toBe(false);
  });

  it('refuses a batch size outside the range the repository accepts', async () => {
    await renderDialog();

    for (const value of ['0', '201', '']) {
      await enterInput(
        container.querySelector<HTMLInputElement>('#edit-plan-chunk-size')!,
        value
      );
      expect(button('保存').disabled).toBe(true);
    }
  });

  it('says so when there is no pending work left to regroup', async () => {
    await renderDialog({
      plan: plan({ processedCount: 60 }),
      batches: [batch(1, 'completed'), batch(2, 'completed')],
    });

    expect(container.textContent).toContain('所有批次都已跑完');
  });
});

describe('anchor text breakdown', () => {
  const rows: AnchorTextTally[] = [
    { bucket: 'brand', text: 'Seed Audio', count: 6, lastAt: 5 },
    { bucket: 'brand', text: 'Seed Audio app', count: 2, lastAt: 4 },
    { bucket: 'exact', text: 'AI video generator', count: 4, lastAt: 3 },
  ];

  async function renderBreakdown(
    props: Partial<Parameters<typeof AnchorTextBreakdown>[0]> = {}
  ) {
    await act(async () => {
      root.render(
        <AnchorTextBreakdown
          bucket="brand"
          rows={rows}
          published={8}
          {...props}
        />
      );
    });
  }

  it('ranks only this bucket wording and scales bars against its busiest row', async () => {
    await renderBreakdown();

    const listed = Array.from(
      container.querySelectorAll<HTMLElement>('.anchor-texts-row')
    );
    expect(
      listed.map((row) => row.querySelector('.anchor-texts-word')?.textContent)
    ).toEqual(['Seed Audio', 'Seed Audio app']);
    expect(listed[0]?.style.getPropertyValue('--anchor-text-share')).toBe(
      '100%'
    );
    // 2 of the busiest 6 is a third of the width.
    expect(listed[1]?.style.getPropertyValue('--anchor-text-share')).toBe(
      '33%'
    );
    expect(container.textContent).toContain('6 次');
  });

  it('says how many published links left no wording behind', async () => {
    await renderBreakdown({ published: 11 });

    expect(container.textContent).toContain('另有 3 条没有留下用词记录');
  });

  it('stays quiet until the bucket has published something', async () => {
    await renderBreakdown({ published: 0 });

    expect(container.querySelector('.anchor-texts')).toBeNull();
  });

  it('explains the gap when published links left no wording behind', async () => {
    await renderBreakdown({ rows: [], published: 4 });

    // Those links did go out; only their wording predates the tally, so the
    // block must say that rather than claim the bucket published nothing.
    expect(container.querySelector('.anchor-texts-row')).toBeNull();
    expect(container.textContent).toContain('另有 4 条没有留下用词记录');
  });

  it('collapses a long list behind a toggle', async () => {
    const many: AnchorTextTally[] = Array.from({ length: 9 }, (_, index) => ({
      bucket: 'brand' as const,
      text: `word-${index}`,
      count: 9 - index,
      lastAt: index,
    }));
    await renderBreakdown({ rows: many, published: 45 });

    expect(container.querySelectorAll('.anchor-texts-row')).toHaveLength(6);
    await click(button('展开全部 9 条'));
    expect(container.querySelectorAll('.anchor-texts-row')).toHaveLength(9);
    await click(button('收起'));
    expect(container.querySelectorAll('.anchor-texts-row')).toHaveLength(6);
  });
});
