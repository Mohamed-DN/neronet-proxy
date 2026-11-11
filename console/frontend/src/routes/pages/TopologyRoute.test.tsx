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

/** The device list that mirrors the map for keyboards; its buttons start with the device name. */
function mirrorButton(name: string) {
  return screen.findByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s?,`) });
}

async function openDevice(user: ReturnType<typeof userEvent.setup>, name: string) {
  (await mirrorButton(name)).focus();
  await user.keyboard('{Enter}');
  return screen.getByRole('complementary');
}

async function openConnection(user: ReturnType<typeof userEvent.setup>, from: string, to: string) {
  const inspector = await openDevice(user, from);
  await user.click(within(inspector).getByRole('button', { name: `Connection: ${from} — ${to}` }));
}

const shapeOf = (container: HTMLElement, id: string) =>
  container.querySelector(`[data-node-id="${id}"] .mesh-node-shape`)?.getAttribute('d');

describe('Network map: readable, honest and keyboard-first', () => {
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

  it('opens a dense thirteen-device mesh with the exceptions only, and every allowed line on request', async () => {
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
    const user = userEvent.setup();
    const { container } = renderTopology();
    await screen.findByRole('heading', { name: 'Groups' });
    expect(container.querySelectorAll('[data-mesh-link]')).toHaveLength(0);
    expect(
      screen.getByText('The rules allow almost every connection, so the map shows only the exceptions.')
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all 78 allowed connections' }));
    expect(container.querySelectorAll('[data-mesh-link]')).toHaveLength(78);
    expect(screen.getByRole('button', { name: /Allowed, not measured/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers counted group filters without moving the remaining devices or losing search focus', async () => {
    const user = userEvent.setup();
    const { container } = renderTopology();
    await mirrorButton('Rome Gateway Alpha');
    const legend = screen.getByRole('region', { name: 'Groups' });
    expect(within(legend).getByRole('checkbox', { name: /Corporate Ops.*2/ })).toBeChecked();
    const before = shapeOf(container, 'svrn-node-rome');
    const search = screen.getByRole('combobox', { name: /Search by name, ID or network address/i });
    await user.type(search, 'Rome');
    expect(search).toHaveFocus();
    expect(shapeOf(container, 'svrn-node-rome')).toBe(before);
    await user.click(within(legend).getByRole('checkbox', { name: /Corporate Ops.*2/ }));
    expect(container.querySelector('[data-node-id]')).not.toBeInTheDocument();
    await user.click(within(legend).getByRole('checkbox', { name: /Corporate Ops.*2/ }));
    expect(shapeOf(container, 'svrn-node-rome')).toBe(before);
  });

  it('keeps the drawing out of the tab order and opens details from the device list', async () => {
    const user = userEvent.setup();
    const { container } = renderTopology();
    await screen.findByRole('heading', { name: 'Groups' });
    expect(container.querySelector('[data-mesh-canvas]')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('[data-mesh-canvas] [tabindex]')).toHaveLength(0);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    await openDevice(user, 'Rome Gateway Alpha');
    await user.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(await mirrorButton('Rome Gateway Alpha')).toHaveFocus();
  });

  it('moves through devices with the arrow keys and rings the focused device on the map', async () => {
    const user = userEvent.setup();
    const { container } = renderTopology();
    const first = await mirrorButton('Berlin Exit Bravo');
    first.focus();
    await waitFor(() =>
      expect(container.querySelector('[data-node-id="svrn-node-berlin"] .mesh-ring--focus')).toBeInTheDocument()
    );
    await user.keyboard('{ArrowDown}');
    expect(await mirrorButton('Rome Gateway Alpha')).toHaveFocus();
    expect(container.querySelector('[data-node-id="svrn-node-rome"] .mesh-ring--focus')).toBeInTheDocument();
    expect(container.querySelector('[data-node-id="svrn-node-berlin"] .mesh-ring--focus')).not.toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(
      within(screen.getByRole('complementary')).getByRole('heading', { name: 'Rome Gateway Alpha' })
    ).toBeVisible();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('paints the selected label above every device without changing the order of the list', async () => {
    const user = userEvent.setup();
    const { container } = renderTopology();
    await mirrorButton('Rome Gateway Alpha');
    const orderBefore = [...container.querySelectorAll('[data-node-id]')].map((node) =>
      node.getAttribute('data-node-id')
    );
    await openDevice(user, 'Rome Gateway Alpha');
    const orderAfter = [...container.querySelectorAll('[data-node-id]')].map((node) =>
      node.getAttribute('data-node-id')
    );
    expect(orderAfter).toEqual(orderBefore);
    const overlay = container.querySelector('[data-selected-label]');
    expect(overlay).toHaveTextContent('Rome Gateway Alpha');
    const groups = [...container.querySelectorAll('[data-node-id]')];
    expect(
      groups[groups.length - 1]!.compareDocumentPosition(overlay!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    const selected = container.querySelector('[data-node-id][data-selected="true"]')!;
    expect(selected.querySelector('.mesh-node-label')).not.toBeInTheDocument();
  });

  it('explores one and two policy hops in the details while denied devices stay outside', async () => {
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
    await openDevice(user, 'Neighbor 0');
    const neighborhood = within(screen.getByRole('group', { name: 'Connected devices' }));
    expect(neighborhood.getByRole('button', { name: /^Neighbor 1 Allowed, not measured/ })).toBeInTheDocument();
    expect(neighborhood.queryByRole('button', { name: /^Neighbor 2/ })).not.toBeInTheDocument();
    await user.click(neighborhood.getByRole('button', { name: 'Up to 2 steps' }));
    expect(neighborhood.getByRole('button', { name: /^Neighbor 2 Through another device/ })).toBeInTheDocument();
    // A denied pair is never a step on a path; it is listed as blocked so it can be unblocked.
    expect(neighborhood.getByRole('button', { name: /^Neighbor 3 Blocked by a rule/ })).toBeInTheDocument();
    await user.click(neighborhood.getByRole('button', { name: /^Neighbor 2/ }));
    expect(within(screen.getByRole('complementary')).getByRole('heading', { name: 'Neighbor 2' })).toBeInTheDocument();
  });

  it('keeps the path to a second-hop device emphasised instead of fading its connecting line', async () => {
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
    await openDevice(user, 'Hop 0');
    const opacity = (label: string) =>
      Number(container.querySelector(`[data-mesh-link][data-label="${label}"] path[opacity]`)!.getAttribute('opacity'));
    expect(opacity('Hop 0 — Hop 1')).toBeGreaterThan(0.9);
    expect(opacity('Hop 1 — Hop 2')).toBeLessThan(0.5);
    await user.click(
      within(screen.getByRole('group', { name: 'Connected devices' })).getByRole('button', { name: 'Up to 2 steps' })
    );
    expect(opacity('Hop 0 — Hop 1')).toBeGreaterThan(0.9);
    expect(opacity('Hop 1 — Hop 2')).toBeGreaterThan(0.9);
    expect(opacity('Hop 2 — Hop 3')).toBeLessThan(0.5);
  });

  it('never shows a configured mode as a measured path, and says so with a dash rather than 0', async () => {
    const { container } = renderTopology();
    await screen.findByRole('heading', { name: 'Groups' });
    // mode: 'derp' is a preference nothing measures; an isolated end decides the line.
    expect(container.querySelector('[data-mesh-link]')).toHaveAttribute('data-mesh-link', 'quarantined');
    expect(container.querySelector('[data-mesh-link="relayed"]')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Through a relay —' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Direct —' })).toBeInTheDocument();
    expect(screen.getByText('Direct and relayed paths are not measured yet, so they show “—”.')).toBeInTheDocument();
    expect(screen.queryByText('Control server')).not.toBeInTheDocument();
  });

  it('draws relayed, direct and blocked lines with different dashes and marks once measured', async () => {
    const nodes = Array.from({ length: 4 }, (_, index) => ({
      ...mockStandardNodes[0]!,
      id: `t-${index}`,
      name: `T ${index}`,
      is_healthy: true,
      is_quarantined: false
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/api/stats/topology')
          ? jsonResponse({
              nodes,
              links: [
                { source: 't-0', target: 't-1', transport: 'direct' },
                { source: 't-1', target: 't-2', transport: 'derp' },
                { source: 't-2', target: 't-3', is_visible: false }
              ]
            })
          : jsonResponse({})
      )
    );
    const { container } = renderTopology();
    await screen.findByRole('heading', { name: 'Groups' });
    const line = (state: string) => container.querySelector(`[data-mesh-link="${state}"] .mesh-link-line`)!;
    expect(line('direct').getAttribute('stroke-dasharray')).toBeNull();
    expect(line('relayed').getAttribute('stroke-dasharray')).toBe('7 4');
    expect(line('blocked').getAttribute('stroke-dasharray')).toBe('5 4');
    expect(container.querySelector('[data-mesh-link="relayed"] .mesh-link-mark--relayed')).toBeInTheDocument();
    expect(container.querySelector('[data-mesh-link="blocked"] .mesh-link-mark--blocked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Through a relay 1' })).toBeInTheDocument();
  });

  it('gives gateways, profile devices and ordinary devices their own shape and filter', async () => {
    const nodes = [
      { ...mockStandardNodes[0]!, id: 'gw', name: 'Gateway', role: 'CLIENT_ORIGIN', is_profile_gateway: true },
      { ...mockStandardNodes[0]!, id: 'phone', name: 'Phone', role: 'CLIENT_ORIGIN', device_kind: 'profile' },
      { ...mockStandardNodes[0]!, id: 'laptop', name: 'Laptop', role: 'CLIENT_ORIGIN' }
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/api/stats/topology') ? jsonResponse({ nodes, links: [] }) : jsonResponse({})
      )
    );
    const user = userEvent.setup();
    const { container } = renderTopology();
    expect(await mirrorButton('Gateway')).toHaveAccessibleName(/Gateway or exit/);
    expect(await mirrorButton('Phone')).toHaveAccessibleName(/Profile device, Not measured/);
    expect(await mirrorButton('Laptop')).toHaveAccessibleName(/, Device, Working well/);
    expect(shapeOf(container, 'gw')).toMatch(/^M [-\d.e]+ [-\d.e]+ L /);
    expect(shapeOf(container, 'phone')).toMatch(/ H /);
    expect(shapeOf(container, 'laptop')).toMatch(/ A /);
    await user.click(screen.getByRole('button', { name: 'Profile device 1' }));
    expect(screen.getByRole('button', { name: 'Profile device 1' })).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('[data-node-id="phone"]')).not.toBeInTheDocument();
  });

  it('reports a device with problems accurately in the details and in the list view', async () => {
    const user = userEvent.setup();
    renderTopology();
    const inspector = await openDevice(user, 'Rome Gateway Alpha');
    expect(within(inspector).getByText('Has problems')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^List$/i }));
    expect(screen.getByText('Has problems')).toBeInTheDocument();
  });

  it('draws each six-device pair once with a modest curve', async () => {
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
    const paths = [...container.querySelectorAll('[data-mesh-link] .mesh-link-line')];
    expect(paths).toHaveLength(15);
    for (const path of paths) expect(path.getAttribute('d')).toMatch(/^M [-\d.e ]+ Q [-\d.e ]+$/);
  });

  it('renders counted groups and distinct positions in the hundred-device fixture', async () => {
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
    const legend = screen.getByRole('region', { name: 'Groups' });
    expect(within(legend).getAllByRole('checkbox')).toHaveLength(11);
    const devices = [...container.querySelectorAll('[data-node-id]')];
    expect(devices).toHaveLength(100);
    expect(new Set(devices.map((device) => device.querySelector('.mesh-node-shape')!.getAttribute('d'))).size).toBe(
      100
    );
    expect(container.querySelectorAll('.mesh-hull')).toHaveLength(10);
  });

  it('folds a group into a bubble without losing its count, and a search opens it again', async () => {
    const user = userEvent.setup();
    const { container } = renderTopology();
    await user.click(await screen.findByRole('button', { name: /^Collapse Corporate Ops/ }));
    expect(container.querySelector('[data-node-id="svrn-node-rome"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-mesh-bubble="cmp-standard"]')).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: /^Show Corporate Ops/ })).toBeInTheDocument();
    await user.type(screen.getByRole('combobox', { name: /Search by name, ID or network address/i }), 'Rome');
    expect(container.querySelector('[data-node-id="svrn-node-rome"]')).toHaveAttribute('data-match', 'true');
  });

  it('keeps health warnings visible and named before and after folding a group', async () => {
    const user = userEvent.setup();
    const { container } = renderTopology();
    const expanded = await screen.findByRole('button', { name: /^Collapse Corporate Ops/ });
    expect(within(expanded).getByText('With problems: 1')).toBeInTheDocument();
    expect(within(expanded).getByText('Isolated: 1')).toBeInTheDocument();
    await user.click(expanded);
    const group = screen.getByRole('button', { name: /^Show Corporate Ops/ });
    expect(group).toHaveAccessibleName(/With problems: 1.*Isolated: 1/);
    expect(container.querySelector('[data-mesh-bubble]')).toHaveTextContent('With problems: 1, Isolated: 1');
  });

  it('finds a device, centres the map on it and opens its details', async () => {
    const user = userEvent.setup();
    const { container } = renderTopology();
    await mirrorButton('Berlin Exit Bravo');
    const scene = container.querySelector('[data-mesh-canvas] > g[transform]')!;
    const before = scene.getAttribute('transform');
    const search = screen.getByRole('combobox', { name: /Search by name, ID or network address/i });
    await user.type(search, 'berl');
    expect(screen.getByRole('option', { name: /Berlin Exit Bravo/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('1 device found')).toBeInTheDocument();
    expect(container.querySelector('[data-node-id="svrn-node-rome"]')).toHaveClass('mesh-node--dimmed');
    await user.keyboard('{Enter}');
    expect(within(screen.getByRole('complementary')).getByRole('heading', { name: 'Berlin Exit Bravo' })).toBeVisible();
    expect(scene.getAttribute('transform')).not.toBe(before);
    expect(scene.getAttribute('transform')).toMatch(/scale\(1\.8\)/);
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
        const svg = container.querySelector('[data-mesh-canvas]')!;
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

  it('tells a lone device what to do next', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/api/stats/topology')
          ? jsonResponse({ nodes: [mockStandardNodes[0]], links: [] })
          : jsonResponse({})
      )
    );
    renderTopology();
    expect(await screen.findByText('Only one device so far')).toBeInTheDocument();
    expect(screen.getByText('Connect another one to see how your devices reach each other.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect a device' })).toBeInTheDocument();
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

    expect(await screen.findByText('No devices yet')).toBeInTheDocument();
    expect(screen.getByText('Connect your first device from My devices and it will appear here.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect a device' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Map$/ })).not.toBeInTheDocument();
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

    await openConnection(user, 'Rome Gateway Alpha', 'Berlin Exit Bravo');
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

    await openDevice(user, 'Rome Gateway Alpha');
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
    const { container } = renderTopology();

    // Compartment is the default; this large unassigned group starts as one bubble.
    expect(await screen.findByRole('button', { name: 'Show Unassigned' })).toBeInTheDocument();
    expect(container.querySelector('[data-mesh-bubble]')).toHaveTextContent('30');
    expect(container.querySelector('[data-node-id]')).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Group by' }));
    await user.click(screen.getByRole('option', { name: 'Country' }));
    expect(screen.getByRole('checkbox', { name: 'DE 15' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'IT 15' })).toBeChecked();

    // A dense mesh opens with its exceptions only: the one blocked pair.
    const drawn = () =>
      [...container.querySelectorAll('[data-mesh-link]')].map((link) => link.getAttribute('data-label'));
    expect(drawn()).toEqual(['Node 1 — Node 2']);

    // Selection adds every allowed pair of Node 0 without drawing the full mesh.
    await openDevice(user, 'Node 0');
    await waitFor(() => expect(drawn().filter((label) => label!.startsWith('Node 0 —'))).toHaveLength(29));
    expect(drawn().length).toBeLessThan(40);
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

describe('Network map: blocking is confirmed, atomic and honest', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocking asks for confirmation first and sends nothing before it', async () => {
    const posted: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', serveMap({ posted }));

    const user = userEvent.setup();
    renderTopology();

    await openConnection(user, 'Rome Gateway Alpha', 'Berlin Exit Bravo');
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

    await openConnection(user, 'Rome Gateway Alpha', 'Berlin Exit Bravo');
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

    await openConnection(user, 'Rome Gateway Alpha', 'Berlin Exit Bravo');
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

    await openConnection(user, 'Rome Gateway Alpha', 'Berlin Exit Bravo');
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

    const inspector = await openDevice(user, 'Berlin Exit Bravo');
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
    await mirrorButton('Rome Gateway Alpha');
    await expectNoAxeViolations(container, theme);
    unmount();
  });
});
