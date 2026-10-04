import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TopologyRoute from './TopologyRoute';
import { ShellProvider } from '../shell';
import { createQueryClient } from '../../services/queries/client';
import type { TopologyNode, TopologyLink, Compartment } from '../../services/types';
import '../../i18n';

const mockStandardNodes: TopologyNode[] = [
  {
    id: 'svrn-node-rome',
    name: 'Rome Gateway Alpha',
    role: 'RELAY',
    country: 'IT',
    overlay_ipv4: '10.200.0.1',
    is_healthy: true,
    is_quarantined: false,
    latency_ms: 14.5,
    compartment_id: 'cmp-standard',
    compartment_name: 'Corporate Ops',
    is_ghost_vault: false
  },
  {
    id: 'svrn-node-berlin',
    name: 'Berlin Exit Bravo',
    role: 'EXIT_BRIDGE',
    country: 'DE',
    overlay_ipv4: '10.200.0.2',
    is_healthy: true,
    is_quarantined: false,
    latency_ms: null, // Unmeasured round trip (truthfulness)
    compartment_id: 'cmp-standard',
    compartment_name: 'Corporate Ops',
    is_ghost_vault: false
  }
];

const mockGhostNode: TopologyNode = {
  id: 'svrn-node-ghost-01',
  name: 'Black Ops Ghost Ingress',
  role: 'HYBRID',
  country: 'CH',
  overlay_ipv4: '10.200.99.1',
  is_healthy: true,
  is_quarantined: false,
  latency_ms: 8.2,
  compartment_id: 'cmp-ghost',
  compartment_name: 'Black Ops Secret Vault',
  is_ghost_vault: true
};

const mockStandardCompartments: Compartment[] = [
  {
    id: 'cmp-standard',
    organization_id: 'org-sovereign',
    name: 'Corporate Ops',
    slug: 'corporate-ops',
    subnet_cidr: '100.64.1.0/24',
    is_hidden: false
  }
];

const mockGhostCompartment: Compartment = {
  id: 'cmp-ghost',
  organization_id: 'org-sovereign',
  name: 'Black Ops Secret Vault',
  slug: 'black-ops-vault',
  subnet_cidr: '100.64.99.0/24',
  is_hidden: true
};

const mockLinks: TopologyLink[] = [
  {
    source: 'svrn-node-rome',
    target: 'svrn-node-berlin',
    protocol: 'wireguard'
  }
];

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function renderTopology(initialEntries = ['/topology']) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, refetchOnWindowFocus: false }
  });

  return renderUI(
    <QueryClientProvider client={queryClient}>
      <ShellProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <Routes>
            <Route path="/topology" element={<TopologyRoute />} />
            <Route path="/nodes/:id" element={<div data-testid="node-detail-route">Node Detail Page</div>} />
          </Routes>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>
  );
}

