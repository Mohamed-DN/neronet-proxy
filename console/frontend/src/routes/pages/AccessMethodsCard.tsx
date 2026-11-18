import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../services/apiClient';
import {
  useAccessMethods,
  useRegenerateAwgParams,
  useSetAccessMethods,
  type AccessMethodsSettings
} from '../../services/queries/accessMethods';
import { effectiveRole } from '../../services/roles';
import { Button, Card, CardHeader, ConfirmDialog, ErrorState, Skeleton, Switch, useToast } from '../../ui';

type RoleUser = Parameters<typeof effectiveRole>[0];

/**
 * The ways people can connect a phone or computer (ADR 0036). Plain WireGuard is always on;
 * an owner or administrator switches the other two. Turning AmneziaWG on makes the secret
 * parameters once (the server never shows them here); regenerating them is a decision that
 * breaks every AmneziaWG profile already handed out, so it asks first.
 */
export function AccessMethodsCard({ orgId, user }: { orgId: string; user: RoleUser }) {
  const { t } = useTranslation(['settings', 'ui']);
  const { notify } = useToast();
  const settings = useAccessMethods(orgId);
  const save = useSetAccessMethods(orgId);
  const regenerate = useRegenerateAwgParams(orgId);
  const [confirming, setConfirming] = useState(false);
  const role = effectiveRole(user);
  const mayManage = role === 'super-admin' || role === 'owner' || role === 'admin';

  async function change(next: Pick<AccessMethodsSettings, 'wireguard_wss' | 'amneziawg'>, firstTimeAwg: boolean) {
    try {
      await save.mutateAsync(next);
      notify(firstTimeAwg ? t('accessMethods.generated') : t('accessMethods.saved'), { tone: 'success' });
    } catch (error) {
      notify(error instanceof ApiError && error.status === 403 ? t('forbidden') : t('accessMethods.failed'), {
        tone: 'danger'
      });
    }
  }

  async function doRegenerate() {
    try {
      const done = await regenerate.mutateAsync();
      setConfirming(false);
      notify(t('accessMethods.regenerated', { count: done.devices_to_redo }), { tone: 'success' });
    } catch {
      setConfirming(false);
      notify(t('accessMethods.failed'), { tone: 'danger' });
    }
  }

  const data = settings.data;
  return (
    <Card>
      <CardHeader as="h2" title={t('accessMethods.title')} description={t('accessMethods.body')} />
      {settings.isLoading ? (
        <Skeleton lines={3} />
      ) : settings.isError || !data ? (
        <ErrorState
          title={t('accessMethods.loadError')}
          detail={settings.error?.message}
          onRetry={() => settings.refetch()}
        />
      ) : (
        <div className="space-y-4">
          <Switch
            checked={data.wireguard_wss}
            disabled={!mayManage || save.isPending}
            onCheckedChange={(on) => void change({ wireguard_wss: on, amneziawg: data.amneziawg }, false)}
            label={t('accessMethods.wss')}
            description={t('accessMethods.wssHint')}
          />
          <Switch
            checked={data.amneziawg}
            disabled={!mayManage || save.isPending}
            onCheckedChange={(on) =>
              void change({ wireguard_wss: data.wireguard_wss, amneziawg: on }, on && !data.amneziawg_ready)
            }
            label={t('accessMethods.awg')}
            description={t('accessMethods.awgHint')}
          />
          {data.amneziawg && (
            <div className="space-y-2 border-t border-border-subtle pt-4">
              <p className="text-caption text-subtle">{t('accessMethods.regenerateBody')}</p>
              {mayManage && (
                <Button variant="secondary" onClick={() => setConfirming(true)}>
                  {t('accessMethods.regenerate')}
                </Button>
              )}
            </div>
          )}
          {!mayManage && <p className="text-caption text-subtle">{t('accessMethods.onlyAdmin')}</p>}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('accessMethods.regenerateTitle')}
        description={t('accessMethods.regenerateWarning')}
        confirmLabel={t('accessMethods.regenerateConfirm')}
        cancelLabel={t('accessMethods.regenerateCancel')}
        tone="danger"
        onConfirm={() => void doRegenerate()}
        busy={regenerate.isPending}
      />
    </Card>
  );
}
