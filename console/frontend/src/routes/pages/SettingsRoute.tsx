import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../context/AuthContext';
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
  const { t } = useTranslation();
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
      notify(t('settings.saved'), { tone: 'success' });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 403
          ? t('settings.forbidden')
          : err instanceof Error
            ? err.message
            : String(err);
      notify(message, { tone: 'danger' });
    }
  };

  if (org.isError) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />
        <ErrorState title={t('settings.loadError')} detail={org.error.message} onRetry={() => org.refetch()} />
      </div>
    );
  }

  const regulated = org.data?.profile === 'regulated';

  return (
    <div className="space-y-6">
      <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />

      {org.isLoading ? (
        <Skeleton lines={6} />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader as="h2" title={t('settings.sectionPolicy')} description={t('settings.sectionPolicyDesc')} />
            <form onSubmit={save} className="space-y-4">
              <FormField label={t('settings.fieldPolicy')}>
                <Select
                  value={policy}
                  onValueChange={(value) => setPolicy(value === 'open' ? 'open' : 'deny')}
                  options={[
                    { value: 'deny', label: t('settings.policyDeny') },
                    { value: 'open', label: t('settings.policyOpen') }
                  ]}
                />
              </FormField>

              <FormField
                label={t('settings.fieldStaleness')}
                hint={t('settings.fieldStalenessHint')}
                error={stalenessInvalid ? t('settings.stalenessInvalid') : null}
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

              <Button
                type="submit"
                loading={update.isPending}
                loadingLabel={t('settings.saving')}
                disabled={stalenessInvalid}
              >
                {t('settings.btnSave')}
              </Button>
            </form>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader
                as="h2"
                title={t('settings.sectionProfile')}
                actions={
                  <Badge tone={regulated ? 'warning' : 'neutral'}>
                    {regulated ? t('settings.profileRegulated') : t('settings.profileStandard')}
                  </Badge>
                }
              />
              <p className="text-caption text-subtle">
                {regulated ? t('settings.profileRegulatedDesc') : t('settings.profileStandardDesc')}
              </p>
            </Card>

            <Card>
              <CardHeader as="h2" title={t('settings.sectionModules')} />
              {modules.isLoading ? (
                <Skeleton lines={3} />
              ) : (
                <ul className="space-y-2">
                  {(modules.data ?? []).map((m) => (
                    <li key={m.module_id} className="flex items-center justify-between font-mono text-caption">
                      <span className="text-content">{m.module_id}</span>
                      <Badge tone={m.enabled ? 'success' : 'neutral'}>
                        {m.enabled ? t('settings.moduleOn') : t('settings.moduleOff')}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardHeader as="h2" title={t('settings.sectionTransport')} />
              <p className="text-caption text-subtle">{t('settings.transportBody')}</p>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
