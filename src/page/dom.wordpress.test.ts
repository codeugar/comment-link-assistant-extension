import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPageCommand } from './command';
import {
  analyzePageDocument,
  clickPreparedSubmissionDocument,
  prepareSubmissionDocument,
  verifySubmissionDocument,
} from './dom';

describe('WordPress-native recognition', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
    document.head.innerHTML = '';
    document.title = 'WordPress article';
    document.body.innerHTML = '';
  });

  it.each([
    ['Spanish', 'Publicar el comentario'],
    ['Swedish', 'Skicka kommentar'],
  ])(
    'recognizes, prepares, and binds a %s WordPress comment form by canonical ids',
    async (_language, submitValue) => {
      document.body.innerHTML = `
        <article><h1>Guía</h1><p>Long-form article copy about testing web forms in detail.</p></article>
        <div id="respond" class="comment-respond">
          <form action="/wp-comments-post.php" method="post" id="commentform" class="comment-form">
            <p class="comment-form-comment"><label for="comment">Comentario</label>
              <textarea id="comment" name="comment"></textarea></p>
            <p class="comment-form-author"><label for="author">Nombre</label>
              <input id="author" name="author" type="text"></p>
            <p class="comment-form-email"><label for="email">Correo</label>
              <input id="email" name="email" type="email"></p>
            <p class="comment-form-url"><label for="url">Web</label>
              <input id="url" name="url" type="url"></p>
            <p class="form-submit">
              <input name="submit" type="submit" id="submit" class="submit" value="${submitValue}"></p>
          </form>
        </div>
      `;
      let submitted = false;
      document
        .querySelector('#commentform')
        ?.addEventListener('submit', (event) => {
          event.preventDefault();
          submitted = true;
        });

      const analysis = await analyzePageDocument(document);
      expect(analysis.form).toMatchObject({
        readiness: 'ready',
        submitLabel: expect.stringContaining(submitValue),
        hasNameField: true,
        hasEmailField: true,
        hasWebsiteField: true,
      });

      const preparation = await prepareSubmissionDocument(document, {
        comment: 'A genuinely useful comment about the article.',
        displayName: 'Seed Audio',
        email: 'support@example.com',
        websiteUrl: 'https://example.com',
      });
      expect(preparation.ok).toBe(true);
      if (!preparation.ok) return;

      expect(
        (document.querySelector('#comment') as HTMLTextAreaElement).value
      ).toContain('genuinely useful');
      expect((document.querySelector('#url') as HTMLInputElement).value).toBe(
        'https://example.com'
      );

      const result = await clickPreparedSubmissionDocument(
        document,
        preparation.prepared,
        0
      );
      expect(submitted).toBe(true);
      expect(result.clickOccurred).toBe(true);
    }
  );

  it('recognizes, prepares, and binds the Jetpack in-frame comment form', async () => {
    // The document served inside the jetpack.wordpress.com/jetpack-comment/
    // frame is a WordPress comment form that POSTs to jetpack.wordpress.com and
    // whose submit carries name="submit" but id="comment-submit" (not #submit).
    document.body.innerHTML = `
      <form
        action="https://jetpack.wordpress.com/jetpack-comment/"
        method="post"
        id="commentform"
        class="comment-form">
        <textarea id="comment" name="comment"></textarea>
        <input id="author" name="author" type="text">
        <input id="email" name="email" type="email">
        <input id="url" name="url" type="url">
        <input name="submit" type="submit" id="comment-submit" value="Post Comment">
      </form>
    `;
    let submitted = false;
    document
      .querySelector('#commentform')
      ?.addEventListener('submit', (event) => {
        event.preventDefault();
        submitted = true;
      });

    const analysis = await analyzePageDocument(document);
    expect(analysis.form).toMatchObject({
      readiness: 'ready',
      hasNameField: true,
      hasEmailField: true,
      hasWebsiteField: true,
    });
    // The in-frame document must not classify itself as a Jetpack frame target.
    expect(analysis.form.frame).toBeUndefined();

    const preparation = await prepareSubmissionDocument(document, {
      comment: 'A genuinely useful comment about the article.',
      displayName: 'Seed Audio',
      email: 'support@example.com',
      websiteUrl: 'https://example.com',
    });
    expect(preparation.ok).toBe(true);
    if (!preparation.ok) return;

    const result = await clickPreparedSubmissionDocument(
      document,
      preparation.prepared,
      0
    );
    expect(submitted).toBe(true);
    expect(result.clickOccurred).toBe(true);
  });

  it('skips a hidden name="comment" honeypot decoy and binds the visible #comment editor', async () => {
    document.body.innerHTML = `
      <article><p>Long-form article copy about testing web forms in detail.</p></article>
      <form id="commentform" action="/wp-comments-post.php" method="post">
        <textarea name="comment" aria-hidden="true" style="position: absolute; left: -9999px"></textarea>
        <textarea id="comment" name="ak_hp_comment"></textarea>
        <input name="submit" type="submit" id="submit" value="Post Comment">
      </form>
    `;

    expect((await analyzePageDocument(document)).form.readiness).toBe('ready');

    const preparation = await prepareSubmissionDocument(document, {
      comment: 'A genuinely useful comment.',
      websiteUrl: '',
    });
    expect(preparation.ok).toBe(true);

    const real = document.querySelector('#comment') as HTMLTextAreaElement;
    const decoy = document.querySelector(
      'textarea[name="comment"]'
    ) as HTMLTextAreaElement;
    expect(real.value).toContain('genuinely useful');
    expect(decoy.value).toBe('');
  });

  it('recognizes a WordPress form by its wp-comments-post.php action without a commentform id', async () => {
    document.body.innerHTML = `
      <article><p>Article copy about the topic in enough detail to analyze.</p></article>
      <form action="/wp-comments-post.php" method="post" class="comment-form">
        <textarea id="comment" name="comment"></textarea>
        <input name="submit" type="submit" id="submit" value="Kommentar absenden">
      </form>
    `;

    expect((await analyzePageDocument(document)).form.readiness).toBe('ready');
  });

  it('recognizes a WordPress form inside a comment-respond wrapper without a native form', async () => {
    document.body.innerHTML = `
      <article><p>Article copy about the topic in enough detail to analyze.</p></article>
      <div class="comment-respond">
        <textarea id="comment" name="comment"></textarea>
        <input name="submit" type="submit" id="submit" value="Enviar">
      </div>
    `;

    expect((await analyzePageDocument(document)).form.readiness).toBe('ready');
  });

  it('keeps a WordPress comment form behind a login gate as login_required', async () => {
    document.body.innerHTML = `
      <article><p>Article copy about the topic in enough detail to analyze.</p></article>
      <p>You must be logged in to post a comment.</p>
      <form id="commentform" action="/wp-comments-post.php">
        <textarea id="comment" name="comment"></textarea>
        <input name="submit" type="submit" id="submit" value="Enviar comentario">
      </form>
    `;

    expect((await analyzePageDocument(document)).form.readiness).toBe(
      'login_required'
    );
  });

  it('keeps a WordPress comment form showing a captcha as captcha_required', async () => {
    document.body.innerHTML = `
      <article><p>Article copy about the topic in enough detail to analyze.</p></article>
      <form id="commentform" action="/wp-comments-post.php">
        <textarea id="comment" name="comment"></textarea>
        <div class="cf-turnstile"></div>
        <input name="submit" type="submit" id="submit" value="Enviar comentario">
      </form>
    `;

    expect((await analyzePageDocument(document)).form.readiness).toBe(
      'captcha_required'
    );
  });

  it('leaves a non-WordPress form with a foreign submit to the generic recognizer', async () => {
    // No WordPress markers: the canonical-id acceptance must NOT apply, so the
    // foreign submit label falls back to the (failing) generic whitelist.
    document.body.innerHTML = `
      <article><p>Article copy about the topic in enough detail to analyze.</p></article>
      <form>
        <textarea name="comment"></textarea>
        <input name="submit" type="submit" id="submit" value="Publicar el comentario">
      </form>
    `;

    expect((await analyzePageDocument(document)).form.readiness).toBe(
      'not_found'
    );
  });
});

