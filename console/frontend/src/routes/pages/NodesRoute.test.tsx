import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, storeSession } from '../../services/authToken';
import { createQueryClient } from '../../services/queries';
import { setLanguage } from '../../i18n';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import type { ThemeName } from '../../ui/tokens';
import { ShellProvider } from '../shell';
import NodesRoute from './NodesRoute';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

const mockNodes = [
  {
    id: 'svrn-node-rome',
    name: 'Rome Gateway Alpha',
    hostname: 'gw-rome-01',
    overlay_ipv4: '10.200.0.1',
    overlay_ipv6: 'fd00:beef::1',
    role: 'EXIT_BRIDGE',
    device_kind: 'mesh',
    country_code: 'IT',
    is_healthy: true,
    is_quarantined: false,
    posture_status: 'verified_compliant',
    posture_checks: {
      disk_encrypted: true,
      firewall_active: true,
      os_name: 'Linux',
      os_version: '6.6.0',
      is_rootless: true,
      measured_at: '2026-09-24T07:00:00Z'
    },
    risk_score: 15,
    public_key: 'WGPubKeyRome11111111111111111111111111111111=',
    last_heartbeat: new Date().toISOString()
  },
  {
    id: 'svrn-node-berlin',
    name: 'Berlin Relay Bravo',
    hostname: 'relay-berlin-01',
    overlay_ipv4: '10.200.0.2',
    overlay_ipv6: 'fd00:beef::2',
    role: 'RELAY',
    device_kind: 'mesh',
    country_code: 'DE',
    is_healthy: true,
    is_quarantined: false,
    posture_status: 'unverified',
    posture_checks: {
      disk_encrypted: null,
      firewall_active: null,
      os_name: 'Linux',
      os_version: '6.6.0',
      is_rootless: null,
      measured_at: null
    },
    risk_score: null,
    public_key: 'WGPubKeyBerlin2222222222222222222222222222222=',
    last_heartbeat: new Date().toISOString()
  },
  {
    id: 'svrn-node-paris',
    name: 'Paris Client Charlie',
    hostname: 'client-paris-01',
    overlay_ipv4: '10.200.0.3',
    overlay_ipv6: 'fd00:beef::3',
    role: 'CLIENT_ORIGIN',
    device_kind: 'profile',
    country_code: 'FR',
    is_healthy: false,
    is_quarantined: true,
    quarantine_reason: 'Detected anomalous egress burst',
    posture_status: 'non_compliant',
    posture_checks: {
      disk_encrypted: false,
      firewall_active: false,
      os_name: 'Linux',
      os_version: '6.1.0',
      is_rootless: false
    },
    risk_score: 85,
    public_key: 'WGPubKeyParis33333333333333333333333333333333=',
    last_heartbeat: new Date(Date.now() - 3600_000).toISOString()
  }
];

function renderNodes(initialEntries = ['/nodes'], theme: ThemeName = 'light') {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, refetchOnWindowFocus: false }
  });

  const result = renderUI(
    <QueryClientProvider client={queryClient}>
      <ShellProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <Routes>
            <Route path="/nodes" element={<NodesRoute />} />
            <Route path="/nodes/:id" element={<NodesRoute />} />
          </Routes>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
    { theme }
  );

  return { queryClient, ...result };
}

/** The fleet list only, so names in the open detail dialog do not match twice. */
function listTable(): HTMLElement {
  return screen.getByRole('table');
}

function fleetFetch(nodes: unknown[]) {
  return vi.fn(async (url: string) => (url === '/api/nodes' ? jsonResponse({ nodes }) : jsonResponse({})));
}

