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
  platform: 'windows',
  device_name: 'Desk PC',
  request_ip: '203.0.113.7',
  requested_at: '2026-11-23T10:00:00Z',
  expires_at: '2026-11-23T10:10:00Z',
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
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
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

describe('AppConnectRoute', () => {
  it('shows what is asking, then approves it', async () => {
    const user = userEvent.setup();
    renderAt('/collega');
    await user.type(await screen.findByLabelText(/code from the app/i), 'abcd-efgh');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText('Desk PC')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
    expect(screen.getByText('Windows')).toBeInTheDocument();
    expect(calls('/device/lookup')).toEqual([{ user_code: 'abcd-efgh' }]);

    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByRole('heading', { name: /app is connected/i })).toBeInTheDocument();
    expect(calls('/device/approve')).toEqual([{ user_code: 'abcd-efgh' }]);
  });

  it('takes the code from the link, removes it from the address and goes straight to the review', async () => {
    renderAt('/collega?code=ABCD-EFGH');
    expect(await screen.findByText('Desk PC')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/collega$/));
    expect(calls('/device/lookup')).toEqual([{ user_code: 'ABCD-EFGH' }]);
  });

  it('asks for the authenticator code when the account needs one, and sends it', async () => {
    lookupAnswer = () => json({ ...REQUEST, mfa_required: true });
    const user = userEvent.setup();
    renderAt('/collega?code=ABCD-EFGH');
    await screen.findByText('Desk PC');
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(await screen.findByText(/enter the code from your authenticator to approve/i)).toBeInTheDocument();
    expect(calls('/device/approve')).toEqual([]);

    await user.type(screen.getByLabelText(/code from your authenticator/i), '123456');
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    await screen.findByRole('heading', { name: /app is connected/i });
    expect(calls('/device/approve')).toEqual([{ user_code: 'ABCD-EFGH', totp_code: '123456' }]);
  });

  it('denies without any second factor', async () => {
    const user = userEvent.setup();
    renderAt('/collega?code=ABCD-EFGH');
    await screen.findByText('Desk PC');
    await user.click(screen.getByRole('button', { name: /^deny$/i }));
    expect(await screen.findByRole('heading', { name: /you denied it/i })).toBeInTheDocument();
    expect(calls('/device/deny')).toEqual([{ user_code: 'ABCD-EFGH' }]);
  });

  it('says plainly what went wrong, in words and not codes', async () => {
    lookupAnswer = () => json({ error: 'code_expired', code: 'code_expired', message: 'x' }, 410);
    const user = userEvent.setup();
    renderAt('/collega');
    await user.type(await screen.findByLabelText(/code from the app/i), 'ABCD-EFGH');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(await screen.findByText(/that code has expired/i)).toBeInTheDocument();
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
    const { container } = renderAt('/collega?code=ABCD-EFGH');
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
