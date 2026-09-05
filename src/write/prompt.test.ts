import type { WritePageContext } from '@/page/types';
import type { WebsiteProfile } from '@/website/profile';
import { describe, expect, it } from 'vitest';
import { buildWritePrompt } from './prompt';
import type { WriteTurn } from './types';

const websiteProfile: WebsiteProfile = {
  url: 'https://example.com',
  title: 'Example',
  description: 'An example site.',
};

const context: WritePageContext = {
  url: 'https://forum.example/thread/1',
  title: 'Why does my build fail on CI?',
  language: 'en',
  selection: null,
  firstPost: 'My CI build fails only on Linux.',
  replyCount: 2,
  source: 'first-post',
};

describe('buildWritePrompt', () => {
  it('asks for a first-turn restatement with no draft', () => {
    const prompt = buildWritePrompt({
      websiteProfile,
      context,
      history: [],
      userMessage: null,
      format: 'markdown',
    });

    expect(prompt.system).toMatch(/first turn/i);
    expect(prompt.system).toMatch(/Do not include a draft on this turn/i);
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]).toMatchObject({ role: 'user' });
    expect(prompt.messages[0]?.content).toContain('forum.example/thread/1');
  });

  it('mentions the selection when the page context came from one', () => {
    const prompt = buildWritePrompt({
      websiteProfile,
      context: {
        ...context,
        selection: 'The exact highlighted text.',
        source: 'selection',
      },
      history: [],
      userMessage: null,
      format: 'markdown',
    });

    expect(prompt.system).toMatch(/selection/i);
  });

  it('carries prior turns and the new user message for a later turn', () => {
    const history: WriteTurn[] = [
      { role: 'assistant', text: 'What angle interests you?', at: 1 },
      { role: 'user', text: 'The caching issue.', at: 2 },
    ];

    const prompt = buildWritePrompt({
      websiteProfile,
      context,
      history,
      userMessage: 'Focus on the cache invalidation bug.',
      format: 'bbcode',
    });

    expect(prompt.system).not.toMatch(/first turn/i);
    expect(prompt.system).toMatch(/at most 2 sentences/i);
    expect(prompt.messages).toHaveLength(4);
    expect(prompt.messages[1]).toEqual({
      role: 'assistant',
      content: 'What angle interests you?',
    });
    expect(prompt.messages[3]).toEqual({
      role: 'user',
      content: 'Focus on the cache invalidation bug.',
    });
  });

  it('requests model-authored anchor wording only when asked', () => {
    const prompt = buildWritePrompt({
      websiteProfile,
      context,
      history: [],
      userMessage: 'go on',
      requestAnchorText: true,
      format: 'html',
    });

    expect(prompt.system).toMatch(/draft.anchorText/);
  });

  it('tells the model the fixed anchor wording when one was chosen', () => {
    const prompt = buildWritePrompt({
      websiteProfile,
      context,
      history: [],
      userMessage: 'go on',
      anchorText: 'a helpful resource',
      format: 'html',
    });

    expect(prompt.system).toContain('a helpful resource');
  });

  it('never leaks markup instructions that contradict the placeholder rule', () => {
    const prompt = buildWritePrompt({
      websiteProfile,
      context,
      history: [],
      userMessage: null,
      format: 'html',
    });

    expect(prompt.system).toMatch(/exactly one \{LINK\} token/);
    expect(prompt.system).toMatch(/Never use HTML, Markdown links, BBCode/);
  });
});
