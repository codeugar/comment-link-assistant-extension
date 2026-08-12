import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { sendToBackground } from './messages';

describe('background message client', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('returns typed dashboard and legacy plan responses', async () => {
    const sendMessage = vi.spyOn(chrome.runtime, 'sendMessage');
    sendMessage.mockResolvedValueOnce({
      ok: true,
      data: { type: 'plans.list', data: { plans: [] } },
    } as never);
    const plans = await sendToBackground({ type: 'plans.list' });
    expect(plans.type).toBe('plans.list');
    expect(plans.data.plans).toEqual([]);

    sendMessage.mockResolvedValueOnce({
      ok: true,
      data: {
        type: 'filter.list',
        data: [
          {
            id: 'filter-1',
            kind: 'domain',
            value: 'example.com',
            createdAt: 1,
          },
        ],
      },
    } as never);
    const filters = await sendToBackground({ type: 'filter.list' });
    expect(filters.type).toBe('filter.list');
    expect(filters.data[0]?.value).toBe('example.com');

    sendMessage.mockResolvedValueOnce({
      ok: true,
      data: {
        type: 'link-library.list',
        data: [
          {
            id: 'link-1',
            url: 'https://blog.example/post',
            tags: ['dofollow', 'login_required'],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    } as never);
    const library = await sendToBackground({ type: 'link-library.list' });
    expect(library.type).toBe('link-library.list');
    expect(library.data[0]?.tags).toEqual(['dofollow', 'login_required']);

    sendMessage.mockResolvedValueOnce({
      ok: true,
      data: {
        type: 'plan.rename',
        data: { id: 'plan-1', name: 'August plan' },
      },
    } as never);
    const renamed = await sendToBackground({
      type: 'plan.rename',
      planId: 'plan-1',
      name: 'August plan',
    });
    expect(renamed.type).toBe('plan.rename');
    expect(renamed.data.name).toBe('August plan');

    sendMessage.mockResolvedValueOnce({
      ok: true,
      data: {
        type: 'plan.deleteTarget',
        data: {
          id: 'target-1',
          planId: 'plan-1',
          url: 'https://blog.example/post',
        },
      },
    } as never);
    const deleted = await sendToBackground({
      type: 'plan.deleteTarget',
      planId: 'plan-1',
      targetId: 'target-1',
      addToFilter: true,
    });
    expect(deleted.type).toBe('plan.deleteTarget');
    expect(deleted.data.url).toBe('https://blog.example/post');

    sendMessage.mockResolvedValueOnce({
      ok: true,
      data: {
        type: 'plan.create',
        data: {
          siteId: 'site-1',
          chunkSize: 30,
          chunks: [],
          createdAt: 1,
          updatedAt: 1,
        },
      },
    } as never);
    const legacy = await sendToBackground({
      type: 'plan.create',
      siteId: 'site-1',
      targetText: 'https://blog.example/post',
      chunkSize: 30,
    });
    expect(legacy.data.siteId).toBe('site-1');
  });

  it('rejects structured errors and malformed responses', async () => {
    const sendMessage = vi.spyOn(chrome.runtime, 'sendMessage');
    sendMessage.mockResolvedValueOnce({
      ok: false,
      error: { code: 'PLAN_NOT_FOUND', message: 'missing plan' },
    } as never);
    await expect(sendToBackground({ type: 'plans.list' })).rejects.toThrow(
      'PLAN_NOT_FOUND:missing plan'
    );

    sendMessage.mockResolvedValueOnce({ unexpected: true } as never);
    await expect(
      sendToBackground({ type: 'dashboard.getSummary' })
    ).rejects.toThrow('BACKGROUND_RESPONSE_INVALID');
  });
});
