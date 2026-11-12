import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../context/AuthContext';
import { ApiError } from '../../services/apiClient';
import { useOrganization, useOrganizationModules, useUpdateOrganizationSettings } from '../../services/queries/users';
import { GatewaysCard } from './GatewaysCard';
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

            <Card>
              <CardHeader as="h2" title={t('sectionModules')} />
              {modules.isLoading ? (
                <Skeleton lines={3} />
              ) : (
                <ul className="space-y-2">
                  {(modules.data ?? []).map((m) => (
                    <li key={m.module_id} className="flex items-center justify-between text-caption">
                      <span className="text-content">
                        {t(`moduleNames.${m.module_id}`, { defaultValue: m.module_id })}
                      </span>
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

      {/* The table needs the full width: name, address, default, devices, last seen, actions. */}
      <GatewaysCard user={user} />
    </div>
  );
}
