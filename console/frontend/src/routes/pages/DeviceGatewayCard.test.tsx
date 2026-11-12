import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AuthContext, { type AuthValue } from '../../context/AuthContext';
import { setLanguage } from '../../i18n';
import { createQueryClient } from '../../services/queries/client';
import type { MeshNode } from '../../services/types';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { DeviceGatewayCard } from './DeviceGatewayCard';

// An administrator moves a WireGuard-app device to another gateway. Its profile names one
// gateway, so the page must say plainly that the person has to import a new profile.

function authFor(role: string): AuthValue {
  const user = { id: 'u1', username: 'owner', role, organization_id: 'org-a' };
  return {
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
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const HQ = {
  node_id: 'node-gw',
  name: 'HQ Gateway',
  endpoint: 'gw.example.org:51820',
  public_key: 'hqKeyhqKeyhqKeyhqKeyhqKeyhqKeyhqKeyhqKey12=',
  is_default: true,
  devices: 1,
  online: true,
  last_seen_at: null
};
const BRANCH = {
  node_id: 'node-gw2',
  name: 'Branch',
  endpoint: 'branch.example.org:51820',
  public_key: 'brKeybrKeybrKeybrKeybrKeybrKeybrKeybrKey12=',
  is_default: false,
  devices: 0,
  online: true,
  last_seen_at: null
};

const phone = {
  id: 'dev-0123456789ab',
  name: 'Ada phone',
  device_kind: 'profile',
  gateway_node_id: 'node-gw'
} as unknown as MeshNode;

function render({ role = 'admin', gateways = [HQ, BRANCH], moveStatus = 200 } = {}) {
  const moves: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/devices/gateways') return json({ gateways });
      if (url === `/api/devices/${phone.id}/gateway` && init?.method === 'PUT') {
        moves.push(JSON.parse(String(init.body)));
        if (moveStatus !== 200) return json({ error: 'nope' }, moveStatus);
        return json({
          device_id: phone.id,
          gateway: {
            node_id: BRANCH.node_id,
            name: BRANCH.name,
            public_key: BRANCH.public_key,
            endpoint: BRANCH.endpoint
          },
          reimport_required: true
        });
      }
      return json({});
    }) as unknown as typeof fetch
  );
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  const result = renderUI(
    <AuthContext.Provider value={authFor(role)}>
      <QueryClientProvider client={client}>
        <DeviceGatewayCard device={phone} />
      </QueryClientProvider>
    </AuthContext.Provider>
  );
  return { ...result, moves };
}

describe('DeviceGatewayCard', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await setLanguage('en');
  });

  it('names the gateway the device connects through, and passes axe', async () => {
    const { container } = render();
    expect(await screen.findByText('Connects through HQ Gateway at gw.example.org:51820')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('warns before the move that the profile must be imported again, then moves the device', async () => {
    const u = userEvent.setup();
    const { moves } = render();
    await screen.findByText('Connects through HQ Gateway at gw.example.org:51820');
    await u.click(screen.getByRole('button', { name: 'Move device' }));

    const dialog = await screen.findByRole('dialog', { name: 'Move Ada phone to Branch?' });
    expect(
      within(dialog).getByText(
        'After the move, this device cannot connect until its WireGuard profile is replaced. A WireGuard profile names one gateway, so the person must import a new profile on the device.'
      )
    ).toBeInTheDocument();
    expect(moves).toEqual([]);
    await u.click(within(dialog).getByRole('button', { name: 'Move device' }));

    await waitFor(() => expect(moves).toEqual([{ gateway_node_id: 'node-gw2' }]));
    const done = (await screen.findByText(/Ada phone now goes through Branch/)).closest(
      '[role="status"]'
    ) as HTMLElement;
    expect(done).not.toBeNull();
    expect(within(done).getByText(BRANCH.public_key)).toBeInTheDocument();
    expect(within(done).getByText('branch.example.org:51820')).toBeInTheDocument();
  });

  it('says so when the move fails, and nothing claims it moved', async () => {
    const u = userEvent.setup();
    render({ moveStatus: 500 });
    await screen.findByText('Connects through HQ Gateway at gw.example.org:51820');
    await u.click(screen.getByRole('button', { name: 'Move device' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move Ada phone to Branch?' });
    await u.click(within(dialog).getByRole('button', { name: 'Move device' }));
    expect(await screen.findByText('The device was not moved. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/now goes through/)).not.toBeInTheDocument();
  });

  it('offers no move when the organisation has one gateway, and says where to add another', async () => {
    render({ gateways: [HQ] });
    expect(await screen.findByText('There is no other gateway. Add one in Settings.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move device' })).not.toBeInTheDocument();
  });

  it('a user who is not an administrator sees the gateway but cannot move the device', async () => {
    render({ role: 'user' });
    await screen.findByText('Connects through HQ Gateway at gw.example.org:51820');
    expect(screen.getByText('Only an administrator can move a device to another gateway.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move device' })).not.toBeInTheDocument();
  });

  it('gives the warning in Italian', async () => {
    const u = userEvent.setup();
    await setLanguage('it');
    render();
    await screen.findByText('Si collega attraverso HQ Gateway su gw.example.org:51820');
    await u.click(screen.getByRole('button', { name: 'Sposta dispositivo' }));
    const dialog = await screen.findByRole('dialog', { name: 'Spostare Ada phone su Branch?' });
    expect(
      within(dialog).getByText(
        'Dopo lo spostamento questo dispositivo non può collegarsi finché il suo profilo WireGuard non viene sostituito. Un profilo WireGuard indica un solo gateway, quindi la persona deve importare un nuovo profilo sul dispositivo.'
      )
    ).toBeInTheDocument();
  });
});
