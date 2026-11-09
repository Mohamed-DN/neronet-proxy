import { Navigate } from 'react-router-dom';

import { useAuth } from '../context/AuthContext';
import { ApiError } from '../services/apiClient';
import { canSee, effectiveRole, landingPath, roleTier, type PageId, type RoleFeatures } from '../services/roles';
import { ErrorState } from '../ui/States';
import { PageFrame } from './PageFrame';

interface RequireRoleProps {
  page: PageId;
  features?: RoleFeatures;
  children: React.ReactNode;
}

/**
 * Lets the page render only for a role the access table allows. A `self` role
 * is sent to its own devices; any other role that is refused sees the forbidden
 * state, not an empty page. Hiding a link is not enough on its own: the route
 * itself must refuse, so a typed address cannot open a page the role lacks.
 */
export function RequireRole({ page, features, children }: RequireRoleProps) {
  const { user } = useAuth();
  const role = effectiveRole(user);

  if (canSee(page, role, features)) return <>{children}</>;
  if (roleTier(role) === 'self') return <Navigate to="/me" replace />;

  return (
    <PageFrame>
      <ErrorState error={new ApiError('forbidden', 403)} />
    </PageFrame>
  );
}

/** The index route: each role lands on the page its tier starts from. */
export function RoleLanding() {
  const { user } = useAuth();
  return <Navigate to={landingPath(effectiveRole(user))} replace />;
}
