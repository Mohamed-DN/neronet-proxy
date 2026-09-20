import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter, matchRoutes, type RouteObject } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../context/AuthContext';
import { clearSession, storeSession } from '../services/authToken';
import { resetConnectionState } from '../services/connection';
import { createQueryClient } from '../services/queries';
import { renderUI } from '../test/harness';
import { PageFrame } from './PageFrame';
import { RequireAuth } from './RequireAuth';
import { RootLayout } from './RootLayout';
import { RouteError } from './RouteError';
import { LOGIN_PATH, ROUTES, nodePath, safeNextPath } from './paths';
import { routes } from './router';
import { ShellProvider } from './shell';

/**
 * The shell, driven through the router.
 *
 * Route matching is asserted against the real route table, because that is the
 * object the router resolves a URL with. The behaviour that needs a rendered
 * tree - error containment, focus after navigation, the sign-in redirect - is
 * driven through the same layout, gate and boundary components the product
 * uses, with stub pages in place of the fourteen real ones: a page that draws
 * WebGL or a chart tests itself in its own work package, and would only make
 * this one slow and flaky.
 */

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function stubEnvironment() {
  // The console refuses to draw below 1024px and says so instead. jsdom has no
  // layout, and the shared matchMedia stub answers false to everything, so
  // without this every test below asserts against the narrow-window notice.
  vi.stubGlobal('matchMedia', ((query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  })) as unknown as typeof window.matchMedia);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/me') return jsonResponse({ user: { id: 'u1', username: 'admin', role: 'super-admin' } });
      if (url === '/api/nodes') return jsonResponse({ nodes: [] });
      if (url === '/api/features') return jsonResponse({ cloud_pc: false });
      if (url === '/api/stats/overview') return jsonResponse({ active_nodes: 0, total_nodes: 0 });
      if (url === '/api/auth/login') {
        return jsonResponse({ token: 'tok', user: { id: 'u1', username: 'admin', role: 'super-admin' } });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch
  );
  // jsdom will happily try to open a socket to a server that is not there and
  // report it asynchronously after the test has finished.
  vi.stubGlobal(
    'WebSocket',
    class {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      close() {}
    } as unknown as typeof WebSocket
  );
}

function Page({ title }: { title: string }) {
  return (
    <PageFrame>
      <h1>{title}</h1>
      <p>body of {title}</p>
    </PageFrame>
  );
}

function Exploding(): never {
  throw new Error('this page throws while rendering');
}

const testRoutes: RouteObject[] = [
  { path: LOGIN_PATH, element: <LoginStub /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: (
          <ShellProvider>
            <RootLayout />
          </ShellProvider>
        ),
        children: [
          {
            path: ROUTES.overview,
            element: <Page title="Global overview" />,
            handle: { titleKey: 'nav.items.overview' }
          },
          {
            path: ROUTES.nodes,
            element: <Page title="Node matrix" />,
            handle: { titleKey: 'nav.items.nodes' }
          },
          {
            path: `${ROUTES.nodes}/:id`,
            element: <Page title="Node matrix" />,
            handle: { titleKey: 'nav.items.nodes' }
          },
          {
            path: ROUTES.audit,
            element: <Exploding />,
            errorElement: <RouteError />,
            handle: { titleKey: 'nav.items.audit' }
          }
        ]
      }
    ]
  }
];

function LoginStub() {
  return <h1>Sign in</h1>;
}

function renderAt(initialEntries: string[]) {
  const router = createMemoryRouter(testRoutes, { initialEntries });
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } });
  const result = renderUI(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
  return { router, ...result };
}

