import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AuthContext, { type AuthValue } from '../../context/AuthContext';
import { createQueryClient } from '../../services/queries/client';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { ShellProvider } from '../shell';
import SettingsRoute from './SettingsRoute';
import '../../i18n';

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
  profile_gateway_endpoint: 'gw.example.org:51820'
};

const phoneNode = { id: 'node-phone', name: 'Ada phone', overlay_ipv4: '100.64.10.9', device_kind: 'profile' };

function render({ putStatus = 200, role = 'user', nodes = [gatewayNode, phoneNode] } = {}) {
  const puts: unknown[] = [];
  const gatewayPuts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/organizations/org-a' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        puts.push(body);
        return putStatus === 200
          ? json({ organization: { id: 'org-a', name: 'A', slug: 'a', ...body, profile: 'standard' } })
          : json({ error: 'Forbidden' }, putStatus);
      }
      if (url === '/api/devices/gateway' && init?.method === 'PUT') {
        gatewayPuts.push(JSON.parse(String(init.body)));
        return json({ gateway: { node_id: 'node-gw', public_key: 'k', endpoint: 'gw2.example.org:51820' } });
      }
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
  return { ...result, puts, gatewayPuts };
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

  it('shows the current gateway from profile_gateway_endpoint', async () => {
    render({ role: 'admin' });
    expect(await screen.findByText('Current gateway: HQ Gateway at gw.example.org:51820')).toBeInTheDocument();
  });

  it('refuses an invalid gateway endpoint before any request is sent', async () => {
    const u = userEvent.setup();
    const { gatewayPuts } = render({ role: 'admin' });
    const endpoint = await screen.findByLabelText(/public address and port/i);
    await u.clear(endpoint);
    await u.type(endpoint, 'not an endpoint');
    await u.click(screen.getByRole('button', { name: 'Save gateway' }));

    expect(await screen.findByText('Write an address and a port, like gw.example.org:51820.')).toBeInTheDocument();
    expect(gatewayPuts).toEqual([]);
  });

  it('saving the gateway sends the chosen device and the endpoint to PUT /api/devices/gateway', async () => {
    const u = userEvent.setup();
    const { gatewayPuts } = render({ role: 'admin' });
    // Wait for the saved gateway to load, so the test edits the value the page actually shows.
    await screen.findByText('Current gateway: HQ Gateway at gw.example.org:51820');
    const endpoint = await screen.findByLabelText(/public address and port/i);
    await u.clear(endpoint);
    await u.type(endpoint, 'gw2.example.org:51820');
    await u.click(screen.getByRole('button', { name: 'Save gateway' }));

    await waitFor(() => expect(gatewayPuts).toEqual([{ node_id: 'node-gw', endpoint: 'gw2.example.org:51820' }]));
  });

  it('a user who may not choose the gateway is told who may, and gets no save button', async () => {
    render({ role: 'user' });
    expect(
      await screen.findByText(/only a platform administrator or an administrator can choose the gateway/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save gateway' })).not.toBeInTheDocument();
  });

  it('the regulated profile does not claim plausible deniability', async () => {
    const { container } = render();
    await screen.findByDisplayValue('300');
    expect(container.textContent ?? '').not.toMatch(/deniab|negabilit/i);
    expect(screen.getByText(/Only the platform administrator can change this level/i)).toBeInTheDocument();
  });
});
