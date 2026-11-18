import { vi } from 'vitest';

import { PHONE_QUERY, TABLET_QUERY, type LayoutSize } from '../ui/useLayoutSize';

/**
 * Makes `matchMedia` answer as a window of the given size would, and returns a
 * function that turns the device to another size and tells every listener, so a
 * test can watch a layout change without resizing anything.
 *
 * Call `vi.unstubAllGlobals()` afterwards (the suites already do).
 */
export function stubLayout(initial: LayoutSize): (next: LayoutSize) => void {
  let current = initial;
  const listeners = new Map<string, Set<() => void>>();

  const matches = (query: string) =>
    query === PHONE_QUERY ? current === 'phone' : query === TABLET_QUERY ? current !== 'desktop' : false;

  vi.stubGlobal('matchMedia', ((query: string) => {
    const set = listeners.get(query) ?? new Set<() => void>();
    listeners.set(query, set);
    return {
      get matches() {
        return matches(query);
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, fn: () => void) => set.add(fn),
      removeEventListener: (_type: string, fn: () => void) => set.delete(fn),
      dispatchEvent: () => false
    };
  }) as unknown as typeof window.matchMedia);

  return (next) => {
    current = next;
    // Only the layout queries change; other listeners (the colour scheme) are not told.
    for (const query of [PHONE_QUERY, TABLET_QUERY]) for (const fn of [...(listeners.get(query) ?? [])]) fn();
  };
}
