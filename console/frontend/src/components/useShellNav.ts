import { useLocation } from 'react-router';

import { useAuth } from '../context/AuthContext';
import type { RouteId } from '../routes/paths';
import { canSeeRoute, locate, visibleGroups } from '../routes/navModel';
import { effectiveRole } from '../services/roles';
import type { Features } from '../services/types';

export interface ShellNavInput {
  features: Features;
  nodeCount: number;
  quarantinedCount: number;
  highRiskCount: number;
}

/**
 * What the tablet bar and the phone's tab bar draw: the groups this role may see,
 * whether it sees Settings, where the address is, and the counts that sit next to
 * entries. It asks `routes/navModel.ts`, which asks `services/roles.ts`, exactly
 * as the desktop top bar does, so no size can show a page the role cannot use.
 */
export function useShellNav({ features, nodeCount, quarantinedCount, highRiskCount }: ShellNavInput) {
  const { user } = useAuth();
  const role = effectiveRole(user);
  const { pathname } = useLocation();

  const counts: Partial<Record<RouteId, number>> = { nodes: nodeCount };
  const alerts: Partial<Record<RouteId, number>> = { risk: highRiskCount, audit: quarantinedCount };

  return {
    groups: visibleGroups(role, features),
    showSettings: canSeeRoute('settings', role, features),
    canSeeRisk: canSeeRoute('risk', role, features),
    here: locate(pathname),
    counts,
    alerts
  };
}
