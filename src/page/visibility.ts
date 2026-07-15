function isHtmlElement(element: Element): element is HTMLElement {
  return element.namespaceURI === 'http://www.w3.org/1999/xhtml';
}

function isInputElement(element: Element): element is HTMLInputElement {
  return element.tagName === 'INPUT';
}

function parentHtmlElement(element: Element): HTMLElement | null {
  if (element.parentElement && isHtmlElement(element.parentElement)) {
    return element.parentElement;
  }
  const root = element.getRootNode();
  if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root) {
    const host = (root as ShadowRoot).host;
    return isHtmlElement(host) ? host : null;
  }
  return null;
}

function numbers(value: string): number[] {
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
}

function hasHiddenTransform(value: string): boolean {
  const transform = value.trim().toLowerCase();
  if (!transform || transform === 'none') return false;

  for (const match of transform.matchAll(/\bscale(?:x|y)?\(([^)]+)\)/g)) {
    const scale = numbers(match[1] ?? '');
    if (scale.some((component) => Math.abs(component) <= 0.01)) return true;
  }
  for (const match of transform.matchAll(/\btranslate(?:x|y)?\(([^)]+)\)/g)) {
    const offsets = (match[1] ?? '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((component) => Number.parseFloat(component));
    if (offsets.some((offset) => Number.isFinite(offset) && offset < -100)) {
      return true;
    }
  }

  const matrix = /^matrix\(([^)]+)\)$/.exec(transform);
  if (!matrix) return false;
  const [a, b, c, d, translateX, translateY] = numbers(matrix[1] ?? '');
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    translateX === undefined ||
    translateY === undefined
  ) {
    return false;
  }
  return (
    Math.abs(a * d - b * c) <= 0.0001 || translateX < -100 || translateY < -100
  );
}

function isFullyClippedInset(value: string): boolean {
  const inset = /^inset\(([^)]*)\)$/i.exec(value.trim());
  if (!inset) return false;
  const beforeRound = (inset[1] ?? '').split(/\s+round\s+/i, 1)[0] ?? '';
  const percentages = beforeRound
    .trim()
    .split(/\s+/)
    .map((component) =>
      component.endsWith('%') ? Number.parseFloat(component) : Number.NaN
    );
  if (
    percentages.length < 1 ||
    percentages.length > 4 ||
    percentages.some((component) => !Number.isFinite(component))
  ) {
    return false;
  }

  const [first, second = first, third = first, fourth = second] = percentages;
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined
  ) {
    return false;
  }
  return first + third >= 100 || second + fourth >= 100;
}

function isFullyClippedRect(value: string): boolean {
  const rect = /^rect\(([^)]*)\)$/i.exec(value.trim());
  if (!rect) return false;
  const [top, right, bottom, left] = (rect[1] ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((component) => Number.parseFloat(component));
  if (
    top === undefined ||
    right === undefined ||
    bottom === undefined ||
    left === undefined ||
    ![top, right, bottom, left].every(Number.isFinite)
  ) {
    return false;
  }
  return right <= left || bottom <= top;
}

export function isLocallyVisible(element: Element): boolean {
  if (!isHtmlElement(element)) return true;
  if (isInputElement(element) && element.type === 'hidden') return false;
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!computed) return true;
  const opacity = Number.parseFloat(computed.opacity || '1');
  const transform = computed.transform || element.style.transform;
  const clipPath = computed.clipPath || element.style.clipPath;
  if (
    computed.display === 'none' ||
    computed.visibility === 'hidden' ||
    opacity <= 0.01 ||
    (computed.width === '0px' && computed.height === '0px') ||
    hasHiddenTransform(transform) ||
    isFullyClippedInset(clipPath) ||
    isFullyClippedRect(computed.clip)
  ) {
    return false;
  }
  if (computed.position === 'absolute' || computed.position === 'fixed') {
    const left = Number.parseFloat(computed.left);
    const top = Number.parseFloat(computed.top);
    if (left < -100 || top < -100) return false;
  }
  return true;
}

export function isVisible(element: Element): boolean {
  if (!isHtmlElement(element)) return true;
  let current: HTMLElement | null = element;
  while (current) {
    if (!isLocallyVisible(current)) return false;
    current = parentHtmlElement(current);
  }

  const frameElement = element.ownerDocument.defaultView?.frameElement;
  if (frameElement && !isVisible(frameElement)) return false;
  return true;
}