describe('WordPress submit-receipt confirmation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.defaultView?.history.replaceState({}, '', '/');
  });

  it('confirms an unapproved/moderation-hash receipt as held for moderation', () => {
    document.defaultView?.history.replaceState(
      {},
      '',
      '/article?unapproved=51&moderation-hash=deadbeef'
    );
    document.body.innerHTML =
      '<article>The article body with no explicit status copy.</article>';

    const result = verifySubmissionDocument(document, 'A useful point', {
      feedbackMessages: [],
      renderedComment: false,
    });

    expect(result).toMatchObject({
      status: 'submitted',
      message: 'COMMENT_SUBMITTED',
      clickOccurred: true,
    });
  });

  it('rejects a WordPress duplicate-comment page as a validation error', () => {
    document.body.innerHTML =
      '<div id="error-page"><p>Duplicate comment detected; it looks as though you’ve already said that!</p></div>';

    const result = verifySubmissionDocument(document, 'A useful point', {
      feedbackMessages: [],
      renderedComment: false,
    });

    expect(result).toMatchObject({
      status: 'validation_error',
      message: 'COMMENT_DUPLICATE',
      clickOccurred: true,
    });
  });

  it('confirms a fresh #comment-<id> permalink receipt through the page command', async () => {
    const origin = document.location.origin;
    document.defaultView?.history.replaceState(
      {},
      '',
      '/article#comment-88213'
    );
    document.body.innerHTML =
      '<article>Rendered article without explicit status copy.</article>';

    const result = await runPageCommand(document, {
      type: 'verify',
      fingerprint: 'A useful point',
      baseline: { feedbackMessages: [], renderedComment: false },
      expectedUrl: `${origin}/article`,
    });

    expect(result).toMatchObject({
      type: 'submission',
      result: {
        status: 'submitted',
        message: 'COMMENT_SUBMITTED',
      },
    });
  });
});
