import { attachLinkFollow, extractPromotedUrl } from './link-follow';
import { getWordPressSubmitReceipt } from './receipts';
import type {
  CommentFormSummary,
  PageAnalysis,
  PageSubmissionBaseline,
  PageSubmissionExpectation,
  PageSubmissionInput,
  PageSubmissionPreparation,
  PageSubmissionResult,
  PreparedPageSubmission,
  TargetPageContext,
} from './types';
import { isLocallyVisible, isVisible } from './visibility';

const EDITOR_SELECTOR = [
  'textarea',
  '[contenteditable="true"]',
  '[role="textbox"][contenteditable]',
  '.ProseMirror',
  '.ql-editor',
  '[data-lexical-editor="true"]',
].join(',');

const POSITIVE_EDITOR =
  /comment|reply|discussion|评论|評論|回复|回覆|留言|回帖|發言|发言/i;
const NEGATIVE_EDITOR =
  /search|query|newsletter|subscribe|contact|feedback|survey|poll|questionnaire|rating|support|ticket|inquiry|enquiry|chat|filter|coupon|title|subject|搜索|搜尋|订阅|訂閱|联系|聯絡|反馈|反饋|问卷|問卷|调查|調查|投票|评分|評分|客服|工单|工單/i;
const BARE_SUBMIT_ACTION =
  /^(?:submit|post|publish|send|reply|respond|发布|發佈|提交|回复|回覆|留言|发表|發表|发帖|發帖|帖子)$/i;
const STRONG_COMMENT_SUBMIT =
  /(?:post|publish|add|leave|send|submit)\s+(?:a\s+|your\s+)?(?:comment|reply)|(?:comment|reply)\s+(?:now|here)|发布评论|發佈評論|提交评论|提交評論|发表评论|發表評論/i;
const COMMENT_HEADING =
  /leave\s+(?:a\s+)?(?:comment|reply)|add\s+(?:a\s+)?comment|join\s+(?:the\s+)?discussion|post\s+(?:a\s+)?comment|发表评论|發表評論|留下评论|留下評論|参与讨论|參與討論/i;
const AUTH_CONTROL =
  /\b(?:log[\s-]*in|sign[\s-]*(?:in|up)|register|create\s+(?:an?\s+)?account|join)\b|登录|登入|注册|註冊|创建账号|建立帳號|加入/i;
const NEGATIVE_SUBMIT =
  /\b(?:search|subscribe|preview|cancel|reset|back|close)\b|搜索|订阅|訂閱|取消|预览|預覽|重置|返回|关闭|關閉/i;
const NON_SUBMISSION_ACTION =
  /\b(?:like|unlike|upvote|downvote|vote|follow|bookmark|copy|share|view|show|expand|collapse)\b|点赞|點讚|赞|讚|投票|关注|關注|收藏|复制|複製|分享|查看|顯示|显示|展开|展開|收起/i;
const DESTRUCTIVE_SUBMIT =
  /\b(?:delete|remove|report|flag|spam|abuse|edit|update|moderate|approve|reject|ban|block|hide|archive|trash|discard)\b|删除|刪除|移除|举报|舉報|标记|標記|垃圾|滥用|濫用|编辑|編輯|更新|审核|審核|批准|拒绝|拒絕|封禁|屏蔽|隱藏|隐藏|归档|歸檔|丢弃|丟棄/i;
const NON_COMMENT_FORM_CONTEXT =
  /\b(?:report|flag|spam|abuse|delete|remove|edit|update|moderat(?:e|ion)|approve|reject|ban|block|hide|archive|trash|discard|share|forward|invite|private[\s_-]*message|direct[\s_-]*message|message[\s_-]*author|order|checkout|payment|purchase|cart|billing|shipping|donat(?:e|ion)|booking|reservation|rsvp|application|apply|log[\s_-]*in|sign[\s_-]*(?:in|up)|register|account)\b|删除|刪除|移除|举报|舉報|标记|標記|垃圾|滥用|濫用|编辑|編輯|更新|审核|審核|批准|拒绝|拒絕|封禁|屏蔽|隱藏|隐藏|归档|歸檔|丢弃|丟棄|分享|转发|轉發|邀请|邀請|私信|私人消息|私人訊息|站内信|站內信|订单|訂單|结账|結帳|支付|付款|购买|購買|购物车|購物車|账单|帳單|捐赠|捐贈|预订|預訂|预约|預約|申请|申請|登录|登入|注册|註冊|加入|账号|帳號/i;
const CHECKOUT_THEME_IDENTITY_TOKEN = /(^|[\s_-])checkout(?=$|[\s_-])/gi;
const LOGIN_COPY =
  /log[\s-]*in\s+to\s+(?:comment|reply)|sign[\s-]*in\s+to\s+(?:comment|reply)|sign[\s-]*up\s+to\s+(?:comment|reply)|register\s+to\s+(?:comment|reply)|create\s+(?:an?\s+)?account\s+to\s+(?:comment|reply)|(?:log[\s-]*in|sign[\s-]*(?:in|up)|register)\s+(?:or\s+(?:sign[\s-]*up|register)\s+)?to\s+(?:post|leave|add|write|submit)\s+(?:a\s+|your\s+)?(?:comment|repl(?:y|ies))s?|you must be logged in|登录后(?:才可)?(?:评论|回复|留言)|请先登录|登入後(?:才可)?(?:評論|回覆)|注册后(?:才可)?(?:评论|回复|留言)|註冊後(?:才可)?(?:評論|回覆)/i;
const CAPTCHA_SELECTOR = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  '[data-sitekey]',
].join(',');
const PENDING_COPY =
  /awaiting moderation|pending (?:approval|moderation)|held for moderation|will be reviewed|等待审核|待审核|審核中|等待審核/i;
const SUCCESS_COPY =
  /comment (?:(?:was|has been) )?(?:submitted|posted|published|saved)|reply (?:was )?(?:submitted|posted)|thank you for (?:your )?comment|评论(?:已)?(?:提交|发布|发表)成功|留言成功|回覆成功|回复成功/i;
const ERROR_COPY =
  /required field|please enter|invalid email|comment cannot be empty|failed to (?:submit|post)|error submitting|必填|请输入|請輸入|邮箱格式|郵箱格式|提交失败|提交失敗|发布失败|發佈失敗/i;
// WordPress emits `wp_die('Duplicate comment detected; ...')` for a re-posted
// comment. The phrase is exact and language-specific, so match it narrowly to
// avoid tripping on ordinary article prose that mentions duplicate comments.
const DUPLICATE_COMMENT_COPY =
  /duplicate comment detected|检测到重复评论|偵測到重複留言|重复评论|重複留言/i;
// WordPress posts a comment to `wp-comments-post.php` and, when the comment is
// held for moderation, redirects to `?unapproved=<ID>&moderation-hash=<hash>` —
// a deterministic, language-independent submit receipt.
const WORDPRESS_COMMENT_POST_ACTION = /\/wp-comments-post\.php\/?$/i;
const WORDPRESS_COMMENT_CONTAINER_SELECTOR = [
  '#commentform',
  'form[action*="wp-comments-post.php"]',
  '#respond',
  '.comment-respond',
].join(',');
const WORDPRESS_CANONICAL_EDITOR_SELECTOR =
  'textarea#comment, textarea[name="comment"]';
const WORDPRESS_CANONICAL_SUBMIT_SELECTOR =
  '#submit, button#comment-submit, input[type="submit"][name="submit"], button[type="submit"][name="submit"], .comment-submit';
const RENDERED_COMMENT_EXCLUDE =
  /preview|draft|(?:^|[\s_-])(?:editor|form|composer|input)(?:$|[\s_-])/i;
const RENDERED_COMMENT_SELECTOR = [
  '[class*="comment"]',
  '[id*="comment"]',
  '[class*="reply"]',
  '[id*="reply"]',
  '[itemprop="comment"]',
  '[itemtype*="Comment"]',
  '[data-comment-id]',
  '[data-comment-key]',
].join(', ');
const DOM_SETTLE_MS = 50;
const SUBMIT_ENABLE_TIMEOUT_MS = 750;
// Post-click verification polls for decisive evidence (rendered promoted link,
// WordPress receipt, moderation/error copy) instead of checking once: slow or
// AJAX comment sections insert the comment seconds after the success banner
// renders. The window must stay under the 120s page-command timeout.
const SUBMIT_VERIFY_POLL_INTERVAL_MS = 1_000;
const SUBMIT_VERIFY_WINDOW_MS = 90_000;
const MAX_FEEDBACK_MESSAGES = 20;
const MAX_FEEDBACK_MESSAGE_LENGTH = 500;
const PREPARATION_TTL_MS = 2 * 60_000;
// Read-only analyze is load-tolerant: heavy / slow pages rarely reach a fully
// loaded state within a batch's grace window, but their server-rendered comment
// form is present early. These bounds keep the settle deterministic and short.
const ANALYZE_DOM_CONTENT_LOADED_TIMEOUT_MS = 5_000;
const ANALYZE_SETTLE_TIMEOUT_MS = 4_000;
// The runtime preflight asks the page for the Verbum bundle rather than waiting
// on its viewport-triggered loader, so a mount lands within seconds. Waiting
// longer than that never helps: a shell that is still empty means the bundle
// never arrived, and no amount of polling makes a background tab render.
const VERBUM_FORM_WAIT_TIMEOUT_MS = 15_000;
const VERBUM_PREFLIGHT_HANDOFF_TIMEOUT_MS = 10_000;
const VERBUM_IDENTITY_WAIT_TIMEOUT_MS = 2_000;
const VERBUM_BACKOFF_INITIAL_MS = 250;
const VERBUM_BACKOFF_MAX_MS = 4_000;
const VERBUM_SHELL_SELECTOR = '.comment-form__verbum';
const COMMENT_REGION_SELECTOR = [
  '#respond',
  '#commentform',
  '#comments',
  '[id*="comment"]',
  '[class*="comment"]',
].join(',');
// Controls that only reveal an initially absent / hidden comment form. Count
// links ("5 comments") are deliberately excluded: they usually just scroll.
const REVEAL_COMMENT_COPY =
  /(?:leave|write|post|add|drop)\s+(?:a\s+|your\s+)?(?:comment|reply)|join\s+the\s+(?:discussion|conversation)|(?:show|view|load|open)\s+(?:the\s+)?comments?|^\s*respond\s*$|发表评论|寫評論|写评论|添加评论|发表留言|我要评论|我要留言/i;