describe('WP-406: TopologyRoute (Interactive Topology & Ghost Vaults Dynamic Unlock)', () => {
  let isVaultUnlocked = false;

  beforeEach(() => {
    isVaultUnlocked = false;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Initial Standard Tier: Ghost Vaults are strictly concealed (Plausible Deniability)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/stats/topology')) {
          return jsonResponse({
            nodes: mockStandardNodes,
            links: mockLinks,
            total_nodes: 2,
            policy_is_open: false,
            mesh_scope: 'global'
          });
        }
        if (url.includes('/api/compartments')) {
          return jsonResponse({
            compartments: mockStandardCompartments
          });
        }
        return jsonResponse({});
      }) as unknown as typeof fetch
    );

    const user = userEvent.setup();
    const { container } = renderTopology();

    // Verify Page Title and Controls
    expect(await screen.findByRole('heading', { name: 'Mesh Topology', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText('Ghost Vaults Inactive').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Unlock Ghost Vaults' })).toBeInTheDocument();

    // Switch to Accessible List view to verify DOM content easily
    const listBtn = screen.getByRole('button', { name: /Accessible List/i });
    await user.click(listBtn);

    // Standard nodes must be in document
    expect(screen.getByText('Rome Gateway Alpha')).toBeInTheDocument();
    expect(screen.getByText('Berlin Exit Bravo')).toBeInTheDocument();

    // Ghost Vault node must NOT exist in the document (Plausible deniability)
    expect(screen.queryByText('Black Ops Ghost Ingress')).not.toBeInTheDocument();
    expect(screen.queryByText('Black Ops Secret Vault')).not.toBeInTheDocument();

    // Truthfulness: unmeasured round trip on Berlin Exit Bravo renders as '—'
    expect(screen.getByText('—')).toBeInTheDocument();

    // Accessibility check: zero severe or critical violations
    await expectNoAxeViolations(container);
  });

  it('2. Dynamic Unlock: entering master vault password reveals hidden Ghost Vaults', async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/compartments/unlock') && init?.method === 'POST') {
        const body = JSON.parse((init.body as string) || '{}');
        if (body.password === 'ValidMasterVaultPassword!') {
          isVaultUnlocked = true;
          return jsonResponse({
            success: true,
            compartment_access: 'root',
            token: 'elevated-root-token'
          });
        }
        return jsonResponse({ error: 'Invalid master authorization password.' }, 401);
      }
      if (url.includes('/api/stats/topology')) {
        return jsonResponse({
          nodes: isVaultUnlocked ? [...mockStandardNodes, mockGhostNode] : mockStandardNodes,
          links: mockLinks,
          total_nodes: isVaultUnlocked ? 3 : 2,
          policy_is_open: false,
          mesh_scope: 'global'
        });
      }
      if (url.includes('/api/compartments')) {
        return jsonResponse({
          compartments: isVaultUnlocked ? [...mockStandardCompartments, mockGhostCompartment] : mockStandardCompartments
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    const user = userEvent.setup();
    renderTopology();

    // Click Unlock Ghost Vaults button
    const unlockBtn = await screen.findByRole('button', { name: 'Unlock Ghost Vaults' });
    await user.click(unlockBtn);

    // Dialog appears
    expect(screen.getByRole('heading', { name: 'Unlock Ghost Vaults', level: 2 })).toBeInTheDocument();

    // Enter master password
    const passwordInput = screen.getByPlaceholderText('Enter vault unlock password');
    await user.type(passwordInput, 'ValidMasterVaultPassword!');

    // Click Authorize & Unlock
    const confirmBtn = screen.getByRole('button', { name: 'Authorize & Unlock' });
    await user.click(confirmBtn);

    // Verify API called
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/compartments/unlock'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    // Badge updates to Ghost Vaults Active and button changes to Lock Ghost Vaults
    await waitFor(() => {
      expect(screen.getAllByText('Ghost Vaults Active').length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: 'Lock Ghost Vaults' })).toBeInTheDocument();
    });

    // Switch to List view
    const listBtn = screen.getByRole('button', { name: /Accessible List/i });
    await user.click(listBtn);

    // Ghost node and compartment now revealed!
    expect(screen.getByText('Black Ops Ghost Ingress')).toBeInTheDocument();
    expect(screen.getByText('Black Ops Secret Vault')).toBeInTheDocument();
    expect(screen.getByText('Stealth Ghost Node')).toBeInTheDocument();
  });

  it('3. Invalid Password: shows error and preserves plausible deniability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/compartments/unlock') && init?.method === 'POST') {
          return jsonResponse({ error: 'Invalid master authorization password.' }, 401);
        }
        if (url.includes('/api/stats/topology')) {
          return jsonResponse({
            nodes: mockStandardNodes,
            links: mockLinks,
            total_nodes: 2
          });
        }
        if (url.includes('/api/compartments')) {
          return jsonResponse({ compartments: mockStandardCompartments });
        }
        return jsonResponse({});
      }) as unknown as typeof fetch
    );

    const user = userEvent.setup();
    renderTopology();

    const unlockBtn = await screen.findByRole('button', { name: 'Unlock Ghost Vaults' });
    await user.click(unlockBtn);

    const passwordInput = screen.getByPlaceholderText('Enter vault unlock password');
    await user.type(passwordInput, 'WrongPassword!');

    const confirmBtn = screen.getByRole('button', { name: 'Authorize & Unlock' });
    await user.click(confirmBtn);

    // Error is displayed
    expect(await screen.findByText('Invalid master authorization password.')).toBeInTheDocument();

    // Vault remains locked
    expect(screen.getAllByText('Ghost Vaults Inactive').length).toBeGreaterThan(0);
  });

  it('4. Lock Ghost Vaults: immediately conceals secret nodes and reverts tier', async () => {
    isVaultUnlocked = true;
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/compartments/lock') && init?.method === 'POST') {
        isVaultUnlocked = false;
        return jsonResponse({
          success: true,
          compartment_access: 'standard',
          token: 'standard-token'
        });
      }
      if (url.includes('/api/stats/topology')) {
        return jsonResponse({
          nodes: isVaultUnlocked ? [...mockStandardNodes, mockGhostNode] : mockStandardNodes,
          links: mockLinks,
          total_nodes: isVaultUnlocked ? 3 : 2
        });
      }
      if (url.includes('/api/compartments')) {
        return jsonResponse({
          compartments: isVaultUnlocked ? [...mockStandardCompartments, mockGhostCompartment] : mockStandardCompartments
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    const user = userEvent.setup();
    renderTopology();

    // Initially active
    const lockBtn = await screen.findByRole('button', { name: 'Lock Ghost Vaults' });
    expect(screen.getAllByText('Ghost Vaults Active').length).toBeGreaterThan(0);

    // Click lock
    await user.click(lockBtn);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining('/api/compartments/lock'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    // Reverted back to Inactive
    await waitFor(() => {
      expect(screen.getAllByText('Ghost Vaults Inactive').length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: 'Unlock Ghost Vaults' })).toBeInTheDocument();
    });
  });

  it('5. Search and Role filtering filters visible nodes accurately', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/stats/topology')) {
          return jsonResponse({
            nodes: mockStandardNodes,
            links: mockLinks,
            total_nodes: 2
          });
        }
        if (url.includes('/api/compartments')) {
          return jsonResponse({ compartments: mockStandardCompartments });
        }
        return jsonResponse({});
      }) as unknown as typeof fetch
    );

    const user = userEvent.setup();
    renderTopology();

    // Switch to List view
    const listBtn = await screen.findByRole('button', { name: /Accessible List/i });
    await user.click(listBtn);

    // Type "Rome" in search
    const searchInput = screen.getByPlaceholderText('Search nodes by name, ID or overlay IP...');
    await user.type(searchInput, 'Rome');

    expect(screen.getByText('Rome Gateway Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Berlin Exit Bravo')).not.toBeInTheDocument();
  });

  it('6. Empty mesh topology renders friendly empty state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/stats/topology')) {
          return jsonResponse({
            nodes: [],
            links: [],
            total_nodes: 0
          });
        }
        if (url.includes('/api/compartments')) {
          return jsonResponse({ compartments: [] });
        }
        return jsonResponse({});
      }) as unknown as typeof fetch
    );

    renderTopology();

    expect(await screen.findByText('No nodes found in topology')).toBeInTheDocument();
    expect(screen.getByText('Enroll sovereign nodes to construct the overlay topology.')).toBeInTheDocument();
  });
});

