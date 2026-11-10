import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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

function renderTopology(initialEntries = ['/topology'], theme: 'light' | 'dark' = 'light') {
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
    </QueryClientProvider>,
    { theme }
  );
}

describe('Community mesh uses policy and observations as distinct evidence', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/stats/topology'))
          return jsonResponse({
            nodes: mockStandardNodes.map((node, index) => ({
              ...node,
              is_healthy: index !== 0,
              is_quarantined: index === 1
            })),
            links: [{ ...mockLinks[0], mode: 'derp', is_visible: true }],
            total_nodes: 2
          });
        if (url.includes('/api/compartments')) return jsonResponse({ compartments: mockStandardCompartments });
        return jsonResponse({});
      }) as unknown as typeof fetch
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it('opens a thirteen-peer full policy mesh with its connections visible by default', async () => {
    const nodes = Array.from({ length: 13 }, (_, index) => ({
      ...mockStandardNodes[0]!,
      id: `overview-${index}`,
      name: `Overview ${index}`
    }));
    const links = nodes.flatMap((source, index) =>
      nodes.slice(index + 1).map((target) => ({ source: source.id, target: target.id }))
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/api/stats/topology') ? jsonResponse({ nodes, links }) : jsonResponse({})
      )
    );
    const { container } = renderTopology();
    await screen.findByRole('heading', { name: 'Groups' });
    expect(container.querySelectorAll('[data-mesh-link]')).toHaveLength(78);
  });

  it('offers counted community filters without moving remaining peers or losing search focus', async () => {
    const user = userEvent.setup();
    const { container } = renderTopology();
    await screen.findByRole('button', { name: 'Rome Gateway Alpha — RELAY' });
    const communities = screen.getByRole('region', { name: 'Groups' });
    expect(within(communities).getByRole('checkbox', { name: /Corporate Ops.*2/ })).toBeChecked();
    const peer = screen.getByRole('button', { name: 'Rome Gateway Alpha — RELAY' });
    const before = peer.querySelector('circle')!.getAttribute('cx');
    const search = screen.getByRole('textbox', { name: /Search by name, ID or network address/i });
    await user.type(search, 'Rome');
    expect(search).toHaveFocus();
    expect(
      screen.getByRole('button', { name: 'Rome Gateway Alpha — RELAY' }).querySelector('circle')!.getAttribute('cx')
    ).toBe(before);
    await user.click(within(communities).getByRole('checkbox', { name: /Corporate Ops.*2/ }));
    expect(container.querySelector('[data-node-id]')).not.toBeInTheDocument();
    expect(within(communities).getByRole('checkbox', { name: /Corporate Ops.*2/ })).not.toBeChecked();
    await user.click(within(communities).getByRole('checkbox', { name: /Corporate Ops.*2/ }));
    expect(screen.getByRole('button', { name: 'Rome Gateway Alpha — RELAY' })).toBeInTheDocument();
  });

  it('reserves the workspace for the graph and opens details only on selection', async () => {
    const user = userEvent.setup();
    const { container } = renderTopology();
    await screen.findByRole('heading', { name: 'Groups' });
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    (await screen.findByRole('button', { name: 'Rome Gateway Alpha — RELAY' })).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('complementary')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(container.querySelector('svg[role="group"]')).toHaveFocus();
  });

  it('paints the selected label above every peer without changing keyboard order', async () => {
    const user = userEvent.setup();
    const { container } = renderTopology();
    const peer = await screen.findByRole('button', { name: 'Rome Gateway Alpha — RELAY' });
    const orderBefore = [...container.querySelectorAll('[data-node-id]')].map((node) =>
      node.getAttribute('data-node-id')
    );
    peer.focus();
    await user.keyboard('{Enter}');
    const orderAfter = [...container.querySelectorAll('[data-node-id]')].map((node) =>
      node.getAttribute('data-node-id')
    );
    expect(orderAfter).toEqual(orderBefore);
    const overlay = container.querySelector('[data-selected-label]');
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveAttribute('aria-hidden', 'true');
    expect(overlay).toHaveTextContent('Rome Gateway Alpha');
    const groups = [...container.querySelectorAll('[data-node-id]')];
    const lastPeer = groups[groups.length - 1]!;
    expect(lastPeer.compareDocumentPosition(overlay!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const selectedGroup = container.querySelector('[data-node-id][aria-pressed="true"]')!;
    expect(selectedGroup.querySelector('.mesh-node-label')).not.toBeInTheDocument();
  });

  it('explores one and two policy hops in the inspector while denied peers stay outside the neighborhood', async () => {
    const nodes = Array.from({ length: 4 }, (_, index) => ({
      ...mockStandardNodes[0]!,
      id: `neighbor-${index}`,
      name: `Neighbor ${index}`
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/api/stats/topology')
          ? jsonResponse({
              nodes,
              links: [
                { source: 'neighbor-0', target: 'neighbor-1' },
                { source: 'neighbor-1', target: 'neighbor-2' },
                { source: 'neighbor-0', target: 'neighbor-3', is_visible: false }
              ]
            })
          : jsonResponse({})
      )
    );
    const user = userEvent.setup();
    renderTopology();
    (await screen.findByRole('button', { name: 'Neighbor 0 — RELAY' })).focus();
    await user.keyboard('{Enter}');
    const neighborhood = within(screen.getByRole('group', { name: 'Connected devices' }));
    expect(neighborhood.getByRole('button', { name: 'Neighbor 1 RELAY' })).toBeInTheDocument();
    expect(neighborhood.queryByRole('button', { name: 'Neighbor 2 RELAY' })).not.toBeInTheDocument();
    await user.click(neighborhood.getByRole('button', { name: 'Up to 2 steps' }));
    expect(neighborhood.getByRole('button', { name: 'Neighbor 2 RELAY' })).toBeInTheDocument();
    expect(neighborhood.queryByRole('button', { name: 'Neighbor 3 RELAY' })).not.toBeInTheDocument();
    await user.click(neighborhood.getByRole('button', { name: 'Neighbor 2 RELAY' }));
    expect(within(screen.getByRole('complementary')).getByRole('heading', { name: 'Neighbor 2' })).toBeInTheDocument();
  });

  it('keeps the path to a second-hop peer emphasised instead of fading its connecting edge', async () => {
    const nodes = Array.from({ length: 4 }, (_, index) => ({
      ...mockStandardNodes[0]!,
      id: `hop-${index}`,
      name: `Hop ${index}`
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/api/stats/topology')
          ? jsonResponse({
              nodes,
              links: [
                { source: 'hop-0', target: 'hop-1' },
                { source: 'hop-1', target: 'hop-2' },
                { source: 'hop-2', target: 'hop-3' }
              ]
            })
          : jsonResponse({})
      )
    );
    const user = userEvent.setup();
    const { container } = renderTopology();
    (await screen.findByRole('button', { name: 'Hop 0 — RELAY' })).focus();
    await user.keyboard('{Enter}');
    const edgeOpacity = (label: string) =>
      Number(
        container.querySelector(`[data-mesh-link][aria-label$="${label}"] path[opacity]`)!.getAttribute('opacity')
      );
    expect(edgeOpacity('Hop 0 — Hop 1')).toBeGreaterThan(0.9);
    expect(edgeOpacity('Hop 1 — Hop 2')).toBeLessThan(0.5);
    const neighborhood = within(screen.getByRole('group', { name: 'Connected devices' }));
    await user.click(neighborhood.getByRole('button', { name: 'Up to 2 steps' }));
    expect(edgeOpacity('Hop 0 — Hop 1')).toBeGreaterThan(0.9);
    expect(edgeOpacity('Hop 1 — Hop 2')).toBeGreaterThan(0.9);
    expect(edgeOpacity('Hop 2 — Hop 3')).toBeLessThan(0.5);
  });

  it('keeps policy separate from observed paths without an invented central transit node', async () => {
    const user = userEvent.setup();
    const { container } = renderTopology();
    expect(await screen.findByRole('heading', { name: 'Groups' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Measured paths' }));
    expect(screen.getByText('Paths between devices have not been measured yet.')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-mesh-link]').length).toBe(0);
  });

  it('reports an unhealthy node accurately in the inspector and accessible list', async () => {
    const user = userEvent.setup();
    renderTopology();
    const node = await screen.findByRole('button', { name: 'Rome Gateway Alpha — RELAY' });
    node.focus();
    await user.keyboard('{Enter}');
    expect(within(screen.getByRole('complementary')).getByText('Has problems')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^List$/i }));
    expect(screen.getByText('Has problems')).toBeInTheDocument();
  });

  it('uses an organic community scene without a central coordination annotation', async () => {
    const { container } = renderTopology();
    await screen.findByRole('heading', { name: 'Groups' });
    expect(screen.queryByText('Control plane')).not.toBeInTheDocument();
    expect(container.querySelector('[data-node-id]')).toHaveClass('mesh-community-0');
  });

  it('draws each six-node policy pair once with a modest community-colored curve', async () => {
    const nodes = Array.from({ length: 6 }, (_, index) => ({
      ...mockStandardNodes[0],
      id: `peer-${index}`,
      name: `Peer ${index}`
    }));
    const links = nodes.flatMap((source, index) =>
      nodes.slice(index + 1).map((target) => ({ source: source.id, target: target.id, is_visible: true }))
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/api/stats/topology')
          ? jsonResponse({ nodes, links })
          : url.includes('/api/compartments')
            ? jsonResponse({ compartments: mockStandardCompartments })
            : jsonResponse({})
      )
    );
    const { container } = renderTopology();
    await screen.findByRole('heading', { name: 'Groups' });
    const paths = [...container.querySelectorAll('[data-mesh-link] > path:last-child')];
    expect(paths).toHaveLength(15);
    for (const path of paths) {
      expect(path.getAttribute('d')).toMatch(/^M [\d. -]+ Q [\d. -]+$/);
      expect(path.parentElement).toHaveClass('mesh-community-0');
    }
  });

  it('renders counted communities and stable distinct positions in the hundred-node fixture', async () => {
    const nodes = Array.from({ length: 100 }, (_, index) => ({
      ...mockStandardNodes[0],
      id: `peer-${index}`,
      compartment_id: `group-${index % 10}`,
      compartment_name: `Group ${index % 10}`
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/api/stats/topology') ? jsonResponse({ nodes, links: [] }) : jsonResponse({})
      )
    );
    const { container } = renderTopology();
    await screen.findByRole('heading', { name: 'Groups' });
    const communities = screen.getByRole('region', { name: 'Groups' });
    expect(within(communities).getAllByRole('checkbox')).toHaveLength(11);
    const peers = [...container.querySelectorAll('[data-node-id]')];
    expect(peers).toHaveLength(100);
    expect(
      new Set(
        peers.map((peer) => {
          const circle = peer.querySelector('circle')!;
          return `${circle.getAttribute('cx')}:${circle.getAttribute('cy')}`;
        })
      ).size
    ).toBe(100);
  });

  it('collapses a group without losing its count and search expands matching nodes', async () => {
    const user = userEvent.setup();
    renderTopology();
    const collapse = await screen.findByRole('button', { name: /^Collapse Corporate Ops/ });
    await user.click(collapse);
    expect(screen.queryByRole('button', { name: 'Rome Gateway Alpha — RELAY' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Show Corporate Ops/ })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /Search by name, ID or network address/i }), 'Rome');
    expect(screen.getByRole('button', { name: 'Rome Gateway Alpha — RELAY' })).toBeInTheDocument();
  });

  it('keeps health warnings visible and accessible before and after folding a group', async () => {
    const user = userEvent.setup();
    renderTopology();
    const expanded = await screen.findByRole('button', { name: /^Collapse Corporate Ops/ });
    expect(within(expanded).getByText('With problems: 1')).toBeInTheDocument();
    expect(within(expanded).getByText('Blocked: 1')).toBeInTheDocument();
    await user.click(expanded);
    const group = screen.getByRole('button', { name: /^Show Corporate Ops/ });
    expect(within(group).getByText('With problems: 1')).toBeInTheDocument();
    expect(within(group).getByText('Blocked: 1')).toBeInTheDocument();
    expect(group).toHaveAccessibleName(/With problems: 1.*Blocked: 1/);
  });

  it('zooms with the wheel after loading and after remounting the canvas', async () => {
    const user = userEvent.setup();
    const originalPoint = globalThis.DOMPoint;
    vi.stubGlobal(
      'DOMPoint',
      class {
        constructor(
          public x: number,
          public y: number
        ) {}
        matrixTransform() {
          return { x: this.x, y: this.y };
        }
      }
    );
    try {
      const { container } = renderTopology();
      await screen.findByRole('heading', { name: 'Groups' });
      const zoom = () => {
        const svg = container.querySelector('svg[role="group"]')!;
        Object.defineProperty(svg, 'getScreenCTM', { value: () => ({ inverse: () => ({}) }) });
        const scene = svg.querySelector(':scope > g[transform]')!;
        const before = scene.getAttribute('transform');
        const wheel = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: 400,
          clientY: 300,
          deltaY: -100
        });
        fireEvent(svg, wheel);
        expect(wheel.defaultPrevented).toBe(true);
        expect(scene.getAttribute('transform')).not.toBe(before);
      };
      zoom();
      await user.click(screen.getByRole('button', { name: /^List$/i }));
      await user.click(screen.getByRole('button', { name: /^Map$/i }));
      zoom();
    } finally {
      vi.stubGlobal('DOMPoint', originalPoint);
    }
  });
});

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
    expect(await screen.findByRole('heading', { name: 'Network map', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText('Hidden groups: not shown').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Show hidden groups' })).toBeInTheDocument();

    // Switch to ^List$ view to verify DOM content easily
    const listBtn = screen.getByRole('button', { name: /^List$/i });
    await user.click(listBtn);

    // Standard nodes must be in document
    expect(screen.getByText('Rome Gateway Alpha')).toBeInTheDocument();
    expect(screen.getByText('Berlin Exit Bravo')).toBeInTheDocument();

    // Ghost Vault node must NOT exist in the document (Plausible deniability)
    expect(screen.queryByText('Black Ops Ghost Ingress')).not.toBeInTheDocument();
    expect(screen.queryByText('Black Ops Secret Vault')).not.toBeInTheDocument();

    // Truthfulness: unmeasured round trip on Berlin Exit Bravo renders as '—'
    expect(screen.getAllByText('Not measured').length).toBeGreaterThan(0);

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
    const unlockBtn = await screen.findByRole('button', { name: 'Show hidden groups' });
    await user.click(unlockBtn);

    // Dialog appears
    expect(screen.getByRole('heading', { name: 'Show hidden groups', level: 2 })).toBeInTheDocument();

    // Enter master password
    const passwordInput = screen.getByPlaceholderText('Enter the unlock password');
    await user.type(passwordInput, 'ValidMasterVaultPassword!');

    // Click Authorize & Unlock
    const confirmBtn = screen.getByRole('button', { name: 'Show hidden groups' });
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
      expect(screen.getAllByText('Hidden groups: shown').length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: 'Hide hidden groups' })).toBeInTheDocument();
    });

    // Switch to List view
    const listBtn = screen.getByRole('button', { name: /^List$/i });
    await user.click(listBtn);

    // Ghost node and compartment now revealed!
    expect(screen.getByText('Black Ops Ghost Ingress')).toBeInTheDocument();
    expect(screen.getByText('Black Ops Secret Vault')).toBeInTheDocument();
    expect(screen.getByText('Hidden device')).toBeInTheDocument();
  });

  it('3. Invalid Password: shows error and preserves plausible deniability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/auth/refresh')) {
          return jsonResponse({ error: 'No active session.' }, 401);
        }
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

    const unlockBtn = await screen.findByRole('button', { name: 'Show hidden groups' });
    await user.click(unlockBtn);

    const passwordInput = screen.getByPlaceholderText('Enter the unlock password');
    await user.type(passwordInput, 'WrongPassword!');

    const confirmBtn = screen.getByRole('button', { name: 'Show hidden groups' });
    await user.click(confirmBtn);

    // Error is displayed
    expect(await screen.findByText('Invalid master authorization password.')).toBeInTheDocument();

    // Vault remains locked
    expect(screen.getAllByText('Hidden groups: not shown').length).toBeGreaterThan(0);
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
    const lockBtn = await screen.findByRole('button', { name: 'Hide hidden groups' });
    expect(screen.getAllByText('Hidden groups: shown').length).toBeGreaterThan(0);

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
      expect(screen.getAllByText('Hidden groups: not shown').length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: 'Show hidden groups' })).toBeInTheDocument();
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
    const listBtn = await screen.findByRole('button', { name: /^List$/i });
    await user.click(listBtn);

    // Type "Rome" in search
    const searchInput = screen.getByPlaceholderText('Search by name, ID or network address…');
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

    expect(await screen.findByText('No devices to show')).toBeInTheDocument();
    expect(screen.getByText('Register your first device to see the network map.')).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Block connection' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Block this connection?' })).getByRole('button', {
        name: 'Block connection'
      })
    );

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

    (await screen.findByRole('button', { name: 'Rome Gateway Alpha — RELAY' })).focus();
    await user.keyboard('{Enter}');
    expect(within(screen.getByRole('complementary')).getByText('Allowed connections: 0')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Connection: Rome Gateway Alpha — Berlin Exit Bravo' }));
    const restore = screen.getByRole('button', { name: 'Unblock connection' });
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

    // Compartment is the default; this large unassigned group starts folded.
    expect(await screen.findByRole('button', { name: 'Show Unassigned' })).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Group by' }));
    await user.click(screen.getByRole('option', { name: 'Country' }));
    const node0 = await screen.findByRole('button', { name: 'Node 0 — CLIENT_ORIGIN' });

    // A bounded overview retains normal policy context and the cut exception.
    expect(screen.getAllByRole('button', { name: /^Connection:/ }).length).toBeGreaterThanOrEqual(29);
    expect(screen.getAllByRole('button', { name: /^Connection:/ }).length).toBeLessThanOrEqual(161);
    expect(screen.getByRole('button', { name: 'Connection: Node 1 — Node 2' })).toBeInTheDocument();
    expect(screen.getByText(/Select a device to see its links/)).toBeInTheDocument();

    // Switching to region reveals two manageable clusters of fifteen.
    expect(screen.getByRole('checkbox', { name: 'DE 15' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'IT 15' })).toBeChecked();

    node0.focus();
    await user.keyboard('{Enter}');

    // Selection adds every allowed pair for Node 0 without drawing the full mesh.
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Connection: Node 0 —/ })).toHaveLength(29));
    expect(screen.getAllByRole('button', { name: /^Connection:/ }).length).toBeLessThan(200);
  });
});

