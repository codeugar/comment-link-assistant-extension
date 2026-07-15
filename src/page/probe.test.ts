import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probePageDocument, resolveProbeCandidate } from './probe';

describe('page probe', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('ignores form named-property clobbering when reading ancestor IDs', () => {
    document.body.innerHTML = `
      <form id="comment-form">
        <input name="id" value="123">
        <textarea name="comment" aria-label="Comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    const form = document.querySelector('form');
    Object.defineProperty(form, 'id', {
      configurable: true,
      value: document.querySelector('input[name="id"]'),
    });

    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'comment'
    );

    expect(snapshot.formCandidates[0]?.attributes.id).toBe('comment-form');
    expect(comment?.ancestorTokens).toContain('form#comment-form');
  });

  it('captures an Apotekanet form without exposing entered identity values', () => {
    document.body.innerHTML = `
      <form id="comment-form">
        <div class="form-group required">
          <label for="input-name">Vaše ime <span>*</span></label>
          <input id="input-name" name="name" value="Wes Lin">
        </div>
        <div class="form-group required">
          <label for="input-email">E-Mail: <span>*</span></label>
          <input id="input-email" name="email" value="wes@example.com">
        </div>
        <div class="form-group">
          <label for="input-website">Web sajt:</label>
          <input id="input-website" name="website" value="https://example.com">
        </div>
        <div class="form-group required">
          <label for="input-comment">Komentar <span>*</span></label>
          <textarea id="input-comment" name="comment">Zanimljiv članak.</textarea>
        </div>
        <input type="hidden" name="csrf" value="private-csrf-token">
        <button type="button" class="comment-submit">Potvrdi</button>
      </form>
    `;

    const snapshot = probePageDocument(document);
    const name = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'name'
    );
    const email = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'email'
    );
    const comment = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'comment'
    );
    const submit = snapshot.controlCandidates.find((candidate) =>
      candidate.attributes.class?.includes('comment-submit')
    );
    const serialized = JSON.stringify(snapshot);

    expect(snapshot).toMatchObject({
      url: document.URL,
      snapshotId: expect.stringMatching(/^snapshot-/),
      formCandidates: [
        expect.objectContaining({
          formId: expect.stringMatching(/^form-/),
          controlCandidateIds: expect.arrayContaining([
            comment?.candidateId,
            submit?.candidateId,
          ]),
        }),
      ],
    });
    expect(name).toMatchObject({
      labels: ['Vaše ime *'],
      requiredSignals: expect.arrayContaining([
        'ancestor-class:required',
        'label-marker:*',
      ]),
      hasValue: true,
    });
    expect(email).toMatchObject({
      labels: ['E-Mail: *'],
      requiredSignals: expect.arrayContaining([
        'ancestor-class:required',
        'label-marker:*',
      ]),
      hasValue: true,
    });
    expect(comment?.formId).toBe(submit?.formId);
    expect(serialized).not.toContain('Wes Lin');
    expect(serialized).not.toContain('wes@example.com');
    expect(serialized).not.toContain('private-csrf-token');
    expect(serialized).not.toContain('Zanimljiv članak.');
  });

  it('keeps controls assigned to the correct candidate across multiple forms', () => {
    document.body.innerHTML = `
      <form id="search-form">
        <input type="search" name="q" value="private search query">
        <input type="submit" value="Search this site">
      </form>
      <form id="comment-form">
        <div
          contenteditable="true"
          aria-label="Komentar"
          aria-required="true"
        >private comment draft</div>
        <div role="button" aria-label="Open formatting">Format</div>
      </form>
      <input
        form="comment-form"
        type="email"
        name="email"
        value="author@example.com"
      >
      <button form="comment-form" type="button">Potvrdi</button>
    `;

    const snapshot = probePageDocument(document);
    const searchForm = snapshot.formCandidates.find(
      (candidate) => candidate.attributes.id === 'search-form'
    );
    const commentForm = snapshot.formCandidates.find(
      (candidate) => candidate.attributes.id === 'comment-form'
    );
    const externalEmail = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'email'
    );
    const externalButton = snapshot.controlCandidates.find(
      (candidate) =>
        candidate.tag === 'button' && candidate.nearbyText.includes('Potvrdi')
    );
    const editor = snapshot.controlCandidates.find(
      (candidate) => candidate.type === 'contenteditable'
    );
    const roleButton = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.role === 'button'
    );
    const inputSubmit = snapshot.controlCandidates.find(
      (candidate) => candidate.tag === 'input' && candidate.type === 'submit'
    );
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.formCandidates).toHaveLength(2);
    expect(searchForm?.formId).not.toBe(commentForm?.formId);
    expect(commentForm?.controlCandidateIds).toEqual(
      expect.arrayContaining([
        editor?.candidateId,
        roleButton?.candidateId,
        externalEmail?.candidateId,
        externalButton?.candidateId,
      ])
    );
    expect(inputSubmit?.formId).toBe(searchForm?.formId);
    expect(editor).toMatchObject({
      labels: ['Komentar'],
      requiredSignals: ['attribute:aria-required'],
      hasValue: true,
    });
    expect(roleButton).toMatchObject({ tag: 'div', type: 'button' });
    expect(serialized).not.toContain('private search query');
    expect(inputSubmit?.nearbyText).toContain('Search this site');
    expect(serialized).not.toContain('private comment draft');
    expect(serialized).not.toContain('author@example.com');
  });

  it('keeps wrapped control content out of labels and nearby text', () => {
    document.body.innerHTML = `
      <form>
        <label>
          Message *
          <textarea required name="comment">private wrapped draft</textarea>
        </label>
        <input
          name="contact"
          aria-label="Contact owner@example.com"
          value="Owner Name"
        >
      </form>
    `;

    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'comment'
    );
    const contact = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'contact'
    );
    const serialized = JSON.stringify(snapshot);

    expect(comment).toMatchObject({
      labels: ['Message *'],
      requiredSignals: expect.arrayContaining([
        'attribute:required',
        'label-marker:*',
      ]),
      hasValue: true,
    });
    expect(contact?.labels).toEqual(['Contact [redacted-email]']);
    expect(serialized).not.toContain('private wrapped draft');
    expect(serialized).not.toContain('owner@example.com');
    expect(serialized).not.toContain('Owner Name');
  });

  it('resolves only candidates from the unchanged live page snapshot', () => {
    document.body.innerHTML = `
      <form>
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
    `;
    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'comment'
    );
    const original = document.querySelector('textarea');

    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        comment?.candidateId ?? ''
      )
    ).toBe(original);
    expect(
      resolveProbeCandidate(
        document,
        'snapshot-stale',
        comment?.candidateId ?? ''
      )
    ).toBeNull();

    original?.replaceWith(original.cloneNode(true));

    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        comment?.candidateId ?? ''
      )
    ).toBeNull();
  });

  it.each([
    {
      evidence: 'button text',
      mutate: (button: HTMLButtonElement) => {
        button.textContent = 'Delete comment';
      },
    },
    {
      evidence: 'type',
      mutate: (button: HTMLButtonElement) => {
        button.type = 'button';
      },
    },
    {
      evidence: 'name',
      mutate: (button: HTMLButtonElement) => {
        button.name = 'delete-comment';
      },
    },
    {
      evidence: 'aria label',
      mutate: (button: HTMLButtonElement) => {
        button.setAttribute('aria-label', 'Delete comment');
      },
    },
    {
      evidence: 'form method',
      mutate: (button: HTMLButtonElement) => {
        button.setAttribute('formmethod', 'get');
      },
    },
  ])('rejects a live candidate after its $evidence changes', ({ mutate }) => {
    document.body.innerHTML = `
      <form>
        <textarea name="comment"></textarea>
        <button
          type="submit"
          name="publish-comment"
          aria-label="Post comment"
          formmethod="post"
        >Post comment</button>
      </form>
    `;
    const snapshot = probePageDocument(document);
    const button = document.querySelector('button');
    const candidate = snapshot.controlCandidates.find(
      (control) => control.tag === 'button'
    );
    expect(button).toBeTruthy();
    if (!button) return;

    mutate(button);

    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        candidate?.candidateId ?? ''
      )
    ).toBeNull();
  });

  it('keeps a live candidate valid across value, disabled, and state-class changes', () => {
    document.body.innerHTML = `
      <form>
        <input
          name="email"
          value="before@example.com"
          class="is-disabled"
          disabled
        >
        <button type="submit" class="is-disabled" disabled>Post comment</button>
      </form>
    `;
    const snapshot = probePageDocument(document);
    const input = document.querySelector('input');
    const button = document.querySelector('button');
    const inputCandidate = snapshot.controlCandidates.find(
      (control) => control.attributes.name === 'email'
    );
    const buttonCandidate = snapshot.controlCandidates.find(
      (control) => control.tag === 'button'
    );
    expect(input).toBeTruthy();
    expect(button).toBeTruthy();
    if (!input || !button) return;

    input.value = 'after@example.com';
    input.disabled = false;
    input.className = 'is-valid';
    button.disabled = false;
    button.setAttribute('aria-disabled', 'false');
    button.className = 'is-valid';

    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        inputCandidate?.candidateId ?? ''
      )
    ).toBe(input);
    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        buttonCandidate?.candidateId ?? ''
      )
    ).toBe(button);
  });

  it.each([
    {
      evidence: 'own semantic class',
      mutate: (input: HTMLInputElement) => {
        input.classList.replace('vName', 'vEmail');
      },
    },
    {
      evidence: 'ancestor semantic class',
      mutate: (input: HTMLInputElement) => {
        input.parentElement?.classList.replace('vName', 'vEmail');
      },
    },
  ])('rejects a candidate after its $evidence changes', ({ mutate }) => {
    document.body.innerHTML = `
      <div class="vName">
        <input class="identity-field vName" name="identity">
      </div>
    `;
    const snapshot = probePageDocument(document);
    const input = document.querySelector('input');
    const candidate = snapshot.controlCandidates[0];
    expect(input).toBeTruthy();
    if (!input) return;

    mutate(input);

    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        candidate?.candidateId ?? ''
      )
    ).toBeNull();
  });

  it('rejects a candidate when its associated label changes in place', () => {
    document.body.innerHTML = `
      <label for="identity">Email</label>
      <input id="identity" name="identity">
    `;
    const snapshot = probePageDocument(document);
    const input = document.querySelector('input');
    const candidate = snapshot.controlCandidates[0];

    document.querySelector('label')?.replaceChildren('Delete confirmation');

    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        candidate?.candidateId ?? ''
      )
    ).toBeNull();
    expect(input).toBeTruthy();
  });

  it('rejects a candidate when its nearby semantic copy changes in place', () => {
    document.body.innerHTML = `
      <span>Email *</span>
      <input id="identity" name="identity">
    `;
    const snapshot = probePageDocument(document);
    const candidate = snapshot.controlCandidates[0];

    document.querySelector('span')?.replaceChildren('Phone *');

    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        candidate?.candidateId ?? ''
      )
    ).toBeNull();
  });

  it('captures safe action paths and rejects endpoint changes without exposing query secrets', () => {
    document.body.innerHTML = `
      <form action="/comments/create?csrf=private-token">
        <textarea name="comment"></textarea>
        <button type="submit" formaction="/comments/publish?nonce=private-nonce">Post comment</button>
      </form>
    `;
    const snapshot = probePageDocument(document);
    const form = snapshot.formCandidates[0];
    const button = document.querySelector('button');
    const candidate = snapshot.controlCandidates.find(
      (control) => control.tag === 'button'
    );

    expect(form?.attributes.action).toContain('/comments/create');
    expect(candidate?.attributes.formaction).toContain('/comments/publish');
    expect(JSON.stringify(snapshot)).not.toContain('private-token');
    expect(JSON.stringify(snapshot)).not.toContain('private-nonce');

    button?.setAttribute(
      'formaction',
      '/comments/publish?action=delete_comment'
    );

    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        candidate?.candidateId ?? ''
      )
    ).toBeNull();
  });

  it('rejects an input submit candidate after its button label changes', () => {
    document.body.innerHTML = `
      <form>
        <input name="email" value="before@example.com">
        <input type="submit" value="Post comment">
      </form>
    `;
    const snapshot = probePageDocument(document);
    const submit = document.querySelector<HTMLInputElement>(
      'input[type="submit"]'
    );
    const candidate = snapshot.controlCandidates.find(
      (control) => control.type === 'submit'
    );
    expect(submit).toBeTruthy();
    if (!submit) return;

    submit.value = 'Delete comment';

    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        candidate?.candidateId ?? ''
      )
    ).toBeNull();
  });

  it('exposes an input submit label without exposing ordinary input values', () => {
    document.body.innerHTML = `
      <form>
        <input name="email" value="private@example.com">
        <textarea name="comment">private draft</textarea>
        <input type="submit" value="Potvrdi">
      </form>
    `;

    const snapshot = probePageDocument(document);
    const email = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'email'
    );
    const submit = snapshot.controlCandidates.find(
      (candidate) => candidate.type === 'submit'
    );

    expect(JSON.stringify(email)).not.toContain('private@example.com');
    expect(JSON.stringify(snapshot)).not.toContain('private draft');
    expect(submit?.nearbyText).toContain('Potvrdi');
  });

  it.each([
    'opacity: 0',
    'position: absolute; left: -9999px',
    'width: 0; height: 0',
  ])('marks a CSS-hidden %s honeypot as invisible', (style) => {
    document.body.innerHTML = `
      <input name="website" style="${style}">
      <textarea name="comment"></textarea>
      <button type="button">Post comment</button>
    `;

    const snapshot = probePageDocument(document);
    const website = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'website'
    );

    expect(website?.visible).toBe(false);
  });

  it('bounds the number of candidates sent to the model', () => {
    document.body.innerHTML = `${Array.from(
      { length: 80 },
      (_, index) => `<form id="form-${index}"></form>`
    ).join('')}<form>${Array.from(
      { length: 180 },
      (_, index) => `<input name="field-${index}">`
    ).join('')}</form>`;

    const snapshot = probePageDocument(document);
    expect(snapshot.formCandidates.length).toBeLessThanOrEqual(40);
    expect(snapshot.controlCandidates.length).toBeLessThanOrEqual(120);
  });

  it('keeps a unique comment entry when repeated reply actions exceed the cap', () => {
    document.body.innerHTML = `
      <a class="comments__add-btn" href="#addComment">+ Add Comments</a>
      ${Array.from(
        { length: 180 },
        (_, index) =>
          `<a class="comments__reply" href="#reply-${index}">Reply</a>`
      ).join('')}
      <form id="commentform">
        <textarea name="comment"></textarea>
        <button type="submit">Submit Comment</button>
      </form>
    `;

    const snapshot = probePageDocument(document);
    const addComment = snapshot.controlCandidates.find((candidate) =>
      candidate.attributes.class?.includes('comments__add-btn')
    );
    const replyCandidates = snapshot.controlCandidates.filter((candidate) =>
      candidate.attributes.class?.includes('comments__reply')
    );

    expect(addComment).toBeDefined();
    expect(replyCandidates).toHaveLength(1);
    expect(snapshot.controlCandidates.length).toBeLessThanOrEqual(120);
  });

  it('keeps a visible button-like reveal control between thousands of links', () => {
    document.body.innerHTML = `
      ${Array.from(
        { length: 200 },
        (_, index) => `<a href="/before-${index}">Before ${index}</a>`
      ).join('')}
      <div id="write-comment" class="btn write-comment-btn">
        Skriv kommentar
      </div>
      ${Array.from(
        { length: 200 },
        (_, index) => `<a href="/after-${index}">After ${index}</a>`
      ).join('')}
    `;

    const snapshot = probePageDocument(document);

    expect(
      snapshot.controlCandidates.find(
        (candidate) => candidate.attributes.id === 'write-comment'
      )
    ).toMatchObject({ type: 'button', visible: true, enabled: true });
    expect(snapshot.controlCandidates.length).toBeLessThanOrEqual(120);
  });

  it('reserves candidate space for a comment link among many buttons', () => {
    document.body.innerHTML = `
      ${Array.from(
        { length: 200 },
        (_, index) => `<button type="button">Action ${index}</button>`
      ).join('')}
      <a id="write-comment" href="#respond">Leave a comment</a>
    `;

    const snapshot = probePageDocument(document);

    expect(
      snapshot.controlCandidates.find(
        (candidate) => candidate.attributes.id === 'write-comment'
      )
    ).toBeDefined();
    expect(snapshot.controlCandidates.length).toBeLessThanOrEqual(120);
  });

  it('bounds aria-labelledby references before resolving or serializing them', () => {
    const labelIds = Array.from({ length: 20 }, (_, index) => `label-${index}`);
    document.body.innerHTML = `
      ${labelIds
        .map((id, index) => `<span id="${id}">Label ${index}</span>`)
        .join('')}
      <input name="comment-title" aria-labelledby="${labelIds.join(' ')}">
    `;

    const snapshot = probePageDocument(document);
    const candidate = snapshot.controlCandidates[0];

    expect(candidate?.labels).toEqual(
      Array.from({ length: 8 }, (_, index) => `Label ${index}`)
    );
    expect(candidate?.attributes['aria-labelledby']?.split(/\s+/)).toEqual(
      labelIds.slice(0, 8)
    );
  });

  it('bounds repeated explicit labels for a single candidate', () => {
    document.body.innerHTML = `
      ${Array.from(
        { length: 30 },
        (_, index) => `<label for="field">Label ${index}</label>`
      ).join('')}
      <input id="field" name="field">
    `;

    const snapshot = probePageDocument(document);

    expect(snapshot.controlCandidates[0]?.labels).toHaveLength(8);
  });

  it('captures nearby form headings and invalidates their semantic snapshot when they change', () => {
    document.body.innerHTML = `
      <section>
        <h3>Ostavite komentar</h3>
        <form>
          <textarea name="vText"></textarea>
          <button type="button">Potvrdi</button>
        </form>
      </section>
    `;
    const snapshot = probePageDocument(document);
    const form = snapshot.formCandidates[0];
    const comment = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'vText'
    );

    expect(form?.headings).toContain('Ostavite komentar');
    expect(comment?.headings).toContain('Ostavite komentar');

    document.querySelector('h3')?.replaceChildren('Kontaktirajte nas');

    expect(
      resolveProbeCandidate(document, snapshot.snapshotId, form?.formId ?? '')
    ).toBeNull();
    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        comment?.candidateId ?? ''
      )
    ).toBeNull();
  });

  it('assigns each adjacent form only its own nearest heading and accessible name', () => {
    document.body.innerHTML = `
      <main>
        <header><h2>Contact us</h2></header>
        <form class="vCard" aria-label="Contact form">
          <input name="vName">
          <textarea name="vText"></textarea>
          <button type="button">Potvrdi</button>
        </form>
        <header><h2 id="comment-title">Leave a comment</h2></header>
        <form class="vCard" aria-labelledby="comment-title">
          <input name="vName">
          <textarea name="vText"></textarea>
          <button type="button">Potvrdi</button>
        </form>
      </main>
    `;

    const snapshot = probePageDocument(document);
    const contactForm = snapshot.formCandidates.find(
      (candidate) => candidate.attributes['aria-label'] === 'Contact form'
    );
    const commentForm = snapshot.formCandidates.find(
      (candidate) => candidate.attributes['aria-labelledby'] === 'comment-title'
    );
    const commentEditor = snapshot.controlCandidates.find(
      (candidate) =>
        candidate.tag === 'textarea' && candidate.formId === commentForm?.formId
    );

    expect(contactForm).toMatchObject({
      attributes: { 'aria-label': 'Contact form' },
      headings: ['Contact us'],
    });
    expect(commentForm).toMatchObject({
      attributes: { 'aria-labelledby': 'comment-title' },
      headings: ['Leave a comment'],
    });
    expect(commentEditor?.headings).toEqual(['Leave a comment']);
  });

  it('keeps page-bottom multiline editors and their form controls within the cap', () => {
    const utilityForms = Array.from(
      { length: 50 },
      (_, formIndex) => `
        <form id="utility-${formIndex}">
          <input name="utility-${formIndex}-a">
          <input name="utility-${formIndex}-b">
          <button type="button">Open utility</button>
        </form>
      `
    ).join('');
    document.body.innerHTML = `
      ${utilityForms}
      <form id="bottom-comment">
        <input name="author">
        <input name="email">
        <textarea name="comment"></textarea>
        <button type="submit">Post comment</button>
      </form>
      <form id="bottom-reply">
        <div contenteditable="true" aria-label="Reply"></div>
        <button type="submit">Post reply</button>
      </form>
    `;

    const snapshot = probePageDocument(document);
    const commentForm = snapshot.formCandidates.find(
      (candidate) => candidate.attributes.id === 'bottom-comment'
    );
    const replyForm = snapshot.formCandidates.find(
      (candidate) => candidate.attributes.id === 'bottom-reply'
    );
    const selectedNames = snapshot.controlCandidates.map(
      (candidate) => candidate.attributes.name
    );
    const replyEditor = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes['aria-label'] === 'Reply'
    );

    expect(snapshot.formCandidates).toHaveLength(40);
    expect(snapshot.controlCandidates.length).toBeLessThanOrEqual(120);
    expect(commentForm?.controlCandidateIds).toHaveLength(4);
    expect(replyForm?.controlCandidateIds).toHaveLength(2);
    expect(selectedNames).toEqual(
      expect.arrayContaining(['author', 'email', 'comment'])
    );
    expect(replyEditor?.formId).toBe(replyForm?.formId);
  });

  it('keeps the page-bottom editor group atomically when many editor forms exceed the cap', () => {
    document.body.innerHTML = `
      ${Array.from(
        { length: 40 },
        (_, index) => `
          <form id="inline-reply-${index}">
            <input name="author-${index}">
            <textarea name="reply-${index}"></textarea>
            <button type="button">Potvrdi</button>
          </form>
        `
      ).join('')}
      <form id="bottom-comment">
        <input name="author-main">
        <textarea name="comment-main"></textarea>
        <button type="button" class="comment-submit">Potvrdi</button>
      </form>
    `;

    const snapshot = probePageDocument(document);
    const targetForm = snapshot.formCandidates.find(
      (candidate) => candidate.attributes.id === 'bottom-comment'
    );
    const targetControls = snapshot.controlCandidates.filter(
      (candidate) => candidate.formId === targetForm?.formId
    );

    expect(snapshot.formCandidates).toHaveLength(40);
    expect(snapshot.controlCandidates).toHaveLength(120);
    expect(targetForm?.controlCandidateIds).toHaveLength(3);
    expect(
      targetControls.map((candidate) => candidate.attributes.name)
    ).toEqual(expect.arrayContaining(['author-main', 'comment-main']));
    expect(
      targetControls.some(
        (candidate) => candidate.attributes.class === 'comment-submit'
      )
    ).toBe(true);
  });

  it('prioritizes a visible comment group over hidden editor groups', () => {
    document.body.innerHTML = `
      ${Array.from(
        { length: 45 },
        (_, index) => `
          <form style="display:none" id="hidden-editor-${index}">
            <input name="hidden-name-${index}">
            <textarea name="hidden-comment-${index}"></textarea>
            <button type="button">Potvrdi</button>
          </form>
        `
      ).join('')}
      <section id="visible-comments">
        <input name="vName">
        <input name="vEmail">
        <textarea name="vText"></textarea>
        <button type="button" class="comment-submit">Potvrdi</button>
      </section>
    `;

    const snapshot = probePageDocument(document);
    const visibleRegion = snapshot.formCandidates.find(
      (candidate) => candidate.attributes.id === 'visible-comments'
    );

    expect(visibleRegion).toMatchObject({ tag: 'region' });
    expect(
      snapshot.controlCandidates
        .filter((candidate) => candidate.formId === visibleRegion?.formId)
        .map((candidate) => candidate.attributes.name)
    ).toEqual(expect.arrayContaining(['vName', 'vEmail', 'vText']));
  });

  it('keeps a page-bottom form-less comment region within the control cap', () => {
    document.body.innerHTML = `
      ${Array.from(
        { length: 140 },
        (_, index) => `<input name="utility-${index}">`
      ).join('')}
      <section class="comment-region">
        <input name="name">
        <input name="email">
        <input name="website">
        <textarea name="comment"></textarea>
        <button type="button" class="comment-submit">Potvrdi</button>
      </section>
    `;

    const snapshot = probePageDocument(document);
    const selectedNames = snapshot.controlCandidates.map(
      (candidate) => candidate.attributes.name
    );

    expect(selectedNames).toEqual(
      expect.arrayContaining(['name', 'email', 'website', 'comment'])
    );
    expect(
      snapshot.controlCandidates.some(
        (candidate) => candidate.attributes.class === 'comment-submit'
      )
    ).toBe(true);
  });

  it('groups independent form-less editors with only their own controls', () => {
    document.body.innerHTML = `
      <section id="contact-widget">
        <input name="vName">
        <textarea name="vText"></textarea>
        <button type="button">Send</button>
      </section>
      <section id="comment-widget">
        <input name="vName">
        <input name="vEmail">
        <textarea name="vText"></textarea>
        <button type="button">Potvrdi</button>
      </section>
    `;

    const snapshot = probePageDocument(document);
    const commentRegion = snapshot.formCandidates.find(
      (candidate) => candidate.attributes.id === 'comment-widget'
    );
    const commentEditor = snapshot.controlCandidates.find(
      (candidate) =>
        candidate.attributes.name === 'vText' &&
        candidate.ancestorTokens.includes('section#comment-widget')
    );
    const commentSubmit = snapshot.controlCandidates.find((candidate) =>
      candidate.nearbyText.includes('Potvrdi')
    );
    const contactEditor = snapshot.controlCandidates.find(
      (candidate) =>
        candidate.attributes.name === 'vText' &&
        candidate.ancestorTokens.includes('section#contact-widget')
    );

    expect(commentRegion).toMatchObject({
      tag: 'region',
      controlCandidateIds: expect.arrayContaining([
        commentEditor?.candidateId,
        commentSubmit?.candidateId,
      ]),
    });
    expect(commentEditor?.formId).toBe(commentRegion?.formId);
    expect(commentSubmit?.formId).toBe(commentRegion?.formId);
    expect(contactEditor?.formId).not.toBe(commentRegion?.formId);
    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        commentRegion?.formId ?? ''
      )
    ).toBe(document.querySelector('#comment-widget'));
  });

  it('reuses a shared form-less region scan across sibling editors', () => {
    document.body.innerHTML = `
      <section id="shared-comment-region">
        ${Array.from(
          { length: 20 },
          (_, index) =>
            `<div><textarea name="comment-${index}"></textarea></div>`
        ).join('')}
        <button type="button">Potvrdi</button>
      </section>
    `;
    const region = document.querySelector<HTMLElement>(
      '#shared-comment-region'
    );
    expect(region).toBeTruthy();
    if (!region) return;
    const querySelectorAll = vi.spyOn(region, 'querySelectorAll');

    const snapshot = probePageDocument(document);

    expect(querySelectorAll).toHaveBeenCalledTimes(1);
    expect(
      snapshot.formCandidates.find(
        (candidate) => candidate.attributes.id === 'shared-comment-region'
      )
    ).toMatchObject({ tag: 'region' });
  });

  it('ignores rich-text toolbar actions when locating a form-less comment region', () => {
    document.body.innerHTML = `
      <section id="comment-widget">
        <input name="vName">
        <input name="vEmail">
        <div class="editor-shell">
          <div role="toolbar">
            <button type="button">Bold</button>
            <button type="button">Emoji</button>
            <button type="submit" class="comment-submit">Potvrdi</button>
          </div>
          <div contenteditable="true" aria-label="Komentar"></div>
        </div>
      </section>
    `;

    const snapshot = probePageDocument(document);
    const region = snapshot.formCandidates.find(
      (candidate) => candidate.attributes.id === 'comment-widget'
    );
    const editor = snapshot.controlCandidates.find(
      (candidate) => candidate.type === 'contenteditable'
    );
    const submit = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.class === 'comment-submit'
    );

    expect(region).toMatchObject({ tag: 'region' });
    expect(editor?.formId).toBe(region?.formId);
    expect(submit?.formId).toBe(region?.formId);
    expect(
      snapshot.controlCandidates.filter(
        (candidate) => candidate.tag === 'button'
      )
    ).toHaveLength(1);
  });

  it('observes an opaque comment form inside an open shadow root', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <form class="vCard">
        <label for="shadow-name">Vaše ime</label>
        <input id="shadow-name" name="vName">
        <span id="shadow-email-label">E-Mail</span>
        <input name="vEmail" aria-labelledby="shadow-email-label">
        <textarea name="vText"></textarea>
        <button type="button">Potvrdi</button>
      </form>
    `;

    const snapshot = probePageDocument(document);
    const selectedNames = snapshot.controlCandidates.map(
      (candidate) => candidate.attributes.name
    );
    const comment = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'vText'
    );
    const name = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'vName'
    );
    const email = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'vEmail'
    );

    expect(selectedNames).toEqual(
      expect.arrayContaining(['vName', 'vEmail', 'vText'])
    );
    expect(name?.labels).toEqual(['Vaše ime']);
    expect(email?.labels).toEqual(['E-Mail']);
    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        comment?.candidateId ?? ''
      )
    ).toBe(shadow.querySelector('textarea'));
  });

  it('observes an opaque comment form inside a same-origin iframe', () => {
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    const frameDocument = iframe.contentDocument;
    expect(frameDocument).toBeTruthy();
    if (!frameDocument) return;
    frameDocument.body.innerHTML = `
      <form class="vCard">
        <input name="vName">
        <input name="vEmail">
        <textarea name="vText"></textarea>
        <button type="button">Potvrdi</button>
      </form>
    `;

    const snapshot = probePageDocument(document);
    const comment = snapshot.controlCandidates.find(
      (candidate) => candidate.attributes.name === 'vText'
    );

    expect(comment).toBeTruthy();
    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        comment?.candidateId ?? ''
      )
    ).toBe(frameDocument.querySelector('textarea'));

    iframe.remove();

    expect(
      resolveProbeCandidate(
        document,
        snapshot.snapshotId,
        comment?.candidateId ?? ''
      )
    ).toBeNull();
  });
});