const REVEAL_REJECT =
  /\b(?:like|unlike|upvote|downvote|vote|follow|bookmark|copy|share|report|flag)\b|点赞|點讚|投票|关注|關注|收藏|复制|複製|分享|举报|舉報/i;

interface ActiveDomSubmission {
  token: string;
  expiresAt: number;
}

const activeDomSubmissions = new WeakMap<Document, ActiveDomSubmission>();

function isHtmlElement(element: Element): element is HTMLElement {
  return element.namespaceURI === 'http://www.w3.org/1999/xhtml';
}

function isInputElement(element: Element): element is HTMLInputElement {
  return element.tagName === 'INPUT';
}

function isTextAreaElement(element: Element): element is HTMLTextAreaElement {
  return element.tagName === 'TEXTAREA';
}

function isButtonElement(element: Element): element is HTMLButtonElement {
  return element.tagName === 'BUTTON';
}

function isFormElement(element: Element): element is HTMLFormElement {
  return element.tagName === 'FORM';
}

function isSelectElement(element: Element): element is HTMLSelectElement {
  return element.tagName === 'SELECT';
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function visibleTextContent(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeType === 1 && !isVisible(node as Element)) return '';
  return Array.from(node.childNodes)
    .map(visibleDescendantTextContent)
    .join(' ');
}

function visibleDescendantTextContent(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeType === 1 && !isLocallyVisible(node as Element)) return '';
  return Array.from(node.childNodes)
    .map(visibleDescendantTextContent)
    .join(' ');
}

function renderedPageText(element: Element): string {
  if (!isVisible(element)) return '';
  if (isHtmlElement(element) && typeof element.innerText === 'string') {
    return element.innerText;
  }
  return visibleTextContent(element);
}

function elementDescriptor(element: Element): string {
  const attributes = [
    element.getAttribute('id'),
    element.getAttribute('name'),
    element.getAttribute('class'),
    element.getAttribute('placeholder'),
    element.getAttribute('aria-label'),
    element.getAttribute('data-testid'),
    element.getAttribute('role'),
    isInputElement(element) ? element.value : null,
    visibleTextContent(element).slice(0, 180),
  ];
  return normalizeWhitespace(attributes.filter(Boolean).join(' ')).slice(
    0,
    500
  );
}

function controlActionDescriptor(element: Element): string {
  return normalizeWhitespace(
    [
      element.getAttribute('id'),
      element.getAttribute('name'),
      element.getAttribute('title'),
      element.getAttribute('aria-label'),
      element.getAttribute('formaction'),
      element.getAttribute('formmethod'),
      isInputElement(element) ? element.value : null,
      visibleTextContent(element).slice(0, 180),
    ]
      .filter(Boolean)
      .join(' ')
  ).slice(0, 500);
}

function controlLabels(element: Element): string[] {
  return [
    element.getAttribute('title'),
    element.getAttribute('aria-label'),
    isInputElement(element) ? element.value : null,
    visibleTextContent(element).slice(0, 180),
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizeWhitespace)
    .filter(Boolean);
}

function isWordPressCommentPostAction(
  action: string | null,
  baseURI: string
): boolean {
  if (!action?.trim()) return false;
  try {
    return WORDPRESS_COMMENT_POST_ACTION.test(
      new URL(action, baseURI).pathname
    );
  } catch {
    return false;
  }
}

// Native WordPress `comment_form()` output, matched structurally so it is
// recognized regardless of UI language: a `<form id="commentform">` (or one
// posting to `wp-comments-post.php`), or a `#respond` / `.comment-respond`
// wrapper holding the canonical `textarea#comment`.
function isWordPressCommentContainer(element: Element): boolean {
  if (isFormElement(element)) {
    if (element.matches('#commentform')) return true;
    if (
      isWordPressCommentPostAction(
        element.getAttribute('action'),
        element.ownerDocument.baseURI
      )
    ) {
      return true;
    }
  }
  return Boolean(
    element.matches('#respond, .comment-respond') &&
      element.querySelector(WORDPRESS_CANONICAL_EDITOR_SELECTOR)
  );
}

function isInsideWordPressCommentForm(element: Element): boolean {
  const form = element.closest('form');
  if (form && isWordPressCommentContainer(form)) return true;
  const respond = element.closest('#respond, .comment-respond');
  return Boolean(respond && isWordPressCommentContainer(respond));
}

// WordPress stamps its submit with `id="submit"` / `name="submit"`; Verbum uses
// `button#comment-submit`. Accept those identities inside a WordPress comment
// form, bypassing the language-fragile label whitelist. The WordPress context
// gate keeps generic forms unaffected.
function isCanonicalWordPressSubmit(element: Element): boolean {
  const canonical =
    element.matches('#submit, button#comment-submit') ||
    ((isInputElement(element) || isButtonElement(element)) &&
      element.type === 'submit' &&
      element.name === 'submit');
  return canonical && isInsideWordPressCommentForm(element);
}

function isPositiveSubmitControl(element: Element): boolean {
  if (element.matches('.comment-submit')) return true;
  if (isCanonicalWordPressSubmit(element)) return true;
  // A canonical submit identity (id/name of `submit`, `post`, `reply`, …) is
  // authoritative on its own. Check it unconditionally, not only as a fallback
  // when the control has no labels: a control whose value doubles as a label
  // (e.g. `<input type="submit" name="submit" value="Save">`) must not be
  // rejected merely because "Save" misses the action-word whitelist.
  if (
    /^(?:submit|post|publish|send|reply|respond)(?:[-_](?:comment|reply))?$/i.test(
      normalizeWhitespace(
        [element.getAttribute('id'), element.getAttribute('name')]
          .filter(Boolean)
          .join(' ')
      )
    )
  ) {
    return true;
  }
  const labels = controlLabels(element);
  if (labels.length > 0) {
    return labels.some(
      (label) =>
        BARE_SUBMIT_ACTION.test(label) || STRONG_COMMENT_SUBMIT.test(label)
    );
  }
  return false;
}

function structuralDescriptor(
  element: Element | null,
  ignoreCheckoutThemeIdentity = false
): string {
  if (!element) return '';
  const identityAttribute = (name: 'id' | 'class') => {
    const value = element.getAttribute(name);
    return ignoreCheckoutThemeIdentity
      ? value?.replace(CHECKOUT_THEME_IDENTITY_TOKEN, '$1')
      : value;
  };
  return normalizeWhitespace(
    [
      identityAttribute('id'),
      element.getAttribute('name'),
      identityAttribute('class'),
      element.getAttribute('placeholder'),
      element.getAttribute('aria-label'),
      element.getAttribute('data-testid'),
      element.getAttribute('role'),
      element.getAttribute('action'),
      element.getAttribute('formaction'),
      element.getAttribute('formmethod'),
    ]
      .filter(Boolean)
      .join(' ')
  ).slice(0, 500);
}

function isDisabled(element: Element): boolean {
  if (element.getAttribute('aria-disabled') === 'true') return true;
  return (
    (isTextAreaElement(element) ||
      isInputElement(element) ||
      isButtonElement(element)) &&
    element.disabled
  );
}

function documentRoots(document: Document): Array<Document | ShadowRoot> {
  const roots: Array<Document | ShadowRoot> = [document];
  const seen = new Set<Document | ShadowRoot>(roots);
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (element.shadowRoot && !seen.has(element.shadowRoot)) {
        seen.add(element.shadowRoot);
        roots.push(element.shadowRoot);
      }
      if (element.tagName === 'IFRAME' && isVisible(element)) {
        try {
          const source = element.getAttribute('src');
          const sourceUrl = source
            ? new URL(source, element.ownerDocument.baseURI)
            : null;
          const ownerOrigin = element.ownerDocument.location.origin;
          const frameDocument =
            !sourceUrl ||
            sourceUrl.protocol === 'about:' ||
            sourceUrl.origin === ownerOrigin
              ? (element as HTMLIFrameElement).contentDocument
              : null;
          if (frameDocument && !seen.has(frameDocument)) {
            seen.add(frameDocument);
            roots.push(frameDocument);
          }
        } catch {
          // Cross-origin frames are intentionally inaccessible here.
        }
      }
    }
  }
  return roots;
}

// Jetpack renders the ONLY comment form of a Jetpack-comments blog inside a
// cross-origin iframe served from jetpack.wordpress.com/jetpack-comment/. The
// frame is same-origin-scriptable from the extension (its sandbox grants
// allow-same-origin allow-scripts), so we treat it as a supported target and
// run submit/click inside it rather than writing it off as unsupported.
const JETPACK_COMMENT_FRAME_HOST = 'jetpack.wordpress.com';
const JETPACK_COMMENT_FRAME_PATH = '/jetpack-comment';

interface JetpackCommentFrame {
  element: HTMLIFrameElement;
  url: string;
}

