import { describe, expect, it } from 'vitest';
import {
  appendOutboundDomainsToTargetText,
  outboundDomainToTargetUrl,
  parsePlanUrls,
} from './plan-targets';

describe('dashboard plan target helpers', () => {
  it('normalizes library domains into executable HTTPS targets', () => {
    expect(outboundDomainToTargetUrl('https://www.Example.com/post')).toBe(
      'https://example.com'
    );
  });

  it('appends library domains using the existing target URL dedupe rules', () => {
    expect(
      appendOutboundDomainsToTargetText(
        'https://example.com/\nhttps://already.example/post',
        ['example.com', 'new.example', 'https://new.example/article']
      )
    ).toBe(
      'https://example.com\nhttps://already.example/post\nhttps://new.example'
    );
  });

  it('preserves editable invalid input while adding valid library targets', () => {
    expect(
      appendOutboundDomainsToTargetText('not a URL', ['example.com'])
    ).toBe('not a URL\nhttps://example.com');
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
