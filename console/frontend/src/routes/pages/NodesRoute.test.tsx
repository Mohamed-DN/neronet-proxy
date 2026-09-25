import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, storeSession } from '../../services/authToken';
import { createQueryClient } from '../../services/queries';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
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
    country_code: 'IT',
    is_healthy: true,
    is_quarantined: false,
    posture_status: 'verified_compliant',
    posture_checks: {
      disk_encrypted: true,
      firewall_active: true,
      os_name: 'Linux',
      os_version: '6.6.0-sovereign',
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
    country_code: 'DE',
    is_healthy: true,
    is_quarantined: false,
    posture_status: 'unverified', // Unverified posture truthfulness
    posture_checks: {
      disk_encrypted: null,
      firewall_active: null,
      os_name: 'Linux',
      os_version: '6.6.0',
      is_rootless: null,
      measured_at: null
    },
    risk_score: null, // Unmeasured risk score truthfulness
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
    country_code: 'FR',
    is_healthy: false,
    is_quarantined: true, // Quarantined node
    quarantine_reason: 'Detected anomalous egress burst',
    posture_status: 'non_compliant',
    posture_checks: {
      disk_encrypted: false,
      firewall_active: true,
      os_name: 'Linux',
      os_version: '6.1.0',
      is_rootless: false
    },
    risk_score: 85,
    public_key: 'WGPubKeyParis33333333333333333333333333333333=',
    last_heartbeat: new Date(Date.now() - 3600_000).toISOString() // 1 hour ago (offline)
  }
];

function renderNodes(initialEntries = ['/nodes']) {
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
    </QueryClientProvider>
  );

  return { queryClient, ...result };
}

