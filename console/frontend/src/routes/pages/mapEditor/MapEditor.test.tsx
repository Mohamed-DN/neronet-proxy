import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AuthContext, { type AuthValue } from '../../../context/AuthContext';
import { clearSession, storeSession } from '../../../services/authToken';
import { createQueryClient } from '../../../services/queries';
import type { Compartment, ReachPreview, TopologyNode } from '../../../services/types';
import { renderUI } from '../../../test/harness';
import { ShellProvider } from '../../shell';
import OverviewRoute from '../OverviewRoute';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const RECENT = () => new Date(Date.now() - 20_000).toISOString();

function device(id: string, compartment: [string, string]): TopologyNode {
  return {
    id,
    name: id,
    role: 'CLIENT_ORIGIN',
    country: 'IT',
    overlay_ipv4: '100.64.0.2',
    is_healthy: true,
    is_quarantined: false,
    latency_ms: null,
    compartment_id: compartment[0],
    compartment_name: compartment[1],
    is_ghost_vault: false,
    last_seen_at: RECENT()
  };
}

const LAB: [string, string] = ['cmp-lab', 'Lab'];
const BRANCH: [string, string] = ['cmp-branch', 'Branch'];

const NODES = [device('telefono-anna', LAB), device('portatile-luca', LAB), device('stampante', BRANCH)];

function compartment(id: string, name: string, order: number, extra: Partial<Compartment> = {}): Compartment {
  return {
    id,
    organization_id: 'org-default',
    name,
    slug: name.toLowerCase(),
    subnet_cidr: '100.64.0.0/24',
    is_hidden: false,
    line_colour: null,
    sort_order: order,
    ...extra
  };
}

const COMPARTMENTS = [
  compartment('cmp-org-default', 'Default Compartment', 0, { slug: 'default' }),
  compartment('cmp-lab', 'Lab', 1, { line_colour: 'blue' }),
  compartment('cmp-branch', 'Branch', 2),
  compartment('cmp-guests', 'Guests', 3)
];

const PEERINGS = [
  {
    id: 'peer-1',
    organization_id: 'org-default',
    src_compartment_id: 'cmp-lab',
    dst_compartment_id: 'cmp-guests',
    policy: 'allow',
    src_name: 'Lab',
    dst_name: 'Guests'
  },
  {
    id: 'peer-2',
    organization_id: 'org-default',
    src_compartment_id: 'cmp-branch',
    dst_compartment_id: 'cmp-lab',
    policy: 'allow',
    src_name: 'Branch',
    dst_name: 'Lab'
  }
];

const MOVE_PREVIEW: ReachPreview = {
  nodes: [
    {
      node_id: 'telefono-anna',
      name: 'telefono-anna',
      reach_before: 2,
      reach_after: 3,
      gains: { count: 3, names: ['stampante', 'nas', 'tv'] },
      losses: { count: 2, names: ['portatile-luca', 'camera'] }
    }
  ],
  summary: { nodes_moved: 1, gains: 3, losses: 2 }
};

