import { useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';

import { AuthProvider } from './context/AuthContext';
import { createQueryClient } from './services/queries';
import { AppErrorBoundary } from './routes/AppErrorBoundary';
import { routes } from './routes/router';

/**
 * The console's root.
 *
 * Order matters here. The global error boundary is outermost, so a failure in
 * any provider still produces a page rather than a blank document. The query
 * client and the session sit above the router, because the router's own
 * elements - the authentication gate, the layout - read both.
 */
export default function App() {
  // Created once per mount rather than at module scope: a client shared
  // between test renders carries one test's cache into the next.
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() => createBrowserRouter(routes));

  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