function jetpackCommentFrameUrl(element: Element): string | null {
  // Lazy-loading themes park the frame URL in a data attribute until the frame
  // scrolls into view, so read those before assuming no source.
  const raw =
    element.getAttribute('src') ??
    element.getAttribute('data-lazy-src') ??
    element.getAttribute('data-src') ??
    '';
  if (!raw) return null;
  try {
    const url = new URL(raw, element.ownerDocument.baseURI);
    if (
      url.host === JETPACK_COMMENT_FRAME_HOST &&
      url.pathname.startsWith(JETPACK_COMMENT_FRAME_PATH)
    ) {
      return url.href;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveJetpackCommentFrame(
  document: Document
): JetpackCommentFrame | null {
  for (const element of queryAllDeep(
    document,
    'iframe[src], iframe[data-lazy-src], iframe[data-src]'
  )) {
    if (element.tagName !== 'IFRAME' || !isVisible(element)) continue;
    const url = jetpackCommentFrameUrl(element);
    if (url) return { element: element as HTMLIFrameElement, url };
  }
  return null;
}

// Background worker tabs never scroll the frame into view, so the theme's
// viewport lazy-loader never promotes `data-lazy-src` to `src`. Promote it
// directly so Chrome commits the real frame document and it becomes scriptable.
function promoteJetpackCommentFrame(frame: JetpackCommentFrame): void {
  if (!frame.element.getAttribute('src')) {
    frame.element.setAttribute('src', frame.url);
  }
}

function buildJetpackFrameSummary(
  frame: JetpackCommentFrame
): CommentFormSummary {
  // The in-frame form's real field shape is resolved by re-analyzing inside the
  // frame (page-commands merges it in); these top-document flags are placeholders.
  return {
    readiness: 'ready',
    editorLabel: '',
    submitLabel: '',
    hasNameField: false,
    hasEmailField: false,
    hasWebsiteField: false,
    requiresWebsiteField: false,
    message: 'JETPACK_COMMENT_FRAME',
    frame: { kind: 'jetpack', url: frame.url },
  };
}

function hasUnsupportedCrossOriginCommentFrame(document: Document): boolean {
  return queryAllDeep(
    document,
    'iframe[src], iframe[data-lazy-src], iframe[data-src]'
  ).some((element) => {
    if (!isVisible(element)) return false;
    try {
      // Lazy-loading themes park the frame URL in a data attribute until the
      // frame scrolls into view, so read those before assuming no source.
      const source = new URL(
        element.getAttribute('src') ??
          element.getAttribute('data-lazy-src') ??
          element.getAttribute('data-src') ??
          '',
        element.ownerDocument.baseURI
      );
      if (!/^https?:$/.test(source.protocol)) return false;
      if (source.origin === element.ownerDocument.location.origin) return false;
      return /comment|reply|discussion|disqus|giscus|hyvor/i.test(
        `${source.href} ${elementDescriptor(element)}`
      );
    } catch {
      return false;
    }
  });
}

function queryAllDeep(document: Document, selector: string): Element[] {
  return documentRoots(document).flatMap((root) =>
    Array.from(root.querySelectorAll(selector))
  );
}

function isVerbumSourceEditor(element: Element): boolean {
  return Boolean(
    isTextAreaElement(element) &&
      element.matches('textarea#comment') &&
      element.closest(VERBUM_SHELL_SELECTOR)
  );
}

// The <iframe> in the parent document that hosts `frameDocument`. Real browsers
// expose this directly as `Window.frameElement`; when that is unavailable (or
// not a usable element, as under happy-dom), resolve it by matching
// `contentDocument` against the same-origin parent document's frames.
function ownerFrameElement(frameDocument: Document): HTMLElement | null {
  const view = frameDocument.defaultView;
  if (!view) return null;
  const nativeFrame = view.frameElement;
  if (nativeFrame && isHtmlElement(nativeFrame)) return nativeFrame;
  const parentDocument = view.parent?.document;
  if (!parentDocument || parentDocument === frameDocument) return null;
  for (const frame of Array.from(parentDocument.querySelectorAll('iframe'))) {
    if (
      (frame as HTMLIFrameElement).contentDocument === frameDocument &&
      isHtmlElement(frame)
    ) {
      return frame;
    }
  }
  return null;
}

// `Element.closest()` cannot cross a frame boundary, so an editor hosted inside
// a same-origin iframe (e.g. CKEditor's contenteditable body) can never reach
// its real <form> in the outer document. Climb out of each frame via its owning
// <iframe> element so container/form lookups resolve across the boundary. For
// every non-iframe case the first local `closest()` matches on the first
// iteration, leaving behavior unchanged.
function crossFrameAncestor(
  element: Element,
  selector: string
): HTMLElement | null {
  let current: Element | null = element;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const match = current.closest(selector);
    if (match && isHtmlElement(match)) return match;
    const frameElement = ownerFrameElement(current.ownerDocument);
    if (!frameElement) return null;
    current = frameElement;
  }
  return null;
}

function scoreEditor(element: Element): number {
  if (!isVisible(element) || isDisabled(element))
    return Number.NEGATIVE_INFINITY;
  const descriptor = elementDescriptor(element);
  let score = isTextAreaElement(element) ? 6 : 4;
  if (POSITIVE_EDITOR.test(descriptor)) score += 8;
  if (NEGATIVE_EDITOR.test(descriptor)) score -= 12;
  const container = crossFrameAncestor(
    element,
    'form, section, article, [role="form"]'
  );
  const containerDescriptor = container ? elementDescriptor(container) : '';
  if (POSITIVE_EDITOR.test(containerDescriptor)) score += 5;
  if (NEGATIVE_EDITOR.test(containerDescriptor)) score -= 7;
  if (element.getAttribute('aria-multiline') === 'true') score += 2;
  return score;
}

function findEditor(document: Document): HTMLElement | null {
  const verbumSourceEditor = queryAllDeep(
    document,
    `${VERBUM_SHELL_SELECTOR} textarea#comment`
  )
    .filter(isHtmlElement)
    .find(isVerbumSourceEditor);
  if (verbumSourceEditor) return verbumSourceEditor;
  const candidates = queryAllDeep(document, EDITOR_SELECTOR)
    .filter(isHtmlElement)
    .map((element) => ({ element, score: scoreEditor(element) }))
    .filter((candidate) => candidate.score >= 8)
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.element ?? null;
}

function findContainer(editor: HTMLElement): HTMLElement {
  const form = crossFrameAncestor(editor, 'form');
  if (form) return form;

  let current = editor.parentElement;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (
      current.querySelector('button, input[type="submit"], [role="button"]')
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return editor.parentElement ?? editor;
}

function scoreSubmit(element: Element): number {
  if (!isVisible(element)) return Number.NEGATIVE_INFINITY;
  const descriptor = controlActionDescriptor(element);
  if (
    AUTH_CONTROL.test(descriptor) ||
    NEGATIVE_SUBMIT.test(descriptor) ||
    DESTRUCTIVE_SUBMIT.test(descriptor) ||
    !isPositiveSubmitControl(element)
  ) {
    return Number.NEGATIVE_INFINITY;
  }
  let score = 0;
  if (
    isButtonElement(element) &&
    (element.type === 'submit' || !element.getAttribute('type'))
  ) {
    score += 4;
  }
  if (isInputElement(element) && element.type === 'submit') {
    score += 4;
  }
  score += 8;
  if (isDisabled(element)) score -= 1;
  return score;
}

function findSubmit(container: HTMLElement): HTMLElement | null {
  const candidates = Array.from(
    container.querySelectorAll(
      'button, input[type="submit"], input[type="button"], [role="button"]'
    )
  )
    .filter(isHtmlElement)
    .map((element) => ({ element, score: scoreSubmit(element) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.element ?? null;
}

function readFormSemanticContext(
  editor: HTMLElement,
  container: HTMLElement,
  additionalElements: Element[] = []
): { structuralContext: string; headingCopy: string } {
  const parent = container.parentElement;
  const structuralContext = [
    structuralDescriptor(editor),
    structuralDescriptor(container),
    structuralDescriptor(parent),
    structuralDescriptor(parent?.parentElement ?? null),
    ...additionalElements.map((element) => structuralDescriptor(element)),
  ].join(' ');
  const headingCopy = normalizeWhitespace(
    Array.from(
      (parent ?? container).querySelectorAll('h1, h2, h3, h4, h5, h6, legend')
    )
      .map((element) => visibleTextContent(element))
      .join(' ')
  );

  return { structuralContext, headingCopy };
}

function isConfidentCommentForm(
  editor: HTMLElement,
  container: HTMLElement,
  submit: HTMLElement
): boolean {
  const { structuralContext, headingCopy } = readFormSemanticContext(
    editor,
    container
  );
  const actionContext = `${structuralContext} ${headingCopy}`;
  const explicitCommentControls =
    POSITIVE_EDITOR.test(elementDescriptor(editor)) &&
    STRONG_COMMENT_SUBMIT.test(elementDescriptor(submit));
  const safetyContext = explicitCommentControls
    ? [
        structuralDescriptor(editor, true),
        structuralDescriptor(container, true),
        structuralDescriptor(container.parentElement, true),
        structuralDescriptor(
          container.parentElement?.parentElement ?? null,
          true
        ),
        headingCopy,
        controlActionDescriptor(submit),
      ].join(' ')
    : `${actionContext} ${controlActionDescriptor(submit)}`;
  if (NEGATIVE_EDITOR.test(structuralContext)) return false;
  if (NON_COMMENT_FORM_CONTEXT.test(safetyContext)) return false;
  if (POSITIVE_EDITOR.test(structuralContext)) return true;
  if (COMMENT_HEADING.test(headingCopy)) return true;

  return explicitCommentControls;
}

type InputKind = 'name' | 'email' | 'website';

const WEBSITE_ACCESSIBLE_LABEL =
  /\b(?:website|web(?:[\s_-]?site)?|homepage|url)\b/i;

function associatedInputLabelText(input: HTMLInputElement): string {
  const labels = new Set<Element>();
  for (const label of Array.from(input.labels ?? [])) labels.add(label);
  const wrappingLabel = input.closest('label');
  if (wrappingLabel) labels.add(wrappingLabel);
  if (input.id) {
    for (const label of Array.from(
      input.ownerDocument.querySelectorAll('label[for]')
    )) {
      if (label.getAttribute('for') === input.id) labels.add(label);
    }
  }
  const precedingLabel = input.previousElementSibling;
  if (precedingLabel?.tagName === 'LABEL') labels.add(precedingLabel);

  const labelledBy = input.getAttribute('aria-labelledby') ?? '';
  const referencedText = labelledBy
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => input.ownerDocument.getElementById(id))
    .filter((element): element is HTMLElement => element !== null)
    .map((element) => visibleTextContent(element));

  return normalizeWhitespace(
    [...labels]
      .map((label) => visibleTextContent(label))
      .concat(referencedText)
      .join(' ')
  ).slice(0, 500);
}

function inputSemanticDescriptor(input: HTMLInputElement): string {
  return normalizeWhitespace(
    [
      input.getAttribute('autocomplete'),
      input.getAttribute('inputmode'),
      input.getAttribute('title'),
      input.getAttribute('aria-label'),
      associatedInputLabelText(input),
    ]
      .filter(Boolean)
      .join(' ')
  ).slice(0, 500);
}

function hasAutocompleteToken(input: HTMLInputElement, token: string): boolean {
  return (input.getAttribute('autocomplete') ?? '')
    .toLowerCase()
    .split(/\s+/)
    .includes(token);
}

function acceptsWebsiteValue(input: HTMLInputElement): boolean {
  return ![
    'button',
    'checkbox',
    'color',
    'date',
    'datetime-local',
    'email',
    'file',
    'hidden',
    'image',
    'month',
    'number',
    'password',
    'radio',
    'range',
    'reset',
    'search',
    'submit',
    'tel',
    'time',
    'week',
  ].includes(input.type.toLowerCase());
}
function scoreInput(input: HTMLInputElement, kind: InputKind): number {
  if (!isVisible(input) || input.disabled) return Number.NEGATIVE_INFINITY;
  if (kind === 'website' && !acceptsWebsiteValue(input)) {
    return Number.NEGATIVE_INFINITY;
  }
  const semanticDescriptor = inputSemanticDescriptor(input);
  const descriptor = `${elementDescriptor(input)} ${semanticDescriptor}`;
  const patterns: Record<InputKind, RegExp> = {
    name: /author|display.?name|your.?name|\bname\b|nickname|姓名|昵称|暱稱/i,
    email: /e-?mail|邮箱|郵箱|电子邮件|電子郵件/i,
    website: /website|web.?site|homepage|url|site|网址|網站|主页|主頁/i,
  };
  let score = patterns[kind].test(descriptor) ? 8 : 0;
  if (kind === 'email' && input.type === 'email') score += 8;
  if (kind === 'website') {
    // HTML URL semantics and accessible labels are language-independent (or
    // explicitly associated with this exact control), unlike a broad class/id
    // substring. The nearby comment form still provides the safety boundary.
    if (input.type === 'url') score += 12;
    if (hasAutocompleteToken(input, 'url')) score += 14;
    if (input.inputMode === 'url') score += 4;
    if (WEBSITE_ACCESSIBLE_LABEL.test(semanticDescriptor)) score += 12;
  }
  if (kind === 'name' && /user.?name|login/i.test(descriptor)) score -= 10;
  return score;
}

function findInput(
  container: HTMLElement,
  kind: InputKind
): HTMLInputElement | null {
  const candidates = Array.from(container.querySelectorAll('input'))
    .filter(isInputElement)
    .map((element) => ({ element, score: scoreInput(element, kind) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.element ?? null;
}

type RequiredFormControl =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLSelectElement;

function isRequiredControl(control: RequiredFormControl | null): boolean {
  return Boolean(
    control &&
      (control.required ||
        control.getAttribute('aria-required') === 'true' ||
        control.closest('.required, [data-required="true"]') ||
        hasRequiredLabelMarker(control))
  );
}

function hasRequiredLabelMarker(control: RequiredFormControl): boolean {
  const requiredMarker = /[*＊✱]/u;
  const labels = new Set<HTMLLabelElement>();
  for (const label of Array.from(control.labels ?? [])) labels.add(label);
  const wrappingLabel = control.closest('label');
  if (wrappingLabel?.tagName === 'LABEL') {
    labels.add(wrappingLabel as HTMLLabelElement);
  }
  for (const sibling of Array.from(control.parentElement?.children ?? [])) {
    if (sibling.tagName === 'LABEL') labels.add(sibling as HTMLLabelElement);
  }
  if (
    Array.from(labels).some((label) =>
      requiredMarker.test(visibleTextContent(label))
    )
  ) {
    return true;
  }
  const nearbyElements = [
    control.previousElementSibling,
    control.nextElementSibling,
  ];
  if (
    nearbyElements.some(
      (element) =>
        element !== null &&
        !element.matches(
          'input, textarea, select, button, [contenteditable]'
        ) &&
        requiredMarker.test(visibleTextContent(element))
    )
  ) {
    return true;
  }
  return Array.from(control.parentElement?.childNodes ?? []).some(
    (node) =>
      node.nodeType === Node.TEXT_NODE &&
      requiredMarker.test(node.textContent ?? '')
  );
}

function isRequiredInput(input: HTMLInputElement | null): boolean {
  return isRequiredControl(input);
}

function associatedControlForm(element: HTMLElement): HTMLFormElement | null {
  if (
    isInputElement(element) ||
    isTextAreaElement(element) ||
    isButtonElement(element)
  ) {
    return element.form;
  }
  return element.closest('form');
}

function readMeta(document: Document, names: string[]): string {
  for (const name of names) {
    const element = document.querySelector(
      `meta[name="${name}"], meta[property="${name}"]`
    );
    const content = element?.getAttribute('content');
    if (content?.trim()) return normalizeWhitespace(content);
  }
  return '';
}

function readPageExcerpt(document: Document): string {
  const selectors = [
    'article .entry-content',
    'article',
    '.post-content',
    '.article-content',
    'main',
    '[role="main"]',
    '#content',
    '.entry-content',
  ];
  let fallback = '';
  for (const selector of selectors) {
    for (const source of document.querySelectorAll(selector)) {
      const text = normalizeWhitespace(renderedPageText(source));
      if (text.length >= 200) return text.slice(0, 8_000);
      if (text.length > fallback.length) fallback = text;
    }
  }
  const bodyText = document.body
    ? normalizeWhitespace(renderedPageText(document.body))
    : '';
  return (bodyText.length > fallback.length ? bodyText : fallback).slice(
    0,
    8_000
  );
}

function hasCaptcha(document: Document): boolean {
  return queryAllDeep(document, CAPTCHA_SELECTOR).some(isVisible);
}

// A login-to-comment notice that is not article prose: the copy must sit in a
// short element outside the article body (WordPress and most CMSes render the
// gate adjacent to or inside the comment area, never inside the post content).
// Bare text nodes directly under `body` cover minimal notice-only pages.
function hasLoginGateNotice(document: Document): boolean {
  const bareBodyText = normalizeWhitespace(
    Array.from(document.body?.childNodes ?? [])
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join(' ')
  );
  if (bareBodyText && LOGIN_COPY.test(bareBodyText)) return true;
  for (const candidate of queryAllDeep(
    document,
    'p, div, span, li, label, legend, a'
  )) {
    const text = normalizeWhitespace(candidate.textContent ?? '');
    if (!text || text.length > 300 || !LOGIN_COPY.test(text)) continue;
    if (!isVisible(candidate)) continue;
    if (
      candidate.closest(
        'article, .entry-content, .post-content, .article-content, [itemprop="articleBody"]'
      )
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function hasLoginForm(document: Document): boolean {
  return queryAllDeep(document, 'input[type="password"]')
    .filter(isVisible)
    .some((password) => {
      const container = password.closest('form, [role="form"]');
      if (!container) return false;
      return Array.from(
        container.querySelectorAll(
          'button, input[type="submit"], input[type="button"], [role="button"]'
        )
      ).some(
        (control) =>
          isVisible(control) &&
          AUTH_CONTROL.test(controlActionDescriptor(control))
      );
    });
}

function hasLoginControl(container: HTMLElement): boolean {
  return Array.from(
    container.querySelectorAll(
      'button, input[type="submit"], input[type="button"], [role="button"]'
    )
  ).some(
    (control) =>
      isVisible(control) && AUTH_CONTROL.test(controlActionDescriptor(control))
  );
}

function buildPageContext(document: Document): TargetPageContext {
  const editor = findEditor(document);
  const container = editor ? findContainer(editor) : null;
  return {
    url: document.location?.href ?? '',
    title: normalizeWhitespace(document.title || '').slice(0, 500),
    description: readMeta(document, ['description', 'og:description']).slice(
      0,
      2_000
    ),
    excerpt: readPageExcerpt(document),
    language: (
      document.documentElement.getAttribute('lang')?.trim() ||
      document.defaultView?.navigator.language ||
      'en'
    ).slice(0, 100),
    hasWebsiteField: Boolean(container && findInput(container, 'website')),
  };
}

interface WordPressCommentForm {
  editor: HTMLElement;
  submit: HTMLElement;
}

// The visible canonical editor. Anti-spam themes plant a hidden decoy
// `textarea[name="comment"]` honeypot next to the real `textarea#comment`, so
// filter to visible controls and prefer the `#comment` identity.
function resolveVisibleWordPressEditor(container: Element): HTMLElement | null {
  const candidates = Array.from(
    container.querySelectorAll(WORDPRESS_CANONICAL_EDITOR_SELECTOR)
  ).filter(isHtmlElement);
  const usable = candidates.filter(
    (element) =>
      !isDisabled(element) &&
      (isVisible(element) || isVerbumSourceEditor(element))
  );
  return (
    usable.find((element) => element.matches('#comment')) ?? usable[0] ?? null
  );
}

function resolveVisibleWordPressSubmit(
  container: Element,
  editor: HTMLElement
): HTMLElement | null {
  const scope = editor.closest('form') ?? container;
  return (
    Array.from(scope.querySelectorAll(WORDPRESS_CANONICAL_SUBMIT_SELECTOR))
      .filter(isHtmlElement)
      .find(isVisible) ?? null
  );
}

function resolveWordPressCommentForm(
  document: Document
): WordPressCommentForm | null {
  for (const container of queryAllDeep(
    document,
    WORDPRESS_COMMENT_CONTAINER_SELECTOR
  )) {
    if (!isHtmlElement(container) || !isWordPressCommentContainer(container)) {
      continue;
    }
    const editor = resolveVisibleWordPressEditor(container);
    if (!editor) continue;
    const submit = resolveVisibleWordPressSubmit(container, editor);
    if (submit) return { editor, submit };
  }
  return null;
}

// Authoritative fast path for native WordPress comment forms: bind by canonical
// ids and report `ready` without the score>=8 editor gate, the submit label
// whitelist, or `isConfidentCommentForm`. Still defers to the existing
// login / captcha gates so a genuinely gated form reports the right readiness.
function buildWordPressFormSummary(
  document: Document,
  wpForm: WordPressCommentForm
): CommentFormSummary {
  const container = findContainer(wpForm.editor);
  const websiteInput = findInput(container, 'website');
  const summary: CommentFormSummary = {
    readiness: 'ready',
    editorLabel: structuralDescriptor(wpForm.editor),
    submitLabel: elementDescriptor(wpForm.submit),
    hasNameField: Boolean(findInput(container, 'name')),
    hasEmailField: Boolean(findInput(container, 'email')),
    hasWebsiteField: Boolean(websiteInput),
    requiresWebsiteField: isRequiredInput(websiteInput),
    message: 'COMMENT_FORM_READY',
  };
  if (hasCaptcha(document)) {
    return {
      ...summary,
      readiness: 'captcha_required',
      message: 'CAPTCHA_REQUIRED',
    };
  }
  if (hasLoginGateNotice(document) || hasLoginForm(document)) {
    return {
      ...summary,
      readiness: 'login_required',
      message: 'LOGIN_REQUIRED',
    };
  }
  return summary;
}

function buildFormSummary(document: Document): CommentFormSummary {
  const wpForm = resolveWordPressCommentForm(document);
  if (wpForm) return buildWordPressFormSummary(document, wpForm);
  const jetpackFrame = resolveJetpackCommentFrame(document);
  if (jetpackFrame) return buildJetpackFrameSummary(jetpackFrame);
  const editor = findEditor(document);
  const captcha = hasCaptcha(document);
  if (!editor) {
    if (captcha) {
      return {
        readiness: 'captcha_required',
        editorLabel: '',
        submitLabel: '',
        hasNameField: false,
        hasEmailField: false,
        hasWebsiteField: false,
        message: 'CAPTCHA_REQUIRED',
      };
    }
    if (hasLoginGateNotice(document) || hasLoginForm(document)) {
      return {
        readiness: 'login_required',
        editorLabel: '',
        submitLabel: '',
        hasNameField: false,
        hasEmailField: false,
        hasWebsiteField: false,
        message: 'LOGIN_REQUIRED',
      };
    }
    return {
      readiness: 'not_found',
      editorLabel: '',
      submitLabel: '',
      hasNameField: false,
      hasEmailField: false,
      hasWebsiteField: false,
      message: hasUnsupportedCrossOriginCommentFrame(document)
        ? 'CROSS_ORIGIN_COMMENT_FRAME_UNSUPPORTED'
        : 'COMMENT_FORM_NOT_FOUND',
    };
  }

  const container = findContainer(editor);
  const submit = findSubmit(container);
  const loginGate =
    !submit && (hasLoginGateNotice(document) || hasLoginControl(container));
  const confident = Boolean(
    submit && isConfidentCommentForm(editor, container, submit)
  );
  return {
    readiness: loginGate
      ? 'login_required'
      : !confident
        ? 'not_found'
        : captcha
          ? 'captcha_required'
          : 'ready',
    editorLabel: structuralDescriptor(editor),
    submitLabel: submit ? elementDescriptor(submit) : '',
    hasNameField: Boolean(findInput(container, 'name')),
    hasEmailField: Boolean(findInput(container, 'email')),
    hasWebsiteField: Boolean(findInput(container, 'website')),
    requiresWebsiteField: isRequiredInput(findInput(container, 'website')),
    message: loginGate
      ? 'LOGIN_REQUIRED'
      : !submit
        ? 'SUBMIT_BUTTON_NOT_FOUND'
        : !confident
          ? 'COMMENT_FORM_NOT_FOUND'
          : captcha
            ? 'CAPTCHA_REQUIRED'
            : 'COMMENT_FORM_READY',
  };
}

function buildPageAnalysis(document: Document): PageAnalysis {
  return {
    page: buildPageContext(document),
    form: buildFormSummary(document),
  };
}

function looksUnsettled(document: Document): boolean {
  return document.readyState !== 'complete';
}

interface VerbumWindow extends Window {
  VerbumComments?: { requireNameEmail?: boolean };
}

function hasVerbumShell(document: Document): boolean {
  return Boolean(document.querySelector(VERBUM_SHELL_SELECTOR));
}

function verbumRequiresIdentity(document: Document): boolean {
  return (
    (document.defaultView as VerbumWindow | null)?.VerbumComments
      ?.requireNameEmail === true
  );
}

async function waitWithExponentialBackoff(
  document: Document,
  condition: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const view = document.defaultView;
  const deadline = Date.now() + timeoutMs;
  let delayMs = VERBUM_BACKOFF_INITIAL_MS;
  while (!condition()) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await new Promise<void>((resolve) => {
      (view?.setTimeout ?? setTimeout)(resolve, Math.min(delayMs, remainingMs));
    });
    delayMs = Math.min(delayMs * 2, VERBUM_BACKOFF_MAX_MS);
  }
  return true;
}

function verbumIdentityFieldsReady(document: Document): boolean {
  const editor = findEditor(document);
  if (!editor) return false;
  const container = findContainer(editor);
  return Boolean(findInput(container, 'name') && findInput(container, 'email'));
}

async function revealVerbumIdentityFields(document: Document): Promise<void> {
  if (!verbumRequiresIdentity(document)) return;
  const editor = findEditor(document);
  if (!editor) return;
  editor.focus();
  await waitWithExponentialBackoff(
    document,
    () => verbumIdentityFieldsReady(document),
    VERBUM_IDENTITY_WAIT_TIMEOUT_MS
  );
}

function scrollCommentRegionIntoView(document: Document): void {
  const target: Element | null =
    findEditor(document) ?? document.querySelector(COMMENT_REGION_SELECTOR);
  if (!target) return;
  // Guard: scrollIntoView can be absent under partial / headless DOM impls.
  const scrollIntoView = (target as Partial<HTMLElement>).scrollIntoView;
  if (typeof scrollIntoView !== 'function') return;
  try {
    scrollIntoView.call(target, { block: 'center' });
  } catch {
    // Best-effort nudge to trigger lazy comment mounts; never fatal.
  }
}

function waitForDomContentLoaded(
  document: Document,
  timeoutMs: number
): Promise<void> {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => {
    const view = document.defaultView;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      document.removeEventListener('DOMContentLoaded', finish);
      resolve();
    };
    document.addEventListener('DOMContentLoaded', finish);
    (view?.setTimeout ?? setTimeout)(finish, timeoutMs);
  });
}

function waitForCommentEditor(
  document: Document,
  timeoutMs: number
): Promise<void> {
  if (timeoutMs <= 0 || findEditor(document)) return Promise.resolve();
  return new Promise((resolve) => {
    const view = document.defaultView;
    const Observer = view?.MutationObserver;
    const pending: { timer?: ReturnType<typeof setTimeout> } = {};
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (pending.timer !== undefined) {
        (view?.clearTimeout ?? clearTimeout)(pending.timer);
      }
      resolve();
    };
    const observer = Observer
      ? new Observer(() => {
          if (findEditor(document)) finish();
        })
      : null;
    if (observer && document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
    pending.timer = (view?.setTimeout ?? setTimeout)(finish, timeoutMs);
    if (!observer) finish();
  });
}

function isSamePageAnchor(element: HTMLElement): boolean {
  const href = element.getAttribute('href');
  return (
    !href || href === '#' || href.startsWith('#') || /^javascript:/i.test(href)
  );
}

// One safe control whose only plausible effect is revealing an initially
// absent / hidden comment form. Links that navigate, auth prompts, and
// destructive or social actions are never candidates.
function findCommentRevealControl(document: Document): HTMLElement | null {
  const candidates = queryAllDeep(
    document,
    'button, [role="button"], summary, a'
  )
    .filter(isHtmlElement)
    .map((element) => {
      if (!isVisible(element) || isDisabled(element)) return null;
      if (element.closest('form')) return null;
      const copy = normalizeWhitespace(visibleTextContent(element));
      if (!copy || copy.length > 80 || !REVEAL_COMMENT_COPY.test(copy)) {
        return null;
      }
      const descriptor = controlActionDescriptor(element);
      if (
        AUTH_CONTROL.test(descriptor) ||
        NEGATIVE_SUBMIT.test(descriptor) ||
        DESTRUCTIVE_SUBMIT.test(descriptor) ||
        REVEAL_REJECT.test(descriptor)
      ) {
        return null;
      }
      if (element.tagName === 'A' && !isSamePageAnchor(element)) return null;
      return { element, score: element.tagName === 'A' ? 1 : 2 };
    })
    .filter((candidate): candidate is { element: HTMLElement; score: number } =>
      Boolean(candidate)
    )
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.element ?? null;
}

async function revealHiddenCommentForm(document: Document): Promise<boolean> {
  const control = findCommentRevealControl(document);
  if (!control) return false;
  try {
    control.click();
  } catch {
    return false;
  }
  await waitForCommentEditor(document, ANALYZE_SETTLE_TIMEOUT_MS);
  return true;
}

interface AnalyzePageOptions {
  verbumPreflightTimedOut?: boolean;
}

export async function analyzePageDocument(
  document: Document,
  options: AnalyzePageOptions = {}
): Promise<PageAnalysis> {
  if (document.readyState === 'loading') {
    await waitForDomContentLoaded(
      document,
      ANALYZE_DOM_CONTENT_LOADED_TIMEOUT_MS
    );
  }
  scrollCommentRegionIntoView(document);
  const jetpackFrame = resolveJetpackCommentFrame(document);
  if (jetpackFrame) promoteJetpackCommentFrame(jetpackFrame);
  const verbum = hasVerbumShell(document);
  let verbumTimedOut = false;
  if (verbum && !resolveWordPressCommentForm(document)) {
    const initial = buildPageAnalysis(document);
    const manuallyGated =
      initial.form.readiness === 'login_required' ||
      initial.form.readiness === 'captcha_required';
    if (!manuallyGated) {
      verbumTimedOut = !(await waitWithExponentialBackoff(
        document,
        () => Boolean(resolveWordPressCommentForm(document)),
        options.verbumPreflightTimedOut
          ? VERBUM_PREFLIGHT_HANDOFF_TIMEOUT_MS
          : VERBUM_FORM_WAIT_TIMEOUT_MS
      ));
      scrollCommentRegionIntoView(document);
    }
  }
  if (verbum && !verbumTimedOut) {
    await revealVerbumIdentityFields(document);
  }
  let analysis = buildPageAnalysis(document);
  // Only pay the bounded settle when nothing was found and the page still looks
  // like it is mounting content; a fully loaded page with no editor is final.
  if (!verbum && !findEditor(document) && looksUnsettled(document)) {
    await waitForCommentEditor(document, ANALYZE_SETTLE_TIMEOUT_MS);
    scrollCommentRegionIntoView(document);
    analysis = buildPageAnalysis(document);
  }
  if (verbumTimedOut && analysis.form.readiness === 'not_found') {
    return {
      ...analysis,
      form: {
        ...analysis.form,
        message: 'VERBUM_COMMENT_FORM_TIMEOUT',
      },
    };
  }
  // The form may still hide behind a "Leave a comment" style toggle. Click at
  // most one reveal control per analyze; verify never runs this path.
  if (
    analysis.form.readiness === 'not_found' &&
    (await revealHiddenCommentForm(document))
  ) {
    scrollCommentRegionIntoView(document);
    return buildPageAnalysis(document);
  }
  return analysis;
}

function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string
) {
  const prototype = Object.getPrototypeOf(element) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  const EventConstructor = element.ownerDocument.defaultView?.Event ?? Event;
  element.dispatchEvent(new EventConstructor('input', { bubbles: true }));
  element.dispatchEvent(new EventConstructor('change', { bubbles: true }));
}

function setEditorValue(editor: HTMLElement, value: string): void {
  if (isTextAreaElement(editor) || isInputElement(editor)) {
    setNativeValue(editor, value);
    const view = editor.ownerDocument.defaultView;
    editor.dispatchEvent(
      new (view?.KeyboardEvent ?? KeyboardEvent)('keyup', { bubbles: true })
    );
    return;
  }
  editor.focus();
  editor.textContent = value;
  const view = editor.ownerDocument.defaultView;
  const InputEventConstructor = view?.InputEvent;
  editor.dispatchEvent(
    InputEventConstructor
      ? new InputEventConstructor('input', {
          bubbles: true,
          inputType: 'insertText',
          data: value,
        })
      : new (view?.Event ?? Event)('input', { bubbles: true })
  );
  editor.dispatchEvent(new (view?.Event ?? Event)('change', { bubbles: true }));
}

function readEditorValue(editor: HTMLElement): string {
  if (isTextAreaElement(editor) || isInputElement(editor)) {
    return editor.value;
  }
  return editor.textContent ?? '';
}

function fingerprintFor(comment: string): string {
  return normalizeWhitespace(comment).slice(0, 80);
}

const REQUIRED_BODY_ANCHOR = /<a\s+href=(["'])([\s\S]*?)\1>([^<>\r\n]+)<\/a>/gi;

function comparableHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

function hasRequiredBodyAnchor(comment: string, websiteUrl: string): boolean {
  const anchors = [...comment.matchAll(REQUIRED_BODY_ANCHOR)];
  const promotedUrl = extractPromotedUrl(comment);
  return (
    anchors.length === 1 &&
    Boolean(anchors[0]?.[3]?.trim()) &&
    !comment.includes('{LINK}') &&
    comparableHttpUrl(promotedUrl ?? '') === comparableHttpUrl(websiteUrl) &&
    comparableHttpUrl(websiteUrl) !== null
  );
}

function comparablePageUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

function readPageFeedbackMessages(
  document: Document,
  scope?: (element: Element) => boolean
): string[] {
  const selectors = [
    '[role="alert"]',
    '[role="status"]',
    '[aria-live]',
    '.alert',
    '.message',
    '.notice',
    '.notification',
    '.status',
    '.success',
    '.error',
    '.toast',
    '.flash-message',
    '.comment-awaiting-moderation',
  ];
  const semanticElements = new Set<Element>();
  for (const selector of selectors) {
    for (const element of queryAllDeep(document, selector)) {
      semanticElements.add(element);
    }
  }
  const genericElements = new Set<Element>();
  for (const candidate of queryAllDeep(document, 'p, div, span, li')) {
    const rawText = normalizeWhitespace(candidate.textContent ?? '');
    if (
      SUCCESS_COPY.test(rawText) ||
      PENDING_COPY.test(rawText) ||
      ERROR_COPY.test(rawText)
    ) {
      if (!semanticElements.has(candidate)) genericElements.add(candidate);
    }
  }
  const inScope = scope ?? (() => true);
  const semanticMessages = Array.from(semanticElements)
    .filter((element) => isVisible(element) && inScope(element))
    .map((element) => normalizeWhitespace(visibleTextContent(element)))
    .filter(Boolean);
  const genericMessages = Array.from(genericElements)
    .filter((element) => isVisible(element) && inScope(element))
    .map((element) => normalizeWhitespace(visibleTextContent(element)))
    .filter(
      (message) =>
        message.length <= MAX_FEEDBACK_MESSAGE_LENGTH &&
        (SUCCESS_COPY.test(message) ||
          PENDING_COPY.test(message) ||
          ERROR_COPY.test(message))
    );
  return [...semanticMessages, ...genericMessages]
    .map((message) => message.slice(0, MAX_FEEDBACK_MESSAGE_LENGTH))
    .slice(-MAX_FEEDBACK_MESSAGES);
}

function renderedCommentExists(
  document: Document,
  fingerprint: string
): boolean {
  if (!fingerprint) return false;
  const candidates = new Set(queryAllDeep(document, RENDERED_COMMENT_SELECTOR));
  // A few WordPress themes put the actual comment body in a generic block
  // inside a semantic comment region. Include those blocks as a fallback.
  for (const element of queryAllDeep(
    document,
    'article, li, section, div, p'
  )) {
    if (containsRenderedFingerprint(element.textContent ?? '', fingerprint)) {
      candidates.add(element);
    }
  }
  return Array.from(candidates).some((element) => {
    if (
      !containsRenderedFingerprint(element.textContent ?? '', fingerprint) ||
      element.matches('form, textarea, input, [contenteditable="true"]') ||
      element.querySelector(`form, ${EDITOR_SELECTOR}`) ||
      hasExcludedRenderedCommentContext(element) ||
      !isVisible(element)
    ) {
      return false;
    }
    return containsRenderedFingerprint(
      visibleTextContent(element),
      fingerprint
    );
  });
}

function renderedTargetWebsiteExists(
  document: Document,
  targetWebsiteUrl?: string
): boolean {
  const expected = comparableHttpUrl(targetWebsiteUrl ?? '');
  if (!expected) return false;
  return queryAllDeep(document, 'a[href]').some((element) => {
    if (element.tagName !== 'A' || !isVisible(element)) {
      return false;
    }
    const href = element.getAttribute('href') ?? '';
    let resolvedHref: string;
    try {
      resolvedHref = new URL(href, element.ownerDocument.baseURI).href;
    } catch {
      return false;
    }
    return (
      comparableHttpUrl(resolvedHref) === expected &&
      Boolean(findRenderedCommentContainer(element))
    );
  });
}

function findRenderedCommentContainer(element: Element): Element | null {
  let current: Element | null = element;
  while (current) {
    if (current.matches('form, [role="form"]')) return null;
    if (
      current.matches(RENDERED_COMMENT_SELECTOR) &&
      !hasExcludedRenderedCommentContext(current)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function containsFingerprintWords(text: string, fingerprint: string): boolean {
  const haystack = normalizeFingerprintText(text);
  const words = normalizeFingerprintText(fingerprint)
    .split(/\s+/)
    .filter(Boolean);
  let offset = 0;
  for (const word of words) {
    const index = haystack.indexOf(word, offset);
    if (index < 0) return false;
    offset = index + word.length;
  }
  return words.length > 0;
}

// Renderers may change curly quotes, dash characters, NBSPs, zero-width
// characters, and Unicode normalization while inserting the comment.
function normalizeFingerprintText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function containsRenderedFingerprint(
  text: string,
  fingerprint: string
): boolean {
  const haystack = normalizeFingerprintText(text);
  const needle = normalizeFingerprintText(fingerprint);
  return Boolean(
    needle &&
      (haystack.includes(needle) || containsFingerprintWords(haystack, needle))
  );
}

function hasExcludedRenderedCommentContext(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (
      current.matches(
        'form, [role="form"], textarea, input, [contenteditable="true"]'
      )
    ) {
      return true;
    }
    const descriptor = structuralDescriptor(current).replace(
      /([a-z\d])([A-Z])/g,
      '$1 $2'
    );
    if (RENDERED_COMMENT_EXCLUDE.test(descriptor)) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

// The comment form's container (and any ancestor that reads as a comment
// region) is where a genuine validation error renders. Late-loading page
// chrome — newsletter widgets, static "Required fields are marked *" notes —
// lives outside it and must not be able to fail a submission.
function buildCommentScope(document: Document): (element: Element) => boolean {
  const editor = findEditor(document);
  const container = editor ? findContainer(editor) : null;
  return (element) => {
    if (container?.contains(element)) return true;
    let current: Element | null = element;
    while (current) {
      if (current.matches(COMMENT_REGION_SELECTOR)) return true;
      current = current.parentElement;
    }
    return false;
  };
}

function diffNewFeedbackMessages(
  messages: string[],
  baseline?: PageSubmissionBaseline
): string[] {
  const previousCounts = new Map<string, number>();
  for (const message of baseline?.feedbackMessages ?? []) {
    previousCounts.set(message, (previousCounts.get(message) ?? 0) + 1);
  }

  const newMessages: string[] = [];
  for (const message of messages) {
    const exactMatches = previousCounts.get(message) ?? 0;
    if (exactMatches > 0) {
      previousCounts.set(message, exactMatches - 1);
      continue;
    }
    const containingMessage = Array.from(previousCounts).find(
      ([previous, count]) => count > 0 && message.includes(previous)
    );
    if (containingMessage) {
      previousCounts.set(containingMessage[0], containingMessage[1] - 1);
      const index = message.indexOf(containingMessage[0]);
      const addedText = normalizeWhitespace(
        `${message.slice(0, index)} ${message.slice(index + containingMessage[0].length)}`
      );
      if (addedText) newMessages.push(addedText);
      continue;
    }
    newMessages.push(message);
  }
  return newMessages;
}

function readNewPageFeedbackMessages(
  document: Document,
  baseline?: PageSubmissionBaseline
): string[] {
  return diffNewFeedbackMessages(readPageFeedbackMessages(document), baseline);
}

// WordPress redirects a comment held for moderation to
// `?unapproved=<ID>&moderation-hash=<hash>`, a deterministic, language-proof
// "accepted into moderation" receipt. (The approved-comment `#comment-<ID>`
// anchor receipt is handled in command.ts, which can compare it against the
// pre-submit URL to reject a pre-existing anchor.)
function hasWordPressModerationReceipt(document: Document): boolean {
  const href = document.location?.href;
  if (!href) return false;
  try {
    const url = new URL(href);
    return (
      url.searchParams.has('unapproved') &&
      url.searchParams.has('moderation-hash')
    );
  } catch {
    return false;
  }
}

export function verifySubmissionDocument(
  document: Document,
  fingerprint: string,
  baseline?: PageSubmissionBaseline,
  targetUrl?: string,
  expectedUrl?: string
): PageSubmissionResult {
  const finalize = (result: PageSubmissionResult): PageSubmissionResult =>
    attachLinkFollow(result, document, targetUrl, fingerprint);
  const form = buildFormSummary(document);
  if (
    form.readiness === 'login_required' ||
    form.readiness === 'captcha_required'
  ) {
    return finalize({
      status: form.readiness,
      message: form.message,
      fingerprint,
      clickOccurred: true,
    });
  }
  const feedbackMessages = readNewPageFeedbackMessages(document, baseline);
  const feedback = feedbackMessages.join(' ');
  const feedbackChanged = feedback.length > 0;
  const renderedComment = renderedCommentExists(document, fingerprint);
  const currentEditor = findEditor(document);
  const currentEditorValue = currentEditor
    ? normalizeWhitespace(readEditorValue(currentEditor))
    : null;
  const draftStillInEditor = Boolean(currentEditorValue?.includes(fingerprint));
  const renderedCommentAdded =
    renderedComment &&
    !(baseline?.renderedComment ?? false) &&
    !draftStillInEditor;
  const renderedTargetWebsite = renderedTargetWebsiteExists(
    document,
    targetUrl
  );
  const pendingFeedback = feedbackChanged && PENDING_COPY.test(feedback);
  const successFeedback = feedbackChanged && SUCCESS_COPY.test(feedback);
  const scopedFeedback = diffNewFeedbackMessages(
    readPageFeedbackMessages(document, buildCommentScope(document)),
    baseline
  ).join(' ');
  const errorFeedback =
    scopedFeedback.length > 0 && ERROR_COPY.test(scopedFeedback);
  const bodyCopy = document.body
    ? normalizeWhitespace(renderedPageText(document.body))
    : '';
  const duplicateComment =
    DUPLICATE_COMMENT_COPY.test(feedback) ||
    DUPLICATE_COMMENT_COPY.test(bodyCopy);
  const receipt = expectedUrl
    ? getWordPressSubmitReceipt(document.location.href, expectedUrl)
    : hasWordPressModerationReceipt(document)
      ? 'pending_moderation'
      : null;
  // WordPress duplicate-comment rejection: an explicit terminal error.
  if (
    duplicateComment &&
    !pendingFeedback &&
    !receipt &&
    !renderedCommentAdded
  ) {
    return finalize({
      status: 'validation_error',
      message: 'COMMENT_DUPLICATE',
      fingerprint,
      clickOccurred: true,
    });
  }
  // Public display is intentionally proved by one signal only: the promoted
  // website URL is rendered as a visible link inside a comment container.
  if (renderedTargetWebsite) {
    return finalize({
      status: 'published',
      message: 'COMMENT_PUBLISHED_RENDERED_TARGET_URL',
      fingerprint,
      clickOccurred: true,
    });
  }
  // A WordPress redirect carrying a fresh `#comment-<id>` anchor proves the
  // server took the comment and gave it an id. It does not prove any visitor
  // can see it: sites that hold or spam-file a comment still redirect to its
  // anchor. Publication is decided by an anonymous read, outside this document.
  if (receipt === 'published') {
    return finalize({
      status: 'unconfirmed',
      message: 'COMMENT_ACCEPTED_AWAITING_PUBLIC_CHECK',
      fingerprint,
      clickOccurred: true,
      acceptance: 'server_receipt',
    });
  }
  // WordPress moderation receipts and fresh moderation feedback prove server
  // acceptance, but intentionally do not claim the comment is public yet.
  if (receipt === 'pending_moderation' || pendingFeedback) {
    return finalize({
      status: 'pending_moderation',
      message:
        receipt === 'pending_moderation'
          ? 'COMMENT_PENDING_WORDPRESS_MODERATION'
          : 'COMMENT_PENDING_MODERATION_FEEDBACK',
      fingerprint,
      clickOccurred: true,
    });
  }
  if (errorFeedback && !successFeedback && !renderedTargetWebsite) {
    return finalize({
      status: 'validation_error',
      message: scopedFeedback.slice(0, 240) || 'COMMENT_SUBMISSION_FAILED',
      fingerprint,
      clickOccurred: true,
    });
  }
  // The comment rendered into this session's copy of the page. WordPress shows
  // a held comment to its own author, so this is acceptance evidence only, and
  // it too hands the verdict to the anonymous read.
  if (renderedCommentAdded) {
    return finalize({
      status: 'unconfirmed',
      message: 'COMMENT_ACCEPTED_AWAITING_PUBLIC_CHECK',
      fingerprint,
      clickOccurred: true,
      acceptance: 'rendered_locally',
    });
  }
  // A click (or generic "thanks" copy) is not a receipt of either public
  // display or moderation acceptance. Keep it as an explicit unknown outcome
  // rather than silently promoting it to submitted.
  return finalize({
    status: 'unconfirmed',
    message: 'COMMENT_SUBMISSION_UNCONFIRMED',
    fingerprint,
    clickOccurred: true,
  });
}

// A WordPress.com site with the subscription box enabled never navigates on
// submit: Verbum posts the comment with `fetch` and then offers a subscription,
// holding the receipt (and its comment id) until that box is dismissed. Its
// close control does nothing but navigate to the comment that was just posted,
// so clicking it hands back the same receipt every other form produces. The
// email field and its Subscribe button are never touched.
const VERBUM_SUBSCRIBE_CLOSE_SELECTOR =
  '.verbum-simple-subscribe-modal__close-button';

function dismissVerbumSubscribeBox(document: Document): boolean {
  const close = document.querySelector(VERBUM_SUBSCRIBE_CLOSE_SELECTOR);
  if (!close || !isHtmlElement(close) || !isVisible(close)) return false;
  try {
    close.click();
  } catch {
    return false;
  }
  return true;
}

// Re-runs the full verdict until it is decisive or the window closes. Success
// copy alone is deliberately not an exit condition: banners routinely render
// before the comment node (and its promoted link) are inserted, and a verdict
// taken at that moment reads as a false `unconfirmed`.
async function pollSubmissionVerdict(
  document: Document,
  prepared: PreparedPageSubmission,
  waitMs: number
): Promise<PageSubmissionResult> {
  const targetUrl = extractPromotedUrl(prepared.comment) ?? undefined;
  const view = document.defaultView;
  const deadline = Date.now() + Math.max(waitMs, 0);
  let subscribeBoxDismissed = false;
  for (;;) {
    if (!subscribeBoxDismissed) {
      subscribeBoxDismissed = dismissVerbumSubscribeBox(document);
    }
    const result = verifySubmissionDocument(
      document,
      prepared.fingerprint,
      prepared.baseline,
      targetUrl,
      prepared.expected.url
    );
    const remaining = deadline - Date.now();
    if (result.status !== 'unconfirmed' || remaining <= 0) return result;
    await new Promise<void>((resolve) => {
      (view?.setTimeout ?? setTimeout)(
        resolve,
        Math.min(SUBMIT_VERIFY_POLL_INTERVAL_MS, remaining)
      );
    });
  }
}

export async function prepareSubmissionDocument(
  document: Document,
  input: PageSubmissionInput,
  expected?: PageSubmissionExpectation
): Promise<PageSubmissionPreparation> {
  const fingerprint = fingerprintFor(input.comment);
  if (
    input.requireInlineAnchor &&
    !hasRequiredBodyAnchor(input.comment, input.websiteUrl)
  ) {
    return preparationError(
      'validation_error',
      'COMMENT_BODY_LINK_REQUIRED',
      fingerprint
    );
  }
  const analysis: PageAnalysis = {
    page: buildPageContext(document),
    form: buildFormSummary(document),
  };
  if (expected && analysis.form.hasWebsiteField !== expected.hasWebsiteField) {
    return preparationError(
      'validation_error',
      'LINK_PLACEMENT_CHANGED',
      fingerprint
    );
  }
  if (
    expected &&
    comparablePageUrl(analysis.page.url) !== comparablePageUrl(expected.url)
  ) {
    return preparationError(
      'validation_error',
      'PAGE_CHANGED_SINCE_GENERATION',
      fingerprint
    );
  }
  if (analysis.form.readiness === 'login_required') {
    return preparationError('login_required', 'LOGIN_REQUIRED', fingerprint);
  }
  if (analysis.form.readiness === 'captcha_required') {
    return preparationError(
      'captcha_required',
      'CAPTCHA_REQUIRED',
      fingerprint
    );
  }
  if (analysis.form.readiness !== 'ready') {
    return preparationError(
      'validation_error',
      analysis.form.message,
      fingerprint
    );
  }

  const editor = findEditor(document);
  if (!editor) {
    return preparationError(
      'validation_error',
      'COMMENT_FORM_NOT_FOUND',
      fingerprint
    );
  }
  const container = findContainer(editor);
  const submit = findSubmit(container);
  if (!submit) {
    return preparationError(
      'validation_error',
      'SUBMIT_BUTTON_NOT_FOUND',
      fingerprint
    );
  }
  const displayName = input.displayName?.trim() ?? '';
  const email = input.email?.trim() ?? '';
  const websiteUrl = input.websiteUrl.trim();
  const nameInput = findInput(container, 'name');
  const emailInput = findInput(container, 'email');
  const websiteInput = findInput(container, 'website');
  if (isRequiredInput(nameInput) && !displayName) {
    return preparationError(
      'validation_error',
      'DISPLAY_NAME_REQUIRED',
      fingerprint
    );
  }
  if (isRequiredInput(emailInput) && !email) {
    return preparationError('validation_error', 'EMAIL_REQUIRED', fingerprint);
  }
  if (websiteInput && isRequiredInput(websiteInput) && !websiteUrl) {
    return preparationError(
      'validation_error',
      'WEBSITE_REQUIRED',
      fingerprint
    );
  }

  const existingSubmission = activeDomSubmissions.get(document);
  if (existingSubmission && existingSubmission.expiresAt > Date.now()) {
    return preparationError(
      'validation_error',
      'SUBMISSION_ALREADY_IN_PROGRESS',
      fingerprint
    );
  }
  if (existingSubmission) {
    releaseDomSubmission(document, existingSubmission.token);
  }
  const tokenBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const domToken = Array.from(tokenBytes, (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  activeDomSubmissions.set(document, {
    token: domToken,
    expiresAt: Date.now() + PREPARATION_TTL_MS,
  });

  try {
    setEditorValue(editor, input.comment);
    if (nameInput) setNativeValue(nameInput, displayName);
    if (emailInput) setNativeValue(emailInput, email);
    if (websiteInput) {
      setNativeValue(websiteInput, websiteUrl);
    }

    await waitForEnabledSubmit(document);

    // Re-find the live controls after the page has settled. Dynamic themes
    // often replace the form nodes after input events, so DOM identity and
    // class/attribute descriptors are deliberately not treated as content
    // validation signals.
    const currentEditor = findEditor(document);
    const currentContainer = currentEditor
      ? findContainer(currentEditor)
      : null;
    const currentSubmit = currentContainer
      ? findSubmit(currentContainer)
      : null;
    const currentWebsiteInput = currentContainer
      ? findInput(currentContainer, 'website')
      : null;
    if (
      !currentEditor ||
      !currentSubmit ||
      isDisabled(currentSubmit) ||
      Boolean(currentWebsiteInput) !== analysis.form.hasWebsiteField ||
      normalizeWhitespace(readEditorValue(currentEditor)) !==
        normalizeWhitespace(input.comment) ||
      (currentWebsiteInput !== null && currentWebsiteInput.value !== websiteUrl)
    ) {
      releaseDomSubmission(document, domToken);
      return preparationError(
        'validation_error',
        'PAGE_CHANGED_SINCE_GENERATION',
        fingerprint
      );
    }
    const baseline: PageSubmissionBaseline = {
      feedbackMessages: readPageFeedbackMessages(document),
      renderedComment: renderedCommentExists(document, fingerprint),
    };

    return {
      ok: true,
      prepared: {
        fingerprint,
        comment: input.comment,
        websiteUrl,
        domToken,
        baseline,
        expected: expected ?? {
          url: analysis.page.url,
          editorLabel: analysis.form.editorLabel,
          submitLabel: analysis.form.submitLabel,
          hasWebsiteField: analysis.form.hasWebsiteField,
        },
      },
    };
  } catch (error) {
    releaseDomSubmission(document, domToken);
    throw error;
  }
}

export async function clickPreparedSubmissionDocument(
  document: Document,
  prepared: PreparedPageSubmission,
  waitMs = SUBMIT_VERIFY_WINDOW_MS
): Promise<PageSubmissionResult> {
  const analysis: PageAnalysis = {
    page: buildPageContext(document),
    form: buildFormSummary(document),
  };
  if (
    comparablePageUrl(analysis.page.url) !==
    comparablePageUrl(prepared.expected.url)
  ) {
    releaseDomSubmission(document, prepared.domToken);
    return {
      status: 'validation_error',
      message: 'PAGE_CHANGED_SINCE_GENERATION',
      fingerprint: prepared.fingerprint,
      clickOccurred: false,
    };
  }
  if (analysis.form.readiness !== 'ready') {
    releaseDomSubmission(document, prepared.domToken);
    return {
      status:
        analysis.form.readiness === 'login_required' ||
        analysis.form.readiness === 'captcha_required'
          ? analysis.form.readiness
          : 'validation_error',
      message: analysis.form.message,
      fingerprint: prepared.fingerprint,
      clickOccurred: false,
    };
  }

  const editor = findEditor(document);
  const currentContainer = editor ? findContainer(editor) : null;
  const submit = currentContainer ? findSubmit(currentContainer) : null;
  const websiteInput = currentContainer
    ? findInput(currentContainer, 'website')
    : null;
  const activeSubmission = activeDomSubmissions.get(document);
  const expectedWebsiteUrl =
    prepared.websiteUrl ?? extractPromotedUrl(prepared.comment);
  // The lease only arbitrates genuinely concurrent preparations in this
  // content-script instance. A background wake, content-script reinjection,
  // or a slow page can legitimately lose/expire the in-memory lease while the
  // visible semantic form state remains exactly what we prepared. In that
  // case the URL, comment, Website value and enabled submit control below are
  // the authoritative click guard.
  const hasConflictingLivePreparation = Boolean(
    activeSubmission &&
      activeSubmission.expiresAt > Date.now() &&
      activeSubmission.token !== prepared.domToken
  );
  if (
    !editor ||
    !submit ||
    isDisabled(submit) ||
    hasConflictingLivePreparation ||
    Boolean(websiteInput) !== prepared.expected.hasWebsiteField ||
    normalizeWhitespace(readEditorValue(editor)) !==
      normalizeWhitespace(prepared.comment) ||
    (websiteInput !== null &&
      (expectedWebsiteUrl?.trim()
        ? comparableHttpUrl(websiteInput.value) !==
          comparableHttpUrl(expectedWebsiteUrl)
        : websiteInput.value.trim() !== ''))
  ) {
    releaseDomSubmission(document, prepared.domToken);
    return {
      status: 'validation_error',
      message: 'PAGE_CHANGED_SINCE_GENERATION',
      fingerprint: prepared.fingerprint,
      clickOccurred: false,
    };
  }

  try {
    submit.click();
    return await pollSubmissionVerdict(document, prepared, waitMs);
  } finally {
    releaseDomSubmission(document, prepared.domToken);
  }
}

export async function fillAndSubmitDocument(
  document: Document,
  input: PageSubmissionInput,
  waitMs = SUBMIT_VERIFY_WINDOW_MS,
  expected?: PageSubmissionExpectation
): Promise<PageSubmissionResult> {
  const preparation = await prepareSubmissionDocument(
    document,
    input,
    expected
  );
  if (!preparation.ok) return preparation.result;
  return clickPreparedSubmissionDocument(
    document,
    preparation.prepared,
    waitMs
  );
}

function waitForDomSettle(document: Document): Promise<void> {
  return new Promise((resolve) => {
    (document.defaultView?.setTimeout ?? setTimeout)(resolve, DOM_SETTLE_MS);
  });
}

async function waitForEnabledSubmit(document: Document): Promise<void> {
  const deadline = Date.now() + SUBMIT_ENABLE_TIMEOUT_MS;
  do {
    await waitForDomSettle(document);
    const editor = findEditor(document);
    const submit = editor ? findSubmit(findContainer(editor)) : null;
    if (submit && !isDisabled(submit)) {
      return;
    }
  } while (Date.now() < deadline);
}

function preparationError(
  status: PageSubmissionResult['status'],
  message: string,
  fingerprint: string
): PageSubmissionPreparation {
  return {
    ok: false,
    result: { status, message, fingerprint, clickOccurred: false },
  };
}

function releaseDomSubmission(document: Document, token: string): void {
  if (activeDomSubmissions.get(document)?.token === token) {
    activeDomSubmissions.delete(document);
  }
}
