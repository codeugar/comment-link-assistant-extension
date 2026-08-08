import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPublicComment } from './public-comment';

const PAGE = 'https://blog.example/article';
const PROMOTED = 'https://product.example';
const LINK = { kind: 'link', websiteUrl: PROMOTED } as const;
const COMMENT_ONLY = { kind: 'comment_only' } as const;

function pageResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    url: PAGE,
    headers: new Headers(init.headers ?? {}),
    text: async () => body,
  } as unknown as Response;
}

function restResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    headers: new Headers(),
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

/** The REST root every WordPress page publishes about itself. */
const REST_ROOT_TAG =
  '<link rel="https://api.w.org/" href="https://blog.example/wp-json/" />';

const BODY_TEXT =
  'Really useful roundup, the section on pricing finally cleared things up for me.';

/**
 * The markup WordPress core's `Walker_Comment::html5_comment()` emits, which
 * every default theme since Twenty Twelve uses. The promoted link sits on the
 * author byline inside `<footer class="comment-meta">` — that is where the
 * default `prefer-website-field` link mode puts it.
 */
function coreComment(
  options: {
    id?: string;
    authorHref?: string | null;
    body?: string;
    children?: string;
  } = {}
): string {
  const id = options.id ?? '88';
  const author =
    options.authorHref === null
      ? '<b class="fn">Wes</b>'
      : `<b class="fn"><a href="${options.authorHref ?? PROMOTED}" class="url" rel="ugc external nofollow">Wes</a></b>`;
  return `
    <li id="comment-${id}" class="comment even thread-even depth-1">
      <article id="div-comment-${id}" class="comment-body">
        <footer class="comment-meta">
          <div class="comment-author vcard">${author}<span class="says">says:</span></div>
          <div class="comment-metadata">
            <a href="https://blog.example/article#comment-${id}"><time>2026-08-08</time></a>
          </div>
        </footer>
        <div class="comment-content"><p>${options.body ?? BODY_TEXT}</p></div>
        <div class="reply"><a class="comment-reply-link" href="/article?replytocom=${id}">Reply</a></div>
      </article>
      ${options.children ?? ''}
    </li>`;
}