/** Serves the map and the rule list; `rules` and the write handlers are per test. */
function serveMap(options: {
  rules?: Array<Record<string, unknown>>;
  links?: TopologyLink[];
  onPost?: (body: Record<string, unknown>, index: number) => Promise<Response>;
  onDelete?: (id: string) => Promise<Response>;
  posted?: Array<Record<string, unknown>>;
  deleted?: string[];
}) {
  const { rules = [], links = mockLinks, posted = [], deleted = [], onPost, onDelete } = options;
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/acl/rules/') && init?.method === 'DELETE') {
      const id = decodeURIComponent(url.split('/').pop() ?? '');
      deleted.push(id);
      return onDelete ? onDelete(id) : jsonResponse({ deleted: id, epoch: 3, policy_is_open: true });
    }
    if (url.includes('/api/acl/rules') && init?.method === 'POST') {
      const body = JSON.parse((init.body as string) || '{}');
      posted.push(body);
      return onPost
        ? onPost(body, posted.length)
        : jsonResponse({ rule: { id: `acl-${posted.length}`, ...body }, epoch: 2 });
    }
    if (url.includes('/api/acl/rules')) {
      return jsonResponse({ rules, epoch: 2, policy_is_open: true, count: rules.length });
    }
    if (url.includes('/api/stats/topology')) {
      return jsonResponse({ nodes: mockStandardNodes, links, total_nodes: 2, policy_is_open: true });
    }
    if (url.includes('/api/compartments')) {
      return jsonResponse({ compartments: mockStandardCompartments });
    }
    return jsonResponse({});
  });
}

