import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation } from 'react-router';
import { ChevronDown } from 'lucide-react';

import { useAuth } from '../context/AuthContext';
import { ROUTES, type RouteId } from '../routes/paths';
import { canSeeRoute, locate, visibleGroups, type NavGroupKey } from '../routes/navModel';
import { effectiveRole } from '../services/roles';
import type { Features } from '../services/types';
import { Disclosure, MENU_CONTENT, MENU_ITEM, cn } from '../ui';
import { Logo } from '../ui/Logo';
import Header from './Header';
import { StatusLine } from './StatusLine';

export interface TopBarProps {
  features: Features;
  nodeCount?: number;
  reachableCount?: number;
  quarantinedCount?: number;
  highRiskCount?: number;
  nukeArmed?: boolean;
  nukeScheduledAt?: string | null;
  onExecuteWipe?: () => void;
  onOpenEnrollModal?: () => void;
}

const TRIGGER =
  'relative inline-flex h-9 items-center gap-1 rounded-control px-3 text-body font-medium text-ink transition-colors hover:bg-surface-hover focus-visible:outline-focus';
// The marker for "you are here": the signal, outlined in ink so it holds 3:1.
const ACTIVE_MARK =
  'font-semibold after:absolute after:inset-x-3 after:-bottom-[7px] after:h-[3px] after:rounded-pill after:bg-signal after:shadow-[0_0_0_1px_rgb(var(--color-ink))]';

/**
 * The top bar: the wordmark, the four task groups, search, language, theme,
 * notifications and the account, and under them one line that says in words how
 * the network is doing. It replaces the left rail.
 *
 * It owns the banner and navigation landmarks. The groups are disclosure menus
 * (ui/Disclosure.tsx): Enter or Space opens one, the arrow keys move through
 * it, Escape closes it and returns focus to the group. What each role sees comes from
 * `routes/navModel.ts`, which reads `services/roles.ts`; the server still
 * refuses what it must.
 */
export default function TopBar({
  features,
  nodeCount = 0,
  reachableCount = 0,
  quarantinedCount = 0,
  highRiskCount = 0,
  nukeArmed = false,
  nukeScheduledAt = null,
  onExecuteWipe,
  onOpenEnrollModal
}: TopBarProps) {
  const { t } = useTranslation('chrome');
  const { user } = useAuth();
  const role = effectiveRole(user);
  const { pathname } = useLocation();
  const here = locate(pathname);

  const groups = visibleGroups(role, features);
  const showSettings = canSeeRoute('settings', role, features);
  const counts: Partial<Record<RouteId, number>> = { nodes: nodeCount };
  const alerts: Partial<Record<RouteId, number>> = { risk: highRiskCount, audit: quarantinedCount };

  const canSeeRisk = canSeeRoute('risk', role, features);

  return (
    <header data-shell-topbar className="sticky top-0 z-sticky border-b border-rule bg-plate">
      <div className="mx-auto flex h-14 w-full max-w-[1360px] items-center gap-4 px-6">
        <Link
          to={ROUTES.overview}
          aria-label={t('nav.home')}
          className="flex shrink-0 items-center gap-2 rounded-control text-lead font-semibold text-ink focus-visible:outline-focus"
        >
          <Logo wordmark size="md" ground="plate" decorative />
        </Link>

        <nav aria-label={t('nav.landmark')} className="flex items-center gap-1">
          {groups.map((group) => {
            const active = here?.group === group.key;
            return (
              <Disclosure
                key={group.key}
                triggerCurrent={active}
                triggerClassName={cn(TRIGGER, active && ACTIVE_MARK)}
                trigger={
                  <>
                    {t(`nav.groups.${group.key as NavGroupKey}`)}
                    <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
                  </>
                }
                panelClassName={MENU_CONTENT}
              >
                {group.items.map((item) => {
                  const count = counts[item.id];
                  const alert = alerts[item.id] ?? 0;
                  return (
                    <Link
                      key={item.id}
                      to={ROUTES[item.id]}
                      aria-current={here?.id === item.id ? 'page' : undefined}
                      className={MENU_ITEM}
                    >
                      <span className={cn('flex-1', here?.id === item.id && 'font-semibold')}>
                        {t(`nav.items.${item.id}`)}
                      </span>
                      {count !== undefined && <span className="text-caption tabular-nums text-muted">{count}</span>}
                      {alert > 0 && (
                        <span className="text-caption font-semibold tabular-nums text-ink">
                          {alert}
                          <span className="sr-only"> {t('nav.alertCount', { count: alert })}</span>
                        </span>
                      )}
                    </Link>
                  );
                })}
              </Disclosure>
            );
          })}

          {showSettings && (
            <NavLink to={ROUTES.settings} className={({ isActive }) => cn(TRIGGER, isActive && ACTIVE_MARK)}>
              {t('nav.items.settings')}
            </NavLink>
          )}
        </nav>

        <div className="ml-auto min-w-0">
          <Header onOpenEnrollModal={onOpenEnrollModal} />
        </div>
      </div>

      <StatusLine
        nodeCount={nodeCount}
        reachableCount={reachableCount}
        quarantinedCount={quarantinedCount}
        highRiskCount={highRiskCount}
        canSeeRisk={canSeeRisk}
        nukeArmed={nukeArmed}
        nukeScheduledAt={nukeScheduledAt}
        onExecuteWipe={onExecuteWipe}
      />
    </header>
  );
}
