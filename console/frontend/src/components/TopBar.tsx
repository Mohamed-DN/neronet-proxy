import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink, useLocation } from 'react-router';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, Skull } from 'lucide-react';

import { useAuth } from '../context/AuthContext';
import { ROUTES, type RouteId } from '../routes/paths';
import { canSeeRoute, locate, visibleGroups, type NavGroupKey } from '../routes/navModel';
import { useStatsOverview } from '../services/queries';
import { effectiveRole } from '../services/roles';
import type { Features } from '../services/types';
import { Disclosure, MENU_CONTENT, MENU_ITEM, NotMeasured, StationSymbol, cn } from '../ui';
import { Logo } from '../ui/Logo';
import Header from './Header';

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

function useCountdown(armed: boolean, scheduledAt: string | null): string {
  const { t } = useTranslation('chrome');
  const [remaining, setRemaining] = useState('');

  useEffect(() => {
    if (!armed && !scheduledAt) return;

    const update = () => {
      if (scheduledAt) {
        const diff = new Date(scheduledAt).getTime() - Date.now();
        if (diff <= 0) {
          setRemaining(t('status.triggered'));
        } else {
          const hours = Math.floor(diff / (1000 * 60 * 60));
          const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
          const secs = Math.floor((diff % (1000 * 60)) / 1000);
          setRemaining(
            `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
          );
        }
      } else if (armed) {
        setRemaining(t('status.erasureArmedInstant'));
      }
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [armed, scheduledAt, t]);

  return remaining;
}

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
  const remaining = useCountdown(nukeArmed, nukeScheduledAt);

  // The rate is null until the collector has two samples to derive it from, and
  // the bar says "not measured" then rather than a zero.
  const overview = useStatsOverview();
  const stats = overview.status === 'success' ? overview.data : null;
  const rate = (value: number | null | undefined) =>
    typeof value === 'number' ? <span className="font-medium tabular-nums">{value} MiB/s</span> : <NotMeasured />;

  const groups = visibleGroups(role, features);
  const showSettings = canSeeRoute('settings', role, features);
  const counts: Partial<Record<RouteId, number>> = { nodes: nodeCount };
  const alerts: Partial<Record<RouteId, number>> = { risk: highRiskCount, audit: quarantinedCount };

  const armed = nukeArmed || Boolean(nukeScheduledAt);
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

      {/* One line, in words, that says how the network is doing: the same
          statuses the map will draw as stations. */}
      <div role="group" aria-label={t('status.label')} className="border-t border-border-subtle bg-sheet">
        <div className="mx-auto flex min-h-9 w-full max-w-[1360px] flex-wrap items-center gap-x-5 gap-y-1 px-6 py-1 text-caption text-muted">
          {armed && (
            <span className="flex items-center gap-2 rounded-control border border-danger bg-danger/10 py-0.5 pl-2 pr-0.5 text-danger">
              <Skull aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="font-semibold">{t('status.erasureArmed')}</span>
              <span className="tabular-nums">{remaining}</span>
              <button
                type="button"
                onClick={onExecuteWipe}
                className="rounded-control bg-danger px-2 py-0.5 font-semibold text-danger-contrast transition-colors hover:bg-danger-strong focus-visible:outline-focus"
              >
                {t('status.eraseNow')}
              </button>
            </span>
          )}

          <span className="flex items-center gap-1.5 text-content">
            <StationSymbol kind="service" size={14} className="text-success" />
            {nodeCount === 0
              ? t('status.noDevices')
              : t('status.inService', { reachable: reachableCount, total: nodeCount })}
          </span>

          {quarantinedCount > 0 ? (
            <Link
              to={ROUTES.nodes}
              className="flex items-center gap-1.5 rounded-control font-medium text-danger underline focus-visible:outline-focus"
            >
              <StationSymbol kind="blocked" size={14} />
              {t('status.blocked', { count: quarantinedCount })}
            </Link>
          ) : (
            <span>{t('status.noneBlocked')}</span>
          )}

          {highRiskCount > 0 && canSeeRisk && (
            <Link
              to={ROUTES.risk}
              className="rounded-control font-medium text-warning underline focus-visible:outline-focus"
            >
              {t('status.highRisk', { count: highRiskCount })}
            </Link>
          )}

          <span aria-label={t('header.throughput')} className="ml-auto hidden items-center gap-4 text-content lg:flex">
            <span className="flex items-center gap-1.5">
              <ArrowDownLeft aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
              <span className="text-muted">{t('header.rx')}:</span>
              {rate(stats?.total_bandwidth_rx_mb_s)}
            </span>
            <span className="flex items-center gap-1.5">
              <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
              <span className="text-muted">{t('header.tx')}:</span>
              {rate(stats?.total_bandwidth_tx_mb_s)}
            </span>
          </span>
        </div>
      </div>
    </header>
  );
}
