import { beforeEach, describe, expect, it } from 'vitest';
import { readWriteContext } from './dom';

describe('readWriteContext', () => {
  beforeEach(() => {
    document.documentElement.lang = '';
    document.title = '';
    document.body.innerHTML = '';
  });

  it('reads a Discourse-style first post and reply count', () => {
    document.documentElement.lang = 'en';
    document.title = 'Why does my build fail on CI?';
    document.body.innerHTML = `
      <article data-post-number="1"><div class="cooked"><p>${'x'.repeat(50)} My CI build fails only on Linux.</p></div></article>
      <article data-post-number="2"><div class="cooked"><p>Have you tried clearing the cache?</p></div></article>
      <article data-post-number="3"><div class="cooked"><p>Same issue here.</p></div></article>
    `;

    const context = readWriteContext(document);

    expect(context.source).toBe('first-post');
    expect(context.firstPost).toContain('My CI build fails only on Linux.');
    expect(context.replyCount).toBe(2);
    expect(context.selection).toBeNull();
  });

  it('reads an XenForo-style first post', () => {
    document.body.innerHTML = `
      <div class="message--post">
        <div class="message-body">${'x'.repeat(50)} XenForo opening post content.</div>
      </div>
      <div class="message--post">
        <div class="message-body">A reply.</div>
      </div>
    `;

    const context = readWriteContext(document);

    expect(context.source).toBe('first-post');
    expect(context.firstPost).toContain('XenForo opening post content.');
    expect(context.replyCount).toBe(1);
  });

  it('reads a phpBB-style first post', () => {
    document.body.innerHTML = `
      <div class="post"><div class="content">${'x'.repeat(50)} phpBB opening post.</div></div>
      <div class="post"><div class="content">Reply one.</div></div>
      <div class="post"><div class="content">Reply two.</div></div>
    `;

    const context = readWriteContext(document);

    expect(context.source).toBe('first-post');
    expect(context.firstPost).toContain('phpBB opening post.');
    expect(context.replyCount).toBe(2);
  });

  it('reads a V2EX-style topic body with no derivable reply count', () => {
    document.body.innerHTML = `
      <div class="topic_content">${'x'.repeat(50)} V2EX topic content goes here.</div>
    `;

    const context = readWriteContext(document);

    expect(context.source).toBe('first-post');
    expect(context.firstPost).toContain('V2EX topic content goes here.');
    expect(context.replyCount).toBeNull();
  });

  it('falls back to an article selector on a plain WordPress-style page', () => {
    document.title = 'A blog post about testing';
    document.body.innerHTML = `
      <article>
        <div class="entry-content">
          <p>${'This is a long-form blog article body. '.repeat(6)}</p>
        </div>
      </article>
    `;

    const context = readWriteContext(document);

    expect(context.source).toBe('article');
    expect(context.firstPost).toContain('long-form blog article body');
    expect(context.replyCount).toBeNull();
  });

  it('falls back to the body when nothing else matches', () => {
    document.body.innerHTML = '<div>short</div>';

    const context = readWriteContext(document);

    expect(context.source).toBe('body');
    expect(context.firstPost).toContain('short');
  });

  it('prefers the user selection when there is one', () => {
    document.body.innerHTML = `
      <article>
        <div class="entry-content"><p>${'A long article body. '.repeat(10)}</p></div>
      </article>
      <p id="target">The exact sentence the user highlighted.</p>
    `;
    const range = document.createRange();
    const target = document.getElementById('target') as HTMLElement;
    range.selectNodeContents(target);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const context = readWriteContext(document);

    expect(context.source).toBe('selection');
    expect(context.selection).toContain(
      'The exact sentence the user highlighted.'
    );
    // firstPost still carries the underlying article/first-post extraction.
    expect(context.firstPost).toContain('A long article body.');
  });

  it('caps firstPost and selection length', () => {
    document.body.innerHTML = `<article><div class="entry-content"><p>${'a'.repeat(10_000)}</p></div></article>`;

    const context = readWriteContext(document);

    expect(context.firstPost.length).toBeLessThanOrEqual(6_000);
  });
});
