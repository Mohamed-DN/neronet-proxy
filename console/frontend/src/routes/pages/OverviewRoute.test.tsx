import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storeSession, clearSession } from '../../services/authToken';
import { createQueryClient } from '../../services/queries';
import { renderUI, expectNoAxeViolations } from '../../test/harness';
import { ShellProvider } from '../shell';
import OverviewRoute from './OverviewRoute';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

interface Fixture {
  overview?: Record<string, unknown>;
  timeseries?: unknown[];
  geo?: unknown[];
}

/** Answers the three stats endpoints from one fixture. Anything else gets an empty object. */
function stubStats({ overview, timeseries = [], geo = [] }: Fixture) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/stats/overview') return jsonResponse(overview ?? {});
      if (url.includes('/api/stats/timeseries')) return jsonResponse(timeseries);
      if (url === '/api/stats/geo-matrix') return jsonResponse(geo);
      return jsonResponse({});
    }) as unknown as typeof fetch
  );
}

const FLEET = {
  active_nodes: 8,
  total_nodes: 10,
  quarantined_nodes: 1,
  connected_users: 5,
  active_users: 5,
  total_bandwidth_rx_mb_s: 42.5,
  total_bandwidth_tx_mb_s: 28.3,
  total_bandwidth_bytes: 10737418240,
  network_health_score: 80,
  posture_verified_compliant_nodes: 7,
  posture_unverified_nodes: 1,
  posture_non_compliant_nodes: 1,
  liveness_window_seconds: 60,
  traffic: {
    source: 'wireguard-device',
    status: 'measured',
    total_nodes: 10,
    measured_nodes: 10,
    stale_nodes: 0,
    unknown_nodes: 0,
    unavailable_nodes: 0,
    memory_measured_nodes: 0,
    freshness_seconds: 60
  }
};

const GEO = [
  { country: 'Italy', code: 'IT', nodes: 6, live: 6, relays: 2, exits: 1, avg_latency: 14.2, status: 'Online' },
  { country: 'Germany', code: 'DE', nodes: 4, live: 2, relays: 1, exits: 0, avg_latency: null, status: 'Degraded' }
];

function renderOverview(theme: 'light' | 'dark' = 'light') {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, refetchOnWindowFocus: false }
  });

  return renderUI(
    <QueryClientProvider client={queryClient}>
      <ShellProvider>
        <MemoryRouter initialEntries={['/']}>
          <OverviewRoute />
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>,
    { theme }
  );
}

