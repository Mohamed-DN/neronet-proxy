import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SubnetsRoute from './SubnetsRoute';
import { ShellProvider } from '../shell';
import { createQueryClient } from '../../services/queries/client';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import type { Compartment, CompartmentPeering, TopologyNode } from '../../services/types';
import '../../i18n';

const compartment = (id: string, name: string, slug: string): Compartment => ({
  id,
  organization_id: 'org-default',
  name,
  slug,
  subnet_cidr: '100.64.0.0/24',
  is_hidden: false
});

const node = (id: string, name: string, country: string, compartmentId: string): TopologyNode => ({
  id,
  name,
  role: 'CLIENT_ORIGIN',
  country,
  overlay_ipv4: null,
  is_healthy: true,
  is_quarantined: false,
  latency_ms: null,
  compartment_id: compartmentId,
  compartment_name: '',
  is_ghost_vault: false
});

const COMPARTMENTS = [
  compartment('cmp-org-default', 'Default Compartment', 'default'),
  compartment('cmp-lab', 'Lab', 'lab'),
  compartment('cmp-guests', 'Guests', 'guests')
];
const NODES = [
  node('n1', 'Rome', 'IT', 'cmp-org-default'),
  node('n2', 'Berlin', 'DE', 'cmp-lab'),
  node('n3', 'Paris', 'FR', 'cmp-lab')
];
const PEERINGS: CompartmentPeering[] = [
  {
    id: 'peer-1',
    organization_id: 'org-default',
    src_compartment_id: 'cmp-lab',
    dst_compartment_id: 'cmp-org-default',
    policy: 'allow'
  }
];

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function json(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  );
}

let calls: Call[];

function stubApi() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      if (method !== 'GET') calls.push({ method, url, body });

      if (method === 'POST' && url.endsWith('/api/compartments')) {
        return json({ compartment: compartment('cmp-office', body.name, 'office') }, 201);
      }
      if (method === 'POST' && url.includes('/members')) {
        return json({ moved: body.node_ids });
      }
      if (method === 'POST' && url.includes('/peerings/create')) {
        return json({ peering: { id: 'peer-new', ...body } }, 201);
      }
      if (method === 'DELETE') return json({ success: true });
      if (url.includes('/api/compartments/peerings/list')) return json({ peerings: PEERINGS });
      if (url.includes('/api/compartments')) return json({ compartments: COMPARTMENTS });
      if (url.includes('/api/stats/topology')) {
        return json({ nodes: NODES, links: [], total_nodes: NODES.length, policy_is_open: true });
      }
      return json({});
    }) as unknown as typeof fetch
  );
}

function renderSubnets() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return renderUI(
    <QueryClientProvider client={queryClient}>
      <ShellProvider>
        <MemoryRouter>
          <SubnetsRoute />
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>
  );
}

const card = (name: string) => screen.getByRole('region', { name });

describe('Sub-networks page', () => {
  beforeEach(() => stubApi());
  afterEach(() => vi.restoreAllMocks());

  it('shows each sub-network with its devices and what it is connected to', async () => {
    const { container } = renderSubnets();
    await screen.findByRole('region', { name: 'Lab' });

    const lab = card('Lab');
    expect(within(lab).getByText('Berlin')).toBeInTheDocument();
    expect(within(lab).getByText('Paris')).toBeInTheDocument();
    expect(within(lab).getByText('2 devices')).toBeInTheDocument();
    expect(within(lab).getByText('Default Compartment')).toBeInTheDocument();

    expect(within(card('Guests')).getByText('Isolated: reaches no other sub-network.')).toBeInTheDocument();
    // The default sub-network comes first and cannot be deleted.
    const regions = screen.getAllByRole('region');
    expect(regions[0]).toHaveAccessibleName('Default Compartment');
    expect(within(regions[0]!).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('creates a sub-network and moves the chosen devices into it', async () => {
    const user = userEvent.setup();
    renderSubnets();
    await screen.findByRole('region', { name: 'Lab' });

    await user.click(screen.getByRole('button', { name: 'New sub-network' }));
    await user.type(screen.getByPlaceholderText('E.g. Lab, Rome office, Guests'), 'Office');
    await user.click(screen.getByLabelText('Rome · IT'));
    await user.click(screen.getByRole('button', { name: 'Create sub-network' }));

    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toMatchObject({ method: 'POST', body: { name: 'Office' } });
    expect(calls[0]!.url).toMatch(/\/api\/compartments$/);
    expect(calls[1]).toMatchObject({ method: 'POST', body: { node_ids: ['n1'] } });
    expect(calls[1]!.url).toContain('/api/compartments/cmp-office/members');
  });

  it('refuses to create a sub-network without a name', async () => {
    const user = userEvent.setup();
    renderSubnets();
    await screen.findByRole('region', { name: 'Lab' });

    await user.click(screen.getByRole('button', { name: 'New sub-network' }));
    await user.click(screen.getByRole('button', { name: 'Create sub-network' }));

    expect(await screen.findByText('Give the sub-network a name.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('connects an isolated sub-network, and disconnects a connected one', async () => {
    const user = userEvent.setup();
    renderSubnets();
    await screen.findByRole('region', { name: 'Guests' });

    await user.click(within(card('Guests')).getByRole('button', { name: 'Connect to…' }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { src_compartment_id: 'cmp-guests', dst_compartment_id: 'cmp-org-default', policy: 'allow' }
    });

    await user.click(within(card('Lab')).getByRole('button', { name: 'Disconnect Default Compartment' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ method: 'DELETE' });
    expect(calls[1]!.url).toContain('/api/compartments/peerings/peer-1');
  });

  it('moves a device back to the default sub-network', async () => {
    const user = userEvent.setup();
    renderSubnets();
    await screen.findByRole('region', { name: 'Lab' });

    await user.click(within(card('Lab')).getByRole('button', { name: 'Move Berlin to the default sub-network' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'POST', body: { node_ids: ['n2'] } });
    expect(calls[0]!.url).toContain('/api/compartments/cmp-org-default/members');
  });

  it('deletes a sub-network only after confirmation', async () => {
    const user = userEvent.setup();
    renderSubnets();
    await screen.findByRole('region', { name: 'Guests' });

    await user.click(within(card('Guests')).getByRole('button', { name: 'Delete' }));
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Delete sub-network' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'DELETE' });
    expect(calls[0]!.url).toMatch(/\/api\/compartments\/cmp-guests$/);
  });
});
