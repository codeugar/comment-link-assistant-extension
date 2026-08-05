import { describe, expect, it } from 'vitest';
import { isPageCommand, runPageCommand } from './command';

describe('page command validation', () => {
  it('keeps legacy prepare commands without a form plan valid', () => {
    expect(
      isPageCommand({
        type: 'submit.prepare',
        input: { comment: 'Useful comment', websiteUrl: '' },
        expected: {
          url: 'https://blog.example/post',
          editorLabel: 'comment',
          submitLabel: 'submit',
          hasWebsiteField: false,
        },
      })
    ).toBe(true);
  });

  it('accepts only a boolean inline-anchor preflight flag', () => {
    const command = {
      type: 'submit.prepare',
      input: {
        comment: 'Useful comment',
        websiteUrl: 'https://product.example',
        requireInlineAnchor: true,
      },
      expected: {
        url: 'https://blog.example/post',
        editorLabel: 'comment',
        submitLabel: 'submit',
        hasWebsiteField: false,
      },
    } as const;

    expect(isPageCommand(command)).toBe(true);
    expect(
      isPageCommand({
        ...command,
        input: { ...command.input, requireInlineAnchor: 'yes' },
      })
    ).toBe(false);
  });

  it('does not publish from a rendered fingerprint without the promoted URL', async () => {
    document.body.innerHTML = `
      <article class="comment-content">A useful generated comment appears publicly.</article>
    `;

    const result = await runPageCommand(document, {
      type: 'moderation.check',
      fingerprint: 'A useful generated comment appears publicly.',
    });

    expect(result).toEqual({
      type: 'moderation-check',
      result: {
        status: 'pending_moderation',
        message: 'COMMENT_PENDING_MODERATION_NOT_VISIBLE',
        fingerprint: 'A useful generated comment appears publicly.',
      },
    });
  });

  it('finds a displayed comment by its target website URL', async () => {
    document.body.innerHTML = `
      <article><a href="https://product.example">navigation link</a></article>
      <section id="comment-42" class="comment-body">
        <a href="https://product.example">Product</a>
      </section>
    `;

    const result = await runPageCommand(document, {
      type: 'moderation.check',
      targetWebsiteUrl: 'https://product.example',
    });

    expect(result).toMatchObject({
      type: 'moderation-check',
      result: {
        status: 'published',
        message: 'COMMENT_PUBLISHED_RENDERED_TARGET_URL',
      },
    });
  });

  it('does not publish a normalized generic block without the promoted URL', async () => {
    document.body.innerHTML = `
      <section id="comments">
        <div class="comment-editor"><textarea></textarea></div>
        <div class="entry-block">
          I love the tip about letting the batter rest overnight—I've noticed
          that with quick breads, a longer rest really does improve the crumb.
        </div>
      </section>
    `.replace('overnight—', 'overnight–');

    const result = await runPageCommand(document, {
      type: 'moderation.check',
      fingerprint:
        "I love the tip about letting the batter rest overnight—I've noticed that with quick breads, a longer rest really does improve the crumb.",
    });

    expect(result).toMatchObject({
      type: 'moderation-check',
      result: {
        status: 'pending_moderation',
        message: 'COMMENT_PENDING_MODERATION_NOT_VISIBLE',
      },
    });
  });

  it('keeps a target link visible when the comments region also contains the form', async () => {
    document.body.innerHTML = `
      <section id="comments">
        <article class="comment-body">
          <p>A displayed comment <a href="https://product.example\n">Product</a></p>
        </article>
        <form id="commentform"><textarea name="comment"></textarea></form>
      </section>
    `;

    const result = await runPageCommand(document, {
      type: 'moderation.check',
      targetWebsiteUrl: 'https://product.example',
    });

    expect(result).toMatchObject({
      type: 'moderation-check',
      result: {
        status: 'published',
        message: 'COMMENT_PUBLISHED_RENDERED_TARGET_URL',
      },
    });
  });

  it('reads verification evidence after a same-origin redirect to another path', async () => {
    const origin = document.location.origin;
    document.defaultView?.history.replaceState({}, '', '/comment/thanks');
    document.body.innerHTML = '<p role="status">Vaš komentar je primljen.</p>';

    const result = await runPageCommand(document, {
      type: 'verify',
      fingerprint: 'Koristan komentar',
      baseline: { feedbackMessages: [], renderedComment: false },
      expectedUrl: `${origin}/article`,
    });

    expect(result).toMatchObject({
      type: 'submission',
      result: {
        status: 'unconfirmed',
      },
    });
    document.defaultView?.history.replaceState({}, '', '/');
  });

  it('does not read verification evidence from another origin', async () => {
    document.body.innerHTML = '<p role="status">Vaš komentar je primljen.</p>';

    const result = await runPageCommand(document, {
      type: 'verify',
      fingerprint: 'Koristan komentar',
      baseline: { feedbackMessages: [], renderedComment: false },
      expectedUrl: 'https://unrelated.example/article',
    });

    expect(result).toMatchObject({
      type: 'submission',
      result: {
        status: 'unconfirmed',
        message: 'COMMENT_SUBMISSION_UNCONFIRMED',
      },
    });
  });

  it('confirms a new WordPress comment anchor as published without the promoted URL', async () => {
    const origin = document.location.origin;
    document.defaultView?.history.replaceState(
      {},
      '',
      '/article#comment-249713'
    );
    document.body.innerHTML = '<form id="commentform"></form>';

    const result = await runPageCommand(document, {
      type: 'verify',
      fingerprint: 'A useful point',
      baseline: { feedbackMessages: [], renderedComment: false },
      expectedUrl: `${origin}/article`,
    });

    expect(result).toMatchObject({
      type: 'submission',
      result: {
        status: 'published',
        message: 'COMMENT_PUBLISHED_WORDPRESS_RECEIPT',
      },
    });
    document.defaultView?.history.replaceState({}, '', '/');
  });

  it('does not infer acceptance from an existing target anchor', async () => {
    const origin = document.location.origin;
    document.defaultView?.history.replaceState(
      {},
      '',
      '/article#comment-249713'
    );
    document.body.innerHTML = '<form id="commentform"></form>';

    const result = await runPageCommand(document, {
      type: 'verify',
      fingerprint: 'A useful point',
      baseline: { feedbackMessages: [], renderedComment: false },
      expectedUrl: `${origin}/article#comment-249713`,
    });

    expect(result).toMatchObject({
      type: 'submission',
      result: {
        status: 'unconfirmed',
        message: 'COMMENT_SUBMISSION_UNCONFIRMED',
      },
    });
    document.defaultView?.history.replaceState({}, '', '/');
  });
});
