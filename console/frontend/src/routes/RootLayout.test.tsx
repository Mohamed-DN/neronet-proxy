import { QueryClientProvider } from '@tanstack/react-query';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../context/AuthContext';
import { clearSession, storeSession } from '../services/authToken';
import { resetConnectionState } from '../services/connection';
import { createQueryClient } from '../services/queries';
import { renderUI } from '../test/harness';
import { stubLayout } from '../test/layout';
import i18n from '../i18n';
import { RequireAuth } from './RequireAuth';
import { RootLayout } from './RootLayout';
import { ShellProvider } from './shell';

const label = (key: string) => i18n.t(key, { ns: 'chrome' });

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function stubEnvironment() {
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
      return jsonResponse({});
    }) as unknown as typeof fetch
  );

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

function renderConsole() {
  const router = createMemoryRouter(
    [
      {
        element: <RequireAuth />,
        children: [
          {
            element: (
              <ShellProvider>
                <RootLayout />
              </ShellProvider>
            ),
            children: [{ path: '/overview', element: <p>Overview body</p> }]
          }
        ]
      },
      { path: '/login', element: <p>Sign in page</p> }
    ],
    { initialEntries: ['/overview'] }
  );
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false } });
  return renderUI(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}

describe('account wipe in the shell', () => {
  beforeEach(() => {
    localStorage.clear();
    resetConnectionState();
    stubEnvironment();
    // The armed control in the top bar is the way in to the wipe.
    localStorage.setItem('nukeArmed', 'true');
    storeSession({ token: 'tok' });
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks with ConfirmDialog and the DELETE MY ACCOUNT phrase; window.confirm is never called', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const alert = vi.spyOn(window, 'alert');
    renderConsole();

    await userEvent.click(await screen.findByRole('button', { name: label('status.eraseNow') }));

    const dialog = await screen.findByRole('dialog', { name: label('wipe.title') });
    expect(dialog).toHaveTextContent(label('wipe.body'));

    const confirmButton = screen.getByRole('button', { name: label('wipe.confirm') });
    expect(confirmButton).toBeDisabled();

    await userEvent.type(screen.getByRole('textbox'), 'DELETE MY ACCOUNT');
    await waitFor(() => expect(confirmButton).toBeEnabled());

    expect(confirm).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('shell height', () => {
  beforeEach(() => {
    localStorage.clear();
    resetConnectionState();
    stubEnvironment();
    storeSession({ token: 'tok' });
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is as tall as its content: no viewport-height size on the shell, and a sticky top bar above the page', async () => {
    const { container } = renderConsole();
    await screen.findByRole('main');

    const root = container.querySelector('[data-shell-root]') as HTMLElement;
    const bar = container.querySelector('[data-shell-topbar]') as HTMLElement;
    expect(root.className).not.toMatch(/\b(min-)?h-(screen|dvh|svh|lvh)\b/);
    expect(bar.className).toContain('sticky');
    expect(bar.className).not.toMatch(/\bh-screen\b/);
    // The top bar comes before the page in the document, and there is no left rail.
    expect(bar.compareDocumentPosition(screen.getByRole('main')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('[data-shell-sidebar]')).toBeNull();
  });
});

describe('shell at every width', () => {
  beforeEach(() => {
    localStorage.clear();
    resetConnectionState();
    stubEnvironment();
    storeSession({ token: 'tok' });
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws the admin shell on a phone, with a bottom tab bar, and no "use a wider window" screen', async () => {
    stubLayout('phone');
    const { container } = renderConsole();

    expect(await screen.findByText('Overview body')).toBeInTheDocument();
    expect(container.querySelector('[data-layout="phone"]')).not.toBeNull();
    const nav = screen.getByRole('navigation', { name: label('nav.landmark') });
    expect(nav).toHaveAttribute('data-bottom-tabs');
    expect(screen.getAllByRole('navigation', { name: label('nav.landmark') })).toHaveLength(1);
    expect(container.querySelector('[data-narrow-window]')).toBeNull();
    // The tab bar is the thing the page makes room for.
    expect(screen.getByRole('main').className).toContain('--bottom-nav-height');
  });

  it('draws a row of tabs under the wordmark on a tablet and no bottom bar', async () => {
    stubLayout('tablet');
    const { container } = renderConsole();

    expect(await screen.findByText('Overview body')).toBeInTheDocument();
    expect(container.querySelector('[data-layout="tablet"]')).not.toBeNull();
    expect(container.querySelector('[data-bottom-tabs]')).toBeNull();
    expect(screen.getByRole('button', { name: label('nav.groups.network') })).toBeInTheDocument();
  });

  it('moves between the layouts as the window turns, without losing the page', async () => {
    const turnTo = stubLayout('desktop');
    const { container } = renderConsole();
    expect(await screen.findByText('Overview body')).toBeInTheDocument();
    expect(container.querySelector('[data-layout="desktop"]')).not.toBeNull();

    act(() => turnTo('phone'));
    await waitFor(() => expect(container.querySelector('[data-layout="phone"]')).not.toBeNull());
    expect(screen.getByText('Overview body')).toBeInTheDocument();
  });
});
