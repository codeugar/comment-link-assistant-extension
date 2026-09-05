import { createDefaultAnchorPlan } from '@/anchor/types';
import type { WritePageContext } from '@/page/types';
import { getAnchorLedger } from '@/storage/anchor-ledger';
import { getAnchorPlan, saveAnchorPlan } from '@/storage/anchor-plan';
import { getOutboundLinkLibrary } from '@/storage/outbound-link-library';
import {
  createDefaultSettings,
  setProviderApiKeys,
  setSettings,
} from '@/storage/settings';
import type { SiteProfile } from '@/types';
import { WEBSITE_PROFILE_CACHE_STORAGE_KEY } from '@/website/profile-cache';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  writeGet,
  writeMarkSent,
  writeReset,
  writeSend,
  writeSetAnchor,
  writeSetFormat,
  writeStart,
} from './service';
import { setWriteSession } from './session-store';
import type { WriteSession } from './types';

const SITE_ID = 'site-1';
const WEBSITE_URL = 'https://product.example';
const PAGE_URL = 'https://forum.example/thread/1';

const context: WritePageContext = {
  url: PAGE_URL,
  title: 'Why does my build fail on CI?',
  language: 'en',
  selection: null,
  firstPost: 'My CI build only fails on Linux and I cannot tell why.',
  replyCount: 2,
  source: 'first-post',
};

const site: SiteProfile = {
  id: SITE_ID,
  label: 'Product',
  websiteUrl: WEBSITE_URL,
  displayName: '',
  email: '',
  linkMode: 'a-tag-newline',
};

async function seedSettings(
  overrides: Partial<SiteProfile> = {}
): Promise<void> {
  const settings = createDefaultSettings();
  settings.sites = [{ ...site, ...overrides }];
  settings.activeSiteId = SITE_ID;
  settings.provider = 'deepseek';
  await setSettings(settings);
  await setProviderApiKeys({ deepseekApiKey: 'deepseek-key', kieApiKey: '' });
}

async function seedWebsiteProfileCache(): Promise<void> {
  await chrome.storage.local.set({
    [WEBSITE_PROFILE_CACHE_STORAGE_KEY]: {
      [WEBSITE_URL]: {
        profile: { url: WEBSITE_URL, title: 'Product Site', description: 'x' },
        fetchedAt: Date.now(),
      },
    },
  });
}

function deepseekReply(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
    { status: 200 }
  );
}

