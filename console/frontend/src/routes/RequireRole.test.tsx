import { screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../test/harness';
import { RequireRole, RoleLanding } from './RequireRole';

const auth = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, role: null, isAuthenticated: true })
}));

function renderAt(path: string, element: React.ReactElement) {
  return renderUI(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/nodes" element={element} />
        <Route path="/users" element={element} />
        <Route path="/me" element={<p>My devices page</p>} />
        <Route path="/overview" element={<p>Overview page</p>} />
        <Route path="/" element={<RoleLanding />} />
      </Routes>
    </MemoryRouter>
  );
}

const NODES = (
  <RequireRole page="nodes">
    <p>Devices page</p>
  </RequireRole>
);

const USERS = (
  <RequireRole page="users">
    <p>Users page</p>
  </RequireRole>
);

describe('RequireRole', () => {
  it('member on nodes is sent to /me', () => {
    auth.user = { id: 'u1', username: 'maria', role: 'user', org_role: 'member' };

    renderAt('/nodes', NODES);

    expect(screen.getByText('My devices page')).toBeInTheDocument();
    expect(screen.queryByText('Devices page')).toBeNull();
  });

  it('auditor on users sees the forbidden message', () => {
    auth.user = { id: 'u2', username: 'luca', role: 'user', org_role: 'auditor' };

    renderAt('/users', USERS);

    expect(screen.getByText('Your role cannot open this')).toBeInTheDocument();
    expect(screen.queryByText('Users page')).toBeNull();
  });

  it('admin on users sees the page', () => {
    auth.user = { id: 'u3', username: 'sara', role: 'user', org_role: 'admin' };

    renderAt('/users', USERS);

    expect(screen.getByText('Users page')).toBeInTheDocument();
  });
});

describe('RoleLanding', () => {
  it('sends a member to /me and an owner to /overview', () => {
    auth.user = { id: 'u4', username: 'anna', role: 'user', org_role: 'member' };
    const member = renderAt('/', NODES);
    expect(screen.getByText('My devices page')).toBeInTheDocument();
    member.unmount();

    auth.user = { id: 'u5', username: 'paolo', role: 'user', org_role: 'owner' };
    renderAt('/', NODES);
    expect(screen.getByText('Overview page')).toBeInTheDocument();
  });
});
