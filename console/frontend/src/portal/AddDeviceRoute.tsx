import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, AlertTriangle, Copy, Download, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { generateDeviceKeys, KeyGenerationUnavailable } from '../devices/keys';
import { QrCode } from '../devices/QrCode';
import {
  buildProfileConfig,
  buildStrictNetworkConfig,
  configFileName,
  strictConfigFileName,
  type StrictNetwork
} from '../devices/wgConfig';
import { ApiError } from '../services/apiClient';
import { useProfileExits, useRegisterProfileDevice, type ProfileExit } from '../services/queries/devices';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { cn } from '../ui/cn';
import { FormField } from '../ui/FormField';
import { Input } from '../ui/Input';
import { PageHeader } from '../ui/PageHeader';
import { Select } from '../ui/Select';
import { useToast } from '../ui/Toast';
import { StrictNetworkSection } from './StrictNetworkSection';

const NAME_MIN = 1;
const NAME_MAX = 64;
const SECONDARY_LARGE =
  'inline-flex h-11 items-center justify-center gap-2 rounded-control border border-border-strong bg-surface-raised px-4 text-body font-medium text-content hover:bg-surface-hover focus-visible:outline-focus';

type AlertKind = 'noCrypto' | 'noGateway' | 'keyInUse' | 'exitNotPermitted' | 'exitGone' | 'generic';

interface Result {
  name: string;
  /** The exit every packet leaves through, when the profile is full-tunnel. */
  exitName?: string;
  /** The WireGuard configuration text, which holds the private key. Kept in memory only. */
  config: string;
  /** The same profile for networks that block VPNs, when the installation offers it. Memory only. */
  strict: { info: StrictNetwork; config: string } | null;
}

function alertKindFor(error: unknown): AlertKind {
  if (error instanceof KeyGenerationUnavailable) return 'noCrypto';
  if (error instanceof ApiError && error.status === 403 && error.code === 'exit_not_permitted')
    return 'exitNotPermitted';
  if (error instanceof ApiError && error.status === 404 && error.code === 'no_such_exit') return 'exitGone';
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
  const exitsQuery = useProfileExits();
  const exits: ProfileExit[] = Array.isArray(exitsQuery.data?.exits) ? exitsQuery.data.exits : [];
  const canChoose = exitsQuery.data?.can_choose === true;
  const [fullTunnel, setFullTunnel] = useState(false);
  const [exitId, setExitId] = useState<string | undefined>(undefined);
  const chosenExit = exits.find((e) => e.node_id === exitId) ?? exits[0];
  const resultId = useId();
  const exitHintId = useId();
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
      const exitNodeId = fullTunnel && canChoose && chosenExit ? chosenExit.node_id : undefined;
      const device = await register.mutateAsync({
        name: trimmed,
        public_key: keys.publicKey,
        preshared_key: keys.presharedKey,
        ...(exitNodeId ? { exit_node_id: exitNodeId } : {})
      });
      const strictInfo = device.strict_network ?? null;
      setResult({
        name: trimmed,
        exitName: device.exit?.name,
        config: buildProfileConfig(keys, device),
        strict: strictInfo ? { info: strictInfo, config: buildStrictNetworkConfig(keys, device, strictInfo) } : null
      });
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

  function downloadConfig(text: string, fileName: string) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
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
          {result.exitName && (
            <div className="mt-4 rounded-card border border-border-subtle bg-surface-raised p-3 text-body text-content">
              <p className="flex items-start gap-2">
                <Globe aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                <span>{t('add.exit.resultNote', { name: result.name, exit: result.exitName })}</span>
              </p>
              <p className="mt-2 text-muted">{t('add.exit.lanNote')}</p>
            </div>
          )}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Button
              variant="secondary"
              size="lg"
              icon={Download}
              onClick={() => downloadConfig(result.config, configFileName(result.name))}
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
          {result.strict && (
            <StrictNetworkSection
              strict={result.strict.info}
              onDownload={() =>
                result.strict && downloadConfig(result.strict.config, strictConfigFileName(result.name))
              }
            />
          )}
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
        {exitsQuery.isSuccess && (
          <fieldset className="space-y-3 rounded-card border border-border-subtle p-4">
            <legend className="px-1 text-label font-medium text-content">{t('add.exit.legend')}</legend>
            <Checkbox
              label={t('add.exit.toggle')}
              checked={fullTunnel && canChoose && exits.length > 0}
              disabled={!canChoose || exits.length === 0}
              onChange={(event) => setFullTunnel(event.target.checked)}
              aria-describedby={exitHintId}
            />
            <p id={exitHintId} className="text-body text-muted">
              {exits.length === 0 ? t('add.exit.none') : !canChoose ? t('add.exit.notAllowed') : t('add.exit.hint')}
            </p>
            {fullTunnel && canChoose && chosenExit && (
              <>
                <FormField label={t('add.exit.picker')}>
                  <Select
                    value={chosenExit.node_id}
                    onValueChange={setExitId}
                    options={exits.map((e) => ({
                      value: e.node_id,
                      label:
                        t(e.kind === 'gateway' ? 'add.exit.optionGateway' : 'add.exit.optionNode', {
                          name: e.name
                        }) + (e.online ? '' : t('add.exit.offline'))
                    }))}
                    className="h-11"
                  />
                </FormField>
                <ul className="list-disc space-y-1 ps-5 text-body text-muted">
                  <li>{t('add.exit.privacy')}</li>
                  <li>{t('add.exit.down')}</li>
                  <li>{t('add.exit.lanNote')}</li>
                </ul>
              </>
            )}
          </fieldset>
        )}
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
