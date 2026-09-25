/**
 * One address per page.
 *
 * The sidebar, the router and every in-console link read this map, so a page
 * cannot be reachable from the navigation under one address and from the router
 * under another. The keys are the identifiers the navigation and the `chrome`
 * translations already use.
 */
export const ROUTES = {
  overview: '/overview',
  topology: '/topology',
  nodes: '/nodes',
  onion: '/onion',
  peering: '/peering',
  cloudpc: '/cloudpc',
  risk: '/risk',
  acls: '/acls',
  audit: '/audit',
  users: '/users',
  settings: '/settings',
  nuke: '/nuke'
} as const;

export type RouteId = keyof typeof ROUTES;

export const LOGIN_PATH = '/login';
export const DEFAULT_PATH = ROUTES.overview;

export function nodePath(id: string): string {
  return `${ROUTES.nodes}/${encodeURIComponent(id)}`;
}

/**
 * Where to send an operator after they sign in.
 *
 * Kept in the query string rather than in storage: a sign-in that happened in
 * another tab must not decide where this one lands. Only a path on this origin
 * is accepted, so a crafted link cannot turn the sign-in form into an open
 * redirect.
 */
export const NEXT_PARAM = 'next';

export function safeNextPath(raw: string | null): string {
  if (!raw) return DEFAULT_PATH;
  if (!raw.startsWith('/') || raw.startsWith('//')) return DEFAULT_PATH;
  if (raw.startsWith(LOGIN_PATH)) return DEFAULT_PATH;
  return raw;
}
