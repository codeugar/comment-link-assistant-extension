import { ANCHOR_BUCKETS, MAX_ANCHOR_TEXT_LENGTH } from '@/anchor/types';
import type { AnchorBucket } from '@/anchor/types';
import type { WritePageContext } from '@/page/types';
import { z } from 'zod';

export const WRITE_LINK_FORMATS = [
  'bbcode',
  'markdown',
  'bare-url',
  'html',
  'none',
] as const;

export type WriteLinkFormat = (typeof WRITE_LINK_FORMATS)[number];

export interface WriteTurn {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

export interface WriteDraft {
  id: string;
  /** 1-based, in the order drafts were produced for this session. */
  version: number;
  /** Plain text with exactly one `{LINK}` token, or none for `format: 'none'`. */
  template: string;
  anchorBucket: AnchorBucket | null;
  anchorText: string | null;
  rendered: string;
  format: WriteLinkFormat;
  createdAt: number;
  sentAt?: number;
}

export interface WriteSession {
  tabId: number;
  pageUrl: string;
  siteId: string;
  format: WriteLinkFormat;
  context: WritePageContext;
  turns: WriteTurn[];
  drafts: WriteDraft[];
  createdAt: number;
  updatedAt: number;
}

const MAX_TURN_TEXT_LENGTH = 4_000;
const MAX_TURNS = 80;
const MAX_DRAFTS = 40;

export const writePageContextSchema: z.ZodType<WritePageContext> = z
  .object({
    url: z.string().min(1).max(2_048),
    title: z.string().max(500),
    language: z.string().max(100),
    selection: z.string().max(3_000).nullable(),
    firstPost: z.string().max(6_000),
    replyCount: z.number().int().nonnegative().nullable(),
    source: z.enum(['selection', 'first-post', 'article', 'body']),
  })
  .strict();

export const writeTurnSchema: z.ZodType<WriteTurn> = z
  .object({
    role: z.enum(['user', 'assistant']),
    text: z.string().min(1).max(MAX_TURN_TEXT_LENGTH),
    at: z.number().int().nonnegative(),
  })
  .strict();

export const writeDraftSchema: z.ZodType<WriteDraft> = z
  .object({
    id: z.string().min(1).max(200),
    version: z.number().int().positive(),
    template: z.string().max(2_000),
    anchorBucket: z.enum(ANCHOR_BUCKETS).nullable(),
    anchorText: z.string().max(MAX_ANCHOR_TEXT_LENGTH).nullable(),
    rendered: z.string().max(2_500),
    format: z.enum(WRITE_LINK_FORMATS),
    createdAt: z.number().int().nonnegative(),
    sentAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export const writeSessionSchema: z.ZodType<WriteSession> = z
  .object({
    tabId: z.number().int().nonnegative(),
    pageUrl: z.string().min(1).max(2_048),
    siteId: z.string().min(1).max(200),
    format: z.enum(WRITE_LINK_FORMATS),
    context: writePageContextSchema,
    turns: z.array(writeTurnSchema).max(MAX_TURNS),
    drafts: z.array(writeDraftSchema).max(MAX_DRAFTS),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
