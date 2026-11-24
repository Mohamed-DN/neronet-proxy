import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';
import { AlertCircle, CheckCircle2, MonitorSmartphone } from 'lucide-react';

import { APP_CONNECT_PATH } from '../routes/paths';
import { ApiError } from '../services/apiClient';
import { approveAppCode, denyAppCode, lookupAppCode, type AppSignInRequest } from '../services/queries/appSessions';
import { Button } from '../ui/Button';
import { FormField } from '../ui/FormField';
import { Input } from '../ui/Input';
import { PageHeader } from '../ui/PageHeader';

/** The shape the server prints: eight letters and numbers, in two groups of four. */
const CODE_PATTERN = /^[0-9A-Za-z]{4}[ -]?[0-9A-Za-z]{4}$/;

/** What a scope lets the app do, in words. Keys avoid the colon, which i18next reads as a namespace. */
const SCOPE_WORDS: Record<string, string> = {
  'app:self': 'appSelf',
  'devices:read': 'devicesRead',
  'exit:select': 'exitSelect',
  'drop:use': 'dropUse'
};

/** The same reading the console gives a typed code: case and separators do not matter, O is 0, I and L are 1. */
function sameCode(a: string, b: string): boolean {
  const clean = (v: string) =>
    v
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, '')
      .replace(/O/g, '0')
      .replace(/[IL]/g, '1');
  return clean(a).length === 8 && clean(a) === clean(b);
}

type Step =
  | { kind: 'enter' }
  | { kind: 'review'; code: string; request: AppSignInRequest }
  | { kind: 'done'; outcome: 'approved' | 'denied' };

function errorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return 'generic';
  if (err.isUnreachable) return 'unreachable';
  if (err.status === 429) return 'tooMany';
  switch (err.code) {
    case 'code_not_found':
      return 'notFound';
    case 'code_expired':
      return 'expired';
    case 'code_used':
      return 'used';
    case 'mfa_required':
      return 'mfaRequired';
    case 'mfa_invalid':
      return 'mfaInvalid';
    case 'mfa_setup_required':
      return 'mfaSetup';
    case 'owner_has_blocked_device':
      return 'blocked';
    case 'forbidden_role':
      return 'forbiddenRole';
    case 'installation_revoked':
    case 'installation_in_use':
      return 'installation';
    default:
      return 'generic';
  }
}

/**
 * Where a person approves the NeroNet app they just installed (`/collega`, optionally opened with
 * `#code=ABCD-EFGH` from the link or QR the app shows). The code travels in the fragment, which no
 * server or proxy ever sees, and is taken out of the address at once; a code in the query string is
 * not read at all. The page names what is asking, and says that the device name and platform are what
 * the app says of itself, so a code someone else talked the person into opening is recognisable as not
 * theirs. Approving needs the code from the app's own screen to be typed, link or no link, and the page
 * never prints that code: a code the page showed would only have to be copied.
 */
