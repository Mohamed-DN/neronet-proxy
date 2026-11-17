import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import i18n from '../i18n';
import { expectNoAxeViolations, renderUI } from '../test/harness';
import MeRoute from './MeRoute';

const auth = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, role: null, isAuthenticated: true })
}));

const NOW_ISO = new Date().toISOString();

const ANNA_PHONE = {
  id: 'a1',
  name: 'Anna phone',
  user_id: 'u1',
  device_kind: 'profile',
  overlay_ipv4: '100.64.0.5',
  last_heartbeat: null
};
const ANNA_LAPTOP = {
  id: 'a2',
  name: 'Anna laptop',
  user_id: 'u1',
  overlay_ipv4: '100.64.0.7',
  is_healthy: true,
  last_heartbeat: NOW_ISO
};
const ANNA_GATEWAY = {
  id: 'a3',
  name: 'Office gateway',
  user_id: 'u1',
  device_kind: 'mesh',
  is_profile_gateway: true,
  profile_gateway_endpoint: '203.0.113.9:51820',
  overlay_ipv4: '100.64.0.1',
  is_healthy: true,
  last_heartbeat: NOW_ISO
};
const LUCA_LAPTOP = {
  id: 'b1',
  name: 'Luca laptop',
  user_id: 'u2',
  overlay_ipv4: '100.64.0.6',
  is_healthy: true,
  last_heartbeat: NOW_ISO
};