describe('Devices page', () => {
  beforeEach(() => {
    localStorage.clear();
    storeSession({ token: 'test-token' });
    vi.stubGlobal(
      'WebSocket',
      class {
        close() {}
        send() {}
        addEventListener() {}
        removeEventListener() {}
      }
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    clearSession();
    await setLanguage('en');
    localStorage.clear();
  });

  it('lists devices in plain words, with checks not confirmed and an em dash for an unscored risk', async () => {
    vi.stubGlobal('fetch', fleetFetch(mockNodes));

    renderNodes();

    expect(screen.getByRole('heading', { name: 'Devices', level: 1 })).toBeInTheDocument();
    await within(await screen.findByRole('table')).findByText('Rome Gateway Alpha');
    expect(screen.getByText('Checks passed')).toBeInTheDocument();
    expect(screen.getByText('Not confirmed')).toBeInTheDocument();
    expect(screen.getByText('Checks failed')).toBeInTheDocument();
    const berlin = within(listTable()).getByText('Berlin Relay Bravo').closest('tr') as HTMLElement;
    expect(within(berlin).getByText('—')).toBeInTheDocument();
  });

  it('reads Unknown type when a device has no role', async () => {
    const noRole = { ...mockNodes[0], id: 'svrn-node-norole', name: 'No Role Delta', role: undefined };
    vi.stubGlobal('fetch', fleetFetch([noRole]));

    renderNodes();

    await waitFor(() => {
      expect(within(listTable()).getByText('No Role Delta')).toBeInTheDocument();
    });
    expect(within(listTable()).getByText('Unknown type')).toBeInTheDocument();
  });

  it('names the profile gateway and WireGuard-app devices by what they are', async () => {
    const gateway = {
      ...mockNodes[1],
      id: 'svrn-node-gw',
      name: 'Office Gateway',
      role: 'CLIENT_ORIGIN',
      is_profile_gateway: true,
      profile_gateway_endpoint: '203.0.113.9:51820'
    };
    const phone = {
      ...mockNodes[1],
      id: 'svrn-node-phone',
      name: 'Owner iPhone',
      role: 'CLIENT_ORIGIN',
      device_kind: 'profile',
      last_heartbeat: null,
      last_handshake_at: new Date(Date.now() - 20_000).toISOString()
    };
    vi.stubGlobal('fetch', fleetFetch([gateway, phone]));

    renderNodes();

    const gwRow = (await within(await screen.findByRole('table')).findByText('Office Gateway')).closest(
      'tr'
    ) as HTMLElement;
    const phoneRow = within(listTable()).getByText('Owner iPhone').closest('tr') as HTMLElement;
    expect(within(gwRow).getByText('Gateway')).toBeInTheDocument();
    expect(within(phoneRow).getByText('WireGuard profile')).toBeInTheDocument();
    expect(within(listTable()).queryByText('User device')).toBeNull();
  });

  it('judges a WireGuard-app device by the handshake its gateway reported', async () => {
    const base = { ...mockNodes[1], role: 'CLIENT_ORIGIN', device_kind: 'profile', last_heartbeat: null };
    const fresh = {
      ...base,
      id: 'p-fresh',
      name: 'Fresh Phone',
      last_handshake_at: new Date(Date.now() - 30_000).toISOString()
    };
    const stale = {
      ...base,
      id: 'p-stale',
      name: 'Stale Phone',
      last_handshake_at: new Date(Date.now() - 10 * 60_000).toISOString()
    };
    const never = { ...base, id: 'p-never', name: 'Never Phone', last_handshake_at: null };
    vi.stubGlobal('fetch', fleetFetch([fresh, stale, never]));

    renderNodes();

    const row = async (name: string) =>
      (await within(await screen.findByRole('table')).findByText(name)).closest('tr') as HTMLElement;
    expect(within(await row('Fresh Phone')).getByText('Reachable')).toBeInTheDocument();
    expect(within(await row('Stale Phone')).getByText('Last connected 10 minutes ago')).toBeInTheDocument();
    expect(within(await row('Never Phone')).getByText('Not measured')).toBeInTheDocument();
    expect(within(listTable()).queryByText('Unreachable')).toBeNull();
  });

  it('labels the gateway and profile devices in Italian', async () => {
    const gateway = { ...mockNodes[1], id: 'gw-it', name: 'Gateway Ufficio', is_profile_gateway: true };
    const phone = { ...mockNodes[1], id: 'ph-it', name: 'iPhone', device_kind: 'profile', last_handshake_at: null };
    vi.stubGlobal('fetch', fleetFetch([gateway, phone]));

    await setLanguage('it');
    renderNodes();

    const phoneRow = (await within(await screen.findByRole('table')).findByText('iPhone')).closest('tr') as HTMLElement;
    expect(within(phoneRow).getByText('Profilo WireGuard')).toBeInTheDocument();
    expect(within(phoneRow).getByText('Non misurato')).toBeInTheDocument();
    const gwRow = within(listTable()).getByText('Gateway Ufficio').closest('tr') as HTMLElement;
    expect(within(gwRow).getByText('Gateway')).toBeInTheDocument();
  });

  it('will not revoke the profile gateway, and says what to do instead', async () => {
    const gateway = { ...mockNodes[0], is_profile_gateway: true, profile_gateway_endpoint: '203.0.113.9:51820' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/nodes') return jsonResponse({ nodes: [gateway] });
        if (url.endsWith('/api/nodes/svrn-node-rome')) return jsonResponse({ node: gateway });
        return jsonResponse({});
      })
    );

    renderNodes(['/nodes/svrn-node-rome']);

    const dialog = await screen.findByRole('dialog');
    const revoke = await within(dialog).findByRole('button', { name: 'Disconnect and revoke key' });
    expect(revoke).toBeDisabled();
    expect(
      within(dialog).getByText(
        'This device is the gateway for WireGuard profiles. Revoking it would disconnect every device that uses the WireGuard app. Make another device the gateway first.'
      )
    ).toBeInTheDocument();
  });

  it('filters by search and by block status', async () => {
    vi.stubGlobal('fetch', fleetFetch(mockNodes));

    const user = userEvent.setup();
    renderNodes();

    await waitFor(() => {
      expect(within(listTable()).getByText('Rome Gateway Alpha')).toBeInTheDocument();
    });

    await user.type(screen.getByRole('textbox'), 'Berlin');
    expect(within(listTable()).getByText('Berlin Relay Bravo')).toBeInTheDocument();
    expect(within(listTable()).queryByText('Rome Gateway Alpha')).not.toBeInTheDocument();

    await user.clear(screen.getByRole('textbox'));
    await user.click(screen.getByRole('button', { name: 'Blocked' }));
    expect(within(listTable()).getByText('Paris Client Charlie')).toBeInTheDocument();
    expect(within(listTable()).queryByText('Berlin Relay Bravo')).not.toBeInTheDocument();
  });

  it('filters with no match show FilteredEmptyState with Clear filters', async () => {
    vi.stubGlobal('fetch', fleetFetch(mockNodes));

    const user = userEvent.setup();
    renderNodes();

    await waitFor(() => {
      expect(within(listTable()).getByText('Rome Gateway Alpha')).toBeInTheDocument();
    });

    await user.type(screen.getByRole('textbox'), 'no such device');
    expect(screen.getByText('No devices match these filters')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(within(listTable()).getByText('Rome Gateway Alpha')).toBeInTheDocument();
  });

  it('says Not measured when the test did not measure a response time, not a number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/nodes') return jsonResponse({ nodes: [mockNodes[0]] });
        if (url.endsWith('/api/nodes/svrn-node-rome/action')) {
          return jsonResponse({
            success: true,
            result: { rtt_ms: null, jitter_ms: null, measured: false, status: 'active' }
          });
        }
        if (url.endsWith('/api/nodes/svrn-node-rome')) return jsonResponse({ node: mockNodes[0] });
        return jsonResponse({});
      })
    );

    const user = userEvent.setup();
    renderNodes(['/nodes/svrn-node-rome']);

    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Test connection' }));

    await waitFor(() => {
      expect(within(dialog).getByText(/Not measured/)).toBeInTheDocument();
    });
    expect(within(dialog).queryByText(/Replied in/)).not.toBeInTheDocument();
  });

  it('ping failure shows the inline alert that says what to do', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/nodes') return jsonResponse({ nodes: [mockNodes[0]] });
        if (url.endsWith('/api/nodes/svrn-node-rome/action')) {
          return jsonResponse({ error: 'unreachable' }, 502);
        }
        if (url.endsWith('/api/nodes/svrn-node-rome')) return jsonResponse({ node: mockNodes[0] });
        return jsonResponse({});
      })
    );

    const user = userEvent.setup();
    renderNodes(['/nodes/svrn-node-rome']);

    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Test connection' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Test failed: the device did not respond. Try again.');
  });

  it('block asks for a reason, then sends the request', async () => {
    let blocked = false;
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === '/api/nodes') return jsonResponse({ nodes: [{ ...mockNodes[0], is_quarantined: blocked }] });
      if (url.endsWith('/api/nodes/svrn-node-rome/quarantine')) {
        blocked = true;
        return jsonResponse({ success: true });
      }
      if (url.endsWith('/api/nodes/svrn-node-rome')) {
        return jsonResponse({ node: { ...mockNodes[0], is_quarantined: blocked } });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchSpy);

    const user = userEvent.setup();
    renderNodes(['/nodes/svrn-node-rome']);

    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Block device' }));

    const confirm = await screen.findByRole('dialog', { name: 'Block this device?' });
    await user.type(within(confirm).getByLabelText('Reason (optional)'), 'Testing security response');
    await user.click(within(confirm).getByRole('button', { name: 'Block device' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/nodes/svrn-node-rome/quarantine'),
        expect.objectContaining({ method: 'POST', body: expect.stringContaining('Testing security response') })
      );
    });
  });

  it('revoke sends the localised default reason', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === '/api/nodes') return jsonResponse({ nodes: [mockNodes[0]] });
      if (url.endsWith('/api/nodes/svrn-node-rome/revoke')) return jsonResponse({ success: true });
      if (url.endsWith('/api/nodes/svrn-node-rome')) return jsonResponse({ node: mockNodes[0] });
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchSpy);

    const user = userEvent.setup();
    renderNodes(['/nodes/svrn-node-rome']);

    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Disconnect and revoke key' }));

    const confirm = await screen.findByRole('dialog', { name: 'Revoke the key of Rome Gateway Alpha?' });
    await user.type(within(confirm).getByRole('textbox'), 'Rome Gateway Alpha');
    await user.click(within(confirm).getByRole('button', { name: 'Revoke key' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/nodes/svrn-node-rome/revoke'),
        expect.objectContaining({ body: expect.stringContaining('Key revoked by an administrator') })
      );
    });
  });

  it('shows no English device values in Italian', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/nodes') return jsonResponse({ nodes: [mockNodes[0]] });
        if (url.endsWith('/api/nodes/svrn-node-rome')) return jsonResponse({ node: mockNodes[0] });
        return jsonResponse({});
      })
    );

    await setLanguage('it');
    renderNodes(['/nodes/svrn-node-rome']);

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.textContent).toContain('Sì'));
    const text = dialog.textContent ?? '';
    for (const english of ['Encrypted', 'Plaintext', 'Active', 'Inactive', 'Yes', 'Rootless']) {
      expect(text).not.toContain(english);
    }
    expect(text).toContain('Attivo');
  });

  it('empty fleet offers Add device', async () => {
    vi.stubGlobal('fetch', fleetFetch([]));

    const { container } = renderNodes(['/nodes']);

    await waitFor(() => {
      expect(screen.getByText('No devices found')).toBeInTheDocument();
    });
    expect(screen.getAllByRole('button', { name: 'Add device' }).length).toBeGreaterThan(0);
    await expectNoAxeViolations(container, 'light');
  });

  it.each(['light', 'dark'] as const)('has no axe violations with the list in %s theme', async (theme) => {
    vi.stubGlobal('fetch', fleetFetch(mockNodes));

    const { container, unmount } = renderNodes(['/nodes'], theme);
    await waitFor(() => {
      expect(within(listTable()).getByText('Rome Gateway Alpha')).toBeInTheDocument();
    });
    await expectNoAxeViolations(container, theme);
    unmount();
  });
});