describe('Topology canvas: cutting links and staying readable at scale', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('7. Cutting a connection writes a DROP rule in each direction between the two overlay IPs', async () => {
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/acl/rules') && init?.method === 'POST') {
          const body = JSON.parse((init.body as string) || '{}');
          posted.push(body);
          return jsonResponse({ rule: { id: `acl-${posted.length}`, ...body }, epoch: 2 });
        }
        if (url.includes('/api/acl/rules')) {
          return jsonResponse({ rules: [], epoch: 1, policy_is_open: true, count: 0 });
        }
        if (url.includes('/api/stats/topology')) {
          return jsonResponse({ nodes: mockStandardNodes, links: mockLinks, total_nodes: 2, policy_is_open: true });
        }
        if (url.includes('/api/compartments')) {
          return jsonResponse({ compartments: mockStandardCompartments });
        }
        return jsonResponse({});
      }) as unknown as typeof fetch
    );

    const user = userEvent.setup();
    renderTopology();

    await user.click(await screen.findByRole('button', { name: 'Connection: Rome Gateway Alpha — Berlin Exit Bravo' }));
    await user.click(screen.getByRole('button', { name: 'Cut connection' }));

    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted).toEqual([
      expect.objectContaining({
        source_cidr: '10.200.0.1/32',
        destination_cidr: '10.200.0.2/32',
        protocol: 'ALL',
        action: 'DROP'
      }),
      expect.objectContaining({
        source_cidr: '10.200.0.2/32',
        destination_cidr: '10.200.0.1/32',
        protocol: 'ALL',
        action: 'DROP'
      })
    ]);
  });

  it('8. Restoring a cut connection deletes the DROP rules for that pair and no other', async () => {
    const deleted: string[] = [];
    const rules = [
      { id: 'acl-a', source_cidr: '10.200.0.1/32', destination_cidr: '10.200.0.2/32', action: 'DROP', protocol: 'ALL' },
      { id: 'acl-b', source_cidr: '10.200.0.2/32', destination_cidr: '10.200.0.1/32', action: 'DROP', protocol: 'ALL' },
      // Same source, different peer: it must survive the restore.
      {
        id: 'acl-other',
        source_cidr: '10.200.0.1/32',
        destination_cidr: '10.200.0.9/32',
        action: 'DROP',
        protocol: 'ALL'
      }
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/acl/rules/') && init?.method === 'DELETE') {
          const id = decodeURIComponent(url.split('/').pop() ?? '');
          deleted.push(id);
          return jsonResponse({ deleted: id, epoch: 3, policy_is_open: true });
        }
        if (url.includes('/api/acl/rules')) {
          return jsonResponse({ rules, epoch: 2, policy_is_open: true, count: rules.length });
        }
        if (url.includes('/api/stats/topology')) {
          return jsonResponse({
            nodes: mockStandardNodes,
            links: [{ ...mockLinks[0], is_visible: false }],
            total_nodes: 2,
            policy_is_open: true
          });
        }
        if (url.includes('/api/compartments')) {
          return jsonResponse({ compartments: mockStandardCompartments });
        }
        return jsonResponse({});
      }) as unknown as typeof fetch
    );

    const user = userEvent.setup();
    renderTopology();

    await user.click(await screen.findByRole('button', { name: 'Connection: Rome Gateway Alpha — Berlin Exit Bravo' }));
    const restore = screen.getByRole('button', { name: 'Restore connection' });
    // Disabled until the rule list has loaded and the pair's rules are known.
    await waitFor(() => expect(restore).toBeEnabled());
    await user.click(restore);

    await waitFor(() => expect([...deleted].sort()).toEqual(['acl-a', 'acl-b']));
  });

  it("9. A large fleet is grouped into clusters and shows a node's connections only once it is selected", async () => {
    const many: TopologyNode[] = Array.from({ length: 30 }, (_, i) => ({
      id: `n-${i}`,
      name: `Node ${i}`,
      role: 'CLIENT_ORIGIN',
      country: i % 2 === 0 ? 'DE' : 'IT',
      overlay_ipv4: `100.64.1.${i + 1}`,
      is_healthy: true,
      is_quarantined: false,
      latency_ms: null,
      compartment_id: null,
      compartment_name: '',
      is_ghost_vault: false
    }));
    const fullMesh: TopologyLink[] = [];
    for (let a = 0; a < many.length; a += 1) {
      for (let b = a + 1; b < many.length; b += 1) {
        // One pair has been cut: that is the kind of exception that must stay visible.
        const cut = a === 1 && b === 2;
        fullMesh.push({ source: many[a]!.id, target: many[b]!.id, mode: 'direct', is_visible: !cut });
      }
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/acl/rules')) {
          return jsonResponse({ rules: [], epoch: 1, policy_is_open: true, count: 0 });
        }
        if (url.includes('/api/stats/topology')) {
          return jsonResponse({ nodes: many, links: fullMesh, total_nodes: many.length, policy_is_open: true });
        }
        if (url.includes('/api/compartments')) {
          return jsonResponse({ compartments: [] });
        }
        return jsonResponse({});
      }) as unknown as typeof fetch
    );

    const user = userEvent.setup();
    renderTopology();

    const node0 = await screen.findByRole('button', { name: 'Node 0 — CLIENT_ORIGIN' });

    // 435 links exist; only the cut one is drawn. The full mesh would be a hairball.
    expect(screen.getAllByRole('button', { name: /^Connection:/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Connection: Node 1 — Node 2' })).toBeInTheDocument();
    expect(screen.getByText(/Select a node to reveal its connections/)).toBeInTheDocument();

    // Grouped by region by default: two clusters of fifteen.
    expect(screen.getByText('DE · 15')).toBeInTheDocument();
    expect(screen.getByText('IT · 15')).toBeInTheDocument();

    node0.focus();
    await user.keyboard('{Enter}');

    // Node 0's 29 links join the cut one; the other 405 stay hidden.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Connection:/ })).toHaveLength(30));
  });
});
