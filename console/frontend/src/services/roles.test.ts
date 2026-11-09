import { describe, expect, it } from 'vitest';

import {
  ACCESS,
  canAddAgentDevice,
  canChooseGateway,
  canSee,
  effectiveRole,
  landingPath,
  roleTier,
  type ConsoleRole,
  type PageId
} from './roles';

/* The access table from the plan's "Role model" section, one row per page.
 * Column order: super-admin, owner, admin, network_admin, auditor, member, user. */
const ROLE_ORDER: ConsoleRole[] = ['super-admin', 'owner', 'admin', 'network_admin', 'auditor', 'member', 'user'];

const MATRIX: Record<PageId, number[]> = {
  overview: [1, 1, 1, 1, 1, 0, 0],
  topology: [1, 1, 1, 1, 1, 0, 0],
  subnets: [1, 1, 1, 1, 1, 0, 0],
  nodes: [1, 1, 1, 1, 1, 0, 0],
  risk: [1, 1, 1, 1, 1, 0, 0],
  acls: [1, 1, 1, 1, 1, 0, 0],
  onion: [1, 1, 1, 1, 0, 0, 0],
  audit: [1, 1, 1, 0, 1, 0, 0],
  users: [1, 1, 1, 0, 0, 0, 0],
  settings: [1, 1, 1, 0, 0, 0, 0],
  cloudpc: [1, 1, 1, 0, 0, 0, 0],
  nuke: [1, 1, 0, 0, 0, 0, 0],
  peering: [1, 0, 0, 0, 0, 0, 0],
  me: [1, 1, 1, 1, 1, 1, 1],
  meAdd: [1, 1, 1, 1, 1, 1, 1],
  glossary: [1, 1, 1, 1, 1, 1, 1]
};

describe('effectiveRole', () => {
  it.each([
    [{ role: 'user', org_role: 'owner' }, 'owner'],
    [{ role: 'super-admin', org_role: 'member' }, 'super-admin'],
    [{ role: 'owner', org_role: null }, 'owner'],
    [{ role: 'user', org_role: null }, 'user'],
    [{ role: 'admin', org_role: 'auditor' }, 'auditor'],
    [null, null]
  ] as const)('maps %j to %s', (user, expected) => {
    expect(effectiveRole(user as never)).toBe(expected);
  });

  it('unknown role maps to user, the least privilege', () => {
    expect(effectiveRole({ role: 'operator', org_role: null })).toBe('user');
    expect(effectiveRole({ role: 'user', org_role: 'operator' })).toBe('user');
  });
});

describe('access table', () => {
  it('canSee matches the plan table for every role and page', () => {
    for (const page of Object.keys(MATRIX) as PageId[]) {
      ROLE_ORDER.forEach((role, i) => {
        expect(canSee(page, role, { cloud_pc: true }), `${page} for ${role}`).toBe(MATRIX[page][i] === 1);
      });
    }
  });

  it('cloudpc needs the feature flag as well as the role', () => {
    expect(canSee('cloudpc', 'admin')).toBe(false);
    expect(canSee('cloudpc', 'admin', { cloud_pc: true })).toBe(true);
  });

  it('every page id in ACCESS has a row', () => {
    expect(Object.keys(ACCESS).sort()).toEqual(Object.keys(MATRIX).sort());
  });
});

describe('roleTier', () => {
  it('maps each role to its tier', () => {
    expect(roleTier('super-admin')).toBe('platform');
    expect(roleTier('owner')).toBe('manage');
    expect(roleTier('admin')).toBe('manage');
    expect(roleTier('network_admin')).toBe('network');
    expect(roleTier('auditor')).toBe('read');
    expect(roleTier('member')).toBe('self');
    expect(roleTier('user')).toBe('self');
    expect(roleTier(null)).toBe('self');
  });
});

describe('landingPath', () => {
  it('sends member and user to /me', () => {
    expect(landingPath('member')).toBe('/me');
    expect(landingPath('user')).toBe('/me');
    expect(landingPath(null)).toBe('/me');
  });

  it('sends every other role to /overview', () => {
    for (const role of ['super-admin', 'owner', 'admin', 'network_admin', 'auditor'] as const) {
      expect(landingPath(role)).toBe('/overview');
    }
  });
});

describe('agent keys and gateway', () => {
  it('only the four managing roles may add an agent device', () => {
    expect(canAddAgentDevice('super-admin')).toBe(true);
    expect(canAddAgentDevice('owner')).toBe(true);
    expect(canAddAgentDevice('admin')).toBe(true);
    expect(canAddAgentDevice('network_admin')).toBe(true);
    expect(canAddAgentDevice('auditor')).toBe(false);
    expect(canAddAgentDevice('member')).toBe(false);
    expect(canAddAgentDevice('user')).toBe(false);
  });

  it('the gateway card follows users.role, not the organisation role', () => {
    expect(canChooseGateway({ role: 'super-admin' })).toBe(true);
    expect(canChooseGateway({ role: 'admin' })).toBe(true);
    expect(canChooseGateway({ role: 'user', org_role: 'owner' })).toBe(false);
    expect(canChooseGateway({ role: 'owner' })).toBe(false);
    expect(canChooseGateway(null)).toBe(false);
  });
});
