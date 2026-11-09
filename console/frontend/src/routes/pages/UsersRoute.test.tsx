import { QueryClientProvider } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expectNoAxeViolations, renderUI } from '../../test/harness';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import UsersRoute from './UsersRoute';
import { ShellProvider } from '../shell';
import { createQueryClient } from '../../services/queries/client';
import type { Organization, UserAccount } from '../../services/types';
import '../../i18n';

const initialMockUsers: UserAccount[] = [
  {
    id: 'usr-admin-1',
    username: 'secops_admin',
    email: 'secops@sovereign.local',
    role: 'super-admin',
    status: 'active',
    bypass_apps: ['com.apple.Music', 'com.spotify.client'],
    organization_id: 'org-default',
    created_at: '2026-09-01T10:00:00.000Z'
  },
  {
    id: 'usr-node-ops',
    username: 'mesh_operator',
    email: 'ops@sovereign.local',
    role: 'operator',
    status: 'active',
    bypass_apps: [],
    organization_id: 'org-default',
    created_at: '2026-09-05T12:00:00.000Z'
  },
  {
    id: 'usr-compliance',
    username: 'auditor_bob',
    email: 'auditor@sovereign.local',
    role: 'auditor',
    status: 'active',
    bypass_apps: ['zoom.us.Zoom'],
    organization_id: 'org-default',
    created_at: '2026-09-10T08:00:00.000Z'
  }
];

const initialMockOrgs: Organization[] = [
  {
    id: 'org-default',
    name: 'Sovereign Core HQ',
    slug: 'sovereign-core',
    default_policy: 'open',
    max_netmap_staleness_seconds: 60,
    created_at: '2026-09-01T00:00:00.000Z'
  },
  {
    id: 'org-classified',
    name: 'Classified Perimeter',
    slug: 'classified-perimeter',
    default_policy: 'deny',
    max_netmap_staleness_seconds: 15,
    created_at: '2026-09-15T00:00:00.000Z'
  }
];

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

/** Indexes into a query result, failing loudly instead of clicking `undefined`. */
function nth<T>(items: T[], index: number): T {
  const item = items[index];
  if (!item) throw new Error(`expected an element at index ${index}, found ${items.length}`);
  return item;
}

function renderUsers(initialEntries = ['/users']) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { retry: false, refetchOnWindowFocus: false }
  });

  return renderUI(
    <QueryClientProvider client={queryClient}>
      <ShellProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <Routes>
            <Route path="/users" element={<UsersRoute />} />
          </Routes>
        </MemoryRouter>
      </ShellProvider>
    </QueryClientProvider>
  );
}

