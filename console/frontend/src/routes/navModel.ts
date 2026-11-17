import { canSee, type ConsoleRole, type PageId, type RoleFeatures } from '../services/roles';
import { ROUTES, type RouteId } from './paths';

/**
 * The console's information architecture: four task groups in the top bar.
 *
 * Network, Access and Security are menus; Settings is a single link. The
 * overview is the wordmark's destination and sits outside the groups. A page
 * appears here only if `services/roles.ts` lets the role see it, so a role never
 * gets a menu entry for a page it cannot use. The compiler rejects a route that
 * has no page id, so a new page cannot join the navigation without its role
 * being decided there.
 */
export type NavGroupKey = 'network' | 'access' | 'security';

export interface NavEntry {
  id: RouteId;
}

export interface NavGroup {
  key: NavGroupKey;
  items: NavEntry[];
}

/** Every route id is a page id. */
const PAGE_OF: Record<RouteId, PageId> = {
  overview: 'overview',
  topology: 'topology',
  subnets: 'subnets',
  nodes: 'nodes',
  onion: 'onion',
  peering: 'peering',
  cloudpc: 'cloudpc',
  risk: 'risk',
  acls: 'acls',
  audit: 'audit',
  users: 'users',
  settings: 'settings',
  nuke: 'nuke',
  me: 'me',
  meAdd: 'meAdd',
  drop: 'drop',
  glossary: 'glossary'
};

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'network',
    // Cloud PC is listed here and shown only when its feature flag is on.
    items: [{ id: 'topology' }, { id: 'nodes' }, { id: 'subnets' }, { id: 'cloudpc' }]
  },
  {
    key: 'access',
    items: [{ id: 'acls' }, { id: 'users' }, { id: 'peering' }]
  },
  {
    key: 'security',
    items: [{ id: 'risk' }, { id: 'audit' }, { id: 'nuke' }, { id: 'onion' }]
  }
];

/** The groups with only the entries this role and these features allow; empty groups are dropped. */
export function visibleGroups(role: ConsoleRole | null, features?: RoleFeatures): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => canSee(PAGE_OF[item.id], role, features))
  })).filter((group) => group.items.length > 0);
}

export function canSeeRoute(id: RouteId, role: ConsoleRole | null, features?: RoleFeatures): boolean {
  return canSee(PAGE_OF[id], role, features);
}

function matches(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** The group and page a path belongs to, for the active marker and the breadcrumb. */
export function locate(pathname: string): { group: NavGroupKey | null; id: RouteId } | null {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (matches(pathname, ROUTES[item.id])) return { group: group.key, id: item.id };
    }
  }
  for (const id of ['overview', 'settings', 'glossary', 'me', 'drop'] as const) {
    if (matches(pathname, ROUTES[id])) return { group: null, id };
  }
  return null;
}
