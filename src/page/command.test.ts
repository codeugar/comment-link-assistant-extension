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
        status: 'unknown',
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
        status: 'unknown',
        message: 'COMMENT_SUBMISSION_UNCONFIRMED',
      },
    });
  });

  it('treats a new WordPress comment anchor as server acceptance', async () => {
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
        status: 'submitted_not_visible',
        message: 'COMMENT_SUBMITTED_NOT_VISIBLE',
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
        status: 'unknown',
        message: 'COMMENT_SUBMISSION_UNCONFIRMED',
      },
    });
    document.defaultView?.history.replaceState({}, '', '/');
  });
});
