import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import i18n from '../i18n';
import { createQueryClient } from '../services/queries';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';
import TopBar from './TopBar';

const auth = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, role: null, isAuthenticated: true, logout: async () => {} })
}));

const label = (key: string, options?: Record<string, unknown>) => i18n.t(key, { ns: 'chrome', ...options });

interface Options {
  nukeArmed?: boolean;
  cloudPc?: boolean;
  path?: string;
  quarantined?: number;
}

function asUser(role: string) {
  auth.user = {
    id: 'u1',
    username: 'someone',
    role: role === 'super-admin' ? 'super-admin' : 'user',
    org_role: role === 'super-admin' ? null : role
  };
}

function bar(options: Options = {}) {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[options.path ?? '/overview']}>
        <TopBar
          features={{ cloud_pc: options.cloudPc ?? false }}
          nodeCount={3}
          reachableCount={2}
          quarantinedCount={options.quarantined ?? 0}
          nukeArmed={options.nukeArmed ?? false}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderBar(role: string, options: Options = {}) {
  asUser(role);
  return renderUI(bar(options));
}

/** Opens a group and returns the names of the pages it lists. */
async function openGroup(group: 'network' | 'access' | 'security'): Promise<string[]> {
  const trigger = screen.queryByRole('button', { name: label(`nav.groups.${group}`) });
  if (!trigger) return [];
  await userEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const panel = document.getElementById(trigger.getAttribute('aria-controls') ?? '') as HTMLElement;
  const names = within(panel)
    .getAllByRole('link')
    .map((item) => item.textContent ?? '');
  await userEvent.keyboard('{Escape}');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  return names;
}

const item = (id: string) => label(`nav.items.${id}`);
const has = (names: string[], id: string) => names.some((name) => name.startsWith(item(id)));

