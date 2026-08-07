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

  it('records a new WordPress comment anchor as acceptance, not publication', async () => {
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
        status: 'unconfirmed',
        message: 'COMMENT_ACCEPTED_AWAITING_PUBLIC_CHECK',
        acceptance: 'server_receipt',
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
