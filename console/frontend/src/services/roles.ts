/**
 * The console's role model, aligned with the backend. The server authorises a
 * request with `req.user.org_role || req.user.role` (middleware/rbac.js), so
 * this file reads the same two fields and maps them onto the console's roles.
 *
 * These functions only decide what the console shows. Every page still handles
 * a refused request itself, because the server is the authority.
 */

export type ConsoleRole = 'super-admin' | 'owner' | 'admin' | 'network_admin' | 'auditor' | 'member' | 'user';

/** What a role may do, grouped. `self` roles see only their own devices. */
export type RoleTier = 'platform' | 'manage' | 'network' | 'read' | 'self';

export type PageId =
  | 'overview'
  | 'topology'
  | 'subnets'
  | 'nodes'
  | 'onion'
  | 'peering'
  | 'cloudpc'
  | 'risk'
  | 'acls'
  | 'audit'
  | 'users'
  | 'settings'
  | 'nuke'
  | 'me'
  | 'meAdd'
  | 'glossary';

export interface RoleFeatures {
  cloud_pc?: boolean;
}

const CONSOLE_ROLES: readonly ConsoleRole[] = [
  'super-admin',
  'owner',
  'admin',
  'network_admin',
  'auditor',
  'member',
  'user'
];

const MANAGERS: readonly ConsoleRole[] = ['super-admin', 'owner', 'admin'];
const EVERYONE: readonly ConsoleRole[] = CONSOLE_ROLES;

/** Which roles see each page. Mirrors the access table in the plan (Role model). */
export const ACCESS: Record<PageId, readonly ConsoleRole[]> = {
  overview: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor'],
  topology: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor'],
  subnets: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor'],
  nodes: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor'],
  risk: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor'],
  acls: ['super-admin', 'owner', 'admin', 'network_admin', 'auditor'],
  onion: ['super-admin', 'owner', 'admin', 'network_admin'],
  audit: ['super-admin', 'owner', 'admin', 'auditor'],
  users: MANAGERS,
  settings: MANAGERS,
  cloudpc: MANAGERS,
  nuke: ['super-admin', 'owner'],
  peering: ['super-admin'],
  me: EVERYONE,
  meAdd: EVERYONE,
  glossary: EVERYONE
};

function isConsoleRole(value: unknown): value is ConsoleRole {
  return typeof value === 'string' && (CONSOLE_ROLES as readonly string[]).includes(value);
}

export interface RoleUser {
  role?: string | null;
  org_role?: string | null;
}

/**
 * The role the console acts on. A platform administrator stays that role in
 * every organisation. Otherwise the organisation role wins, and a role the
 * console does not know becomes `user`, the least privilege.
 */
export function effectiveRole(user: RoleUser | null): ConsoleRole | null {
  if (!user) return null;
  if (user.role === 'super-admin') return 'super-admin';
  const raw = user.org_role ?? user.role ?? 'user';
  return isConsoleRole(raw) ? raw : 'user';
}

export function roleTier(role: ConsoleRole | null): RoleTier {
  switch (role) {
    case 'super-admin':
      return 'platform';
    case 'owner':
    case 'admin':
      return 'manage';
    case 'network_admin':
      return 'network';
    case 'auditor':
      return 'read';
    default:
      return 'self';
  }
}

export function canSee(page: PageId, role: ConsoleRole | null, features?: RoleFeatures): boolean {
  if (page === 'cloudpc' && !features?.cloud_pc) return false;
  return ACCESS[page].includes(role ?? 'user');
}

/** A `self` role lands on its own devices; everyone else on the overview. */
export function landingPath(role: ConsoleRole | null): '/me' | '/overview' {
  return roleTier(role) === 'self' ? '/me' : '/overview';
}

/** The agent registration key is offered to the roles that the server lets create one. */
export function canAddAgentDevice(role: ConsoleRole | null): boolean {
  return role === 'super-admin' || role === 'owner' || role === 'admin' || role === 'network_admin';
}

/**
 * The settings gateway card checks `users.role` on the server, not the
 * organisation role (routes/devices.js), so the console checks the same field.
 */
export function canChooseGateway(user: RoleUser | null): boolean {
  return user?.role === 'super-admin' || user?.role === 'admin';
}

/** The organisation roles a person can be invited into, highest first. Owner never is. */
export type InvitableRole = 'admin' | 'network_admin' | 'auditor' | 'member';
const INVITABLE: readonly InvitableRole[] = ['admin', 'network_admin', 'auditor', 'member'];

/**
 * Which roles this role may invite someone into. The server's rule is "at or below
 * your own" (routes/invitations.js); only owners, admins and the platform
 * administrator invite at all, and all three sit at or above admin.
 */
export function invitableRoles(role: ConsoleRole | null): InvitableRole[] {
  return role === 'super-admin' || role === 'owner' || role === 'admin' ? [...INVITABLE] : [];
}
