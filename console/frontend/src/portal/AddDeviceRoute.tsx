import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, AlertTriangle, Copy, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { generateDeviceKeys, KeyGenerationUnavailable } from '../devices/keys';
import { QrCode } from '../devices/QrCode';
import { buildProfileConfig, configFileName } from '../devices/wgConfig';
import { ApiError } from '../services/apiClient';
import { useRegisterProfileDevice } from '../services/queries/devices';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import { FormField } from '../ui/FormField';
import { Input } from '../ui/Input';
import { PageHeader } from '../ui/PageHeader';
import { useToast } from '../ui/Toast';

const NAME_MIN = 1;
const NAME_MAX = 64;
const SECONDARY_LARGE =
  'inline-flex h-11 items-center justify-center gap-2 rounded-control border border-border-strong bg-surface-raised px-4 text-body font-medium text-content hover:bg-surface-hover focus-visible:outline-focus';

type AlertKind = 'noCrypto' | 'noGateway' | 'keyInUse' | 'generic';

interface Result {
  name: string;
  /** The WireGuard configuration text, which holds the private key. Kept in memory only. */
  config: string;
}

function alertKindFor(error: unknown): AlertKind {
  if (error instanceof KeyGenerationUnavailable) return 'noCrypto';
  if (error instanceof ApiError && error.status === 409) {
    // Older servers name the reason only in `error`; the message is that same word then.
    const reason = error.code ?? error.message;
    return reason === 'no_profile_gateway' ? 'noGateway' : 'keyInUse';
  }
  return 'generic';
}

/**
 * Adds a phone or computer. The keys are made here, in the browser; only the
 * name and the two public values go to the server. The answer is a
 * configuration shown once as a QR code and as a file.
 */
export default function AddDeviceRoute() {
  const { t } = useTranslation('portal');
  const { notify } = useToast();
  const register = useRegisterProfileDevice();
  const resultId = useId();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [alert, setAlert] = useState<AlertKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  // Focus goes to a failure so that a screen reader and a keyboard both land on it.
  useEffect(() => {
    if (alert) alertRef.current?.focus();
  }, [alert]);

  // While the one-time code is on screen, leaving the page would lose it: ask first.
  useEffect(() => {
    if (!result) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [result]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) {
      setNameError(t('add.nameRequired'));
      return;
    }
    setNameError(null);
    setAlert(null);
    setBusy(true);
    try {
      const keys = await generateDeviceKeys();
      const device = await register.mutateAsync({
        name: trimmed,
        public_key: keys.publicKey,
        preshared_key: keys.presharedKey
      });
      setResult({ name: trimmed, config: buildProfileConfig(keys, device) });
      notify(t('add.result.added', { name: trimmed }), { tone: 'success' });
    } catch (error) {
      if (error instanceof ApiError && error.status === 400) {
        setNameError(t('add.nameRequired'));
      } else {
        setAlert(alertKindFor(error));
      }
    } finally {
      setBusy(false);
    }
  }

  function downloadConfig(current: Result) {
    const url = URL.createObjectURL(new Blob([current.config], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = configFileName(current.name);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  async function copyConfig(current: Result) {
    try {
      await navigator.clipboard.writeText(current.config);
      notify(t('add.result.copied'), { tone: 'success' });
    } catch {
      notify(t('code.copyFailed', { ns: 'ui' }), { tone: 'danger' });
    }
  }

  if (result) {
    return (
      <>
        <PageHeader title={t('add.title')} description={t('add.description')} />
        <section aria-labelledby={resultId}>
          <h2 id={resultId} className="text-heading font-medium text-content">
            {t('add.result.title')}
          </h2>
          <div className="mt-4 flex justify-center rounded-card border border-border-subtle bg-surface-raised p-4">
            <QrCode value={result.config} label={t('add.result.qrAlt', { name: result.name })} size={256} />
          </div>
          <p className="mt-4 flex items-start gap-2 text-body text-content">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>{t('add.result.warning')}</span>
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Button
              variant="secondary"
              size="lg"
              icon={Download}
              onClick={() => downloadConfig(result)}
              className="w-full sm:w-auto"
            >
              {t('add.result.download')}
            </Button>
            <Button
              variant="secondary"
              size="lg"
              icon={Copy}
              onClick={() => void copyConfig(result)}
              className="w-full sm:w-auto"
            >
              {t('add.result.copy')}
            </Button>
          </div>
          <div className="mt-8 border-t border-border-subtle pt-4">
            <Link to="/me" onClick={() => setResult(null)} className={cn(SECONDARY_LARGE, 'w-full sm:w-auto')}>
              {t('add.result.back')}
            </Link>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('add.title')} description={t('add.description')} />
      <ol className="mb-6 list-decimal space-y-1 ps-5 text-body text-muted">
        <li>{t('add.step1')}</li>
        <li>{t('add.step2')}</li>
        <li>{t('add.step3')}</li>
      </ol>

      {alert && (
        <div
          ref={alertRef}
          role="alert"
          tabIndex={-1}
          className="mb-6 flex items-start gap-2 rounded-card border border-danger/40 bg-danger-subtle p-3 text-body text-content focus-visible:outline-focus"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <p>{t(`add.error.${alert}`)}</p>
        </div>
      )}

      <form onSubmit={onSubmit} noValidate className="space-y-6">
        <FormField label={t('add.name')} hint={t('add.nameHint')} error={nameError} required>
          <Input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" className="h-11" />
        </FormField>
        <Button
          type="submit"
          variant="primary"
          size="lg"
          loading={busy}
          loadingLabel={t('add.working')}
          className="w-full sm:w-auto"
        >
          {busy ? t('add.working') : t('add.submit')}
        </Button>
      </form>

      <div className="mt-8 border-t border-border-subtle pt-4">
        <Link to="/me" className={cn(SECONDARY_LARGE, 'w-full sm:w-auto')}>
          {t('add.result.back')}
        </Link>
      </div>
    </>
  );
}
