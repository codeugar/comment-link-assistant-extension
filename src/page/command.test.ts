import { describe, expect, it } from 'vitest';
import { isPageCommand, runPageCommand } from './command';

describe('page command validation', () => {
  it('reveals a hidden comment form only through an observed candidate ID', async () => {
    document.body.innerHTML = `
      <button id="reveal" type="button">Escribe una respuesta</button>
      <div id="slot"></div>
    `;
    document.querySelector('#reveal')?.addEventListener('click', () => {
      const slot = document.querySelector('#slot');
      if (slot) slot.innerHTML = '<textarea name="comment"></textarea>';
    });
    const analyzed = await runPageCommand(document, { type: 'analyze' });
    expect(analyzed.type).toBe('analysis');
    if (analyzed.type !== 'analysis') return;
    const candidate = analyzed.analysis.probe?.controlCandidates.find(
      (control) => control.attributes.id === 'reveal'
    );
    expect(candidate).toBeTruthy();

    await expect(
      runPageCommand(document, {
        type: 'form.reveal',
        snapshotId: analyzed.analysis.probe?.snapshotId ?? '',
        candidateId: candidate?.candidateId ?? '',
      })
    ).resolves.toEqual({ type: 'form.reveal', clicked: true });
    expect(document.querySelector('textarea')).toBeTruthy();
  });

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

  it('rejects a form plan that violates the shared strict schema', () => {
    expect(
      isPageCommand({
        type: 'submit.prepare',
        input: { comment: 'Useful comment', websiteUrl: '' },
        expected: {
          url: 'https://blog.example/post',
          editorLabel: 'Komentar',
          submitLabel: 'Potvrdi',
          hasWebsiteField: false,
          formPlan: {
            schemaVersion: 1,
            snapshotId: 'snapshot-1',
            decision: 'commentable',
            formCandidateId: 'form-1',
            bindings: {
              comment: 'control-1',
              selector: '#comment',
            },
            submitCandidateId: 'control-2',
            requiredRoles: ['comment'],
            uncertainties: [],
          },
        },
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
        status: 'unknown',
        verificationObservation: {
          feedbackMessages: ['Vaš komentar je primljen.'],
        },
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
    if (result.type === 'submission') {
      expect(result.result.verificationObservation).toBeUndefined();
    }
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
