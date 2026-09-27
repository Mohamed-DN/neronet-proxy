import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useSearchParams } from 'react-router-dom';

import { useAuth } from '../context/AuthContext';
import { MfaChallenge, startMfaEnrolment, type MfaEnrolment } from '../services/session';
import { Button, LanguageSwitcher, ThemeToggle } from '../ui';
import { NEXT_PARAM, safeNextPath } from './paths';

const INPUT_CLASS =
  'w-full rounded-control border border-border bg-surface px-3.5 py-2.5 font-mono text-caption text-content placeholder:text-subtle focus-visible:outline-focus';

interface MfaStep {
  token: string;
  enrolment: MfaEnrolment | null;
}

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
  const { login, completeMfaSignIn, isAuthenticated } = useAuth();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Set once the password is accepted and the account needs a TOTP code. With
  // `enrolment`, the account has no authenticator yet and enrols one here.
  const [mfa, setMfa] = useState<MfaStep | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const next = safeNextPath(params.get(NEXT_PARAM));

  useEffect(() => {
    usernameRef.current?.focus();
    document.title = t('page.title', { page: t('login.title') });
  }, [t]);

  // Moves focus to the code field when the MFA step replaces the password form, so a
  // keyboard or screen reader user lands where the next input is expected.
  useEffect(() => {
    if (mfa) codeRef.current?.focus();
  }, [mfa, useRecovery]);

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
      if (err instanceof MfaChallenge) {
        try {
          const enrolment = err.setupRequired ? await startMfaEnrolment(err.mfaToken) : null;
          setMfa({ token: err.mfaToken, enrolment });
          setPassword('');
        } catch (enrolErr) {
          setError(enrolErr instanceof Error ? enrolErr.message : t('login.failed'));
        }
      } else {
        setError(err instanceof Error ? err.message : t('login.failed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleMfaSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mfa) return;
    setSubmitting(true);
    setError('');
    try {
      const proof = useRecovery ? { recovery_code: code.trim() } : { code: code.replace(/\s+/g, '') };
      await completeMfaSignIn(mfa.token, proof);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const startOver = () => {
    setMfa(null);
    setCode('');
    setUseRecovery(false);
    setError('');
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

        {mfa ? (
          <form onSubmit={handleMfaSubmit} className="space-y-4">
            {mfa.enrolment ? (
              <div className="space-y-3">
                <p className="font-mono text-caption text-content">{t('login.mfa.enrolIntro')}</p>
                <img
                  src={mfa.enrolment.qrDataUrl}
                  alt={t('login.mfa.qrAlt')}
                  className="mx-auto h-44 w-44 rounded-control bg-white p-2"
                />
                <p className="font-mono text-micro text-muted">
                  {t('login.mfa.secretLabel')} <code className="break-all text-content">{mfa.enrolment.secret}</code>
                </p>
                <div className="rounded-control border border-border p-3">
                  <p className="font-mono text-micro text-muted">{t('login.mfa.recoveryIntro')}</p>
                  <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-caption text-content">
                    {mfa.enrolment.recoveryCodes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : (
              <p className="font-mono text-caption text-content">
                {useRecovery ? t('login.mfa.recoveryPrompt') : t('login.mfa.prompt')}
              </p>
            )}

            <div className="space-y-1">
              <label htmlFor="login-mfa-code" className="block font-mono text-caption text-muted">
                {useRecovery ? t('login.mfa.recoveryLabel') : t('login.mfa.codeLabel')}
              </label>
              <input
                id="login-mfa-code"
                type="text"
                ref={codeRef}
                required
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={INPUT_CLASS}
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
              {mfa.enrolment ? t('login.mfa.enrolSubmit') : t('login.mfa.submit')}
            </Button>

            <div className="flex justify-between font-mono text-micro">
              {!mfa.enrolment && (
                <button
                  type="button"
                  className="text-muted underline"
                  onClick={() => {
                    setUseRecovery((v) => !v);
                    setCode('');
                  }}
                >
                  {useRecovery ? t('login.mfa.useCode') : t('login.mfa.useRecovery')}
                </button>
              )}
              <button type="button" className="text-muted underline" onClick={startOver}>
                {t('login.mfa.startOver')}
              </button>
            </div>
          </form>
        ) : (
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
                className={INPUT_CLASS}
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
                className={INPUT_CLASS}
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
        )}

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
