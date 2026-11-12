import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { AlertCircle, CheckCircle2, Link2 } from 'lucide-react';

import { useAuth } from '../context/AuthContext';
import { LOGIN_PATH, NEXT_PARAM, ROUTES } from '../routes/paths';
import { ApiError } from '../services/apiClient';
import { acceptInvitation } from '../services/queries/invitations';
import { MfaChallenge } from '../services/session';
import { Button } from '../ui/Button';
import { FormField } from '../ui/FormField';
import { Input } from '../ui/Input';
import { LanguageSwitcher } from '../ui/LanguageSwitcher';
import { ThemeToggle } from '../ui/ThemeToggle';

// The same shapes the server checks (services/InvitationService.js), so most mistakes
// are caught before a request spends one of the address's ten attempts.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

type Secret = { token: string } | { code: string };
type FieldErrors = Partial<Record<'code' | 'username' | 'password' | 'repeat', string>>;
type Done = { mfa: boolean };

/** A pasted link counts as the link: what follows `#` is the token. */
function readSecret(typed: string): Secret | null {
  const value = typed.trim();
  if (!value) return null;
  const fragment = value.includes('#') ? value.slice(value.lastIndexOf('#') + 1) : value;
  if (TOKEN_PATTERN.test(fragment)) return { token: fragment };
  return { code: value };
}

function serverError(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const body = err.details as { error?: string } | null;
  return body?.error ?? err.message ?? null;
}

const LOGIN_TO_ADD = `${LOGIN_PATH}?${NEXT_PARAM}=${encodeURIComponent(ROUTES.meAdd)}`;

/**
 * Where an invitation link opens (`/invito#<token>`), and where a person types the
 * short code instead. Public: the person has no account yet. The token is read from
 * the fragment, which no server or proxy ever sees, and then removed from the
 * address bar so it does not linger in the history or on a shared screen.
 */
export default function InviteAcceptRoute() {
  const { t } = useTranslation('invitations');
  const { user, isAuthenticated, login, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  // Read once, on the first render, before the fragment is cleared below.
  const [linkToken] = useState<string | null>(() => {
    const fragment = location.hash.replace(/^#/, '');
    return TOKEN_PATTERN.test(fragment) ? fragment : null;
  });
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    document.title = t('accept.title');
    if (location.hash) navigate({ pathname: location.pathname, search: location.search }, { replace: true });
    // Only on arrival: the fragment is cleared once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (alert) alertRef.current?.focus();
  }, [alert]);

  useEffect(() => {
    if (done) headingRef.current?.focus();
  }, [done]);

  function validate(): FieldErrors {
    const found: FieldErrors = {};
    if (!linkToken && !code.trim()) found.code = t('accept.errors.codeRequired');
    if (!USERNAME_PATTERN.test(username)) found.username = t('accept.errors.usernameFormat');
    if (!password) found.password = t('accept.errors.passwordRequired');
    else if (password !== repeat) found.repeat = t('accept.errors.mismatch');
    return found;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = validate();
    setErrors(found);
    setAlert(null);
    if (Object.keys(found).length > 0) return;
    const secret = linkToken ? { token: linkToken } : readSecret(code);
    if (!secret) return;

    setBusy(true);
    try {
      await acceptInvitation({ ...secret, username, password });
    } catch (err) {
      setBusy(false);
      const reason = serverError(err);
      if (reason === 'username_taken') setErrors({ username: t('accept.errors.usernameTaken') });
      else if (reason === 'invalid_username') setErrors({ username: t('accept.errors.usernameFormat') });
      else if (reason === 'invitation_invalid') setAlert(t('accept.errors.invalid'));
      else if (err instanceof ApiError && err.status === 429) setAlert(t('accept.errors.tooMany'));
      else if (err instanceof ApiError && err.isUnreachable) setAlert(t('accept.errors.unreachable'));
      else setAlert(t('accept.errors.generic'));
      return;
    }

    // The account exists. Sign in the normal way, so every sign-in rule applies.
    try {
      await login(username, password);
      navigate(ROUTES.meAdd, { replace: true });
    } catch (err) {
      setPassword('');
      setRepeat('');
      setDone({ mfa: err instanceof MfaChallenge });
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await logout();
  }

  let body: React.ReactNode;
  if (done) {
    body = (
      <section className="space-y-4">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="flex items-center gap-2 text-heading font-semibold text-content focus-visible:outline-focus"
        >
          <CheckCircle2 aria-hidden="true" className="h-5 w-5 shrink-0 text-success" />
          {t('accept.ready.title')}
        </h2>
        <p className="text-body text-content">{done.mfa ? t('accept.ready.mfa') : t('accept.ready.plain')}</p>
        <Link
          to={LOGIN_TO_ADD}
          className="inline-flex h-11 w-full items-center justify-center rounded-control bg-accent px-4 text-body font-medium text-accent-contrast hover:bg-accent-strong focus-visible:outline-focus"
        >
          {t('accept.ready.signIn')}
        </Link>
      </section>
    );
  } else if (isAuthenticated) {
    body = (
      <section className="space-y-4">
        <p className="text-body text-content">{t('accept.signedIn.body', { name: user?.username ?? '' })}</p>
        <Button variant="secondary" size="lg" fullWidth onClick={() => void signOut()}>
          {t('accept.signedIn.signOut')}
        </Button>
      </section>
    );
  } else {
    body = (
      <form onSubmit={onSubmit} noValidate className="space-y-5">
        {linkToken ? (
          <p className="flex items-start gap-2 rounded-control border border-border-subtle bg-surface p-3 text-caption text-content">
            <Link2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>{t('accept.fromLink')}</span>
          </p>
        ) : (
          <FormField label={t('accept.code')} hint={t('accept.codeHint')} error={errors.code} required>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              mono
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              className="h-11 tracking-wider"
            />
          </FormField>
        )}

        <FormField label={t('accept.username')} hint={t('accept.usernameHint')} error={errors.username} required>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            className="h-11"
          />
        </FormField>

        <FormField label={t('accept.password')} hint={t('accept.passwordHint')} error={errors.password} required>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className="h-11"
          />
        </FormField>

        <FormField label={t('accept.repeat')} error={errors.repeat} required>
          <Input
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            autoComplete="new-password"
            className="h-11"
          />
        </FormField>

        {alert && (
          <div
            ref={alertRef}
            role="alert"
            tabIndex={-1}
            className="flex items-start gap-2 rounded-control border border-danger/40 bg-danger-subtle p-3 text-body text-content focus-visible:outline-focus"
          >
            <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <p>{alert}</p>
          </div>
        )}

        <Button type="submit" variant="primary" size="lg" fullWidth loading={busy} loadingLabel={t('accept.working')}>
          {t('accept.submit')}
        </Button>
      </form>
    );
  }

  return (
    <div className="flex min-h-dvh items-start justify-center bg-surface px-4 py-8 font-sans sm:items-center">
      <main className="w-full max-w-md space-y-6 rounded-card border border-border bg-surface-raised p-6 sm:p-8">
        <div className="flex items-center justify-between gap-2">
          <span className="text-body font-semibold text-content">{'NeroNet'}</span>
          <div className="flex items-center gap-1">
            <LanguageSwitcher />
            <ThemeToggle />
          </div>
        </div>
        <div className="space-y-2">
          <h1 className="text-title font-bold text-content">{t('accept.title')}</h1>
          <p className="text-body text-muted">{t('accept.subtitle')}</p>
        </div>
        {body}
      </main>
    </div>
  );
}
