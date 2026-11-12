import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AuthContext, { type AuthValue } from '../../../context/AuthContext';
import { expectNoAxeViolations, renderUI } from '../../../test/harness';
import { InvitationsPanel } from './InvitationsPanel';

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async (_value: string, _options: unknown) => 'data:image/png;base64,AAA') }
}));

const TOKEN = 'Q2hpYXZlLWRpLXByb3ZhLWxhcmdhLTMyLWJ5dGVzLXg';
const CODE = '7K3M-Q9TD-X2WA';
const IN_A_WEEK = new Date(Date.now() + 7 * 86_400_000).toISOString();

function authAs(role: string, orgRole: string | null): AuthValue {
  const user = { id: 'usr-me', username: 'me', role, org_role: orgRole } as unknown as NonNullable<AuthValue['user']>;
  return {
    user,
    role,
    token: 't',
    loading: false,
    isAuthenticated: true,
    switchRole: () => {},
    login: async () => user,
    completeMfaSignIn: async () => user,
    logout: async () => {},
    refreshUser: async () => {}
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const pending = {
  id: 'inv-1',
  organization_id: 'org-a',
  role: 'member',
  display_name_hint: 'Zia Carla',
  created_by: 'usr-me',
  created_by_username: 'me',
  created_at: new Date().toISOString(),
  expires_at: IN_A_WEEK,
  used_at: null,
  used_by: null,
  used_by_username: null,
  revoked_at: null,
  status: 'pending'
};
const used = {
  ...pending,
  id: 'inv-2',
  display_name_hint: null,
  status: 'used',
  used_at: new Date().toISOString(),
  used_by: 'usr-nonno',
  used_by_username: 'nonno'
};

let orgs: { id: string; name: string }[];
let invitations: Record<string, unknown>[];
let fetchMock: ReturnType<typeof vi.fn>;

function calls(method: string, fragment: string) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url).includes(fragment) && ((init as RequestInit)?.method ?? 'GET') === method
  );
}

beforeEach(() => {
  orgs = [{ id: 'org-a', name: 'Casa Rossi' }];
  invitations = [pending, used];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/organizations') && method === 'GET') return json({ organizations: orgs });
    if (url.includes('/invitations') && method === 'GET') return json({ invitations });
    if (url.includes('/invitations') && method === 'POST') {
      const body = JSON.parse(String(init?.body));
      return json(
        {
          invitation: { ...pending, id: 'inv-new', role: body.role, display_name_hint: body.display_name_hint ?? null },
          token: TOKEN,
          code: CODE
        },
        201
      );
    }
    if (url.includes('/invitations/') && method === 'DELETE') {
      return json({ invitation: { ...pending, status: 'revoked', revoked_at: new Date().toISOString() } });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Harness() {
  const [open, setOpen] = useState(false);
  return <InvitationsPanel inviteOpen={open} onInviteOpenChange={setOpen} />;
}

function renderPanel(auth = authAs('user', 'owner')) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return renderUI(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>
    </AuthContext.Provider>
  );
}

describe('InvitationsPanel', () => {
  it('lists the invitations of the organisation with what each became', async () => {
    renderPanel();
    expect(await screen.findByText('Zia Carla')).toBeInTheDocument();
    expect(screen.getByText(/waiting/i)).toBeInTheDocument();
    expect(screen.getByText(/used by nonno/i)).toBeInTheDocument();
    expect(calls('GET', '/api/organizations/org-a/invitations')).toHaveLength(1);
  });

  it('creates an invitation and shows the link, the code and a QR code once, with copy buttons and the expiry', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPanel();

    await user.click(await screen.findByRole('button', { name: /invite a person/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/who is it for/i), 'Cugino Piero');
    await user.click(within(dialog).getByRole('button', { name: /create the invitation/i }));

    const link = `${window.location.origin}/invito#${TOKEN}`;
    expect(await within(dialog).findByText(link)).toBeInTheDocument();
    expect(within(dialog).getByText(CODE)).toBeInTheDocument();
    expect(within(dialog).getByText(/you will not see them again/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/valid until/i)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole('img', { name: /qr code/i })).toBeInTheDocument());
    const qrcode = (await import('qrcode')).default;
    expect(vi.mocked(qrcode.toDataURL).mock.calls.at(-1)?.[0]).toBe(link);

    const [, init] = calls('POST', '/api/organizations/org-a/invitations')[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      role: 'member',
      expires_in_days: 7,
      display_name_hint: 'Cugino Piero'
    });

    await user.click(within(dialog).getByRole('button', { name: /copy the link/i }));
    expect(writeText).toHaveBeenCalledWith(link);
    await user.click(within(dialog).getByRole('button', { name: /copy the code/i }));
    expect(writeText).toHaveBeenCalledWith(CODE);

    // Closed means gone: opening the dialog again starts a new invitation.
    await user.click(within(dialog).getByRole('button', { name: /^done$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(CODE)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /invite a person/i }));
    expect(await screen.findByRole('button', { name: /create the invitation/i })).toBeInTheDocument();
  });

  it('offers only the roles at or below the caller’s own, never owner', async () => {
    const user = userEvent.setup();
    renderPanel(authAs('user', 'admin'));
    await user.click(await screen.findByRole('button', { name: /invite a person/i }));
    await user.click(await screen.findByRole('combobox', { name: /role/i }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(options).toHaveLength(4);
    expect(options.join(' ')).not.toMatch(/owner/i);
  });

  it('withdraws a pending invitation after asking, and offers nothing to withdraw on a used one', async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText('Zia Carla');
    const withdrawButtons = screen.getAllByRole('button', { name: /withdraw/i });
    expect(withdrawButtons).toHaveLength(1);

    await user.click(withdrawButtons[0]!);
    const confirm = await screen.findByRole('dialog');
    expect(confirm).toHaveTextContent(/zia carla/i);
    await user.click(within(confirm).getByRole('button', { name: /withdraw the invitation/i }));
    await waitFor(() => expect(calls('DELETE', '/api/organizations/org-a/invitations/inv-1')).toHaveLength(1));
  });

  it('a platform administrator chooses the organisation', async () => {
    orgs = [
      { id: 'org-a', name: 'Casa Rossi' },
      { id: 'org-b', name: 'Casa Bianchi' }
    ];
    const user = userEvent.setup();
    renderPanel(authAs('super-admin', null));
    await user.click(await screen.findByRole('combobox', { name: /organisation/i }));
    await user.click(await screen.findByRole('option', { name: 'Casa Bianchi' }));
    await waitFor(() => expect(calls('GET', '/api/organizations/org-b/invitations')).toHaveLength(1));
  });

  it('says what to do when there are none', async () => {
    invitations = [];
    renderPanel();
    expect(await screen.findByText(/no invitations yet/i)).toBeInTheDocument();
  });

  it('has no accessibility violations in the list and in the result', async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await screen.findByText('Zia Carla');
    await expectNoAxeViolations(container);
    await user.click(screen.getByRole('button', { name: /invite a person/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /create the invitation/i }));
    await within(dialog).findByText(CODE);
    await expectNoAxeViolations(document.body);
  });
});
