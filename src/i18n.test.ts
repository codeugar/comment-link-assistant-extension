import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_LOCALE,
  MESSAGE_KEYS,
  getUiLocale,
  setUiLocale,
  translate,
} from './i18n';

const requiredBatchKeys = [
  'batchIdleTitle',
  'batchIdleDescription',
  'batchProgressTitle',
  'continueBatch',
  'stopBatch',
  'batchPausedLoginDescription',
  'batchPausedCaptchaDescription',
  'batchCompletedTitle',
  'batchStoppedTitle',
  'startNewBatch',
  'batchStatusQueued',
  'batchStatusGenerating',
  'batchStatusSubmitted',
] as const;

describe('batch translations', () => {
  it('defaults to Chinese and switches catalogs without browser locale', () => {
    expect(DEFAULT_UI_LOCALE).toBe('zh-CN');
    setUiLocale('zh-CN');
    expect(translate('settingsTitle')).toBe('设置');
    setUiLocale('en');
    expect(getUiLocale()).toBe('en');
    expect(translate('settingsTitle')).toBe('Settings');
    setUiLocale(DEFAULT_UI_LOCALE);
  });

  it.each(['en', 'zh_CN'])('defines every batch message in %s', (locale) => {
    const path = join(
      process.cwd(),
      'public',
      '_locales',
      locale,
      'messages.json'
    );
    const messages = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      unknown
    >;

    expect(Object.keys(messages)).toEqual(
      expect.arrayContaining([...requiredBatchKeys])
    );
    expect(Object.keys(messages)).toEqual(
      expect.arrayContaining([...MESSAGE_KEYS])
    );
  });

  it.each(['en', 'zh_CN'])(
    'contains no replacement-character corruption in %s',
    (locale) => {
      const path = join(
        process.cwd(),
        'public',
        '_locales',
        locale,
        'messages.json'
      );
      const source = readFileSync(path, 'utf8');

      expect(source).not.toContain('\uFFFD');
      expect(source).not.toMatch(/\?{3,}/);
    }
  );

  it('keeps the Chinese batch summary readable', () => {
    const path = join(
      process.cwd(),
      'public',
      '_locales',
      'zh_CN',
      'messages.json'
    );
    const messages = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      { message: string }
    >;

    expect(messages.batchSummary?.message).toBe(
      '\u5df2\u663e\u793a $1 \u00b7 \u7b49\u5f85\u5ba1\u6838 $2 \u00b7 \u7ed3\u679c\u672a\u786e\u8ba4 $3 \u00b7 \u5931\u8d25 $4'
    );
  });
});
