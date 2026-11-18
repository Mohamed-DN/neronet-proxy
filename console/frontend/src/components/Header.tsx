import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Bell, ChevronDown, HelpCircle, LogOut, Send, Smartphone } from 'lucide-react';

import CommandMenu from '../command/CommandMenu';
import { useAuth } from '../context/AuthContext';
import { ROUTES } from '../routes/paths';
import { canSeeRoute } from '../routes/navModel';
import { effectiveRole } from '../services/roles';
import { Disclosure, LanguageSwitcher, MENU_CONTENT, MENU_ITEM, ThemeToggle } from '../ui';

export interface HeaderProps {
  onOpenEnrollModal?: () => void;
}

/**
 * The account menu: who is signed in, language, theme, the member's own space,
 * the glossary and sign-out. It is the whole of the phone's top bar on the right.
 */
export function AccountMenu() {
  const { t } = useTranslation('chrome');
  const { t: tGlossary } = useTranslation('glossary');
  const { t: tUi } = useTranslation('ui');
  const { user, logout } = useAuth();

  const role = effectiveRole(user);
  const name = user?.username ?? '';

  return (
    <Disclosure
      align="end"
      triggerLabel={`${t('header.accountMenu')}: ${name}`}
      trigger={
        <>
          <span
            aria-hidden="true"
            className="flex h-6 w-6 items-center justify-center rounded-pill bg-accent text-caption font-semibold text-accent-contrast"
          >
            {name[0]?.toUpperCase() ?? 'U'}
          </span>
          <span aria-hidden="true" className="hidden max-w-[8rem] truncate xl:inline">
            {name}
          </span>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
        </>
      }
      triggerClassName="inline-flex h-9 max-xl:h-11 items-center gap-2 rounded-control border border-border bg-surface-sunken pl-1.5 pr-2 text-body text-ink transition-colors hover:bg-surface-hover focus-visible:outline-focus"
      panelClassName={MENU_CONTENT}
    >
      <div className="px-3 py-2">
        <div className="text-body font-medium text-ink">{name}</div>
        {role && <div className="text-caption text-muted">{tGlossary(`roles.${role}.term`)}</div>}
      </div>
      <hr className="my-1 border-rule" />
      {/* Preferences. They change a setting and leave the menu open. */}
      <div data-keep-open="" className="flex items-center justify-between gap-3 px-3 py-1.5">
        <span className="text-caption text-muted">{tUi('language.label')}</span>
        <LanguageSwitcher variant="buttons" />
      </div>
      <div data-keep-open="" className="flex items-center justify-between gap-3 px-3 py-1.5">
        <span className="text-caption text-muted">{tUi('theme.label')}</span>
        <ThemeToggle />
      </div>
      <hr className="my-1 border-rule" />
      {/* The member's own space: every role has one, and it is where a phone is
          connected. */}
      {canSeeRoute('me', role) && (
        <Link to={ROUTES.me} className={MENU_ITEM}>
          <Smartphone aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
          {t('nav.items.me')}
        </Link>
      )}
      {canSeeRoute('drop', role) && (
        <Link to={ROUTES.drop} className={MENU_ITEM}>
          <Send aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
          {t('nav.items.drop')}
        </Link>
      )}
      <Link to={ROUTES.glossary} className={MENU_ITEM}>
        <HelpCircle aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
        {t('header.glossary')}
      </Link>
      <hr className="my-1 border-rule" />
      {/* The console had no way to end a session short of destroying the account. */}
      <button type="button" className={`${MENU_ITEM} w-full text-left`} onClick={() => void logout()}>
        <LogOut aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />
        {t('header.signOut')}
      </button>
    </Disclosure>
  );
}

/**
 * The end of the top bar: search, notifications and the account menu. Language
 * and theme live in the account menu, and adding a device is the primary action
 * of the pages that list devices (and a command in the search). It is a cluster
 * inside the bar's banner, not a banner of its own.
 */
export default function Header({ onOpenEnrollModal }: HeaderProps) {
  const { t } = useTranslation('chrome');
  return (
    <div className="flex min-w-0 items-center gap-2">
      <CommandMenu onAddDevice={onOpenEnrollModal} />

      {/* A panel, not a bare toggle: Escape and a click outside close it, focus
          moves into it when it opens and returns to the bell when it closes. */}
      <Disclosure
        kind="dialog"
        align="end"
        triggerLabel={t('header.notifications')}
        trigger={<Bell aria-hidden="true" className="h-4 w-4" />}
        triggerClassName="inline-flex h-9 w-9 max-xl:h-11 max-xl:w-11 items-center justify-center rounded-control border border-border bg-surface-sunken text-muted transition-colors hover:text-content focus-visible:outline-focus"
        panelLabel={t('header.alerts')}
        panelClassName="w-80 space-y-2 rounded-plate border border-border bg-plate p-3 shadow-overlay"
      >
        <div className="flex items-center justify-between border-b border-border-subtle pb-2 text-caption font-semibold">
          <span className="text-content">{t('header.alerts')}</span>
        </div>
        {/* The two entries that used to be here were written into the markup: a
            named node with an unsigned kernel module and another at 14%
            battery, on every deployment. There is no notification feed behind
            this control yet, and inventing one is worse than showing that it
            is empty. */}
        <p className="py-4 text-center text-caption text-muted">{t('header.noAlerts')}</p>
      </Disclosure>

      <AccountMenu />
    </div>
  );
}
