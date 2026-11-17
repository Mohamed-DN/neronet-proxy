import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { ChevronDown, LogOut, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../context/AuthContext';
import { ROUTES } from '../routes/paths';
import { effectiveRole, roleTier } from '../services/roles';
import { cn } from '../ui/cn';
import { Disclosure } from '../ui/Disclosure';
import { Glyph } from '../ui/Glyph';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';
import { MENU_CONTENT, MENU_ITEM } from '../ui/menuStyles';
import { SkipLink } from '../ui/SkipLink';
import { ThemeToggle } from '../ui/ThemeToggle';

const NAV_LINK = 'relative inline-flex min-h-11 items-center px-1 text-body text-ink focus-visible:outline-focus';
// "You are here": the signal, outlined in ink so it holds 3:1 (the same mark as the console's top bar).
const ACTIVE_MARK =
  'font-semibold after:absolute after:inset-x-0 after:bottom-0 after:h-[3px] after:rounded-pill after:bg-signal after:shadow-[0_0_0_1px_rgb(var(--color-ink))]';

/**
 * The frame around the member pages: one narrow column, the wordmark (a link
 * home), two places to go and an account menu. The account menu holds language,
 * theme, the way back to the console for roles that have one, and a sign-out
 * with a visible word. The portal does not show the console's chrome.
 */
export default function PortalLayout() {
  const { t } = useTranslation('portal');
  const { t: tUi } = useTranslation('ui');
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isSelf = roleTier(effectiveRole(user)) === 'self';
  const name = user?.username ?? '';

  async function signOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-dvh bg-surface text-content">
      <SkipLink />
      <header className="border-b border-rule">
        <div className="mx-auto flex w-full max-w-[640px] items-center justify-between gap-3 px-4 pt-3">
          <Link
            to={ROUTES.me}
            aria-label={t('layout.home')}
            className="inline-flex min-h-11 items-center gap-2 rounded-control text-body font-semibold text-content focus-visible:outline-focus"
          >
            <Glyph />
            <span>{'NeroNet'}</span>
          </Link>

          <Disclosure
            align="end"
            triggerLabel={`${t('layout.account')}: ${name}`}
            trigger={
              <>
                <span aria-hidden="true" className="max-w-[9rem] truncate">
                  {name}
                </span>
                <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
              </>
            }
            triggerClassName="inline-flex h-11 items-center gap-2 rounded-control border border-border bg-surface-sunken px-3 text-body text-ink hover:bg-surface-hover focus-visible:outline-focus"
            panelClassName={cn(MENU_CONTENT, 'w-64 max-w-[calc(100vw-2rem)]')}
          >
            <div className="px-3 py-2">
              <p className="break-words text-body font-medium text-ink">{name}</p>
            </div>
            <hr className="my-1 border-rule" />
            {/* Preferences change a setting and leave the menu open. */}
            <div data-keep-open="" className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="text-caption text-muted">{tUi('language.label')}</span>
              <LanguageSwitcher variant="buttons" />
            </div>
            <div data-keep-open="" className="flex items-center justify-between gap-3 px-3 py-1.5">
              <span className="text-caption text-muted">{tUi('theme.label')}</span>
              <ThemeToggle />
            </div>
            <hr className="my-1 border-rule" />
            {!isSelf && (
              <Link to={ROUTES.overview} className={MENU_ITEM}>
                <ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
                {t('layout.adminConsole')}
              </Link>
            )}
            <button type="button" onClick={() => void signOut()} className={cn(MENU_ITEM, 'w-full text-start')}>
              <LogOut aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
              {t('layout.signOut')}
            </button>
          </Disclosure>
        </div>

        <nav aria-label={t('layout.nav')} className="mx-auto w-full max-w-[640px] px-4">
          <ul className="flex flex-wrap gap-x-6">
            {[
              { to: ROUTES.me, label: t('layout.navDevices') },
              { to: ROUTES.drop, label: t('layout.navDrop') }
            ].map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  // Without `end`, /me/add is still "my devices": the link stays marked there.
                  className={({ isActive }) => cn(NAV_LINK, isActive && ACTIVE_MARK)}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-[640px] px-4 pb-8 pt-6">
        <Outlet />
      </main>
    </div>
  );
}
