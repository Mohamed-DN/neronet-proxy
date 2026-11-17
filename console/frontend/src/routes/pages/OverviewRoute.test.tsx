import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isOctilinear } from '../../charts/transitLayout';
import { storeSession, clearSession } from '../../services/authToken';
import { createQueryClient } from '../../services/queries';
import type { TopologyNode } from '../../services/types';
import { renderUI, expectNoAxeViolations } from '../../test/harness';
import { ShellProvider } from '../shell';
import OverviewRoute from './OverviewRoute';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

const RECENT = () => new Date(Date.now() - 20_000).toISOString();
const LONG_AGO = () => new Date(Date.now() - 30 * 60_000).toISOString();

function device(id: string, extra: Partial<TopologyNode> = {}): TopologyNode {
  return {
    id,
    name: id,
    role: 'CLIENT_ORIGIN',
    country: 'IT',
    overlay_ipv4: '100.64.0.2',
    is_healthy: true,
    is_quarantined: false,
    latency_ms: null,
    compartment_id: 'cmp-lab',
    compartment_name: 'Lab',
    is_ghost_vault: false,
    last_seen_at: RECENT(),
    ...extra
  };
}

interface Fixture {
  nodes?: TopologyNode[];
  overview?: Record<string, unknown>;
  timeseries?: unknown[];
  topologyStatus?: number;
  links?: unknown[];
}

/** Answers the topology and the stats endpoints from one fixture. Anything else gets an empty object. */
function stubApi({ nodes = [], overview = {}, timeseries = [], topologyStatus = 200, links = [] }: Fixture = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/stats/topology') {
      return topologyStatus === 200 ? jsonResponse({ nodes, links }) : jsonResponse({ error: 'down' }, topologyStatus);
    }
    if (url === '/api/stats/overview') return jsonResponse(overview);
    if (url.includes('/api/stats/timeseries')) return jsonResponse(timeseries);
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

const COVERAGE = {
  source: 'wireguard-device',
  status: 'measured',
  total_nodes: 3,
  measured_nodes: 3,
  stale_nodes: 0,
  unknown_nodes: 0,
  unavailable_nodes: 0,
  memory_measured_nodes: 0,
  freshness_seconds: 60
};
const STATS = { total_bandwidth_bytes: 10737418240, traffic: COVERAGE };

const THREE = [device('Alpha'), device('Bravo'), device('Charlie', { last_seen_at: LONG_AGO() })];

function renderOverview(theme: 'light' | 'dark' = 'light') {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, refetchOnWindowFocus: false }
  });

  return renderUI(
    <QueryClientProvider client={queryClient}>
      <ShellProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<OverviewRoute />} />
            <Route path="/nodes/:id" element={<div data-testid="node-detail-route">Node detail</div>} />
            <Route path="/nodes" element={<div data-testid="nodes-route">Devices</div>} />
          </Routes>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
    { theme }
  );
}

const map = async () => within(await screen.findByTestId('transit-map'));