describe('WP-410: UsersRoute (Role-Based Access Control, Organizations & Client Profiles)', () => {
  let usersState: UserAccount[] = [];
  let orgsState: Organization[] = [];

  beforeEach(() => {
    usersState = JSON.parse(JSON.stringify(initialMockUsers));
    orgsState = JSON.parse(JSON.stringify(initialMockOrgs));

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const method = init?.method?.toUpperCase() || 'GET';

        // 1. GET /api/users
        if (
          url.includes('/api/users') &&
          !url.includes('/onboard-qr') &&
          !url.includes('/split-tunneling') &&
          !url.includes('/revoke-sessions') &&
          method === 'GET'
        ) {
          return jsonResponse({ users: usersState });
        }

        // 2. POST /api/users
        if (url.includes('/api/users') && method === 'POST') {
          const body = JSON.parse((init?.body as string) || '{}');
          const newUser: UserAccount = {
            id: `usr-test-${Date.now()}`,
            username: body.username,
            email: body.email || `${body.username}@sovereign.local`,
            role: body.role || 'user',
            status: 'active',
            bypass_apps: body.bypass_apps || [],
            organization_id: body.organization_id || 'org-default',
            created_at: new Date().toISOString()
          };
          usersState.push(newUser);
          return jsonResponse({ user: newUser }, 201);
        }

        // 3. DELETE /api/users/:id
        if (url.match(/\/api\/users\/usr-[^/]+$/) && method === 'DELETE') {
          const idMatch = url.match(/\/api\/users\/(usr-[^/]+)$/);
          if (idMatch) {
            usersState = usersState.filter((u) => u.id !== idMatch[1]);
          }
          return jsonResponse({ ok: true });
        }

        // 4. POST /api/users/:id/revoke-sessions
        if (url.includes('/revoke-sessions') && method === 'POST') {
          return jsonResponse({ ok: true, revoked_count: 3 });
        }

        // 5. GET /api/users/:id/onboard-qr: the control plane has no per-user profile.
        if (url.includes('/onboard-qr') && method === 'GET') {
          return jsonResponse(
            {
              error: 'not_implemented',
              message:
                'Per-user onboarding profiles are not available. Enrol a device with a pre-auth key from Nodes → Enroll Node.'
            },
            501
          );
        }

        // 6. PUT /api/users/:id/split-tunneling
        if (url.includes('/split-tunneling') && method === 'PUT') {
          const body = JSON.parse((init?.body as string) || '{}');
          const idMatch = url.match(/\/api\/users\/([^/]+)\/split-tunneling/);
          const targetUser = usersState.find((u) => u.id === idMatch?.[1]);
          if (targetUser) {
            targetUser.bypass_apps = body.bypass_apps || [];
          }
          return jsonResponse({ user: targetUser });
        }

        // 7. GET /api/organizations
        if (url.includes('/api/organizations') && method === 'GET') {
          return jsonResponse({ organizations: orgsState });
        }

        // 8. POST /api/organizations
        if (url.includes('/api/organizations') && method === 'POST') {
          const body = JSON.parse((init?.body as string) || '{}');
          const newOrg: Organization = {
            id: `org-test-${Date.now()}`,
            name: body.name,
            slug: body.slug,
            default_policy: body.default_policy || 'open',
            max_netmap_staleness_seconds: body.max_netmap_staleness_seconds || 60,
            created_at: new Date().toISOString()
          };
          orgsState.push(newOrg);
          return jsonResponse({ organization: newOrg }, 201);
        }

        return jsonResponse({ ok: true });
      })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Renders stat cards, user directory table, and passes axe-core accessibility with 0 violations', async () => {
    const { container } = renderUsers();

    // Verify stat cards
    await waitFor(() => {
      expect(screen.getByText('secops_admin')).toBeInTheDocument();
    });

    expect(screen.getByText('mesh_operator')).toBeInTheDocument();
    expect(screen.getByText('auditor_bob')).toBeInTheDocument();

    // Verify accessibility in light theme
    await expectNoAxeViolations(container);

    // Verify accessibility in dark theme
    document.documentElement.setAttribute('data-theme', 'dark');
    await expectNoAxeViolations(container);
    document.documentElement.removeAttribute('data-theme');
  });

  it('2. Provisions a new tenant user via the modal dialog', async () => {
    const user = userEvent.setup();
    renderUsers();

    await waitFor(() => {
      expect(screen.getByText('secops_admin')).toBeInTheDocument();
    });

    // Click "Provision User" button
    const provisionBtn = screen.getByRole('button', { name: /provision user|crea utente/i });
    await user.click(provisionBtn);

    // Dialog title should appear
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    // Fill username
    const usernameInput = screen.getByPlaceholderText(/operator_alpha/i);
    await user.type(usernameInput, 'new_field_operator');

    // Fill email
    const emailInput = screen.getByPlaceholderText(/operator@sovereign.local/i);
    await user.type(emailInput, 'new_field_operator@acme.corp');

    // Submit
    const submitBtn = screen.getByRole('button', { name: /create user|crea utente/i });
    await user.click(submitBtn);

    // Wait for new user to appear in table
    await waitFor(() => {
      expect(screen.getByText('new_field_operator')).toBeInTheDocument();
    });
  });

  // The page used to fall back, on any error, to a WireGuard profile it made up (a
  // fixed address, a public key and an endpoint that exist nowhere) and offered it to
  // copy and download. A device configured from it reaches nothing.
  it('3. Says per-user onboarding profiles are unavailable and invents none', async () => {
    const user = userEvent.setup();
    renderUsers();

    await waitFor(() => {
      expect(screen.getByText('secops_admin')).toBeInTheDocument();
    });

    const qrButtons = screen.getAllByRole('button', { name: /onboarding qr|qr onboarding/i });
    await user.click(nth(qrButtons, 0));

    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/pre-auth key/i);
    expect(dialog).not.toHaveTextContent(
      /vpn\.sovereign\.mesh|4gC5z7y2M3oN9rPt8xV1wK0jL5qS6uI3dF2hB1eA4gA=|10\.42\.100\./
    );
    expect(within(dialog).queryByRole('img', { name: /qr code/i })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /copy config|copia configurazione/i })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /download \.conf|scarica \.conf/i })).toBeDisabled();
  });

  it('4. Updates split tunneling app bypass rules for a user', async () => {
    const user = userEvent.setup();
    renderUsers();

    await waitFor(() => {
      expect(screen.getByText('secops_admin')).toBeInTheDocument();
    });

    // Click split tunnel button
    const splitButtons = screen.getAllByRole('button', { name: /split tunnel/i });
    await user.click(nth(splitButtons, 0));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Split Tunneling App Bypass/i)).toBeInTheDocument();

    // Add preset app
    const presetBtn = screen.getByRole('button', { name: /zoom\.us\.Zoom/i });
    await user.click(presetBtn);

    // Save
    const saveBtn = screen.getByRole('button', { name: /save changes|salva modifiche/i });
    await user.click(saveBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('5. Revokes all active sessions for a user', async () => {
    const user = userEvent.setup();
    renderUsers();

    await waitFor(() => {
      expect(screen.getByText('mesh_operator')).toBeInTheDocument();
    });

    // Click revoke button
    const revokeButtons = screen.getAllByRole('button', { name: /revoke sessions|revoca sessioni/i });
    await user.click(nth(revokeButtons, 1));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Revoke All User Sessions/i)).toBeInTheDocument();

    // Confirm revoke
    const confirmBtn = screen.getByRole('button', { name: /revoke all sessions|revoca tutte le sessioni/i });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('6. Deletes a user account', async () => {
    const user = userEvent.setup();
    renderUsers();

    await waitFor(() => {
      expect(screen.getByText('auditor_bob')).toBeInTheDocument();
    });

    // Click delete button
    const deleteButtons = screen.getAllByRole('button', { name: /delete user|elimina utente/i });
    await user.click(nth(deleteButtons, 2));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/Delete User Account/i)).toBeInTheDocument();

    // Confirm delete
    const confirmBtn = screen.getByRole('button', { name: /delete account|elimina account/i });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(screen.queryByText('auditor_bob')).not.toBeInTheDocument();
    });
  });

  it('7. Renders organizations tab and creates a new organization', async () => {
    const user = userEvent.setup();
    renderUsers();

    await waitFor(() => {
      expect(screen.getByText('secops_admin')).toBeInTheDocument();
    });

    // Switch to Organizations tab
    const orgsTab = screen.getByRole('tab', { name: /organizations|organizzazioni/i });
    await user.click(orgsTab);

    expect(await screen.findByText('Sovereign Core HQ')).toBeInTheDocument();
    expect(screen.getByText('Classified Perimeter')).toBeInTheDocument();

    // Click "New Organization" button
    const newOrgBtn = screen.getByRole('button', { name: /new organization|nuova organizzazione/i });
    await user.click(newOrgBtn);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    // Fill name
    const nameInput = screen.getByPlaceholderText(/Acme Defense Cyber/i);
    await user.type(nameInput, 'Galactic Defense Alliance');

    // Submit
    const submitBtn = screen.getByRole('button', { name: /create organization|crea organizzazione/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Galactic Defense Alliance')).toBeInTheDocument();
    });
  });
});