describe('the route table', () => {
  it('resolves every page in the navigation by its own URL', () => {
    for (const [id, path] of Object.entries(ROUTES)) {
      const matches = matchRoutes(routes, path);
      expect(matches, `no route matched ${path} (${id})`).not.toBeNull();
      const leaf = matches?.[matches.length - 1];
      expect(leaf?.route.path, `${path} matched the catch-all instead of its own route`).toBe(path);
    }
  });

  it('resolves a node deep link and exposes the identifier', () => {
    const matches = matchRoutes(routes, nodePath('svrn-node-abc'));
    const leaf = matches?.[matches.length - 1];
    expect(leaf?.route.path).toBe(`${ROUTES.nodes}/:id`);
    expect(leaf?.params.id).toBe('svrn-node-abc');
  });

  it('sends an unknown address to the not-found route, inside the layout', () => {
    const matches = matchRoutes(routes, '/no-such-page');
    const leaf = matches?.[matches.length - 1];
    expect(leaf?.route.path).toBe('*');
    // Still nested under the layout route, so the navigation stays on screen.
    expect(matches!.length).toBeGreaterThan(2);
  });

  it('gives every page its own error boundary and a title', () => {
    const pages = matchRoutes(routes, ROUTES.overview);
    const leaf = pages?.[pages.length - 1]?.route;
    expect(leaf?.errorElement).toBeDefined();
    expect((leaf?.handle as { titleKey?: string } | undefined)?.titleKey).toBe('nav.items.overview');
  });

  it('refuses a next path that would leave this origin', () => {
    expect(safeNextPath('//evil.example/path')).toBe(ROUTES.overview);
    expect(safeNextPath('https://evil.example')).toBe(ROUTES.overview);
    expect(safeNextPath(null)).toBe(ROUTES.overview);
    expect(safeNextPath(LOGIN_PATH)).toBe(ROUTES.overview);
    expect(safeNextPath('/nodes/abc')).toBe('/nodes/abc');
  });
});

describe('the shell', () => {
  beforeEach(() => {
    localStorage.clear();
    resetConnectionState();
    stubEnvironment();
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('sends an unauthenticated operator to sign in, keeping the address they asked for', async () => {
    const { router } = renderAt([nodePath('svrn-node-abc')]);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(LOGIN_PATH);
    expect(router.state.location.search).toBe(`?next=${encodeURIComponent('/nodes/svrn-node-abc')}`);
  });

  it('renders the page a deep link asks for, with the navigation beside it', async () => {
    storeSession({ token: 'tok' });
    renderAt([ROUTES.nodes]);

    expect(await screen.findByRole('heading', { name: 'Node matrix' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Global overview/ })).toHaveAttribute('href', ROUTES.overview);
  });

  it('sets the document title from the route', async () => {
    storeSession({ token: 'tok' });
    renderAt([ROUTES.overview]);

    await screen.findByRole('heading', { name: 'Global overview' });
    await waitFor(() => expect(document.title).toBe('Global overview - NeroNet console'));
  });

  it('is navigable from the keyboard and moves focus to the heading of the page it lands on', async () => {
    storeSession({ token: 'tok' });
    const { router } = renderAt([ROUTES.overview]);
    await screen.findByRole('heading', { name: 'Global overview' });

    const link = screen.getByRole('link', { name: /Node matrix/ });
    link.focus();
    expect(link).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    const heading = await screen.findByRole('heading', { name: 'Node matrix' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(router.state.location.pathname).toBe(ROUTES.nodes);
  });

  it('follows the browser back button rather than leaving the console', async () => {
    storeSession({ token: 'tok' });
    const { router } = renderAt([ROUTES.overview]);
    await screen.findByRole('heading', { name: 'Global overview' });

    await userEvent.click(screen.getByRole('link', { name: /Node matrix/ }));
    await screen.findByRole('heading', { name: 'Node matrix' });

    router.navigate(-1);

    expect(await screen.findByRole('heading', { name: 'Global overview' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(ROUTES.overview);
  });

  it('contains a page that throws, leaving the navigation usable', async () => {
    storeSession({ token: 'tok' });
    // The boundary reports the failure; the assertion is on what the operator
    // is left with, not on the log.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { router } = renderAt([ROUTES.audit]);

    expect(await screen.findByRole('heading', { name: 'This page could not be drawn' })).toBeInTheDocument();
    // An identifier, and nothing from the error itself.
    expect(screen.queryByText(/this page throws while rendering/)).not.toBeInTheDocument();
    expect(screen.getByText(/^[0-9A-F]{8}$/)).toBeInTheDocument();
    expect(logged).toHaveBeenCalled();

    // The sidebar survived, and still navigates.
    const link = screen.getByRole('link', { name: /Global overview/ });
    await userEvent.click(link);

    expect(await screen.findByRole('heading', { name: 'Global overview' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(ROUTES.overview);
    logged.mockRestore();
  });

  it('keeps the sidebar collapse across mounts', async () => {
    storeSession({ token: 'tok' });
    const first = renderAt([ROUTES.overview]);
    await screen.findByRole('heading', { name: 'Global overview' });

    await userEvent.click(screen.getByRole('button', { name: 'Collapse the navigation' }));
    expect(screen.getByRole('button', { name: 'Expand the navigation' })).toBeInTheDocument();
    first.unmount();

    renderAt([ROUTES.overview]);
    expect(await screen.findByRole('button', { name: 'Expand the navigation' })).toBeInTheDocument();
  });
});
