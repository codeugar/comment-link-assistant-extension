import { describe, expect, it } from 'vitest';
import {
  getWordPressSubmitReceipt,
  hasWordPressSubmitReceipt,
  readWordPressSubmitReceipt,
} from './receipts';

describe('WordPress submit receipts', () => {
  it('accepts a newly added comment anchor on the permalink', () => {
    expect(
      getWordPressSubmitReceipt(
        'https://blog.example/article#comment-88',
        'https://blog.example/article'
      )
    ).toBe('published');
    expect(
      hasWordPressSubmitReceipt(
        'https://blog.example/article#comment-88',
        'https://blog.example/article'
      )
    ).toBe(true);
  });

  it('accepts the moderation receipt query on the permalink', () => {
    expect(
      getWordPressSubmitReceipt(
        'https://blog.example/article?unapproved=42&moderation-hash=abc',
        'https://blog.example/article'
      )
    ).toBe('pending_moderation');
    expect(
      hasWordPressSubmitReceipt(
        'https://blog.example/article?unapproved=42&moderation-hash=abc',
        'https://blog.example/article'
      )
    ).toBe(true);
  });

  it('accepts a paginated-comments redirect carrying the anchor', () => {
    expect(
      hasWordPressSubmitReceipt(
        'https://blog.example/article/comment-page-2/#comment-99',
        'https://blog.example/article/'
      )
    ).toBe(true);
  });

  it('rejects a pre-existing anchor already present on the target', () => {
    expect(
      hasWordPressSubmitReceipt(
        'https://blog.example/article#comment-88',
        'https://blog.example/article#comment-88'
      )
    ).toBe(false);
  });

  it('rejects another origin even with an anchor', () => {
    expect(
      hasWordPressSubmitReceipt(
        'https://evil.example/article#comment-88',
        'https://blog.example/article'
      )
    ).toBe(false);
  });

  it('rejects another permalink even with an anchor', () => {
    expect(
      hasWordPressSubmitReceipt(
        'https://blog.example/another-article#comment-88',
        'https://blog.example/article'
      )
    ).toBe(false);
  });

  it('rejects a longer permalink that merely starts with the target path', () => {
    expect(
      hasWordPressSubmitReceipt(
        'https://blog.example/article-two/comment-page-2/#comment-88',
        'https://blog.example/article'
      )
    ).toBe(false);
  });

  it('rejects a bare permalink without any receipt', () => {
    expect(
      getWordPressSubmitReceipt(
        'https://blog.example/article',
        'https://blog.example/article'
      )
    ).toBeNull();
    expect(
      hasWordPressSubmitReceipt(
        'https://blog.example/article',
        'https://blog.example/article'
      )
    ).toBe(false);
  });

  it('reads the comment id a published receipt carries', () => {
    expect(
      readWordPressSubmitReceipt(
        'https://blog.example/article#comment-88213',
        'https://blog.example/article'
      )
    ).toEqual({
      type: 'published',
      url: 'https://blog.example/article#comment-88213',
      commentId: '88213',
    });
  });

  it('reads the comment id a moderation receipt carries', () => {
    expect(
      readWordPressSubmitReceipt(
        'https://blog.example/article?unapproved=4242&moderation-hash=abc',
        'https://blog.example/article'
      )
    ).toEqual({
      type: 'pending_moderation',
      url: 'https://blog.example/article?unapproved=4242&moderation-hash=abc',
      commentId: '4242',
    });
  });

  it('keeps a receipt whose id is not a number id-less', () => {
    expect(
      readWordPressSubmitReceipt(
        'https://blog.example/article?unapproved=abc&moderation-hash=abc',
        'https://blog.example/article'
      )
    ).toEqual({
      type: 'pending_moderation',
      url: 'https://blog.example/article?unapproved=abc&moderation-hash=abc',
    });
  });
});
