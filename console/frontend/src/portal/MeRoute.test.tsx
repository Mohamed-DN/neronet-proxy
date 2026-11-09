import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import i18n from '../i18n';
import { expectNoAxeViolations, renderUI } from '../test/harness';
import MeRoute from './MeRoute';

const auth = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, role: null, isAuthenticated: true })
}));

const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true } as const;

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
const LUCA_LAPTOP = {
  id: 'b1',
  name: 'Luca laptop',
  user_id: 'u2',
  overlay_ipv4: '100.64.0.6',
  is_healthy: true,
  last_heartbeat: NOW_ISO
};

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
      <MemoryRouter initialEntries={['/me']} future={ROUTER_FUTURE}>
        <Routes>
          <Route path="/me" element={<MeRoute />} />
          <Route path="/me/add" element={<p>Add page</p>} />
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
    expect(screen.getByText('To remove a device, ask an administrator.')).toBeInTheDocument();
    expect(
      screen.getByText('Uses the WireGuard app. Its connection is not reported to the console.')
    ).toBeInTheDocument();
  });

  it('empty state offers Add a device', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() => json({ nodes: [LUCA_LAPTOP] }));

    await renderMe();

    expect(await screen.findByText('No devices yet')).toBeInTheDocument();
    expect(screen.getByText("Add this phone or computer to reach your team's resources.")).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Add a device' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveAttribute('href', '/me/add');
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

  it('copy button copies the address and says so', async () => {
    auth.user = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
    stubApi(() => json({ nodes: [ANNA_PHONE] }));
    // userEvent.setup() installs its own clipboard, so the spy must come after it.
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    await renderMe();

    await user.click(await screen.findByRole('button', { name: 'Copy the address of Anna phone' }));

    expect(writeText).toHaveBeenCalledWith('100.64.0.5');
    expect(await screen.findByText('Address copied.')).toBeInTheDocument();
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
