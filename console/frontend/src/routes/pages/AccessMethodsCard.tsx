import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../services/apiClient';
import {
  useAccessMethods,
  usePreviewAccessMethods,
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
  const preview = usePreviewAccessMethods(orgId);
  const [blocked, setBlocked] = useState<Array<{ id: string; name: string | null }> | null>(null);
  const [asking, setAsking] = useState<{
    next: Pick<AccessMethodsSettings, 'wireguard_wss' | 'amneziawg'>;
    devices: Array<{ id: string; name: string | null }>;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const data = settings.data;
  const role = effectiveRole(user);
  const mayManage = role === 'super-admin' || role === 'owner' || role === 'admin';

  async function commit(
    next: Pick<AccessMethodsSettings, 'wireguard_wss' | 'amneziawg'>,
    firstTimeAwg: boolean,
    confirmReimport = false
  ) {
    try {
      await save.mutateAsync(confirmReimport ? { ...next, confirm_reimport: true } : next);
      notify(firstTimeAwg ? t('accessMethods.generated') : t('accessMethods.saved'), { tone: 'success' });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'would_strand_devices') {
        const body = (error.details ?? {}) as { devices?: Array<{ id: string; name: string | null }> };
        setBlocked(body.devices ?? []);
      } else {
        notify(error instanceof ApiError && error.status === 403 ? t('forbidden') : t('accessMethods.failed'), {
          tone: 'danger'
        });
      }
    } finally {
      setAsking(null);
    }
  }

  // Switching a method off can strand devices or make profiles useless: the server says who first.
  async function change(next: Pick<AccessMethodsSettings, 'wireguard_wss' | 'amneziawg'>, firstTimeAwg: boolean) {
    setBlocked(null);
    const turnsOff =
      (data?.wireguard_wss === true && !next.wireguard_wss) || (data?.amneziawg === true && !next.amneziawg);
    if (!turnsOff) return commit(next, firstTimeAwg);
    try {
      const plan = await preview.mutateAsync(next);
      if (plan.strands_total > 0) return setBlocked(plan.strands);
      if (plan.reimport_total > 0) return setAsking({ next, devices: plan.reimport });
    } catch {
      return notify(t('accessMethods.failed'), { tone: 'danger' });
    }
    return commit(next, false);
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
          {blocked && (
            <div role="alert" className="space-y-1 rounded-plate border border-danger/40 bg-danger/10 p-3 text-body">
              <p className="font-medium">{t('accessMethods.blockedTitle', { count: blocked.length })}</p>
              <p className="text-caption">{blocked.map((d) => d.name || d.id).join(', ')}</p>
              <p className="text-caption text-subtle">{t('accessMethods.blockedBody')}</p>
            </div>
          )}
          {!mayManage && <p className="text-caption text-subtle">{t('accessMethods.onlyAdmin')}</p>}
        </div>
      )}

      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title={t('accessMethods.reimportTitle', { count: asking?.devices.length ?? 0 })}
        description={t('accessMethods.reimportBody', {
          devices: asking ? asking.devices.map((d) => d.name || d.id).join(', ') : ''
        })}
        confirmLabel={t('accessMethods.reimportConfirm')}
        cancelLabel={t('accessMethods.reimportCancel')}
        tone="danger"
        onConfirm={() => asking && void commit(asking.next, false, true)}
        busy={save.isPending}
      />

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
