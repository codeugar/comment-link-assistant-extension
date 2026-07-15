import type { FormPlan } from '@/api/form-planner';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPageCommand } from './command';
import {
  analyzePageDocument,
  clickPreparedSubmissionDocument,
  fillAndSubmitDocument,
  prepareSubmissionDocument,
  revealPlannedCommentFormDocument,
  verifySubmissionDocument,
} from './dom';
import { probePageDocument } from './probe';

describe('comment page DOM helpers', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
    document.head.innerHTML =
      '<meta name="description" content="A practical article about testing web forms.">';
    document.title = 'Useful testing guide';
    document.body.innerHTML = '';
  });

  it('finds a WordPress-style comment form and its optional backlink fields', () => {
    document.body.innerHTML = `
      <article><h1>Useful testing guide</h1><p>Long-form article copy.</p></article>
      <form id="commentform">
        <textarea id="comment" name="comment" placeholder="Leave a comment"></textarea>
        <input name="author" placeholder="Name">
        <input type="email" name="email">
        <input type="url" name="url">
        <button type="submit">Post comment</button>
      </form>
    `;

    const analysis = analyzePageDocument(document);

    expect(analysis.form).toMatchObject({
      readiness: 'ready',
      hasNameField: true,
      hasEmailField: true,
      hasWebsiteField: true,
    });
    expect(analysis.page).toMatchObject({
      title: 'Useful testing guide',
      description: 'A practical article about testing web forms.',
      language: 'en',
      hasWebsiteField: true,
    });
  });

  it('clicks an AI-selected localized control to reveal the comment form', () => {
    document.body.innerHTML = `
      <article><p>Long-form article copy.</p></article>
      <button id="reveal" type="button">Escribe una respuesta</button>
      <section id="slot"></section>
    `;
    document.querySelector('#reveal')?.addEventListener('click', () => {
      const slot = document.querySelector('#slot');
      if (slot) {
        slot.innerHTML = `
          <form id="commentform">
            <textarea name="comment"></textarea>
            <button type="submit">Post comment</button>
          </form>
        `;
      }
    });
    const probe = probePageDocument(document);
    const reveal = probe.controlCandidates.find(
      (candidate) => candidate.attributes.id === 'reveal'
    );

    expect(reveal).toBeTruthy();
    expect(
      revealPlannedCommentFormDocument(
        document,
        probe.snapshotId,
        reveal?.candidateId ?? ''
      )
    ).toBe(true);
    expect(analyzePageDocument(document).form.readiness).toBe('ready');
  });

  it('refuses an AI-selected link that navigates away from the article', () => {
    document.body.innerHTML = `
      <article><p>Long-form article copy.</p></article>
      <a id="unsafe-reveal" href="https://other.example/comments">Open</a>
    `;
    const probe = probePageDocument(document);
    const reveal = probe.controlCandidates.find(
      (candidate) => candidate.attributes.id === 'unsafe-reveal'
    );

    expect(reveal).toBeTruthy();
    expect(
      revealPlannedCommentFormDocument(
        document,
        probe.snapshotId,
        reveal?.candidateId ?? ''
      )
    ).toBe(false);
  });

  it('refuses an AI-selected submit button associated with an external form', () => {
    document.body.innerHTML = `
      <form id="newsletter"><input name="email"></form>
      <button id="unsafe-submit" type="submit" form="newsletter">Open</button>
    `;
    const probe = probePageDocument(document);
    const reveal = probe.controlCandidates.find(
      (candidate) => candidate.attributes.id === 'unsafe-submit'
    );

    expect(reveal).toBeTruthy();
    expect(
      revealPlannedCommentFormDocument(
        document,
        probe.snapshotId,
        reveal?.candidateId ?? ''
      )
    ).toBe(false);
  });

  it('refuses an AI-selected destructive JavaScript button', () => {
    document.body.innerHTML = `
      <button id="unsafe-delete" type="button">Delete account</button>
    `;
    const probe = probePageDocument(document);
    const reveal = probe.controlCandidates.find(
      (candidate) => candidate.attributes.id === 'unsafe-delete'
    );

    expect(reveal).toBeTruthy();
    expect(
      revealPlannedCommentFormDocument(
        document,
        probe.snapshotId,
        reveal?.candidateId ?? ''
      )
    ).toBe(false);
  });

  it('recognizes a localized comment form with a structural submit control', () => {
    document.body.innerHTML = `
      <form>
        <input name="name">
        <input name="email">
        <input name="website">
        <textarea name="comment"></textarea>
        <button type="button" class="comment-submit">Potvrdi</button>
      </form>
    `;

    expect(analyzePageDocument(document).form).toMatchObject({
      readiness: 'ready',
      hasNameField: true,
      hasEmailField: true,
      hasWebsiteField: true,
    });
  });

  it('trusts explicit comment controls even when the theme uses checkout classes', () => {
    document.body.innerHTML = `
      <form class="checkout-form">
        <input name="author">
        <input name="email">
        <textarea name="comment" placeholder="Enter your comment"></textarea>
        <button type="submit" class="checkout-form__btn">Submit Comment</button>
      </form>
    `;

    expect(analyzePageDocument(document).form).toMatchObject({
      readiness: 'ready',
      message: 'COMMENT_FORM_READY',
      hasNameField: true,
      hasEmailField: true,
    });
  });

  it('rejects explicit comment controls inside a real checkout form', () => {
    document.body.innerHTML = `
      <form action="/checkout/payment">
        <h2>Checkout payment</h2>
        <textarea name="comment" placeholder="Enter your comment"></textarea>
        <button type="submit">Submit Comment</button>
      </form>
    `;

    expect(analyzePageDocument(document).form).toMatchObject({
      readiness: 'not_found',
      message: 'COMMENT_FORM_NOT_FOUND',
    });
  });

  it.each([
    ['destructive id', 'id="delete-account"'],
    ['transactional class', 'class="checkout-form payment-form"'],
  ])(
    'never submits explicit comment controls inside a %s',
    async (_, formAttribute) => {
      document.body.innerHTML = `
      <form ${formAttribute}>
        <textarea name="comment" placeholder="Enter your comment"></textarea>
        <button type="submit">Submit Comment</button>
      </form>
    `;
      let submitted = false;
      document.querySelector('form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        submitted = true;
      });

      expect(analyzePageDocument(document).form.readiness).toBe('not_found');
      await expect(
        fillAndSubmitDocument(
          document,
          { comment: 'This must not be submitted here.', websiteUrl: '' },
          0
        )
      ).resolves.toMatchObject({
        status: 'validation_error',
        clickOccurred: false,
      });
      expect(submitted).toBe(false);
    }
  );

  it('finds and submits a comment form inside a same-origin iframe', async () => {
    document.body.innerHTML =
      '<article><p>A practical article about embedded discussions.</p></article><iframe></iframe>';
    const frame = document.querySelector('iframe');
    const frameDocument = frame?.contentDocument;
    expect(frameDocument).toBeTruthy();
    if (!frameDocument) return;
    frameDocument.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment" placeholder="Leave a comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    frameDocument.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const notice = frameDocument.createElement('p');
      notice.setAttribute('role', 'alert');
      notice.textContent = 'Your comment was submitted.';
      frameDocument.body.append(notice);
    });

    expect(analyzePageDocument(document).form.readiness).toBe('ready');
    await expect(
      fillAndSubmitDocument(
        document,
        {
          comment: 'The embedded discussion adds useful context.',
          websiteUrl: '',
        },
        0
      )
    ).resolves.toMatchObject({ status: 'submitted_not_visible' });
  });

  it('does not select a comment form inside a hidden iframe', () => {
    document.body.innerHTML = '<iframe style="display: none"></iframe>';
    const frameDocument = document.querySelector('iframe')?.contentDocument;
    expect(frameDocument).toBeTruthy();
    if (!frameDocument) return;
    frameDocument.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment" placeholder="Leave a comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;

    expect(analyzePageDocument(document).form.readiness).toBe('not_found');
  });

  it('reports a known cross-origin comment widget explicitly', () => {
    document.body.innerHTML = `
      <article><p>An article with an embedded discussion.</p></article>
      <iframe title="Comments" src="about:blank"></iframe>
    `;
    const frame = document.querySelector('iframe');
    expect(frame).toBeTruthy();
    if (!frame) return;
    const originalGetAttribute = frame.getAttribute.bind(frame);
    const getAttribute = vi
      .spyOn(frame, 'getAttribute')
      .mockImplementation((name) =>
        name === 'src'
          ? 'https://comments.example/embed/discussion'
          : originalGetAttribute(name)
      );
    try {
      expect(analyzePageDocument(document).form).toMatchObject({
        readiness: 'not_found',
        message: 'CROSS_ORIGIN_COMMENT_FRAME_UNSUPPORTED',
      });
    } finally {
      getAttribute.mockRestore();
    }
  });

  it('does not mistake a search box for a comment editor', () => {
    document.body.innerHTML = `
      <form class="site-search">
        <textarea name="search-query" placeholder="Search"></textarea>
        <button type="submit">Search</button>
      </form>
    `;

    expect(analyzePageDocument(document).form.readiness).toBe('not_found');
  });

  it('does not mistake a generic contact message form for a comment form', () => {
    document.body.innerHTML = `
      <form class="contact-form">
        <textarea name="message"></textarea>
        <button type="submit">Send</button>
      </form>
    `;

    expect(analyzePageDocument(document).form.readiness).toBe('not_found');
  });

  it.each([
    {
      label: 'report form',
      markup: `
        <form class="comment-form" action="/report">
          <h2>Report comment</h2>
          <textarea name="reason"></textarea>
          <button type="submit">Send</button>
        </form>
      `,
    },
    {
      label: 'order form',
      markup: `
        <form id="order-comments" action="/checkout">
          <textarea placeholder="Order comments"></textarea>
          <button type="submit">Submit</button>
        </form>
      `,
    },
  ])('never submits an unrelated $label', async ({ markup }) => {
    document.body.innerHTML = markup;
    let submitted = false;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted = true;
    });

    expect(analyzePageDocument(document).form.readiness).toBe('not_found');
    const result = await fillAndSubmitDocument(
      document,
      { comment: 'This must not be submitted here.', websiteUrl: '' },
      0
    );
    expect(result).toMatchObject({
      status: 'validation_error',
      clickOccurred: false,
    });
    expect(submitted).toBe(false);
  });

  it('does not treat an ambiguous survey comments field as publishable', async () => {
    document.body.innerHTML = `
      <section id="survey-response">
        <form>
          <textarea name="comments"></textarea>
          <button type="submit">Submit</button>
        </form>
      </section>
    `;
    let submitted = false;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted = true;
    });

    expect(analyzePageDocument(document).form.readiness).toBe('not_found');
    const result = await fillAndSubmitDocument(
      document,
      {
        comment: 'This must not be posted to a survey.',
        websiteUrl: 'https://example.com',
      },
      0
    );
    expect(result.status).toBe('validation_error');
    expect(submitted).toBe(false);
  });

  it('does not report a comment editor as ready without a submit control', () => {
    document.body.innerHTML = `
      <section class="comment-editor">
        <textarea name="comment" placeholder="Leave a comment"></textarea>
      </section>
    `;

    expect(analyzePageDocument(document).form).toMatchObject({
      readiness: 'not_found',
      message: 'SUBMIT_BUTTON_NOT_FOUND',
    });
  });

  it('finds a rendered comment form below the initial viewport', () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment" placeholder="Leave a comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    const form = document.querySelector('form');
    const editor = document.querySelector('textarea');
    const submit = document.querySelector('button');
    const belowFold = {
      x: 0,
      y: 5_000,
      top: 5_000,
      left: 0,
      right: 600,
      bottom: 5_300,
      width: 600,
      height: 300,
      toJSON: () => ({}),
    };
    for (const element of [form, editor, submit]) {
      if (element) element.getBoundingClientRect = () => belowFold;
    }

    expect(analyzePageDocument(document).form.readiness).toBe('ready');
  });

  it('reports login and CAPTCHA gates without attempting submission', () => {
    document.body.innerHTML = '<p>You must be logged in to comment.</p>';
    expect(analyzePageDocument(document).form.readiness).toBe('login_required');

    document.body.innerHTML = `
      <form class="comment-form">
        <textarea name="comment"></textarea>
        <div class="cf-turnstile"></div>
        <button type="submit">Submit comment</button>
      </form>
    `;
    expect(analyzePageDocument(document).form.readiness).toBe(
      'captcha_required'
    );
  });

  it.each(['Sign up to comment', 'Create an account to reply', '注册后评论'])(
    'recognizes the text-only auth gate "%s"',
    (copy) => {
      document.body.textContent = copy;
      expect(analyzePageDocument(document).form.readiness).toBe(
        'login_required'
      );
    }
  );

  it('recognizes a generic sign-in form as a login gate', () => {
    document.body.innerHTML = `
      <form action="/account/session">
        <input type="email" name="email">
        <input type="password" name="password">
        <button type="submit">Sign in</button>
      </form>
    `;

    expect(analyzePageDocument(document).form).toMatchObject({
      readiness: 'login_required',
      message: 'LOGIN_REQUIRED',
    });
  });

  it('recognizes a Traditional Chinese join action as a login gate', () => {
    document.body.innerHTML = `
      <form>
        <input type="email" name="email">
        <input type="password" name="password">
        <button type="submit">立即加入</button>
      </form>
    `;

    expect(analyzePageDocument(document).form).toMatchObject({
      readiness: 'login_required',
    });
  });

  it('reports a visible CAPTCHA challenge even before an editor is rendered', () => {
    document.body.innerHTML = `
      <article><p>The article remains visible.</p></article>
      <div class="cf-turnstile"></div>
    `;

    expect(analyzePageDocument(document).form).toMatchObject({
      readiness: 'captcha_required',
      message: 'CAPTCHA_REQUIRED',
    });
  });

  it('fills the editor before requiring a submit button to become enabled', async () => {
    document.body.innerHTML = `
      <form class="comment-form">
        <textarea name="comment" placeholder="Leave a comment"></textarea>
        <button type="submit" disabled>Post comment</button>
      </form>
    `;
    const editor = document.querySelector('textarea');
    const submit = document.querySelector('button');
    editor?.addEventListener('input', () => {
      if (submit instanceof HTMLButtonElement) submit.disabled = false;
    });
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const notice = document.createElement('p');
      notice.setAttribute('role', 'alert');
      notice.textContent = 'Your comment was submitted.';
      document.body.append(notice);
    });

    expect(analyzePageDocument(document).form.readiness).toBe('ready');
    await expect(
      fillAndSubmitDocument(
        document,
        {
          comment: 'The state transition example is especially useful.',
          websiteUrl: 'https://example.com',
        },
        0
      )
    ).resolves.toMatchObject({ status: 'submitted_not_visible' });
  });

  it('marks an accepted comment as not visible when the page only shows a success message', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <input name="author">
        <input type="email" name="email">
        <input type="url" name="website">
        <button type="submit">Post comment</button>
      </form>
    `;
    const form = document.querySelector('form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const notice = document.createElement('p');
      notice.setAttribute('role', 'alert');
      notice.textContent = 'Your comment was submitted.';
      document.body.append(notice);
    });

    const result = await fillAndSubmitDocument(
      document,
      {
        comment: 'This testing approach is especially useful for form states.',
        displayName: 'Alex',
        email: 'alex@example.com',
        websiteUrl: 'https://example.com',
      },
      0
    );

    expect(result).toMatchObject({
      status: 'submitted_not_visible',
      message: 'COMMENT_SUBMITTED_NOT_VISIBLE',
    });
    expect(
      (document.querySelector('textarea') as HTMLTextAreaElement).value
    ).toContain('testing approach');
    expect(
      (document.querySelector('input[name="author"]') as HTMLInputElement).value
    ).toBe('Alex');
    expect(
      (document.querySelector('input[name="website"]') as HTMLInputElement)
        .value
    ).toBe('https://example.com');
  });

  it('marks a comment as immediately published only when it is rendered on the page', async () => {
    const comment = 'The state-machine example makes the tradeoff clear.';
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const editor = document.querySelector('textarea');
      if (editor instanceof HTMLTextAreaElement) editor.value = '';
      const rendered = document.createElement('article');
      rendered.className = 'comment-body';
      rendered.textContent = comment;
      document.body.append(rendered);
      const notice = document.createElement('p');
      notice.setAttribute('role', 'alert');
      notice.textContent = 'Your comment was published.';
      document.body.append(notice);
    });

    await expect(
      fillAndSubmitDocument(document, { comment, websiteUrl: '' }, 0)
    ).resolves.toMatchObject({
      status: 'published',
      message: 'COMMENT_PUBLISHED',
    });
  });

  it('never selects a destructive comment action as the submit control', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment" placeholder="Leave a comment"></textarea>
        <button id="danger" type="submit">Delete comment</button>
        <button id="post" type="submit">Post comment</button>
      </form>
    `;
    let destructiveClicks = 0;
    let postClicks = 0;
    document.querySelector('#danger')?.addEventListener('click', (event) => {
      event.preventDefault();
      destructiveClicks += 1;
    });
    document.querySelector('#post')?.addEventListener('click', (event) => {
      event.preventDefault();
      postClicks += 1;
      const notice = document.createElement('p');
      notice.setAttribute('role', 'alert');
      notice.textContent = 'Your comment was submitted.';
      document.body.append(notice);
    });

    const result = await fillAndSubmitDocument(
      document,
      { comment: 'A useful comment.', websiteUrl: '' },
      0
    );

    expect(result.status).toBe('submitted_not_visible');
    expect(destructiveClicks).toBe(0);
    expect(postClicks).toBe(1);
  });

  it.each(['Like comment', 'View reply', '查看回复'])(
    'never selects the social action "%s" as submit',
    async (label) => {
      document.body.innerHTML = `
        <form id="commentform">
          <textarea name="comment" placeholder="Leave a comment"></textarea>
          <button id="social" type="submit">${label}</button>
          <button id="post" type="submit">Post comment</button>
        </form>
      `;
      let socialClicks = 0;
      let postClicks = 0;
      document.querySelector('#social')?.addEventListener('click', (event) => {
        event.preventDefault();
        socialClicks += 1;
      });
      document.querySelector('#post')?.addEventListener('click', (event) => {
        event.preventDefault();
        postClicks += 1;
        const notice = document.createElement('p');
        notice.setAttribute('role', 'alert');
        notice.textContent = 'Your comment was submitted.';
        document.body.append(notice);
      });

      const result = await fillAndSubmitDocument(
        document,
        { comment: 'A useful comment.', websiteUrl: '' },
        0
      );

      expect(result.status).toBe('submitted_not_visible');
      expect(socialClicks).toBe(0);
      expect(postClicks).toBe(1);
    }
  );

  it('does not use hidden button text to authorize a submit action', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment" placeholder="Leave a comment"></textarea>
        <button id="continue" type="submit">
          Continue <span aria-hidden="true">Post comment</span>
        </button>
      </form>
    `;
    let clicks = 0;
    document.querySelector('#continue')?.addEventListener('click', (event) => {
      event.preventDefault();
      clicks += 1;
    });

    const result = await fillAndSubmitDocument(
      document,
      { comment: 'This must not be submitted.', websiteUrl: '' },
      0
    );

    expect(result).toMatchObject({
      status: 'validation_error',
      clickOccurred: false,
    });
    expect(clicks).toBe(0);
  });

  it.each(['Log in to comment', 'Sign-up to comment', '注册后评论'])(
    'treats the auth control "%s" inside a comment form as a gate, not submit',
    async (label) => {
      document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment" placeholder="Leave a comment"></textarea>
        <button id="login" type="submit">${label}</button>
      </form>
    `;
      let loginClicks = 0;
      document.querySelector('#login')?.addEventListener('click', (event) => {
        event.preventDefault();
        loginClicks += 1;
      });

      expect(analyzePageDocument(document).form.readiness).toBe(
        'login_required'
      );
      await expect(
        fillAndSubmitDocument(
          document,
          { comment: 'This must wait for login.', websiteUrl: '' },
          0
        )
      ).resolves.toMatchObject({
        status: 'login_required',
        clickOccurred: false,
      });
      expect(loginClicks).toBe(0);
    }
  );

  it('clears browser-autofilled identity fields when identity settings are empty', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <input name="author" value="Autofilled Person">
        <input type="email" name="email" value="autofilled@example.com">
        <button type="submit">Post comment</button>
      </form>
    `;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const notice = document.createElement('p');
      notice.setAttribute('role', 'alert');
      notice.textContent = 'Your comment was submitted.';
      document.body.append(notice);
    });

    const result = await fillAndSubmitDocument(
      document,
      { comment: 'A useful comment.', websiteUrl: '' },
      0
    );

    expect(result.status).toBe('submitted_not_visible');
    expect(
      (document.querySelector('input[name="author"]') as HTMLInputElement).value
    ).toBe('');
    expect(
      (document.querySelector('input[name="email"]') as HTMLInputElement).value
    ).toBe('');
  });

  it.each([
    ['<input name="author" required>', 'DISPLAY_NAME_REQUIRED'],
    [
      '<input type="email" name="email" aria-required="true">',
      'EMAIL_REQUIRED',
    ],
  ] as const)(
    'refuses to click when a required identity setting is missing',
    async (identityMarkup, expectedMessage) => {
      document.body.innerHTML = `
        <form id="commentform">
          <textarea name="comment"></textarea>
          ${identityMarkup}
          <button type="submit">Post comment</button>
        </form>
      `;
      let submitted = false;
      document.querySelector('form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        submitted = true;
      });

      const result = await fillAndSubmitDocument(
        document,
        { comment: 'A useful comment.', websiteUrl: '' },
        0
      );

      expect(result).toMatchObject({
        status: 'validation_error',
        message: expectedMessage,
      });
      expect(submitted).toBe(false);
    }
  );

  it('recognizes required identity fields declared by their form-group ancestors', async () => {
    document.body.innerHTML = `
      <form class="form-horizontal">
        <div class="form-group required">
          <label for="input-name">Vaše ime</label>
          <input type="text" name="name" id="input-name">
        </div>
        <div class="form-group required">
          <label for="input-email">E-Mail:</label>
          <input type="text" name="email" id="input-email">
        </div>
        <div class="form-group">
          <label for="input-website">Web sajt:</label>
          <input type="text" name="website" id="input-website">
        </div>
        <div class="form-group required">
          <label for="input-comment">Komentar</label>
          <textarea name="comment" id="input-comment"></textarea>
        </div>
        <button type="button" class="comment-submit">Potvrdi</button>
      </form>
    `;
    let submitted = false;
    document.querySelector('button')?.addEventListener('click', () => {
      submitted = true;
    });

    const missingName = await fillAndSubmitDocument(
      document,
      {
        comment: 'Zanimljiv članak.',
        email: 'reader@example.com',
        websiteUrl: 'https://example.com',
      },
      0
    );

    expect(missingName).toMatchObject({
      status: 'validation_error',
      message: 'DISPLAY_NAME_REQUIRED',
      clickOccurred: false,
    });
    expect(submitted).toBe(false);
  });

  it('uses a bounded semantic plan to fill and click a localized opaque form', async () => {
    document.body.innerHTML = `
      <form class="vcard">
        <div class="required"><label>Vaše ime *</label><input name="vName"></div>
        <div class="required"><label>E-Mail *</label><input name="vEmail"></div>
        <label>Web sajt</label><input name="vSite">
        <div class="required"><label>Komentar *</label><textarea name="vText"></textarea></div>
        <button type="button">Potvrdi</button>
      </form>
    `;
    const snapshot = probePageDocument(document);
    const candidate = (name: string) =>
      snapshot.controlCandidates.find(
        (control) => control.attributes.name === name
      )?.candidateId ?? '';
    const submitCandidateId =
      snapshot.controlCandidates.find((control) => control.tag === 'button')
        ?.candidateId ?? '';
    const formCandidateId = snapshot.formCandidates[0]?.formId ?? null;
    const expected = {
      url: document.location.href,
      editorLabel: '',
      submitLabel: '',
      hasWebsiteField: true,
      formPlan: {
        schemaVersion: 1 as const,
        snapshotId: snapshot.snapshotId,
        decision: 'commentable' as const,
        formCandidateId,
        bindings: {
          comment: candidate('vText'),
          name: candidate('vName'),
          email: candidate('vEmail'),
          website: candidate('vSite'),
        },
        submitCandidateId,
        requiredRoles: ['comment', 'name', 'email'],
        uncertainties: [],
      } as FormPlan,
    };
    let submitted = false;
    document.querySelector('button')?.addEventListener('click', () => {
      submitted = true;
    });

    const preparation = await prepareSubmissionDocument(
      document,
      {
        comment: 'Zanimljiv članak.',
        displayName: 'WesLin',
        email: 'reader@example.com',
        websiteUrl: 'https://seed-audio1.com',
      },
      expected
    );

    expect(preparation.ok).toBe(true);
    expect(submitted).toBe(false);
    expect(
      (document.querySelector('[name="vName"]') as HTMLInputElement).value
    ).toBe('WesLin');
    expect(
      (document.querySelector('[name="vEmail"]') as HTMLInputElement).value
    ).toBe('reader@example.com');
    if (!preparation.ok) return;

    await expect(
      clickPreparedSubmissionDocument(document, preparation.prepared, 0)
    ).resolves.toMatchObject({ clickOccurred: true });
    expect(submitted).toBe(true);
  });

  it('does not mistake a mapped email identity field for a non-comment form', async () => {
    document.body.innerHTML = `
      <section class="comment-region">
        <input id="input-name" name="name">
        <input id="input-email" name="email">
        <input id="input-website" name="website">
        <textarea id="input-comment" name="comment"></textarea>
        <button type="button" class="comment-submit">Potvrdi</button>
      </section>
    `;
    const snapshot = probePageDocument(document);
    const candidate = (name: string) =>
      snapshot.controlCandidates.find(
        (control) => control.attributes.name === name
      )?.candidateId ?? '';
    const submit = snapshot.controlCandidates.find(
      (control) => control.attributes.class === 'comment-submit'
    );
    const commentRegion = snapshot.formCandidates.find(
      (candidate) => candidate.tag === 'region'
    );

    const preparation = await prepareSubmissionDocument(
      document,
      {
        comment: 'Zanimljiv članak.',
        displayName: 'Reader',
        email: 'reader@example.com',
        websiteUrl: 'https://example.com',
      },
      {
        url: document.location.href,
        editorLabel: 'comment',
        submitLabel: 'Potvrdi',
        hasWebsiteField: true,
        formPlan: {
          schemaVersion: 1,
          snapshotId: snapshot.snapshotId,
          decision: 'commentable',
          formCandidateId: commentRegion?.formId ?? null,
          bindings: {
            comment: candidate('comment'),
            name: candidate('name'),
            email: candidate('email'),
            website: candidate('website'),
          },
          submitCandidateId: submit?.candidateId ?? null,
          requiredRoles: ['comment', 'name', 'email'],
          uncertainties: [],
        },
      }
    );

    expect(preparation).toMatchObject({ ok: true });
    if (preparation.ok) {
      await clickPreparedSubmissionDocument(document, preparation.prepared, 0);
    }
  });

  it('rejects a form-less plan that binds a distant page button', async () => {
    document.body.innerHTML = `
      <section id="comment-region">
        <textarea name="vText"></textarea>
      </section>
      <section id="account-actions">
        <button type="button">Potvrdi</button>
      </section>
    `;
    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (control) => control.attributes.name === 'vText'
    );
    const submit = snapshot.controlCandidates.find(
      (control) => control.tag === 'button'
    );
    let clicked = false;
    document.querySelector('button')?.addEventListener('click', () => {
      clicked = true;
    });

    const preparation = await prepareSubmissionDocument(
      document,
      { comment: 'Zanimljiv članak.', websiteUrl: '' },
      {
        url: document.location.href,
        editorLabel: '',
        submitLabel: '',
        hasWebsiteField: false,
        formPlan: {
          schemaVersion: 1,
          snapshotId: snapshot.snapshotId,
          decision: 'commentable',
          formCandidateId: null,
          bindings: { comment: comment?.candidateId ?? '' },
          submitCandidateId: submit?.candidateId ?? null,
          requiredRoles: ['comment'],
          uncertainties: [],
        },
      }
    );

    expect(preparation).toMatchObject({
      ok: false,
      result: {
        status: 'validation_error',
        message: 'PAGE_CHANGED_SINCE_GENERATION',
        clickOccurred: false,
      },
    });
    expect(clicked).toBe(false);
  });

  it('rejects a semantic plan after a selected live candidate is replaced', async () => {
    document.body.innerHTML = `
      <form>
        <textarea name="vText"></textarea>
        <button type="button">Potvrdi</button>
      </form>
    `;
    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (control) => control.tag === 'textarea'
    );
    const submit = snapshot.controlCandidates.find(
      (control) => control.tag === 'button'
    );
    document
      .querySelector('textarea')
      ?.replaceWith(document.querySelector('textarea')?.cloneNode(true) ?? '');

    await expect(
      prepareSubmissionDocument(
        document,
        { comment: 'Zanimljiv članak.', websiteUrl: '' },
        {
          url: document.location.href,
          editorLabel: '',
          submitLabel: '',
          hasWebsiteField: false,
          formPlan: {
            schemaVersion: 1,
            snapshotId: snapshot.snapshotId,
            decision: 'commentable',
            formCandidateId: snapshot.formCandidates[0]?.formId ?? null,
            bindings: { comment: comment?.candidateId ?? '' },
            submitCandidateId: submit?.candidateId ?? null,
            requiredRoles: ['comment'],
            uncertainties: [],
          },
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      result: {
        status: 'validation_error',
        message: 'PAGE_CHANGED_SINCE_GENERATION',
        clickOccurred: false,
      },
    });
  });

  it('never executes a destructive action selected by a semantic plan', async () => {
    document.body.innerHTML = `
      <form>
        <textarea name="vText"></textarea>
        <button type="button">Delete comment</button>
        <button type="button">Potvrdi</button>
      </form>
    `;
    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (control) => control.tag === 'textarea'
    );
    const destructive = snapshot.controlCandidates.find(
      (control) => control.tag === 'button'
    );
    let clicked = false;
    document.querySelector('button')?.addEventListener('click', () => {
      clicked = true;
    });

    await expect(
      prepareSubmissionDocument(
        document,
        { comment: 'A useful comment.', websiteUrl: '' },
        {
          url: document.location.href,
          editorLabel: '',
          submitLabel: '',
          hasWebsiteField: false,
          formPlan: {
            schemaVersion: 1,
            snapshotId: snapshot.snapshotId,
            decision: 'commentable',
            formCandidateId: snapshot.formCandidates[0]?.formId ?? null,
            bindings: { comment: comment?.candidateId ?? '' },
            submitCandidateId: destructive?.candidateId ?? null,
            requiredRoles: ['comment'],
            uncertainties: [],
          },
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      result: {
        status: 'validation_error',
        message: 'FORM_PLAN_UNSAFE_SUBMIT',
        clickOccurred: false,
      },
    });
    expect(clicked).toBe(false);
  });

  it('rejects a localized planned action inside a checkout form', async () => {
    document.body.innerHTML = `
      <form id="checkout" class="woocommerce-checkout" action="/place-order">
        <h2>Order notes</h2>
        <textarea name="order_comments"></textarea>
        <button type="button">Potvrdi</button>
      </form>
    `;
    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (control) => control.tag === 'textarea'
    );
    const submit = snapshot.controlCandidates.find(
      (control) => control.tag === 'button'
    );
    let clicked = false;
    document.querySelector('button')?.addEventListener('click', () => {
      clicked = true;
    });

    const result = await fillAndSubmitDocument(
      document,
      { comment: 'This is not an order note.', websiteUrl: '' },
      0,
      {
        url: document.location.href,
        editorLabel: '',
        submitLabel: '',
        hasWebsiteField: false,
        formPlan: {
          schemaVersion: 1,
          snapshotId: snapshot.snapshotId,
          decision: 'commentable',
          formCandidateId: snapshot.formCandidates[0]?.formId ?? null,
          bindings: { comment: comment?.candidateId ?? '' },
          submitCandidateId: submit?.candidateId ?? null,
          requiredRoles: ['comment'],
          uncertainties: [],
        },
      }
    );

    expect(result).toMatchObject({
      status: 'validation_error',
      message: 'FORM_PLAN_UNSAFE_SUBMIT',
      clickOccurred: false,
    });
    expect(clicked).toBe(false);
  });

  it('rejects a localized action whose form endpoint is destructive', async () => {
    document.body.innerHTML = `
      <form class="comment-form">
        <textarea name="comment"></textarea>
        <button type="submit" formaction="/comments/delete">Potvrdi</button>
      </form>
    `;
    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (control) => control.tag === 'textarea'
    );
    const submit = snapshot.controlCandidates.find(
      (control) => control.tag === 'button'
    );
    let clicked = false;
    document.querySelector('button')?.addEventListener('click', () => {
      clicked = true;
    });

    await expect(
      prepareSubmissionDocument(
        document,
        { comment: 'A useful comment.', websiteUrl: '' },
        {
          url: document.location.href,
          editorLabel: 'comment',
          submitLabel: 'Potvrdi',
          hasWebsiteField: false,
          formPlan: {
            schemaVersion: 1,
            snapshotId: snapshot.snapshotId,
            decision: 'commentable',
            formCandidateId: snapshot.formCandidates[0]?.formId ?? null,
            bindings: { comment: comment?.candidateId ?? '' },
            submitCandidateId: submit?.candidateId ?? null,
            requiredRoles: ['comment'],
            uncertainties: [],
          },
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      result: {
        message: 'FORM_PLAN_UNSAFE_SUBMIT',
        clickOccurred: false,
      },
    });
    expect(clicked).toBe(false);
  });

  it('rejects a planned comment form that submits to another origin', async () => {
    document.body.innerHTML = `
      <form class="comment-form" action="https://collector.example/submit" method="post">
        <textarea name="comment"></textarea>
        <button type="submit">Potvrdi</button>
      </form>
    `;
    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (control) => control.tag === 'textarea'
    );
    const submit = snapshot.controlCandidates.find(
      (control) => control.tag === 'button'
    );
    let clicked = false;
    document.querySelector('button')?.addEventListener('click', () => {
      clicked = true;
    });

    await expect(
      prepareSubmissionDocument(
        document,
        { comment: 'A useful comment.', websiteUrl: '' },
        {
          url: document.location.href,
          editorLabel: 'comment',
          submitLabel: 'Potvrdi',
          hasWebsiteField: false,
          formPlan: {
            schemaVersion: 1,
            snapshotId: snapshot.snapshotId,
            decision: 'commentable',
            formCandidateId: snapshot.formCandidates[0]?.formId ?? null,
            bindings: { comment: comment?.candidateId ?? '' },
            submitCandidateId: submit?.candidateId ?? null,
            requiredRoles: ['comment'],
            uncertainties: [],
          },
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      result: {
        message: 'FORM_PLAN_UNSAFE_SUBMIT',
        clickOccurred: false,
      },
    });
    expect(clicked).toBe(false);
  });

  it('rejects an unmapped visible required select in a planned form', async () => {
    document.body.innerHTML = `
      <form class="vcard">
        <textarea name="vText"></textarea>
        <select name="topic" required>
          <option value="">Choose a topic</option>
          <option value="article">Article</option>
        </select>
        <button type="button">Potvrdi</button>
      </form>
    `;
    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (control) => control.tag === 'textarea'
    );
    const submit = snapshot.controlCandidates.find(
      (control) => control.tag === 'button'
    );
    let clicked = false;
    document.querySelector('button')?.addEventListener('click', () => {
      clicked = true;
    });

    const result = await fillAndSubmitDocument(
      document,
      { comment: 'Zanimljiv članak.', websiteUrl: '' },
      0,
      {
        url: document.location.href,
        editorLabel: '',
        submitLabel: '',
        hasWebsiteField: false,
        formPlan: {
          schemaVersion: 1,
          snapshotId: snapshot.snapshotId,
          decision: 'commentable',
          formCandidateId: snapshot.formCandidates[0]?.formId ?? null,
          bindings: { comment: comment?.candidateId ?? '' },
          submitCandidateId: submit?.candidateId ?? null,
          requiredRoles: ['comment'],
          uncertainties: [],
        },
      }
    );

    expect(result).toMatchObject({
      status: 'validation_error',
      message: 'FORM_PLAN_REQUIRED_FIELD_MISSING',
      clickOccurred: false,
    });
    expect(clicked).toBe(false);
  });

  it('rejects an unmapped control marked required only by nearby copy', async () => {
    document.body.innerHTML = `
      <form class="comment-form">
        <textarea name="comment"></textarea>
        <div><span>Phone *</span><input id="phone" name="phone"></div>
        <button type="button">Post comment</button>
      </form>
    `;
    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (control) => control.tag === 'textarea'
    );
    const submit = snapshot.controlCandidates.find(
      (control) => control.tag === 'button'
    );
    let clicked = false;
    document.querySelector('button')?.addEventListener('click', () => {
      clicked = true;
    });

    await expect(
      prepareSubmissionDocument(
        document,
        { comment: 'A useful comment.', websiteUrl: '' },
        {
          url: document.location.href,
          editorLabel: 'comment',
          submitLabel: 'Post comment',
          hasWebsiteField: false,
          formPlan: {
            schemaVersion: 1,
            snapshotId: snapshot.snapshotId,
            decision: 'commentable',
            formCandidateId: snapshot.formCandidates[0]?.formId ?? null,
            bindings: { comment: comment?.candidateId ?? '' },
            submitCandidateId: submit?.candidateId ?? null,
            requiredRoles: ['comment'],
            uncertainties: [],
          },
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      result: {
        message: 'FORM_PLAN_REQUIRED_FIELD_MISSING',
        clickOccurred: false,
      },
    });
    expect(clicked).toBe(false);
  });

  it('rejects an unmapped required control associated outside the planned form', async () => {
    document.body.innerHTML = `
      <form id="comment-form" class="vcard">
        <textarea name="vText"></textarea>
        <button type="button">Potvrdi</button>
      </form>
      <input form="comment-form" type="checkbox" name="consent" required>
    `;
    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (control) => control.tag === 'textarea'
    );
    const submit = snapshot.controlCandidates.find(
      (control) => control.tag === 'button'
    );
    let clicked = false;
    document.querySelector('button')?.addEventListener('click', () => {
      clicked = true;
    });

    const result = await fillAndSubmitDocument(
      document,
      { comment: 'Zanimljiv članak.', websiteUrl: '' },
      0,
      {
        url: document.location.href,
        editorLabel: '',
        submitLabel: '',
        hasWebsiteField: false,
        formPlan: {
          schemaVersion: 1,
          snapshotId: snapshot.snapshotId,
          decision: 'commentable',
          formCandidateId: snapshot.formCandidates[0]?.formId ?? null,
          bindings: { comment: comment?.candidateId ?? '' },
          submitCandidateId: submit?.candidateId ?? null,
          requiredRoles: ['comment'],
          uncertainties: [],
        },
      }
    );

    expect(result).toMatchObject({
      status: 'validation_error',
      message: 'FORM_PLAN_REQUIRED_FIELD_MISSING',
      clickOccurred: false,
    });
    expect(clicked).toBe(false);
  });

  it('rejects identity values changed after preparation', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <input name="author">
        <input type="email" name="email">
        <button type="submit">Post comment</button>
      </form>
    `;
    let submitted = false;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted = true;
    });
    const preparation = await prepareSubmissionDocument(document, {
      comment: 'A useful comment.',
      displayName: 'Alex',
      email: 'alex@example.com',
      websiteUrl: '',
    });
    expect(preparation.ok).toBe(true);
    if (!preparation.ok) return;

    const name = document.querySelector(
      'input[name="author"]'
    ) as HTMLInputElement;
    const email = document.querySelector(
      'input[name="email"]'
    ) as HTMLInputElement;
    name.value = 'Changed';
    email.value = 'changed@example.com';

    await expect(
      clickPreparedSubmissionDocument(document, preparation.prepared, 0)
    ).resolves.toMatchObject({
      status: 'validation_error',
      message: 'PAGE_CHANGED_SINCE_GENERATION',
    });
    expect(submitted).toBe(false);
  });

  it('keeps the website field empty when the generated comment uses an inline link', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <input type="url" name="website" value="https://autofilled.example">
        <button type="submit">Post comment</button>
      </form>
    `;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const notice = document.createElement('p');
      notice.setAttribute('role', 'alert');
      notice.textContent = 'Your comment was submitted.';
      document.body.append(notice);
    });

    const result = await fillAndSubmitDocument(
      document,
      {
        comment: 'A relevant note with https://example.com included inline.',
        websiteUrl: '',
      },
      0
    );

    expect(result.status).toBe('submitted_not_visible');
    expect(
      (document.querySelector('input[name="website"]') as HTMLInputElement)
        .value
    ).toBe('');
  });

  it.each([
    'opacity: 0',
    'position: absolute; left: -9999px',
    'width: 0; height: 0',
  ])('ignores an invisible website-field honeypot styled with %s', (style) => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <input type="url" name="website" style="${style}" value="untouched">
        <button type="submit">Post comment</button>
      </form>
    `;

    expect(analyzePageDocument(document).form).toMatchObject({
      readiness: 'ready',
      hasWebsiteField: false,
    });
  });

  it('rejects a website value changed after preparation', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <input type="url" name="website">
        <button type="submit">Post comment</button>
      </form>
    `;
    let submitted = false;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted = true;
    });
    const preparation = await prepareSubmissionDocument(document, {
      comment: 'A useful comment.',
      websiteUrl: 'https://example.com',
    });
    expect(preparation.ok).toBe(true);
    if (!preparation.ok) return;

    const website = document.querySelector(
      'input[name="website"]'
    ) as HTMLInputElement;
    website.value = 'https://changed.example';

    await expect(
      clickPreparedSubmissionDocument(document, preparation.prepared, 0)
    ).resolves.toMatchObject({
      status: 'validation_error',
      message: 'PAGE_CHANGED_SINCE_GENERATION',
    });
    expect(submitted).toBe(false);
  });

  it.each([
    [false, '<input type="url" name="website">'],
    [true, ''],
  ] as const)(
    'requires regeneration when website-field availability changes from %s',
    async (expectedWebsiteField, websiteMarkup) => {
      document.body.innerHTML = `
        <form id="commentform">
          <textarea name="comment"></textarea>
          ${websiteMarkup}
          <button type="submit">Post comment</button>
        </form>
      `;

      const current = analyzePageDocument(document);
      const preparation = await prepareSubmissionDocument(
        document,
        { comment: 'A useful comment.', websiteUrl: '' },
        {
          url: current.page.url,
          editorLabel: current.form.editorLabel,
          submitLabel: current.form.submitLabel,
          hasWebsiteField: expectedWebsiteField,
        }
      );

      expect(preparation).toMatchObject({
        ok: false,
        result: {
          status: 'validation_error',
          message: 'LINK_PLACEMENT_CHANGED',
        },
      });
    }
  );

  it('caps stored feedback baselines by count and message length', async () => {
    document.body.innerHTML = `
      ${Array.from(
        { length: 30 },
        (_, index) => `<p role="alert">${index}-${'x'.repeat(700)}</p>`
      ).join('')}
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;

    const preparation = await prepareSubmissionDocument(document, {
      comment: 'A useful comment.',
      websiteUrl: '',
    });

    expect(preparation.ok).toBe(true);
    if (!preparation.ok) return;
    expect(preparation.prepared.baseline.feedbackMessages).toHaveLength(20);
    expect(
      Math.max(
        ...preparation.prepared.baseline.feedbackMessages.map(
          (message) => message.length
        )
      )
    ).toBeLessThanOrEqual(500);
    await clickPreparedSubmissionDocument(document, preparation.prepared, 0);
  });

  it('does not block the same form when descriptive labels are stale', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    let submitted = false;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted = true;
    });
    const analysis = analyzePageDocument(document);

    const result = await fillAndSubmitDocument(
      document,
      {
        comment: 'A concrete point from the article.',
        websiteUrl: 'https://example.com',
      },
      0,
      {
        url: analysis.page.url,
        editorLabel: analysis.form.editorLabel,
        submitLabel: 'A different submit control',
        hasWebsiteField: analysis.form.hasWebsiteField,
      }
    );

    expect(result).toMatchObject({ status: 'unknown', clickOccurred: true });
    expect(submitted).toBe(true);
  });

  it('allows localized editor and submit labels on the same comment form', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment" placeholder="Your comment..."></textarea>
        <button type="submit">Post</button>
      </form>
    `;
    const analysis = analyzePageDocument(document);
    const editor = document.querySelector('textarea');
    const submit = document.querySelector('button');
    editor?.setAttribute('placeholder', '您的評論…');
    if (submit) submit.textContent = '帖子';
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const notice = document.createElement('div');
      notice.id = 'status';
      notice.textContent = 'Comment submitted successfully';
      document.body.append(notice);
    });

    const result = await fillAndSubmitDocument(
      document,
      { comment: 'A useful comment.', websiteUrl: '' },
      0,
      {
        url: analysis.page.url,
        editorLabel: analysis.form.editorLabel,
        submitLabel: analysis.form.submitLabel,
        hasWebsiteField: analysis.form.hasWebsiteField,
      }
    );

    expect(result).toMatchObject({
      status: 'submitted_not_visible',
      clickOccurred: true,
    });
  });

  it('recognizes a newly added generic success status element', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const notice = document.createElement('div');
      notice.id = 'status';
      notice.textContent = 'Comment submitted successfully';
      document.body.append(notice);
    });

    const result = await fillAndSubmitDocument(
      document,
      { comment: 'A useful comment.', websiteUrl: '' },
      0
    );

    expect(result).toMatchObject({
      status: 'submitted_not_visible',
      clickOccurred: true,
    });
    expect(result).not.toHaveProperty('verificationObservation');
  });

  it('returns bounded local-language evidence without guessing the outcome', async () => {
    document.documentElement.lang = 'sr';
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const editor = document.querySelector('textarea');
      if (editor) editor.value = '';
      for (let index = 0; index < 25; index += 1) {
        const notice = document.createElement('div');
        notice.className = 'alert';
        notice.setAttribute('role', 'status');
        notice.textContent = `Obaveštenje ${index}: Vaš komentar je primljen. ${'ž'.repeat(600)}`;
        document.body.append(notice);
      }
    });

    const result = await fillAndSubmitDocument(
      document,
      { comment: 'Koristan komentar.', websiteUrl: '' },
      0
    );

    expect(result).toMatchObject({
      status: 'unknown',
      clickOccurred: true,
      verificationObservation: {
        url: document.location.href,
        language: 'sr',
        editorCleared: true,
        renderedCommentAdded: false,
      },
    });
    expect(result.verificationObservation?.feedbackMessages).toHaveLength(20);
    expect(
      result.verificationObservation?.feedbackMessages.every(
        (message) => message.length <= 500
      )
    ).toBe(true);
    expect(result.verificationObservation?.feedbackMessages.at(-1)).toMatch(
      /^Obaveštenje 24:/
    );
  });

  it('recognizes the Muvizu saved-comment confirmation', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post</button>
      </form>
    `;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const notice = document.createElement('div');
      notice.textContent = 'Your comment has been saved.';
      document.body.append(notice);
    });

    await expect(
      fillAndSubmitDocument(
        document,
        { comment: 'A useful comment.', websiteUrl: '' },
        0
      )
    ).resolves.toMatchObject({
      status: 'submitted_not_visible',
      clickOccurred: true,
    });
  });

  it('does not treat feedback that existed before the click as success', async () => {
    document.body.innerHTML = `
      <p role="alert">Your comment was submitted.</p>
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
    });

    const result = await fillAndSubmitDocument(
      document,
      {
        comment: 'A new comment that was not actually published.',
        websiteUrl: 'https://example.com',
      },
      0
    );

    expect(result.status).toBe('unknown');
  });

  it('does not treat hidden success feedback as publication evidence', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const notice = document.createElement('p');
      notice.setAttribute('role', 'alert');
      const hiddenCopy = document.createElement('span');
      hiddenCopy.style.display = 'none';
      hiddenCopy.textContent = 'Your comment was submitted.';
      notice.append(hiddenCopy);
      Object.defineProperty(notice, 'innerText', {
        configurable: true,
        value: 'Your comment was submitted.',
      });
      document.body.append(notice);
    });

    const result = await fillAndSubmitDocument(
      document,
      { comment: 'A comment without visible confirmation.', websiteUrl: '' },
      0
    );

    expect(result.status).toBe('unknown');
  });

  it('does not treat a hidden rendered comment as publication evidence', async () => {
    const comment = 'A comment rendered only in a hidden container.';
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const editor = document.querySelector('textarea');
      if (editor instanceof HTMLTextAreaElement) editor.value = '';
      const rendered = document.createElement('div');
      rendered.className = 'comment-body';
      const hiddenCopy = document.createElement('span');
      hiddenCopy.style.display = 'none';
      hiddenCopy.textContent = comment;
      rendered.append(hiddenCopy);
      Object.defineProperty(rendered, 'innerText', {
        configurable: true,
        value: comment,
      });
      document.body.append(rendered);
    });

    const result = await fillAndSubmitDocument(
      document,
      { comment, websiteUrl: '' },
      0
    );

    expect(result.status).toBe('unknown');
  });

  it('rejects a same-looking form that replaces the prepared DOM nodes', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    const preparation = await prepareSubmissionDocument(document, {
      comment: 'The prepared comment.',
      websiteUrl: 'https://example.com',
    });
    expect(preparation.ok).toBe(true);
    if (!preparation.ok) return;

    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment">Different replacement text.</textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    let submitted = false;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted = true;
    });

    const result = await clickPreparedSubmissionDocument(
      document,
      preparation.prepared,
      0
    );
    expect(result).toMatchObject({
      status: 'validation_error',
      message: 'PAGE_CHANGED_SINCE_GENERATION',
    });
    expect(submitted).toBe(false);
  });

  it('rejects a cloned replacement that copies the prepared DOM markers', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    const preparation = await prepareSubmissionDocument(document, {
      comment: 'The prepared comment.',
      websiteUrl: 'https://example.com',
    });
    expect(preparation.ok).toBe(true);
    if (!preparation.ok) return;

    const original = document.querySelector('form');
    const replacement = original?.cloneNode(true) as HTMLFormElement;
    original?.replaceWith(replacement);
    let submitted = false;
    replacement.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted = true;
    });

    const result = await clickPreparedSubmissionDocument(
      document,
      preparation.prepared,
      0
    );
    expect(result).toMatchObject({
      status: 'validation_error',
      message: 'PAGE_CHANGED_SINCE_GENERATION',
    });
    expect(submitted).toBe(false);
  });

  it('rejects prepared controls that are moved into another form', async () => {
    document.body.innerHTML = `
      <form id="commentform" action="/comments">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    const preparation = await prepareSubmissionDocument(document, {
      comment: 'The prepared comment.',
      websiteUrl: 'https://example.com',
    });
    expect(preparation.ok).toBe(true);
    if (!preparation.ok) return;

    const original = document.querySelector('form');
    const replacement = document.createElement('form');
    replacement.id = 'commentform';
    replacement.action = '/different-endpoint';
    while (original?.firstChild) replacement.append(original.firstChild);
    original?.replaceWith(replacement);
    let submitted = false;
    replacement.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted = true;
    });

    const result = await clickPreparedSubmissionDocument(
      document,
      preparation.prepared,
      0
    );
    expect(result).toMatchObject({
      status: 'validation_error',
      message: 'PAGE_CHANGED_SINCE_GENERATION',
    });
    expect(submitted).toBe(false);
  });

  it('allows only one in-flight submission for a document', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    let submissions = 0;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submissions += 1;
    });

    const first = fillAndSubmitDocument(
      document,
      {
        comment: 'The first comment.',
        websiteUrl: 'https://example.com',
      },
      0
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = fillAndSubmitDocument(
      document,
      {
        comment: 'The duplicate comment.',
        websiteUrl: 'https://example.com',
      },
      0
    );

    const [, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toMatchObject({
      status: 'validation_error',
      message: 'SUBMISSION_ALREADY_IN_PROGRESS',
    });
    expect(submissions).toBe(1);
  });

  it('rejects a concurrent edit that overwrites the draft during preparation', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    const editor = document.querySelector('textarea');
    editor?.addEventListener('input', () => {
      setTimeout(() => {
        editor.value = 'A concurrent replacement.';
      }, 0);
    });

    const preparation = await prepareSubmissionDocument(document, {
      comment: 'The intended draft.',
      websiteUrl: 'https://example.com',
    });

    expect(preparation).toMatchObject({
      ok: false,
      result: {
        status: 'validation_error',
        message: 'PAGE_CHANGED_SINCE_GENERATION',
      },
    });
  });

  it('ignores an old success message when an unrelated live region changes', async () => {
    document.body.innerHTML = `
      <p role="alert">Your comment was submitted.</p>
      <p aria-live="polite">Idle</p>
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const live = document.querySelector('[aria-live]');
      if (live) live.textContent = 'Working';
    });

    const result = await fillAndSubmitDocument(
      document,
      {
        comment: 'This was not actually submitted.',
        websiteUrl: 'https://example.com',
      },
      0
    );
    expect(result.status).toBe('unknown');
  });

  it('does not confuse an input-generated comment preview with publication', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    const editor = document.querySelector('textarea');
    editor?.addEventListener('input', () => {
      setTimeout(() => {
        const preview = document.createElement('div');
        preview.className = 'comment-preview';
        preview.textContent = editor.value;
        document.body.append(preview);
      }, 0);
    });
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
    });

    const result = await fillAndSubmitDocument(
      document,
      {
        comment: 'Previewed, but not published.',
        websiteUrl: 'https://example.com',
      },
      0
    );
    expect(result.status).toBe('unknown');
  });

  it('does not treat a delayed nested preview as a published comment', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    const editor = document.querySelector('textarea');
    editor?.addEventListener('input', () => {
      setTimeout(() => {
        const preview = document.createElement('div');
        preview.className = 'commentPreview';
        preview.innerHTML = `<div class="comment-body">${editor.value}</div>`;
        document.body.append(preview);
      }, 80);
    });
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (editor) editor.value = '';
    });

    const result = await fillAndSubmitDocument(
      document,
      {
        comment: 'Delayed preview, but not published.',
        websiteUrl: 'https://example.com',
      },
      150
    );
    expect(result.status).toBe('unknown');
  });

  it('does not treat draft markup inside the comment form as publication', async () => {
    document.body.innerHTML = `
      <form>
        <textarea name="comment" placeholder="Leave a comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    const editor = document.querySelector('textarea');
    const form = document.querySelector('form');
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (editor) editor.value = '';
      const draft = document.createElement('div');
      draft.className = 'comment-body';
      draft.textContent = 'Draft markup, not a published comment.';
      form.append(draft);
    });

    const result = await fillAndSubmitDocument(
      document,
      {
        comment: 'Draft markup, not a published comment.',
        websiteUrl: 'https://example.com',
      },
      0
    );
    expect(result.status).toBe('unknown');
  });

  it('waits past unrelated mutations when an old success message exists', async () => {
    document.body.innerHTML = `
      <p role="alert">Your comment was submitted.</p>
      <p aria-live="polite">Idle</p>
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      setTimeout(() => {
        const live = document.querySelector('[aria-live]');
        if (live) live.textContent = 'Working';
      }, 10);
      setTimeout(() => {
        const notice = document.createElement('p');
        notice.setAttribute('role', 'alert');
        notice.textContent = 'Your comment was submitted.';
        document.body.append(notice);
      }, 100);
    });

    const result = await fillAndSubmitDocument(
      document,
      {
        comment: 'A comment that is actually submitted later.',
        websiteUrl: 'https://example.com',
      },
      250
    );
    expect(result.status).toBe('submitted_not_visible');
  });

  it('detects success text appended to an existing live region', async () => {
    document.body.innerHTML = `
      <p aria-live="polite">Working</p>
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      setTimeout(() => {
        const live = document.querySelector('[aria-live]');
        if (live) live.textContent = 'Working Your comment was submitted.';
      }, 100);
    });

    const result = await fillAndSubmitDocument(
      document,
      {
        comment: 'A comment confirmed by a live region.',
        websiteUrl: 'https://example.com',
      },
      250
    );
    expect(result.status).toBe('submitted_not_visible');
  });

  it('distinguishes moderation from an unconfirmed result', () => {
    document.body.innerHTML =
      '<p class="comment-awaiting-moderation">Your comment is awaiting moderation.</p>';
    const submittedNotVisible = verifySubmissionDocument(
      document,
      'A useful point'
    );
    expect(submittedNotVisible.status).toBe('submitted_not_visible');
    expect(submittedNotVisible).not.toHaveProperty('verificationObservation');

    document.body.innerHTML = '<p>No status message here.</p>';
    expect(verifySubmissionDocument(document, 'A useful point').status).toBe(
      'unknown'
    );

    document.body.innerHTML = `
      <article>This guide explains what happens after a comment was submitted.</article>
      <section class="comment-editor">
        <div contenteditable="true">A useful point</div>
      </section>
    `;
    expect(verifySubmissionDocument(document, 'A useful point').status).toBe(
      'unknown'
    );
  });

  it('keeps conflicting success and error feedback unconfirmed', () => {
    document.body.innerHTML =
      '<p role="alert">Your comment was submitted. Error submitting comment.</p>';

    const result = verifySubmissionDocument(document, 'A useful point');
    expect(result).toMatchObject({
      status: 'unknown',
      message: 'COMMENT_SUBMISSION_UNCONFIRMED',
    });
    expect(result).not.toHaveProperty('verificationObservation');
  });

  it.each([
    ['<p>You must be logged in to comment.</p>', 'login_required'],
    ['<div class="cf-turnstile"></div>', 'captcha_required'],
  ] as const)(
    'detects a post-submit manual gate as %s',
    async (gateMarkup, expectedStatus) => {
      document.body.innerHTML = `
        <form id="commentform">
          <textarea name="comment"></textarea>
          <button type="submit">Post comment</button>
        </form>
      `;
      document.querySelector('form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        document.body.innerHTML = gateMarkup;
      });

      await expect(
        fillAndSubmitDocument(
          document,
          { comment: 'A useful comment.', websiteUrl: '' },
          0
        )
      ).resolves.toMatchObject({
        status: expectedStatus,
        clickOccurred: true,
      });
    }
  );

  it('reports that a gate appearing before click did not submit the comment', async () => {
    document.body.innerHTML = `
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    let submitted = false;
    document.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitted = true;
    });
    const preparation = await prepareSubmissionDocument(document, {
      comment: 'A useful comment.',
      websiteUrl: '',
    });
    expect(preparation.ok).toBe(true);
    if (!preparation.ok) return;
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<div class="cf-turnstile"></div>'
    );

    const result = await clickPreparedSubmissionDocument(
      document,
      preparation.prepared,
      0
    );

    expect(result).toMatchObject({
      status: 'captcha_required',
      clickOccurred: false,
    });
    expect(submitted).toBe(false);
  });

  it('does not verify a submission on a different page URL', async () => {
    document.body.innerHTML = '<p role="alert">Your comment was submitted.</p>';

    const result = await runPageCommand(document, {
      type: 'verify',
      fingerprint: 'A useful point',
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

  it('allows a WordPress moderation return URL on the same article', async () => {
    const origin = document.location.origin;
    document.defaultView?.history.replaceState(
      {},
      '',
      '/article?unapproved=42&moderation-hash=abc#comment-42'
    );
    document.body.innerHTML =
      '<p class="comment-awaiting-moderation">Your comment is awaiting moderation.</p>';

    const result = await runPageCommand(document, {
      type: 'verify',
      fingerprint: 'A useful point',
      baseline: { feedbackMessages: [], renderedComment: false },
      expectedUrl: `${origin}/article`,
    });

    expect(result).toMatchObject({
      type: 'submission',
      result: { status: 'submitted_not_visible' },
    });
    document.defaultView?.history.replaceState({}, '', '/');
  });
});