describe('Overview page: the network as a map', () => {
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

  it('says the status in one sentence, with no middle dots', async () => {
    stubApi({ nodes: THREE, overview: STATS });
    renderOverview();

    expect(await screen.findByText('2 devices in service, one interrupted, none blocked.')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('·');
  });

  it('draws sub-networks as lines and devices as stations, each with its status in the name', async () => {
    const nodes = [
      device('Alpha'),
      device('Gate', { role: 'RELAY' }),
      device('Exit', { role: 'EXIT_BRIDGE' }),
      device('Down', { last_seen_at: LONG_AGO() }),
      device('Locked', { is_quarantined: true }),
      device('Annex', { compartment_id: 'cmp-branch', compartment_name: 'Branch' })
    ];
    stubApi({ nodes, overview: STATS });
    const { container } = renderOverview();

    const view = await map();
    await view.findByRole('button', { name: 'Alpha, In service' });
    expect(view.getByRole('button', { name: 'Gate, gateway, In service' }).querySelector('svg')).toHaveAttribute(
      'data-station',
      'interchange'
    );
    expect(
      view.getByRole('button', { name: 'Exit, exit to the internet, In service' }).querySelector('svg')
    ).toHaveAttribute('data-station', 'terminus');
    expect(view.getByRole('button', { name: 'Down, Interrupted' }).querySelector('svg')).toHaveAttribute(
      'data-station',
      'interrupted'
    );
    expect(view.getByRole('button', { name: 'Locked, Blocked' }).querySelector('svg')).toHaveAttribute(
      'data-station',
      'blocked'
    );
    // Two sub-networks, two lines, each named and counted in ink.
    expect(view.getByText('Lab')).toBeInTheDocument();
    expect(view.getByText('Branch')).toBeInTheDocument();
    expect(container.querySelectorAll('path[data-line]')).toHaveLength(2);
  });

  it('draws every line with horizontal, vertical and 45-degree segments only', async () => {
    const many = Array.from({ length: 30 }, (_, k) => device(`Device ${String(k).padStart(2, '0')}`));
    stubApi({ nodes: many, overview: STATS });
    const { container } = renderOverview();

    await screen.findByRole('button', { name: 'Device 00, In service' });
    for (const line of container.querySelectorAll('path[data-line]')) {
      expect(isOctilinear(line.getAttribute('d') ?? '')).toBe(true);
    }
  });

  it('opens the device when a station is chosen, from the keyboard too', async () => {
    stubApi({ nodes: THREE, overview: STATS });
    const user = userEvent.setup();
    renderOverview();

    const view = await map();
    (await view.findByRole('button', { name: 'Bravo, In service' })).focus();
    expect(view.getByRole('button', { name: 'Bravo, In service' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(await screen.findByTestId('node-detail-route')).toBeInTheDocument();
  });

  it('keeps a visible list of every device for a screen reader, with each status in words', async () => {
    stubApi({ nodes: THREE, overview: STATS });
    const user = userEvent.setup();
    renderOverview();

    await user.click(await screen.findByText('Show the devices as a list'));
    const list = screen.getByRole('region', { name: 'Lab' });
    expect(within(list).getByRole('button', { name: /Charlie/ })).toHaveTextContent('Interrupted');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
  });

  it('collapses each line into one station with a count above 60 devices', async () => {
    const lab = Array.from({ length: 50 }, (_, k) => device(`Lab ${k}`));
    const branch = Array.from({ length: 15 }, (_, k) =>
      device(`Branch ${k}`, { compartment_id: 'cmp-branch', compartment_name: 'Branch' })
    );
    stubApi({ nodes: [...lab, ...branch], overview: STATS });
    renderOverview();

    const view = await map();
    expect(await view.findByRole('button', { name: 'Lab, 50 devices, In service' })).toBeInTheDocument();
    expect(view.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByText(/each sub-network is a single stop/)).toBeInTheDocument();
    expect(screen.getByText('65 devices in service, none interrupted, none blocked.')).toBeInTheDocument();
  });

  it('shows the default sub-network under its translated name', async () => {
    stubApi({ nodes: [device('Alpha', { compartment_id: 'cmp-org', compartment_name: 'Default Compartment' })] });
    renderOverview();

    const view = await map();
    expect(await view.findByText('Main sub-network')).toBeInTheDocument();
    expect(view.queryByText('Default Compartment')).toBeNull();
  });

  it('with no device, draws no line at all and offers Add a device as the only primary action', async () => {
    stubApi({ nodes: [] });
    const { container } = renderOverview();

    expect(await screen.findByText('No devices registered yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('transit-map')).toBeNull();
    expect(container.querySelectorAll('path[data-line]')).toHaveLength(0);
    expect(screen.queryByText('This network')).toBeNull();
    const primaries = Array.from(container.querySelectorAll('button')).filter((b) =>
      /(^|\s)bg-accent(\s|$)/.test(b.className)
    );
    expect(primaries.map((b) => b.textContent)).toEqual(['Add a device']);
  });

  it('with one device, draws a short line capped at both ends with the station in the middle', async () => {
    stubApi({ nodes: [device('Only', { compartment_id: null, compartment_name: '' })] });
    const { container } = renderOverview();

    const view = await map();
    expect(await view.findByRole('button', { name: 'Only, In service' })).toBeInTheDocument();
    expect(view.getByText('No sub-network')).toBeInTheDocument();
    expect(container.querySelectorAll('path[data-cap]')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Add a device' })).toBeInTheDocument();
    expect(screen.getByText('1 device in service, none interrupted, none blocked.')).toBeInTheDocument();
  });

  it('shares a gateway between the lines it serves and ends an exit where its lines end', async () => {
    const nodes = [
      device('Gate', { is_profile_gateway: true, role: 'RELAY' }),
      device('Alpha', { device_kind: 'profile', gateway_node_id: 'Gate' }),
      device('Bravo', { device_kind: 'profile', gateway_node_id: 'Gate' }),
      device('Annex', { compartment_id: 'cmp-branch', compartment_name: 'Branch', gateway_node_id: 'Gate' }),
      device('Door', { role: 'EXIT_BRIDGE', compartment_id: 'cmp-branch', compartment_name: 'Branch' })
    ];
    stubApi({
      nodes,
      overview: STATS,
      links: [{ source: 'Alpha', target: 'Annex', relay_id: 'Door' }]
    });
    const { container } = renderOverview();

    const view = await map();
    const gate = await view.findByRole('button', { name: 'Gate, gateway, In service' });
    const door = view.getByRole('button', { name: 'Door, exit to the internet, In service' });
    expect(gate).toHaveAttribute('data-shared', 'true');
    expect(door).toHaveAttribute('data-shared', 'true');
    expect(view.getAllByRole('button', { name: 'Gate, gateway, In service' })).toHaveLength(1);
    expect(container.querySelectorAll('path[data-line]')).toHaveLength(2);
    for (const line of container.querySelectorAll('path[data-line]')) {
      expect(isOctilinear(line.getAttribute('d') ?? '')).toBe(true);
    }
  });

  it('has one way into the full map: a link at the plate, no second button in the header', async () => {
    stubApi({ nodes: THREE, overview: STATS });
    renderOverview();

    const link = await screen.findByRole('link', { name: 'Open the full map' });
    expect(link).toHaveAttribute('href', '/topology');
    expect(screen.queryByRole('button', { name: /open the (full|network) map/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Network map' })).toBeNull();
  });

  it('has no old figures list, progress bar or sketch', async () => {
    stubApi({ nodes: THREE, overview: STATS });
    const { container } = renderOverview();

    await screen.findByTestId('transit-map');
    expect(container.querySelector('dl')).toBeNull();
    expect(container.querySelector('[data-testid="answering-bar"]')).toBeNull();
    expect(container.querySelector('[data-site]')).toBeNull();
  });

  it('keeps the chart samples in a hidden table with the chart title as caption', async () => {
    stubApi({
      nodes: THREE,
      overview: STATS,
      timeseries: [
        { timestamp: '2026-09-24T06:00:00Z', time: '08:00', rx: 40.1, tx: 25.2 },
        { timestamp: '2026-09-24T07:00:00Z', time: '09:00', rx: 42.5, tx: 28.3 }
      ]
    });
    const { container } = renderOverview();

    await waitFor(() => expect(container.querySelector('table.sr-only')).not.toBeNull());
    const table = container.querySelector('table.sr-only') as HTMLElement;
    expect(within(table).getByText('Network traffic over time')).toBeInTheDocument();
    expect(within(table).getByText('40.1')).toBeInTheDocument();
    expect(within(table).getByText('28.3')).toBeInTheDocument();
  });

  it('shows a plain empty state, not a lone spike, when only one sample carried traffic', async () => {
    stubApi({
      nodes: THREE,
      overview: STATS,
      timeseries: [
        { timestamp: '2026-09-24T06:00:00Z', time: '08:00', rx: 0, tx: 0 },
        { timestamp: '2026-09-24T07:00:00Z', time: '09:00', rx: 12.5, tx: 0 },
        { timestamp: '2026-09-24T08:00:00Z', time: '10:00', rx: 0, tx: 0 }
      ]
    });
    const { container } = renderOverview();

    expect(await screen.findByText('No traffic recorded in this period')).toBeInTheDocument();
    expect(container.querySelector('path[data-series]')).toBeNull();
  });

  it.each([
    ['partial', 'Partial data'],
    ['stale', 'Old data'],
    ['unknown', 'Not available yet']
  ])('explains %s traffic coverage without inventing totals', async (status, label) => {
    stubApi({
      nodes: THREE,
      overview: {
        total_bandwidth_bytes: null,
        traffic: {
          ...COVERAGE,
          status,
          total_nodes: 2,
          measured_nodes: status === 'partial' ? 1 : 0,
          stale_nodes: status === 'unknown' ? 0 : 1,
          unknown_nodes: status === 'unknown' ? 2 : 0
        }
      }
    });
    renderOverview();

    const coverage = await screen.findByTestId('native-traffic-coverage');
    await waitFor(() => expect(coverage).toHaveTextContent(label));
    expect(coverage).toHaveTextContent(`Data from ${status === 'partial' ? 1 : 0} of 2 devices in the last 60 seconds`);
    expect(screen.getByText('Total transferred since measuring began:').parentElement).toHaveTextContent(
      'Not measured'
    );
  });

  it('announces an unreachable control plane as an error with the retry action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Connection refused by control plane');
      }) as unknown as typeof fetch
    );
    renderOverview();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cannot reach the network server. Try again shortly.');
  });

  it('timeseries range selection requests that range', async () => {
    const fetchSpy = stubApi({ nodes: THREE, overview: STATS });

    const user = userEvent.setup();
    renderOverview();

    await user.click(await screen.findByRole('button', { name: '1h' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/stats/timeseries?range=1h'), expect.anything());
    });
  });

  it.each(['light', 'dark'] as const)('has no axe violations in %s theme', async (theme) => {
    stubApi({
      nodes: THREE,
      overview: STATS,
      timeseries: [{ timestamp: '2026-09-24T06:00:00Z', time: '08:00', rx: 40.1, tx: 25.2 }]
    });
    const { container, unmount } = renderOverview(theme);

    await screen.findByRole('button', { name: 'Alpha, In service' });
    await expectNoAxeViolations(container, theme);
    unmount();
  });
});