function makeSession(overrides: Partial<WriteSession> = {}): WriteSession {
  return {
    tabId: 1,
    pageUrl: PAGE_URL,
    siteId: SITE_ID,
    format: 'markdown',
    context,
    turns: [{ role: 'assistant', text: 'What angle interests you?', at: 1 }],
    drafts: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function activateTabWithContext(): Promise<number> {
  const tab = await fakeBrowser.tabs.create({
    url: PAGE_URL,
    active: true,
  });
  vi.spyOn(chrome.tabs, 'query').mockResolvedValue([
    tab,
  ] as unknown as chrome.tabs.Tab[]);
  vi.spyOn(chrome.tabs, 'sendMessage').mockImplementation(async () => ({
    type: 'context',
    context,
  }));
  return tab.id as number;
}

beforeEach(async () => {
  await fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeStart', () => {
  it('reads the active page, resolves the site, and starts a session with the first turn', async () => {
    await seedSettings();
    await seedWebsiteProfileCache();
    const tabId = await activateTabWithContext();
    vi.stubGlobal('fetch', async () =>
      deepseekReply({
        reply:
          'This thread is about a Linux-only CI failure. What have you already tried?',
      })
    );

    const session = await writeStart({ siteId: SITE_ID, format: 'markdown' });

    expect(session.tabId).toBe(tabId);
    expect(session.pageUrl).toBe(PAGE_URL);
    expect(session.siteId).toBe(SITE_ID);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({ role: 'assistant' });
    expect(session.drafts).toHaveLength(0);
  });

  it('throws SITE_NOT_FOUND for an unknown site id, never falling back to the active site', async () => {
    await seedSettings();
    await activateTabWithContext();

    await expect(
      writeStart({ siteId: 'does-not-exist', format: 'markdown' })
    ).rejects.toThrow('SITE_NOT_FOUND');
  });

  it('throws WRITE_CONTEXT_EMPTY when the page has no usable title or text', async () => {
    await seedSettings();
    await seedWebsiteProfileCache();
    const tab = await fakeBrowser.tabs.create({ url: PAGE_URL, active: true });
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([
      tab,
    ] as unknown as chrome.tabs.Tab[]);
    vi.spyOn(chrome.tabs, 'sendMessage').mockImplementation(async () => ({
      type: 'context',
      context: { ...context, title: '', firstPost: 'short' },
    }));

    await expect(
      writeStart({ siteId: SITE_ID, format: 'markdown' })
    ).rejects.toThrow('WRITE_CONTEXT_EMPTY');
  });
});

describe('writeSend', () => {
  it('throws WRITE_SESSION_NOT_FOUND when there is no session for the tab', async () => {
    await expect(writeSend({ tabId: 1, text: 'hi' })).rejects.toThrow(
      'WRITE_SESSION_NOT_FOUND'
    );
  });

  it('treats a session as stale once the tab navigated elsewhere, and clears it', async () => {
    await seedSettings();
    await setWriteSession(makeSession());
    await fakeBrowser.tabs.create({ url: 'https://forum.example/thread/2' });
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: 'https://forum.example/thread/2',
    } as chrome.tabs.Tab);

    await expect(writeSend({ tabId: 1, text: 'hi' })).rejects.toThrow(
      'WRITE_SESSION_STALE'
    );
    expect(await writeGet({ tabId: 1 })).toBeNull();
  });

  it('appends the user and assistant turns and stores a rendered draft', async () => {
    await seedSettings();
    await seedWebsiteProfileCache();
    await setWriteSession(makeSession());
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: PAGE_URL,
    } as chrome.tabs.Tab);
    vi.stubGlobal('fetch', async () =>
      deepseekReply({
        reply: 'Here is a draft comment for you.',
        draft: { comment: 'Worth a look at {LINK} for context.' },
      })
    );

    const session = await writeSend({
      tabId: 1,
      text: 'Focus on the caching bug.',
    });

    expect(session.turns).toHaveLength(3);
    expect(session.turns[1]).toMatchObject({
      role: 'user',
      text: 'Focus on the caching bug.',
    });
    expect(session.turns[2]).toMatchObject({ role: 'assistant' });
    expect(session.drafts).toHaveLength(1);
    expect(session.drafts[0]?.version).toBe(1);
    expect(session.drafts[0]?.template).toBe(
      'Worth a look at {LINK} for context.'
    );
    expect(session.drafts[0]?.rendered).toContain('(https://product.example)');
  });

  it('re-reads the tab and swaps in a fresh selection made mid-conversation', async () => {
    await seedSettings();
    await seedWebsiteProfileCache();
    await setWriteSession(makeSession());
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: PAGE_URL,
    } as chrome.tabs.Tab);
    vi.spyOn(chrome.tabs, 'sendMessage').mockImplementation(async () => ({
      type: 'context',
      context: {
        ...context,
        selection: 'This is the reply I just selected on the page.',
      },
    }));
    vi.stubGlobal('fetch', async () =>
      deepseekReply({ reply: 'Responding to the reply you selected.' })
    );

    const session = await writeSend({
      tabId: 1,
      text: 'Respond to the one I just selected.',
    });

    expect(session.context.selection).toBe(
      'This is the reply I just selected on the page.'
    );
    // Nothing else about the context was disturbed by the re-read.
    expect(session.context.title).toBe(context.title);
  });

  it('keeps the original context when the tab has since navigated elsewhere', async () => {
    await seedSettings();
    await seedWebsiteProfileCache();
    await setWriteSession(makeSession());
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: PAGE_URL,
    } as chrome.tabs.Tab);
    vi.spyOn(chrome.tabs, 'sendMessage').mockImplementation(async () => ({
      type: 'context',
      context: {
        ...context,
        url: 'https://forum.example/thread/2',
        selection: 'Selection from an unrelated page.',
      },
    }));
    vi.stubGlobal('fetch', async () =>
      deepseekReply({ reply: 'Still talking about the original thread.' })
    );

    const session = await writeSend({ tabId: 1, text: 'Keep going.' });

    expect(session.context.selection).toBeNull();
  });

  it('does not add a draft when the model sends none', async () => {
    await seedSettings();
    await seedWebsiteProfileCache();
    await setWriteSession(makeSession());
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: PAGE_URL,
    } as chrome.tabs.Tab);
    vi.stubGlobal('fetch', async () =>
      deepseekReply({ reply: 'Tell me more first.' })
    );

    const session = await writeSend({ tabId: 1, text: 'not sure yet' });

    expect(session.drafts).toHaveLength(0);
  });
});

