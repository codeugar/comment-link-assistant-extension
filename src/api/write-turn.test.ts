import type { WebsiteProfile } from '@/website/profile';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateWriteTurn } from './client';

const websiteProfile: WebsiteProfile = {
  url: 'https://product.example',
  title: 'Product',
  description: 'Description',
};

const prompt = {
  system: 'system rules',
  messages: [{ role: 'user' as const, content: 'context payload' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function deepseekResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
  });
}

function geminiResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: content }] } }],
    }),
    { status: 200 }
  );
}

describe('generateWriteTurn', () => {
  it('sends the full message history to DeepSeek with the system prompt first', async () => {
    const fetchMock = vi.fn(async (_url: string, _request?: RequestInit) =>
      deepseekResponse(JSON.stringify({ reply: 'What angle interests you?' }))
    );
    vi.stubGlobal('fetch', fetchMock);

    const history = {
      system: 'system rules',
      messages: [
        { role: 'user' as const, content: 'context payload' },
        { role: 'assistant' as const, content: 'earlier reply' },
        { role: 'user' as const, content: 'the caching bug' },
      ],
    };

    await generateWriteTurn(
      { deepseekApiKey: 'key', kieApiKey: '' },
      {
        provider: 'deepseek',
        websiteProfile,
        prompt: history,
        isFirstTurn: false,
      }
    );

    const [, request] = fetchMock.mock.calls[0] ?? [undefined, undefined];
    const body = JSON.parse(String(request?.body));
    expect(body.messages).toEqual([
      { role: 'system', content: 'system rules' },
      { role: 'user', content: 'context payload' },
      { role: 'assistant', content: 'earlier reply' },
      { role: 'user', content: 'the caching bug' },
    ]);
  });

  it('builds alternating Gemini contents with the system text on the first turn', async () => {
    const fetchMock = vi.fn(async (_url: string, _request?: RequestInit) =>
      geminiResponse(JSON.stringify({ reply: 'ok', draft: null }))
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateWriteTurn(
      { deepseekApiKey: '', kieApiKey: 'key' },
      {
        provider: 'kie-gemini',
        websiteProfile,
        prompt: {
          system: 'system rules',
          messages: [
            { role: 'user', content: 'context payload' },
            { role: 'assistant', content: 'earlier reply' },
          ],
        },
        isFirstTurn: false,
      }
    );

    const [, request] = fetchMock.mock.calls[0] ?? [undefined, undefined];
    const body = JSON.parse(String(request?.body));
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'system rules\n\ncontext payload' }] },
      { role: 'model', parts: [{ text: 'earlier reply' }] },
    ]);
  });

  it('returns the reply with no draft when the model sends none', async () => {
    vi.stubGlobal('fetch', async () =>
      deepseekResponse(
        JSON.stringify({ reply: 'Tell me more about the failure.' })
      )
    );

    const result = await generateWriteTurn(
      { deepseekApiKey: 'key', kieApiKey: '' },
      { provider: 'deepseek', websiteProfile, prompt, isFirstTurn: true }
    );

    expect(result).toEqual({
      reply: 'Tell me more about the failure.',
      draft: null,
    });
  });

  it('drops a draft the model wrongly sent on the first turn instead of throwing', async () => {
    vi.stubGlobal('fetch', async () =>
      deepseekResponse(
        JSON.stringify({
          reply:
            'Restating the topic in a couple sentences. What draws you to it?',
          draft: { comment: 'A premature draft {LINK}.' },
        })
      )
    );

    const result = await generateWriteTurn(
      { deepseekApiKey: 'key', kieApiKey: '' },
      { provider: 'deepseek', websiteProfile, prompt, isFirstTurn: true }
    );

    expect(result.draft).toBeNull();
    expect(result.reply).toMatch(/Restating the topic/);
  });

  it('validates and returns a draft template with the caller-chosen anchor text', async () => {
    vi.stubGlobal('fetch', async () =>
      deepseekResponse(
        JSON.stringify({
          reply: 'Here is a draft.',
          draft: { comment: 'Worth checking {LINK} for the details.' },
        })
      )
    );

    const result = await generateWriteTurn(
      { deepseekApiKey: 'key', kieApiKey: '' },
      {
        provider: 'deepseek',
        websiteProfile,
        prompt,
        isFirstTurn: false,
        anchorText: 'a useful comparison',
      }
    );

    expect(result.draft).toEqual({
      template: 'Worth checking {LINK} for the details.',
      anchorText: 'a useful comparison',
    });
  });

  it('accepts the model-suggested anchor text only when requestAnchorText is set', async () => {
    vi.stubGlobal('fetch', async () =>
      deepseekResponse(
        JSON.stringify({
          reply: 'Here is a draft.',
          draft: {
            comment: 'Worth checking {LINK} for the details.',
            anchorText: 'a plain phrase',
          },
        })
      )
    );

    const result = await generateWriteTurn(
      { deepseekApiKey: 'key', kieApiKey: '' },
      {
        provider: 'deepseek',
        websiteProfile,
        prompt,
        isFirstTurn: false,
        requestAnchorText: true,
      }
    );

    expect(result.draft?.anchorText).toBe('a plain phrase');
  });

  it('rejects a draft that carries a foreign URL instead of repairing it', async () => {
    vi.stubGlobal('fetch', async () =>
      deepseekResponse(
        JSON.stringify({
          reply: 'Here is a draft.',
          draft: { comment: 'Check https://spam.example instead.' },
        })
      )
    );

    await expect(
      generateWriteTurn(
        { deepseekApiKey: 'key', kieApiKey: '' },
        { provider: 'deepseek', websiteProfile, prompt, isFirstTurn: false }
      )
    ).rejects.toThrow('COMMENT_RELEVANT_URL_REQUIRED');
  });

  it('rejects a draft carrying HTML markup', async () => {
    vi.stubGlobal('fetch', async () =>
      deepseekResponse(
        JSON.stringify({
          reply: 'Here is a draft.',
          draft: {
            comment: 'See <a href="https://x.example">this</a> {LINK}.',
          },
        })
      )
    );

    await expect(
      generateWriteTurn(
        { deepseekApiKey: 'key', kieApiKey: '' },
        { provider: 'deepseek', websiteProfile, prompt, isFirstTurn: false }
      )
    ).rejects.toThrow(/COMMENT_/);
  });

  it('throws on an unparsable response body', async () => {
    vi.stubGlobal('fetch', async () => deepseekResponse('not json'));

    await expect(
      generateWriteTurn(
        { deepseekApiKey: 'key', kieApiKey: '' },
        { provider: 'deepseek', websiteProfile, prompt, isFirstTurn: true }
      )
    ).rejects.toThrow('COMMENT_PROVIDER_JSON_INVALID');
  });

  it('throws when the reply field is missing', async () => {
    vi.stubGlobal('fetch', async () => deepseekResponse(JSON.stringify({})));

    await expect(
      generateWriteTurn(
        { deepseekApiKey: 'key', kieApiKey: '' },
        { provider: 'deepseek', websiteProfile, prompt, isFirstTurn: true }
      )
    ).rejects.toThrow('COMMENT_PROVIDER_PAYLOAD_INVALID');
  });
});
