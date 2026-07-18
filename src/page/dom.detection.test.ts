import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzePageDocument, fillAndSubmitDocument } from './dom';

describe('login-gated comment areas', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
    document.head.innerHTML =
      '<meta name="description" content="A knowledge-base article about registration.">';
    document.title = 'Registration guide';
    document.body.innerHTML = '';
  });

  it('classifies a "log in to post comments" gate as login_required', async () => {
    // pharmahub.org KB shape: a comment form shell whose only logged-out
    // content is the login warning — no textarea at all.
    document.body.innerHTML = `
      <article><h1>Registration guide</h1><p>Enough article copy to build an excerpt for generation.</p></article>
      <h3 class="post-comment-title">Post a comment</h3>
      <form method="post" action="/kb/registration/login2" id="commentform">
        <fieldset>
          <legend>Post a comment</legend>
          <div class="form-group">
            <label for="commentcontent">
              Your comments: <span class="required">Required</span>
              <p class="warning">You must <a href="/login?return=abc">log in</a> to post comments.</p>
            </label>
          </div>
        </fieldset>
      </form>
    `;

    const analysis = await analyzePageDocument(document);

    expect(analysis.form).toMatchObject({
      readiness: 'login_required',
      message: 'LOGIN_REQUIRED',
    });
  });

  it('does not gate a working WordPress form on far-away article prose', async () => {
    document.body.innerHTML = `
      <article>
        <h1>Commenting culture</h1>
        <p>Many sites now make you log in to post comments, which changes
        how communities behave and who participates in them.</p>
      </article>
      <form id="commentform">
        <textarea id="comment" name="comment"></textarea>
        <input name="author" placeholder="Name">
        <button type="submit" id="submit">Post comment</button>
      </form>
    `;

    const analysis = await analyzePageDocument(document);

    expect(analysis.form).toMatchObject({ readiness: 'ready' });
  });

  it('still gates a WordPress form shell that carries the login notice', async () => {
    document.body.innerHTML = `
      <article><h1>Article</h1><p>Enough article copy to build an excerpt for generation.</p></article>
      <div id="respond" class="comment-respond">
        <textarea id="comment" name="comment"></textarea>
        <p>You must be logged in to post a comment.</p>
        <button type="submit" id="submit">Post comment</button>
      </div>
    `;

    const analysis = await analyzePageDocument(document);

    expect(analysis.form).toMatchObject({ readiness: 'login_required' });
  });
});

describe('cross-origin comment frames', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
    document.head.innerHTML =
      '<meta name="description" content="A wellness article.">';
    document.title = 'Disconnect to reconnect';
    document.body.innerHTML = '';
  });

  function mountJetpackFrame() {
    // greenerideal.com shape: the iframe has no `src` until a lazy-load
    // script promotes `data-lazy-src` when scrolled into view.
    document.body.innerHTML = `
      <article><h1>Disconnect to reconnect</h1><p>Enough article copy to build an excerpt for generation.</p></article>
      <div id="respond" class="comment-respond">
        <h3 id="reply-title" class="comment-reply-title">What do you think? Leave a comment!</h3>
        <form id="commentform" class="comment-form">
          <iframe
            title="Comment Form"
            name="jetpack_remote_comment"
            class="jetpack_remote_comment"
            id="jetpack_remote_comment"
            style="width:100%; height:430px; border:0;"
            data-lazy-src="https://jetpack.wordpress.com/jetpack-comment/?blogid=115909882&postid=44294"
            data-lazy-method="viewport"
            data-lazy-attributes="src"></iframe>
        </form>
      </div>
    `;
    return document.getElementById(
      'jetpack_remote_comment'
    ) as HTMLIFrameElement;
  }

  it('reports a lazy-loaded Jetpack remote-comment iframe as a ready frame', async () => {
    mountJetpackFrame();

    const analysis = await analyzePageDocument(document);

    expect(analysis.form).toMatchObject({
      readiness: 'ready',
      frame: {
        kind: 'jetpack',
        url: 'https://jetpack.wordpress.com/jetpack-comment/?blogid=115909882&postid=44294',
      },
    });
  });

  it('promotes the Jetpack frame data-lazy-src so a background tab loads it', async () => {
    const frame = mountJetpackFrame();
    expect(frame.getAttribute('src')).toBeNull();

    await analyzePageDocument(document);

    expect(frame.getAttribute('src')).toBe(
      'https://jetpack.wordpress.com/jetpack-comment/?blogid=115909882&postid=44294'
    );
  });

  it('still reports a non-Jetpack cross-origin comment frame as unsupported', async () => {
    document.body.innerHTML = `
      <article><h1>Disconnect to reconnect</h1><p>Enough article copy to build an excerpt for generation.</p></article>
      <div id="comments">
        <iframe
          title="Comments"
          src="https://widget.disqus.com/embed.html?forum=example#comment"
          style="width:100%; height:430px; border:0;"></iframe>
      </div>
    `;

    const analysis = await analyzePageDocument(document);

    expect(analysis.form).toMatchObject({
      readiness: 'not_found',
      message: 'CROSS_ORIGIN_COMMENT_FRAME_UNSUPPORTED',
    });
  });
});

