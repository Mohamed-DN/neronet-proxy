import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../context/AuthContext';
import { clearSession } from '../services/authToken';
import { renderUI } from '../test/harness';
import LoginRoute from './LoginRoute';
import { RequireAuth } from './RequireAuth';
import { LOGIN_PATH, ROUTES } from './paths';

// A NeroDrop link keeps its key in the fragment so that no server ever sees it. A
// signed-out recipient was sent to the sign-in form with only the path, so the key was
// dropped and they landed on /drop with no link. The fragment must ride along in the
// sign-in address's own fragment, never in its query string (which reaches access logs).

const LINK = '#r=0123456789abcdef0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderAt(entry: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/login') return json({ token: 't', user: { id: 'u1', username: 'admin', role: 'member' } });
      return json({ error: 'no session' }, 401);
    })
  );
  const router = createMemoryRouter(
    [
      { path: LOGIN_PATH, element: <LoginRoute /> },
      {
        element: <RequireAuth />,
        children: [{ path: ROUTES.drop, element: <h1>Drop page</h1> }]
      }
    ],
    { initialEntries: [entry] }
  );
  renderUI(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
  return router;
}

describe('RequireAuth keeps a fragment out of the server', () => {
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('carries the fragment in the sign-in fragment, not in the query', async () => {
    const router = renderAt(`${ROUTES.drop}${LINK}`);
    await waitFor(() => expect(router.state.location.pathname).toBe(LOGIN_PATH));
    const { search, hash } = router.state.location;
    expect(search).toBe(`?next=${encodeURIComponent(ROUTES.drop)}`);
    expect(search).not.toContain('r%3D');
    expect(hash).toBe(LINK);
  });

  it('lands on /drop with the link intact after sign-in', async () => {
    const router = renderAt(`${ROUTES.drop}${LINK}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: /sign in|accedi/i }));
    await screen.findByRole('heading', { name: 'Drop page' });
    expect(router.state.location.pathname).toBe(ROUTES.drop);
    expect(router.state.location.hash).toBe(LINK);
  });
});
