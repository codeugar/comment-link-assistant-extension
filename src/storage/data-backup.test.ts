import { createDefaultAnchorPlan, emptyAnchorPools } from '@/anchor/types';
import type { DashboardBackupData } from '@/dashboard/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { emptyAnchorLedger } from './anchor-ledger';
import type { BatchHistoryEntry } from './batch-history';
import {
  DATA_BACKUP_FORMAT_VERSION,
  DataBackupError,
  type DataBackupSections,
  FIRST_RUN_STORAGE_KEY,
  buildDataBackup,
  clearFirstRunPending,
  isDefaultExtensionSettings,
  isFirstRunPending,
  markFirstRunPending,
  parseDataBackupFile,
} from './data-backup';
import type { FilterListEntry } from './filter-list';
import type { OutboundLinkLibraryEntry } from './outbound-link-library';
import { createDefaultSettings } from './settings';

function sampleDashboard(): DashboardBackupData {
  return {
    plans: [
      {
        id: 'plan-1',
        name: 'July outreach',
        promotingSiteId: 'site-1',
        promotingSiteLabel: 'Product',
        promotingWebsiteUrl: 'https://product.example',
        status: 'active',
        chunkSize: 30,
        targetCount: 1,
        processedCount: 0,
        submittedCount: 0,
        failedCount: 0,
        unknownCount: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ],
    batches: [],
    targets: [],
    runs: [],
    attempts: [],
    meta: [{ key: 'legacy-import:v1', value: true, updatedAt: 1_000 }],
  };
}

function sampleOutboundLink(): OutboundLinkLibraryEntry {
  return {
    id: 'link-1',
    domain: 'blog.example',
    url: 'https://blog.example/post',
    tags: ['dofollow'],
    followStatus: 'dofollow',
    loginRequired: null,
    captchaRequired: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function sampleFilterEntry(): FilterListEntry {
  return {
    id: 'filter-1',
    kind: 'domain',
    value: 'spam.example',
    createdAt: 1_000,
  };
}

function sampleBatchHistoryEntry(): BatchHistoryEntry {
  return {
    id: 'history-1',
    settings: {
      provider: 'deepseek',
      websiteUrl: 'https://product.example',
      displayName: 'Alex',
      email: '',
      linkMode: 'a-tag-newline',
      siteId: 'site-1',
      siteLabel: 'Product',
    },
    createdAt: 1_000,
    archivedAt: 2_000,
    counts: {
      published: 1,
      pendingModeration: 0,
      unconfirmed: 0,
      failed: 0,
      total: 1,
    },
    items: [
      { url: 'https://blog.example/post', status: 'published', message: 'OK' },
    ],
  };
}

function sampleSections(): DataBackupSections {
  return {
    settings: createDefaultSettings(),
    providerApiKeys: { deepseekApiKey: 'sk-test', kieApiKey: '' },
    outboundLinkLibrary: [sampleOutboundLink()],
    filterList: [sampleFilterEntry()],
    batchHistory: [sampleBatchHistoryEntry()],
    dashboard: sampleDashboard(),
    anchorPlans: {},
    anchorLedgers: {},
  };
}

describe('data backup format', () => {
  it('round-trips a full backup through JSON serialization', () => {
    const built = buildDataBackup(
      sampleSections(),
      '1.2.3',
      () => new Date('2026-01-01T00:00:00.000Z')
    );
    expect(built.formatVersion).toBe(DATA_BACKUP_FORMAT_VERSION);
    expect(built.exportedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(built.appVersion).toBe('1.2.3');

    const roundTripped = JSON.parse(JSON.stringify(built));
    const parsed = parseDataBackupFile(roundTripped);

    expect(parsed).toEqual(built);
  });

  it('rejects a file that is not a valid backup envelope', () => {
    expect(() => parseDataBackupFile(null)).toThrow(DataBackupError);
    expect(() => parseDataBackupFile('just a string')).toThrow(DataBackupError);
    expect(() => parseDataBackupFile({ not: 'a backup' })).toThrow(
      DataBackupError
    );
    try {
      parseDataBackupFile({ not: 'a backup' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DataBackupError);
      expect((error as DataBackupError).code).toBe('BACKUP_FILE_INVALID');
    }
  });

  it('rejects a corrupted section independently with a specific error code', () => {
    const built = buildDataBackup(sampleSections(), '1.2.3');
    const raw = JSON.parse(JSON.stringify(built));
    raw.data.settings = { provider: 'not-a-real-provider' };
    try {
      parseDataBackupFile(raw);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DataBackupError);
      expect((error as DataBackupError).code).toBe(
        'BACKUP_SECTION_SETTINGS_INVALID'
      );
    }
  });

  it('rejects a corrupted dashboard section', () => {
    const built = buildDataBackup(sampleSections(), '1.2.3');
    const raw = JSON.parse(JSON.stringify(built));
    raw.data.dashboard = { plans: 'not-an-array' };
    try {
      parseDataBackupFile(raw);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DataBackupError);
      expect((error as DataBackupError).code).toBe(
        'BACKUP_SECTION_DASHBOARD_INVALID'
      );
    }
  });

  it('carries the anchor mix and its tally through a round trip', () => {
    const sections = sampleSections();
    sections.anchorPlans = {
      'site-1': {
        ...createDefaultAnchorPlan('site-1', 1_000),
        pools: {
          ...emptyAnchorPools(),
          brand: ['Example'],
        },
      },
    };
    sections.anchorLedgers = {
      'site-1': {
        ...emptyAnchorLedger('site-1', 1_000),
        published: {
          brand: 3,
          naked: 2,
          exact: 2,
          partial: 1,
          generic: 1,
          natural: 0,
        },
      },
    };

    const built = buildDataBackup(sections, '1.2.3');
    const parsed = parseDataBackupFile(JSON.parse(JSON.stringify(built)));

    expect(parsed.data.anchorPlans['site-1']?.pools.brand).toEqual(['Example']);
    expect(parsed.data.anchorLedgers['site-1']?.published.brand).toBe(3);
  });

  it('restores a backup written before anchor ratios existed', () => {
    const built = buildDataBackup(sampleSections(), '1.2.3');
    const raw = JSON.parse(JSON.stringify(built));
    raw.data.anchorPlans = undefined;
    raw.data.anchorLedgers = undefined;

    const parsed = parseDataBackupFile(raw);

    expect(parsed.data.anchorPlans).toEqual({});
    expect(parsed.data.anchorLedgers).toEqual({});
  });

  it('rejects a corrupted anchor mix section', () => {
    const built = buildDataBackup(sampleSections(), '1.2.3');
    const raw = JSON.parse(JSON.stringify(built));
    // Targets that do not add up to 100 are not a usable mix.
    raw.data.anchorPlans = {
      'site-1': {
        ...createDefaultAnchorPlan('site-1', 1_000),
        targets: {
          brand: 90,
          naked: 0,
          exact: 0,
          partial: 0,
          generic: 0,
          natural: 0,
        },
      },
    };
    try {
      parseDataBackupFile(raw);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DataBackupError);
      expect((error as DataBackupError).code).toBe(
        'BACKUP_SECTION_ANCHOR_PLANS_INVALID'
      );
    }
  });

  it('rejects a formatVersion newer than this build understands', () => {
    const built = buildDataBackup(sampleSections(), '1.2.3');
    const raw = { ...JSON.parse(JSON.stringify(built)), formatVersion: 2 };
    try {
      parseDataBackupFile(raw);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DataBackupError);
      expect((error as DataBackupError).code).toBe(
        'BACKUP_FORMAT_VERSION_UNSUPPORTED'
      );
    }
  });

  it('treats only an unconfigured settings object as default', () => {
    expect(isDefaultExtensionSettings(createDefaultSettings())).toBe(true);
    expect(
      isDefaultExtensionSettings({
        ...createDefaultSettings(),
        sites: [
          {
            id: 'site-1',
            label: 'My blog',
            websiteUrl: 'https://example.com',
            displayName: 'Alex',
            email: '',
            linkMode: 'a-tag-newline',
          },
        ],
      })
    ).toBe(false);
  });
});

describe('first-run pending flag', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('is unset until markFirstRunPending runs, and clears on demand', async () => {
    expect(await isFirstRunPending()).toBe(false);
    await markFirstRunPending();
    expect(await isFirstRunPending()).toBe(true);
    const stored = await chrome.storage.local.get(FIRST_RUN_STORAGE_KEY);
    expect(stored[FIRST_RUN_STORAGE_KEY]).toBe(true);
    await clearFirstRunPending();
    expect(await isFirstRunPending()).toBe(false);
  });
});
