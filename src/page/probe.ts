import { isVisible } from './visibility';

export type SafeAttributeMap = Record<string, string>;

export interface PageFormCandidate {
  formId: string;
  tag: 'form' | 'region';
  attributes: SafeAttributeMap;
  headings?: string[];
  controlCandidateIds: string[];
}

export interface PageControlCandidate {
  candidateId: string;
  formId: string | null;
  tag: string;
  type: string;
  attributes: SafeAttributeMap;
  labels: string[];
  nearbyText: string[];
  headings?: string[];
  ancestorTokens: string[];
  requiredSignals: string[];
  visible: boolean;
  enabled: boolean;
  hasValue: boolean;
}

export interface PageProbeSnapshot {
  snapshotId: string;
  url: string;
  formCandidates: PageFormCandidate[];
  controlCandidates: PageControlCandidate[];
}

interface ProbeSessionCandidate {
  element: HTMLElement;
  evidenceFingerprint: string;
}

interface ProbeSession {
  snapshotId: string;
  candidates: Map<string, ProbeSessionCandidate>;
  frameAnchors: Map<Document, HTMLIFrameElement>;
}

const probeSessions = new WeakMap<Document, ProbeSession>();

const CONTROL_SELECTOR = [
  'input',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
  'button',
  '[role="button"]',
].join(',');

const CONTROL_ATTRIBUTES = [
  'id',
  'name',
  'type',
  'autocomplete',
  'placeholder',
  'aria-label',
  'aria-labelledby',
  'aria-required',
  'role',
  'class',
  'form',
  'formaction',
  'formmethod',
] as const;

const FORM_ATTRIBUTES = [
  'id',
  'name',
  'method',
  'action',
  'role',
  'aria-label',
  'aria-labelledby',
  'class',
] as const;
const MAX_FORM_CANDIDATES = 40;
const MAX_CONTROL_CANDIDATES = 120;
const MAX_ARIA_LABEL_REFERENCES = 8;
const MAX_TEXT_EVIDENCE = 8;
const VOLATILE_STATE_CLASS =
  /^(?:active|disabled|enabled|error|filled|focus|focused|has-error|has-focus|has-success|has-value|invalid|is-active|is-disabled|is-enabled|is-error|is-filled|is-focused|is-invalid|is-loading|is-pending|is-submitting|is-valid|loading|ng-dirty|ng-invalid|ng-pending|ng-pristine|ng-submitted|ng-touched|ng-untouched|ng-valid|pending|submitted|submitting|success|touched|untouched|user-invalid|user-valid|valid|visited)$/i;
const STABLE_EVIDENCE_ATTRIBUTES = new Set([
  'id',
  'name',
  'type',
  'autocomplete',
  'placeholder',
  'aria-label',
  'aria-labelledby',
  'aria-required',
  'role',
  'form',
  'formaction',
  'formmethod',
  'required',
  'hidden',
  'contenteditable',
  'method',
  'action',
  'class',
]);

function isInputElement(element: Element): element is HTMLInputElement {
  return element.tagName === 'INPUT';
}

function isTextAreaElement(element: Element): element is HTMLTextAreaElement {
  return element.tagName === 'TEXTAREA';
}

function isButtonElement(element: Element): element is HTMLButtonElement {
  return element.tagName === 'BUTTON';
}

function isHtmlElement(element: Element): element is HTMLElement {
  return element.namespaceURI === 'http://www.w3.org/1999/xhtml';
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function semanticClassNames(element: Element): string[] {
  return [...element.classList]
    .filter((className) => !VOLATILE_STATE_CLASS.test(className))
    .slice(0, 8)
    .map(normalizeText)
    .filter(Boolean);
}

function uniqueText(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map(normalizeText).filter(Boolean))].slice(
    0,
    MAX_TEXT_EVIDENCE
  );
}

