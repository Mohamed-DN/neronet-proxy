import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
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
    case 'installation_revoked':
    case 'installation_in_use':
      return 'installation';
    default:
      return 'generic';
  }
}

/**
 * Where a person approves the NeroNet app they just installed (`/collega`, optionally with
 * `?code=ABCD-EFGH` from the link or QR the app shows). The page names what is asking, its
 * platform, device name and the address it asked from, so a code someone else talked the
 * person into typing is recognisable as not theirs.
 */
export default function AppConnectRoute() {
  const { t } = useTranslation('apps');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLDivElement>(null);
  const [code, setCode] = useState(() => params.get('code') ?? '');
  const [step, setStep] = useState<Step>({ kind: 'enter' });
  const [totp, setTotp] = useState('');
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

  // A code that arrives in the address is read once and taken out of it, so it does not
  // linger in the history or on a shared screen.
  useEffect(() => {
    document.title = t('title');
    const fromLink = params.get('code');
    if (fromLink) {
      navigate({ pathname: APP_CONNECT_PATH }, { replace: true });
      void look(fromLink);
    }
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (step.kind === 'done') headingRef.current?.focus();
  }, [step]);

  async function decide(approve: boolean) {
    if (step.kind !== 'review') return;
    setError(null);
    if (approve && step.request.mfa_required && !totp.trim()) {
      setError('mfaRequired');
      return;
    }
    setBusy(true);
    try {
      if (approve) {
        await approveAppCode(step.code, step.request.mfa_required ? { totp_code: totp.trim() } : undefined);
      } else {
        await denyAppCode(step.code);
      }
      setTotp('');
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
        <h2 id="app-connect-asking" className="flex items-center gap-2 text-heading font-semibold text-content">
          <MonitorSmartphone aria-hidden="true" className="h-5 w-5 shrink-0 text-accent" />
          {t('review.title')}
        </h2>
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 rounded-card border border-border-subtle bg-surface p-4 text-body">
          <dt className="text-muted">{t('review.device')}</dt>
          <dd className="font-medium text-content">{r.device_name}</dd>
          <dt className="text-muted">{t('review.platform')}</dt>
          <dd className="text-content">{t(`platform.${r.platform}`)}</dd>
          <dt className="text-muted">{t('review.address')}</dt>
          <dd className="font-mono text-content">{r.request_ip ?? t('review.unknownAddress')}</dd>
        </dl>
        <p className="text-body text-muted">{t('review.warning')}</p>
        {r.mfa_required && (
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
