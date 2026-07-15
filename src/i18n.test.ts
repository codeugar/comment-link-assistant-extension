import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MESSAGE_KEYS } from './i18n';

const requiredBatchKeys = [
  'batchSetupTitle',
  'targetUrlsLabel',
  'prepareBatch',
  'batchReviewTitle',
  'batchConfirmationNotice',
  'confirmAndStartBatch',
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
  'batchStatusPublished',
  'batchStatusSubmittedNotVisible',
  'batchStatusUnknown',
  'siteRejectedByPriorResult',
] as const;

describe('batch translations', () => {
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
});
