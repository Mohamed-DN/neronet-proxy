import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storeSession, clearSession } from '../../services/authToken';
import { createQueryClient } from '../../services/queries';
import { renderUI, expectNoAxeViolations } from '../../test/harness';
import OverviewRoute from './OverviewRoute';

vi.mock('recharts', async () => {
  const actual = await vi.importActual<typeof import('recharts')>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 800, height: 300 }}>{children}</div>
    )
  };
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function renderOverview() {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, refetchOnWindowFocus: false }
  });

  const result = renderUI(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/']}>
        <OverviewRoute />
      </MemoryRouter>
    </QueryClientProvider>
  );

  return { queryClient, ...result };
}

describe('WP-404: OverviewRoute (Fleet Overview Dashboard)', () => {
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

  it('1. Truthfulness: renders Mesh Posture Score as "Not measured" when total_nodes is 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/stats/overview') {
          return jsonResponse({
            active_nodes: 0,
            total_nodes: 0,
            quarantined_nodes: 0,
            connected_users: 1,
            active_users: 1,
            total_bandwidth_rx_mb_s: null,
            total_bandwidth_tx_mb_s: null,
            total_bandwidth_bytes: 0,
            network_health_score: 100, // Even if backend returns 100, UI renders Not measured
            posture_verified_compliant_nodes: null,
            posture_unverified_nodes: null,
            posture_non_compliant_nodes: null,
            liveness_window_seconds: 60
          });
        }
        if (url.includes('/api/stats/timeseries')) {
          return jsonResponse([]);
        }
        if (url === '/api/stats/geo-matrix') {
          return jsonResponse([]);
        }
        return jsonResponse({});
      }) as unknown as typeof fetch
    );

    const { container } = renderOverview();

    // Wait until overview query resolves and renders Not measured
    await waitFor(() => {
      expect(screen.getByText('Mesh Overview')).toBeInTheDocument();
      expect(screen.getAllByText('Not measured').length).toBeGreaterThan(0);
    });

    // Check data-state="not-measured" attribute exists
    const notMeasuredState = container.querySelector('[data-state="not-measured"]');
    expect(notMeasuredState).toBeInTheDocument();

    // Must show "No nodes enrolled" hint under the posture card
    expect(screen.getAllByText('No nodes enrolled').length).toBeGreaterThanOrEqual(1);

    // Must show Live line-rate rateHint since throughput is null
    expect(screen.getAllByText('Needs two samples a minute apart').length).toBeGreaterThan(0);

    // Axe accessibility validation
    await expectNoAxeViolations(container);
  });

  it('2. Active Fleet: renders active nodes, measured posture, throughput rates and geo entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/stats/overview') {
          return jsonResponse({
            active_nodes: 8,
            total_nodes: 10,
            quarantined_nodes: 1,
            connected_users: 5,
            active_users: 5,
            total_bandwidth_rx_mb_s: 42.5,
            total_bandwidth_tx_mb_s: 28.3,
            total_bandwidth_bytes: 10737418240, // 10 GiB
            network_health_score: 80,
            posture_verified_compliant_nodes: 7,
            posture_unverified_nodes: 1,
            posture_non_compliant_nodes: 1,
            liveness_window_seconds: 60
          });
        }
        if (url.includes('/api/stats/timeseries')) {
          return jsonResponse([
            { timestamp: '2026-09-24T06:00:00Z', time: '08:00', rx: 40.1, tx: 25.2 },
            { timestamp: '2026-09-24T07:00:00Z', time: '09:00', rx: 42.5, tx: 28.3 }
          ]);
        }
        if (url === '/api/stats/geo-matrix') {
          return jsonResponse([
            {
              country: 'Italy',
              code: 'IT',
              nodes: 6,
              live: 6,
              relays: 2,
              exits: 1,
              avg_latency: 14.2,
              status: 'Online'
            },
            {
              country: 'Germany',
              code: 'DE',
              nodes: 4,
              live: 2,
              relays: 1,
              exits: 0,
              avg_latency: null,
              status: 'Degraded'
            }
          ]);
        }
        return jsonResponse({});
      }) as unknown as typeof fetch
    );

    const { container } = renderOverview();

    // Wait for the query data to settle
    await waitFor(() => {
      expect(screen.getByText('8')).toBeInTheDocument();
      expect(screen.getByText('/ 10 Enrolled')).toBeInTheDocument();
      expect(screen.getByText('80')).toBeInTheDocument();
      expect(screen.getAllByText('Degraded').length).toBeGreaterThanOrEqual(1);
    });

    // Check posture breakdown
    expect(screen.getByText('7 posture verified')).toBeInTheDocument();
    expect(screen.getByText('1 unverified')).toBeInTheDocument();
    expect(screen.getByText('1 non-compliant')).toBeInTheDocument();
    expect(screen.getByText('1 quarantined')).toBeInTheDocument();

    // Check throughput line-rate (42.5 + 28.3 = 70.8 MB/s)
    expect(screen.getByText('70.8')).toBeInTheDocument();
    expect(screen.getByText('RX: 42.5 MB/s')).toBeInTheDocument();
    expect(screen.getByText('TX: 28.3 MB/s')).toBeInTheDocument();

    // Check lifetime transfer
    expect(screen.getByText('10.0 GiB')).toBeInTheDocument();

    // Check geographic presence
    expect(screen.getByText('Italy')).toBeInTheDocument();
    expect(screen.getByText('14.2ms')).toBeInTheDocument();
    expect(screen.getByText('Germany')).toBeInTheDocument();
    expect(screen.getByText('no RTT')).toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it('3. Error Handling: announces stale status when control plane is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Connection refused by control plane');
      }) as unknown as typeof fetch
    );

    renderOverview();

    await waitFor(() => {
      expect(screen.getByText('Control plane unreachable')).toBeInTheDocument();
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Figures below may be stale')).toBeInTheDocument();
  });

  it('4. Timeseries range selection works', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url === '/api/stats/overview') {
        return jsonResponse({ active_nodes: 1, total_nodes: 1 });
      }
      if (url.includes('/api/stats/timeseries')) {
        return jsonResponse([]);
      }
      if (url === '/api/stats/geo-matrix') {
        return jsonResponse([]);
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);

    const user = userEvent.setup();
    renderOverview();

    await waitFor(() => {
      expect(screen.getByText('Mesh Overview')).toBeInTheDocument();
    });

    const button1h = screen.getByRole('button', { name: '1h' });
    await user.click(button1h);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('/stats/timeseries?range=1h'), expect.anything());
    });
  });
});
