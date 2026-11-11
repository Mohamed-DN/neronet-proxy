import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MfaChallenge } from '../services/session';
import { expectNoAxeViolations, renderUI } from '../test/harness';
import InviteAcceptRoute from './InviteAcceptRoute';

const auth = vi.hoisted(() => ({
  user: null as unknown,
  isAuthenticated: false,
  login: vi.fn(),
  logout: vi.fn()
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: auth.user,
    isAuthenticated: auth.isAuthenticated,
    login: auth.login,
    logout: auth.logout
  })
}));

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true } as const;
const TOKEN = 'Q2hpYXZlLWRpLXByb3ZhLWxhcmdhLTMyLWJ5dGVzLXg';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let acceptAnswer: () => Response = () => json({ ok: true, username: 'carla' }, 201);
let fetchMock: ReturnType<typeof vi.fn>;

function sentBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/invitations/accept'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

/** Shows where the router is, hash included, so the test can see the token leave the address. */
function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.hash}`}</p>;
}

function renderAt(entry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderUI(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]} future={ROUTER_FUTURE}>
        <Routes>
          <Route
            path="/invito"
            element={
              <>
                <InviteAcceptRoute />
                <Where />
              </>
            }
          />
          <Route path="/me/add" element={<p>Add device page</p>} />
          <Route path="/login" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function fillAccount(user: ReturnType<typeof userEvent.setup>, password = 'una frase lunga') {
  await user.type(screen.getByLabelText(/^username/i), 'carla');
  await user.type(screen.getByLabelText(/^password/i), password);
  await user.type(screen.getByLabelText(/repeat the password/i), 'una frase lunga');
}

beforeEach(() => {
  auth.user = null;
  auth.isAuthenticated = false;
  auth.login.mockReset().mockResolvedValue({ id: 'u1', username: 'carla' });
  auth.logout.mockReset().mockResolvedValue(undefined);
  acceptAnswer = () => json({ ok: true, username: 'carla' }, 201);
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/invitations/accept')) return acceptAnswer();
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('InviteAcceptRoute', () => {
  it('takes the token from the link, removes it from the address, creates the account and signs in to add a device', async () => {
    const user = userEvent.setup();
    renderAt(`/invito#${TOKEN}`);

    expect(await screen.findByRole('heading', { level: 1, name: /join neronet/i })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/invito$/));
    // The link already carries the invitation: no code field to fill.
    expect(screen.queryByLabelText(/invitation code/i)).not.toBeInTheDocument();
    expect(screen.getByText(/your invitation is in the link/i)).toBeInTheDocument();

    await fillAccount(user);
    await user.click(screen.getByRole('button', { name: /create my account/i }));

    expect(await screen.findByText('Add device page')).toBeInTheDocument();
    expect(sentBodies()).toEqual([{ token: TOKEN, username: 'carla', password: 'una frase lunga' }]);
    expect(auth.login).toHaveBeenCalledWith('carla', 'una frase lunga');
  });

  it('without a link, asks for the code and sends what the person typed as the code', async () => {
    const user = userEvent.setup();
    renderAt('/invito');

    await user.type(await screen.findByLabelText(/invitation code/i), '7k3m q9td x2wa');
    await fillAccount(user);
    await user.click(screen.getByRole('button', { name: /create my account/i }));

    await screen.findByText('Add device page');
    expect(sentBodies()).toEqual([{ code: '7k3m q9td x2wa', username: 'carla', password: 'una frase lunga' }]);
  });

  it('a whole link pasted into the code field is read as the link', async () => {
    const user = userEvent.setup();
    renderAt('/invito');

    await user.type(await screen.findByLabelText(/invitation code/i), `https://console.example/invito#${TOKEN}`);
    await fillAccount(user);
    await user.click(screen.getByRole('button', { name: /create my account/i }));

    await screen.findByText('Add device page');
    expect(sentBodies()[0]).toMatchObject({ token: TOKEN });
  });

  it('says plainly when the invitation cannot be used, whatever the reason', async () => {
    acceptAnswer = () => json({ error: 'invitation_invalid', message: 'x' }, 400);
    const user = userEvent.setup();
    renderAt(`/invito#${TOKEN}`);

    await fillAccount(user);
    await user.click(await screen.findByRole('button', { name: /create my account/i }));

    expect((await screen.findByText(/this invitation does not work/i)).closest('[role="alert"]')).not.toBeNull();
    expect(auth.login).not.toHaveBeenCalled();
  });

  it('a username already in use is reported on the username field', async () => {
    acceptAnswer = () => json({ error: 'username_taken', message: 'x' }, 409);
    const user = userEvent.setup();
    renderAt(`/invito#${TOKEN}`);

    await fillAccount(user);
    await user.click(await screen.findByRole('button', { name: /create my account/i }));

    expect(await screen.findByText(/already taken/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^username/i)).toHaveAttribute('aria-invalid', 'true');
  });

  it('too many attempts are named as such', async () => {
    acceptAnswer = () => json({ error: 'too many invitation attempts; wait before trying again' }, 429);
    const user = userEvent.setup();
    renderAt(`/invito#${TOKEN}`);

    await fillAccount(user);
    await user.click(await screen.findByRole('button', { name: /create my account/i }));

    expect((await screen.findByText(/too many attempts/i)).closest('[role="alert"]')).not.toBeNull();
  });

  it('two different passwords are caught before anything is sent', async () => {
    const user = userEvent.setup();
    renderAt(`/invito#${TOKEN}`);

    await fillAccount(user, 'una frase diversa');
    await user.click(await screen.findByRole('button', { name: /create my account/i }));

    expect(await screen.findByText(/passwords are not the same/i)).toBeInTheDocument();
    expect(sentBodies()).toEqual([]);
  });

  it('an account that needs an authenticator is sent to the sign-in page, which then opens Add a device', async () => {
    auth.login.mockRejectedValue(new MfaChallenge('mfa-token', true));
    const user = userEvent.setup();
    renderAt(`/invito#${TOKEN}`);

    await fillAccount(user);
    await user.click(await screen.findByRole('button', { name: /create my account/i }));

    expect(await screen.findByRole('heading', { name: /your account is ready/i })).toBeInTheDocument();
    expect(screen.getByText(/authenticator app/i)).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /sign in/i }));
    expect(screen.getByTestId('where')).toHaveTextContent('/login');
  });

  it('a person already signed in is told to sign out first', async () => {
    auth.user = { id: 'u0', username: 'mario' };
    auth.isAuthenticated = true;
    const user = userEvent.setup();
    renderAt(`/invito#${TOKEN}`);

    expect(await screen.findByText(/signed in as mario/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create my account/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(auth.logout).toHaveBeenCalled();
  });

  it('has no accessibility violations, with and without a link', async () => {
    const withLink = renderAt(`/invito#${TOKEN}`);
    await screen.findByRole('heading', { level: 1 });
    await expectNoAxeViolations(withLink.container);
    withLink.unmount();

    const withoutLink = renderAt('/invito');
    await screen.findByLabelText(/invitation code/i);
    await expectNoAxeViolations(withoutLink.container);
  });
});
