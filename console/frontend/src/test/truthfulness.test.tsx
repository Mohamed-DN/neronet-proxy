import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, storeSession } from '../services/authToken';
import { createQueryClient } from '../services/queries';
import OnionRoute from '../routes/pages/OnionRoute';
import NodesRoute from '../routes/pages/NodesRoute';
import OverviewRoute from '../routes/pages/OverviewRoute';
import PeeringRoute from '../routes/pages/PeeringRoute';
import RiskRoute from '../routes/pages/RiskRoute';
import { ShellProvider } from '../routes/shell';
import { renderUI } from './harness';

/*
 * Shared render test for the truthfulness hotfix (plan T5). Every fixture is a
 * backend-shaped response in which a field is null or absent when the control
 * plane did not measure it. A page that fills such a field with a default
 * number, a country, a role, a range or a count fails here.
 */

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    role: 'super-admin',
    user: { id: 'u1', role: 'super-admin', org_role: null, email: 'admin@example.test' }
  })
}));

const NODE_A = {
  id: 'n-a',
  name: 'alpha',
  user_id: 'u1',
  overlay_ipv4: '100.64.0.10',
  role: null,
  country_code: null,
  city: null,
  latency_ms: null,
  jitter_ms: null,
  risk_score: null,
  last_heartbeat: null,
  is_healthy: false,
  is_quarantined: false,
  onion_routing_enabled: false,
  device_kind: 'mesh'
};

const NODE_B = {
  ...NODE_A,
  id: 'n-b',
  name: 'beta',
  overlay_ipv4: '100.64.0.11',
  role: 'RELAY',
  country_code: 'DE'
};

const PEERING = {
  id: 'peer-1',
  peer_name: 'https://remote.example',
  initiator_endpoint: 'https://remote.example',
  remote_mesh_name: 'remote',
  scope_mode: 'ALL',
  shared_subnets: [],
  imported_nodes: [],
  status: 'active',
  expires_at: '2027-01-01T00:00:00Z'
};

const FIXTURES: Record<string, unknown> = {
  '/stats/overview': {
    total_nodes: 2,
    active_nodes: 1,
    quarantined_nodes: 0,
    connected_users: 0,
    network_health_score: 50,
    total_bandwidth_rx_mb_s: null,
    total_bandwidth_tx_mb_s: null,
    liveness_window_seconds: 90
  },
  '/stats/timeseries': [],
  '/stats/geo-matrix': [
    {
      country: 'Italy',
      code: 'IT',
      nodes: 1,
      live: 1,
      relays: 0,
      exits: 0,
      avg_latency: null,
      status: 'Online'
    }
  ],
  '/nodes': { nodes: [NODE_A, NODE_B] },
  '/peering': { peering_agreements: [PEERING], agreements: [PEERING], total: 1 },
  '/risk/summary': {},
  '/risk/leaderboard': {
    leaderboard: [{ id: 'n-a', name: 'alpha', risk_score: 80, country_code: null, city: null }]
  },
  '/risk/events': {
    events: [
      {
        id: 'e1',
        node_id: 'n-a',
        event_type: 'impossible_travel',
        risk_delta: null,
        created_at: '2026-11-09T10:00:00Z'
      }
    ]
  },
  '/features': { cloud_pc: false, onion: true }
};

const FORBIDDEN_COPY =
  /18\.2|15 ms|CLIENT_ORIGIN|Regional|\+50|100\.64\.0\.0\/16|3D|Posture Score|Immutable|deniab|OpenVPN|\bUS\b/;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path =
        String(input)
          .replace(/^\/api/, '')
          .split('?')[0] ?? '';
      if (path in FIXTURES) return jsonResponse(FIXTURES[path]);
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch
  );
}

function renderPage(page: React.ReactElement) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return renderUI(
    <QueryClientProvider client={queryClient}>
      <ShellProvider>
        <MemoryRouter initialEntries={['/']}>{page}</MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>
  );
}

const PAGES: Array<[string, () => React.ReactElement]> = [
  ['Overview', () => <OverviewRoute />],
  ['Nodes', () => <NodesRoute />],
  ['Peering', () => <PeeringRoute />],
  ['Onion', () => <OnionRoute />],
  ['Risk', () => <RiskRoute />]
];

describe('T5 truthfulness: pages never show a value the server did not send', () => {
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
    stubFetch();
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it.each(PAGES)('%s shows no invented default and no false claim', async (_name, make) => {
    const { container } = renderPage(make());

    await waitFor(() => expect(container.querySelectorAll('h1').length).toBeGreaterThan(0));
    await waitFor(() => expect(container.textContent).not.toMatch(/Loading/));

    const text = container.textContent ?? '';
    expect(text).not.toMatch(FORBIDDEN_COPY);
    expect(screen.queryByText(/^US$/)).toBeNull();
  });

  it('shows Not measured wherever the server sent null for a measured field', async () => {
    const { container } = renderPage(<PeeringRoute />);
    await waitFor(() => expect(container.textContent).toMatch(/remote/));
    expect(container.querySelectorAll('[data-state="not-measured"]').length).toBeGreaterThan(0);
  });
});