export default function AppConnectRoute() {
  const { t } = useTranslation('apps');
  const navigate = useNavigate();
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'enter' });
  const [typed, setTyped] = useState('');
  const [totp, setTotp] = useState('');
  const [recovery, setRecovery] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function look(value: string) {
    setError(null);
    if (!CODE_PATTERN.test(value.trim())) {
      setError('format');
      return;
    }
    setBusy(true);
    try {
      const request = await lookupAppCode(value.trim());
      setStep({ kind: 'review', code: value.trim(), request });
    } catch (err) {
      setError(errorKey(err));
    } finally {
      setBusy(false);
    }
  }

  // A code that arrives in the address fragment is read once and taken out of it, so it does not
  // linger in the history or on a shared screen.
  useEffect(() => {
    document.title = t('title');
    const fromLink = new URLSearchParams(location.hash.replace(/^#/, '')).get('code');
    if (location.hash) navigate({ pathname: APP_CONNECT_PATH, search: location.search }, { replace: true });
    if (fromLink) void look(fromLink);
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (step.kind === 'review') reviewRef.current?.focus();
    if (step.kind === 'done') headingRef.current?.focus();
  }, [step]);

  async function decide(approve: boolean) {
    if (step.kind !== 'review') return;
    setError(null);
    const r = step.request;
    if (approve) {
      if (!typed.trim()) return setError('codeRequired');
      if (!sameCode(typed, r.user_code ?? step.code)) return setError('codeMismatch');
      if (r.mfa_required && useRecovery && !recovery.trim()) return setError('recoveryRequired');
      if (r.mfa_required && !useRecovery && !totp.trim()) return setError('mfaRequired');
    }
    setBusy(true);
    try {
      if (approve) {
        const proof = !r.mfa_required
          ? undefined
          : useRecovery
            ? { recovery_code: recovery.trim() }
            : { totp_code: totp.trim() };
        await approveAppCode(step.code, proof);
      } else {
        await denyAppCode(step.code);
      }
      setTotp('');
      setRecovery('');
      setStep({ kind: 'done', outcome: approve ? 'approved' : 'denied' });
    } catch (err) {
      setError(errorKey(err));
    } finally {
      setBusy(false);
    }
  }

  function onEnter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void look(code);
  }

  const alert = error && (
    <div
      ref={alertRef}
      role="alert"
      tabIndex={-1}
      className="flex items-start gap-2 rounded-control border border-danger/40 bg-danger-subtle p-3 text-body text-content focus-visible:outline-focus"
    >
      <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <p>{t(`errors.${error}`)}</p>
    </div>
  );

  let body: React.ReactNode;
  if (step.kind === 'done') {
    body = (
      <section className="space-y-4">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="flex items-center gap-2 text-heading font-semibold text-content focus-visible:outline-focus"
        >
          <CheckCircle2 aria-hidden="true" className="h-5 w-5 shrink-0 text-success" />
          {t(`done.${step.outcome}.title`)}
        </h2>
        <p className="text-body text-content">{t(`done.${step.outcome}.body`)}</p>
        <Link
          to="/me"
          className="inline-flex h-11 items-center justify-center rounded-control border border-border bg-surface-raised px-4 text-body font-medium text-content hover:bg-surface-sunken focus-visible:outline-focus"
        >
          {t('done.back')}
        </Link>
      </section>
    );
  } else if (step.kind === 'review') {
    const r = step.request;
    body = (
      <section className="space-y-5" aria-labelledby="app-connect-asking">
        <h2
          id="app-connect-asking"
          ref={reviewRef}
          tabIndex={-1}
          className="flex items-center gap-2 text-heading font-semibold text-content focus-visible:outline-focus"
        >
          <MonitorSmartphone aria-hidden="true" className="h-5 w-5 shrink-0 text-accent" />
          {t('review.title')}
        </h2>
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 rounded-card border border-border-subtle bg-surface p-4 text-body">
          <dt className="text-muted">{t('review.device')}</dt>
          <dd className="text-content">
            <span className="font-medium">{r.device_name}</span>
            <span className="block text-caption text-muted">{t('review.selfDeclared')}</span>
          </dd>
          <dt className="text-muted">{t('review.platform')}</dt>
          <dd className="text-content">
            {t(`platform.${r.platform}`)}
            <span className="block text-caption text-muted">{t('review.selfDeclared')}</span>
          </dd>
          <dt className="text-muted">{t('review.address')}</dt>
          <dd className="font-mono text-content">{r.request_ip ?? t('review.unknownAddress')}</dd>
        </dl>
        <div>
          <p className="text-body font-medium text-content">{t('review.scopesTitle')}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-body text-content">
            {(r.scopes ?? []).map((scope) => (
              <li key={scope}>{t(`scopes.${SCOPE_WORDS[scope] ?? 'unknown'}`)}</li>
            ))}
          </ul>
        </div>
        <p className="text-body text-muted">{t('review.warning')}</p>
        <FormField label={t('review.confirmCode')} hint={t('review.confirmCodeHint')} required>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            mono
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="h-11 tracking-wider"
          />
        </FormField>
        {r.mfa_required &&
          (useRecovery ? (
            <FormField label={t('review.recovery')} hint={t('review.recoveryHint')} required>
              <Input
                value={recovery}
                onChange={(e) => setRecovery(e.target.value)}
                mono
                autoComplete="off"
                spellCheck={false}
                className="h-11 tracking-wider"
              />
            </FormField>
          ) : (
            <FormField label={t('review.totp')} hint={t('review.totpHint')} required>
              <Input
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                mono
                inputMode="numeric"
                autoComplete="one-time-code"
                spellCheck={false}
                className="h-11 tracking-wider"
              />
            </FormField>
          ))}
        {r.mfa_required && (
          <Button variant="ghost" onClick={() => setUseRecovery((v) => !v)}>
            {useRecovery ? t('review.useAuthenticator') : t('review.useRecovery')}
          </Button>
        )}
        {alert}
        <div className="flex flex-col gap-3 sm:flex-row-reverse">
          <Button
            variant="primary"
            size="lg"
            fullWidth
            loading={busy}
            loadingLabel={t('working')}
            onClick={() => void decide(true)}
          >
            {t('review.approve')}
          </Button>
          <Button variant="secondary" size="lg" fullWidth disabled={busy} onClick={() => void decide(false)}>
            {t('review.deny')}
          </Button>
        </div>
      </section>
    );
  } else {
    body = (
      <form onSubmit={onEnter} noValidate className="space-y-5">
        <FormField label={t('enter.code')} hint={t('enter.codeHint')} required>
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
        {alert}
        <Button type="submit" variant="primary" size="lg" fullWidth loading={busy} loadingLabel={t('working')}>
          {t('enter.submit')}
        </Button>
      </form>
    );
  }

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="max-w-md">{body}</div>
    </>
  );
}
