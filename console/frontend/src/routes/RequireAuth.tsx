import { useTranslation } from 'react-i18next';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from '../context/AuthContext';
import { Skeleton } from '../ui';
import { LOGIN_PATH, NEXT_PARAM } from './paths';

/**
 * The gate in front of every page that is not the sign-in screen.
 *
 * The address the operator asked for is carried to the sign-in form and
 * restored afterwards, so a link to a node survives an expired session instead
 * of dropping its recipient on the overview.
 */
export function RequireAuth() {
  const { t } = useTranslation('chrome');
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen bg-surface p-6">
        <p className="sr-only" role="status">
          {t('page.loading')}
        </p>
        <Skeleton lines={6} />
      </div>
    );
  }

  if (!isAuthenticated) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`${LOGIN_PATH}?${NEXT_PARAM}=${encodeURIComponent(next)}`} replace />;
  }

  return <Outlet />;
}
