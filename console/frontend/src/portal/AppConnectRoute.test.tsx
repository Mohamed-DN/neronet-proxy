import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '../i18n';
import { expectNoAxeViolations, renderUI } from '../test/harness';
import AppConnectRoute from './AppConnectRoute';
import SignedInApps from './SignedInApps';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const REQUEST = {
  user_code: 'ABCD-EFGH',
  platform: 'windows',
  device_name: 'Desk PC',
  request_ip: '203.0.113.7',
  requested_at: '2026-11-23T10:00:00Z',
  expires_at: '2026-11-23T10:10:00Z',
  scopes: ['app:self', 'devices:read'],
  mfa_required: false
};

let lookupAnswer: () => Response;
let approveAnswer: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;

function calls(fragment: string): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes(fragment))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}${location.hash}`}</p>;
}

function renderAt(entry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderUI(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/collega"
            element={
              <>
                <AppConnectRoute />
                <Where />
              </>
            }
          />
          <Route path="/me" element={<p>My devices page</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  lookupAnswer = () => json(REQUEST);
  approveAnswer = () => json({ approved: true });
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/device/lookup')) return lookupAnswer();
    if (url.includes('/device/approve')) return approveAnswer();
    if (url.includes('/device/deny')) return json({ denied: true });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Looks the code up and waits for the review of what is asking. */
async function reachReview(user: ReturnType<typeof userEvent.setup>) {
  renderAt('/collega');
  await user.type(await screen.findByLabelText(/code from the app/i), 'abcd-efgh');
  await user.click(screen.getByRole('button', { name: /continue/i }));
  await screen.findByText('Desk PC');
}

describe('AppConnectRoute', () => {
  it('shows what is asking, labelled as what the app says about itself, then approves once the code is typed', async () => {
    const user = userEvent.setup();
    await reachReview(user);
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('Windows')).toBeInTheDocument();
    // The device name and platform are the app's own claim, not something the console checked.
    expect(screen.getAllByText(/stated by the app, not checked/i).length).toBeGreaterThan(0);
    // What it will be allowed to do, in plain words.
    expect(screen.getByText(/see which account it is signed in as/i)).toBeInTheDocument();
    expect(screen.getByText(/see your devices/i)).toBeInTheDocument();
    expect(calls('/device/lookup')).toEqual([{ user_code: 'abcd-efgh' }]);

    // Approving needs the code from the app's screen to be typed, even without a second factor.
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByText(/type the code shown in the app to confirm/i)).toBeInTheDocument();
    expect(calls('/device/approve')).toEqual([]);
    await user.type(screen.getByLabelText(/type the code shown in the app/i), 'wrong-cod');
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByText(/does not match the one on the app/i)).toBeInTheDocument();
    expect(calls('/device/approve')).toEqual([]);

    await user.clear(screen.getByLabelText(/type the code shown in the app/i));
    await user.type(screen.getByLabelText(/type the code shown in the app/i), 'abcd efgh');
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByRole('heading', { name: /app is connected/i })).toBeInTheDocument();
    expect(calls('/device/approve')).toEqual([{ user_code: 'abcd-efgh' }]);
  });

  it('moves focus to the heading of the review when it appears', async () => {
    const user = userEvent.setup();
    await reachReview(user);
    expect(screen.getByRole('heading', { name: /asking to sign in as you/i })).toHaveFocus();
  });

  it('takes the code from the address fragment, removes it, and still asks for it to be typed', async () => {
    const user = userEvent.setup();
    renderAt('/collega#code=ABCD-EFGH');
    expect(await screen.findByText('Desk PC')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/collega$/));
    expect(calls('/device/lookup')).toEqual([{ user_code: 'ABCD-EFGH' }]);
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByText(/type the code shown in the app to confirm/i)).toBeInTheDocument();
    expect(calls('/device/approve')).toEqual([]);
  });

  it('does not read a code from the query string, which reaches server logs', async () => {
    renderAt('/collega?code=ABCD-EFGH');
    expect(await screen.findByLabelText(/code from the app/i)).toBeInTheDocument();
    expect(calls('/device/lookup')).toEqual([]);
  });

  it('asks for the authenticator code when the account needs one, and sends it with the typed code', async () => {
    lookupAnswer = () => json({ ...REQUEST, mfa_required: true });
    const user = userEvent.setup();
    await reachReview(user);
    await user.type(screen.getByLabelText(/type the code shown in the app/i), 'ABCDEFGH');
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByText(/enter the code from your authenticator to approve/i)).toBeInTheDocument();
    expect(calls('/device/approve')).toEqual([]);

    await user.type(screen.getByLabelText(/code from your authenticator/i), '123456');
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    await screen.findByRole('heading', { name: /app is connected/i });
    expect(calls('/device/approve')).toEqual([{ user_code: 'abcd-efgh', totp_code: '123456' }]);
  });

  it('accepts a recovery code in place of the authenticator code', async () => {
    lookupAnswer = () => json({ ...REQUEST, mfa_required: true });
    const user = userEvent.setup();
    await reachReview(user);
    await user.type(screen.getByLabelText(/type the code shown in the app/i), 'ABCDEFGH');
    await user.click(screen.getByRole('button', { name: /use a recovery code instead/i }));
    expect(screen.queryByLabelText(/code from your authenticator/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/recovery code/i), 'A1B2C-D3E4F');
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    await screen.findByRole('heading', { name: /app is connected/i });
    expect(calls('/device/approve')).toEqual([{ user_code: 'abcd-efgh', recovery_code: 'A1B2C-D3E4F' }]);
  });

  it('denies without typing the code or any second factor', async () => {
    const user = userEvent.setup();
    await reachReview(user);
    await user.click(screen.getByRole('button', { name: /^deny$/i }));
    expect(await screen.findByRole('heading', { name: /you denied it/i })).toBeInTheDocument();
    expect(calls('/device/deny')).toEqual([{ user_code: 'abcd-efgh' }]);
  });

  it('says plainly what went wrong, in words and not codes', async () => {
    lookupAnswer = () => json({ error: 'code_expired', code: 'code_expired', message: 'x' }, 410);
    const user = userEvent.setup();
    renderAt('/collega');
    await user.type(await screen.findByLabelText(/code from the app/i), 'ABCD-EFGH');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/that code has expired/i)).toBeInTheDocument();
  });

  it('says a read-only role cannot approve', async () => {
    approveAnswer = () => json({ error: 'forbidden_role', code: 'forbidden_role', message: 'x' }, 403);
    const user = userEvent.setup();
    await reachReview(user);
    await user.type(screen.getByLabelText(/type the code shown in the app/i), 'ABCDEFGH');
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByText(/your role cannot add devices/i)).toBeInTheDocument();
  });

  it('refuses a malformed code before spending an attempt', async () => {
    const user = userEvent.setup();
    renderAt('/collega');
    await user.type(await screen.findByLabelText(/code from the app/i), 'nope');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/eight letters and numbers/i)).toBeInTheDocument();
    expect(calls('/device/lookup')).toEqual([]);
  });

  it('is available in Italian', async () => {
    await i18n.changeLanguage('it');
    renderAt('/collega');
    expect(await screen.findByLabelText(/codice mostrato dall'app/i)).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const user = userEvent.setup();
    const { container } = renderAt('/collega');
    await user.type(await screen.findByLabelText(/code from the app/i), 'abcd-efgh');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText('Desk PC');
    await expectNoAxeViolations(container);
  });
});

describe('SignedInApps', () => {
  const session = (over: Record<string, unknown>) => ({
    id: 'aps_000000000000000000000001',
    user_id: 'u1',
    organization_id: 'org',
    platform: 'linux',
    device_name: 'Office laptop',
    node_id: 'pk_0123456789abcdef',
    scopes: ['app:self'],
    created_at: '2026-11-23T09:00:00Z',
    last_used_at: null,
    revoked_at: null,
    status: 'active',
    ...over
  });

  function renderList(sessions: unknown[]) {
    let revoked = false;
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/app-auth/sessions') && init?.method === 'DELETE') {
        revoked = true;
        return json({ revoked: true });
      }
      if (url.includes('/app-auth/sessions')) {
        return json({ sessions: revoked ? [] : sessions });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    return renderUI(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SignedInApps />
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  it('lists only active apps and signs one out after a confirmation that says the connection is cut', async () => {
    const user = userEvent.setup();
    renderList([
      session({}),
      session({ id: 'aps_000000000000000000000002', device_name: 'Old phone', status: 'revoked' })
    ]);
    expect(await screen.findByText('Office laptop')).toBeInTheDocument();
    expect(screen.queryByText('Old phone')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^sign out$/i }));
    expect(await screen.findByText(/connection to your network is cut right away/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /sign out and cut it/i }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/app-auth/sessions/aps_000000000000000000000001') &&
            (init as RequestInit).method === 'DELETE'
        )
      ).toBe(true)
    );
    expect(await screen.findByText(/no neronet app is signed in/i)).toBeInTheDocument();
  });
});
