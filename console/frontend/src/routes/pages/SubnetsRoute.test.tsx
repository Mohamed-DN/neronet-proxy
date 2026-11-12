import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
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

function renderSubnets(theme: 'light' | 'dark' = 'light') {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return renderUI(
    <QueryClientProvider client={queryClient}>
      <ShellProvider>
        <MemoryRouter>
          <SubnetsRoute />
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
    { theme }
  );
}

const card = (name: string) => screen.getByRole('heading', { name }).closest('li') as HTMLElement;

describe('Sub-networks page', () => {
  beforeEach(() => stubApi());
  afterEach(() => vi.restoreAllMocks());

  it('shows each sub-network with its devices and what it is connected to', async () => {
    const { container } = renderSubnets();
    await screen.findByRole('heading', { name: 'Lab' });

    const lab = card('Lab');
    expect(within(lab).getByText('Berlin')).toBeInTheDocument();
    expect(within(lab).getByText('Paris')).toBeInTheDocument();
    expect(within(lab).getByText('2 devices')).toBeInTheDocument();
    expect(within(lab).getByText('Default Compartment')).toBeInTheDocument();

    expect(within(card('Guests')).getByText('Isolated: does not communicate with other networks.')).toBeInTheDocument();
    // The default sub-network comes first and cannot be deleted.
    const regions = screen.getAllByRole('heading', { level: 2 }).map((h) => h.closest('li') as HTMLElement);
    expect(within(regions[0]!).getByRole('heading', { name: 'Default Compartment' })).toBeInTheDocument();
    expect(within(regions[0]!).queryByRole('button', { name: 'Delete sub-network' })).not.toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('creates a sub-network and moves the chosen devices into it', async () => {
    const user = userEvent.setup();
    renderSubnets();
    await screen.findByRole('heading', { name: 'Lab' });

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
    await screen.findByRole('heading', { name: 'Lab' });

    await user.click(screen.getByRole('button', { name: 'New sub-network' }));
    await user.click(screen.getByRole('button', { name: 'Create sub-network' }));

    expect(await screen.findByText('Enter a name for the sub-network.')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('connects an isolated sub-network, and disconnects a connected one', async () => {
    const user = userEvent.setup();
    renderSubnets();
    await screen.findByRole('heading', { name: 'Guests' });

    await user.click(within(card('Guests')).getByRole('button', { name: 'Connect to another network…' }));
    await user.click(screen.getByRole('button', { name: 'Connect the networks' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: { src_compartment_id: 'cmp-guests', dst_compartment_id: 'cmp-org-default', policy: 'allow' }
    });

    await user.click(within(card('Lab')).getByRole('button', { name: 'Disconnect from Default Compartment' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ method: 'DELETE' });
    expect(calls[1]!.url).toContain('/api/compartments/peerings/peer-1');
  });

  it('moves a device back to the default sub-network', async () => {
    const user = userEvent.setup();
    renderSubnets();
    await screen.findByRole('heading', { name: 'Lab' });

    await user.click(within(card('Lab')).getByRole('button', { name: 'Move Berlin to the default network' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'POST', body: { node_ids: ['n2'] } });
    expect(calls[0]!.url).toContain('/api/compartments/cmp-org-default/members');
  });

  it('deletes a sub-network only after confirmation', async () => {
    const user = userEvent.setup();
    renderSubnets();
    await screen.findByRole('heading', { name: 'Guests' });

    await user.click(within(card('Guests')).getByRole('button', { name: 'Delete sub-network' }));
    expect(calls).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Delete sub-network' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'DELETE' });
    expect(calls[0]!.url).toMatch(/\/api\/compartments\/cmp-guests$/);
  });
});

describe('Sub-networks: plain language and honest failures', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('an empty network offers Add device and says what to do', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/compartments/peerings')) return json({ peerings: [] });
        if (url.includes('/api/compartments')) return json({ compartments: [COMPARTMENTS[0]] });
        if (url.includes('/api/stats/topology')) {
          return json({ nodes: [], links: [], total_nodes: 0, policy_is_open: true });
        }
        return json({});
      })
    );

    const { container } = renderSubnets();

    expect(await screen.findByRole('button', { name: 'Add device' })).toBeInTheDocument();
    expect(
      screen.getByText('No devices registered yet. Register the first device to create a sub-network.')
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('the delete dialog does not say the change cannot be undone', async () => {
    const user = userEvent.setup();
    stubApi();
    renderSubnets();
    await screen.findByRole('heading', { name: 'Guests' });

    await user.click(within(card('Guests')).getByRole('button', { name: 'Delete sub-network' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Guests?' });

    expect(
      within(dialog).getByText('Its devices go back to the default network and its links are removed.')
    ).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/cannot be undone|non si può annullare/i);
  });

  it('a failed change shows the main message, and the server text only as a detail line', async () => {
    const user = userEvent.setup();
    stubApi();
    const base = vi.mocked(fetch).getMockImplementation();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') return json({ error: 'Compartment has members' }, 500);
        return base!(url, init);
      })
    );
    renderSubnets();
    await screen.findByRole('heading', { name: 'Guests' });

    await user.click(within(card('Guests')).getByRole('button', { name: 'Delete sub-network' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Delete Guests?' })).getByRole('button', {
        name: 'Delete sub-network'
      })
    );

    const alert = await screen.findByRole('alert');
    const main = within(alert).getByText('This was not completed. Try again shortly.');
    expect(within(alert).getByText(/Compartment has members/)).not.toBe(main);
  });

  it.each(['light', 'dark'] as const)('has no axe violations with sub-networks in the %s theme', async (theme) => {
    stubApi();
    const { container, unmount } = renderSubnets(theme);
    await screen.findByRole('heading', { name: 'Guests' });
    await expectNoAxeViolations(container, theme);
    unmount();
  });
});
