import { useTranslation } from 'react-i18next';

import {
  useDeviceConnectionOrder,
  usePreviewConnectionOrder,
  useSetDeviceConnectionOrder,
  type OrderChange
} from '../../services/queries/connectionOrder';
import type { MeshNode } from '../../services/types';
import { Card, CardHeader, Skeleton, Switch, useToast } from '../../ui';
import { ConnectionOrderEditor, orderSentence, originLabel } from './ConnectionOrderEditor';

type T = (key: string, options?: Record<string, unknown>) => string;

/**
 * Device detail, "Connection order" (ADR 0037): the order this device walks, inherited from its
 * line or the organisation unless set here. An administrator may set and lock it; the owner may
 * set it when the organisation lets members choose and nothing above is locked.
 */
export function DeviceConnectionOrderCard({ device }: { device: MeshNode }) {
  const { t } = useTranslation('connection');
  const tt = t as unknown as T;
  const { notify } = useToast();
  const query = useDeviceConnectionOrder(device.id);
  const save = useSetDeviceConnectionOrder(device.id);
  const preview = usePreviewConnectionOrder();
  const data = query.data;

  // The card is an extra on the detail page: while it loads, or if the person may not see it
  // (a device that is not theirs), it takes no room beyond a skeleton and shows no error.
  if (query.isLoading) {
    return (
      <Card className="p-4">
        <CardHeader as="h2" title={t('device.title')} />
        <Skeleton lines={3} />
      </Card>
    );
  }
  if (query.isError || !data || !Array.isArray(data.allowed)) return null;

  const lineName = data.line?.name ?? null;
  const inheritLabel =
    data.inherited.origin.scope === 'default'
      ? t('device.inheritDefault')
      : t('device.inherit', { from: originLabel(tt, data.inherited.origin) });

  async function onSave(next: OrderChange) {
    await save.mutateAsync(next);
    notify(t('saved'), { tone: 'success' });
  }

  async function setLocked(locked: boolean) {
    try {
      await save.mutateAsync({ locked });
      notify(t('saved'), { tone: 'success' });
    } catch {
      notify(t('failed'), { tone: 'danger' });
    }
  }

  return (
    <Card className="p-4">
      <CardHeader as="h2" title={t('device.title')} description={t('device.body')} />
      <div className="space-y-4 text-sm">
        <p className="text-body">
          {t('summary.now', {
            order: orderSentence(tt, data.effective.order, data.effective.forced),
            origin: originLabel(tt, data.effective.origin)
          })}
        </p>
        <p className="text-caption text-subtle">
          {t('device.profileMethod', { method: t(`method.${data.access_method}.short`) })}
        </p>
        {!data.effective.usable && (
          <p role="alert" className="font-medium text-danger">
            {t('device.noPath')}
          </p>
        )}
        {data.effective.person_blocked === 'locked' && (
          <p className="text-caption text-subtle">{t('device.lockedNote')}</p>
        )}
        <ConnectionOrderEditor
          idPrefix={`device-order-${device.id}`}
          allowed={data.allowed}
          own={data.own}
          inherited={{ order: data.inherited.order, origin: data.inherited.origin }}
          inheritLabel={inheritLabel}
          available={data.available}
          mayEdit={data.can_edit}
          readOnlyNote={data.own.locked || data.line?.locked ? t('device.lockedNote') : t('device.readOnly')}
          onPreview={(next) => preview.mutateAsync({ scope: 'device', id: device.id, settings: next })}
          onSave={onSave}
        />
        {data.can_lock && (
          <div className="border-t border-border-subtle pt-4">
            <Switch
              checked={data.own.locked}
              disabled={save.isPending}
              onCheckedChange={(on) => void setLocked(on)}
              label={t('device.lock')}
              description={lineName ? t('device.lockHintLine', { line: lineName }) : t('device.lockHint')}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
