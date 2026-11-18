import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router';
import { ChevronDown } from 'lucide-react';

import { ROUTES } from '../routes/paths';
import type { NavGroupKey } from '../routes/navModel';
import { Disclosure, MENU_CONTENT, cn } from '../ui';
import { Logo } from '../ui/Logo';
import Header from './Header';
import { NavEntry } from './NavEntry';
import { StatusLine } from './StatusLine';
import type { TopBarProps } from './TopBar';
import { useShellNav } from './useShellNav';

// 44 px tall and as wide as the row allows: a tab is a touch target.
const TAB =
  'relative inline-flex h-11 w-full items-center justify-center gap-1 rounded-control px-2 text-body font-medium text-ink transition-colors hover:bg-surface-hover focus-visible:outline-focus';
// "You are here": the signal under the tab, outlined in ink so it holds 3:1.
const ACTIVE_MARK =
  'font-semibold after:absolute after:inset-x-3 after:-bottom-px after:h-[3px] after:rounded-pill after:bg-signal after:shadow-[0_0_0_1px_rgb(var(--color-ink))]';

/**
 * The shell's top at tablet width (768 to 1279 px): the wordmark and the account
 * row, then the four groups as a row of tabs, then the status line. The groups
 * open as menus sized for a finger (entries 44 px tall); Settings is a link.
 *
 * Same landmark, same labels and same role filter as the desktop top bar.
 */
export default function TabletBar({
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
  const { groups, showSettings, canSeeRisk, here, counts, alerts } = useShellNav({
    features,
    nodeCount,
    quarantinedCount,
    highRiskCount
  });

  return (
    <header
      data-shell-topbar=""
      data-shell-size="tablet"
      className="sticky top-0 z-sticky border-b border-rule bg-plate"
    >
      <div className="flex h-14 items-center gap-3 px-5">
        <Link
          to={ROUTES.overview}
          aria-label={t('nav.home')}
          className="flex min-h-11 shrink-0 items-center gap-2 rounded-control text-lead font-semibold text-ink focus-visible:outline-focus"
        >
          <Logo wordmark size="md" ground="plate" decorative />
        </Link>
        <div className="ml-auto min-w-0">
          <Header onOpenEnrollModal={onOpenEnrollModal} />
        </div>
      </div>

      <nav aria-label={t('nav.landmark')} className="border-t border-border-subtle px-3">
        <div className="flex items-stretch gap-1 py-1">
          {groups.map((group) => {
            const active = here?.group === group.key;
            return (
              <div key={group.key} className="min-w-0 flex-1">
                <Disclosure
                  triggerCurrent={active}
                  triggerClassName={cn(TAB, active && ACTIVE_MARK)}
                  trigger={
                    <>
                      {t(`nav.groups.${group.key as NavGroupKey}`)}
                      <ChevronDown aria-hidden="true" className="h-4 w-4 text-muted" />
                    </>
                  }
                  panelClassName={cn(MENU_CONTENT, 'min-w-64')}
                >
                  {group.items.map((item) => (
                    <NavEntry
                      key={item.id}
                      id={item.id}
                      current={here?.id === item.id}
                      count={counts[item.id]}
                      alert={alerts[item.id]}
                    />
                  ))}
                </Disclosure>
              </div>
            );
          })}

          {showSettings && (
            <div className="min-w-0 flex-1">
              <NavLink to={ROUTES.settings} className={({ isActive }) => cn(TAB, isActive && ACTIVE_MARK)}>
                {t('nav.items.settings')}
              </NavLink>
            </div>
          )}
        </div>
      </nav>

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
