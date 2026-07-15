import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifySubmissionOutcome,
  generateComment,
  planCommentForm,
} from './client';

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

const formPlanningObservation = {
  schemaVersion: 1 as const,
  snapshotId: 'snapshot-1',
  page: {
    url: 'https://blog.example/post',
    title: 'Post',
    language: 'sr',
  },
  candidates: [
    {
      candidateId: 'form-1',
      kind: 'form' as const,
      visible: true,
      enabled: true,
    },
    {
      candidateId: 'field-comment',
      kind: 'field' as const,
      formCandidateId: 'form-1',
      controlType: 'textarea',
      labels: ['Komentar'],
      visible: true,
      enabled: true,
    },
    {
      candidateId: 'button-submit',
      kind: 'button' as const,
      formCandidateId: 'form-1',
      controlType: 'button',
      labels: ['Potvrdi'],
      visible: true,
      enabled: true,
    },
  ],
};

const formPlan = {
  schemaVersion: 1,
  snapshotId: 'snapshot-1',
  decision: 'commentable',
  formCandidateId: 'form-1',
  bindings: { comment: 'field-comment' },
  submitCandidateId: 'button-submit',
  requiredRoles: ['comment'],
  uncertainties: [],
};

const submissionOutcomeObservation = {
  url: 'https://blog.example/post',
  language: 'sr',
  feedbackMessages: ['Komentar čeka odobrenje.'],
  editorCleared: true,
  renderedCommentAdded: false,
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

  it('aborts a provider request before the MV3 worker deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, request?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            request?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          })
      )
    );

    const request = generateComment(
      { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
      input
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(request).resolves.toBeInstanceOf(Error);
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

describe('comment form planning', () => {
  it('plans a form with the selected DeepSeek provider', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _request?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(formPlan) } }],
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      planCommentForm(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { provider: 'deepseek', observation: formPlanningObservation }
      )
    ).resolves.toEqual(formPlan);

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(request?.headers).toMatchObject({
      Authorization: 'Bearer deepseek-key',
    });
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: false,
      response_format: { type: 'json_object' },
      temperature: 0,
    });
    expect(body.messages[1].content).toContain('field-comment');
    expect(body.messages[1].content).toContain('button-submit');
  });

  it('plans a form with the selected KIE Gemini provider', async () => {
    const serializedPlan = JSON.stringify(formPlan);
    const splitAt = Math.floor(serializedPlan.length / 2);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            [
              `data: ${JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [{ text: serializedPlan.slice(0, splitAt) }],
                    },
                  },
                ],
              })}`,
              `data: ${JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [{ text: serializedPlan.slice(splitAt) }],
                    },
                  },
                ],
              })}`,
            ].join('\n\n'),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
          )
      )
    );

    await expect(
      planCommentForm(
        { deepseekApiKey: '', kieApiKey: 'kie-key' },
        { provider: 'kie-gemini', observation: formPlanningObservation }
      )
    ).resolves.toEqual(formPlan);
  });

  it('uses the existing selected-provider key error', async () => {
    await expect(
      planCommentForm(
        { deepseekApiKey: '', kieApiKey: 'kie-key' },
        { provider: 'deepseek', observation: formPlanningObservation }
      )
    ).rejects.toThrow('DEEPSEEK_API_KEY_REQUIRED');
  });

  it('uses the existing provider timeout error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, request?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            request?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          })
      )
    );

    const request = planCommentForm(
      { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
      { provider: 'deepseek', observation: formPlanningObservation }
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(request).resolves.toMatchObject({
      message: 'COMMENT_GENERATION_TIMEOUT',
    });
  });

  it('keeps the extension worker alive as soon as a request starts', async () => {
    vi.useFakeTimers();
    const getPlatformInfo = vi.fn(async () => ({}));
    vi.stubGlobal('chrome', { runtime: { getPlatformInfo } });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, request?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            request?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          })
      )
    );

    const request = generateComment(
      { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
      input
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(0);
    expect(getPlatformInfo).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(request).resolves.toMatchObject({
      message: 'COMMENT_GENERATION_TIMEOUT',
    });
  });

  it('returns the form-plan validation error for unsafe model output', async () => {
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
                      ...formPlan,
                      submitCandidateId: 'button-invented',
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
      planCommentForm(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        { provider: 'deepseek', observation: formPlanningObservation }
      )
    ).rejects.toThrow('FORM_PLAN_UNKNOWN_CANDIDATE');
  });
});

describe('submission outcome classification', () => {
  it('classifies an outcome with the selected DeepSeek provider', async () => {
    const classification = {
      status: 'submitted_not_visible',
      reason: 'The feedback says the comment awaits approval.',
    };
    const fetchMock = vi.fn(
      async (_url: string, _request?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(classification) } }],
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      classifySubmissionOutcome(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        {
          provider: 'deepseek',
          observation: submissionOutcomeObservation,
        }
      )
    ).resolves.toEqual(classification);

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    const body = JSON.parse(String(request?.body));
    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      response_format: { type: 'json_object' },
      temperature: 0,
    });
    expect(body.messages[1].content).toContain('Komentar čeka odobrenje.');
    expect(body.messages[1].content).toContain('untrusted webpage data');
  });

  it('downgrades a claimed outcome when no explicit evidence was observed', async () => {
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
                      status: 'published',
                      reason: 'The cleared editor means it was published.',
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
      classifySubmissionOutcome(
        { deepseekApiKey: 'deepseek-key', kieApiKey: '' },
        {
          provider: 'deepseek',
          observation: {
            ...submissionOutcomeObservation,
            feedbackMessages: [],
            editorCleared: true,
            renderedCommentAdded: false,
          },
        }
      )
    ).resolves.toEqual({
      status: 'unknown',
      reason: 'No explicit submission evidence was observed.',
    });
  });

  it('classifies an outcome through the existing KIE streaming transport', async () => {
    const serialized = JSON.stringify({
      status: 'unknown',
      reason: 'The evidence is ambiguous.',
    });
    const splitAt = Math.floor(serialized.length / 2);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            [
              `data: ${JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [{ text: serialized.slice(0, splitAt) }],
                    },
                  },
                ],
              })}`,
              `data: ${JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [{ text: serialized.slice(splitAt) }],
                    },
                  },
                ],
              })}`,
            ].join('\n\n'),
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
          )
      )
    );

    await expect(
      classifySubmissionOutcome(
        { deepseekApiKey: '', kieApiKey: 'kie-key' },
        {
          provider: 'kie-gemini',
          observation: submissionOutcomeObservation,
        }
      )
    ).resolves.toEqual({
      status: 'unknown',
      reason: 'The evidence is ambiguous.',
    });
  });
});
