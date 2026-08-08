import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPublicComment } from './public-comment';

function restResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function htmlResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://blog.example/article',
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

const PAGE = 'https://blog.example/article';
const PROMOTED = 'https://product.example';

describe('anonymous public comment check', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the comment id over the public REST route without a session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      restResponse({
        id: 88213,
        link: 'https://blog.example/article#comment-88213',
        content: {
          rendered: '<p>Nice <a href="https://product.example">P</a></p>',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      checkPublicComment({
        pageUrl: `${PAGE}#comment-88213`,
        websiteUrl: PROMOTED,
        commentId: '88213',
      })
    ).resolves.toMatchObject({ visibility: 'visible', method: 'wp_rest' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://blog.example/wp-json/wp/v2/comments/88213',
      expect.objectContaining({ credentials: 'omit', cache: 'no-store' })
    );
  });

  it('matches a promoted link whose href carries a trailing newline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        restResponse({
          id: 1,
          link: 'https://blog.example/article#comment-1',
          content: {
            rendered: '<p>See <a href="https://product.example\n">P</a></p>',
          },
        })
      )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        websiteUrl: PROMOTED,
        commentId: '1',
      })
    ).resolves.toMatchObject({ visibility: 'visible' });
  });

  it('accepts the promoted link on the author byline, not only in the body', async () => {
    // Default link mode puts the promoted URL in the comment form's website
    // field, so it renders on the author name and never in the body.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        restResponse({
          id: 500,
          link: 'https://blog.example/article#comment-500',
          author_url: 'https://product.example/',
          content: { rendered: '<p>Nice post, thanks for the roundup.</p>' },
        })
      )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        websiteUrl: PROMOTED,
        commentId: '500',
      })
    ).resolves.toMatchObject({ visibility: 'visible', method: 'wp_rest' });
  });

  it('ignores a REST comment that belongs to another install on the origin', async () => {
    // WordPress under /blog/, something else at the root: comment 500 there is
    // a different comment that happens to share the id.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          restResponse({
            id: 500,
            link: 'https://blog.example/unrelated-root-post#comment-500',
            content: { rendered: '<p>Someone else entirely</p>' },
          })
        )
        .mockResolvedValueOnce(
          htmlResponse(
            `<ol class="comment-list"><li id="comment-500"><p>Ours <a href="https://product.example">P</a></p></li></ol>`
          )
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: 'https://blog.example/blog/post/',
        websiteUrl: PROMOTED,
        commentId: '500',
      })
    ).resolves.toMatchObject({ visibility: 'visible', method: 'html' });
  });

  it('never reads a page through its moderation-hash preview URL', async () => {
    // That URL shows a held comment to anyone who has the hash, so reading it
    // would prove nothing about the public page.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        htmlResponse('<ol class="comment-list"><li id="comment-7">x</li></ol>')
      );
    vi.stubGlobal('fetch', fetchMock);

    await checkPublicComment({
      pageUrl: `${PAGE}?unapproved=7&moderation-hash=abc`,
      websiteUrl: PROMOTED,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://blog.example/article',
      expect.objectContaining({ credentials: 'omit' })
    );
  });

  it('cannot decide from a page with no recognizable comments region', async () => {
    // The article itself links to the promoted site, which proves nothing
    // about a comment.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        htmlResponse(
          `<article>Read more at <a href="https://product.example">Product</a></article>
           <section class="post-conversation">no markers here</section>`
        )
      )
    );

    await expect(
      checkPublicComment({ pageUrl: PAGE, websiteUrl: PROMOTED })
    ).resolves.toMatchObject({ visibility: 'inconclusive', method: 'html' });
  });

  it('stops the last comment block before the reply form and the footer', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(restResponse({ code: 'rest_no_route' }, 404))
        .mockResolvedValueOnce(
          htmlResponse(
            `<ol class="comment-list">
               <li id="comment-88"><p>Ours, link removed</p></li>
             </ol>
             <div id="respond"><form></form></div>
             <aside class="widget recent-comments">
               <a href="https://product.example">P</a>
             </aside>`
          )
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        websiteUrl: PROMOTED,
        commentId: '88',
      })
    ).resolves.toMatchObject({ visibility: 'link_stripped', method: 'html' });
  });

  it('treats a refused comment id as decisively not visible', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          restResponse({ code: 'rest_comment_invalid_id' }, 404)
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        websiteUrl: PROMOTED,
        commentId: '4242',
      })
    ).resolves.toMatchObject({ visibility: 'not_visible', method: 'wp_rest' });
  });

  it('falls back to the page when the REST route itself is missing', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(restResponse({ code: 'rest_no_route' }, 404))
      .mockResolvedValueOnce(
        htmlResponse(
          `<ol class="comment-list">
             <li id="comment-77"><p>Other comment</p></li>
             <li id="comment-88"><p>Ours <a href="https://product.example/">P</a></p></li>
           </ol>`
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        websiteUrl: PROMOTED,
        commentId: '88',
      })
    ).resolves.toMatchObject({ visibility: 'visible', method: 'html' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads the page when a security plugin walls off the REST API', async () => {
    // Observed on a live target: the plugin answers 401 for every id, so a
    // published comment would read as missing if this were trusted.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        restResponse(
          {
            code: 'itsec_rest_api_access_restricted',
            message: 'Access to REST API requests is restricted',
          },
          401
        )
      )
      .mockResolvedValueOnce(
        htmlResponse(
          `<li class="comment" id="comment-587321"><div id="div-comment-587321" class="comment-body">
             <p>Ours <a href="https://product.example">P</a></p>
           </div></li>`
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        websiteUrl: PROMOTED,
        commentId: '587321',
      })
    ).resolves.toMatchObject({ visibility: 'visible', method: 'html' });
  });

  it('reports a public comment whose link was removed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        restResponse({
          id: 88,
          link: 'https://blog.example/article#comment-88',
          content: { rendered: '<p>Ours, link gone</p>' },
        })
      )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        websiteUrl: PROMOTED,
        commentId: '88',
      })
    ).resolves.toMatchObject({ visibility: 'link_stripped' });
  });

  it('keeps a neighbouring comment from standing in for ours', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(restResponse({ code: 'rest_no_route' }, 404))
        .mockResolvedValueOnce(
          htmlResponse(
            `<ol class="comment-list">
               <li id="comment-77"><p>Theirs <a href="https://product.example">P</a></p></li>
               <li id="comment-88"><p>Ours, no link</p></li>
             </ol>`
          )
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        websiteUrl: PROMOTED,
        commentId: '88',
      })
    ).resolves.toMatchObject({ visibility: 'link_stripped', method: 'html' });
  });

  it('reports a comment id the page does not contain as not visible', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(restResponse({ code: 'rest_no_route' }, 404))
        .mockResolvedValueOnce(
          htmlResponse(
            '<ol class="comment-list"><li id="comment-77">x</li></ol>'
          )
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        websiteUrl: PROMOTED,
        commentId: '88',
      })
    ).resolves.toMatchObject({ visibility: 'not_visible', method: 'html' });
  });

  it('ignores a promoted link outside the comments region when no id is known', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        htmlResponse(
          `<aside><a href="https://product.example">sponsor</a></aside>
           <div id="comments"><article>No comment of ours here</article></div>`
        )
      )
    );

    await expect(
      checkPublicComment({ pageUrl: PAGE, websiteUrl: PROMOTED })
    ).resolves.toMatchObject({ visibility: 'not_visible', method: 'html' });
  });

  it('finds the promoted link inside the comments region without an id', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          htmlResponse(
            `<div id="comments"><article>Ours <a href="http://www.product.example">P</a></article></div>`
          )
        )
    );

    await expect(
      checkPublicComment({ pageUrl: PAGE, websiteUrl: PROMOTED })
    ).resolves.toMatchObject({ visibility: 'visible', method: 'html' });
  });

  it('never turns an unreadable page into a verdict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network unreachable'))
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        websiteUrl: PROMOTED,
        commentId: '88',
      })
    ).resolves.toMatchObject({ visibility: 'inconclusive', method: 'none' });
  });

  it('cannot decide without a promoted URL to look for', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      checkPublicComment({ pageUrl: PAGE, websiteUrl: '' })
    ).resolves.toMatchObject({ visibility: 'inconclusive' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