const SPLIT_PREVIEW: ReachPreview = {
  nodes: [
    {
      node_id: 'telefono-anna',
      name: 'telefono-anna',
      reach_before: 4,
      reach_after: 1,
      gains: { count: 0, names: [] },
      losses: { count: 3, names: ['portatile-luca', 'stampante', 'nas'] }
    }
  ],
  summary: { nodes_moved: 1, gains: 0, losses: 3 },
  peerings_not_inherited: { count: 2, peers: ['Guests', 'Branch'] }
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

/** Answers the endpoints the overview and the editor use, and records every call. */
function stubApi(overrides: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const call = { url, method, body };
    calls.push(call);
    const key = `${method} ${url}`;
    if (overrides[key]) return overrides[key](call);
    if (url === '/api/stats/topology') return json({ nodes: NODES, links: [] });
    if (url === '/api/compartments') return json({ compartments: COMPARTMENTS });
    if (url === '/api/compartments/peerings/list') return json({ peerings: PEERINGS });
    if (key === 'POST /api/compartments/preview-move') return json(MOVE_PREVIEW);
    if (key === 'POST /api/compartments/cmp-lab/preview-split') return json(SPLIT_PREVIEW);
    if (key === 'POST /api/compartments/cmp-branch/members') return json({ moved: ['telefono-anna'] });
    if (key === 'POST /api/compartments/cmp-lab/split') {
      return json(
        {
          compartment: compartment('cmp-new', (body as { name: string }).name, 4, { line_colour: 'violet' }),
          moved: ['telefono-anna'],
          peerings_not_inherited: { count: 2, peers: ['Guests', 'Branch'] }
        },
        201
      );
    }
    if (key === 'POST /api/compartments/cmp-lab/merge') {
      return json({
        compartment: COMPARTMENTS[2],
        moved: ['telefono-anna', 'portatile-luca'],
        dropped_peerings: { count: 2, peers: ['Guests', 'Branch'] }
      });
    }
    if (key === 'PUT /api/compartments/reorder') return json({ compartments: COMPARTMENTS });
    if (method === 'PUT' && url.startsWith('/api/compartments/')) return json({ compartment: COMPARTMENTS[1] });
    if (method === 'DELETE' && url.startsWith('/api/compartments/')) return json({ success: true });
    if (url === '/api/stats/overview') return json({});
    if (url.includes('/api/stats/timeseries')) return json([]);
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return calls;
}

function authAs(orgRole: string): AuthValue {
  const user = (orgRole === 'super-admin'
    ? { id: 'usr-root', username: 'root', role: 'super-admin', org_role: null }
    : { id: `usr-${orgRole}`, username: orgRole, role: 'user', org_role: orgRole }) as unknown as NonNullable<
    AuthValue['user']
  >;
  return {
    user,
    role: user.role ?? null,
    token: 'test-token',
    loading: false,
    isAuthenticated: true,
    switchRole: () => {},
    login: async () => user,
    completeMfaSignIn: async () => user,
    logout: async () => {},
    refreshUser: async () => {}
  };
}

function renderOverview(role: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return renderUI(
    <AuthContext.Provider value={authAs(role)}>
      <QueryClientProvider client={queryClient}>
        <ShellProvider>
          <MemoryRouter initialEntries={['/']}>
            <Routes>
              <Route path="/" element={<OverviewRoute />} />
              <Route path="/nodes/:id" element={<div>Node detail</div>} />
            </Routes>
          </MemoryRouter>
        </ShellProvider>
      </QueryClientProvider>
    </AuthContext.Provider>
  );
}

const station = (name: string) => document.querySelector<HTMLButtonElement>(`[data-station-id="${name}"]`)!;

async function startEditing(role = 'admin') {
  const user = userEvent.setup();
  renderOverview(role);
  await user.click(await screen.findByRole('button', { name: 'Edit the map' }));
  return user;
}

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

describe('map editor: who sees it', () => {
  it.each(['owner', 'admin', 'network_admin', 'super-admin'])('%s can start editing', async (role) => {
    stubApi();
    renderOverview(role);
    expect(await screen.findByRole('button', { name: 'Edit the map' })).toBeInTheDocument();
  });

  it.each(['member', 'auditor', 'user'])('%s sees no edit button', async (role) => {
    stubApi();
    renderOverview(role);
    await screen.findByTestId('transit-map');
    expect(screen.queryByRole('button', { name: 'Edit the map' })).not.toBeInTheDocument();
  });

  it('says what editing does and ends with Done', async () => {
    stubApi();
    const user = await startEditing();
    const banner = await screen.findByTestId('map-editor-banner');
    expect(within(banner).getByText('You are editing the network: changes alter who can reach whom.')).toBeVisible();
    await user.click(within(banner).getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('map-editor-banner')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit the map' })).toHaveFocus());
  });
});

describe('map editor: moving a device', () => {
  it('previews before anything is written, and moves only on confirm (keyboard path)', async () => {
    const calls = stubApi();
    const user = await startEditing();
    await screen.findByTestId('transit-map');

    // Keyboard: focus the stop, Enter chooses it.
    station('telefono-anna').focus();
    await user.keyboard('{Enter}');
    expect(station('telefono-anna')).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Move to…' }));
    const picker = await screen.findByRole('dialog', { name: 'Move to…' });
    // Nothing yet: no preview, no write.
    expect(calls.some((c) => c.url.includes('preview-move'))).toBe(false);

    await user.click(within(picker).getByRole('button', { name: /Branch/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to Branch' });
    expect(
      await within(dialog).findByText('telefono-anna will reach 3 more devices and will no longer reach 2 devices.')
    ).toBeVisible();
    expect(within(dialog).getByText('Gained: stampante, nas, tv')).toBeVisible();
    expect(within(dialog).getByText('Lost: portatile-luca, camera')).toBeVisible();

    const preview = calls.find((c) => c.url === '/api/compartments/preview-move')!;
    expect(preview.body).toEqual({ node_ids: ['telefono-anna'], to: 'cmp-branch' });
    expect(calls.some((c) => c.url.endsWith('/members'))).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Move' }));
    const move = await waitFor(() => {
      const found = calls.find((c) => c.url === '/api/compartments/cmp-branch/members');
      expect(found).toBeDefined();
      return found!;
    });
    expect(move.body).toEqual({ node_ids: ['telefono-anna'] });
    // The preview came first.
    expect(calls.indexOf(preview)).toBeLessThan(calls.indexOf(move));
    expect(await screen.findByText('Moved to Branch')).toBeVisible();
  });

  it('cancelling the preview writes nothing', async () => {
    const calls = stubApi();
    const user = await startEditing();
    await screen.findByTestId('transit-map');
    await user.click(station('telefono-anna'));
    await user.click(screen.getByRole('button', { name: 'Move to…' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Move to…' })).getByRole('button', { name: /Branch/ })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Move to Branch' });
    await within(dialog).findByTestId('reach-preview');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.url.endsWith('/members'))).toBe(false);
  });

  it('drops a device on a line: same preview, same confirm', async () => {
    const calls = stubApi();
    await startEditing();
    await screen.findByTestId('transit-map');

    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      get types() {
        return [...data.keys()];
      },
      effectAllowed: 'all',
      dropEffect: 'move'
    };
    fireEvent.dragStart(station('telefono-anna'), { dataTransfer });
    const zone = document.querySelector('[data-lane-zone="cmp-branch"]')!;
    fireEvent.dragOver(zone, { dataTransfer });
    fireEvent.drop(zone, { dataTransfer });

    const dialog = await screen.findByRole('dialog', { name: 'Move to Branch' });
    await within(dialog).findByTestId('reach-preview');
    expect(calls.some((c) => c.url.endsWith('/members'))).toBe(false);
  });

  it('moves several chosen devices in one go', async () => {
    const calls = stubApi();
    const user = await startEditing();
    await screen.findByTestId('transit-map');
    await user.click(station('telefono-anna'));
    await user.click(station('portatile-luca'));
    expect(screen.getByText('2 devices chosen')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Move to…' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Move to…' })).getByRole('button', { name: /Branch/ })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Move to Branch' });
    await within(dialog).findByTestId('reach-preview');
    expect(calls.find((c) => c.url === '/api/compartments/preview-move')!.body).toEqual({
      node_ids: ['telefono-anna', 'portatile-luca'],
      to: 'cmp-branch'
    });
  });
});

describe('map editor: cutting a line', () => {
  it('previews the cut, then splits with the name and colour', async () => {
    const calls = stubApi();
    const user = await startEditing();
    await screen.findByTestId('transit-map');
    await user.click(station('telefono-anna'));
    await user.click(screen.getByRole('button', { name: 'Cut into a new line' }));

    const dialog = await screen.findByRole('dialog', { name: 'Cut into a new line' });
    expect(await within(dialog).findByText('telefono-anna will no longer reach 3 devices.')).toBeVisible();
    expect(within(dialog).getByTestId('peerings-not-inherited')).toHaveTextContent(
      'The new line starts with no connections: 2 connections of Lab are not inherited, with Guests, Branch.'
    );
    expect(calls.find((c) => c.url === '/api/compartments/cmp-lab/preview-split')!.body).toEqual({
      node_ids: ['telefono-anna']
    });
    expect(calls.some((c) => c.url.endsWith('/split'))).toBe(false);

    await user.type(within(dialog).getByLabelText('Name of the new line'), 'Telefoni');
    await user.click(within(dialog).getByRole('radio', { name: 'Violet' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cut the line' }));

    await waitFor(() => expect(calls.some((c) => c.url === '/api/compartments/cmp-lab/split')).toBe(true));
    expect(calls.find((c) => c.url === '/api/compartments/cmp-lab/split')!.body).toEqual({
      name: 'Telefoni',
      node_ids: ['telefono-anna'],
      line_colour: 'violet'
    });
    expect(await screen.findByText('New line Telefoni created')).toBeVisible();
  });

  it('refuses to cut devices that sit on two lines', async () => {
    stubApi();
    const user = await startEditing();
    await screen.findByTestId('transit-map');
    await user.click(station('telefono-anna'));
    await user.click(station('stampante'));
    expect(screen.getByRole('button', { name: 'Cut into a new line' })).toBeDisabled();
    expect(screen.getByText('To cut, choose devices from one line only.')).toBeVisible();
  });
});

describe('map editor: a line menu', () => {
  const openLine = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
    await screen.findByTestId('transit-map');
    await user.click((await screen.findAllByRole('button', { name: `${name}: edit the line` }))[0]!);
    return screen.findByRole('dialog', { name: `Line ${name}` });
  };

  it('shows the six line colours as named swatches and saves the one chosen', async () => {
    const calls = stubApi();
    const user = await startEditing();
    const dialog = await openLine(user, 'Branch');
    const group = within(dialog).getByRole('radiogroup', { name: 'Line colour' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((r) => r.textContent)
    ).toEqual(['Automatic', 'Red', 'Green', 'Blue', 'Orange', 'Violet', 'Sky blue']);
    await user.click(within(group).getByRole('radio', { name: 'Orange' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'PUT' && c.url === '/api/compartments/cmp-branch')).toBe(true)
    );
    expect(calls.find((c) => c.method === 'PUT' && c.url === '/api/compartments/cmp-branch')!.body).toEqual({
      line_colour: 'orange'
    });
    expect(await screen.findByText('Line colour changed')).toBeVisible();
  });

  it('moves the colour with the arrow keys', async () => {
    stubApi();
    const user = await startEditing();
    const dialog = await openLine(user, 'Branch');
    const group = within(dialog).getByRole('radiogroup', { name: 'Line colour' });
    const automatic = within(group).getByRole('radio', { name: 'Automatic' });
    expect(automatic).toHaveAttribute('aria-checked', 'true');
    automatic.focus();
    await user.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: 'Red' })).toHaveFocus();
  });

  it('renames, and says so when the name is taken (409)', async () => {
    const calls = stubApi({
      'PUT /api/compartments/cmp-branch': () =>
        json({ error: 'name_in_use', message: 'A line with this name already exists' }, 409)
    });
    const user = await startEditing();
    const dialog = await openLine(user, 'Branch');
    const field = within(dialog).getByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'Lab');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await within(dialog).findByText('A line with this name already exists. Choose another.')).toBeVisible();
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ name: 'Lab' });
    expect(screen.queryByText('Line renamed')).not.toBeInTheDocument();
  });

  it('renames and announces it', async () => {
    stubApi();
    const user = await startEditing();
    const dialog = await openLine(user, 'Branch');
    const field = within(dialog).getByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'Ufficio');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText('Line renamed')).toBeVisible();
  });

  it('puts a line one place down and saves the order', async () => {
    const calls = stubApi();
    const user = await startEditing();
    const dialog = await openLine(user, 'Lab');
    expect(within(dialog).getByText('Position 2 of 4')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Move down' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/compartments/reorder')).toBe(true));
    expect(calls.find((c) => c.url === '/api/compartments/reorder')!.body).toEqual({
      ids: ['cmp-org-default', 'cmp-branch', 'cmp-lab', 'cmp-guests']
    });
    expect(await screen.findByText('Lines reordered')).toBeVisible();
  });

  it('merges only after a confirm that names what is dropped', async () => {
    const calls = stubApi();
    const user = await startEditing('owner');
    const dialog = await openLine(user, 'Lab');
    await user.click(within(dialog).getByRole('radio', { name: 'Branch' }));
    await user.click(within(dialog).getByRole('button', { name: 'Merge…' }));

    const confirm = await screen.findByRole('dialog', { name: 'Merge Lab into Branch?' });
    expect(within(confirm).getByText(/This cannot be undone/)).toBeVisible();
    expect(within(confirm).getByTestId('merge-consequences')).toHaveTextContent('2 devices move to Branch.');
    expect(within(confirm).getByTestId('merge-consequences')).toHaveTextContent(
      '2 connections between lines are removed: with Guests, Branch.'
    );
    expect(calls.some((c) => c.url.endsWith('/merge'))).toBe(false);

    await user.click(within(confirm).getByRole('button', { name: 'Merge the lines' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/compartments/cmp-lab/merge')).toBe(true));
    expect(calls.find((c) => c.url.endsWith('/merge'))!.body).toEqual({ into: 'cmp-branch' });
    expect(await screen.findByText('Line merged into Branch. 2 connections removed.')).toBeVisible();
  });

  it('gives a network admin no merge and no delete', async () => {
    stubApi();
    const user = await startEditing('network_admin');
    const dialog = await openLine(user, 'Lab');
    expect(within(dialog).getByRole('radiogroup', { name: 'Line colour' })).toBeVisible();
    expect(within(dialog).queryByRole('button', { name: 'Merge…' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Delete…' })).not.toBeInTheDocument();
  });

  it('deletes after a confirm, for an admin', async () => {
    const calls = stubApi();
    const user = await startEditing('admin');
    const dialog = await openLine(user, 'Guests');
    await user.click(within(dialog).getByRole('button', { name: 'Delete…' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete the line Guests?' });
    expect(within(confirm).getByTestId('delete-consequences')).toHaveTextContent('1 connection');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(confirm).getByRole('button', { name: 'Delete the line' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/compartments/cmp-guests')).toBe(true)
    );
    expect(await screen.findByText('Line deleted')).toBeVisible();
  });

  it('never offers to delete the default line', async () => {
    stubApi();
    const user = await startEditing('owner');
    const dialog = await openLine(user, 'Main sub-network');
    expect(within(dialog).queryByRole('button', { name: 'Delete…' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('The default line cannot be deleted.')).toBeVisible();
  });
});

describe('map editor: a new line', () => {
  it('creates a line with a name and a colour', async () => {
    const calls = stubApi({
      'POST /api/compartments': (call) =>
        json({ compartment: compartment('cmp-new', (call.body as { name: string }).name, 4) }, 201)
    });
    const user = await startEditing();
    await screen.findByTestId('transit-map');
    await user.click(screen.getByRole('button', { name: 'New line' }));
    const dialog = await screen.findByRole('dialog', { name: 'New line' });
    await user.type(within(dialog).getByLabelText('Name of the line'), 'Ospiti');
    await user.click(within(dialog).getByRole('radio', { name: 'Green' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create the line' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/compartments')).toBe(true));
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/compartments')!.body).toEqual({
      name: 'Ospiti',
      line_colour: 'green'
    });
    expect(await screen.findByText('Line Ospiti created')).toBeVisible();
  });

  it('previews the move of the devices picked for it before moving them', async () => {
    const calls = stubApi({
      'POST /api/compartments': () => json({ compartment: compartment('cmp-ospiti', 'Ospiti', 4) }, 201)
    });
    const user = await startEditing();
    await screen.findByTestId('transit-map');
    await user.click(station('telefono-anna'));
    await user.click(screen.getByRole('button', { name: 'New line' }));
    const dialog = await screen.findByRole('dialog', { name: 'New line' });
    expect(within(dialog).getByRole('checkbox', { name: 'telefono-anna' })).toBeChecked();
    await user.type(within(dialog).getByLabelText('Name of the line'), 'Ospiti');
    await user.click(within(dialog).getByRole('button', { name: 'Create the line' }));
    const move = await screen.findByRole('dialog', { name: 'Move to Ospiti' });
    await within(move).findByTestId('reach-preview');
    expect(calls.some((c) => c.url.endsWith('/members'))).toBe(false);
  });
});