/** Stands in for the Add page and shows what the rebuild carried over. */
function AddProbe() {
  const { state } = useLocation() as { state: { name?: string } | null };
  return <p>{`Add page: ${state?.name ?? ''}`}</p>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** /nodes answers as asked; any other path (the app manifest) is not published. */
function stubApi(nodesAnswer: () => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/nodes')) return nodesAnswer();
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Waits for both queries to settle, so no state update lands after the test ends. */
async function renderMe(theme: 'light' | 'dark' = 'light') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = renderUI(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/me']}>
        <Routes>
          <Route path="/me" element={<MeRoute />} />
          <Route path="/me/add" element={<AddProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
    { theme }
  );
  await waitFor(() => {
    expect(screen.queryByText('Checking which apps are published…')).toBeNull();
    expect(screen.queryByText('Loading your devices…')).toBeNull();
  });
  return rendered;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Only switch back when a test changed it: re-announcing the same language re-renders mounted pages.
  if (i18n.language !== 'en') void i18n.changeLanguage('en');
});

describe('MeRoute', () => {
  it('admin sees only own devices', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'admin' };
    stubApi(() => json({ nodes: [ANNA_PHONE, LUCA_LAPTOP, ANNA_LAPTOP] }));

    await renderMe();

    const list = await screen.findByRole('list', { name: 'Your devices' });
    expect(within(list).getByText('Anna phone')).toBeInTheDocument();
    expect(within(list).getByText('Anna laptop')).toBeInTheDocument();
    expect(within(list).queryByText('Luca laptop')).toBeNull();
    expect(screen.queryByText('Luca laptop')).toBeNull();
    expect(screen.queryByText('To remove a device, ask an administrator.')).toBeNull();
    expect(screen.getByText('Not connected yet')).toBeInTheDocument();
  });

  it('shows the name a device is reachable by, as text, only when it has one', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() =>
      json({
        nodes: [
          { ...ANNA_PHONE, dns_name: 'anna-phone-2.example.com' },
          { ...ANNA_LAPTOP, dns_name: null }
        ]
      })
    );

    await renderMe();

    const list = await screen.findByRole('list', { name: 'Your devices' });
    const phone = within(list).getByText('Anna phone').closest('li') as HTMLElement;
    expect(within(phone).getByText('Reachable as')).toBeInTheDocument();
    expect(within(phone).getByText('anna-phone-2.example.com')).toBeInTheDocument();
    const laptop = within(list).getByText('Anna laptop').closest('li') as HTMLElement;
    expect(within(laptop).queryByText('Reachable as')).toBeNull();

    await i18n.changeLanguage('it');
    expect(await within(phone).findByText('Raggiungibile come')).toBeInTheDocument();
  });

  it('leaves out the gateway that serves the WireGuard profiles: it is not a personal device', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'admin' };
    stubApi(() => json({ nodes: [ANNA_PHONE, ANNA_GATEWAY, ANNA_LAPTOP] }));

    await renderMe();

    const list = await screen.findByRole('list', { name: 'Your devices' });
    expect(within(list).getByText('Anna phone')).toBeInTheDocument();
    expect(within(list).queryByText('Office gateway')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Office gateway' })).toBeNull();
  });

  it('shows a WireGuard-app device as connected when its gateway saw a recent handshake', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() => json({ nodes: [{ ...ANNA_PHONE, last_handshake_at: new Date().toISOString() }] }));

    await renderMe();

    const list = await screen.findByRole('list', { name: 'Your devices' });
    const row = within(list).getByText('Anna phone').closest('li') as HTMLElement;
    expect(within(row).getByText('Connected')).toBeInTheDocument();
  });

  it('says a blocked device is kept by an administrator when the server refuses the removal', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/nodes') && init?.method === 'DELETE') {
        return json({ code: 'device_blocked', error: 'device_blocked', message: 'blocked' }, 409);
      }
      if (url.includes('/nodes')) return json({ nodes: [ANNA_LAPTOP] });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderMe();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Anna laptop' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove device' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This device was blocked by an administrator: ask them to unblock or remove it.'
    );
  });

  it('says why the gateway cannot be removed when the server refuses it', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'admin' };
    // The list loads; the server refuses the DELETE because the node serves the profiles.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/nodes') && init?.method === 'DELETE') {
        return json({ code: 'profile_gateway_in_use', error: 'gateway' }, 409);
      }
      if (url.includes('/nodes')) return json({ nodes: [ANNA_LAPTOP] });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderMe();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Anna laptop' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove device' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Your other devices connect through Anna laptop, so it cannot be removed from here. Ask an administrator.'
    );
  });

  it('lists nothing of the organisation to a viewer who owns no device', async () => {
    auth.user = { id: 'u9', username: 'root', role: 'super-admin', org_role: 'owner' };
    stubApi(() => json({ nodes: [ANNA_PHONE, LUCA_LAPTOP, ANNA_LAPTOP] }));

    await renderMe();

    expect(await screen.findByText('No devices yet')).toBeInTheDocument();
    expect(screen.queryByText('Luca laptop')).toBeNull();
  });

  it('removes an own device after a confirmation that names the consequence', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    const fetchMock = stubApi(() => json({ nodes: [ANNA_PHONE, ANNA_LAPTOP] }));
    vi.spyOn(window, 'confirm');

    await renderMe();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Anna laptop' }));

    const dialog = await screen.findByRole('dialog', { name: 'Remove Anna laptop?' });
    expect(dialog).toHaveTextContent('loses access to the network straight away');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove device' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
      expect(String(call?.[0])).toBe('/api/nodes/a2');
    });
    expect(await screen.findByText('Anna laptop removed.')).toBeInTheDocument();
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('keeps the dialog open and says so when the removal fails', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE') return json({ error: 'nope' }, 500);
      if (url.includes('/nodes')) return json({ nodes: [ANNA_PHONE, ANNA_LAPTOP] });
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await renderMe();
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Anna phone' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove device' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Anna phone was not removed');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('empty state offers Add a device', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() => json({ nodes: [LUCA_LAPTOP] }));

    await renderMe();

    expect(await screen.findByText('No devices yet')).toBeInTheDocument();
    expect(screen.getByText("Add this phone or computer to reach your team's resources.")).toBeInTheDocument();
    // One call to action, not the empty state's plus a fixed bar repeating it.
    const links = screen.getAllByRole('link', { name: 'Add a device' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/me/add');
  });

  it('error state differs from empty', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() => json({ error: 'boom' }, 500));

    await renderMe();

    expect(await screen.findByText('Your devices could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument();
    expect(screen.queryByText('No devices yet')).toBeNull();
  });

  it('blocked notice counts own blocked devices', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() =>
      json({
        nodes: [
          { ...ANNA_LAPTOP, is_quarantined: true },
          { ...LUCA_LAPTOP, id: 'b2', is_quarantined: true }
        ]
      })
    );

    await renderMe();

    const notice = await screen.findByText('1 of your devices is blocked. Ask an administrator why.');
    expect(notice.closest('[role="status"]')).not.toBeNull();
  });

  it('has one heading for the page and shows each device as a station symbol and a word', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() =>
      json({
        nodes: [
          { ...ANNA_PHONE, last_handshake_at: new Date().toISOString() },
          { ...ANNA_LAPTOP, id: 'a4', name: 'Anna old laptop', is_quarantined: true }
        ]
      })
    );

    await renderMe();

    const list = await screen.findByRole('list', { name: 'Your devices' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Your devices' })).toBeNull();
    const phone = within(list).getByText('Anna phone').closest('li') as HTMLElement;
    expect(phone.querySelector('[data-station="service"]')).not.toBeNull();
    expect(within(phone).getByText('Connected')).toBeInTheDocument();
    const old = within(list).getByText('Anna old laptop').closest('li') as HTMLElement;
    expect(old.querySelector('[data-station="blocked"]')).not.toBeNull();
    expect(within(old).getByText('Blocked by an administrator')).toBeInTheDocument();
  });

  it('offers to set the access up again only for a phone or computer that uses the WireGuard app', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() => json({ nodes: [ANNA_PHONE, ANNA_LAPTOP] }));

    await renderMe();

    expect(await screen.findByRole('button', { name: 'Set up Anna phone again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up Anna laptop again' })).toBeNull();
  });

  it('does not offer to set up again a device an administrator blocked: that would replace it with an unblocked one', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() => json({ nodes: [{ ...ANNA_PHONE, is_quarantined: true }] }));

    await renderMe();

    expect(await screen.findByText('Blocked by an administrator')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up Anna phone again' })).toBeNull();
  });

  it('setting the access up again says the old one stops, removes the device and opens Add with the same name', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    const fetchMock = stubApi(() => json({ nodes: [ANNA_PHONE] }));

    await renderMe();
    await userEvent.click(await screen.findByRole('button', { name: 'Set up Anna phone again' }));

    const dialog = await screen.findByRole('dialog', { name: 'Set up Anna phone again?' });
    expect(dialog).toHaveTextContent('The current access stops working on Anna phone straight away');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Yes, set it up again' }));

    expect(await screen.findByText('Add page: Anna phone')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(String(call?.[0])).toBe('/api/nodes/a1');
  });

  it('primary action links to /me/add', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() => json({ nodes: [ANNA_PHONE] }));

    await renderMe();

    await screen.findByRole('list', { name: 'Your devices' });
    const link = screen.getByRole('link', { name: 'Add a device' });
    expect(link).toHaveAttribute('href', '/me/add');
    expect(link.className).toContain('h-11');
  });

  it('shows the Italian title in Italian', async () => {
    await i18n.changeLanguage('it');
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() => json({ nodes: [ANNA_PHONE] }));

    const { unmount } = await renderMe();

    expect(await screen.findByRole('heading', { level: 1, name: 'I miei dispositivi' })).toBeInTheDocument();
    // Unmount before switching back, so the language change does not re-render a mounted page.
    unmount();
    await i18n.changeLanguage('en');
  });

  it('is accessible in both themes', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() => json({ nodes: [ANNA_PHONE, ANNA_LAPTOP] }));

    const light = await renderMe('light');
    await screen.findByRole('list', { name: 'Your devices' });
    await expectNoAxeViolations(light.container, 'light');
    light.unmount();

    const dark = await renderMe('dark');
    await waitFor(() => expect(dark.container.querySelector('[role="list"]')).not.toBeNull());
    await expectNoAxeViolations(dark.container, 'dark');
    dark.unmount();
  });
});
