import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoAxeViolations, renderUI } from '../test/harness';
import PortalLayout from './PortalLayout';

const auth = vi.hoisted(() => ({ user: null as unknown, logout: vi.fn(async () => undefined) }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, role: null, isAuthenticated: true, logout: auth.logout })
}));

const MEMBER = { id: 'u1', username: 'anna', role: 'user', org_role: 'member' };
const ADMIN = { id: 'u2', username: 'root', role: 'user', org_role: 'admin' };

function renderLayout(path = '/me', theme: 'light' | 'dark' = 'light') {
  return renderUI(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<PortalLayout />}>
          <Route path="/me" element={<h1>My devices page</h1>} />
          <Route path="/me/add" element={<h1>Add page</h1>} />
          <Route path="/drop" element={<h1>Send page</h1>} />
        </Route>
        <Route path="/login" element={<h1>Login page</h1>} />
      </Routes>
    </MemoryRouter>,
    { theme }
  );
}

afterEach(() => {
  auth.logout.mockClear();
});

describe('PortalLayout', () => {
  it('makes the wordmark a link home and offers the two places a member can go', () => {
    auth.user = MEMBER;
    renderLayout('/drop');

    expect(screen.getByRole('link', { name: 'NeroNet, my devices' })).toHaveAttribute('href', '/me');
    const nav = screen.getByRole('navigation', { name: 'Navigation' });
    expect(within(nav).getByRole('link', { name: 'My devices' })).toHaveAttribute('href', '/me');
    expect(within(nav).getByRole('link', { name: 'Send a file' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'My devices' })).not.toHaveAttribute('aria-current');
  });

  it('keeps "My devices" marked on the add page, which is part of it', () => {
    auth.user = MEMBER;
    renderLayout('/me/add');

    expect(screen.getByRole('link', { name: 'My devices' })).toHaveAttribute('aria-current', 'page');
  });

  it('puts language, theme and a labelled sign-out in the account menu', async () => {
    auth.user = MEMBER;
    renderLayout();
    const user = userEvent.setup();

    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Account: anna' }));

    expect(screen.getByRole('group', { name: 'Language' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    const signOut = screen.getByRole('button', { name: 'Sign out' });
    expect(signOut).toHaveTextContent('Sign out');
    expect(screen.queryByRole('link', { name: 'Admin console' })).toBeNull();

    await user.click(signOut);
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Login page')).toBeInTheDocument();
  });

  it('shows the way back to the console only to roles that have one', async () => {
    auth.user = ADMIN;
    renderLayout();

    await userEvent.click(screen.getByRole('button', { name: 'Account: root' }));

    expect(screen.getByRole('link', { name: 'Admin console' })).toHaveAttribute('href', '/overview');
  });

  it('is accessible in both themes, with the menu open', async () => {
    auth.user = ADMIN;
    for (const theme of ['light', 'dark'] as const) {
      const view = renderLayout('/me', theme);
      await userEvent.click(screen.getByRole('button', { name: 'Account: root' }));
      await expectNoAxeViolations(view.container, theme);
      view.unmount();
    }
  });
});