describe('Overview page', () => {
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

  it('reads the status as one sentence: "1 of 2 devices is not answering."', async () => {
    stubStats({ overview: { ...FLEET, active_nodes: 1, total_nodes: 2, traffic: undefined } });
    renderOverview();

    expect(await screen.findByText('1 of 2 devices is not answering.')).toBeInTheDocument();
  });

  it('zero devices shows the empty state with Add device as the only primary button', async () => {
    stubStats({ overview: { active_nodes: 0, total_nodes: 0, network_health_score: null } });
    const { container } = renderOverview();

    expect(await screen.findByText('No devices yet')).toBeInTheDocument();
    const primaries = Array.from(container.querySelectorAll('button')).filter((b) =>
      /(^|\s)bg-accent(\s|$)/.test(b.className)
    );
    expect(primaries.map((b) => b.textContent)).toEqual(['Add device']);
    expect(container.querySelector('[data-site]')).toBeNull();
  });

  it('every figure has a label beside it', async () => {
    stubStats({ overview: FLEET, geo: GEO });
    const { container } = renderOverview();

    await screen.findByText('Devices answering');
    const figures = container.querySelectorAll('dd');
    expect(figures.length).toBeGreaterThan(0);
    for (const figure of figures) {
      expect(figure.parentElement?.querySelector('dt')?.textContent ?? '').not.toBe('');
    }
  });

  it('traffic right now shows Not measured when rates are null', async () => {
    stubStats({
      overview: {
        ...FLEET,
        total_bandwidth_rx_mb_s: null,
        total_bandwidth_tx_mb_s: null,
        total_bandwidth_bytes: null
      },
      geo: GEO
    });
    renderOverview();

    const row = (await screen.findByText('Traffic right now')).parentElement;
    expect(row).toHaveTextContent('Not measured');
  });

  it('draws one sketch site per geographic entry', async () => {
    stubStats({ overview: FLEET, geo: GEO });
    const { container } = renderOverview();

    await waitFor(() => expect(container.querySelectorAll('[data-site]')).toHaveLength(2));
    expect(container.querySelector('[data-site="IT"]')).toHaveAttribute('data-live', 'true');
    expect(container.querySelector('[data-site="DE"]')).toHaveAttribute('data-live', 'true');
  });

  it('keeps the chart samples in a hidden table with the chart title as caption', async () => {
    stubStats({
      overview: FLEET,
      timeseries: [
        { timestamp: '2026-09-24T06:00:00Z', time: '08:00', rx: 40.1, tx: 25.2 },
        { timestamp: '2026-09-24T07:00:00Z', time: '09:00', rx: 42.5, tx: 28.3 }
      ],
      geo: GEO
    });
    const { container } = renderOverview();

    await waitFor(() => expect(container.querySelector('table.sr-only')).not.toBeNull());
    const table = container.querySelector('table.sr-only') as HTMLElement;
    expect(within(table).getByText('Network traffic over time')).toBeInTheDocument();
    expect(within(table).getByText('40.1')).toBeInTheDocument();
    expect(within(table).getByText('28.3')).toBeInTheDocument();
  });

  it('shows a plain empty state, not a lone spike, when only one sample carried traffic', async () => {
    stubStats({
      overview: FLEET,
      timeseries: [
        { timestamp: '2026-09-24T06:00:00Z', time: '08:00', rx: 0, tx: 0 },
        { timestamp: '2026-09-24T07:00:00Z', time: '09:00', rx: 12.5, tx: 0 },
        { timestamp: '2026-09-24T08:00:00Z', time: '10:00', rx: 0, tx: 0 }
      ],
      geo: GEO
    });
    const { container } = renderOverview();

    expect(await screen.findByText('No traffic recorded in this period')).toBeInTheDocument();
    expect(container.querySelector('path[data-series]')).toBeNull();
  });

  it('shows no 3D, posture-score, latency or "Time:" wording', async () => {
    stubStats({
      overview: FLEET,
      timeseries: [{ timestamp: '2026-09-24T06:00:00Z', time: '08:00', rx: 40.1, tx: 25.2 }],
      geo: GEO
    });
    renderOverview();

    await screen.findByText('Devices answering');
    expect(document.body.textContent ?? '').not.toMatch(/3D|Posture Score|Avg Latency|Time:/);
  });

  it.each([
    ['partial', 'Partial data'],
    ['stale', 'Old data'],
    ['unknown', 'Not available yet']
  ])('explains %s traffic coverage without inventing totals', async (status, label) => {
    stubStats({
      overview: {
        ...FLEET,
        active_nodes: 2,
        total_nodes: 2,
        total_bandwidth_rx_mb_s: null,
        total_bandwidth_tx_mb_s: null,
        total_bandwidth_bytes: null,
        traffic: {
          source: 'wireguard-device',
          status,
          total_nodes: 2,
          measured_nodes: status === 'partial' ? 1 : 0,
          stale_nodes: status === 'unknown' ? 0 : 1,
          unknown_nodes: status === 'unknown' ? 2 : 0,
          unavailable_nodes: 0,
          memory_measured_nodes: 0,
          freshness_seconds: 60
        }
      }
    });
    renderOverview();

    const coverage = await screen.findByTestId('native-traffic-coverage');
    expect(coverage).toHaveTextContent(label);
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
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === '/api/stats/overview') return jsonResponse({ active_nodes: 1, total_nodes: 1 });
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    const user = userEvent.setup();
    renderOverview();

    await user.click(await screen.findByRole('button', { name: '1h' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/stats/timeseries?range=1h'), expect.anything());
    });
  });

  it.each(['light', 'dark'] as const)('has no axe violations in %s theme', async (theme) => {
    stubStats({
      overview: FLEET,
      timeseries: [{ timestamp: '2026-09-24T06:00:00Z', time: '08:00', rx: 40.1, tx: 25.2 }],
      geo: GEO
    });
    const { container, unmount } = renderOverview(theme);

    await screen.findByRole('heading', { name: 'Network overview' });
    await expectNoAxeViolations(container, theme);
    unmount();
  });
});
