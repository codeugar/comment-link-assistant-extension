import { describe, expect, it, vi } from 'vitest';
import {
  fetchPublicPageContainsFingerprint,
  publicCommentHtmlContainsFingerprint,
} from './public-visibility';

const fingerprint = 'I’d use https://product.example because it’s practical.';

describe('public comment visibility', () => {
  it('checks a visible comment container without sending session credentials', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          '<article class="comment">I&rsquo;d use <a href="https://product.example">https://product.example</a> because it&rsquo;s practical.</article>',
          { status: 200, headers: { 'content-type': 'text/html' } }
        )
      );

    await expect(
      fetchPublicPageContainsFingerprint(
        'https://blog.example/post#comment-42',
        fingerprint,
        fetchMock
      )
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://blog.example/post',
      expect.objectContaining({
        method: 'GET',
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
      })
    );
  });

  it('ignores matching text in the article body and hidden comment previews', () => {
    const html = `
      <main><p>${fingerprint}</p></main>
      <section class="comments-area">
        <article class="comment" hidden>${fingerprint}</article>
        <article class="comment pending">${fingerprint}</article>
        <div class="comment-preview">${fingerprint}</div>
        <form class="comment-form"><textarea>${fingerprint}</textarea></form>
      </section>
    `;

    expect(publicCommentHtmlContainsFingerprint(html, fingerprint)).toBe(false);
  });

  it('does not expose attribute text after a quoted greater-than character', () => {
    const html = `<article class="comment" data-preview="not visible > ${fingerprint}">Different visible text</article>`;

    expect(publicCommentHtmlContainsFingerprint(html, fingerprint)).toBe(false);
  });

  it('finds the comment class after a quoted greater-than character', () => {
    const html = `<article data-note="one > two" class="comment">${fingerprint}</article>`;

    expect(publicCommentHtmlContainsFingerprint(html, fingerprint)).toBe(true);
  });

  it('rejects a public page larger than the verification boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<article class="comment">visible</article>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-length': '2000001',
        },
      })
    );

    await expect(
      fetchPublicPageContainsFingerprint(
        'https://blog.example/post',
        'visible',
        fetchMock
      )
    ).resolves.toBe(false);
  });
});