function safeAttributeValue(
  element: Element,
  name: string,
  rawValue: string
): string {
  if (name === 'class') return semanticClassNames(element).join(' ');
  if (name === 'aria-labelledby') {
    return rawValue
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, MAX_ARIA_LABEL_REFERENCES)
      .join(' ');
  }
  if (name !== 'action' && name !== 'formaction') return rawValue;
  if (!rawValue.trim()) return '';
  try {
    const url = new URL(rawValue, element.ownerDocument.baseURI);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // Preserve a bounded structural path when the page uses a non-URL value.
  }
  return rawValue.split(/[?#]/, 1)[0] ?? '';
}

function readStaticText(element: Element | null): string | null {
  if (!element) return null;
  if (element.matches('input, textarea, [contenteditable]')) return null;
  const copy = element.cloneNode(true) as Element;
  for (const control of copy.querySelectorAll(
    'input, textarea, [contenteditable]'
  )) {
    control.remove();
  }
  return copy.textContent;
}

function readAttributes(
  element: Element,
  allowed: readonly string[]
): SafeAttributeMap {
  const attributes: SafeAttributeMap = {};
  for (const name of allowed) {
    const rawValue = element.getAttribute(name);
    if (rawValue === null) continue;
    const value = normalizeText(safeAttributeValue(element, name, rawValue));
    if (name === 'class' && !value) continue;
    attributes[name] = value;
  }
  return attributes;
}

function readLabels(element: Element): string[] {
  const root = element.getRootNode() as Document | ShadowRoot;
  const id = element.getAttribute('id');
  const nativeLabels =
    'labels' in element
      ? Array.from(
          (element as Element & { labels?: NodeListOf<HTMLLabelElement> })
            .labels ?? []
        )
      : [];
  const explicitLabels =
    nativeLabels.length > 0
      ? nativeLabels.map(readStaticText)
      : id
        ? [...root.querySelectorAll<HTMLLabelElement>('label[for]')]
            .filter((label) => label.htmlFor === id)
            .map(readStaticText)
        : [];
  const wrappingLabel = readStaticText(element.closest('label'));
  const ariaLabel = element.getAttribute('aria-label');
  const labelledBy = (element.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_ARIA_LABEL_REFERENCES)
    .map((labelId) => readStaticText(root.getElementById(labelId)));

  return uniqueText([
    ...explicitLabels,
    wrappingLabel,
    ariaLabel,
    ...labelledBy,
  ]);
}

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6, legend';
const HEADING_BOUNDARY_SELECTOR = 'form, section, article, [role="form"]';

function ownHeadings(element: HTMLElement): Element[] {
  if (element.matches(HEADING_SELECTOR)) return [element];
  return Array.from(element.children).flatMap((child) => {
    if (child.matches(HEADING_SELECTOR)) return [child];
    if (child.matches('header')) {
      return [...child.querySelectorAll(HEADING_SELECTOR)];
    }
    if (child.matches('fieldset')) {
      return Array.from(child.children).filter((nested) =>
        nested.matches('legend')
      );
    }
    return [];
  });
}

function precedingHeadings(element: HTMLElement): Element[] {
  let sibling = element.previousElementSibling;
  while (sibling) {
    if (sibling.matches(HEADING_SELECTOR)) return [sibling];
    if (sibling.matches(HEADING_BOUNDARY_SELECTOR)) return [];
    const nested = [...sibling.querySelectorAll(HEADING_SELECTOR)];
    if (nested.length > 0) return [nested[nested.length - 1]];
    sibling = sibling.previousElementSibling;
  }
  return [];
}

function readContextHeadings(element: HTMLElement): string[] {
  const own = uniqueText(ownHeadings(element).map(readStaticText));
  if (own.length > 0) return own;

  let anchor: HTMLElement | null = element;
  for (let depth = 0; anchor && depth < 6; depth += 1) {
    const text = uniqueText(precedingHeadings(anchor).map(readStaticText));
    if (text.length > 0) return text;
    anchor = parentElementAcrossShadow(anchor);
  }
  return [];
}

function readButtonText(element: HTMLElement): string | null {
  if (element.matches('button, [role="button"]')) {
    return readStaticText(element);
  }
  if (isInputElement(element) && ['button', 'submit'].includes(element.type)) {
    return element.value;
  }
  return null;
}

function readNearbyText(element: HTMLElement): string[] {
  const parentText = element.parentElement
    ? [...element.parentElement.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
    : [];
  const siblingText = [
    readStaticText(element.previousElementSibling),
    readStaticText(element.nextElementSibling),
  ];
  const ownButtonText = readButtonText(element);

  return uniqueText([...parentText, ...siblingText, ownButtonText]);
}

function readAncestorTokens(element: HTMLElement): string[] {
  const tokens: string[] = [];
  let ancestor = parentElementAcrossShadow(element);
  while (ancestor && tokens.length < 6) {
    const tag = ancestor.tagName.toLowerCase();
    const id = ancestor.id ? `#${normalizeText(ancestor.id)}` : '';
    const classes = semanticClassNames(ancestor)
      .map((className) => `.${normalizeText(className)}`)
      .join('');
    tokens.push(`${tag}${id}${classes}`);
    ancestor = parentElementAcrossShadow(ancestor);
  }
  return tokens;
}

function readRequiredSignals(
  element: HTMLElement,
  labels: string[],
  nearbyText: string[]
): string[] {
  const signals: string[] = [];
  if (element.hasAttribute('required')) signals.push('attribute:required');
  if (element.getAttribute('aria-required') === 'true') {
    signals.push('attribute:aria-required');
  }
  if (element.parentElement?.closest('.required')) {
    signals.push('ancestor-class:required');
  }
  if (labels.some((label) => /[*＊✱]/u.test(label))) {
    signals.push('label-marker:*');
  }
  if (nearbyText.some((text) => /[*＊✱]/u.test(text))) {
    signals.push('nearby-marker:*');
  }
  return signals;
}

function hasValue(element: HTMLElement): boolean {
  if (isInputElement(element)) return element.value.length > 0;
  if (isTextAreaElement(element)) return element.value.length > 0;
  if (element.hasAttribute('contenteditable')) {
    return normalizeText(element.textContent).length > 0;
  }
  return false;
}

function controlType(element: HTMLElement): string {
  if (isInputElement(element)) return element.type;
  if (isTextAreaElement(element)) return 'textarea';
  if (element.hasAttribute('contenteditable')) return 'contenteditable';
  if (element.matches('button, [role="button"]')) return 'button';
  return element.tagName.toLowerCase();
}

function associatedForm(element: HTMLElement): HTMLFormElement | null {
  if (
    isInputElement(element) ||
    isTextAreaElement(element) ||
    isButtonElement(element)
  ) {
    return element.form;
  }
  return element.closest('form');
}

function parentElementAcrossShadow(element: Element): HTMLElement | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root) {
    const host = (root as ShadowRoot).host;
    return isHtmlElement(host) ? host : null;
  }
  return null;
}