describe('writeSetFormat and writeSetAnchor', () => {
  async function seedSessionWithDraft(): Promise<void> {
    await seedSettings();
    await seedWebsiteProfileCache();
    await setWriteSession(
      makeSession({
        drafts: [
          {
            id: 'draft-1',
            version: 1,
            template: 'Worth a look at {LINK} for context.',
            anchorBucket: null,
            anchorText: 'a useful resource',
            rendered: '[a useful resource](https://product.example)',
            format: 'markdown',
            createdAt: 1,
          },
        ],
      })
    );
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: PAGE_URL,
    } as chrome.tabs.Tab);
  }

  it('re-renders every draft in the new format', async () => {
    await seedSessionWithDraft();

    const session = await writeSetFormat({ tabId: 1, format: 'bbcode' });

    expect(session.format).toBe('bbcode');
    expect(session.drafts[0]?.format).toBe('bbcode');
    expect(session.drafts[0]?.rendered).toBe(
      'Worth a look at [url=https://product.example]a useful resource[/url] for context.'
    );
  });

  it('re-renders only the targeted draft and keeps its anchor bucket', async () => {
    await seedSessionWithDraft();

    const session = await writeSetAnchor({
      tabId: 1,
      draftId: 'draft-1',
      anchorText: 'a different phrase',
    });

    expect(session.drafts[0]?.anchorText).toBe('a different phrase');
    expect(session.drafts[0]?.anchorBucket).toBeNull();
    expect(session.drafts[0]?.rendered).toContain('a different phrase');
  });

  it('throws WRITE_DRAFT_NOT_FOUND for an unknown draft id', async () => {
    await seedSessionWithDraft();

    await expect(
      writeSetAnchor({ tabId: 1, draftId: 'missing', anchorText: 'x' })
    ).rejects.toThrow('WRITE_DRAFT_NOT_FOUND');
  });
});

describe('writeGet and writeReset', () => {
  it('returns null when there is no session', async () => {
    expect(await writeGet({ tabId: 42 })).toBeNull();
  });

  it('clears a session on reset', async () => {
    await setWriteSession(makeSession());
    await writeReset({ tabId: 1 });
    expect(await writeGet({ tabId: 1 })).toBeNull();
  });
});