function page(inner: string, extra = ''): string {
  return `<html><head>${REST_ROOT_TAG}</head><body>
    <article class="post-content"><p>The article itself.</p></article>
    <div id="comments" class="comments-area">
      <ol class="comment-list">${inner}</ol>
    </div>
    <div id="respond" class="comment-respond"><form id="commentform"></form></div>
    ${extra}
    <footer class="site-footer"><p>&copy; blog.example</p></footer>
  </body></html>`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// A — is the comment on the public page, with its content actually rendered?
// ---------------------------------------------------------------------------

describe('locating the comment', () => {
  it('finds the promoted link on the author byline of real WordPress markup', async () => {
    // Regression: a marker-based slicer cut this comment at its own
    // `<footer class="comment-meta">`, losing the byline and the body, and
    // reported a live backlink as a terminal `link_stripped` failure.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(pageResponse(page(coreComment())))
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'visible', method: 'html' });
  });

  it('keeps a theme id that merely starts with "comment-" from truncating the node', async () => {
    // Themes stamp ids like `comment-author-88` on elements *inside* a comment.
    // Only `comment-<digits>` and `div-comment-<digits>` delimit another
    // comment; a prefix match would delete the byline holding the link.
    const themed = `
      <li id="comment-88" class="comment">
        <article id="div-comment-88" class="comment-body">
          <div id="comment-author-88" class="comment-author">
            <a href="${PROMOTED}" class="url">Wes</a>
          </div>
          <div id="comment-content-88" class="comment-content"><p>${BODY_TEXT}</p></div>
        </article>
      </li>`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(pageResponse(page(themed)))
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'visible' });
  });

  it('will not settle a comment whose body never rendered into the HTML', async () => {
    // Some themes render the comment shell server-side and fill it in with
    // JavaScript. An empty shell proves nothing, so it must never become the
    // terminal `link_stripped`.
    const shell =
      '<li id="comment-88" class="comment"><article id="div-comment-88" class="comment-body"></article></li>';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(pageResponse(page(shell)))
        .mockResolvedValueOnce(restResponse({ code: 'rest_no_route' }, 404))
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'inconclusive' });
  });

  it('reports a rendered comment with no link of ours as link_stripped', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          pageResponse(page(coreComment({ authorHref: null })))
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'link_stripped', method: 'html' });
  });

  it('does not let the article body stand in for the comment link', async () => {
    // The target blog covers the same niche, so its own article may already
    // link to the promoted site. That link is not the one this run produced.
    const html = `<html><head>${REST_ROOT_TAG}</head><body>
      <article class="post-content">Reviewed <a href="${PROMOTED}">Product</a> last week.</article>
      <div id="comments"><ol class="comment-list">${coreComment({ authorHref: null })}</ol></div>
    </body></html>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(pageResponse(html)));

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'link_stripped' });
  });

  it('does not let a reply nested under our comment supply the link', async () => {
    const nested = coreComment({
      authorHref: null,
      children: `<ol class="children">${coreComment({ id: '91' })}</ol>`,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(pageResponse(page(nested)))
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'link_stripped' });
  });

  it('does not let a neighbouring comment supply the link', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          pageResponse(
            page(
              coreComment({ id: '77' }) +
                coreComment({ id: '88', authorHref: null })
            )
          )
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'link_stripped' });
  });
});

// ---------------------------------------------------------------------------
// No comment id: the fingerprint is the only handle, and without it there is
// no handle at all.
// ---------------------------------------------------------------------------

describe('without a server-assigned comment id', () => {
  it('locates our comment in the comments region by its fingerprint', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          pageResponse(
            page(
              coreComment({ id: '77', authorHref: null }) +
                coreComment({ id: '88' })
            )
          )
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'visible', method: 'html' });
  });

  it('matches a fingerprint through WordPress texturization', async () => {
    // `wptexturize` rewrites straight quotes and double hyphens on render, so
    // the stored fingerprint never matches the page byte for byte.
    const stored = `It's the pricing table -- that's what sold me on it.`;
    const rendered =
      'It&#8217;s the pricing table &#8212; that&#8217;s what sold me on it.';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(pageResponse(page(coreComment({ body: rendered }))))
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        fingerprint: stored,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'visible' });
  });

  it('never calls a fingerprint-only match a stripped link', async () => {
    // A server-assigned id says "this comment is yours". A text match only says
    // "this comment reads like yours", which a neighbour quoting you satisfies
    // too. Weak attribution may keep an item queued; it may never spend the
    // terminal `link_stripped`, so a text match with no link is passed over and
    // the search reports nothing found.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          pageResponse(
            page(
              coreComment({ id: '77', authorHref: null }) +
                coreComment({ id: '88', authorHref: null })
            )
          )
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'not_visible' });
  });

  it('ignores a promoted link that sits outside the comments region', async () => {
    // Regression: scanning from the comments marker to the end of the document
    // let a sidebar or footer link stand in for a comment that never appeared.
    const html = page(
      coreComment({ id: '77', authorHref: null }),
      `<aside class="widget"><a href="${PROMOTED}">Sponsor</a></aside>`
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(pageResponse(html))
        .mockResolvedValueOnce(restResponse({ code: 'rest_no_route' }, 404))
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'not_visible' });
  });

  it('never reaches a verdict with neither an id nor a fingerprint', async () => {
    // A manually added entry that carries only a page URL cannot say which
    // comment on that page is the user's, so it may never settle anything.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(pageResponse(page(coreComment())))
    );

    await expect(
      checkPublicComment({ pageUrl: PAGE, criterion: LINK })
    ).resolves.toMatchObject({ visibility: 'inconclusive' });
  });
});

// ---------------------------------------------------------------------------
// The success criterion travels with the task instead of being assumed.
// ---------------------------------------------------------------------------

describe('success criterion', () => {
  it('settles a comment-only submission on visibility alone', async () => {
    // Regression: the checker always looked for a promoted link, so every
    // comment posted in `comment-only` mode was recorded as a terminal
    // `link_stripped` failure by the re-check job.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          pageResponse(page(coreComment({ authorHref: null })))
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: COMMENT_ONLY,
      })
    ).resolves.toMatchObject({ visibility: 'visible' });
  });

  it('still reports a missing comment-only comment as not visible', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(pageResponse(page(coreComment({ id: '77' }))))
        .mockResolvedValueOnce(
          restResponse({ code: 'rest_comment_invalid_id' }, 404)
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: COMMENT_ONLY,
      })
    ).resolves.toMatchObject({ visibility: 'not_visible' });
  });
});

// ---------------------------------------------------------------------------
// The REST root is discovered from the page, never guessed from the origin.
// ---------------------------------------------------------------------------

describe('REST discovery', () => {
  it('reads the page first and does not call REST when the page decides', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(pageResponse(page(coreComment())));
    vi.stubGlobal('fetch', fetchMock);

    await checkPublicComment({
      pageUrl: PAGE,
      commentId: '88',
      fingerprint: BODY_TEXT,
      criterion: LINK,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses the REST root the page publishes, not the origin', async () => {
    // WordPress in a subdirectory: `origin + /wp-json/` answers from whatever
    // serves the root, which is a different install with different comment ids.
    const subdirectory = 'https://blog.example/blog/article';
    const html = `<html><head>
        <link rel="https://api.w.org/" href="https://blog.example/blog/wp-json/" />
      </head><body><div id="comments"><ol class="comment-list"></ol></div></body></html>`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse(html))
      .mockResolvedValueOnce(
        restResponse({
          id: 88,
          link: 'https://blog.example/blog/article#comment-88',
          author_url: PROMOTED,
          content: { rendered: `<p>${BODY_TEXT}</p>` },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      checkPublicComment({
        pageUrl: subdirectory,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'visible', method: 'wp_rest' });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://blog.example/blog/wp-json/wp/v2/comments/88'
    );
  });

  it('accepts the REST root from the Link response header', async () => {
    const html =
      '<html><head></head><body><div id="comments"><ol class="comment-list"></ol></div></body></html>';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        pageResponse(html, {
          headers: {
            Link: '<https://blog.example/wp-json/>; rel="https://api.w.org/"',
          },
        })
      )
      .mockResolvedValueOnce(
        restResponse({
          id: 88,
          link: `${PAGE}#comment-88`,
          author_url: PROMOTED,
          content: { rendered: `<p>${BODY_TEXT}</p>` },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'visible', method: 'wp_rest' });

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://blog.example/wp-json/wp/v2/comments/88'
    );
  });

  it('trusts a comment-route refusal once the root came from the page', async () => {
    const html = `<html><head>${REST_ROOT_TAG}</head><body>
      <div id="comments"><ol class="comment-list"></ol></div></body></html>`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(pageResponse(html))
        .mockResolvedValueOnce(
          restResponse({ code: 'rest_comment_invalid_id' }, 404)
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'not_visible', method: 'wp_rest' });
  });

  it('falls through when a security plugin walls off the whole REST API', async () => {
    // The plugin answers 401 for every id, published or not, so its refusal
    // decides nothing.
    const html = `<html><head>${REST_ROOT_TAG}</head><body>
      <section class="js-rendered-comments"></section></body></html>`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(pageResponse(html))
        .mockResolvedValueOnce(
          restResponse({ code: 'itsec_rest_api_access_restricted' }, 401)
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'inconclusive' });
  });

  it('never guesses a REST root when the page cannot be read', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error('network unreachable'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'inconclusive', method: 'none' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('takes the promoted link from the REST author byline as well as the body', async () => {
    const html = `<html><head>${REST_ROOT_TAG}</head><body>
      <section class="js-rendered-comments"></section></body></html>`;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(pageResponse(html))
        .mockResolvedValueOnce(
          restResponse({
            id: 88,
            link: `${PAGE}#comment-88`,
            author_url: 'https://product.example/',
            content: { rendered: '<p>Nice post, thanks for the roundup.</p>' },
          })
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'visible', method: 'wp_rest' });
  });
});

