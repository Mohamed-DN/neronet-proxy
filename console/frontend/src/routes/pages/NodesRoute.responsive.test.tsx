import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, storeSession } from '../../services/authToken';
import { createQueryClient } from '../../services/queries';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { stubLayout } from '../../test/layout';
import type { LayoutSize } from '../../ui/useLayoutSize';
import { ShellProvider } from '../shell';
import NodesRoute from './NodesRoute';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const nodes = [
  {
    id: 'n-rome',
    name: 'Rome Gateway Alpha',
    hostname: 'gw-rome-01',
    overlay_ipv4: '10.200.0.1',
    role: 'EXIT_BRIDGE',
    device_kind: 'mesh',
    is_healthy: true,
    is_quarantined: false,
    posture_status: 'verified_compliant',
    posture_checks: { disk_encrypted: true, firewall_active: true, os_name: 'Linux', os_version: '6.6' },
    risk_score: 15,
    public_key: 'WGPubKeyRome11111111111111111111111111111111=',
    last_heartbeat: new Date().toISOString()
  },
  {
    id: 'n-berlin',
    name: 'Berlin Relay Bravo',
    hostname: 'relay-berlin-01',
    overlay_ipv4: '10.200.0.2',
    role: 'RELAY',
    device_kind: 'mesh',
    is_healthy: true,
    is_quarantined: true,
    quarantine_reason: 'Anomalous egress burst',
    posture_status: 'unverified',
    risk_score: null,
    public_key: 'WGPubKeyBerlin2222222222222222222222222222222=',
    last_heartbeat: new Date().toISOString()
  }
];

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderNodes(size: LayoutSize, path = '/nodes') {
  stubLayout(size);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return renderUI(
    <QueryClientProvider client={queryClient}>
      <ShellProvider>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/nodes" element={<NodesRoute />} />
            <Route path="/nodes/:id" element={<NodesRoute />} />
          </Routes>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  storeSession({ token: 'test-token' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/nodes') return jsonResponse({ nodes });
      const one = nodes.find((n) => url === `/api/nodes/${n.id}`);
      return jsonResponse(one ? { node: one } : {});
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
  localStorage.clear();
});

describe('Devices page: master-detail on a tablet', () => {
  it('shows the list on the left and the open device on the right, in the same view and with no dialog', async () => {
    renderNodes('tablet', '/nodes/n-rome');

    const list = await screen.findByRole('list', { name: 'Devices' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('table')).toBeNull();

    const pane = await screen.findByRole('complementary', { name: 'Rome Gateway Alpha' });
    expect(within(pane).getByRole('heading', { level: 2, name: 'Rome Gateway Alpha' })).toBeInTheDocument();
    expect(within(pane).getByText('Device security checks')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    // The open device is marked in the list.
    expect(within(list).getByRole('button', { name: /Rome Gateway Alpha/ })).toHaveAttribute('aria-current', 'true');
  });

  it('asks for a choice while nothing is open, and opening a row puts the id in the address', async () => {
    renderNodes('tablet');

    await screen.findByRole('list', { name: 'Devices' });
    expect(screen.getByText('Choose a device to see its details here.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Berlin Relay Bravo/ }));

    expect(screen.getByTestId('where')).toHaveTextContent('/nodes/n-berlin');
    const pane = await screen.findByRole('complementary', { name: 'Berlin Relay Bravo' });
    expect(await within(pane).findByText('Device security checks')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Devices' })).toBeInTheDocument();
  });

  it('closes the open device from the pane and goes back to /nodes', async () => {
    renderNodes('tablet', '/nodes/n-rome');
    const pane = await screen.findByRole('complementary', { name: 'Rome Gateway Alpha' });

    await userEvent.click(within(pane).getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/nodes$/));
    expect(screen.queryByRole('complementary', { name: 'Rome Gateway Alpha' })).toBeNull();
  });

  it('has no accessibility violations with a device open', async () => {
    const { container } = renderNodes('tablet', '/nodes/n-rome');
    await screen.findByRole('complementary', { name: 'Rome Gateway Alpha' });
    await expectNoAxeViolations(container);
  });
});

describe('Devices page: rows then a full-screen detail on a phone', () => {
  it('lists station rows (name and one muted line), not a table', async () => {
    renderNodes('phone');

    const list = await screen.findByRole('list', { name: 'Devices' });
    expect(screen.queryByRole('table')).toBeNull();
    const rome = within(list).getByRole('button', { name: /Rome Gateway Alpha/ });
    expect(rome).toHaveTextContent('10.200.0.1');
    expect(within(list).getByRole('button', { name: /Berlin Relay Bravo/ })).toHaveTextContent('Blocked');
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('opens a device as a full-screen detail route with a back button that returns to the list', async () => {
    renderNodes('phone');
    await userEvent.click(await screen.findByRole('button', { name: /Rome Gateway Alpha/ }));

    expect(screen.getByTestId('where')).toHaveTextContent('/nodes/n-rome');
    const detail = await screen.findByRole('region', { name: 'Rome Gateway Alpha' });
    expect(await within(detail).findByText('Device security checks')).toBeInTheDocument();
    // The list and the page header are replaced, not shown beside the detail.
    expect(screen.queryByRole('list', { name: 'Devices' })).toBeNull();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/nodes$/));
    expect(await screen.findByRole('list', { name: 'Devices' })).toBeInTheDocument();
  });

  it('goes straight to the detail when the address names a device', async () => {
    renderNodes('phone', '/nodes/n-berlin');
    const detail = await screen.findByRole('region', { name: 'Berlin Relay Bravo' });
    expect(within(detail).getByRole('button', { name: 'Remove block' })).toBeInTheDocument();
  });

  it('puts the primary action in a bar fixed above the tab bar', async () => {
    const { container } = renderNodes('phone');
    await screen.findByRole('list', { name: 'Devices' });
    const bar = container.querySelector('[data-sticky-actions]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(within(bar).getByRole('button', { name: 'Add device' })).toBeInTheDocument();
    expect(bar.className).toContain('fixed');
  });
});

describe('Devices page on a desktop', () => {
  it('keeps the table and opens a device in a dialog', async () => {
    renderNodes('desktop', '/nodes/n-rome');

    expect(await screen.findByRole('dialog', { name: 'Rome Gateway Alpha' })).toBeInTheDocument();
    // The table is behind the modal, which hides it from the accessibility tree.
    expect(screen.getByRole('table', { hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole('complementary')).toBeNull();
  });
});
