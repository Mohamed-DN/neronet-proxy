import { useState } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';

import { AuthProvider } from './context/AuthContext';
import { AppErrorBoundary } from './routes/AppErrorBoundary';
import { routes } from './routes/router';

/**
 * The console's root.
 *
 * Order matters here. The global error boundary is outermost, so a failure in
 * any provider still produces a page rather than a blank document. The query
 * cache belongs to the admitted session and sits inside AuthProvider. Replacing
 * that session also retires route-local state and the previous session's data.
 */
export default function App() {
  const [router] = useState(() => createBrowserRouter(routes));

  return (
    <AppErrorBoundary>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </AppErrorBoundary>
  );
}
