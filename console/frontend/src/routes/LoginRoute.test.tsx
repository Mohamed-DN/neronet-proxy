import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../context/AuthContext';
import { clearSession, readAccessToken } from '../services/authToken';
import { renderUI } from '../test/harness';
import LoginRoute from './LoginRoute';
import { LOGIN_PATH, ROUTES } from './paths';

// The console could not sign in an account with MFA: the login answer carried an
// mfa_token instead of a session and the page reported "The control plane did not
// return a session". With MFA required for administrators, that locked them out.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const USER = { id: 'u1', username: 'admin', role: 'super-admin' };

function renderLogin() {
  const router = createMemoryRouter(
    [
      { path: LOGIN_PATH, element: <LoginRoute /> },
      { path: ROUTES.overview, element: <h1>Overview</h1> }
    ],
    { initialEntries: [LOGIN_PATH] }
  );
  renderUI(
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}

async function submitPassword() {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Username'), 'admin');
  await user.type(screen.getByLabelText('Password'), 'pw');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  return user;
}

describe('sign-in with MFA', () => {
  let calls: { url: string; body: Record<string, unknown> }[];

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  function stub(login: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push({ url, body });
        if (url === '/api/auth/refresh') return json({ error: 'Missing token for refresh' }, 401);
        if (url === '/api/auth/login') return json(login);
        if (url === '/api/auth/mfa/setup') {
          return json({
            secret: 'JBSWY3DPEHPK3PXP',
            qrDataUrl: 'data:image/png;base64,AAAA',
            otpauthUri: 'otpauth://totp/x',
            recoveryCodes: ['aaaa-1111', 'bbbb-2222']
          });
        }
        if (url === '/api/auth/mfa/verify') {
          return body.code === '123456' || body.recovery_code === 'aaaa-1111'
            ? json({ token: 'session-token', user: USER })
            : json({ error: 'Invalid TOTP code' }, 401);
        }
        if (url === '/api/auth/me') return json({ user: USER });
        return json({});
      }) as unknown as typeof fetch
    );
  }

  it('asks for the authenticator code and completes the sign-in with it', async () => {
    stub({ mfa_required: true, mfa_setup_required: false, mfa_token: 'pending-1' });
    renderLogin();

    const user = await submitPassword();
    await user.type(await screen.findByLabelText('Authenticator code'), '123 456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/api/auth/mfa/verify')?.body).toEqual({
      mfa_token: 'pending-1',
      code: '123456'
    });
    expect(readAccessToken()).toBe('session-token');
  });

  it('accepts a recovery code instead', async () => {
    stub({ mfa_required: true, mfa_setup_required: false, mfa_token: 'pending-2' });
    renderLogin();

    const user = await submitPassword();
    await user.click(await screen.findByRole('button', { name: 'Use a recovery code' }));
    await user.type(screen.getByLabelText('Recovery code'), 'aaaa-1111');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('enrols an authenticator when the account has none, showing the key and the recovery codes', async () => {
    stub({ mfa_required: true, mfa_setup_required: true, mfa_token: 'pending-3' });
    renderLogin();

    const user = await submitPassword();
    expect(await screen.findByAltText('QR code to add this account to an authenticator app')).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByText('bbbb-2222')).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/api/auth/mfa/setup')?.body).toEqual({ mfa_token: 'pending-3' });

    await user.type(screen.getByLabelText('Authenticator code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Confirm and sign in' }));

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('shows a wrong code and stays on the MFA step', async () => {
    stub({ mfa_required: true, mfa_setup_required: false, mfa_token: 'pending-4' });
    renderLogin();

    const user = await submitPassword();
    await user.type(await screen.findByLabelText('Authenticator code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid TOTP code');
    expect(screen.getByLabelText('Authenticator code')).toBeInTheDocument();
    expect(readAccessToken()).toBeNull();
  });
});
