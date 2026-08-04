import { getOutboundLinkLibrary } from '@/storage/outbound-link-library';
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  getTargetLibraryGateState,
  observeTargetLibrary,
} from './link-library-observer';

describe('batch outbound-link library adapter', () => {
  beforeEach(async () => {
    await fakeBrowser.reset();
  });

  it('stores explicit tri-state observations by canonical domain', async () => {
    await observeTargetLibrary('https://www.Example.com/post', {
      followStatus: 'dofollow',
      loginRequired: false,
      captchaRequired: false,
    });

    await expect(getOutboundLinkLibrary()).resolves.toEqual([
      expect.objectContaining({
        domain: 'example.com',
        followStatus: 'dofollow',
        loginRequired: false,
        captchaRequired: false,
      }),
    ]);
    await expect(
      getTargetLibraryGateState('http://example.com/another-post')
    ).resolves.toEqual({ loginRequired: false, captchaRequired: false });
  });

  it('updates only the observed fields and detects a known gate', async () => {
    await observeTargetLibrary('example.com', { loginRequired: true });
    await observeTargetLibrary('https://www.example.com/post', {
      captchaRequired: true,
    });

    await expect(
      getTargetLibraryGateState('https://example.com/next')
    ).resolves.toEqual({ loginRequired: true, captchaRequired: true });
    await expect(getOutboundLinkLibrary()).resolves.toEqual([
      expect.objectContaining({
        domain: 'example.com',
        followStatus: 'unknown',
        loginRequired: true,
        captchaRequired: true,
      }),
    ]);
  });
});