describe('writeMarkSent', () => {
  async function seedSentTest(): Promise<WriteSession> {
    await seedSettings();
    const session = makeSession({
      drafts: [
        {
          id: 'draft-1',
          version: 1,
          template: 'Worth a look at {LINK} for context.',
          anchorBucket: 'brand',
          anchorText: 'Product Site',
          rendered: '[Product Site](https://product.example)',
          format: 'markdown',
          createdAt: 1,
        },
      ],
    });
    await setWriteSession(session);
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: PAGE_URL,
    } as chrome.tabs.Tab);
    return session;
  }

  it('records the anchor as published, adds the page to the outbound link library, and stamps sentAt', async () => {
    await seedSentTest();

    const session = await writeMarkSent({
      tabId: 1,
      draftId: 'draft-1',
      addToRecheck: false,
    });

    expect(session.drafts[0]?.sentAt).toBeTypeOf('number');
    const ledger = await getAnchorLedger(SITE_ID);
    expect(ledger.published.brand).toBe(1);
    const library = await getOutboundLinkLibrary();
    expect(library.some((entry) => entry.url === PAGE_URL)).toBe(true);
  });

  it('adds a moderation re-check entry when asked', async () => {
    await seedSentTest();

    await writeMarkSent({ tabId: 1, draftId: 'draft-1', addToRecheck: true });

    const { loadManualModerationEntries } = await import(
      '@/dashboard/moderation-recheck'
    );
    const entries = await loadManualModerationEntries();
    expect(entries.some((entry) => entry.pageUrl === PAGE_URL)).toBe(true);
  });

  it('is idempotent: sending twice never double-records the ledger', async () => {
    await seedSentTest();

    await writeMarkSent({ tabId: 1, draftId: 'draft-1', addToRecheck: false });
    await writeMarkSent({ tabId: 1, draftId: 'draft-1', addToRecheck: false });

    const ledger = await getAnchorLedger(SITE_ID);
    expect(ledger.published.brand).toBe(1);
  });

  it('throws WRITE_DRAFT_NOT_FOUND for an unknown draft', async () => {
    await seedSentTest();

    await expect(
      writeMarkSent({ tabId: 1, draftId: 'missing', addToRecheck: false })
    ).rejects.toThrow('WRITE_DRAFT_NOT_FOUND');
  });

  it('derives what it records from the draft format at send time, not the format it was drawn under', async () => {
    await seedSettings();
    // Drawn under bbcode with a real bucket, then switched to `none` before
    // being sent: nothing must be recorded, because `none` never carried a
    // link — the rotation cost already happened when it was drawn.
    const session = makeSession({
      drafts: [
        {
          id: 'draft-1',
          version: 1,
          template: 'Worth a look at {LINK} for context.',
          anchorBucket: 'brand',
          anchorText: 'Product Site',
          rendered: 'Worth a look at for context.',
          format: 'none',
          createdAt: 1,
        },
      ],
    });
    await setWriteSession(session);
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: PAGE_URL,
    } as chrome.tabs.Tab);

    await writeMarkSent({ tabId: 1, draftId: 'draft-1', addToRecheck: false });

    const ledger = await getAnchorLedger(SITE_ID);
    expect(ledger.published.brand).toBe(0);
    expect(ledger.published.naked).toBe(0);
  });

  it('records the naked bucket against the site URL for a bare-url draft, ignoring any stored bucket', async () => {
    await seedSettings();
    const session = makeSession({
      drafts: [
        {
          id: 'draft-1',
          version: 1,
          template: 'Worth a look at {LINK} for context.',
          anchorBucket: 'brand',
          anchorText: 'Product Site',
          rendered: `Worth a look at ${WEBSITE_URL} for context.`,
          format: 'bare-url',
          createdAt: 1,
        },
      ],
    });
    await setWriteSession(session);
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: PAGE_URL,
    } as chrome.tabs.Tab);

    await writeMarkSent({ tabId: 1, draftId: 'draft-1', addToRecheck: false });

    const ledger = await getAnchorLedger(SITE_ID);
    expect(ledger.published.naked).toBe(1);
    expect(ledger.published.brand).toBe(0);
    expect(ledger.texts.find((row) => row.bucket === 'naked')?.text).toBe(
      WEBSITE_URL
    );
  });

  it('persists sentAt and the ledger write even when the re-check enrollment fails unexpectedly, and surfaces the error', async () => {
    await seedSentTest();
    const moderationModule = await import('@/dashboard/moderation-recheck');
    vi.spyOn(moderationModule, 'addManualModerationEntry').mockRejectedValue(
      new Error('MODERATION_RECHECK_UNEXPECTED')
    );

    const result = await writeMarkSent({
      tabId: 1,
      draftId: 'draft-1',
      addToRecheck: true,
    });

    expect(result.drafts[0]?.sentAt).toBeTypeOf('number');
    expect(result.recheckError).toBe('MODERATION_RECHECK_UNEXPECTED');
    const ledger = await getAnchorLedger(SITE_ID);
    expect(ledger.published.brand).toBe(1);

    // A retry must see the draft as already sent and never touch the ledger
    // again, even though the re-check enrollment never actually succeeded.
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: PAGE_URL,
    } as chrome.tabs.Tab);
    const retry = await writeMarkSent({
      tabId: 1,
      draftId: 'draft-1',
      addToRecheck: true,
    });
    expect(retry.recheckError).toBeUndefined();
    const ledgerAfterRetry = await getAnchorLedger(SITE_ID);
    expect(ledgerAfterRetry.published.brand).toBe(1);
  });
});

