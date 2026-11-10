import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import i18n from '../i18n';
import { renderUI } from '../test/harness';
import Sidebar from './Sidebar';

const auth = vi.hoisted(() => ({ user: null as unknown }));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: auth.user, role: null, isAuthenticated: true })
}));

const label = (key: string) => i18n.t(key, { ns: 'chrome' });

function escapeRe(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A link whose accessible name starts with the label; counts and badges may follow it. */
function link(name: string) {
  return screen.queryByRole('link', { name: new RegExp(`^${escapeRe(name)}`) });
}

function renderSidebar(role: string, options: { nukeArmed?: boolean } = {}) {
  auth.user = {
    id: 'u1',
    username: 'someone',
    role: role === 'super-admin' ? 'super-admin' : 'user',
    org_role: role === 'super-admin' ? null : role
  };
  return renderUI(
    <MemoryRouter>
      <Sidebar features={{ cloud_pc: false }} nodeCount={0} nukeArmed={options.nukeArmed ?? false} />
    </MemoryRouter>
  );
}

describe('Sidebar by role', () => {
  it('auditor sees overview, devices and activity log but not users, settings, data erasure, routes or peering', () => {
    renderSidebar('auditor');

    expect(link(label('nav.items.overview'))).not.toBeNull();
    expect(link(label('nav.items.nodes'))).not.toBeNull();
    expect(link(label('nav.items.audit'))).not.toBeNull();

    expect(link(label('nav.items.users'))).toBeNull();
    expect(link(label('nav.items.settings'))).toBeNull();
    expect(link(label('nav.items.nuke'))).toBeNull();
    expect(link(label('nav.items.onion'))).toBeNull();
    expect(link(label('nav.items.peering'))).toBeNull();
  });

  it('shows no badge text that promises a feature the console does not run', () => {
    renderSidebar('super-admin', { nukeArmed: true });

    const text = document.body.textContent ?? '';
    for (const badge of ['3-hop', 'Ed25519', 'WebRTC', '3-tier']) {
      expect(text).not.toContain(badge);
    }
  });

  it('uses no uppercase class anywhere in the navigation, including the armed block', () => {
    const { container } = renderSidebar('super-admin', { nukeArmed: true });

    expect(container.querySelectorAll('.uppercase')).toHaveLength(0);
  });

  it('shows the My devices link for every console role', () => {
    for (const role of ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user']) {
      const { unmount } = renderSidebar(role);
      expect(link(label('nav.items.me')), `My devices missing for ${role}`).not.toBeNull();
      unmount();
    }
  });
});
