import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzePageDocument } from './dom';

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

  it('reports a lazy-loaded Jetpack remote-comment iframe as unsupported', async () => {
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
