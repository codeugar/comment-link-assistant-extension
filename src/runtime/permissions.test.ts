import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  hasBatchOriginPermissions,
  hasOriginPermissions,
  requestBatchOriginPermissions,
  requestOriginPermissions,
} from './permissions';

describe('runtime origin permissions', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('requests deduplicated origins directly inside the user gesture', async () => {
    const contains = vi.spyOn(chrome.permissions, 'contains');
    contains.mockImplementation((async () => false) as never);
    const request = vi.spyOn(chrome.permissions, 'request');
    request.mockImplementation((async () => true) as never);

    await expect(
      requestOriginPermissions([
        'https://blog.example/post',
        'https://blog.example/other',
        'http://forum.example/thread',
      ])
    ).resolves.toBe(true);

    expect(contains).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith({
      origins: ['https://blog.example/*', 'http://forum.example/*'],
    });
  });

  it('uses contains only for a non-interactive permission check', async () => {
    const contains = vi.spyOn(chrome.permissions, 'contains');
    contains.mockImplementation((async () => true) as never);

    await expect(
      hasOriginPermissions(['https://blog.example/post'])
    ).resolves.toBe(true);
    expect(contains).toHaveBeenCalledWith({
      origins: ['https://blog.example/*'],
    });
  });

  it('requests safe canonical origin variants for batch websites', async () => {
    const request = vi.spyOn(chrome.permissions, 'request');
    request.mockImplementation((async () => true) as never);

    await expect(
      requestBatchOriginPermissions([
        'https://source.example/product',
        'http://www.example.com/post',
        'https://product.test/thread',
      ])
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith({
      origins: [
        'https://source.example/*',
        'https://www.source.example/*',
        'http://www.example.com/*',
        'https://www.example.com/*',
        'http://example.com/*',
        'https://example.com/*',
        'https://product.test/*',
        'https://www.product.test/*',
      ],
    });
  });

  it('does not expand localhost or IP target permissions', async () => {
    const request = vi.spyOn(chrome.permissions, 'request');
    request.mockImplementation((async () => true) as never);

    await expect(
      requestBatchOriginPermissions([
        'http://localhost:3000/post',
        'http://127.0.0.1:8080/thread',
        'http://[::1]:9000/topic',
      ])
    ).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith({
      origins: [
        'http://localhost:3000/*',
        'http://127.0.0.1:8080/*',
        'http://[::1]:9000/*',
      ],
    });
  });

  it('covers a www canonical redirect for multi-part public suffixes', async () => {
    const request = vi.spyOn(chrome.permissions, 'request');
    request.mockImplementation((async () => true) as never);

    await requestBatchOriginPermissions(['https://example.co.uk/article']);

    expect(request).toHaveBeenCalledWith({
      origins: ['https://example.co.uk/*', 'https://www.example.co.uk/*'],
    });
  });

  it('checks the same canonical variants before the background starts a batch', async () => {
    const contains = vi.spyOn(chrome.permissions, 'contains');
    contains.mockImplementation((async () => true) as never);

    await expect(
      hasBatchOriginPermissions(['http://www.example.com/post'])
    ).resolves.toBe(true);

    expect(contains).toHaveBeenCalledWith({
      origins: [
        'http://www.example.com/*',
        'https://www.example.com/*',
        'http://example.com/*',
        'https://example.com/*',
      ],
    });
  });
});
