import { afterEach, describe, expect, it } from 'vitest';
import { verifyLinkFollow } from './link-follow';

const targetUrl = 'https://product.example/guide';
const fingerprint = 'A concrete, useful observation.';

afterEach(() => {
  document.body.innerHTML = '';
  document.defaultView?.history.replaceState({}, '', '/');
});

describe('link-follow verification', () => {
  it('records a body link with no rel attribute as dofollow', () => {
    document.body.innerHTML = `
      <article id="comment-17" class="comment">
        <div class="comment-content">${fingerprint} <a href="${targetUrl}">Guide</a></div>
      </article>
    `;

    expect(verifyLinkFollow(document, { targetUrl, fingerprint })).toEqual({
      status: 'dofollow',
      rel: null,
      href: targetUrl,
      surface: 'comment_body',
    });
  });

  it('records nofollow and stripped promoted links distinctly', () => {
    document.body.innerHTML = `
      <article class="comment">
        <div class="comment-content">${fingerprint} <a href="${targetUrl}" rel="ugc nofollow">Guide</a></div>
      </article>
    `;
    expect(
      verifyLinkFollow(document, { targetUrl, fingerprint })
    ).toMatchObject({
      status: 'nofollow',
      rel: 'ugc nofollow',
      surface: 'comment_body',
    });

    document.body.innerHTML = `<article class="comment"><div class="comment-content">${fingerprint}</div></article>`;
    expect(
      verifyLinkFollow(document, { targetUrl, fingerprint })
    ).toMatchObject({
      status: 'link_stripped',
      surface: 'comment_body',
    });
  });
});
