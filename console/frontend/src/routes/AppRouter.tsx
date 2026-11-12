import { Suspense } from 'react';
import type { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';

import { Skeleton } from '../ui';

type Router = ReturnType<typeof createBrowserRouter>;

/**
 * The router with two guards against React error #426 ("a component suspended
 * while responding to synchronous input").
 *
 * A layout may wait for something on its first render: the portal frame reads the
 * lazily loaded `portal` translations, for one, and sits outside the console's own
 * Suspense boundary. A click navigation is a synchronous update, so that wait had
 * no fallback to show and the route error page appeared until the person pressed
 * Retry (owner report, 12 November 2026).
 *
 * - React Router 7's DOM `RouterProvider` (from `react-router/dom`) runs navigations
 *   as transitions: the current page stays on screen while the next one loads.
 * - The outer Suspense catches any first load that still waits (a direct visit,
 *   a reload) with a quiet placeholder instead of an error.
 */
export function AppRouter({ router }: { router: Router }) {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-2xl p-6">
          <Skeleton lines={6} />
        </div>
      }
    >
      <RouterProvider router={router} />
    </Suspense>
  );
}
