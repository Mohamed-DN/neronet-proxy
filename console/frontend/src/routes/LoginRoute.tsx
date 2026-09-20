import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../context/AuthContext';
import { Button, LanguageSwitcher, ThemeToggle } from '../ui';
import { NEXT_PARAM, safeNextPath } from './paths';

/**
 * The sign-in screen.
 *
 * It is a route of its own so that an expired session redirects here with the
 * address the operator asked for, and returns them to it afterwards, rather
 * than replacing the whole console with a form and then dropping them on the
 * overview.
 */
export default function LoginRoute() {
  const { t } = useTranslation('chrome');
  const { login, isAuthenticated } = useAuth();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);

  const next = safeNextPath(params.get(NEXT_PARAM));

  useEffect(() => {
    usernameRef.current?.focus();
    document.title = t('page.title', { page: t('login.title') });
  }, [t]);

  if (isAuthenticated) {
    return <Navigate to={next} replace />;
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await login(username, password);
      // The redirect happens through isAuthenticated on the next render, so a
      // sign-in that succeeded and a session that was already there land the
      // operator in the same place.
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4 font-sans">
      <div className="w-full max-w-md space-y-6 rounded-card border border-border bg-surface-raised p-8">
        <div className="flex justify-end gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>

        <div className="space-y-2 text-center">
          <h1 className="font-mono text-title font-bold tracking-wider text-content">{t('login.title')}</h1>
          <p className="font-mono text-caption text-muted">{t('login.subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="login-username" className="block font-mono text-caption text-muted">
              {t('login.username')}
            </label>
            <input
              id="login-username"
              ref={usernameRef}
              type="text"
              required
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-control border border-border bg-surface px-3.5 py-2.5 font-mono text-caption text-content placeholder:text-subtle focus-visible:outline-focus"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="login-password" className="block font-mono text-caption text-muted">
              {t('login.password')}
            </label>
            <input
              id="login-password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-control border border-border bg-surface px-3.5 py-2.5 font-mono text-caption text-content placeholder:text-subtle focus-visible:outline-focus"
            />
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-control border border-danger/40 bg-danger-subtle p-3 font-mono text-caption text-danger"
            >
              {error}
            </p>
          )}

          <Button type="submit" fullWidth loading={submitting} loadingLabel={t('login.working')}>
            {t('login.submit')}
          </Button>
        </form>

        <p className="border-t border-border-subtle pt-3 text-center font-mono text-micro text-subtle">
          {/* This read "Zero-Knowledge Cryptographic Authentication - Ed25519".
              Console sign-in is a password verified with bcrypt against a hash,
              and the session is a signed JWT. Ed25519 is used for node identity
              and federation, not for signing in here. */}
          {t('login.method')}
        </p>
      </div>
    </div>
  );
}
