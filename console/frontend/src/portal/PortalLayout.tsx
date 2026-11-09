import { Link, Outlet, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../context/AuthContext';
import { effectiveRole, roleTier } from '../services/roles';
import { IconButton } from '../ui/IconButton';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';
import { SkipLink } from '../ui/SkipLink';
import { ThemeToggle } from '../ui/ThemeToggle';

/**
 * The frame around `/me` and `/me/add`: one column on a phone, the wordmark, the
 * signed-in name, language, theme and sign-out. Admin roles get a quiet way
 * back to the console; the portal itself does not show the console's chrome.
 */
export default function PortalLayout() {
  const { t } = useTranslation('portal');
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isSelf = roleTier(effectiveRole(user)) === 'self';

  async function signOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-dvh bg-surface text-content">
      <SkipLink />
      <header className="border-b border-border-subtle">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-2 px-4 py-3">
          <span className="text-body font-semibold text-content">NeroNet</span>
          <div className="flex items-center gap-1">
            <LanguageSwitcher />
            <ThemeToggle />
            <IconButton
              icon={LogOut}
              label={t('layout.signOut')}
              onClick={() => void signOut()}
              className="h-11 w-11"
            />
          </div>
        </div>
        <div className="mx-auto w-full max-w-xl px-4 pb-3 text-caption text-muted">
          <p>{t('layout.signedInAs', { name: user?.username ?? '' })}</p>
          {!isSelf && (
            <p className="mt-1">
              <Link
                to="/overview"
                className="inline-flex min-h-11 items-center rounded-sm underline focus-visible:outline-focus"
              >
                {t('me.consoleLink')}
              </Link>
            </p>
          )}
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="mx-auto w-full max-w-xl px-4 pb-28 pt-6 sm:pb-8">
        <Outlet />
      </main>
    </div>
  );
}