function isMultilineEditor(element: HTMLElement): boolean {
  return (
    isTextAreaElement(element) ||
    (element.hasAttribute('contenteditable') &&
      element.getAttribute('contenteditable') !== 'false')
  );
}

function isActionControl(element: HTMLElement): boolean {
  return (
    element.tagName === 'BUTTON' ||
    (isInputElement(element) &&
      (element.type === 'button' || element.type === 'submit')) ||
    element.getAttribute('role') === 'button'
  );
}

function isToolbarActionControl(element: HTMLElement): boolean {
  if (!isActionControl(element)) return false;
  if (
    element.matches('.comment-submit') ||
    element.getAttribute('type')?.toLowerCase() === 'submit'
  ) {
    return false;
  }
  let ancestor = parentElementAcrossShadow(element);
  for (let depth = 0; ancestor && depth < 4; depth += 1) {
    if (
      ancestor.getAttribute('role') === 'toolbar' ||
      [...ancestor.classList].some((className) =>
        /(?:^|[-_])toolbar(?:$|[-_])/i.test(className)
      )
    ) {
      return true;
    }
    ancestor = parentElementAcrossShadow(ancestor);
  }
  return false;
}

function findFormlessEditorRegion(
  editor: HTMLElement,
  cache: Map<HTMLElement, HTMLElement | null>
): HTMLElement | null {
  if (associatedForm(editor)) return null;
  const visited: HTMLElement[] = [];
  let nearestActionRegion: HTMLElement | null = null;
  let ancestor = parentElementAcrossShadow(editor);
  for (let depth = 0; ancestor && depth < 8; depth += 1) {
    if (cache.has(ancestor)) {
      const region = cache.get(ancestor) ?? nearestActionRegion;
      for (const element of visited) cache.set(element, region);
      return region;
    }
    visited.push(ancestor);
    if (ancestor.tagName === 'BODY' || ancestor.tagName === 'HTML') {
      for (const element of visited) {
        cache.set(element, nearestActionRegion);
      }
      return nearestActionRegion;
    }
    const controls = [
      ...ancestor.querySelectorAll<HTMLElement>(CONTROL_SELECTOR),
    ].filter((control) => !isToolbarActionControl(control));
    if (controls.length <= 40) {
      const hasAction = controls.some((control) => isActionControl(control));
      if (hasAction) {
        nearestActionRegion ??= ancestor;
        const hasIdentityInput = controls.some(
          (control) =>
            isInputElement(control) &&
            !['button', 'hidden', 'submit'].includes(control.type)
        );
        if (hasIdentityInput) {
          for (const element of visited) cache.set(element, ancestor);
          return ancestor;
        }
      }
    }
    ancestor = parentElementAcrossShadow(ancestor);
  }
  for (const element of visited) cache.set(element, nearestActionRegion);
  return nearestActionRegion;
}

