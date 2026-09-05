import { describe, expect, it } from 'vitest';
import { renderDraft } from './render';

const WEBSITE_URL = 'https://example.com';

describe('renderDraft', () => {
  it('renders bbcode', () => {
    const rendered = renderDraft('Check this out {LINK} for more.', {
      websiteUrl: WEBSITE_URL,
      anchorText: 'a helpful guide',
      format: 'bbcode',
    });
    expect(rendered).toBe(
      'Check this out [url=https://example.com]a helpful guide[/url] for more.'
    );
  });

  it('escapes ] in a bbcode anchor label', () => {
    const rendered = renderDraft('{LINK}', {
      websiteUrl: WEBSITE_URL,
      anchorText: 'weird [label]',
      format: 'bbcode',
    });
    expect(rendered).toBe('[url=https://example.com]weird ［label］[/url]');
  });

  it('renders markdown', () => {
    const rendered = renderDraft('See {LINK} here.', {
      websiteUrl: WEBSITE_URL,
      anchorText: 'a helpful guide',
      format: 'markdown',
    });
    expect(rendered).toBe('See [a helpful guide](https://example.com) here.');
  });

  it('escapes ] and [ in a markdown anchor label', () => {
    const rendered = renderDraft('{LINK}', {
      websiteUrl: WEBSITE_URL,
      anchorText: 'weird [label]',
      format: 'markdown',
    });
    expect(rendered).toBe('[weird \\[label\\]](https://example.com)');
  });

  it('renders html and escapes quotes and angle brackets', () => {
    const rendered = renderDraft('{LINK}', {
      websiteUrl: 'https://example.com/?a=1&b=2',
      anchorText: `a "quoted" <label>`,
      format: 'html',
    });
    expect(rendered).toBe(
      '<a href="https://example.com/?a=1&amp;b=2">a &quot;quoted&quot; &lt;label&gt;</a>'
    );
  });

  it('renders bare-url by substituting the URL directly and dropping the anchor wording', () => {
    const rendered = renderDraft('Also see {LINK} for details.', {
      websiteUrl: WEBSITE_URL,
      anchorText: 'ignored wording',
      format: 'bare-url',
    });
    expect(rendered).toBe('Also see https://example.com for details.');
  });

  it('renders none by removing the placeholder and tidying punctuation', () => {
    const rendered = renderDraft('Also see {LINK} , it helps.', {
      websiteUrl: WEBSITE_URL,
      format: 'none',
    });
    expect(rendered).toBe('Also see, it helps.');
  });

  it('leaves a template with no placeholder untouched for format none', () => {
    const rendered = renderDraft('Just a plain comment.', {
      websiteUrl: WEBSITE_URL,
      format: 'none',
    });
    expect(rendered).toBe('Just a plain comment.');
  });

  it('falls back to the website title when no anchor text is given', () => {
    const rendered = renderDraft('{LINK}', {
      websiteUrl: WEBSITE_URL,
      websiteTitle: 'Example Site',
      format: 'markdown',
    });
    expect(rendered).toBe('[Example Site](https://example.com)');
  });

  it('falls back to the hostname when neither anchor text nor title is given', () => {
    const rendered = renderDraft('{LINK}', {
      websiteUrl: 'https://www.example.com',
      format: 'markdown',
    });
    expect(rendered).toBe('[example.com](https://www.example.com)');
  });

  it('throws WRITE_TEMPLATE_INVALID when a link format has no placeholder', () => {
    expect(() =>
      renderDraft('No link here.', {
        websiteUrl: WEBSITE_URL,
        format: 'bbcode',
      })
    ).toThrow('WRITE_TEMPLATE_INVALID');
  });

  it('throws WRITE_TEMPLATE_INVALID when a link format has more than one placeholder', () => {
    expect(() =>
      renderDraft('{LINK} and {LINK}', {
        websiteUrl: WEBSITE_URL,
        format: 'html',
      })
    ).toThrow('WRITE_TEMPLATE_INVALID');
  });

  it('throws WRITE_TEMPLATE_INVALID for format none with more than one placeholder', () => {
    expect(() =>
      renderDraft('{LINK} and {LINK}', {
        websiteUrl: WEBSITE_URL,
        format: 'none',
      })
    ).toThrow('WRITE_TEMPLATE_INVALID');
  });
});
