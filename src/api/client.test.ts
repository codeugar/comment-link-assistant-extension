import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateComment } from './client';

const input = {
  provider: 'deepseek' as const,
  websiteProfile: {
    url: 'https://product.example',
    title: 'Product',
    description: 'Description',
  },
  targetPage: {
    url: 'https://blog.example/post',
    title: 'Post',
    description: 'Description',
    excerpt: 'Excerpt',
    language: 'en',
    hasWebsiteField: true,
  },
  linkMode: 'a-tag-newline' as const,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stubComment(comment: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ comment }) } }],
          }),
          { status: 200 }
        )
    )
  );
}

describe('direct comment generation', () => {
  it('calls DeepSeek directly with the selected provider key', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _request?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"comment":"  A useful comment.  "}' } },
            ],
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateComment({ deepseekApiKey: 'deepseek-key', kieApiKey: '' }, input)
    ).resolves.toMatchObject({
      comment:
        'A useful comment. <a href="https://product.example\n">Product</a>',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(request?.headers).toMatchObject({
      Authorization: 'Bearer deepseek-key',
      'Content-Type': 'application/json',
    });
    const requestBody = JSON.parse(String(request?.body));
    expect(requestBody).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: false,
      response_format: { type: 'json_object' },
    });
    expect(requestBody.messages[0].content).toContain('{LINK}');
    expect(requestBody.messages[0].content).not.toContain('<a href=');
  });

  it('calls the KIE Gemini Flash endpoint directly', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _request?: RequestInit) =>
        new Response(
          [
            'data: {"candidates":[{"content":{"parts":[{"text":"{\\"comment\\":\\"A useful"}]}}]}',
            'data: {"candidates":[{"content":{"parts":[{"text":" comment.\\"}"}]}}]}',
          ].join('\n\n'),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateComment(
      { deepseekApiKey: '', kieApiKey: 'kie-key' },
      { ...input, provider: 'kie-gemini' }
    );

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://api.kie.ai/gemini/v1/models/gemini-3-5-flash:streamGenerateContent'
    );
    expect(request?.headers).toMatchObject({
      Authorization: 'Bearer kie-key',
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      stream: true,
      contents: [{ role: 'user', parts: [{ text: expect.any(String) }] }],
    });
  });

  it('allows KIE generation to finish after the observed 67 second latency', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(
                new Response(
                  JSON.stringify({
                    candidates: [
                      {
                        content: {
                          parts: [{ text: '{"comment":"A useful comment."}' }],
                        },
                      },
                    ],
                  }),
                  { status: 200 }
                )
              );
            }, 67_000);
          })
      )
    );

    const request = generateComment(
      { deepseekApiKey: '', kieApiKey: 'kie-key' },
      { ...input, provider: 'kie-gemini' }
    );
    await vi.advanceTimersByTimeAsync(67_000);

    await expect(request).resolves.toMatchObject({
      comment:
        'A useful comment. <a href="https://product.example\n">Product</a>',
    });
  });

  it('retries a request that times out on its first attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<(url: string, request?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(
        (_url, request) =>
          new Promise<Response>((_resolve, reject) => {
            request?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"comment":"A useful comment."}' } },
            ],
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    const request = generateComment(
      { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
      input
    );

    await vi.advanceTimersByTimeAsync(30_000); // per-attempt budget expires, aborting attempt 1
    await vi.advanceTimersByTimeAsync(250); // retry backoff before attempt 2

    await expect(request).resolves.toMatchObject({
      comment:
        'A useful comment. <a href="https://product.example\n">Product</a>',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws COMMENT_GENERATION_TIMEOUT only once every attempt has timed out', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_url: string, request?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          request?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const request = generateComment(
      { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
      input
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(30_000); // attempt 1 times out
    await vi.advanceTimersByTimeAsync(250); // backoff before attempt 2
    await vi.advanceTimersByTimeAsync(30_000); // attempt 2 times out
    await vi.advanceTimersByTimeAsync(500); // backoff before attempt 3
    await vi.advanceTimersByTimeAsync(30_000); // attempt 3 times out

    const error = await request;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('COMMENT_GENERATION_TIMEOUT');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not let an earlier attempt's expired timer abort a later attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<(url: string, request?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockImplementationOnce(
        (_url, request) =>
          new Promise<Response>((resolve, reject) => {
            request?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
            // Resolves after attempt 1's original 30s deadline has passed but
            // well within attempt 2's own fresh 30s budget.
            setTimeout(() => {
              resolve(
                new Response(
                  JSON.stringify({
                    choices: [
                      {
                        message: { content: '{"comment":"A useful comment."}' },
                      },
                    ],
                  }),
                  { status: 200 }
                )
              );
            }, 29_800);
          })
      );
    vi.stubGlobal('fetch', fetchMock);

    const request = generateComment(
      { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
      input
    );

    // 250ms backoff + 29_800ms = 30_050ms, past attempt 1's original 30_000ms
    // deadline measured from call start, but before attempt 2's own deadline.
    await vi.advanceTimersByTimeAsync(30_100);

    await expect(request).resolves.toMatchObject({
      comment:
        'A useful comment. <a href="https://product.example\n">Product</a>',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires the key for the selected provider', async () => {
    await expect(
      generateComment({ deepseekApiKey: '', kieApiKey: 'kie-key' }, input)
    ).rejects.toThrow('DEEPSEEK_API_KEY_REQUIRED');
  });

  it('keeps the promoted HTML anchor in a-tag-newline mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '{"comment":"Useful point. See https://product.example"}',
                  },
                },
              ],
            }),
            { status: 200 }
          )
      )
    );

    await expect(
      generateComment({ deepseekApiKey: 'deepseek-key', kieApiKey: '' }, input)
    ).resolves.toMatchObject({
      comment:
        'Useful point. See <a href="https://product.example\n">Product</a>',
    });
  });

  it('requires exactly the promoted URL for inline-link mode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '{"comment":"Useful point. See https://other.example"}',
                  },
                },
              ],
            }),
            { status: 200 }
          )
      )
    );

    await expect(
      generateComment(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { ...input, linkMode: 'inline' }
      )
    ).rejects.toThrow('COMMENT_RELEVANT_URL_REQUIRED');
  });

  it('adds the promoted HTML anchor when an inline comment omits every link', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"comment":"A specific, useful observation."}',
                },
              },
            ],
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateComment(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { ...input, linkMode: 'inline' }
      )
    ).resolves.toMatchObject({
      comment:
        'A specific, useful observation. <a href="https://product.example\n">Product</a>',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('materializes one generated link placeholder into a standard HTML anchor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      comment:
                        'The resting tip is useful; {LINK} explains the related workflow clearly.',
                    }),
                  },
                },
              ],
            }),
            { status: 200 }
          )
      )
    );

    await expect(
      generateComment(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { ...input, linkMode: 'inline' }
      )
    ).resolves.toMatchObject({
      comment:
        'The resting tip is useful; <a href="https://product.example\n">Product</a> explains the related workflow clearly.',
    });
  });

  it('keeps only the intended href line break, not one between the tag name and attribute', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      comment: 'A useful point with {LINK} in the body.',
                    }),
                  },
                },
              ],
            }),
            { status: 200 }
          )
      )
    );

    const result = await generateComment(
      { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
      { ...input, linkMode: 'inline' }
    );
    expect(result.comment).toContain(
      '<a href="https://product.example\n">Product</a>'
    );
    expect(result.comment).not.toContain('<a\nhref=');
  });

  it('normalizes a legacy provider anchor through the deterministic placeholder path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      comment:
                        'See <a href="https://product.example">Explore Product</a> for details.',
                    }),
                  },
                },
              ],
            }),
            { status: 200 }
          )
      )
    );

    await expect(
      generateComment(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { ...input, linkMode: 'inline' }
      )
    ).resolves.toMatchObject({
      comment:
        'See <a href="https://product.example\n">Product</a> for details.',
    });
  });

  it('retries a transient provider failure with a capped backoff', async () => {
    const fetchMock = vi
      .fn<(url: string, request?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: '{"comment":"A useful comment."}' } },
            ],
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateComment({ deepseekApiKey: 'deepseek-key', kieApiKey: '' }, input)
    ).resolves.toMatchObject({
      comment:
        'A useful comment. <a href="https://product.example\n">Product</a>',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('allows ordinary prose containing a colon', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: '{"comment":"One detail stood out: the example."}',
                  },
                },
              ],
            }),
            { status: 200 }
          )
      )
    );

    await expect(
      generateComment({ deepseekApiKey: 'deepseek-key', kieApiKey: '' }, input)
    ).resolves.toMatchObject({
      comment:
        'One detail stood out: the example. <a href="https://product.example\n">Product</a>',
    });
  });

  it('renders a caller-supplied anchor text instead of the site title', async () => {
    stubComment('The pacing note is fair; {LINK} covers the same ground.');

    await expect(
      generateComment(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { ...input, anchorText: 'AI video generator' }
      )
    ).resolves.toMatchObject({
      comment:
        'The pacing note is fair; <a href="https://product.example\n">AI video generator</a> covers the same ground.',
      anchorText: 'AI video generator',
    });
  });

  it('tells the model what the token will read as without letting it author the link', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _request?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ comment: 'A point about {LINK}.' }),
                },
              },
            ],
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateComment(
      { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
      { ...input, anchorText: 'learn more' }
    );

    const system = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
      .messages[0].content;
    expect(system).toContain('"learn more"');
    expect(system).toContain('{"comment":"..."}');
    expect(system).not.toContain('anchorText');
  });

  it('uses the anchor wording the model chose for the natural slot', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _request?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    comment: 'That matches {LINK} almost exactly.',
                    anchorText: 'a rundown I read recently',
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateComment(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { ...input, requestAnchorText: true, anchorText: 'this write-up' }
      )
    ).resolves.toMatchObject({
      comment:
        'That matches <a href="https://product.example\n">a rundown I read recently</a> almost exactly.',
      anchorText: 'a rundown I read recently',
    });

    const system = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
      .messages[0].content;
    expect(system).toContain('"anchorText"');
  });

  it.each([
    ['a URL', 'see https://spam.example'],
    ['markup', '<b>this tool</b>'],
    ['an overlong phrase', 'x'.repeat(61)],
    ['nothing at all', '   '],
  ])(
    'falls back to the caller wording when the model answers with %s',
    async (_label, anchorText) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        comment: 'That matches {LINK} almost exactly.',
                        anchorText,
                      }),
                    },
                  },
                ],
              }),
              { status: 200 }
            )
        )
      );

      await expect(
        generateComment(
          { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
          { ...input, requestAnchorText: true, anchorText: 'this write-up' }
        )
      ).resolves.toMatchObject({
        comment:
          'That matches <a href="https://product.example\n">this write-up</a> almost exactly.',
        anchorText: 'this write-up',
      });
    }
  );

  it('ignores a model anchor suggestion that was never asked for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      comment: 'A point about {LINK}.',
                      anchorText: 'best AI tool ever',
                    }),
                  },
                },
              ],
            }),
            { status: 200 }
          )
      )
    );

    await expect(
      generateComment(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { ...input, anchorText: 'Example' }
      )
    ).resolves.toMatchObject({
      comment: 'A point about <a href="https://product.example\n">Example</a>.',
      anchorText: 'Example',
    });
  });

  it('renders a bare URL as the anchor text', async () => {
    stubComment('Worth a look for the same workflow: {LINK}');

    await expect(
      generateComment(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { ...input, anchorText: 'https://product.example' }
      )
    ).resolves.toMatchObject({
      comment:
        'Worth a look for the same workflow: <a href="https://product.example\n">https://product.example</a>',
    });
  });

  it('escapes markup in a caller-supplied anchor text', async () => {
    stubComment('A useful point about {LINK} here.');

    await expect(
      generateComment(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { ...input, anchorText: '<b>Product</b>' }
      )
    ).resolves.toMatchObject({
      comment:
        'A useful point about <a href="https://product.example\n">&lt;b&gt;Product&lt;/b&gt;</a> here.',
    });
  });

  it('falls back to the site title when the anchor text is blank', async () => {
    stubComment('A useful point about {LINK} here.');

    await expect(
      generateComment(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { ...input, anchorText: '   ' }
      )
    ).resolves.toMatchObject({
      comment:
        'A useful point about <a href="https://product.example\n">Product</a> here.',
    });
  });

  it('rejects a template carrying more than one placeholder', async () => {
    stubComment('{LINK} covers this, and {LINK} goes further.');

    await expect(
      generateComment({ deepseekApiKey: 'deepseek-key', kieApiKey: '' }, input)
    ).rejects.toThrow('COMMENT_PROVIDER_PAYLOAD_INVALID');
  });

  it('rejects a foreign URL sitting alongside the placeholder', async () => {
    stubComment('Compare {LINK} against https://other.example for context.');

    await expect(
      generateComment({ deepseekApiKey: 'deepseek-key', kieApiKey: '' }, input)
    ).rejects.toThrow('COMMENT_RELEVANT_URL_REQUIRED');
  });

  it('rejects a template mixing the placeholder with a Markdown link', async () => {
    stubComment('See {LINK} and [the docs](/docs) for the rest.');

    await expect(
      generateComment({ deepseekApiKey: 'deepseek-key', kieApiKey: '' }, input)
    ).rejects.toThrow('COMMENT_MUST_BE_SAFE_PLAIN_TEXT');
  });

  it('rejects a second model-authored anchor next to the promoted one', async () => {
    stubComment(
      'See <a href="https://product.example">Product</a> and <a href="https://other.example">more</a>.'
    );

    await expect(
      generateComment({ deepseekApiKey: 'deepseek-key', kieApiKey: '' }, input)
    ).rejects.toThrow('COMMENT_MUST_BE_SAFE_PLAIN_TEXT');
  });

  it.each(['prefer-website-field', 'comment-only'] as const)(
    'returns plain comment text for %s mode',
    async (linkMode) => {
      const fetchMock = vi.fn<
        (url: string, request?: RequestInit) => Promise<Response>
      >(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '{"comment":"The example makes the trade-off clear."}',
                  },
                },
              ],
            }),
            { status: 200 }
          )
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(
        generateComment(
          { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
          { ...input, linkMode }
        )
      ).resolves.toMatchObject({
        comment: 'The example makes the trade-off clear.',
      });

      const request = fetchMock.mock.calls[0]?.[1];
      const body = JSON.parse(String(request?.body));
      expect(body.messages[0].content).not.toContain('{LINK}');
    }
  );
});
