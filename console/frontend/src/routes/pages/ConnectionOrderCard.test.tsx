import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../../services/queries/client';
import type { MeshNode } from '../../services/types';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { ConnectionOrderCard } from './ConnectionOrderCard';
import { DeviceConnectionOrderCard } from './DeviceConnectionOrderCard';

// The organisation card and the device card talk to /api/connection-order. The server resolves
// the effective order; these tests check what the console shows and what it sends.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const ALL = ['wireguard', 'wireguard-wss', 'amneziawg'];
const effective = (order: string[], origin: unknown, extra = {}) => ({
  order,
  forced: false,
  origin,
  usable: true,
  person_blocked: null,
  ...extra
});

const ORG = {
  organization_id: 'org-a',
  allowed: ALL,
  own: { order: null, forced: false },
  members_may_choose: false,
  default_order: ALL,
  effective: effective(ALL, { scope: 'default' })
};

const DEVICE = {
  device_id: 'dev-1',
  name: 'Ada phone',
  access_method: 'wireguard',
  line: { id: 'cmp-1', name: 'Viaggiatori', locked: false },
  allowed: ['wireguard', 'wireguard-wss'],
  available: ['wireguard', 'wireguard-wss'],
  own: { order: null, forced: false, locked: false },
  members_may_choose: true,
  inherited: effective(['wireguard-wss', 'wireguard'], { scope: 'line', id: 'cmp-1', name: 'Viaggiatori' }),
  effective: effective(['wireguard-wss', 'wireguard'], { scope: 'line', id: 'cmp-1', name: 'Viaggiatori' }),
  can_edit: true,
  can_lock: true
};
const PLAN = { strands: [], strands_total: 0, reimport: [], reimport_total: 0 };

const phone = { id: 'dev-1', name: 'Ada phone', device_kind: 'profile' } as unknown as MeshNode;

function stub(handler: (url: string, init?: RequestInit) => Response | undefined) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      return handler(url, init) ?? json({});
    }) as unknown as typeof fetch
  );
  return calls;
}

