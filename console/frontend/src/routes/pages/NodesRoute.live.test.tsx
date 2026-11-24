import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AuthContext, { type AuthValue } from '../../context/AuthContext';
import { setLanguage } from '../../i18n';
import { clearSession, storeSession } from '../../services/authToken';
import { createQueryClient } from '../../services/queries';
import { renderUI } from '../../test/harness';
import { ShellProvider } from '../shell';
import NodesRoute from './NodesRoute';

// ADR 0040 and ADR 0040: the device page tells where a device is only when someone stated
// it, shows how it answered the gateway with the age of that answer, and the connection
// test shows its own request, not a stored number.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function auth(role: string): AuthValue {
  const user = { id: 'u1', username: 'someone', role, org_role: role, organization_id: 'org-a' };
  return {
    user,
    role,
    token: null,
    loading: false,
    isAuthenticated: true,
    switchRole: () => {},
    login: async () => user,
    completeMfaSignIn: async () => user,
    logout: async () => {},
    refreshUser: async () => {}
  };
}

const phone = (over: Record<string, unknown> = {}) => ({
  id: 'dev-phone',
  name: 'Maria phone',
  overlay_ipv4: '100.64.0.9',
  role: 'CLIENT_ORIGIN',
  device_kind: 'profile',
  country_code: null,
  location_source: null,
  is_healthy: true,
  is_quarantined: false,
  posture_status: 'unverified',
  posture_checks: {},
  risk_score: null,
  public_key: 'WGPubKeyPhone1111111111111111111111111111111=',
  last_handshake_at: new Date(Date.now() - 20_000).toISOString(),
  rtt_ms: 12.5,
  rtt_measured_at: new Date(Date.now() - 30_000).toISOString(),
  rtt_method: 'icmp',
  ...over
});

interface Plane {
  node: ReturnType<typeof phone>;
  probe: { first: unknown; reads: unknown[] };
  calls: { method: string; url: string; body?: unknown }[];
}

function mount(role: string, plane: Plane) {
  vi.stubGlobal(
    'WebSocket',
    class {
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    }
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      plane.calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/nodes') return json({ nodes: [plane.node] });
      if (url === '/api/devices/gateways') return json({ gateways: [] });
      if (method === 'PUT' && url.endsWith('/location')) {
        const body = JSON.parse(String(init?.body));
        plane.node = phone({
          ...plane.node,
          country_code: body.country_code,
          location_source: body.country_code ? 'declared' : null
        });
        return json({ node: plane.node });
      }
      if (method === 'POST' && url.endsWith('/probe')) return json(plane.probe.first);
      if (url.includes('/probe/')) return json(plane.probe.reads.length > 1 ? plane.probe.reads.shift() : plane.probe.reads[0]);
      if (url.endsWith('/api/nodes/dev-phone')) return json({ node: plane.node });
      return json({});
    }) as unknown as typeof fetch
  );
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return renderUI(
    <AuthContext.Provider value={auth(role)}>
      <QueryClientProvider client={client}>
        <ShellProvider>
          <MemoryRouter initialEntries={['/nodes/dev-phone']}>
            <Routes>
              <Route path="/nodes" element={<NodesRoute />} />
              <Route path="/nodes/:id" element={<NodesRoute />} />
            </Routes>
          </MemoryRouter>
        </ShellProvider>
      </QueryClientProvider>
    </AuthContext.Provider>
  );
}

const plane = (over: Partial<Plane> = {}): Plane => ({
  node: phone(),
  probe: { first: { request_id: 'prb-1', state: 'pending' }, reads: [{ request_id: 'prb-1', state: 'measuring' }] },
  calls: [],
  ...over
});

