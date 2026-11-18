import { useSyncExternalStore } from 'react';

/**
 * The three sizes the console is designed for (docs/design/DIRECTION-2026-11.md,
 * "Three sizes, three designs"). The breakpoints are Tailwind's `md` and `xl`,
 * so a `max-md:` class and `useLayoutSize() === 'phone'` always agree.
 */
export type LayoutSize = 'desktop' | 'tablet' | 'phone';

/** Under 768 px. */
export const PHONE_QUERY = '(max-width: 767.98px)';
/** Under 1280 px: tablet and phone. */
export const TABLET_QUERY = '(max-width: 1279.98px)';

function canMatch(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/*
 * The queries describe the narrow sizes, not the wide ones, on purpose: an
 * environment that answers "no" to everything (jsdom's default stub, a browser
 * without matchMedia) then draws the desktop layout, which is the one every
 * page was written for.
 */
function read(): LayoutSize {
  if (!canMatch()) return 'desktop';
  if (window.matchMedia(PHONE_QUERY).matches) return 'phone';
  if (window.matchMedia(TABLET_QUERY).matches) return 'tablet';
  return 'desktop';
}

type Listener = () => void;

function listen(list: MediaQueryList, onChange: Listener): () => void {
  if (typeof list.addEventListener === 'function') {
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }
  // Safari before 14.
  list.addListener?.(onChange);
  return () => list.removeListener?.(onChange);
}

function subscribe(onChange: Listener): () => void {
  if (!canMatch()) return () => {};
  const stops = [PHONE_QUERY, TABLET_QUERY].map((query) => listen(window.matchMedia(query), onChange));
  return () => stops.forEach((stop) => stop());
}

/**
 * 'desktop' (>= 1280 px), 'tablet' (768 to 1279 px) or 'phone' (< 768 px),
 * kept current as the window resizes or the device turns. Safe to render on a
 * server: it answers 'desktop' there.
 */
export function useLayoutSize(): LayoutSize {
  return useSyncExternalStore(subscribe, read, () => 'desktop');
}
