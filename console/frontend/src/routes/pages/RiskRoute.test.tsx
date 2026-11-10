import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RiskRoute from './RiskRoute';
import { clearSession, storeSession } from '../../services/authToken';
import { createQueryClient } from '../../services/queries/client';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import i18n from '../../i18n';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const SUMMARY = {
  distribution: { low: 1, medium: 1, high: 1 },
  average_risk_score: 50,
  total_nodes: 3,
  quarantined_nodes: 0,
  active_anomalies_count: 1
};

const LEADERBOARD = [
  { node_id: 'n-a', id: 'n-a', name: 'alpha', risk_score: 80, is_quarantined: false, status: 'active', color: 'red' },
  { node_id: 'n-b', id: 'n-b', name: 'beta', risk_score: 55, is_quarantined: false, status: 'active', color: 'yellow' },
  { node_id: 'n-c', id: 'n-c', name: 'gamma', risk_score: 20, is_quarantined: false, status: 'active', color: 'green' }
];

const NODES = [
  { id: 'n-a', name: 'alpha', role: 'CLIENT_ORIGIN', posture_status: 'verified_compliant' },
  { id: 'n-b', name: 'beta', role: null, posture_status: 'unverified' },
  { id: 'n-c', name: 'gamma', role: 'RELAY', posture_status: null }
];

const EVENTS = [
  {
    id: 'e1',
    event_type: 'IMPOSSIBLE_TRAVEL_DETECTED',
    node_id: 'n-a',
    actor: 'system',
    severity: 'WARNING',
    details: 'Impossible travel detected',
    created_at: '2026-11-09T10:00:00Z'
  }
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Answers each request from `answers` by "METHOD /path" or "/path", and records every call. */
function stubApi(answers: Record<string, () => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path =
        String(input)
          .replace(/^\/api/, '')
          .split('?')[0] ?? '';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      const answer = answers[`${method} ${path}`] ?? answers[path];
      return answer ? answer() : json({}, 404);
    }) as unknown as typeof fetch
  );
  return calls;
}

function healthy(overrides: Record<string, () => Response> = {}): Record<string, () => Response> {
  return {
    '/risk/summary': () => json(SUMMARY),
    '/risk/leaderboard': () => json({ leaderboard: LEADERBOARD }),
    '/risk/events': () => json({ events: EVENTS }),
    '/nodes': () => json({ nodes: NODES }),
    ...overrides
  };
}

function renderPage(theme: 'light' | 'dark' = 'light') {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return renderUI(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/risk']}>
        <RiskRoute />
      </MemoryRouter>
    </QueryClientProvider>,
    { theme }
  );
}

describe('RiskRoute (device risk score, in TypeScript)', () => {
  beforeEach(() => {
    localStorage.clear();
    storeSession({ token: 'test-token' });
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
    void i18n.changeLanguage('en');
  });

  it('has no Clear flag or reset-the-score button', async () => {
    stubApi(healthy());
    renderPage();

    await screen.findByRole('table', { name: 'Devices by score' });
    expect(screen.queryByRole('button', { name: /clear flag|reset the score|azzera/i })).toBeNull();
    expect(screen.queryByText(/clear flag/i)).toBeNull();
  });

  it('invents nothing when a city or a delta is missing', async () => {
    stubApi(healthy());
    const { container } = renderPage();

    await screen.findByRole('table', { name: 'Devices by score' });
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/undefined|null|NaN|Regional|\+50/);
  });

  it('says All checks passed only for a verified_compliant device', async () => {
    stubApi(healthy());
    renderPage();

    await screen.findByRole('table', { name: 'Devices by score' });
    // alpha is verified_compliant; beta is unverified and gamma has no posture data.
    expect(screen.getAllByText('All checks passed')).toHaveLength(1);
    expect(within(screen.getByRole('row', { name: /alpha/ })).getByText('All checks passed')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /beta/ })).queryByText('All checks passed')).toBeNull();
  });

  it('blocks through ConfirmDialog and posts quarantine with the localised reason', async () => {
    const calls = stubApi({
      ...healthy(),
      'POST /nodes/n-a/action': () => json({ success: true })
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('table', { name: 'Devices by score' });
    await user.click(within(screen.getByRole('row', { name: /alpha/ })).getByRole('button', { name: 'Block device' }));
    const dialog = await screen.findByRole('dialog', { name: 'Block alpha?' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Block device' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/nodes/n-a/action',
        body: { action: 'quarantine', params: { reason: 'Blocked from the risk score page' } }
      })
    );
  });

  it('a filter with no match shows the filtered empty state, not the empty leaderboard', async () => {
    stubApi(healthy({ '/risk/leaderboard': () => json({ leaderboard: [LEADERBOARD[2]] }) }));
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('table', { name: 'Devices by score' });
    await user.click(screen.getByRole('button', { name: 'Critical' }));

    expect(await screen.findByText('No devices match this filter')).toBeInTheDocument();
    expect(screen.queryByText('No device has a score yet.')).toBeNull();
  });

  it('shows an error state when the summary cannot be loaded', async () => {
    stubApi(healthy({ '/risk/summary': () => json({ error: 'boom' }, 500) }));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('The risk data could not be loaded. Try again.');
  });

  it.each(['light', 'dark'] as const)('has no axe violations in %s theme', async (theme) => {
    stubApi(healthy());
    const { container, unmount } = renderPage(theme);
    await screen.findByRole('table', { name: 'Devices by score' });
    await expectNoAxeViolations(container, theme);
    unmount();
  });
});
