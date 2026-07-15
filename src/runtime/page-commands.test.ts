import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeTab,
  clickPreparedTabSubmission,
  prepareTabSubmission,
  submitCurrentPage,
  verifyTabSubmission,
} from './page-commands';

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
    await vi.advanceTimersByTimeAsync(10_000);
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
      status: 'published' as const,
      message: 'COMMENT_PUBLISHED',
      fingerprint: prepared.fingerprint,
    };
    const sendMessage = vi.fn().mockResolvedValue({
      type: 'submission',
      result,
    });
    const executeScript = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: { sendMessage },
      scripting: { executeScript },
    });

    await expect(clickPreparedTabSubmission(42, prepared)).resolves.toEqual(
      result
    );

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

  it('verifies a prepared submission after a WordPress moderation redirect', async () => {
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
      status: 'submitted_not_visible' as const,
      message: 'COMMENT_SUBMITTED_NOT_VISIBLE',
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
    ).resolves.toEqual(result);

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: ['content-scripts/page-command.js'],
    });
    expect(sendMessage).toHaveBeenCalledWith(42, {
      type: 'comment-link-assistant:page-command',
      command: {
        type: 'verify',
        fingerprint: prepared.fingerprint,
        baseline: prepared.baseline,
        expectedUrl: prepared.expected.url,
      },
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
            status: 'published',
            message: 'COMMENT_PUBLISHED',
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
          status: 'published',
          message: 'COMMENT_PUBLISHED',
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
    ).resolves.toMatchObject({ status: 'published' });

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
      status: 'unknown',
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
          status: 'submitted_not_visible',
          message: 'COMMENT_SUBMITTED_NOT_VISIBLE',
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
    ).resolves.toMatchObject({ status: 'submitted_not_visible' });
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[2]?.[1]).toMatchObject({
      command: {
        type: 'verify',
        expectedUrl: 'https://blog.example/article',
      },
    });
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
          status: 'unknown',
          message: 'COMMENT_SUBMISSION_UNCONFIRMED',
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
    await expect(first).resolves.toMatchObject({ status: 'unknown' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
