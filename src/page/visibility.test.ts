import { describe, expect, it } from 'vitest';
import { isVisible } from './visibility';

describe('DOM control visibility', () => {
  it.each([
    'transform: scale(0)',
    'transform: translateX(-9999px)',
    'transform: matrix(0, 0, 0, 0, 0, 0)',
    'transform: matrix(1, 0, 0, 1, -9999, 0)',
    'clip-path: inset(50%)',
    'width: 1px; height: 1px; clip: rect(1px, 1px, 1px, 1px)',
  ])('treats a honeypot styled with %s as hidden', (style) => {
    document.body.innerHTML = `<input name="website" style="${style}">`;

    expect(isVisible(document.querySelector('input') as HTMLInputElement)).toBe(
      false
    );
  });
});
