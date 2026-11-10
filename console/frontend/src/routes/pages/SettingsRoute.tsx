import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../context/AuthContext';
import { useSetProfileGateway } from '../../services/queries/devices';
import { useNodes } from '../../services/queries/nodes';
import { canChooseGateway } from '../../services/roles';
import { ApiError } from '../../services/apiClient';
import { useOrganization, useOrganizationModules, useUpdateOrganizationSettings } from '../../services/queries/users';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorState,
  FormField,
  Input,
  PageHeader,
  Select,
  Skeleton,
  useToast
} from '../../ui';

const MIN_STALENESS_SECONDS = 60;

// A device's public endpoint: a host (letters, digits, dots, brackets, colons, hyphens) and a port.
const ENDPOINT_PATTERN = /^[A-Za-z0-9.[\]:-]{1,255}:([0-9]{1,5})$/;

export function isValidGatewayEndpoint(value: string): boolean {
  const match = ENDPOINT_PATTERN.exec(value.trim());
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}

/**
 * Which device serves the phones and computers that join with the WireGuard app. Only a
 * platform administrator or an administrator may choose it (routes/devices.js checks users.role).
 * The saved endpoint is the one the server holds; nothing here is invented.
 */
function GatewayCard({ user }: { user: Parameters<typeof canChooseGateway>[0] }) {
  const { t } = useTranslation(['settings', 'ui']);
  const { notify } = useToast();
  const nodes = useNodes();
  const setGateway = useSetProfileGateway();
  const list = nodes.data ?? [];
  const current = list.find((n) => Boolean(n.profile_gateway_endpoint));
  const candidates = list.filter((n) => n.device_kind !== 'profile');
  const mayChoose = canChooseGateway(user);

  const [nodeId, setNodeId] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Start from the device that is already the gateway, or the first device that can be one.
  useEffect(() => {
    if (!nodeId && candidates[0]) setNodeId(candidates[0].id);
  }, [candidates, nodeId]);
  const savedEndpoint = current?.profile_gateway_endpoint ?? '';
  // Show the server's endpoint when it changes; clearing the field does not bring it back.
  // Once the person has typed, the server value no longer replaces their text.
  const endpointEdited = useRef(false);
  useEffect(() => {
    if (savedEndpoint && !endpointEdited.current) setEndpoint(savedEndpoint);
  }, [savedEndpoint]);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!isValidGatewayEndpoint(endpoint)) {
      setError(t('gateway.endpointInvalid'));
      return;
    }
    try {
      await setGateway.mutateAsync({ node_id: nodeId, endpoint: endpoint.trim() });
      notify(t('gateway.saved'), { tone: 'success' });
    } catch {
      setError(t('gateway.failed'));
    }
  };

  return (
    <Card>
      <CardHeader as="h2" title={t('gateway.title')} description={t('gateway.body')} />
      <p className="text-caption text-subtle">
        {current?.profile_gateway_endpoint
          ? t('gateway.current', {
              name: current.name || current.id,
              endpoint: current.profile_gateway_endpoint
            })
          : t('gateway.none')}
      </p>
      {mayChoose ? (
        <form onSubmit={save} className="space-y-4 pt-3">
          <FormField label={t('gateway.node')}>
            <Select
              value={nodeId}
              onValueChange={setNodeId}
              options={candidates.map((n) => ({
                value: n.id,
                label: `${n.name || n.id} (${n.overlay_ipv4 || '—'})`
              }))}
            />
          </FormField>
          <FormField label={t('gateway.endpoint')} hint={t('gateway.endpointHint')}>
            <Input
              value={endpoint}
              onChange={(e) => {
                endpointEdited.current = true;
                setEndpoint(e.target.value);
              }}
              mono
            />
          </FormField>
          {error && (
            <p role="alert" className="text-caption text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="secondary" loading={setGateway.isPending} disabled={!nodeId}>
            {t('gateway.save')}
          </Button>
        </form>
      ) : (
        <p className="pt-3 text-caption text-subtle">{t('gateway.onlyAdmin')}</p>
      )}
    </Card>
  );
}

/**
 * The organisation's settings, read from and written to the control plane.
 *
 * This page used to be a form of switches -- onion circuits, ShadowTLS, VLESS
 * Reality, port hopping, MTU, cipher suite -- held in local state, whose "Apply"
 * button waited 400 ms and said it was done. None of it reached the control plane,
 * and several of the options did not exist anywhere. It now shows only settings the
 * control plane applies, and saves them with PUT /api/organizations/:id.
 */
export default function SettingsRoute() {
  const { t } = useTranslation(['settings', 'ui']);
  const { user } = useAuth();
  const { notify } = useToast();
  const orgId = (user?.organization_id as string | undefined) || 'org-default';

  const org = useOrganization(orgId);
  const modules = useOrganizationModules(orgId);
  const update = useUpdateOrganizationSettings(orgId);

  const [policy, setPolicy] = useState<'open' | 'deny'>('deny');
  const [staleness, setStaleness] = useState('');

  useEffect(() => {
    if (!org.data) return;
    setPolicy(org.data.default_policy ?? 'deny');
    setStaleness(String(org.data.max_netmap_staleness_seconds ?? ''));
  }, [org.data]);

  const stalenessValue = Number(staleness);
  const stalenessInvalid =
    staleness !== '' && (!Number.isInteger(stalenessValue) || stalenessValue < MIN_STALENESS_SECONDS);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (stalenessInvalid) return;
    try {
      await update.mutateAsync({
        default_policy: policy,
        ...(staleness !== '' ? { max_netmap_staleness_seconds: stalenessValue } : {})
      });
      notify(t('saved'), { tone: 'success' });
    } catch (err) {
      const message = err instanceof ApiError && err.status === 403 ? t('forbidden') : t('failed');
      notify(message, { tone: 'danger' });
    }
  };

  if (org.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('title')} description={t('description')} />
        <ErrorState title={t('loadError')} detail={org.error.message} onRetry={() => org.refetch()} />
      </div>
    );
  }

  const regulated = org.data?.profile === 'regulated';

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />

      {org.isLoading ? (
        <Skeleton lines={6} />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader as="h2" title={t('sectionPolicy')} description={t('sectionPolicyDesc')} />
            <form onSubmit={save} className="space-y-4">
              <FormField label={t('fieldPolicy')}>
                <Select
                  value={policy}
                  onValueChange={(value) => setPolicy(value === 'open' ? 'open' : 'deny')}
                  options={[
                    { value: 'deny', label: t('policyDeny') },
                    { value: 'open', label: t('policyOpen') }
                  ]}
                />
              </FormField>

              <FormField
                label={t('fieldStaleness')}
                hint={t('fieldStalenessHint')}
                error={stalenessInvalid ? t('stalenessInvalid') : null}
              >
                <Input
                  type="number"
                  min={MIN_STALENESS_SECONDS}
                  step={1}
                  mono
                  value={staleness}
                  invalid={stalenessInvalid}
                  onChange={(e) => setStaleness(e.target.value)}
                />
              </FormField>

              <Button type="submit" loading={update.isPending} loadingLabel={t('saving')} disabled={stalenessInvalid}>
                {t('btnSave')}
              </Button>
            </form>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader
                as="h2"
                title={t('sectionProfile')}
                actions={
                  <Badge tone={regulated ? 'warning' : 'neutral'}>
                    {regulated ? t('profileRegulated') : t('profileStandard')}
                  </Badge>
                }
              />
              <p className="text-caption text-subtle">
                {regulated ? t('profileRegulatedDesc') : t('profileStandardDesc')}
              </p>
            </Card>

            <GatewayCard user={user} />

            <Card>
              <CardHeader as="h2" title={t('sectionModules')} />
              {modules.isLoading ? (
                <Skeleton lines={3} />
              ) : (
                <ul className="space-y-2">
                  {(modules.data ?? []).map((m) => (
                    <li key={m.module_id} className="flex items-center justify-between font-mono text-caption">
                      <span className="text-content">{m.module_id}</span>
                      <Badge tone={m.enabled ? 'success' : 'neutral'}>
                        {m.enabled ? t('moduleOn') : t('moduleOff')}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader as="h2" title={t('sectionTransport')} />
              <p className="text-caption text-subtle">{t('transportBody')}</p>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
