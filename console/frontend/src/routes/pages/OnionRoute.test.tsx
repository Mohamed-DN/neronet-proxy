import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OnionRoute from './OnionRoute';
import { clearSession, storeSession } from '../../services/authToken';
import { createQueryClient } from '../../services/queries/client';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import i18n from '../../i18n';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const NODES = [
  {
    id: 'n-alpha',
    name: 'alpha',
    overlay_ipv4: '100.64.0.10',
    role: 'EXIT_BRIDGE',
    country_code: null,
    onion_routing_enabled: false
  },
  {
    id: 'n-beta',
    name: 'beta',
    overlay_ipv4: '100.64.0.11',
    role: 'CLIENT_ORIGIN',
    country_code: 'DE',
    onion_routing_enabled: true
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

function renderPage(theme: 'light' | 'dark' = 'light') {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
  return renderUI(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/onion']}>
        <OnionRoute />
      </MemoryRouter>
    </QueryClientProvider>,
    { theme }
  );
}

describe('OnionRoute (three-stop routes, in TypeScript)', () => {
  beforeEach(() => {
    localStorage.clear();
    storeSession({ token: 'test-token' });
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
    void i18n.changeLanguage('en');
  });

  it('shows an error, not "no devices", when the load fails', async () => {
    stubApi({ '/nodes': () => json({ error: 'boom' }, 500) });
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The devices could not be loaded. Try again.');
    expect(screen.queryByText('No devices registered')).toBeNull();
  });

  it('reads Unknown for a device whose country was not reported', async () => {
    stubApi({ '/nodes': () => json({ nodes: NODES }) });
    renderPage();

    await screen.findByRole('table', { name: 'Devices and their stops' });
    expect(within(screen.getByRole('row', { name: /alpha/ })).getByText('Unknown')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /beta/ })).getByText('DE')).toBeInTheDocument();
  });

  it('posts toggle_onion with enabled true when a device is switched on', async () => {
    const calls = stubApi({
      '/nodes': () => json({ nodes: NODES }),
      'POST /nodes/n-alpha/action': () => json({ success: true })
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('switch', { name: 'Three stops for alpha' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/nodes/n-alpha/action',
        body: { action: 'toggle_onion', params: { enabled: true } }
      })
    );
  });

  it('explains the module-off refusal when the server answers 403', async () => {
    stubApi({
      '/nodes': () => json({ nodes: NODES }),
      'POST /nodes/n-alpha/action': () => json({ error: 'onion routing is disabled for this organization' }, 403)
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('switch', { name: 'Three stops for alpha' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/switched off for this organisation/);
  });

  it('has no kill switch control', async () => {
    stubApi({ '/nodes': () => json({ nodes: NODES }) });
    renderPage();

    await screen.findByRole('table', { name: 'Devices and their stops' });
    expect(screen.queryByText(/kill/i)).toBeNull();
  });

  it('says in the description that no traffic uses the routes yet', async () => {
    stubApi({ '/nodes': () => json({ nodes: NODES }) });
    renderPage();

    expect(
      await screen.findByText(
        'Choose which devices should use three-stop routes; the choice is saved, but no traffic uses these routes yet.'
      )
    ).toBeInTheDocument();
  });

  it.each(['light', 'dark'] as const)('has no axe violations in %s theme', async (theme) => {
    stubApi({ '/nodes': () => json({ nodes: NODES }) });
    const { container, unmount } = renderPage(theme);
    await screen.findByRole('table', { name: 'Devices and their stops' });
    await expectNoAxeViolations(container, theme);
    unmount();
  });
});
