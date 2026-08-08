import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeTab,
  clickPreparedTabSubmission,
  prepareTabSubmission,
  submitCurrentPage,
  verifyTabSubmission,
} from './page-commands';

/** Minimal stand-ins for the anonymous public read the runtime now performs. */
function htmlResponse(body: string, url = 'https://blog.example/article') {
  return {
    ok: true,
    status: 200,
    url,
    text: async () => body,
    json: async () => ({}),
  } as unknown as Response;
}

function restResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

describe('page command runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('analyzes the specified tab without depending on the active tab', async () => {
    const analysis = {
      page: {
        url: 'https://blog.example/article',
        title: 'Article',
        description: 'Description',
        excerpt: 'Excerpt',
        language: 'en',
        hasWebsiteField: true,
      },
      form: {
        readiness: 'ready' as const,
        editorLabel: 'Comment',
        submitLabel: 'Post comment',
        hasNameField: true,
        hasEmailField: true,
        hasWebsiteField: true,
        message: 'COMMENT_FORM_READY',
      },
    };
    const query = vi.fn().mockRejectedValue(new Error('no active tab'));
    const executeScript = vi.fn().mockResolvedValue([]);
    const sendMessage = vi.fn().mockResolvedValue({
      type: 'analysis',
      analysis,
    });
    vi.stubGlobal('chrome', {
      tabs: { query, sendMessage },
      scripting: { executeScript },
    });

    await expect(analyzeTab(42)).resolves.toEqual(analysis);

    expect(query).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(42, {
      type: 'comment-link-assistant:page-command',
      command: { type: 'analyze' },
    });
  });

  it('uses an existing listener without injecting again', async () => {
    const analysis = {
      page: {
        url: 'http://blog.example/article',
        title: 'Article',
        description: 'Description',
        excerpt: 'Excerpt',
        language: 'en',
        hasWebsiteField: false,
      },
      form: {
        readiness: 'ready' as const,
        editorLabel: 'Comment',
        submitLabel: 'Post comment',
        hasNameField: false,
        hasEmailField: false,
        hasWebsiteField: false,
        message: 'COMMENT_FORM_READY',
      },
    };
    const sendMessage = vi.fn().mockResolvedValue({
      type: 'analysis',
      analysis,
    });
    vi.stubGlobal('chrome', {
      tabs: { sendMessage },
      scripting: { executeScript: vi.fn(() => new Promise(() => {})) },
    });

    await expect(analyzeTab(42)).resolves.toEqual(analysis);

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('injects once when the page has no listener yet', async () => {
    const analysis = {
      page: {
        url: 'http://blog.example/article',
        title: 'Article',
        description: 'Description',
        excerpt: 'Excerpt',
        language: 'en',
        hasWebsiteField: false,
      },
      form: {
        readiness: 'not_found' as const,
        editorLabel: '',
        submitLabel: '',
        hasNameField: false,
        hasEmailField: false,
        hasWebsiteField: false,
        message: 'COMMENT_FORM_NOT_FOUND',
      },
    };
    const executeScript = vi.fn().mockResolvedValue([]);
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Could not establish connection. Receiving end does not exist.'
        )
      )
      .mockResolvedValueOnce({ type: 'analysis', analysis });
    vi.stubGlobal('chrome', {
      tabs: { sendMessage },
      scripting: { executeScript },
    });

    await expect(analyzeTab(42)).resolves.toEqual(analysis);

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('reports a failed navigation as an unreachable target, not a Chrome internal', async () => {
    const executeScript = vi
      .fn()
      .mockRejectedValue(new Error('Frame with ID 0 is showing error page.'));
    const sendMessage = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Could not establish connection. Receiving end does not exist.'
        )
      );
    vi.stubGlobal('chrome', {
      tabs: { sendMessage },
      scripting: { executeScript },
    });

    await expect(analyzeTab(42)).rejects.toThrow('TARGET_PAGE_UNREACHABLE');

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('prepares a submission in the specified tab', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      comment: 'A relevant comment',
      domToken: 'dom-token',
      baseline: { feedbackMessages: [], renderedComment: false },
      expected: {
        url: 'https://blog.example/article',
        editorLabel: 'Comment',
        submitLabel: 'Post comment',
        hasWebsiteField: true,
      },
    };
    const query = vi.fn().mockRejectedValue(new Error('no active tab'));
    const sendMessage = vi.fn().mockResolvedValue({
      type: 'preparation',
      preparation: { ok: true, prepared },
    });
    const executeScript = vi.fn().mockResolvedValue([]);
    vi.stubGlobal('chrome', {
      tabs: { query, sendMessage },
      scripting: { executeScript },
    });

    await expect(
      prepareTabSubmission(
        42,
        {
          comment: 'A relevant comment',
          websiteUrl: 'https://product.example',
        },
        prepared.expected
      )
    ).resolves.toEqual({ ok: true, prepared });

    expect(query).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(42, {
      type: 'comment-link-assistant:page-command',
      command: {
        type: 'submit.prepare',
        input: {
          comment: 'A relevant comment',
          websiteUrl: 'https://product.example',
        },
        expected: prepared.expected,
      },
    });
  });

  it('times out when the page command listener never responds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: vi.fn(() => new Promise(() => {})) },
      scripting: { executeScript: vi.fn().mockResolvedValue([]) },
    });

    const result = expect(
      prepareTabSubmission(
        42,
        {
          comment: 'A relevant comment',
          websiteUrl: 'https://product.example',
        },
        {
          url: 'https://blog.example/article',
          editorLabel: 'Comment',
          submitLabel: 'Post comment',
          hasWebsiteField: true,
        }
      )
    ).rejects.toThrow('PAGE_COMMAND_TIMEOUT');

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(120_000);
    await result;
  });

  it('clicks an already prepared submission without injecting again', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      comment: 'A relevant comment',
      domToken: 'dom-token',
      baseline: { feedbackMessages: [], renderedComment: false },
      expected: {
        url: 'https://blog.example/article',
        editorLabel: 'Comment',
        submitLabel: 'Post comment',
        hasWebsiteField: true,
      },
    };
    const result = {
      status: 'submitted' as const,
      message: 'COMMENT_SUBMITTED',
      fingerprint: prepared.fingerprint,
    };
    const sendMessage = vi.fn().mockResolvedValue({
      type: 'submission',
      result,
    });
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage,
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: 'https://blog.example/article',
          status: 'complete',
        }),
      },
      scripting: { executeScript },
    });

    await expect(
      clickPreparedTabSubmission(42, prepared)
    ).resolves.toMatchObject(result);

    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(42, {
      type: 'comment-link-assistant:page-command',
      command: { type: 'submit.click', prepared },
    });
  });

  it('reports a navigation-interrupted click without clicking again', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      comment: 'A relevant comment',
      domToken: 'dom-token',
      baseline: { feedbackMessages: [], renderedComment: false },
      expected: {
        url: 'https://blog.example/article',
        editorLabel: 'Comment',
        submitLabel: 'Post comment',
        hasWebsiteField: true,
      },
    };
    const sendMessage = vi
      .fn()
      .mockRejectedValue(new Error('The message port closed.'));
    vi.stubGlobal('chrome', {
      tabs: { sendMessage },
    });

    await expect(clickPreparedTabSubmission(42, prepared)).rejects.toThrow(
      'PAGE_SUBMISSION_NAVIGATION_IN_PROGRESS'
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to a WordPress moderation receipt when the DOM check is unavailable', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      comment: 'A relevant comment',
      domToken: 'dom-token',
      baseline: { feedbackMessages: [], renderedComment: false },
      expected: {
        url: 'https://blog.example/article',
        editorLabel: 'Comment',
        submitLabel: 'Post comment',
        hasWebsiteField: true,
      },
    };
    const sendMessage = vi.fn();
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: 'https://blog.example/article?unapproved=42&moderation-hash=abc#comment-42',
          status: 'complete',
        }),
        sendMessage,
      },
      scripting: { executeScript },
    });

    await expect(
      verifyTabSubmission(42, prepared, prepared.expected.url)
    ).resolves.toMatchObject({
      status: 'pending_moderation',
      message: 'COMMENT_PENDING_WORDPRESS_MODERATION',
      fingerprint: prepared.fingerprint,
      clickOccurred: true,
    });

    // The DOM URL check has priority; if it is unavailable, the deterministic
    // moderation receipt still preserves the pending state.
    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('publishes only when the anonymous read finds the promoted link', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      baseline: { feedbackMessages: [], renderedComment: false },
      websiteUrl: 'https://product.example',
    };
    const sendMessage = vi.fn().mockResolvedValue({
      type: 'submission',
      result: {
        status: 'unconfirmed',
        message: 'COMMENT_ACCEPTED_AWAITING_PUBLIC_CHECK',
        fingerprint: prepared.fingerprint,
        clickOccurred: true,
        acceptance: 'server_receipt',
      },
    });
    const publicFetch = vi.fn().mockResolvedValue(
      restResponse({
        id: 539871,
        link: 'https://blog.example/article#comment-539871',
        content: {
          rendered:
            '<p>Useful <a href="https://product.example">Product</a></p>',
        },
      })
    );
    vi.stubGlobal('fetch', publicFetch);
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: 'https://blog.example/article#comment-539871',
          status: 'complete',
        }),
        sendMessage,
      },
      scripting: { executeScript: vi.fn() },
    });

    await expect(
      verifyTabSubmission(42, prepared, 'https://blog.example/article')
    ).resolves.toMatchObject({
      status: 'published',
      message: 'COMMENT_PUBLISHED_PUBLIC_CHECK',
      receipt: { commentId: '539871' },
      publicCheck: { visibility: 'visible', method: 'wp_rest' },
    });

    // The comment id from the receipt addresses the check, and it runs without
    // the author's session.
    expect(publicFetch).toHaveBeenCalledWith(
      'https://blog.example/wp-json/wp/v2/comments/539871',
      expect.objectContaining({ credentials: 'omit', cache: 'no-store' })
    );
  });

  it('keeps a receipt-only comment pending when no visitor can see it', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      baseline: { feedbackMessages: [], renderedComment: false },
      websiteUrl: 'https://product.example',
    };
    const sendMessage = vi.fn().mockResolvedValue({
      type: 'submission',
      result: {
        status: 'unconfirmed',
        message: 'COMMENT_ACCEPTED_AWAITING_PUBLIC_CHECK',
        fingerprint: prepared.fingerprint,
        clickOccurred: true,
        acceptance: 'server_receipt',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          restResponse({ code: 'rest_comment_invalid_id' }, 404)
        )
    );
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: 'https://blog.example/article#comment-539871',
          status: 'complete',
        }),
        sendMessage,
      },
      scripting: { executeScript: vi.fn() },
    });

    await expect(
      verifyTabSubmission(42, prepared, 'https://blog.example/article')
    ).resolves.toMatchObject({
      status: 'pending_moderation',
      message: 'COMMENT_ACCEPTED_NOT_PUBLIC_YET',
      publicCheck: { visibility: 'not_visible' },
    });
  });

  it('settles a public comment whose link the site stripped', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      baseline: { feedbackMessages: [], renderedComment: false },
      websiteUrl: 'https://product.example',
    };
    const sendMessage = vi.fn().mockResolvedValue({
      type: 'submission',
      result: {
        status: 'unconfirmed',
        message: 'COMMENT_ACCEPTED_AWAITING_PUBLIC_CHECK',
        fingerprint: prepared.fingerprint,
        clickOccurred: true,
        acceptance: 'server_receipt',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        restResponse({
          id: 539871,
          link: 'https://blog.example/article#comment-539871',
          content: { rendered: '<p>Useful, and no link at all</p>' },
        })
      )
    );
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: 'https://blog.example/article#comment-539871',
          status: 'complete',
        }),
        sendMessage,
      },
      scripting: { executeScript: vi.fn() },
    });

    // Terminal, not pending: re-checking cannot bring the link back.
    await expect(
      verifyTabSubmission(42, prepared, 'https://blog.example/article')
    ).resolves.toMatchObject({
      status: 'link_stripped',
      message: 'COMMENT_PUBLIC_LINK_STRIPPED',
      receipt: { commentId: '539871' },
      publicCheck: { visibility: 'link_stripped' },
    });
  });

  it('does not publish a comment only the submitting session can see', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      baseline: { feedbackMessages: [], renderedComment: false },
      websiteUrl: 'https://product.example',
    };
    const sendMessage = vi.fn().mockResolvedValue({
      type: 'submission',
      result: {
        status: 'unconfirmed',
        message: 'COMMENT_ACCEPTED_AWAITING_PUBLIC_CHECK',
        fingerprint: prepared.fingerprint,
        clickOccurred: true,
        acceptance: 'rendered_locally',
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          htmlResponse('<div id="comments">no comment of ours here</div>')
        )
    );
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: 'https://blog.example/article',
          status: 'complete',
        }),
        sendMessage,
      },
      scripting: { executeScript: vi.fn() },
    });

    await expect(
      verifyTabSubmission(42, prepared, 'https://blog.example/article')
    ).resolves.toMatchObject({
      status: 'pending_moderation',
      message: 'COMMENT_ACCEPTED_NOT_PUBLIC_YET',
    });
  });

  it('verifies a paginated anchor in-page using the promoted URL', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      baseline: { feedbackMessages: [], renderedComment: false },
      websiteUrl: 'https://product.example',
    };
    const sendMessage = vi.fn().mockResolvedValue({
      type: 'submission',
      result: {
        status: 'published',
        message: 'COMMENT_PUBLISHED_RENDERED_TARGET_URL',
        fingerprint: prepared.fingerprint,
        clickOccurred: true,
      },
    });
    const executeScript = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        restResponse({
          id: 99,
          link: 'https://blog.example/article/comment-page-2/#comment-99',
          content: {
            rendered:
              '<p>Nice <a href="https://product.example">Product</a></p>',
          },
        })
      )
    );
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: 'https://blog.example/article/comment-page-2/#comment-99',
          status: 'complete',
        }),
        sendMessage,
      },
      scripting: { executeScript },
    });

    await expect(
      verifyTabSubmission(42, prepared, 'https://blog.example/article/')
    ).resolves.toMatchObject({
      status: 'published',
      clickOccurred: true,
    });

    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        command: expect.objectContaining({
          type: 'verify',
          targetWebsiteUrl: 'https://product.example',
        }),
      })
    );
  });

  it('verifies in-page on a paginated-comments path without a receipt', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      baseline: { feedbackMessages: [], renderedComment: false },
    };
    const result = {
      status: 'submitted' as const,
      message: 'COMMENT_SUBMITTED',
      fingerprint: prepared.fingerprint,
    };
    const sendMessage = vi.fn().mockResolvedValue({
      type: 'submission',
      result,
    });
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: 'https://blog.example/article/comment-page-2/',
          status: 'complete',
        }),
        sendMessage,
      },
      scripting: { executeScript: vi.fn() },
    });

    await expect(
      verifyTabSubmission(42, prepared, 'https://blog.example/article')
    ).resolves.toMatchObject(result);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('injects immediately when verification needs the content script', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      baseline: { feedbackMessages: [], renderedComment: false },
    };
    const result = {
      status: 'submitted' as const,
      message: 'COMMENT_SUBMITTED',
      fingerprint: prepared.fingerprint,
    };
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'Could not establish connection. Receiving end does not exist.'
        )
      )
      .mockResolvedValueOnce({
        type: 'submission',
        result,
      });
    const executeScript = vi.fn().mockResolvedValue([]);
    const onUpdated = {
      addListener: vi.fn(
        (listener: (tabId: number, changeInfo: { status?: string }) => void) =>
          listener(42, { status: 'complete' })
      ),
      removeListener: vi.fn(),
    };
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: 'https://blog.example/article',
          status: 'loading',
        }),
        sendMessage,
        onUpdated,
      },
      scripting: { executeScript },
    });

    await expect(
      verifyTabSubmission(42, prepared, 'https://blog.example/article')
    ).resolves.toMatchObject(result);

    // A slow page must not delay re-injection until document_idle.
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: ['content-scripts/page-command.js'],
      injectImmediately: true,
    });
  });

  it('rejects verification after the tab navigates to another article', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      baseline: { feedbackMessages: [], renderedComment: false },
    };
    const executeScript = vi.fn().mockResolvedValue([]);
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: 'https://blog.example/another-article',
          status: 'complete',
        }),
        sendMessage: vi.fn().mockResolvedValue({
          type: 'submission',
          result: {
            status: 'submitted',
            message: 'COMMENT_SUBMITTED',
            fingerprint: prepared.fingerprint,
          },
        }),
      },
      scripting: { executeScript },
    });

    await expect(
      verifyTabSubmission(42, prepared, 'https://blog.example/article')
    ).rejects.toThrow('PAGE_CHANGED_SINCE_SUBMISSION');
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('re-verifies after a same-URL reload closes the click message port', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      comment: 'A relevant comment',
      domToken: 'dom-token',
      baseline: { feedbackMessages: [], renderedComment: false },
      expected: {
        url: 'https://blog.example/article',
        editorLabel: 'comment',
        submitLabel: 'Post comment',
        hasWebsiteField: true,
      },
    };
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        type: 'preparation',
        preparation: { ok: true, prepared },
      })
      .mockRejectedValueOnce(new Error('The message port closed.'))
      .mockResolvedValueOnce({
        type: 'submission',
        result: {
          status: 'submitted',
          message: 'COMMENT_SUBMITTED',
          fingerprint: prepared.fingerprint,
        },
      });
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([
          {
            id: 7,
            url: 'https://blog.example/article',
            status: 'complete',
          },
        ]),
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: 'https://blog.example/article',
          status: 'complete',
        }),
        sendMessage,
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([]),
      },
    });

    await expect(
      submitCurrentPage(
        {
          comment: 'A relevant comment',
          websiteUrl: 'https://product.example',
        },
        {
          tabId: 7,
          url: 'https://blog.example/article',
          editorLabel: 'comment',
          submitLabel: 'Post comment',
          hasWebsiteField: true,
          fillWebsiteField: true,
        }
      )
    ).resolves.toMatchObject({ status: 'submitted' });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[2]?.[1]).toMatchObject({
      command: {
        type: 'verify',
        baseline: prepared.baseline,
        expectedUrl: 'https://blog.example/article',
      },
    });
  });

  it('does not verify success after navigation to another URL', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      comment: 'A relevant comment',
      domToken: 'dom-token',
      baseline: { feedbackMessages: [], renderedComment: false },
      expected: {
        url: 'https://blog.example/article',
        editorLabel: 'comment',
        submitLabel: 'Post comment',
        hasWebsiteField: true,
      },
    };
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        type: 'preparation',
        preparation: { ok: true, prepared },
      })
      .mockRejectedValueOnce(new Error('The message port closed.'));
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([
          {
            id: 7,
            url: 'https://blog.example/article',
            status: 'complete',
          },
        ]),
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: 'https://unrelated.example/success',
          status: 'complete',
        }),
        sendMessage,
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([]),
      },
    });

    await expect(
      submitCurrentPage(
        {
          comment: 'A relevant comment',
          websiteUrl: 'https://product.example',
        },
        {
          tabId: 7,
          url: 'https://blog.example/article',
          editorLabel: 'comment',
          submitLabel: 'Post comment',
          hasWebsiteField: true,
          fillWebsiteField: true,
        }
      )
    ).resolves.toMatchObject({
      status: 'unconfirmed',
      message: 'COMMENT_SUBMISSION_UNCONFIRMED',
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('re-verifies a WordPress moderation return URL', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      comment: 'A relevant comment',
      domToken: 'dom-token',
      baseline: { feedbackMessages: [], renderedComment: false },
      expected: {
        url: 'https://blog.example/article',
        editorLabel: 'comment',
        submitLabel: 'Post comment',
        hasWebsiteField: true,
      },
    };
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        type: 'preparation',
        preparation: { ok: true, prepared },
      })
      .mockRejectedValueOnce(new Error('The message port closed.'))
      .mockResolvedValueOnce({
        type: 'submission',
        result: {
          status: 'submitted',
          message: 'COMMENT_SUBMITTED',
          fingerprint: prepared.fingerprint,
        },
      });
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([
          {
            id: 7,
            url: 'https://blog.example/article',
            status: 'complete',
          },
        ]),
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: 'https://blog.example/article?unapproved=42&moderation-hash=abc#comment-42',
          status: 'complete',
        }),
        sendMessage,
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([]),
      },
    });

    await expect(
      submitCurrentPage(
        {
          comment: 'A relevant comment',
          websiteUrl: 'https://product.example',
        },
        {
          tabId: 7,
          url: 'https://blog.example/article',
          editorLabel: 'comment',
          submitLabel: 'Post comment',
          hasWebsiteField: true,
          fillWebsiteField: true,
        }
      )
    ).resolves.toMatchObject({ status: 'pending_moderation' });
    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it('keeps a bounded timeout for a read-only analyze command', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: vi.fn(() => new Promise(() => {})) },
      scripting: { executeScript: vi.fn().mockResolvedValue([]) },
    });

    const pending = analyzeTab(42);
    const outcome = vi.fn();
    void pending.then(
      () => outcome('resolved'),
      () => outcome('rejected')
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).not.toHaveBeenCalled();

    // Analyze still has a hard 30s bound so it can never hang forever.
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toHaveBeenCalledWith('rejected');
    await expect(pending).rejects.toThrow('PAGE_COMMAND_TIMEOUT');
  });

  it('gives a submit click 2 minutes for slow ad-heavy pages', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      comment: 'A relevant comment',
      domToken: 'dom-token',
      baseline: { feedbackMessages: [], renderedComment: false },
      expected: {
        url: 'https://blog.example/article',
        editorLabel: 'Comment',
        submitLabel: 'Post comment',
        hasWebsiteField: true,
      },
    };
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: vi.fn(() => new Promise(() => {})) },
    });

    const pending = clickPreparedTabSubmission(42, prepared);
    const rejection = expect(pending).rejects.toThrow(
      'PAGE_SUBMISSION_NAVIGATION_IN_PROGRESS'
    );
    await vi.advanceTimersByTimeAsync(119_999);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
  });

  it('allows only one submission flow per tab at a time', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      comment: 'A relevant comment',
      domToken: 'dom-token',
      baseline: { feedbackMessages: [], renderedComment: false },
      expected: {
        url: 'https://blog.example/article',
        editorLabel: 'comment',
        submitLabel: 'Post comment',
        hasWebsiteField: true,
      },
    };
    let resolvePreparation: ((value: unknown) => void) | undefined;
    const preparation = new Promise((resolve) => {
      resolvePreparation = resolve;
    });
    const sendMessage = vi
      .fn()
      .mockImplementationOnce(() => preparation)
      .mockResolvedValueOnce({
        type: 'submission',
        result: {
          status: 'submitted',
          message: 'COMMENT_SUBMITTED',
          fingerprint: prepared.fingerprint,
        },
      });
    vi.stubGlobal('chrome', {
      tabs: {
        query: vi.fn().mockResolvedValue([
          {
            id: 7,
            url: 'https://blog.example/article',
            status: 'complete',
          },
        ]),
        get: vi.fn().mockResolvedValue({
          id: 7,
          url: 'https://blog.example/article',
          status: 'complete',
        }),
        sendMessage,
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([]),
      },
    });
    const target = {
      tabId: 7,
      url: 'https://blog.example/article',
      editorLabel: 'comment',
      submitLabel: 'Post comment',
      hasWebsiteField: true,
      fillWebsiteField: true,
    };
    const input = {
      comment: 'A relevant comment',
      websiteUrl: 'https://product.example',
    };

    const first = submitCurrentPage(input, target);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    await expect(submitCurrentPage(input, target)).rejects.toThrow(
      'SUBMISSION_ALREADY_IN_PROGRESS'
    );
    resolvePreparation?.({
      type: 'preparation',
      preparation: { ok: true, prepared },
    });
    await expect(first).resolves.toMatchObject({ status: 'submitted' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe('jetpack remote-comment frame routing', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const frameHint = {
    kind: 'jetpack' as const,
    url: 'https://jetpack.wordpress.com/jetpack-comment/?blogid=1&postid=2',
  };
  // The frame's committed URL carries more params (sig, etc.) than the top page's
  // data-lazy-src hint; routing must target the committed URL, not the hint.
  const committedFrameUrl =
    'https://jetpack.wordpress.com/jetpack-comment/?blogid=1&postid=2&sig=abc';

  it('merges an in-frame analysis for a Jetpack remote-comment frame', async () => {
    const topAnalysis = {
      page: {
        url: 'https://blog.example/article',
        title: 'Article',
        description: 'Description',
        excerpt: 'Excerpt',
        language: 'en',
        hasWebsiteField: false,
      },
      form: {
        readiness: 'ready' as const,
        editorLabel: '',
        submitLabel: '',
        hasNameField: false,
        hasEmailField: false,
        hasWebsiteField: false,
        message: 'JETPACK_COMMENT_FRAME',
        frame: frameHint,
      },
    };
    const frameAnalysis = {
      page: {
        url: committedFrameUrl,
        title: '',
        description: '',
        excerpt: '',
        language: 'en',
        hasWebsiteField: true,
      },
      form: {
        readiness: 'ready' as const,
        editorLabel: 'comment comment',
        submitLabel: 'Post Comment',
        hasNameField: true,
        hasEmailField: true,
        hasWebsiteField: true,
        requiresWebsiteField: false,
        message: 'COMMENT_FORM_READY',
      },
    };
    const sendMessage = vi.fn((_tabId, _message, options) =>
      Promise.resolve({
        type: 'analysis',
        analysis: options?.frameId === 7 ? frameAnalysis : topAnalysis,
      })
    );
    const getAllFrames = vi.fn().mockResolvedValue([
      { frameId: 0, url: 'https://blog.example/article' },
      { frameId: 7, url: committedFrameUrl },
    ]);
    vi.stubGlobal('chrome', {
      tabs: { sendMessage },
      scripting: { executeScript: vi.fn().mockResolvedValue([]) },
      webNavigation: { getAllFrames },
    });

    const result = await analyzeTab(42);

    expect(result.page).toEqual(topAnalysis.page);
    expect(result.form).toMatchObject({
      readiness: 'ready',
      hasWebsiteField: true,
      submitLabel: 'Post Comment',
      frame: { kind: 'jetpack', url: committedFrameUrl },
    });
    expect(getAllFrames).toHaveBeenCalledWith({ tabId: 42 });
    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ command: { type: 'analyze' } }),
      { frameId: 7 }
    );
  });

  it('reports the frame unsupported when it cannot be resolved', async () => {
    const topAnalysis = {
      page: {
        url: 'https://blog.example/article',
        title: 'Article',
        description: 'Description',
        excerpt: 'Excerpt',
        language: 'en',
        hasWebsiteField: false,
      },
      form: {
        readiness: 'ready' as const,
        editorLabel: '',
        submitLabel: '',
        hasNameField: false,
        hasEmailField: false,
        hasWebsiteField: false,
        message: 'JETPACK_COMMENT_FRAME',
        frame: frameHint,
      },
    };
    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage: vi
          .fn()
          .mockResolvedValue({ type: 'analysis', analysis: topAnalysis }),
      },
      scripting: { executeScript: vi.fn().mockResolvedValue([]) },
      // Only the blog frame is present — the jetpack frame never committed.
      webNavigation: {
        getAllFrames: vi
          .fn()
          .mockResolvedValue([
            { frameId: 0, url: 'https://blog.example/article' },
          ]),
      },
    });

    // Resolution polls webNavigation for the promoted frame up to an 8s budget;
    // drive that clock so the never-committed frame falls back to unsupported.
    vi.useFakeTimers();
    const pending = analyzeTab(42);
    await vi.advanceTimersByTimeAsync(9_000);
    const result = await pending;

    expect(result.form).toMatchObject({
      readiness: 'not_found',
      message: 'CROSS_ORIGIN_COMMENT_FRAME_UNSUPPORTED',
    });
    expect(result.form.frame).toBeUndefined();
  });

  it('prepares a Jetpack submission inside the frame and restores the blog url', async () => {
    const target = {
      url: 'https://blog.example/article',
      editorLabel: 'comment comment',
      submitLabel: 'Post Comment',
      hasWebsiteField: true,
    };
    const framePrepared = {
      fingerprint: 'A relevant comment',
      comment: 'A relevant comment',
      domToken: 'tok',
      baseline: { feedbackMessages: [], renderedComment: false },
      expected: { ...target, url: committedFrameUrl },
    };
    const sendMessage = vi.fn().mockResolvedValue({
      type: 'preparation',
      preparation: { ok: true, prepared: framePrepared },
    });
    const getAllFrames = vi
      .fn()
      .mockResolvedValue([{ frameId: 7, url: committedFrameUrl }]);
    vi.stubGlobal('chrome', {
      tabs: { sendMessage },
      scripting: { executeScript: vi.fn().mockResolvedValue([]) },
      webNavigation: { getAllFrames },
    });

    const result = await prepareTabSubmission(
      42,
      { comment: 'A relevant comment', websiteUrl: 'https://product.example' },
      target,
      frameHint
    );

    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        command: expect.objectContaining({
          type: 'submit.prepare',
          expected: expect.objectContaining({ url: committedFrameUrl }),
        }),
      }),
      { frameId: 7 }
    );
    expect(result).toMatchObject({
      ok: true,
      prepared: { expected: { url: 'https://blog.example/article' } },
    });
  });

  it('clicks a prepared Jetpack submission inside the frame', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      comment: 'A relevant comment',
      domToken: 'tok',
      baseline: { feedbackMessages: [], renderedComment: false },
      expected: {
        url: 'https://blog.example/article',
        editorLabel: 'comment comment',
        submitLabel: 'Post Comment',
        hasWebsiteField: true,
      },
    };
    const result = {
      status: 'submitted' as const,
      message: 'COMMENT_SUBMITTED',
      fingerprint: prepared.fingerprint,
    };
    const sendMessage = vi
      .fn()
      .mockResolvedValue({ type: 'submission', result });
    const getAllFrames = vi
      .fn()
      .mockResolvedValue([{ frameId: 7, url: committedFrameUrl }]);
    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage,
        get: vi.fn().mockResolvedValue({
          id: 42,
          url: 'https://blog.example/article',
          status: 'complete',
        }),
      },
      webNavigation: { getAllFrames },
    });

    await expect(
      clickPreparedTabSubmission(42, prepared, frameHint)
    ).resolves.toMatchObject(result);

    expect(sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        command: expect.objectContaining({
          type: 'submit.click',
          prepared: expect.objectContaining({
            expected: expect.objectContaining({ url: committedFrameUrl }),
          }),
        }),
      }),
      { frameId: 7 }
    );
  });

  it('maps a closed frame port to a navigation-in-progress for a Jetpack click', async () => {
    const prepared = {
      fingerprint: 'A relevant comment',
      comment: 'A relevant comment',
      domToken: 'tok',
      baseline: { feedbackMessages: [], renderedComment: false },
      expected: {
        url: 'https://blog.example/article',
        editorLabel: 'c',
        submitLabel: 'Post Comment',
        hasWebsiteField: true,
      },
    };
    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage: vi
          .fn()
          .mockRejectedValue(new Error('The message port closed.')),
      },
      webNavigation: {
        getAllFrames: vi
          .fn()
          .mockResolvedValue([{ frameId: 7, url: committedFrameUrl }]),
      },
    });

    await expect(
      clickPreparedTabSubmission(42, prepared, frameHint)
    ).rejects.toThrow('PAGE_SUBMISSION_NAVIGATION_IN_PROGRESS');
  });
});