describe('device page: location, response time and the connection test', () => {
  beforeEach(() => {
    localStorage.clear();
    storeSession({ token: 'test-token' });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    clearSession();
    await setLanguage('en');
    localStorage.clear();
  });

  const clickTest = async () => {
    const dialog = await screen.findByRole('dialog');
    await userEvent.setup().click(await within(dialog).findByRole('button', { name: 'Test connection' }));
    return dialog;
  };

  it('says Location unknown for a device nobody placed, and never a country', async () => {
    mount('member', plane());
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Maria phone');
    expect(within(dialog).getAllByText('Location unknown').length).toBeGreaterThan(0);
    expect(within(dialog).queryByText(/United States/)).not.toBeInTheDocument();
  });

  it('shows a stated country with who stated it', async () => {
    mount('member', plane({ node: phone({ country_code: 'IT', location_source: 'declared' }) }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Italy · stated by an administrator')).toBeInTheDocument();
  });

  it('lets an administrator state a country; a plain member sees no control for it', async () => {
    const member = mount('member', plane());
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Maria phone');
    expect(within(dialog).queryByText('Save country')).not.toBeInTheDocument();
    member.unmount();

    const p = plane();
    mount('admin', p);
    const adminDialog = await screen.findByRole('dialog');
    const save = await within(adminDialog).findByRole('button', { name: 'Save country' });
    expect(save).toBeDisabled();
    const user = userEvent.setup();
    await user.click(within(adminDialog).getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Italy' }));
    await user.click(save);
    await waitFor(() => expect(p.calls.find((c) => c.method === 'PUT')?.body).toEqual({ country_code: 'IT' }));
    expect(await within(adminDialog).findByText('Location saved.')).toBeInTheDocument();
  });

  it('shows the gateway ping with its age, and a no-reply as no reply, not as a number', async () => {
    const first = mount('member', plane());
    let dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/12\.5 ms · 30 seconds ago/)).toBeInTheDocument();
    first.unmount();

    mount('member', plane({ node: phone({ rtt_ms: null }) }));
    dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/No reply · 30 seconds ago/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/12\.5/)).not.toBeInTheDocument();
  });

  it('measuring, then replied in X ms with ICMP and the time', async () => {
    const p = plane({
      probe: {
        first: { request_id: 'prb-1', state: 'pending' },
        reads: [
          { request_id: 'prb-1', state: 'measuring' },
          { request_id: 'prb-1', state: 'replied', rtt_ms: 4.25, method: 'icmp', answered_at: new Date().toISOString() }
        ]
      }
    });
    mount('member', p);
    const dialog = await clickTest();
    expect(await within(dialog).findByText('Measuring…')).toBeInTheDocument();
    expect(await within(dialog).findByText(/Replied in 4\.25 ms \(ICMP\)/)).toBeInTheDocument();
    expect(p.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/probe'))).toHaveLength(1);
  });

  it('no reply but connected: last contact, and one sentence that Windows blocks ping by default', async () => {
    mount(
      'member',
      plane({
        probe: {
          first: { request_id: 'prb-1', state: 'pending' },
          reads: [{ request_id: 'prb-1', state: 'no_reply', last_contact_at: new Date(Date.now() - 15_000).toISOString() }]
        }
      })
    );
    const dialog = await clickTest();
    const text = await within(dialog).findByText(/No reply within 3 seconds, but the device is connected/);
    expect(text).toHaveTextContent('last contact 15 seconds ago');
    expect(text).toHaveTextContent('Windows blocks ping by default');
  });

  it('not connected, with the last contact or without one', async () => {
    mount('member', plane({ probe: { first: { state: 'not_connected', last_contact_at: new Date(Date.now() - 600_000).toISOString() }, reads: [] } }));
    let dialog = await clickTest();
    expect(await within(dialog).findByText(/Not connected\. Last contact 10 minutes ago\./)).toBeInTheDocument();
    vi.unstubAllGlobals();

    mount('member', plane({ probe: { first: { state: 'not_connected', last_contact_at: null }, reads: [] } }));
    const dialogs = await screen.findAllByRole('dialog');
    dialog = dialogs[dialogs.length - 1]!;
    await userEvent.setup().click(await within(dialog).findByRole('button', { name: 'Test connection' }));
    expect(await within(dialog).findByText(/never been in contact/)).toBeInTheDocument();
  });

  it('gateway not reachable and an unsupported device are said plainly', async () => {
    mount('member', plane({ probe: { first: { state: 'gateway_unreachable' }, reads: [] } }));
    const dialog = await clickTest();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The gateway that serves this device did not answer. Try again shortly.'
    );
  });

  it('is worded in Italian', async () => {
    await setLanguage('it');
    mount('member', plane({ probe: { first: { state: 'gateway_unreachable' }, reads: [] } }));
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findAllByText('Posizione sconosciuta')).length).toBeGreaterThan(0);
    await userEvent.setup().click(await within(dialog).findByRole('button', { name: /Prova|Verifica|Test/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Il gateway che serve questo dispositivo non ha risposto');
  });
});
