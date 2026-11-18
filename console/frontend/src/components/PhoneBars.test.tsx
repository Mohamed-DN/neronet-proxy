import { QueryClientProvider } from '@tanstack/react-query';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import i18n from '../i18n';
import { createQueryClient } from '../services/queries';
import { stubLayout } from '../test/layout';
import { expectAccessibleInBothThemes, renderUI } from '../test/harness';
import { BottomTabBar, PhoneTopBar } from './PhoneBars';
import TabletBar from './TabletBar';

const auth = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, role: null, isAuthenticated: true, logout: async () => {} })
}));

afterEach(() => vi.unstubAllGlobals());

const label = (key: string, options?: Record<string, unknown>) => i18n.t(key, { ns: 'chrome', ...options });

function asUser(role: string) {
  auth.user = {
    id: 'u1',
    username: 'someone',
    role: role === 'super-admin' ? 'super-admin' : 'user',
    org_role: role === 'super-admin' ? null : role
  };
}

function shell(role: string, path = '/nodes', cloudPc = false) {
  asUser(role);
  stubLayout('phone');
  const props = { features: { cloud_pc: cloudPc }, nodeCount: 3, reachableCount: 2, quarantinedCount: 1 };
  return renderUI(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <PhoneTopBar {...props} />
        <BottomTabBar {...props} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function tabs() {
  const nav = screen.getByRole('navigation', { name: label('nav.landmark') });
  return [...nav.querySelectorAll('button, a')].map((el) => el.textContent?.trim());
}

describe('phone tab bar', () => {
  it('shows the four groups with an icon and a word each, for the platform administrator', () => {
    const { container } = shell('super-admin');
    expect(tabs()).toEqual([
      label('nav.groups.network'),
      label('nav.groups.access'),
      label('nav.groups.security'),
      label('nav.items.settings')
    ]);
    const nav = screen.getByRole('navigation', { name: label('nav.landmark') });
    expect(nav.querySelectorAll('svg')).toHaveLength(4);
    // Fixed to the bottom edge, clearing the home indicator.
    expect(container.querySelector('[data-bottom-tabs]')?.className).toContain('safe-area-inset-bottom');
  });

  it('marks the group of the current page with aria-current', () => {
    shell('super-admin', '/nodes');
    expect(screen.getByRole('button', { name: label('nav.groups.network') })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: label('nav.groups.access') })).not.toHaveAttribute('aria-current');
  });

  it('marks Settings as the current page on /settings', () => {
    shell('super-admin', '/settings');
    expect(screen.getByRole('link', { name: label('nav.items.settings') })).toHaveAttribute('aria-current', 'page');
  });

  it('opens a sheet with the group pages, marks the current one and closes when one is chosen', async () => {
    shell('super-admin', '/nodes');
    await userEvent.click(screen.getByRole('button', { name: label('nav.groups.network') }));

    const sheet = await screen.findByRole('dialog', { name: label('nav.groups.network') });
    const links = within(sheet).getAllByRole('link');
    expect(links.map((link) => link.textContent?.replace(/\d+.*$/, ''))).toEqual([
      label('nav.items.topology'),
      label('nav.items.nodes'),
      label('nav.items.subnets')
    ]);
    expect(within(sheet).getByRole('link', { name: new RegExp(label('nav.items.nodes')) })).toHaveAttribute(
      'aria-current',
      'page'
    );

    await userEvent.click(within(sheet).getByRole('link', { name: new RegExp(label('nav.items.subnets')) }));
    expect(screen.queryByRole('dialog', { name: label('nav.groups.network') })).toBeNull();
  });

  it('gives an auditor only what roles.ts allows: no People, Federation, data erasure, routes or Settings', async () => {
    shell('auditor');
    // Settings is for owners and admins.
    expect(tabs()).toEqual([label('nav.groups.network'), label('nav.groups.access'), label('nav.groups.security')]);

    await userEvent.click(screen.getByRole('button', { name: label('nav.groups.access') }));
    let sheet = await screen.findByRole('dialog');
    expect(
      within(sheet)
        .getAllByRole('link')
        .map((l) => l.textContent)
    ).toEqual([label('nav.items.acls')]);
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: label('nav.groups.security') }));
    sheet = await screen.findByRole('dialog');
    expect(
      within(sheet)
        .getAllByRole('link')
        .map((l) => l.textContent?.replace(/\d+.*$/, ''))
    ).toEqual([label('nav.items.risk'), label('nav.items.audit')]);
  });

  it('lists virtual computers under Network only when the feature is on', async () => {
    shell('owner', '/overview', true);
    await userEvent.click(screen.getByRole('button', { name: label('nav.groups.network') }));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('link', { name: label('nav.items.cloudpc') })).toBeInTheDocument();
  });

  it('puts the account menu at the top right and condenses the status to one sentence', () => {
    shell('super-admin');
    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('button', { name: new RegExp(label('header.accountMenu')) })).toBeInTheDocument();
    const status = within(banner).getByRole('group', { name: label('status.label') });
    expect(status).toHaveTextContent(label('status.inService', { reachable: 2, total: 3 }));
    // No throughput readings and no "none blocked" filler on a phone.
    expect(within(status).queryByLabelText(label('header.throughput'))).toBeNull();
  });

  it('has no accessibility violations in either theme', async () => {
    asUser('super-admin');
    stubLayout('phone');
    await expectAccessibleInBothThemes(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/nodes']}>
          <PhoneTopBar features={{ cloud_pc: false }} nodeCount={3} reachableCount={2} />
          <BottomTabBar features={{ cloud_pc: false }} nodeCount={3} />
        </MemoryRouter>
      </QueryClientProvider>
    );
  });
});

describe('tablet bar', () => {
  it('shows the four groups as a row of tabs under the wordmark and respects the role', () => {
    asUser('auditor');
    stubLayout('tablet');
    renderUI(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={['/acls']}>
          <TabletBar features={{ cloud_pc: false }} nodeCount={3} reachableCount={2} />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(tabs()).toEqual([label('nav.groups.network'), label('nav.groups.access'), label('nav.groups.security')]);
    expect(screen.getByRole('button', { name: label('nav.groups.access') })).toHaveAttribute('aria-current', 'true');
  });
});