// ---------------------------------------------------------------------------
// How the read itself is performed.
// ---------------------------------------------------------------------------

describe('the anonymous read', () => {
  it('carries no session and bypasses the caches on both sides', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(pageResponse(page(coreComment())));
    vi.stubGlobal('fetch', fetchMock);

    await checkPublicComment({
      pageUrl: PAGE,
      commentId: '88',
      fingerprint: BODY_TEXT,
      criterion: LINK,
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store' });
    // A CDN in front of the site would otherwise answer from a copy rendered
    // before the comment existed; `cache: no-store` only governs our own cache.
    expect(new URL(String(url)).search).not.toBe('');
  });

  it('never reads a page through its moderation-hash preview URL', async () => {
    // WordPress serves a held comment to anyone holding that hash, cookie or
    // not, so that URL proves nothing about the public page.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(pageResponse(page(coreComment())));
    vi.stubGlobal('fetch', fetchMock);

    await checkPublicComment({
      pageUrl: `${PAGE}?unapproved=88&moderation-hash=abc`,
      commentId: '88',
      fingerprint: BODY_TEXT,
      criterion: LINK,
    });

    const requested = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(requested).toContain('blog.example');
    expect(requested).not.toContain('unapproved');
    expect(requested).not.toContain('moderation-hash');
  });

  it('matches a promoted link whose href carries a trailing newline', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          pageResponse(page(coreComment({ authorHref: `${PROMOTED}\n` })))
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'visible' });
  });

  it('matches the promoted site across http/https, www and trailing slash', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          pageResponse(
            page(coreComment({ authorHref: 'http://www.product.example/' }))
          )
        )
    );

    await expect(
      checkPublicComment({
        pageUrl: PAGE,
        commentId: '88',
        fingerprint: BODY_TEXT,
        criterion: LINK,
      })
    ).resolves.toMatchObject({ visibility: 'visible' });
  });
});
