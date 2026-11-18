import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router';
import { Network, Settings, ShieldCheck, KeyRound, type LucideIcon } from 'lucide-react';

import { ROUTES } from '../routes/paths';
import type { NavGroupKey } from '../routes/navModel';
import { BottomSheet, cn } from '../ui';
import { Logo } from '../ui/Logo';
import { AccountMenu } from './Header';
import { NavEntry } from './NavEntry';
import { StatusLine } from './StatusLine';
import type { TopBarProps } from './TopBar';
import { useShellNav } from './useShellNav';

const GROUP_ICON: Record<NavGroupKey, LucideIcon> = {
  network: Network,
  access: KeyRound,
  security: ShieldCheck
};

/** The tab bar's height without the safe area; the shell reserves this much under the page. */
export const TAB_BAR_HEIGHT = '3.5rem';

const TAB =
  'relative flex h-14 w-full flex-col items-center justify-center gap-0.5 px-1 text-caption text-ink-muted transition-colors focus-visible:outline-focus';
// "You are here": a signal bar on the tab's top edge, outlined in ink so it holds 3:1.
const ACTIVE_MARK =
  'font-semibold text-ink after:absolute after:inset-x-4 after:top-0 after:h-[3px] after:rounded-b-pill after:bg-signal after:shadow-[0_0_0_1px_rgb(var(--color-ink))]';

/**
 * The shell's top on a phone: the wordmark, the account menu at the right, and
 * one condensed sentence of status. Search, notifications and the group menus
 * are not here; the groups are in the tab bar under the thumb.
 */
export function PhoneTopBar({
  nodeCount = 0,
  reachableCount = 0,
  quarantinedCount = 0,
  highRiskCount = 0,
  nukeArmed = false,
  nukeScheduledAt = null,
  onExecuteWipe,
  features
}: TopBarProps) {
  const { t } = useTranslation('chrome');
  const { canSeeRisk } = useShellNav({ features, nodeCount, quarantinedCount, highRiskCount });

  return (
    <header
      data-shell-topbar=""
      data-shell-size="phone"
      className="sticky top-0 z-sticky border-b border-rule bg-plate"
    >
      <div className="flex h-12 items-center justify-between gap-3 px-4">
        <Link
          to={ROUTES.overview}
          aria-label={t('nav.home')}
          className="flex min-h-11 shrink-0 items-center gap-2 rounded-control text-lead font-semibold text-ink focus-visible:outline-focus"
        >
          <Logo wordmark size="md" ground="plate" decorative />
        </Link>
        <AccountMenu />
      </div>
      <StatusLine
        condensed
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

/**
 * The four groups at the bottom of a phone, icon and word each: Network, Access
 * and Security open a sheet with their pages, Settings is a link. What a role sees
 * comes from `routes/navModel.ts`, as in the top bar. The bar clears the home
 * indicator with the safe-area inset.
 */
export function BottomTabBar({
  features,
  nodeCount = 0,
  quarantinedCount = 0,
  highRiskCount = 0
}: Pick<TopBarProps, 'features' | 'nodeCount' | 'quarantinedCount' | 'highRiskCount'>) {
  const { t } = useTranslation('chrome');
  const [openGroup, setOpenGroup] = useState<NavGroupKey | null>(null);
  const { groups, showSettings, here, counts, alerts } = useShellNav({
    features,
    nodeCount: nodeCount ?? 0,
    quarantinedCount,
    highRiskCount
  });
  const sheet = groups.find((group) => group.key === openGroup);

  return (
    <>
      <nav
        aria-label={t('nav.landmark')}
        data-bottom-tabs=""
        className="fixed inset-x-0 bottom-0 z-sticky border-t border-rule bg-plate pb-[env(safe-area-inset-bottom)]"
      >
        {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
        <ul role="list" className="flex">
          {groups.map((group) => {
            const Icon = GROUP_ICON[group.key];
            const active = here?.group === group.key;
            return (
              <li key={group.key} className="min-w-0 flex-1">
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={openGroup === group.key}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setOpenGroup(group.key)}
                  className={cn(TAB, active && ACTIVE_MARK)}
                >
                  <Icon aria-hidden="true" className="h-5 w-5" />
                  <span className="max-w-full truncate">{t(`nav.groups.${group.key}`)}</span>
                </button>
              </li>
            );
          })}

          {showSettings && (
            <li className="min-w-0 flex-1">
              <NavLink to={ROUTES.settings} className={({ isActive }) => cn(TAB, isActive && ACTIVE_MARK)}>
                <Settings aria-hidden="true" className="h-5 w-5" />
                <span className="max-w-full truncate">{t('nav.items.settings')}</span>
              </NavLink>
            </li>
          )}
        </ul>
      </nav>

      <BottomSheet
        open={sheet !== undefined}
        onOpenChange={(open) => {
          if (!open) setOpenGroup(null);
        }}
        title={sheet ? t(`nav.groups.${sheet.key}`) : ''}
      >
        {/* Choosing a page closes the sheet; the page moves focus to its own heading. */}
        {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
        <ul role="list">
          {sheet?.items.map((item) => (
            <li key={item.id}>
              <NavEntry
                id={item.id}
                current={here?.id === item.id}
                count={counts[item.id]}
                alert={alerts[item.id]}
                className="min-h-12"
                onNavigate={() => setOpenGroup(null)}
              />
            </li>
          ))}
        </ul>
      </BottomSheet>
    </>
  );
}
