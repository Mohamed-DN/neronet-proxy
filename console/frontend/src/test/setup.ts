import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll } from 'vitest';

import { initI18n } from '../i18n';

/*
 * jsdom implements neither of these, and Radix uses both: the Select and the
 * Tooltip position themselves with ResizeObserver, and the Select scrolls the
 * highlighted item into view. Without them every overlay test throws before it
 * asserts anything.
 */
beforeAll(() => {
  // A plain function, not vi.fn: restoreMocks between tests would otherwise
  // turn the stub back into a spy that returns undefined, and every component
  // that asks for the colour scheme would throw on the second test in a file.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia;
  }

  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }

  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }

  // navigator.clipboard is a getter-only property in jsdom; CodeText needs a
  // writable one to be testable at all.
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => {} },
      configurable: true,
      writable: true
    });
  }

  initI18n('en');
});

afterEach(() => {
  cleanup();
});