describe('TopBar by role', () => {
  it('lists the four task groups in the order of the brief for the platform administrator', async () => {
    renderBar('super-admin');

    const nav = screen.getByRole('navigation', { name: label('nav.landmark') });
    const entries = [...nav.querySelectorAll('button, a')].map((el) => el.textContent?.trim());
    expect(entries).toEqual([
      label('nav.groups.network'),
      label('nav.groups.access'),
      label('nav.groups.security'),
      item('settings')
    ]);

    const network = await openGroup('network');
    expect(network.map((name) => name.replace(/\d+$/, ''))).toEqual([item('topology'), item('nodes'), item('subnets')]);
    const access = await openGroup('access');
    expect(access).toEqual([item('acls'), item('users'), item('peering')]);
    const security = await openGroup('security');
    expect(security).toEqual([item('risk'), item('audit'), item('nuke'), item('onion')]);
  });

  it('auditor sees the map, devices, rules, risk and the log but not people, settings, data erasure, routes or federation', async () => {
    renderBar('auditor');

    const network = await openGroup('network');
    const access = await openGroup('access');
    const security = await openGroup('security');

    expect(has(network, 'topology')).toBe(true);
    expect(has(network, 'nodes')).toBe(true);
    expect(has(access, 'acls')).toBe(true);
    expect(has(security, 'risk')).toBe(true);
    expect(has(security, 'audit')).toBe(true);

    expect(has(access, 'users')).toBe(false);
    expect(has(access, 'peering')).toBe(false);
    expect(has(security, 'nuke')).toBe(false);
    expect(has(security, 'onion')).toBe(false);
    expect(screen.queryByRole('link', { name: item('settings') })).toBeNull();
  });

  it('network administrator sees the three-stop routes but not data erasure', async () => {
    renderBar('network_admin');

    const security = await openGroup('security');
    expect(has(security, 'onion')).toBe(true);
    expect(has(security, 'nuke')).toBe(false);
    expect(await openGroup('access')).toEqual([item('acls')]);
  });

  it('shows Settings to owners and admins and data erasure to owners only', async () => {
    const { unmount } = renderBar('admin');
    expect(screen.getByRole('link', { name: item('settings') })).toBeInTheDocument();
    expect(has(await openGroup('security'), 'nuke')).toBe(false);
    unmount();

    renderBar('owner');
    expect(has(await openGroup('security'), 'nuke')).toBe(true);
  });

  it('lists virtual computers under Network only when the feature is on', async () => {
    const { unmount } = renderBar('owner', { cloudPc: false });
    expect(has(await openGroup('network'), 'cloudpc')).toBe(false);
    unmount();

    renderBar('owner', { cloudPc: true });
    expect(has(await openGroup('network'), 'cloudpc')).toBe(true);
  });

  it('hides a whole group a role has nothing in', () => {
    renderBar('member');

    expect(screen.queryByRole('button', { name: label('nav.groups.network') })).toBeNull();
    expect(screen.queryByRole('button', { name: label('nav.groups.access') })).toBeNull();
    expect(screen.queryByRole('button', { name: label('nav.groups.security') })).toBeNull();
  });

  it('offers My devices in the account menu for every console role', async () => {
    for (const role of ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user']) {
      const { unmount } = renderBar(role);
      await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${label('header.accountMenu')}`) }));
      const mine = await screen.findByRole('link', { name: item('me') });
      expect(mine, `My devices missing for ${role}`).toHaveAttribute('href', '/me');
      unmount();
    }
  });

  it('links the wordmark to the overview', () => {
    renderBar('owner');

    expect(screen.getByRole('link', { name: label('nav.home') })).toHaveAttribute('href', '/overview');
  });
});

describe('TopBar menus from the keyboard', () => {
  it('opens a group with Enter, moves with the arrow keys, and closes with Escape back onto the group', async () => {
    renderBar('super-admin');
    const trigger = screen.getByRole('button', { name: label('nav.groups.network') });

    trigger.focus();
    await userEvent.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    // Focus stays on the group; the first arrow key enters the list.
    expect(trigger).toHaveFocus();
    const panel = document.getElementById(trigger.getAttribute('aria-controls') ?? '') as HTMLElement;
    const [first, second, third] = within(panel).getAllByRole('link');

    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(first).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    expect(second).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(third).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(first).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(third).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('closes a group on a click outside and when focus leaves it', async () => {
    renderBar('super-admin');
    const network = screen.getByRole('button', { name: label('nav.groups.network') });
    const access = screen.getByRole('button', { name: label('nav.groups.access') });

    await userEvent.click(network);
    await userEvent.click(document.body);
    expect(network).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(network);
    await userEvent.click(access);
    expect(network).toHaveAttribute('aria-expanded', 'false');
    expect(access).toHaveAttribute('aria-expanded', 'true');
  });

  it('marks the group the current page is in', () => {
    renderBar('super-admin', { path: '/nodes/abc' });

    expect(screen.getByRole('button', { name: label('nav.groups.network') })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: label('nav.groups.access') })).not.toHaveAttribute('aria-current');
  });
});

describe('TopBar status', () => {
  it('says in words how many devices are in service and how many are blocked', () => {
    renderBar('owner', { quarantined: 2 });

    expect(screen.getByText(label('status.inService', { reachable: 2, total: 3 }))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: label('status.blocked', { count: 2 }) })).toHaveAttribute('href', '/nodes');
  });

  it('shows the armed erasure with its words and a button, and none when it is not armed', () => {
    const armed = renderBar('super-admin', { nukeArmed: true });
    expect(screen.getByText(label('status.erasureArmed'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: label('status.eraseNow') })).toBeInTheDocument();
    armed.unmount();

    renderBar('super-admin');
    expect(screen.queryByText(label('status.erasureArmed'))).toBeNull();
  });

  it('shows no badge text that promises a feature the console does not run', () => {
    renderBar('super-admin', { nukeArmed: true });

    const text = document.body.textContent ?? '';
    for (const badge of ['3-hop', 'Ed25519', 'WebRTC', '3-tier']) {
      expect(text).not.toContain(badge);
    }
  });

  it('uses no uppercase class and no tracked caps anywhere in the bar, including the armed block', () => {
    const { container } = renderBar('super-admin', { nukeArmed: true });

    expect(container.querySelectorAll('.uppercase')).toHaveLength(0);
    expect(container.querySelectorAll('[class*="tracking-"]')).toHaveLength(0);
  });

  it('has one banner and one navigation, and no axe violations in either theme', async () => {
    asUser('super-admin');
    await expectAccessibleInBothThemes(bar({ nukeArmed: true }));
    renderBar('super-admin');
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
  });
});
