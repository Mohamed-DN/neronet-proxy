import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../context/AuthContext';
import { clearSession, storeSession } from '../services/authToken';
import { resetConnectionState } from '../services/connection';
import { createQueryClient } from '../services/queries';
import { renderUI } from '../test/harness';
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
    // The armed control in the sidebar is the way in to the wipe.
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

    await userEvent.click(await screen.findByRole('button', { name: label('sidebar.destroyNow') }));

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
