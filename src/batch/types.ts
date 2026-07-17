import type { PageAnalysis, PreparedPageSubmission } from '@/page/types';
import type { ExtensionSettings } from '@/types';
import type { WebsiteProfile } from '@/website/profile';
import { z } from 'zod';

export const BATCH_ITEM_STATUSES = [
  'queued',
  'opening',
  'analyzing',
  'generating',
  'prepared',
  'click_dispatched',
  'verifying',
  'submitted',
  'login_required',
  'captcha_required',
  'no_form',
  'validation_error',
  'failed',
  'stopped',
] as const;

export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number];

export interface BatchItemEvent {
  status: BatchItemStatus;
  message: string;
  at: number;
}

export const BATCH_STATUSES = [
  'running',
  'paused',
  'completed',
  'stopped',
] as const;

export type BatchStatus = (typeof BATCH_STATUSES)[number];

export type BatchSettingsSnapshot = Pick<
  ExtensionSettings,
  'provider' | 'websiteUrl' | 'displayName' | 'email' | 'linkMode'
>;

export interface BatchItem {
  id: string;
  url: string;
  status: BatchItemStatus;
  analysis: PageAnalysis | null;
  comment: string | null;
  commentFingerprint: string | null;
  prepared: PreparedPageSubmission | null;
  events: BatchItemEvent[];
  partialPageAllowed?: boolean;
  message: string;
  createdAt: number;
  updatedAt: number;
}

export interface BatchSnapshot {
  id: string;
  status: BatchStatus;
  settings: BatchSettingsSnapshot;
  items: BatchItem[];
  currentIndex: number;
  websiteProfile: WebsiteProfile | null;
  workerTabId?: number;
  createdAt: number;
  updatedAt: number;
}

const httpUrlSchema = z
  .string()
  .max(2_048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    );
  });

const optionalEmailSchema = z
  .string()
  .max(320)
  .refine(
    (value) => value === '' || z.string().email().safeParse(value).success
  );

export const batchSettingsSnapshotSchema: z.ZodType<BatchSettingsSnapshot> = z
  .object({
    provider: z.enum(['deepseek', 'kie-gemini']),
    websiteUrl: httpUrlSchema,
    displayName: z.string().max(200),
    email: optionalEmailSchema,
    linkMode: z.enum(['prefer-website-field', 'inline']),
  })
  .strict();

const websiteProfileSchema: z.ZodType<WebsiteProfile> = z
  .object({
    url: httpUrlSchema,
    title: z.string().max(500),
    description: z.string().max(2_000),
  })
  .strict();

const targetPageContextSchema = z
  .object({
    url: httpUrlSchema,
    title: z.string().max(500),
    description: z.string().max(2_000),
    excerpt: z.string().max(8_000),
    language: z.string().max(100),
    hasWebsiteField: z.boolean(),
  })
  .strict();

const commentFormSummarySchema = z
  .object({
    readiness: z.enum([
      'ready',
      'login_required',
      'captcha_required',
      'not_found',
    ]),
    editorLabel: z.string().max(500),
    submitLabel: z.string().max(500),
    hasNameField: z.boolean(),
    hasEmailField: z.boolean(),
    hasWebsiteField: z.boolean(),
    requiresWebsiteField: z.boolean().optional(),
    message: z.string().max(500),
    frame: z
      .object({ kind: z.literal('jetpack'), url: httpUrlSchema })
      .strict()
      .optional(),
  })
  .strict();

const pageAnalysisSchema: z.ZodType<PageAnalysis> = z
  .object({
    page: targetPageContextSchema,
    form: commentFormSummarySchema,
  })
  .strict();

const preparedPageSubmissionSchema: z.ZodType<PreparedPageSubmission> = z
  .object({
    fingerprint: z.string().max(80),
    comment: z.string().max(2_000),
    domToken: z.string().max(128),
    baseline: z
      .object({
        feedbackMessages: z.array(z.string().max(500)).max(20),
        renderedComment: z.boolean(),
      })
      .strict(),
    expected: z
      .object({
        url: httpUrlSchema,
        editorLabel: z.string().max(500),
        submitLabel: z.string().max(500),
        hasWebsiteField: z.boolean(),
      })
      .strict(),
  })
  .strict();

const batchItemEventSchema: z.ZodType<BatchItemEvent> = z
  .object({
    status: z.enum(BATCH_ITEM_STATUSES),
    message: z.string().max(500),
    at: z.number().int().nonnegative(),
  })
  .strict();

export const batchItemSchema: z.ZodType<BatchItem> = z
  .object({
    id: z.string().min(1).max(200),
    url: httpUrlSchema,
    status: z.enum(BATCH_ITEM_STATUSES),
    analysis: pageAnalysisSchema.nullable(),
    comment: z.string().max(2_000).nullable(),
    commentFingerprint: z.string().max(64).nullable(),
    prepared: preparedPageSubmissionSchema.nullable(),
    events: z.array(batchItemEventSchema).min(1).max(32),
    partialPageAllowed: z.boolean().optional(),
    message: z.string().max(500),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

const pausedItemStatuses = new Set<BatchItemStatus>([
  'login_required',
  'captcha_required',
]);

const completedItemStatuses = new Set<BatchItemStatus>([
  'submitted',
  'no_form',
  'validation_error',
  'failed',
  'stopped',
]);

export const batchSnapshotSchema: z.ZodType<BatchSnapshot> = z
  .object({
    id: z.string().min(1).max(200),
    status: z.enum(BATCH_STATUSES),
    settings: batchSettingsSnapshotSchema,
    items: z.array(batchItemSchema).min(1).max(200),
    currentIndex: z.number().int().nonnegative(),
    websiteProfile: websiteProfileSchema.nullable(),
    workerTabId: z.number().int().nonnegative().optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((batch, context) => {
    if (batch.currentIndex > batch.items.length) {
      context.addIssue({
        code: 'custom',
        message: 'Current batch index is outside the queue',
        path: ['currentIndex'],
      });
      return;
    }

    if (batch.status === 'completed') {
      if (batch.currentIndex !== batch.items.length) {
        context.addIssue({
          code: 'custom',
          message: 'Completed batches must be at the end of the queue',
          path: ['currentIndex'],
        });
      }
      if (
        !batch.items.every((item) => completedItemStatuses.has(item.status))
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Completed batches cannot contain unfinished items',
          path: ['items'],
        });
      }
      return;
    }

    if (batch.status === 'running' || batch.status === 'paused') {
      if (batch.currentIndex >= batch.items.length) {
        context.addIssue({
          code: 'custom',
          message: 'Active batches must point to a queue item',
          path: ['currentIndex'],
        });
        return;
      }
    }

    if (
      batch.status === 'paused' &&
      !pausedItemStatuses.has(
        batch.items[batch.currentIndex]?.status ?? 'queued'
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Paused batches must point to a manual-review item',
        path: ['items', batch.currentIndex, 'status'],
      });
    }
  });
