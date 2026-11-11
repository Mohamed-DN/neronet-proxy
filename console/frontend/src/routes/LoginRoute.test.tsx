import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../context/AuthContext';
import { clearSession, readAccessToken } from '../services/authToken';
import i18n from '../i18n';
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

/* The copy comes from the translations, so a wording change does not break these tests. */
const L = (key: string) => i18n.t(key, { ns: 'chrome' });

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
  await user.click(screen.getByRole('button', { name: L('login.submit') }));
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
    await user.type(await screen.findByLabelText(L('login.mfa.codeLabel')), '123 456');
    await user.click(screen.getByRole('button', { name: L('login.mfa.submit') }));

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
    await user.click(await screen.findByRole('button', { name: L('login.mfa.useRecovery') }));
    await user.type(screen.getByLabelText(L('login.mfa.recoveryLabel')), 'aaaa-1111');
    await user.click(screen.getByRole('button', { name: L('login.mfa.submit') }));

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('enrols an authenticator when the account has none, showing the key and the recovery codes', async () => {
    stub({ mfa_required: true, mfa_setup_required: true, mfa_token: 'pending-3' });
    renderLogin();

    const user = await submitPassword();
    expect(await screen.findByAltText(L('login.mfa.qrAlt'))).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();
    expect(screen.getByText('bbbb-2222')).toBeInTheDocument();
    expect(calls.find((c) => c.url === '/api/auth/mfa/setup')?.body).toEqual({ mfa_token: 'pending-3' });

    await user.type(screen.getByLabelText(L('login.mfa.codeLabel')), '123456');
    await user.click(screen.getByRole('button', { name: L('login.mfa.enrolSubmit') }));

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('shows a wrong code and stays on the MFA step', async () => {
    stub({ mfa_required: true, mfa_setup_required: false, mfa_token: 'pending-4' });
    renderLogin();

    const user = await submitPassword();
    await user.type(await screen.findByLabelText(L('login.mfa.codeLabel')), '000000');
    await user.click(screen.getByRole('button', { name: L('login.mfa.submit') }));

    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('login.mfa.failed', { ns: 'chrome' }));
    expect(screen.queryByText('Invalid TOTP code')).not.toBeInTheDocument();
    expect(screen.getByLabelText(L('login.mfa.codeLabel'))).toBeInTheDocument();
    expect(readAccessToken()).toBeNull();
  });
});

describe('sign-in errors in plain words', () => {
  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('says the server cannot be reached, with no raw browser error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/login') throw new TypeError('Failed to fetch');
        return json({});
      }) as unknown as typeof fetch
    );
    renderLogin();

    const user = await submitPassword();
    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('login.unreachable', { ns: 'chrome' }));
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
    expect(user).toBeDefined();
  });

  it('says sign-in failed, not the raw server text, for a wrong password', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/login') return json({ error: 'Invalid username or password' }, 401);
        return json({});
      }) as unknown as typeof fetch
    );
    renderLogin();

    await submitPassword();
    expect(await screen.findByRole('alert')).toHaveTextContent(i18n.t('login.failed', { ns: 'chrome' }));
    expect(screen.queryByText('Invalid username or password')).not.toBeInTheDocument();
  });
});

describe('language on the sign-in page', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('switches the whole page when English or Italiano is chosen', async () => {
    await i18n.changeLanguage('it');
    renderLogin();
    await waitFor(() =>
      expect(screen.getByText(i18n.t('login.subtitle', { ns: 'chrome', lng: 'it' }))).toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: 'Italiano' })).toHaveAttribute('aria-pressed', 'true');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'English' }));

    expect(
      await screen.findByRole('button', { name: i18n.t('login.submit', { ns: 'chrome', lng: 'en' }) })
    ).toBeInTheDocument();
    expect(screen.getByText(i18n.t('login.subtitle', { ns: 'chrome', lng: 'en' }))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('login.subtitle', { ns: 'chrome', lng: 'it' }))).toBeNull();
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.lang).toBe('en');

    await user.click(screen.getByRole('button', { name: 'Italiano' }));
    expect(
      await screen.findByRole('button', { name: i18n.t('login.submit', { ns: 'chrome', lng: 'it' }) })
    ).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('it');
  });
});
