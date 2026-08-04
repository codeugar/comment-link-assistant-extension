import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  parseOutboundLinkImportFile,
  parseOutboundLinkImportText,
  parseTargetFile,
  parseTargetFileRows,
} from './outbound-link-import';

function spreadsheetFile(
  sheets: Array<{ name: string; rows: unknown[][] }>,
  name = 'import.xlsx'
): File {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(sheet.rows),
      sheet.name
    );
  }
  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new File([bytes], name, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

describe('outbound link imports', () => {
  it('reads the default four columns without a header', () => {
    const result = parseOutboundLinkImportText(
      'https://www.example.com/post,是,否,否\nblog.example.com,否,是,是'
    );
    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toEqual([
      {
        lineNumber: 1,
        url: 'https://www.example.com/post',
        domain: 'example.com',
        followStatus: 'dofollow',
        loginRequired: false,
        captchaRequired: false,
      },
      {
        lineNumber: 2,
        url: 'https://blog.example.com',
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
        url: 'https://example.com',
        domain: 'example.com',
        followStatus: 'dofollow',
        captchaRequired: false,
      },
    ]);
    expect(result.invalidRows).toEqual([
      { lineNumber: 3, url: '', domain: '', error: 'URL_REQUIRED' },
      {
        lineNumber: 4,
        url: 'https://foo.example.com',
        domain: 'foo.example.com',
        error: 'ATTRIBUTE_INVALID',
      },
    ]);
  });

  it('uses positional optional columns when only the domain header is present', () => {
    const result = parseOutboundLinkImportText(
      '博客网站域名\nexample.com,是,否,否'
    );
    expect(result.rows).toEqual([
      {
        lineNumber: 2,
        url: 'https://example.com',
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

  it('uses the first non-empty workbook sheet for library imports', async () => {
    const result = await parseOutboundLinkImportFile(
      spreadsheetFile([
        { name: '说明', rows: [] },
        {
          name: '外链库',
          rows: [
            ['博客网站域名', '是否Dofollow', '是否需要登录', '是否CAPTCHA'],
            ['www.example.com/post', '是', '否', '否'],
          ],
        },
      ])
    );

    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toEqual([
      {
        lineNumber: 2,
        url: 'https://www.example.com/post',
        domain: 'example.com',
        followStatus: 'dofollow',
        loginRequired: false,
        captchaRequired: false,
      },
    ]);
  });

  it('finds a named URL column in the first non-empty plan workbook sheet', async () => {
    const values = await parseTargetFile(
      spreadsheetFile([
        { name: '空表', rows: [] },
        {
          name: '计划',
          rows: [
            ['备注', '目标网址'],
            ['博客 A', 'example.com/post'],
            ['博客 B', 'https://www.example.org/article'],
          ],
        },
      ])
    );

    expect(values).toEqual([
      'example.com/post',
      'https://www.example.org/article',
    ]);
  });

  it('preserves CSV text so plan parsing can find domains outside column A', async () => {
    const values = await parseTargetFile(
      new File(['备注,目标网址\n博客 A,example.com/post'], 'targets.csv', {
        type: 'text/csv',
      })
    );

    expect(values).toEqual(['备注,目标网址\n博客 A,example.com/post']);
  });
});