describe('comment form reveal controls', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
    document.head.innerHTML =
      '<meta name="description" content="An article with a toggled comment form.">';
    document.title = 'Toggled comments';
    document.body.innerHTML = '';
  });

  function mountFormOnClick(button: HTMLElement) {
    button.addEventListener('click', () => {
      const form = document.createElement('form');
      form.innerHTML = `
        <textarea name="comment" placeholder="Write a comment"></textarea>
        <button type="submit">Post comment</button>
      `;
      form.className = 'comment-form';
      document.body.appendChild(form);
    });
  }

  it('clicks a "Leave a comment" button that mounts the form', async () => {
    document.body.innerHTML = `
      <article><h1>Toggled comments</h1><p>Enough article copy to build an excerpt for generation.</p></article>
      <button type="button" id="open-comments">Leave a comment</button>
    `;
    const button = document.getElementById('open-comments');
    if (!button) throw new Error('fixture button missing');
    mountFormOnClick(button);

    const analysis = await analyzePageDocument(document);

    expect(analysis.form).toMatchObject({ readiness: 'ready' });
  });

  it('clicks a toggle that unhides an already mounted form', async () => {
    document.body.innerHTML = `
      <article><h1>Toggled comments</h1><p>Enough article copy to build an excerpt for generation.</p></article>
      <button type="button" id="open-comments">Write a comment</button>
      <div id="comment-area" style="display:none">
        <form class="comment-form">
          <textarea name="comment" placeholder="Write a comment"></textarea>
          <button type="submit">Post comment</button>
        </form>
      </div>
    `;
    document.getElementById('open-comments')?.addEventListener('click', () => {
      const area = document.getElementById('comment-area');
      if (area) area.style.display = 'block';
    });

    const analysis = await analyzePageDocument(document);

    expect(analysis.form).toMatchObject({ readiness: 'ready' });
  });

  it('does not click a login link phrased like a reveal control', async () => {
    document.body.innerHTML = `
      <article><h1>Toggled comments</h1><p>Enough article copy to build an excerpt for generation.</p></article>
      <a href="/login" id="login-link">Log in to leave a comment</a>
    `;
    const clicked = vi.fn();
    document.getElementById('login-link')?.addEventListener('click', clicked);

    const analysis = await analyzePageDocument(document);

    expect(clicked).not.toHaveBeenCalled();
    expect(analysis.form).toMatchObject({ readiness: 'login_required' });
  });

  it('does not click a navigating link even when it mentions comments', async () => {
    document.body.innerHTML = `
      <article><h1>Toggled comments</h1><p>Enough article copy to build an excerpt for generation.</p></article>
      <a href="/all-comments" id="comments-page-link">View all comments</a>
    `;
    const clicked = vi.fn();
    document
      .getElementById('comments-page-link')
      ?.addEventListener('click', clicked);

    const analysis = await analyzePageDocument(document);

    expect(clicked).not.toHaveBeenCalled();
    expect(analysis.form).toMatchObject({ readiness: 'not_found' });
  });

  it('leaves pages without a reveal control untouched', async () => {
    document.body.innerHTML = `
      <article><h1>Toggled comments</h1><p>Enough article copy to build an excerpt for generation.</p></article>
      <button type="button" id="subscribe">Subscribe</button>
      <button type="button" id="share">Share this post</button>
    `;
    const clicked = vi.fn();
    document.getElementById('subscribe')?.addEventListener('click', clicked);
    document.getElementById('share')?.addEventListener('click', clicked);

    const analysis = await analyzePageDocument(document);

    expect(clicked).not.toHaveBeenCalled();
    expect(analysis.form).toMatchObject({ readiness: 'not_found' });
  });
});

