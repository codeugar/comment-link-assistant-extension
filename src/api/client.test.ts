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
  linkMode: 'prefer-website-field' as const,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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
    ).resolves.toBe('A useful comment.');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(request?.headers).toMatchObject({
      Authorization: 'Bearer deepseek-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: false,
      response_format: { type: 'json_object' },
    });
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

    await expect(request).resolves.toBe('A useful comment.');
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

    await expect(request).resolves.toBe('A useful comment.');
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

    await expect(request).resolves.toBe('A useful comment.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires the key for the selected provider', async () => {
    await expect(
      generateComment({ deepseekApiKey: '', kieApiKey: 'kie-key' }, input)
    ).rejects.toThrow('DEEPSEEK_API_KEY_REQUIRED');
  });

  it('rejects a URL when the dedicated website field should be used', async () => {
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
    ).rejects.toThrow('COMMENT_URL_NOT_ALLOWED');
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

  it('adds the promoted URL when an inline comment omits every link', async () => {
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
    ).resolves.toBe('A specific, useful observation. https://product.example');
    expect(fetchMock).toHaveBeenCalledOnce();
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
    ).resolves.toBe('A useful comment.');
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
    ).resolves.toBe('One detail stood out: the example.');
  });
});