function uniqueElements(elements: HTMLElement[]): HTMLElement[] {
  return [...new Set(elements)];
}

interface EditorControlGroup {
  container: HTMLElement;
  controls: HTMLElement[];
  score: number;
  order: number;
}

const COMMENT_GROUP_EVIDENCE =
  /comment|reply|discussion|komentar|评论|評論|回复|回覆|留言/i;

function scoreEditorGroup(
  container: HTMLElement,
  controls: HTMLElement[],
  editors: HTMLElement[],
  order: number
): number {
  const visibleEditor = editors.some(isVisible);
  const visibleAction = controls.some(
    (control) => isActionControl(control) && isVisible(control)
  );
  const evidence = normalizeText(
    [
      container.id,
      container.getAttribute('name'),
      container.getAttribute('class'),
      container.getAttribute('aria-label'),
      ...readContextHeadings(container),
      ...editors.flatMap((editor) => [
        ...readLabels(editor),
        ...readNearbyText(editor),
        ...readAncestorTokens(editor),
      ]),
    ]
      .filter(Boolean)
      .join(' ')
  );
  return (
    (visibleEditor ? 1_000 : 0) +
    (visibleAction ? 200 : 0) +
    (COMMENT_GROUP_EVIDENCE.test(evidence) ? 100 : 0) +
    order / 1_000_000
  );
}

function hashSnapshot(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

type ProbeRoot = Document | ShadowRoot;

function collectProbeRoots(document: Document): {
  roots: ProbeRoot[];
  frameAnchors: Map<Document, HTMLIFrameElement>;
} {
  const roots: ProbeRoot[] = [document];
  const seen = new Set<ProbeRoot>(roots);
  const frameAnchors = new Map<Document, HTMLIFrameElement>();
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    for (const element of root.querySelectorAll<HTMLElement>('*')) {
      if (element.shadowRoot && !seen.has(element.shadowRoot)) {
        seen.add(element.shadowRoot);
        roots.push(element.shadowRoot);
      }
      if (element.tagName !== 'IFRAME' || !isVisible(element)) continue;
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
          frameAnchors.set(frameDocument, element as HTMLIFrameElement);
          roots.push(frameDocument);
        }
      } catch {
        // Cross-origin frames are not readable candidates.
      }
    }
  }
  return { roots, frameAnchors };
}

function belongsToProbeDocument(
  document: Document,
  element: HTMLElement,
  frameAnchors: Map<Document, HTMLIFrameElement>
): boolean {
  let ownerDocument = element.ownerDocument;
  if (ownerDocument === document) return true;
  while (ownerDocument !== document) {
    const frameElement = frameAnchors.get(ownerDocument);
    if (
      !frameElement ||
      !frameElement.isConnected ||
      frameElement.contentDocument !== ownerDocument
    ) {
      return false;
    }
    ownerDocument = frameElement.ownerDocument;
  }
  return true;
}

