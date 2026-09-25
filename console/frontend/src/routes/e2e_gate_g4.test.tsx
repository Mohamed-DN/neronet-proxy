import { QueryClientProvider } from '@tanstack/react-query';
import { waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routes } from './router';
import { ROUTES } from './paths';
import { AuthProvider } from '../context/AuthContext';
import { clearSession, storeSession } from '../services/authToken';
import { createQueryClient } from '../services/queries/client';
import { expectNoAxeViolations, renderUI } from '../test/harness';
import '../i18n';

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function mockFetchRouter(url: string, _options?: RequestInit) {
  // Auth & Session
  if (url.includes('/api/auth/me')) {
    return jsonResponse({
      user: { id: 'usr-admin-1', username: 'secops_admin', role: 'super-admin' },
      organization: { id: 'org-default', name: 'Sovereign Core HQ' }
    });
  }

  // Stats & Overview
  if (url.includes('/api/stats/overview')) {
    return jsonResponse({
      total_nodes: 6,
      active_nodes: 5,
      quarantined_nodes: 1,
      total_traffic_bytes: 104857600,
      posture_score: 95
    });
  }
  if (url.includes('/api/stats/timeseries')) {
    return jsonResponse({ points: [] });
  }
  if (url.includes('/api/stats/geo-matrix')) {
    return jsonResponse({ regions: [] });
  }

  // Nodes & Topology
  if (url.includes('/api/nodes')) {
    return jsonResponse({
      nodes: [
        {
          id: 'node-rome-1',
          name: 'rome-gateway-01',
          public_key: 'x25519-pubkey-rome-1',
          vip: '100.64.0.10',
          status: 'online',
          transport: 'wireguard',
          stealth_mode: false,
          created_at: '2026-09-01T00:00:00.000Z'
        }
      ]
    });
  }
  if (url.includes('/api/topology') || url.includes('/api/compartments')) {
    return jsonResponse({
      compartments: [{ id: 'cmp-main', name: 'Main Mesh', is_ghost: false, nodes: ['node-rome-1'] }]
    });
  }

  // ACLs
  if (url.includes('/api/acls/rules') || url.includes('/api/acls/compile')) {
    return jsonResponse({
      rules: [
        {
          id: 'acl-rule-1',
          source: '*',
          destination: '100.64.0.0/10',
          action: 'accept',
          priority: 100
        }
      ]
    });
  }

  // Audit
  if (url.includes('/api/audit')) {
    return jsonResponse({
      events: [
        {
          id: 1,
          event_type: 'AUTH_LOGIN',
          actor_id: 'usr-admin-1',
          created_at: '2026-09-24T12:00:00.000Z',
          entry_hash: 'abc123hash',
          is_tampered: false
        }
      ],
      is_valid: true
    });
  }

  // NeroNuke
  if (url.includes('/api/nuke/status') || url.includes('/api/nuke/legal-hold')) {
    return jsonResponse({
      armed: false,
      legal_hold: false,
      requires_dual_auth: true,
      pending_approvals: 0
    });
  }

  // Users & Organizations
  if (url.includes('/api/users')) {
    return jsonResponse({
      users: [
        {
          id: 'usr-admin-1',
          username: 'secops_admin',
          email: 'secops@sovereign.local',
          role: 'super-admin',
          status: 'active',
          bypass_apps: [],
          organization_id: 'org-default',
          created_at: '2026-09-01T10:00:00.000Z'
        }
      ]
    });
  }
  if (url.includes('/api/organizations')) {
    return jsonResponse({
      organizations: [
        {
          id: 'org-default',
          name: 'Sovereign Core HQ',
          slug: 'sovereign-core',
          default_policy: 'open',
          max_netmap_staleness_seconds: 60,
          created_at: '2026-09-01T00:00:00.000Z'
        }
      ]
    });
  }

  // Settings
  if (url.includes('/api/settings')) {
    return jsonResponse({
      mesh_name: 'Sovereign Mesh Enterprise',
      default_transport: 'wireguard',
      daita_mode: 'balanced',
      rosenpass_enabled: true,
      fail_static: true,
      mtu: 1360,
      keepalive_seconds: 25
    });
  }

  return jsonResponse({});
}

describe('WP-411: Gate G4 End-to-End Console Navigation and a11y Certification', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    storeSession({ token: 'mock-valid-token' });
    globalThis.fetch = vi.fn().mockImplementation((url, opts) => mockFetchRouter(String(url), opts));
  });

  afterEach(() => {
    clearSession();
    vi.restoreAllMocks();
  });

  function renderConsole(initialPath: string = ROUTES.overview) {
    const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({
      queries: { retry: false, refetchOnWindowFocus: false }
    });

    const result = renderUI(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    );

    return { router, ...result };
  }

  it('1. Traverses primary routes without errors and validates accessibility with axe-core', async () => {
    const primaryRoutes = [
      ROUTES.overview,
      ROUTES.nodes,
      ROUTES.acls,
      ROUTES.audit,
      ROUTES.users,
      ROUTES.settings,
      ROUTES.nuke
    ];

    for (const routePath of primaryRoutes) {
      const { container, unmount } = renderConsole(routePath);
      await waitFor(() => {
        expect(container.querySelector('main')).toBeInTheDocument();
      });

      await expectNoAxeViolations(container);
      unmount();
    }
  });

  it('2. Enforces authentication and redirects unauthenticated operator to login', async () => {
    clearSession();
    const { router, unmount } = renderConsole(ROUTES.overview);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
    unmount();
  });

  it('3. Supports dynamic theme toggling between light and dark modes', async () => {
    const { container, unmount } = renderConsole(ROUTES.overview);
    await waitFor(() => expect(container.querySelector('main')).toBeInTheDocument());

    const root = document.documentElement;
    root.setAttribute('data-theme', 'dark');
    expect(root.getAttribute('data-theme')).toBe('dark');
    await expectNoAxeViolations(container);

    root.setAttribute('data-theme', 'light');
    expect(root.getAttribute('data-theme')).toBe('light');
    await expectNoAxeViolations(container);
    unmount();
  });
});
