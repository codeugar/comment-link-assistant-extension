import { describe, expect, it, vi } from 'vitest';
import {
  extractWebsiteProfile,
  fetchWebsiteProfile,
  normalizeWebsiteUrl,
  originPermissionPattern,
} from './profile';

describe('website profile extraction', () => {
  it('extracts title and description regardless of meta attribute order', () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <title>Example &amp; Tools</title>
          <meta content="Practical AI tools for creators." name="description">
        </head>
      </html>
    `;

    expect(extractWebsiteProfile(html, 'https://example.com/')).toEqual({
      url: 'https://example.com/',
      title: 'Example & Tools',
      description: 'Practical AI tools for creators.',
    });
  });

  it('uses Open Graph metadata as a fallback', () => {
    const html = `
      <meta property="og:title" content="Fallback title">
      <meta property="og:description" content="Fallback description">
    `;
    expect(extractWebsiteProfile(html, 'https://example.com')).toMatchObject({
      title: 'Fallback title',
      description: 'Fallback description',
    });
  });

  it('normalizes URLs and derives a least-scope permission pattern', () => {
    expect(normalizeWebsiteUrl('example.com/path#section')).toBe(
      'https://example.com/path'
    );
    expect(normalizeWebsiteUrl('https:seed-audio1.com')).toBe(
      'https://seed-audio1.com/'
    );
    expect(originPermissionPattern('https://example.com/path')).toBe(
      'https://example.com/*'
    );
    expect(() =>
      normalizeWebsiteUrl('https://user:password@example.com')
    ).toThrow('WEBSITE_URL_INVALID');
  });

  it('fetches the page without exposing provider credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        '<title>Fetched title</title><meta name="description" content="Fetched description">',
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }
      )
    );

    await expect(
      fetchWebsiteProfile('example.com', fetchMock, 100)
    ).resolves.toMatchObject({
      title: 'Fetched title',
      description: 'Fetched description',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/',
      expect.objectContaining({ method: 'GET', redirect: 'follow' })
    );
  });

  it('accepts a same-site canonical redirect and records the final URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://www.example.com/home',
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () =>
        '<title>Canonical title</title><meta name="description" content="Canonical description">',
    } as Response);

    await expect(
      fetchWebsiteProfile('http://example.com', fetchMock, 100)
    ).resolves.toMatchObject({
      url: 'https://www.example.com/home',
      title: 'Canonical title',
    });
  });

  it('rejects a promoted-site redirect to an unrelated origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://unrelated.example/landing',
      headers: new Headers({ 'content-type': 'text/html' }),
      text: async () =>
        '<title>Other title</title><meta name="description" content="Other description">',
    } as Response);

    await expect(
      fetchWebsiteProfile('https://example.com', fetchMock, 100)
    ).rejects.toThrow('WEBSITE_REDIRECT_UNSUPPORTED');
  });
});