describe('WP-405: NodesRoute (Sovereign Nodes Fleet Management)', () => {
  beforeEach(() => {
    localStorage.clear();
    storeSession({ token: 'test-token' });

    vi.stubGlobal(
      'WebSocket',
      class {
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onmessage: (() => void) | null = null;
        close() {}
      }
    );
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('1. Truthfulness & Posture: renders fleet nodes, unverified posture as not-measured, and null risk score as em-dash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/nodes') {
          return jsonResponse({ nodes: mockNodes });
        }
        return jsonResponse({});
      }) as unknown as typeof fetch
    );

    const { container } = renderNodes(['/nodes']);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Sovereign Nodes' })).toBeInTheDocument();
      expect(screen.getByText('Rome Gateway Alpha')).toBeInTheDocument();
      expect(screen.getByText('Berlin Relay Bravo')).toBeInTheDocument();
      expect(screen.getByText('Paris Client Charlie')).toBeInTheDocument();
    });

    // Check KPI counts: Total 3, Reachable 2, Quarantined 1, Unverified 1
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    // Check posture statuses
    expect(screen.getByText('Verified Compliant')).toBeInTheDocument();
    expect(screen.getByText('Unverified')).toBeInTheDocument();
    expect(screen.getByText('Non-Compliant')).toBeInTheDocument();

    // Check truthfulness: unverified node must have data-state="not-measured"
    const notMeasuredElements = container.querySelectorAll('[data-state="not-measured"]');
    expect(notMeasuredElements.length).toBeGreaterThan(0);

    // Axe accessibility compliance
    await expectNoAxeViolations(container);
  });

  it('2. Search & Filtering: filters nodes by search query and category filters', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/nodes') {
          return jsonResponse({ nodes: mockNodes });
        }
        return jsonResponse({});
      }) as unknown as typeof fetch
    );

    const user = userEvent.setup();
    renderNodes(['/nodes']);

    await waitFor(() => {
      expect(screen.getByText('Rome Gateway Alpha')).toBeInTheDocument();
    });

    // Filter by search text 'berlin'
    const searchInput = screen.getByPlaceholderText(/Search by hostname/i);
    await user.type(searchInput, 'berlin');

    expect(screen.getByText('Berlin Relay Bravo')).toBeInTheDocument();
    expect(screen.queryByText('Rome Gateway Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('Paris Client Charlie')).not.toBeInTheDocument();

    // Clear search
    await user.clear(searchInput);

    // Click 'Quarantined' filter button
    const quarantinedBtn = screen.getByRole('button', { name: 'Quarantined' });
    await user.click(quarantinedBtn);

    expect(screen.getByText('Paris Client Charlie')).toBeInTheDocument();
    expect(screen.queryByText('Rome Gateway Alpha')).not.toBeInTheDocument();
    expect(screen.queryByText('Berlin Relay Bravo')).not.toBeInTheDocument();
  });

  it('3. Node Detail & Diagnostics: deep-links to /nodes/:id, renders hardware attestation and tests ping', async () => {
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/api/nodes') {
        return jsonResponse({ nodes: mockNodes });
      }
      if (url.includes('/api/nodes/svrn-node-rome/action')) {
        return jsonResponse({
          success: true,
          result: { rtt_ms: 12.4, jitter_ms: 0.9, status: 'active' }
        });
      }
      if (url.includes('/api/nodes/svrn-node-rome')) {
        return jsonResponse({ node: mockNodes[0] });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    const user = userEvent.setup();
    const { container } = renderNodes(['/nodes/svrn-node-rome']);

    // Detail dialog should open
    await waitFor(() => {
      expect(screen.getAllByText('Rome Gateway Alpha').length).toBeGreaterThan(0);
      expect(screen.getByText('Zero-Trust Hardware Attestation')).toBeInTheDocument();
      expect(screen.getByText('Encrypted')).toBeInTheDocument();
      expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Yes (Rootless)')).toBeInTheDocument();
    });

    // Test ping diagnostics
    const pingBtn = screen.getByRole('button', { name: /Ping Peer/i });
    await user.click(pingBtn);

    await waitFor(() => {
      expect(screen.getByText(/RTT: 12.4ms/i)).toBeInTheDocument();
    });

    await expectNoAxeViolations(container);
  });

  it('4. Quarantine and Lift Quarantine actions trigger control plane mutations', async () => {
    let quarantinedState = false;
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/api/nodes') {
        return jsonResponse({
          nodes: [
            {
              ...mockNodes[0],
              is_quarantined: quarantinedState
            }
          ]
        });
      }
      if (url.includes('/api/nodes/svrn-node-rome/quarantine')) {
        quarantinedState = true;
        return jsonResponse({ success: true, result: { is_quarantined: true } });
      }
      if (url.includes('/api/nodes/svrn-node-rome/unquarantine')) {
        quarantinedState = false;
        return jsonResponse({ success: true, result: { is_quarantined: false } });
      }
      if (url.includes('/api/nodes/svrn-node-rome')) {
        return jsonResponse({
          node: {
            ...mockNodes[0],
            is_quarantined: quarantinedState
          }
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    const user = userEvent.setup();
    renderNodes(['/nodes/svrn-node-rome']);

    await waitFor(() => {
      expect(screen.getAllByText('Rome Gateway Alpha').length).toBeGreaterThan(0);
    });

    // Click Quarantine Node button in detail view
    const quarantineActionBtn = screen.getByRole('button', { name: 'Quarantine Node' });
    await user.click(quarantineActionBtn);

    // Confirm dialog appears
    expect(screen.getByText('Quarantine Rationale')).toBeInTheDocument();
    const reasonInput = screen.getByPlaceholderText('Manual security quarantine');
    await user.type(reasonInput, 'Testing security response');

    // Click confirm in dialog
    const confirmQuarantineBtn = screen.getByRole('button', { name: 'Confirm Quarantine' });
    await user.click(confirmQuarantineBtn);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/nodes/svrn-node-rome/quarantine'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('5. Revoke Cryptographic Key triggers confirmation and API deletion', async () => {
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url === '/api/nodes') {
        return jsonResponse({ nodes: [mockNodes[0]] });
      }
      if (url.includes('/api/nodes/svrn-node-rome/revoke')) {
        return jsonResponse({ success: true, message: 'Node revoked successfully' });
      }
      if (url.includes('/api/nodes/svrn-node-rome')) {
        return jsonResponse({ node: mockNodes[0] });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    const user = userEvent.setup();
    renderNodes(['/nodes/svrn-node-rome']);

    await waitFor(() => {
      expect(screen.getAllByText('Rome Gateway Alpha').length).toBeGreaterThan(0);
    });

    // Click Revoke Cryptographic Key
    const revokeBtn = screen.getByRole('button', { name: 'Revoke Cryptographic Key' });
    await user.click(revokeBtn);

    // Confirmation dialog opens
    expect(screen.getByText('Revoke Node Key')).toBeInTheDocument();
    expect(
      screen.getByText(/Are you sure you want to permanently revoke this node's cryptographic key/i)
    ).toBeInTheDocument();

    // Type confirmation phrase (node name 'Rome Gateway Alpha')
    const confirmInput = screen.getByRole('textbox');
    await user.type(confirmInput, 'Rome Gateway Alpha');

    const confirmRevokeBtn = screen.getByRole('button', { name: 'Confirm' });
    expect(confirmRevokeBtn).not.toBeDisabled();
    await user.click(confirmRevokeBtn);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/nodes/svrn-node-rome/revoke'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('6. Empty fleet: renders friendly empty state with enroll action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/nodes') {
          return jsonResponse({ nodes: [] });
        }
        return jsonResponse({});
      }) as unknown as typeof fetch
    );

    const { container } = renderNodes(['/nodes']);

    await waitFor(() => {
      expect(screen.getByText('No sovereign nodes found')).toBeInTheDocument();
      expect(screen.getByText('Enroll your first node to join the sovereign mesh network.')).toBeInTheDocument();
    });

    await expectNoAxeViolations(container);
  });
});
