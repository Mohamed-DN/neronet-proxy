import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation, useSearchParams } from 'react-router';

import { useAuth } from '../context/AuthContext';
import { ApiError } from '../services/apiClient';
import { MfaChallenge, startMfaEnrolment, type MfaEnrolment } from '../services/session';
import { Button, Checkbox, LanguageSwitcher, Logo, ThemeToggle } from '../ui';
import { LoginBrandMap } from './LoginBrandMap';
import { NEXT_PARAM, safeNextPath } from './paths';

const INPUT_CLASS =
  'w-full rounded-control border border-border bg-surface px-3.5 py-2.5 text-caption text-content placeholder:text-subtle focus-visible:outline-focus';

interface PlainError {
  message: string;
  /** The server's own words, shown as a secondary line only for a server fault. */
  detail: string | null;
}

/**
 * Turns a failed sign-in into words a person can act on. A server that cannot
 * be reached is named as such; a server fault keeps its own text as a small
 * detail; anything else gets the plain fallback, never the raw message alone.
 */
function plainError(err: unknown, fallback: string, t: (key: string) => string): PlainError {
  if (err instanceof ApiError && err.isUnreachable) return { message: t('login.unreachable'), detail: null };
  if (err instanceof ApiError && err.status >= 500) return { message: fallback, detail: err.message };
  return { message: fallback, detail: null };
}

function PlainErrorAlert({ error }: { error: PlainError }) {
  return (
    <p role="alert" className="rounded-control border border-danger/40 bg-danger-subtle p-3 text-caption text-danger">
      {error.message}
      {error.detail && <span className="mt-1 block text-micro text-muted">{error.detail}</span>}
    </p>
  );
}

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
// The mark switches on once per page load, however often the route is shown.
let markPlayed = false;

