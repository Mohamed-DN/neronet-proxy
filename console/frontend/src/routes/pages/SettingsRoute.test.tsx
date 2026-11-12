import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AuthContext, { type AuthValue } from '../../context/AuthContext';
import { createQueryClient } from '../../services/queries/client';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { ShellProvider } from '../shell';
import SettingsRoute from './SettingsRoute';
import { setLanguage } from '../../i18n';

// The page used to keep every setting in local state and pretend to apply it. It now
// reads the organisation from the control plane and saves with PUT.

function authFor(role: string) {
  const user = { id: 'u1', username: 'owner', role, organization_id: 'org-a' };
  const auth: AuthValue = {
    user,
    role,
    token: null,
    loading: false,
    isAuthenticated: true,
    switchRole: () => {},
    login: async () => user,
    completeMfaSignIn: async () => user,
    logout: async () => {},
    refreshUser: async () => {}
  };
  return auth;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const gatewayNode = {
  id: 'node-gw',
  name: 'HQ Gateway',
  overlay_ipv4: '100.64.10.1',
  device_kind: 'mesh',
  is_profile_gateway: true,
  profile_gateway_endpoint: 'gw.example.org:51820'
};
const branchNode = {
  id: 'node-gw2',
  name: 'Branch',
  overlay_ipv4: '100.64.10.2',
  device_kind: 'mesh',
  is_profile_gateway: true,
  profile_gateway_endpoint: 'branch.example.org:51820'
};
const spareNode = { id: 'node-spare', name: 'Spare server', overlay_ipv4: '100.64.10.3', device_kind: 'mesh' };
const phoneNode = { id: 'node-phone', name: 'Ada phone', overlay_ipv4: '100.64.10.9', device_kind: 'profile' };

const GATEWAYS = [
  {
    node_id: 'node-gw',
    name: 'HQ Gateway',
    endpoint: 'gw.example.org:51820',
    public_key: 'k1',
    is_default: true,
    devices: 1,
    online: true,
    overlay_ipv4: '100.64.10.1',
    last_seen_at: new Date(Date.now() - 30_000).toISOString()
  },
  {
    node_id: 'node-gw2',
    name: 'Branch',
    endpoint: 'branch.example.org:51820',
    public_key: 'k2',
    is_default: false,
    devices: 2,
    online: false,
    overlay_ipv4: '100.64.10.2',
    last_seen_at: null
  }
];

interface RenderOptions {
  putStatus?: number;
  role?: string;
  nodes?: unknown[];
  gateways?: unknown[];
  deleteAnswer?: { status: number; body: unknown };
}

function render({
  putStatus = 200,
  role = 'user',
  nodes = [gatewayNode, branchNode, spareNode, phoneNode],
  gateways = GATEWAYS,
  deleteAnswer = { status: 200, body: { removed: 'node-gw2' } }
}: RenderOptions = {}) {
  const puts: unknown[] = [];
  const gatewayPuts: unknown[] = [];
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') calls.push(`${method} ${url}`);
      if (url === '/api/organizations/org-a' && method === 'PUT') {
        const body = JSON.parse(String(init?.body));
        puts.push(body);
        return putStatus === 200
          ? json({ organization: { id: 'org-a', name: 'A', slug: 'a', ...body, profile: 'standard' } })
          : json({ error: 'Forbidden' }, putStatus);
      }
      if (url === '/api/devices/gateway' && method === 'PUT') {
        gatewayPuts.push(JSON.parse(String(init?.body)));
        return json({
          gateway: { node_id: 'node-spare', public_key: 'k3', endpoint: 'spare.example.org:51820', is_default: false }
        });
      }
      if (url.startsWith('/api/devices/gateways/') && method === 'PUT') {
        return json({ gateway: { ...GATEWAYS[1], is_default: true } });
      }
      if (url.startsWith('/api/devices/gateways/') && method === 'DELETE') {
        return json(deleteAnswer.body, deleteAnswer.status);
      }
      if (url === '/api/devices/gateways') return json({ gateways });
      if (url === '/api/organizations/org-a') {
        return json({
          organization: {
            id: 'org-a',
            name: 'A',
            slug: 'a',
            default_policy: 'deny',
            max_netmap_staleness_seconds: 300,
            profile: 'regulated'
          }
        });
      }
      if (url === '/api/organizations/org-a/modules') return json({ modules: [{ module_id: 'nuke', enabled: false }] });
      if (url === '/api/nodes') return json({ nodes });
      return json({});
    }) as unknown as typeof fetch
  );
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  const result = renderUI(
    <AuthContext.Provider value={authFor(role)}>
      <QueryClientProvider client={client}>
        <ShellProvider>
          <MemoryRouter initialEntries={['/settings']}>
            <Routes>
              <Route path="/settings" element={<SettingsRoute />} />
            </Routes>
          </MemoryRouter>
        </ShellProvider>
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  return { ...result, puts, gatewayPuts, calls };
}

