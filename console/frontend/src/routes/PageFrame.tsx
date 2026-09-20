import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Wraps the body of one route and moves focus to its heading.
 *
 * A route change in a single-page console replaces the content without moving
 * focus, so a keyboard or screen-reader operator is left on a link in the
 * sidebar with no announcement that anything happened, and the next Tab
 * continues through the navigation rather than into the page.
 *
 * Focus goes to the page's own `h1`, which the reader then announces. The
 * heading is not replaced or duplicated: the design system allows one `h1` per
 * view, and every page already has one. A page without one gets the wrapper
 * itself, which is better than leaving focus behind.
 *
 * This lives inside the lazily loaded route chunk on purpose. Running it in the
 * layout would move focus while the suspense fallback is on screen, to a
 * heading that has not been rendered yet.
 */
/*
 * The address the last focus move was made for, across route components, since
 * each one mounts and unmounts with its route. `null` means nothing has been
 * focused since the document loaded.
 */
let lastFocusedPath: string | null = null;

/** Test seam, so one test's navigation does not decide the next test's. */
export function resetPageFocusHistory(): void {
  lastFocusedPath = null;
}

export function PageFrame({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    // Not on the first page of a session. Focus starts at the top of the
    // document, where the skip link is the first thing in the tab order;
    // moving it into the content on load would put the whole sidebar behind
    // the operator with no way forward to it and no skip link to use.
    const isFirstPage = lastFocusedPath === null;
    const unchanged = lastFocusedPath === pathname;
    lastFocusedPath = pathname;
    if (isFirstPage || unchanged) return;

    const target = root.querySelector('h1') ?? root;
    // Headings are not focusable by default. -1 keeps it out of the tab order
    // while allowing focus to be moved there programmatically.
    target.setAttribute('tabindex', '-1');
    (target as HTMLElement).focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div ref={ref} data-page-frame="">
      {children}
    </div>
  );
}