function stableEvidenceFingerprint(element: HTMLElement): string {
  const attributes = element
    .getAttributeNames()
    .filter((name) => STABLE_EVIDENCE_ATTRIBUTES.has(name))
    .sort()
    .flatMap((name) => {
      const rawValue = element.getAttribute(name) ?? '';
      const value =
        name === 'class'
          ? semanticClassNames(element).join(' ')
          : name === 'action' || name === 'formaction'
            ? rawValue
            : safeAttributeValue(element, name, rawValue);
      const normalized = normalizeText(value);
      return name === 'class' && !normalized ? [] : [[name, normalized]];
    });
  const buttonText = normalizeText(readButtonText(element));
  const labels = readLabels(element);
  const nearbyText = readNearbyText(element);
  const headings = readContextHeadings(element);
  const ancestorTokens = readAncestorTokens(element);

  return hashSnapshot(
    JSON.stringify({
      tag: element.tagName.toLowerCase(),
      attributes,
      buttonText,
      labels,
      nearbyText,
      headings,
      ancestorTokens,
    })
  );
}

export function probePageDocument(document: Document): PageProbeSnapshot {
  const { roots, frameAnchors } = collectProbeRoots(document);
  const allForms = roots.flatMap((root) => [
    ...root.querySelectorAll<HTMLFormElement>('form'),
  ]);
  const allControls = roots
    .flatMap((root) => [
      ...root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR),
    ])
    .filter((control) => !isToolbarActionControl(control));
  const controlOrder = new Map(
    allControls.map((control, index) => [control, index])
  );
  const editors = allControls.filter(isMultilineEditor);
  const editorSet = new Set(editors);
  const formLessRegionCache = new Map<HTMLElement, HTMLElement | null>();
  const editorRegions = uniqueElements(
    editors
      .map((editor) => findFormlessEditorRegion(editor, formLessRegionCache))
      .filter((region): region is HTMLElement => region !== null)
  );
  const editorFormSet = new Set(
    editors
      .map(associatedForm)
      .filter((form): form is HTMLFormElement => form !== null)
  );
  const editorRegionSet = new Set(editorRegions);
  const controlsByNativeForm = new Map<HTMLFormElement, HTMLElement[]>();
  const controlsByRegion = new Map<HTMLElement, HTMLElement[]>();
  for (const control of allControls) {
    const form = associatedForm(control);
    if (form && editorFormSet.has(form)) {
      const controls = controlsByNativeForm.get(form) ?? [];
      controls.push(control);
      controlsByNativeForm.set(form, controls);
      continue;
    }
    if (form) continue;
    let ancestor = parentElementAcrossShadow(control);
    while (ancestor) {
      if (editorRegionSet.has(ancestor)) {
        const controls = controlsByRegion.get(ancestor) ?? [];
        controls.push(control);
        controlsByRegion.set(ancestor, controls);
        break;
      }
      ancestor = parentElementAcrossShadow(ancestor);
    }
  }
  const editorGroups: EditorControlGroup[] = [
    ...Array.from(editorFormSet, (form) => ({
      container: form as HTMLElement,
      controls: controlsByNativeForm.get(form) ?? [],
    })),
    ...editorRegions.map((region) => ({
      container: region,
      controls: controlsByRegion.get(region) ?? [],
    })),
  ].map((group) => {
    const groupEditors = group.controls.filter(isMultilineEditor);
    const order = Math.max(
      0,
      ...group.controls.map((control) => controlOrder.get(control) ?? 0)
    );
    return {
      ...group,
      score: scoreEditorGroup(
        group.container,
        group.controls,
        groupEditors,
        order
      ),
      order,
    };
  });
  editorGroups.sort(
    (left, right) => right.score - left.score || right.order - left.order
  );

  const selectedEditorGroups: EditorControlGroup[] = [];
  let selectedControlCount = 0;
  for (const group of editorGroups) {
    if (selectedEditorGroups.length >= MAX_FORM_CANDIDATES) break;
    if (
      group.controls.length === 0 ||
      selectedControlCount + group.controls.length > MAX_CONTROL_CANDIDATES
    ) {
      continue;
    }
    selectedEditorGroups.push(group);
    selectedControlCount += group.controls.length;
  }
  const selectedEditorContainers = new Set(
    selectedEditorGroups.map((group) => group.container)
  );
  const fallbackForms = allForms
    .filter(
      (form) => !editorFormSet.has(form) && !selectedEditorContainers.has(form)
    )
    .slice(0, MAX_FORM_CANDIDATES - selectedEditorGroups.length);
  const groups: HTMLElement[] = [
    ...selectedEditorGroups.map((group) => group.container),
    ...fallbackForms,
  ];
  let nativeFormIndex = 0;
  let regionIndex = 0;
  const formIds = new Map<HTMLElement, string>();
  for (const group of groups) {
    if (group.tagName === 'FORM') {
      nativeFormIndex += 1;
      formIds.set(group, `form-${nativeFormIndex}`);
    } else {
      regionIndex += 1;
      formIds.set(group, `region-${regionIndex}`);
    }
  }
  const formCandidates: PageFormCandidate[] = groups.map((group) => ({
    formId: formIds.get(group) ?? '',
    tag: group.tagName === 'FORM' ? 'form' : 'region',
    attributes: readAttributes(group, FORM_ATTRIBUTES),
    headings: readContextHeadings(group),
    controlCandidateIds: [],
  }));
  const selectedRegions = new Set(
    selectedEditorGroups
      .map((group) => group.container)
      .filter((group) => group.tagName !== 'FORM')
  );
  const controlGroup = (element: HTMLElement): HTMLElement | null => {
    const form = associatedForm(element);
    if (form && formIds.has(form)) return form;
    if (form) return null;
    let ancestor = parentElementAcrossShadow(element);
    while (ancestor) {
      if (selectedRegions.has(ancestor)) return ancestor;
      ancestor = parentElementAcrossShadow(ancestor);
    }
    return null;
  };
  const selectedGroupedControls = uniqueElements(
    selectedEditorGroups.flatMap((group) => group.controls)
  );
  const controlsInAnyEditorGroup = new Set(
    editorGroups.flatMap((group) => group.controls)
  );
  const fallbackControls = allControls.filter(
    (element) =>
      !editorSet.has(element) && !controlsInAnyEditorGroup.has(element)
  );
  const controls = [
    ...selectedGroupedControls,
    ...fallbackControls.slice(
      0,
      MAX_CONTROL_CANDIDATES - selectedGroupedControls.length
    ),
  ];
  const controlCandidates = controls.map((element, index) => {
    const group = controlGroup(element);
    const formId = group ? (formIds.get(group) ?? null) : null;
    const candidateId = `control-${index + 1}`;
    const labels = readLabels(element);
    const nearbyText = readNearbyText(element);
    const candidate: PageControlCandidate = {
      candidateId,
      formId,
      tag: element.tagName.toLowerCase(),
      type: controlType(element),
      attributes: readAttributes(element, CONTROL_ATTRIBUTES),
      labels,
      nearbyText,
      headings: readContextHeadings(element),
      ancestorTokens: readAncestorTokens(element),
      requiredSignals: readRequiredSignals(element, labels, nearbyText),
      visible: isVisible(element),
      enabled:
        !('disabled' in element && element.disabled) &&
        element.getAttribute('aria-disabled') !== 'true',
      hasValue: hasValue(element),
    };
    if (formId) {
      formCandidates
        .find((formCandidate) => formCandidate.formId === formId)
        ?.controlCandidateIds.push(candidateId);
    }
    return candidate;
  });
  const snapshotBody = JSON.stringify({
    url: document.URL,
    formCandidates,
    controlCandidates,
  });

  const snapshotId = `snapshot-${hashSnapshot(snapshotBody)}`;
  const candidates = new Map<string, ProbeSessionCandidate>();
  for (const [group, formId] of formIds) {
    candidates.set(formId, {
      element: group,
      evidenceFingerprint: stableEvidenceFingerprint(group),
    });
  }
  for (const [index, control] of controls.entries()) {
    candidates.set(`control-${index + 1}`, {
      element: control,
      evidenceFingerprint: stableEvidenceFingerprint(control),
    });
  }
  probeSessions.set(document, { snapshotId, candidates, frameAnchors });

  return {
    snapshotId,
    url: document.URL,
    formCandidates,
    controlCandidates,
  };
}

export function resolveProbeCandidate(
  document: Document,
  snapshotId: string,
  candidateId: string
): HTMLElement | null {
  const session = probeSessions.get(document);
  if (!session || session.snapshotId !== snapshotId) return null;

  const storedCandidate = session.candidates.get(candidateId);
  const candidate = storedCandidate?.element;
  if (
    !candidate ||
    !candidate.isConnected ||
    !belongsToProbeDocument(document, candidate, session.frameAnchors) ||
    stableEvidenceFingerprint(candidate) !== storedCandidate.evidenceFingerprint
  ) {
    return null;
  }

  return candidate;
}