export default function LoginRoute() {
  const { t } = useTranslation('chrome');
  const { login, completeMfaSignIn, isAuthenticated } = useAuth();
  const [params] = useSearchParams();
  const location = useLocation();
  // Read purely, and recorded in an effect, so a development double render still plays it.
  const [animateMark] = useState(() => !markPlayed);
  useEffect(() => {
    markPlayed = true;
  }, []);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<PlainError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set once the password is accepted and the account needs a TOTP code. With
  // `enrolment`, the account has no authenticator yet and enrols one here.
  const [mfa, setMfa] = useState<MfaStep | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  // Enrolment: the recovery codes are shown once, so leaving needs to be deliberate.
  const [codesSaved, setCodesSaved] = useState(false);
  const [codesCopied, setCodesCopied] = useState<'copied' | 'failed' | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const next = safeNextPath(params.get(NEXT_PARAM));

  useEffect(() => {
    usernameRef.current?.focus();
    document.title = t('page.title', { page: t('login.submit') });
  }, [t]);

  // Moves focus to the code field when the MFA step replaces the password form, so a
  // keyboard or screen reader user lands where the next input is expected.
  useEffect(() => {
    if (mfa) codeRef.current?.focus();
  }, [mfa, useRecovery]);

  if (isAuthenticated) {
    // The fragment (a NeroDrop link) is re-attached here; it never went to the server.
    return <Navigate to={`${next}${location.hash}`} replace />;
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
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
          setError(plainError(enrolErr, t('login.failed'), t));
        }
      } else {
        setError(plainError(err, t('login.failed'), t));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleMfaSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mfa) return;
    setSubmitting(true);
    setError(null);
    try {
      const proof = useRecovery ? { recovery_code: code.trim() } : { code: code.replace(/\s+/g, '') };
      await completeMfaSignIn(mfa.token, proof);
    } catch (err) {
      setError(plainError(err, t('login.mfa.failed'), t));
    } finally {
      setSubmitting(false);
    }
  };

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText((mfa?.enrolment?.recoveryCodes ?? []).join('\n'));
      setCodesCopied('copied');
    } catch {
      setCodesCopied('failed');
    }
  };

  const startOver = () => {
    // The pending enrolment is replaced next time, so the codes on screen would stop working.
    if (mfa?.enrolment && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setCodesSaved(false);
    setCodesCopied(null);
    setConfirmDiscard(false);
    setMfa(null);
    setCode('');
    setUseRecovery(false);
    setError(null);
  };

  return (
    <div className="min-h-dvh bg-sheet font-sans text-ink lg:grid lg:grid-cols-2">
      <section
        aria-label={t('login.brandLabel')}
        className="login-brand flex flex-col gap-6 px-6 pb-2 pt-8 lg:relative lg:min-h-dvh lg:justify-between lg:gap-10 lg:overflow-hidden lg:bg-sheet lg:px-14 lg:py-12"
      >
        <div className="space-y-5 lg:space-y-8">
          <h1 className="text-ink">
            <Logo wordmark size={48} animate={animateMark ? 'allaccio' : undefined} speed={0.75} />
          </h1>
          <p className="max-w-[22ch] text-title font-bold text-ink lg:text-[2.5rem] lg:leading-[1.1]">
            {t('login.subtitle')}
          </p>
        </div>
        <LoginBrandMap className="hidden h-auto w-full max-w-[640px] lg:block" />
      </section>

      <main className="flex items-center justify-center px-6 py-8 lg:px-14">
        <div className="w-full max-w-sm space-y-6">
          <div className="flex justify-end gap-2">
            <LanguageSwitcher variant="buttons" />
            <ThemeToggle />
          </div>

          {mfa ? (
            <form onSubmit={handleMfaSubmit} className="space-y-4">
              {mfa.enrolment ? (
                <div className="space-y-3">
                  <p className="text-caption text-content">{t('login.mfa.enrolIntro')}</p>
                  <img
                    src={mfa.enrolment.qrDataUrl}
                    alt={t('login.mfa.qrAlt')}
                    className="mx-auto h-44 w-44 rounded-control bg-white p-2"
                  />
                  <p className="text-micro text-muted">
                    {t('login.mfa.secretLabel')} <code className="break-all text-content">{mfa.enrolment.secret}</code>
                  </p>
                  <div className="rounded-control border border-border p-3">
                    <p className="text-micro text-muted">{t('login.mfa.recoveryIntro')}</p>
                    <ul className="mt-2 grid grid-cols-2 gap-1 text-caption text-content">
                      {mfa.enrolment.recoveryCodes.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <Button type="button" variant="secondary" onClick={() => void copyCodes()}>
                        {t('login.mfa.copyCodes')}
                      </Button>
                      {codesCopied && (
                        <span role="status" className="text-micro text-muted">
                          {t(codesCopied === 'copied' ? 'login.mfa.copied' : 'login.mfa.copyFailed')}
                        </span>
                      )}
                    </div>
                    <div className="mt-3">
                      <Checkbox
                        label={t('login.mfa.savedCodes')}
                        checked={codesSaved}
                        onChange={(e) => setCodesSaved(e.target.checked)}
                      />
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-caption text-content">
                  {useRecovery ? t('login.mfa.recoveryPrompt') : t('login.mfa.prompt')}
                </p>
              )}

              <div className="space-y-1">
                <label htmlFor="login-mfa-code" className="block text-caption text-muted">
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

              {error && <PlainErrorAlert error={error} />}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                loading={submitting}
                loadingLabel={t('login.working')}
                disabled={Boolean(mfa.enrolment) && !codesSaved}
              >
                {mfa.enrolment ? t('login.mfa.enrolSubmit') : t('login.mfa.submit')}
              </Button>

              <div className="flex justify-between text-micro">
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
                {confirmDiscard ? (
                  <div className="space-y-1">
                    <p role="status" className="text-danger">
                      {t('login.mfa.discardWarning')}
                    </p>
                    <button type="button" className="text-danger underline" onClick={startOver}>
                      {t('login.mfa.discardConfirm')}
                    </button>
                  </div>
                ) : (
                  <button type="button" className="text-muted underline" onClick={startOver}>
                    {t('login.mfa.startOver')}
                  </button>
                )}
              </div>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1">
                <label htmlFor="login-username" className="block text-caption text-muted">
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
                <label htmlFor="login-password" className="block text-caption text-muted">
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

              {error && <PlainErrorAlert error={error} />}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                fullWidth
                loading={submitting}
                loadingLabel={t('login.working')}
              >
                {t('login.submit')}
              </Button>
            </form>
          )}

          <p className="border-t border-border-subtle pt-3 text-center text-micro text-subtle">
            {/* This read "Zero-Knowledge Cryptographic Authentication - Ed25519".
              Console sign-in is a password verified with bcrypt against a hash,
              and the session is a signed JWT. Ed25519 is used for node identity
              and federation, not for signing in here. */}
            {t('login.method')}
          </p>
        </div>
      </main>
    </div>
  );
}
