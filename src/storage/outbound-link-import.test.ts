import { describe, expect, it } from 'vitest';
import {
  parseOutboundLinkImportText,
  parseTargetFileRows,
} from './outbound-link-import';

describe('outbound link imports', () => {
  it('reads the default four columns without a header', () => {
    const result = parseOutboundLinkImportText(
      'https://www.example.com/post,是,否,否\nblog.example.com,否,是,是'
    );
    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toEqual([
      {
        lineNumber: 1,
        domain: 'example.com',
        followStatus: 'dofollow',
        loginRequired: false,
        captchaRequired: false,
      },
      {
        lineNumber: 2,
        domain: 'blog.example.com',
        followStatus: 'nofollow',
        loginRequired: true,
        captchaRequired: true,
      },
    ]);
  });

  it('supports headers, omitted columns and invalid row reporting', () => {
    const result = parseOutboundLinkImportText(
      '域名,是否Dofollow,是否需要登录,是否CAPTCHA\nexample.com,yes,,no\n,yes,no,no\nfoo.example.com,maybe,no,no'
    );
    expect(result.headerDetected).toBe(true);
    expect(result.rows).toEqual([
      {
        lineNumber: 2,
        domain: 'example.com',
        followStatus: 'dofollow',
        captchaRequired: false,
      },
    ]);
    expect(result.invalidRows).toEqual([
      { lineNumber: 3, domain: '', error: 'DOMAIN_REQUIRED' },
      { lineNumber: 4, domain: 'foo.example.com', error: 'ATTRIBUTE_INVALID' },
    ]);
  });

  it('uses positional optional columns when only the domain header is present', () => {
    const result = parseOutboundLinkImportText(
      '博客网站域名\nexample.com,是,否,否'
    );
    expect(result.rows).toEqual([
      {
        lineNumber: 2,
        domain: 'example.com',
        followStatus: 'dofollow',
        loginRequired: false,
        captchaRequired: false,
      },
    ]);
  });

  it('reads the first column for plan text files and skips a URL header', () => {
    expect(
      parseTargetFileRows('url\nexample.com/post\nwww.example.com')
    ).toEqual(['example.com/post', 'www.example.com']);
  });
});
