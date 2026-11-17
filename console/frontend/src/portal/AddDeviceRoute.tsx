import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../context/AuthContext';
import { generateDeviceKeys, KeyGenerationUnavailable } from '../devices/keys';
import { buildProfileConfig, buildStrictNetworkConfig } from '../devices/wgConfig';
import { ApiError } from '../services/apiClient';
import { useProfileExits, useRegisterProfileDevice } from '../services/queries/devices';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import { FormField } from '../ui/FormField';
import { Input } from '../ui/Input';
import { PageHeader } from '../ui/PageHeader';
import { Select } from '../ui/Select';
import { Switch } from '../ui/Switch';
import { AddResult, type AddResultData } from './AddResult';
import { detectPlatform, type Platform } from './platform';
import { PlatformPicker } from './PlatformPicker';

const NAME_MIN = 1;
const NAME_MAX = 64;
const SECONDARY_LARGE =
  'inline-flex h-11 items-center justify-center gap-2 rounded-control border border-border-strong bg-surface-raised px-4 text-body font-medium text-content hover:bg-surface-hover focus-visible:outline-focus';

type AlertKind = 'noCrypto' | 'noGateway' | 'keyInUse' | 'exitNotPermitted' | 'exitGone' | 'generic';

function alertKindFor(error: unknown): AlertKind {
  if (error instanceof KeyGenerationUnavailable) return 'noCrypto';
  if (error instanceof ApiError && error.status === 403 && error.code === 'exit_not_permitted')
    return 'exitNotPermitted';
  if (error instanceof ApiError && error.status === 404 && error.code === 'no_such_exit') return 'exitGone';
  if (error instanceof ApiError && error.status === 409) {
    // Older servers name the reason only in `error`; the message is that same word then.
    const reason = error.code ?? error.message;
    if (reason === 'no_profile_gateway') return 'noGateway';
    // Only a taken key is "key already in use"; any other conflict is a plain retry.
    return reason === 'public_key_in_use' ? 'keyInUse' : 'generic';
  }
  return 'generic';
}

/**
 * Adds a phone or computer, platform first: which device, a name, one button.
 * The keys are made here, in the browser; only the name and the two public
 * values go to the server. What comes back is shown once by AddResult.
 */
export default function AddDeviceRoute() {
  const { t } = useTranslation('portal');
  const { user } = useAuth();
  const location = useLocation();
  const register = useRegisterProfileDevice();
  const exitsQuery = useProfileExits();
  const exits = useMemo(
    () => (Array.isArray(exitsQuery.data?.exits) ? exitsQuery.data.exits : []),
    [exitsQuery.data?.exits]
  );
  // The choice is offered only when the server offers it: no exits, or no right to choose, and it is not mentioned.
  const offersExit = exitsQuery.isSuccess && exitsQuery.data.can_choose === true && exits.length > 0;

  const detected = useMemo(() => detectPlatform(), []);
  const [platform, setPlatform] = useState<Platform | null>(detected);
  const [platformError, setPlatformError] = useState(false);
  // "Rifai l'accesso" arrives here with the old name, so the new access keeps it.
  const carriedName = (location.state as { name?: unknown } | null)?.name;
  const [customName, setCustomName] = useState<string | null>(typeof carriedName === 'string' ? carriedName : null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [fullTunnel, setFullTunnel] = useState(false);
  const [exitId, setExitId] = useState<string | undefined>(undefined);
  const [alert, setAlert] = useState<AlertKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddResultData | null>(null);
  const alertRef = useRef<HTMLDivElement>(null);

  const chosenExit = exits.find((e) => e.node_id === exitId) ?? exits.find((e) => e.online) ?? exits[0];
  const username = user?.username ?? '';
  const defaultName = platform
    ? (username ? t(`add.defaultName.${platform}`, { user: username }) : t(`add.platform.${platform}`)).slice(
        0,
        NAME_MAX
      )
    : '';
  const name = customName ?? defaultName;

  // Focus goes to a failure so that a screen reader and a keyboard both land on it.
  useEffect(() => {
    if (alert) alertRef.current?.focus();
  }, [alert]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!platform) {
      setPlatformError(true);
      return;
    }
    setPlatformError(false);
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
      const exitNodeId = fullTunnel && offersExit && chosenExit ? chosenExit.node_id : undefined;
      const device = await register.mutateAsync({
        name: trimmed,
        public_key: keys.publicKey,
        preshared_key: keys.presharedKey,
        ...(exitNodeId ? { exit_node_id: exitNodeId } : {})
      });
      const strictInfo = device.strict_network ?? null;
      setResult({
        deviceId: device.device_id,
        name: trimmed,
        platform,
        sameDevice: detected === platform,
        exitName: device.exit?.name,
        config: buildProfileConfig(keys, device),
        strict: strictInfo ? { info: strictInfo, config: buildStrictNetworkConfig(keys, device, strictInfo) } : null
      });
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

  if (result) {
    return (
      <>
        <PageHeader title={t('add.title')} />
        <AddResult result={result} />
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('add.title')} description={t('add.description')} />

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

      <form onSubmit={onSubmit} noValidate className="space-y-8">
        <fieldset>
          <legend className="text-heading font-medium text-content">{t('add.platform.legend')}</legend>
          <div className="mt-3">
            <PlatformPicker
              value={platform}
              onChange={(next) => {
                setPlatform(next);
                setPlatformError(false);
              }}
              detected={detected}
            />
          </div>
          {platformError && (
            <p role="alert" className="mt-2 text-body text-danger">
              {t('add.platform.required')}
            </p>
          )}
        </fieldset>

        <FormField label={t('add.name')} hint={t('add.nameHint')} error={nameError} required>
          <Input
            value={name}
            onChange={(event) => setCustomName(event.target.value)}
            autoComplete="off"
            className="h-11"
          />
        </FormField>

        {offersExit && (
          <div className="space-y-3">
            <Switch
              checked={fullTunnel}
              onCheckedChange={setFullTunnel}
              label={t('add.exit.toggle')}
              description={t('add.exit.hint')}
            />
            {fullTunnel && (
              <>
                {exits.length > 1 && chosenExit && (
                  <FormField label={t('add.exit.picker')}>
                    <Select
                      value={chosenExit.node_id}
                      onValueChange={setExitId}
                      options={exits.map((e) => ({
                        value: e.node_id,
                        label: e.name + (e.online ? '' : t('add.exit.offline'))
                      }))}
                      className="h-11"
                    />
                  </FormField>
                )}
                <p className="text-body text-muted">{t('add.exit.privacy')}</p>
              </>
            )}
          </div>
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
          {t('add.cancel')}
        </Link>
      </div>
    </>
  );
}