function inClient(ui: React.ReactElement) {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return renderUI(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('ConnectionOrderCard (Settings)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('says what the organisation tries first and where that comes from, and passes axe', async () => {
    stub((url) => (url === '/api/connection-order/organization' ? json(ORG) : undefined));
    const { container } = inClient(<ConnectionOrderCard user={{ role: 'admin' }} />);
    expect(
      await screen.findByText('Tries first: WireGuard, then port 443, then AmneziaWG (Automatic).')
    ).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('saves a custom order after asking the server who it would affect', async () => {
    const u = userEvent.setup();
    const calls = stub((url, init) => {
      if (url === '/api/connection-order/organization' && (!init?.method || init.method === 'GET')) return json(ORG);
      if (url === '/api/connection-order/preview') return json(PLAN);
      if (url === '/api/connection-order/organization' && init?.method === 'PUT') return json({ ...ORG, plan: PLAN });
      return undefined;
    });
    inClient(<ConnectionOrderCard user={{ role: 'admin' }} />);
    await screen.findByText(/Tries first/);
    await u.click(screen.getByRole('radio', { name: 'Custom' }));
    await u.click(screen.getByRole('button', { name: 'Move port 443 up' }));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const preview = calls.find((c) => c.url === '/api/connection-order/preview');
    expect(preview?.body).toEqual({
      scope: 'organization',
      settings: { order: ['wireguard-wss', 'wireguard', 'amneziawg'], forced: false }
    });
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      order: ['wireguard-wss', 'wireguard', 'amneziawg'],
      forced: false
    });
  });

  it('lets an administrator switch "members can choose" on', async () => {
    const u = userEvent.setup();
    const calls = stub((url, init) => {
      if (url === '/api/connection-order/organization' && (!init?.method || init.method === 'GET')) return json(ORG);
      if (init?.method === 'PUT') return json({ ...ORG, members_may_choose: true, plan: PLAN });
      return undefined;
    });
    inClient(<ConnectionOrderCard user={{ role: 'admin' }} />);
    await u.click(await screen.findByRole('switch', { name: 'Members can choose' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ members_may_choose: true }));
  });

  it('is read-only for a member', async () => {
    stub((url) => (url === '/api/connection-order/organization' ? json(ORG) : undefined));
    inClient(<ConnectionOrderCard user={{ role: 'user', org_role: 'member' }} />);
    await screen.findByText(/Tries first/);
    expect(screen.getByRole('switch', { name: 'Members can choose' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(
      screen.getByText('Only the organisation owner or an administrator can change the connection order.')
    ).toBeInTheDocument();
  });

  it('offers a retry when the order cannot be loaded', async () => {
    stub(() => json({ error: 'boom' }, 500));
    inClient(<ConnectionOrderCard user={{ role: 'admin' }} />);
    expect(await screen.findByText('Could not load the connection order. Try again.')).toBeInTheDocument();
  });
});

describe('DeviceConnectionOrderCard (device detail)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows where the order comes from, by line name', async () => {
    stub((url) => (url === '/api/connection-order/devices/dev-1' ? json(DEVICE) : undefined));
    const { container } = inClient(<DeviceConnectionOrderCard device={phone} />);
    expect(
      await screen.findByText('Tries first: port 443, then WireGuard (from line Viaggiatori).')
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Inherit from line Viaggiatori' })).toBeChecked();
    expect(screen.getByText('The profile on this device is made for WireGuard.')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('only offers what the line allows, and forces a single method', async () => {
    const u = userEvent.setup();
    const calls = stub((url, init) => {
      if (url === '/api/connection-order/devices/dev-1' && (!init?.method || init.method === 'GET'))
        return json(DEVICE);
      if (url === '/api/connection-order/preview') return json(PLAN);
      if (init?.method === 'PUT') return json({ ...DEVICE, plan: PLAN });
      return undefined;
    });
    inClient(<DeviceConnectionOrderCard device={phone} />);
    await screen.findByText(/Tries first/);
    await u.click(screen.getByRole('radio', { name: 'Custom' }));
    expect(screen.queryByRole('switch', { name: 'Use AmneziaWG' })).not.toBeInTheDocument();
    await u.click(screen.getByRole('switch', { name: 'Force only the first' }));
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        order: ['wireguard-wss', 'wireguard'],
        forced: true
      })
    );
    expect(calls.find((c) => c.url === '/api/connection-order/preview')?.body).toMatchObject({
      scope: 'device',
      id: 'dev-1'
    });
  });

  it('lets an administrator lock the setting', async () => {
    const u = userEvent.setup();
    const calls = stub((url, init) => {
      if (url === '/api/connection-order/devices/dev-1' && (!init?.method || init.method === 'GET'))
        return json(DEVICE);
      if (init?.method === 'PUT') return json({ ...DEVICE, own: { ...DEVICE.own, locked: true }, plan: PLAN });
      return undefined;
    });
    inClient(<DeviceConnectionOrderCard device={phone} />);
    await u.click(await screen.findByRole('switch', { name: 'Lock this setting' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ locked: true }));
  });

  it('is read-only for the owner of a locked device and says why', async () => {
    stub((url) =>
      url === '/api/connection-order/devices/dev-1'
        ? json({
            ...DEVICE,
            can_edit: false,
            can_lock: false,
            own: { order: ['wireguard'], forced: false, locked: true },
            effective: effective(['wireguard'], { scope: 'device', id: 'dev-1' }, { person_blocked: 'locked' })
          })
        : undefined
    );
    inClient(<DeviceConnectionOrderCard device={phone} />);
    await screen.findByText(/Tries first/);
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Lock this setting' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/An administrator locked this setting/).length).toBeGreaterThan(0);
  });

  it('warns when no method of the order is one the gateway runs', async () => {
    stub((url) =>
      url === '/api/connection-order/devices/dev-1'
        ? json({ ...DEVICE, effective: effective([], { scope: 'device' }, { usable: false }) })
        : undefined
    );
    inClient(<DeviceConnectionOrderCard device={phone} />);
    expect(await screen.findByText(/The device cannot connect\./)).toBeInTheDocument();
  });

  it('renders nothing for a device the person may not see', async () => {
    stub(() => json({ error: 'no_such_device' }, 404));
    const { container } = inClient(<DeviceConnectionOrderCard device={phone} />);
    await waitFor(() => expect(container.textContent).toBe(''));
  });
});