const romeBerlin = 'Connection: Rome Gateway Alpha — Berlin Exit Bravo';

describe('Network map: blocking is confirmed, atomic and honest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocking asks for confirmation first and sends nothing before it', async () => {
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', serveMap({ posted }));

    const user = userEvent.setup();
    renderTopology();

    await user.click(await screen.findByRole('button', { name: romeBerlin }));
    await user.click(screen.getByRole('button', { name: 'Block connection' }));

    expect(posted).toHaveLength(0);
    const dialog = await screen.findByRole('dialog', { name: 'Block this connection?' });
    expect(
      within(dialog).getByText(
        'Two blocking rules are added, one for each direction, so the two devices cannot exchange data.'
      )
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Block connection' }));
    await waitFor(() => expect(posted).toHaveLength(2));
  });

  it('a second rule that fails deletes the first and says the link was not blocked', async () => {
    const deleted: string[] = [];
    vi.stubGlobal(
      'fetch',
      serveMap({
        deleted,
        onPost: (body, index) =>
          index === 1
            ? jsonResponse({ rule: { id: 'acl-1', ...body }, epoch: 2 })
            : jsonResponse({ error: 'control plane busy' }, 500)
      })
    );

    const user = userEvent.setup();
    renderTopology();

    await user.click(await screen.findByRole('button', { name: romeBerlin }));
    await user.click(screen.getByRole('button', { name: 'Block connection' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Block this connection?' })).getByRole('button', {
        name: 'Block connection'
      })
    );

    await waitFor(() => expect(deleted).toEqual(['acl-1']));
    expect(await screen.findByRole('alert')).toHaveTextContent('The connection was not blocked. Try again shortly.');
  });

  it('a rollback that also fails names the rule that still blocks one direction', async () => {
    vi.stubGlobal(
      'fetch',
      serveMap({
        onPost: (body, index) =>
          index === 1
            ? jsonResponse({ rule: { id: 'acl-1', ...body }, epoch: 2 })
            : jsonResponse({ error: 'control plane busy' }, 500),
        onDelete: () => jsonResponse({ error: 'control plane busy' }, 500)
      })
    );

    const user = userEvent.setup();
    renderTopology();

    await user.click(await screen.findByRole('button', { name: romeBerlin }));
    await user.click(screen.getByRole('button', { name: 'Block connection' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Block this connection?' })).getByRole('button', {
        name: 'Block connection'
      })
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only one direction was blocked. Open Access rules and remove rule acl-1, or try again.'
    );
  });

  it('unblocking names the rules still present after the refetch', async () => {
    const rules = [
      { id: 'acl-a', source_cidr: '10.200.0.1/32', destination_cidr: '10.200.0.2/32', action: 'DROP', protocol: 'ALL' },
      { id: 'acl-b', source_cidr: '10.200.0.2/32', destination_cidr: '10.200.0.1/32', action: 'DROP', protocol: 'ALL' }
    ];
    vi.stubGlobal('fetch', serveMap({ rules, links: [{ ...(mockLinks[0] as TopologyLink), is_visible: false }] }));

    const user = userEvent.setup();
    renderTopology();

    await user.click(await screen.findByRole('button', { name: romeBerlin }));
    const unblock = screen.getByRole('button', { name: 'Unblock connection' });
    await waitFor(() => expect(unblock).toBeEnabled());
    await user.click(unblock);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Some blocking rules are still there: acl-a, acl-b. Try again.'
    );
  });

  it('a connection that was never measured shows Not measured, not a number', async () => {
    vi.stubGlobal('fetch', serveMap({}));

    const user = userEvent.setup();
    renderTopology();

    (await screen.findByRole('button', { name: /^Berlin Exit Bravo —/ })).focus();
    await user.keyboard('{Enter}');
    const inspector = screen.getByRole('complementary');
    expect(within(inspector).getByText('Response time')).toBeInTheDocument();
    expect(within(inspector).getAllByText(/Not measured/).length).toBeGreaterThan(0);
    expect(inspector.textContent).not.toMatch(/\d ms/);
  });

  it('the hidden-groups dialog makes no deniability claim', async () => {
    vi.stubGlobal('fetch', serveMap({}));

    const user = userEvent.setup();
    renderTopology();

    await user.click(await screen.findByRole('button', { name: 'Show hidden groups' }));
    const dialog = await screen.findByRole('dialog', { name: 'Show hidden groups' });
    expect(dialog.textContent).not.toMatch(/deniab|negabil|plausib/i);
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme) => {
    vi.stubGlobal('fetch', serveMap({}));

    const { container, unmount } = renderTopology(['/topology'], theme);
    await screen.findByRole('button', { name: romeBerlin });
    await expectNoAxeViolations(container, theme);
    unmount();
  });
});