/** The row of the gateways table that names `name`. */
async function gatewayRow(name: string, table = 'Gateways'): Promise<HTMLElement> {
  const found = await screen.findByRole('table', { name: table });
  // The name cell, not the button labels that also carry the name for a screen reader.
  return (await within(found).findByText(name, { selector: 'td > span' })).closest('tr') as HTMLElement;
}

describe('SettingsRoute', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows what the control plane holds, and passes axe', async () => {
    const { container } = render();
    expect(await screen.findByDisplayValue('300')).toBeInTheDocument();
    expect(screen.getByText('Strict (for regulated sectors)')).toBeInTheDocument();
    expect(screen.getByText('Data erasure')).toBeInTheDocument();
    expect(screen.queryByText(/VLESS Reality|ShadowTLS|QUIC MASQUE/)).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('saves through the API', async () => {
    const u = userEvent.setup();
    const { puts } = render();
    const input = await screen.findByDisplayValue('300');
    await u.clear(input);
    await u.type(input, '600');
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(puts).toEqual([{ default_policy: 'deny', max_netmap_staleness_seconds: 600 }]));
  });

  it('says so when the caller may not change the settings', async () => {
    const u = userEvent.setup();
    render({ putStatus: 403 });
    await screen.findByDisplayValue('300');
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(
      await screen.findByText("Only the organisation's owner or an administrator can change these settings.")
    ).toBeInTheDocument();
  });

  it('lists every gateway with its address, the default, the devices it serves and when it was last seen', async () => {
    const { container } = render({ role: 'admin' });
    const hq = await gatewayRow('HQ Gateway');
    expect(within(hq).getByText('gw.example.org:51820')).toBeInTheDocument();
    expect(within(hq).getByText('Default')).toBeInTheDocument();
    expect(within(hq).getByText('1')).toBeInTheDocument();
    const branch = await gatewayRow('Branch');
    expect(within(branch).getByText('branch.example.org:51820')).toBeInTheDocument();
    expect(within(branch).getByText('2')).toBeInTheDocument();
    expect(within(branch).getByText('Never')).toBeInTheDocument();
    expect(within(branch).queryByText('Default')).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('adds a gateway from a device that is not one yet, with its public address', async () => {
    const u = userEvent.setup();
    const { gatewayPuts } = render({ role: 'admin' });
    await gatewayRow('Branch');
    await u.type(await screen.findByLabelText(/public address and port/i), 'spare.example.org:51820');
    await u.click(screen.getByRole('button', { name: 'Add gateway' }));
    await waitFor(() => expect(gatewayPuts).toEqual([{ node_id: 'node-spare', endpoint: 'spare.example.org:51820' }]));
  });

  it('refuses an invalid gateway endpoint before any request is sent', async () => {
    const u = userEvent.setup();
    const { gatewayPuts } = render({ role: 'admin' });
    await gatewayRow('Branch');
    await u.type(await screen.findByLabelText(/public address and port/i), 'not an endpoint');
    await u.click(screen.getByRole('button', { name: 'Add gateway' }));
    expect(await screen.findByText('Write an address and a port, like gw.example.org:51820.')).toBeInTheDocument();
    expect(gatewayPuts).toEqual([]);
  });

  it('makes another gateway the default; the default itself offers no such button', async () => {
    const u = userEvent.setup();
    const { calls } = render({ role: 'admin' });
    const hq = await gatewayRow('HQ Gateway');
    expect(within(hq).queryByRole('button', { name: /default/i })).not.toBeInTheDocument();
    await u.click(within(await gatewayRow('Branch')).getByRole('button', { name: 'Make default: Branch' }));
    await waitFor(() => expect(calls).toContain('PUT /api/devices/gateways/node-gw2/default'));
  });

  it('asks before removing a gateway, and says how many devices still use it when refused', async () => {
    const u = userEvent.setup();
    const { calls } = render({
      role: 'admin',
      deleteAnswer: { status: 409, body: { code: 'profile_gateway_serves_devices', devices: 2, error: 'x' } }
    });
    await u.click(within(await gatewayRow('Branch')).getByRole('button', { name: 'Remove Branch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Branch as a gateway?' });
    expect(
      within(dialog).getByText(
        'The device stays on the network. It stops accepting phones and computers that use the WireGuard app.'
      )
    ).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Remove gateway' }));
    await waitFor(() => expect(calls).toContain('DELETE /api/devices/gateways/node-gw2'));
    expect(
      await screen.findByText(
        'Branch still serves 2 devices. Move them to another gateway from Devices, then remove it.'
      )
    ).toBeInTheDocument();
  });

  it('says to hand the default on first when the default cannot be removed', async () => {
    const u = userEvent.setup();
    render({ role: 'admin', deleteAnswer: { status: 409, body: { code: 'profile_gateway_is_default', error: 'x' } } });
    await u.click(within(await gatewayRow('HQ Gateway')).getByRole('button', { name: 'Remove HQ Gateway' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove HQ Gateway as a gateway?' });
    await u.click(within(dialog).getByRole('button', { name: 'Remove gateway' }));
    expect(
      await screen.findByText(
        'New devices join through HQ Gateway. Make another gateway the default first, then remove it.'
      )
    ).toBeInTheDocument();
  });

  it('says what to do when the organisation has no gateway yet', async () => {
    render({ role: 'admin', gateways: [] });
    expect(
      await screen.findByText('No gateway yet. Phones and computers cannot be added until you add one.')
    ).toBeInTheDocument();
  });

  it('a user who may not manage gateways sees them, is told who may, and gets no buttons', async () => {
    render({ role: 'user' });
    await gatewayRow('Branch');
    expect(
      screen.getByText(/only a platform administrator or an administrator can manage gateways/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add gateway' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /default$/ })).not.toBeInTheDocument();
  });

  it('labels the gateways table in Italian', async () => {
    await setLanguage('it');
    try {
      render({ role: 'admin' });
      const row = await gatewayRow('Branch', 'Gateway');
      expect(within(row).getByText('Mai')).toBeInTheDocument();
      expect(within(row).getByRole('button', { name: 'Rendi predefinito: Branch' })).toBeInTheDocument();
      expect(within(await gatewayRow('HQ Gateway', 'Gateway')).getByText('Predefinito')).toBeInTheDocument();
    } finally {
      await setLanguage('en');
    }
  });

  it('the regulated profile does not claim plausible deniability', async () => {
    const { container } = render();
    await screen.findByDisplayValue('300');
    expect(container.textContent ?? '').not.toMatch(/deniab|negabilit/i);
    expect(screen.getByText(/Only the platform administrator can change this level/i)).toBeInTheDocument();
  });
});
