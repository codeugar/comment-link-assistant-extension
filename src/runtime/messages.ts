import type { BatchSnapshot } from '@/batch/types';
import type {
  PageAnalysis,
  PageSubmissionResult,
  PageSubmissionTarget,
} from '@/page/types';
import type { WebsiteProfile } from '@/website/profile';

export type PopupMessage =
  | { type: 'page.analyze' }
  | { type: 'comment.prepare' }
  | { type: 'batch.preview'; websiteUrl: string; refresh?: boolean }
  | {
      type: 'batch.start';
      targetText: string;
      websiteProfile: WebsiteProfile;
    }
  | { type: 'batch.continue' }
  | { type: 'batch.stop' }
  | { type: 'batch.reset' }
  | { type: 'batch.retry-items'; itemIds: string[] }
  | { type: 'batch.retry-from-history'; historyId: string; urls?: string[] }
  | { type: 'batch.open-current' }
  | {
      type: 'comment.submit';
      comment: string;
      target: PageSubmissionTarget;
    };

export interface PreparedComment {
  analysis: PageAnalysis;
  websiteProfile: WebsiteProfile;
  comment: string;
  target: PageSubmissionTarget;
}

export type PopupMessageResult =
  | { type: 'page.analyze'; data: PageAnalysis }
  | { type: 'comment.prepare'; data: PreparedComment }
  | { type: 'comment.submit'; data: PageSubmissionResult }
  | { type: 'batch.preview'; data: WebsiteProfile }
  | {
      type:
        | 'batch.start'
        | 'batch.continue'
        | 'batch.stop'
        | 'batch.reset'
        | 'batch.retry-items'
        | 'batch.retry-from-history'
        | 'batch.open-current';
      data: BatchSnapshot | null;
    };

export type BackgroundResponse =
  | { ok: true; data: PopupMessageResult }
  | { ok: false; error: { code: string; message: string } };

function isBackgroundResponse(value: unknown): value is BackgroundResponse {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'ok' in value &&
      typeof (value as { ok: unknown }).ok === 'boolean'
  );
}

export async function sendToBackground(
  message: PopupMessage
): Promise<PopupMessageResult> {
  const response = (await chrome.runtime.sendMessage(message)) as unknown;
  if (!isBackgroundResponse(response))
    throw new Error('BACKGROUND_RESPONSE_INVALID');
  if (!response.ok)
    throw new Error(`${response.error.code}:${response.error.message}`);
  return response.data;
}