describe('anchor selection depends on the session format', () => {
  async function seedSendable(format: WriteSession['format']): Promise<void> {
    await seedSettings();
    await seedWebsiteProfileCache();
    await setWriteSession(makeSession({ format }));
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: PAGE_URL,
    } as chrome.tabs.Tab);
  }

  it('draws no anchor and never touches the plan for format none', async () => {
    await seedSendable('none');
    // A plan with a non-empty pool would prove a draw happened if one did;
    // its cursor staying untouched shows format `none` never consulted it.
    await saveAnchorPlan({
      ...createDefaultAnchorPlan(SITE_ID, 1),
      targets: {
        brand: 100,
        naked: 0,
        exact: 0,
        partial: 0,
        generic: 0,
        natural: 0,
      },
      pools: {
        brand: ['Product Site'],
        naked: [],
        exact: [],
        partial: [],
        generic: [],
        natural: [],
      },
    });
    vi.stubGlobal('fetch', async () =>
      deepseekReply({
        reply: 'Here is a draft.',
        draft: { comment: 'Worth a look at {LINK} for context.' },
      })
    );

    const session = await writeSend({ tabId: 1, text: 'go on' });

    expect(session.drafts[0]?.anchorBucket).toBeNull();
    expect(session.drafts[0]?.anchorText).toBeNull();
    expect(session.drafts[0]?.rendered).not.toContain('{LINK}');
    const plan = await getAnchorPlan(SITE_ID);
    expect(plan.cursor.brand).toBe(0);
  });

  it('records the naked bucket with the site URL for format bare-url without drawing from the plan', async () => {
    await seedSendable('bare-url');
    vi.stubGlobal('fetch', async () =>
      deepseekReply({
        reply: 'Here is a draft.',
        draft: { comment: 'Worth a look at {LINK} for context.' },
      })
    );

    const session = await writeSend({ tabId: 1, text: 'go on' });

    expect(session.drafts[0]?.anchorBucket).toBe('naked');
    expect(session.drafts[0]?.anchorText).toBe(WEBSITE_URL);
    expect(session.drafts[0]?.rendered).toContain(WEBSITE_URL);
  });

  it('draws from the anchor plan for markdown/bbcode/html formats', async () => {
    await seedSendable('markdown');
    await saveAnchorPlan({
      ...createDefaultAnchorPlan(SITE_ID, 1),
      targets: {
        brand: 100,
        naked: 0,
        exact: 0,
        partial: 0,
        generic: 0,
        natural: 0,
      },
      pools: {
        brand: ['Product Site', 'Product Co'],
        naked: [],
        exact: [],
        partial: [],
        generic: [],
        natural: [],
      },
    });
    vi.stubGlobal('fetch', async () =>
      deepseekReply({
        reply: 'Here is a draft.',
        draft: { comment: 'Worth a look at {LINK} for context.' },
      })
    );

    const session = await writeSend({ tabId: 1, text: 'go on' });

    expect(session.drafts[0]?.anchorBucket).toBe('brand');
    expect(session.drafts[0]?.anchorText).toBe('Product Site');
  });
});

describe('anchor rotation is only spent once a draft is produced', () => {
  async function seedRotationPlan(): Promise<void> {
    await saveAnchorPlan({
      ...createDefaultAnchorPlan(SITE_ID, 1),
      targets: {
        brand: 100,
        naked: 0,
        exact: 0,
        partial: 0,
        generic: 0,
        natural: 0,
      },
      pools: {
        brand: ['Product Site', 'Product Co'],
        naked: [],
        exact: [],
        partial: [],
        generic: [],
        natural: [],
      },
    });
  }

  it('never advances the cursor on a turn that produced no draft', async () => {
    await seedSettings();
    await seedWebsiteProfileCache();
    await seedRotationPlan();
    await setWriteSession(makeSession({ format: 'markdown' }));
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: PAGE_URL,
    } as chrome.tabs.Tab);
    vi.stubGlobal('fetch', async () =>
      deepseekReply({ reply: 'Tell me more first.' })
    );

    await writeSend({ tabId: 1, text: 'not sure yet' });

    const plan = await getAnchorPlan(SITE_ID);
    expect(plan.cursor.brand).toBe(0);
  });

  it('advances and persists the cursor once a draft is produced', async () => {
    await seedSettings();
    await seedWebsiteProfileCache();
    await seedRotationPlan();
    await setWriteSession(makeSession({ format: 'markdown' }));
    vi.spyOn(chrome.tabs, 'get').mockResolvedValue({
      id: 1,
      url: PAGE_URL,
    } as chrome.tabs.Tab);
    vi.stubGlobal('fetch', async () =>
      deepseekReply({
        reply: 'Here is a draft.',
        draft: { comment: 'Worth a look at {LINK} for context.' },
      })
    );

    await writeSend({ tabId: 1, text: 'go on' });

    const plan = await getAnchorPlan(SITE_ID);
    expect(plan.cursor.brand).toBe(1);
  });
});
