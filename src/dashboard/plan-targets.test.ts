import { describe, expect, it } from 'vitest';
import {
  appendOutboundUrlsToTargetText,
  outboundUrlToTargetUrl,
  parsePlanUrls,
} from './plan-targets';

describe('dashboard plan target helpers', () => {
  it('normalizes library entries while preserving the executable article path', () => {
    expect(outboundUrlToTargetUrl('https://www.Example.com/post#reply')).toBe(
      'https://www.example.com/post'
    );
  });

  it('appends complete library URLs using the existing target URL dedupe rules', () => {
    expect(
      appendOutboundUrlsToTargetText(
        'https://example.com/\nhttps://already.example/post',
        [
          'example.com',
          'https://new.example/article',
          'https://new.example/another-article',
        ]
      )
    ).toBe(
      'https://example.com\nhttps://already.example/post\nhttps://new.example/article\nhttps://new.example/another-article'
    );
  });

  it('preserves editable invalid input while adding valid library targets', () => {
    expect(appendOutboundUrlsToTargetText('not a URL', ['example.com'])).toBe(
      'not a URL\nhttps://example.com'
    );
  });

  it('reports duplicate and invalid target rows for the preview', () => {
    expect(
      parsePlanUrls('example.com\nhttps://example.com\njavascript:x')
    ).toEqual(
      expect.objectContaining({
        valid: ['https://example.com'],
        duplicates: ['https://example.com'],
      })
    );
    expect(
      parsePlanUrls('example.com\nhttps://example.com\njavascript:x').invalid
    ).toContain('line:3');
  });
});