describe('HUBzero CKEditor iframe comment form', () => {
  beforeEach(() => {
    document.documentElement.lang = 'en';
    document.head.innerHTML =
      '<meta name="description" content="A knowledge-base article rendered by HUBzero.">';
    document.title = 'Knowledge base article';
    document.body.innerHTML = '';
  });

  // CKEditor 4 mounts its rich-text surface inside a same-origin, srcless
  // iframe whose contentDocument.body carries contenteditable="true" and only
  // generic cke_* classes — no "comment" anywhere in the iframe document.
  function mountCkEditorBody(
    iframe: HTMLIFrameElement,
    comment = ''
  ): Document | null {
    const frameDocument = iframe.contentDocument;
    if (!frameDocument) return null;
    frameDocument.body.innerHTML = '';
    frameDocument.body.setAttribute('contenteditable', 'true');
    frameDocument.body.className =
      'cke_editable cke_editable_themed cke_contents_ltr';
    if (comment) frameDocument.body.textContent = comment;
    return frameDocument;
  }

  // The exact logged-in pharmahub.org (HUBzero) KB comment form: a hidden
  // decoy <textarea>, the visible CKEditor chrome, a same-origin srcless
  // iframe editor, an anonymous checkbox, a name="submit" value="Save"
  // button, and several hidden bookkeeping inputs.
  function mountLoggedInHubzeroForm(): Document | null {
    document.body.innerHTML = `
      <article><h1>Knowledge base article</h1><p>Enough article copy to build an excerpt for generation and analysis of the topic.</p></article>
      <h3 class="post-comment-title">Post a comment</h3>
      <form method="post" action="/kb/registration/login2" id="commentform">
        <p class="comment-member-photo"><img alt=""></p>
        <fieldset>
          <legend>Post a comment</legend>
          <div class="form-group">
            <label for="commentcontent">Your comments: <span class="required">Required</span></label>
            <textarea name="comment[content]" id="commentcontent" rows="15" cols="40"
              class="minimal ckeditor-content" style="visibility: hidden; display: none;"></textarea>
            <div id="cke_commentcontent" class="cke cke_reset cke_chrome cke_editor_commentcontent cke_ltr">
              <div class="cke_inner">
                <span class="cke_top">
                  <a class="cke_button" role="button" title="Source">Source</a>
                  <a class="cke_button" role="button" title="Link">Link</a>
                  <a class="cke_button" role="button" title="Bold">Bold</a>
                </span>
                <div class="cke_contents" style="height:270px">
                  <iframe id="cke_wysiwyg_frame" class="cke_reset" title="Rich Text Editor, commentcontent" frameborder="0"></iframe>
                </div>
              </div>
            </div>
          </div>
        </fieldset>
        <p><input type="checkbox" name="comment[anonymous]" id="comment-anonymous" value="1" class="option"> Post anonymously</p>
        <input type="submit" name="submit" value="Save">
        <input type="hidden" name="comment[id]" value="0">
        <input type="hidden" name="comment[entry_id]" value="4">
        <input type="hidden" name="comment[parent]" value="">
        <input type="hidden" name="option" value="com_kb">
        <input type="hidden" name="task" value="savecomment">
      </form>
    `;
    const iframe = document.getElementById(
      'cke_wysiwyg_frame'
    ) as HTMLIFrameElement | null;
    if (!iframe) return null;
    return mountCkEditorBody(iframe);
  }

  // A neighbouring already-posted comment's "Reply" editor: the identical
  // CKEditor iframe pattern, but collapsed (display:none) until clicked.
  function appendCollapsedReplyForm(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'comment-reply-wrapper';
    wrapper.style.display = 'none';
    wrapper.innerHTML = `
      <form method="post" action="/kb/registration/login2" class="comment-reply-form">
        <textarea name="comment[content]" class="ckeditor-content" style="display:none"></textarea>
        <div class="cke cke_reset cke_chrome">
          <div class="cke_contents">
            <iframe class="cke_reply_frame cke_reset" title="Rich Text Editor, reply" frameborder="0"></iframe>
          </div>
        </div>
        <input type="submit" name="submit" value="Save">
      </form>
    `;
    document.body.appendChild(wrapper);
    const iframe = wrapper.querySelector('iframe') as HTMLIFrameElement | null;
    if (iframe) mountCkEditorBody(iframe);
  }

  it('reports the logged-in CKEditor comment form as ready', async () => {
    expect(mountLoggedInHubzeroForm()).toBeTruthy();

    const analysis = await analyzePageDocument(document);

    expect(analysis.form).toMatchObject({
      readiness: 'ready',
      message: 'COMMENT_FORM_READY',
    });
  });

  it('writes the comment into the iframe body, not the hidden textarea, and submits the outer form', async () => {
    const frameDocument = mountLoggedInHubzeroForm();
    expect(frameDocument).toBeTruthy();
    if (!frameDocument) return;
    let submitted = false;
    document
      .querySelector('#commentform')
      ?.addEventListener('submit', (event) => {
        event.preventDefault();
        submitted = true;
        const notice = document.createElement('p');
        notice.setAttribute('role', 'alert');
        notice.textContent = 'Your comment was submitted.';
        document.body.append(notice);
      });

    const comment =
      'The KB walkthrough clears up the registration flow nicely.';
    const result = await fillAndSubmitDocument(
      document,
      { comment, websiteUrl: '' },
      0
    );

    expect(result).toMatchObject({ status: 'submitted', clickOccurred: true });
    expect(submitted).toBe(true);
    expect(frameDocument.body.textContent).toContain('KB walkthrough');
    expect(
      (document.getElementById('commentcontent') as HTMLTextAreaElement).value
    ).toBe('');
  });

  it('stays ready while ignoring a sibling collapsed CKEditor reply form', async () => {
    expect(mountLoggedInHubzeroForm()).toBeTruthy();
    appendCollapsedReplyForm();

    const analysis = await analyzePageDocument(document);

    expect(analysis.form).toMatchObject({ readiness: 'ready' });
  });

  it('does not pick a standalone collapsed CKEditor reply form', async () => {
    document.body.innerHTML = `
      <article><h1>Knowledge base article</h1><p>Enough article copy to build an excerpt for generation and analysis of the topic.</p></article>
    `;
    appendCollapsedReplyForm();

    const analysis = await analyzePageDocument(document);

    expect(analysis.form).toMatchObject({
      readiness: 'not_found',
      message: 'COMMENT_FORM_NOT_FOUND',
    });
  });

  it('accepts a plain comment form whose submit is name="submit" value="Save"', async () => {
    document.body.innerHTML = `
      <article><h1>Knowledge base article</h1><p>Enough article copy to build an excerpt for generation and analysis of the topic.</p></article>
      <form class="comment-form" action="/kb/comments/save">
        <label for="c">Your comments</label>
        <textarea id="c" name="comment"></textarea>
        <input type="submit" name="submit" value="Save">
      </form>
    `;

    const analysis = await analyzePageDocument(document);

    expect(analysis.form).toMatchObject({ readiness: 'ready' });
  });

  it('does not report a plain settings form with a name="submit" Save button as ready', async () => {
    document.body.innerHTML = `
      <article><h1>Account settings</h1><p>Enough article copy to build an excerpt for generation and analysis of the topic.</p></article>
      <form class="account-settings" action="/account/save">
        <label for="bio">Bio</label>
        <textarea id="bio" name="bio"></textarea>
        <input type="submit" name="submit" value="Save">
      </form>
    `;

    const analysis = await analyzePageDocument(document);

    expect(analysis.form.readiness).toBe('not_found');
  });
});
