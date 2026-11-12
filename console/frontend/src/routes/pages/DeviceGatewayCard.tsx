import { useContext, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AuthContext from '../../context/AuthContext';
import { useMoveDeviceGateway, useProfileGateways, type MoveDeviceAnswer } from '../../services/queries/devices';
import { canChooseGateway } from '../../services/roles';
import type { MeshNode } from '../../services/types';
import { Button, Card, CardHeader, CodeText, ConfirmDialog, FormField, Select, Skeleton } from '../../ui';

/**
 * The gateway a WireGuard-app device connects through, and, for an administrator, a way
 * to move it to another gateway of the organisation. A stock WireGuard profile names one
 * gateway (one [Peer], one Endpoint) and the server never holds the device's private key,
 * so after a move the person must import a new profile: the page says so before and after.
 */
export function DeviceGatewayCard({ device }: { device: MeshNode }) {
  const { t } = useTranslation('nodes');
  // Read without useAuth: the Devices page is also rendered without a session provider in
  // tests, and an absent session simply means "may not move".
  const auth = useContext(AuthContext);
  const mayMove = canChooseGateway(auth?.user ?? null);
  const gateways = useProfileGateways();
  const move = useMoveDeviceGateway();

  const list = gateways.data ?? [];
  const current = list.find((g) => g.node_id === device.gateway_node_id) ?? list.find((g) => g.is_default) ?? null;
  const others = useMemo(() => list.filter((g) => g.node_id !== current?.node_id), [list, current]);
  const deviceName = device.name || device.id;

  const [target, setTarget] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [moved, setMoved] = useState<MoveDeviceAnswer | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!others.some((g) => g.node_id === target)) setTarget(others[0]?.node_id ?? '');
  }, [others, target]);

  const targetName = others.find((g) => g.node_id === target)?.name ?? '';

  const confirmMove = async () => {
    setFailed(false);
    try {
      const answer = await move.mutateAsync({ deviceId: device.id, gatewayId: target });
      setMoved(answer);
    } catch {
      setFailed(true);
    } finally {
      setConfirmOpen(false);
    }
  };

  return (
    <Card className="p-4">
      <CardHeader as="h2" title={t('gateway.title')} />
      <div className="mt-3 flex flex-col gap-3 text-sm">
        {gateways.isLoading ? (
          <Skeleton lines={2} />
        ) : gateways.isError ? (
          <p className="text-muted">{t('gateway.loadFailed')}</p>
        ) : current ? (
          <p className="font-medium">{t('gateway.current', { name: current.name, endpoint: current.endpoint })}</p>
        ) : (
          <p className="text-muted">{t('gateway.none')}</p>
        )}

        {moved && (
          <div role="status" className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning-subtle p-3">
            <p>
              {moved.reimport_required
                ? t('gateway.done', { device: deviceName, gateway: moved.gateway.name })
                : t('gateway.unchanged', { device: deviceName, gateway: moved.gateway.name })}
            </p>
            {moved.reimport_required && (
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_1fr] sm:items-center">
                <dt className="text-xs text-muted">{t('gateway.publicKey')}</dt>
                <dd>
                  <CodeText copyable>{moved.gateway.public_key ?? '—'}</CodeText>
                </dd>
                <dt className="text-xs text-muted">{t('gateway.endpoint')}</dt>
                <dd>
                  <CodeText copyable>{moved.gateway.endpoint}</CodeText>
                </dd>
              </dl>
            )}
          </div>
        )}

        {!gateways.isLoading && !gateways.isError && current && (
          <>
            {!mayMove ? (
              <p className="text-muted">{t('gateway.onlyAdmin')}</p>
            ) : others.length === 0 ? (
              <p className="text-muted">{t('gateway.noOther')}</p>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <div className="sm:min-w-[16rem]">
                  <FormField label={t('gateway.moveTo')}>
                    <Select
                      value={target}
                      onValueChange={setTarget}
                      options={others.map((g) => ({ value: g.node_id, label: `${g.name} (${g.endpoint})` }))}
                    />
                  </FormField>
                </div>
                <Button variant="secondary" disabled={!target} onClick={() => setConfirmOpen(true)}>
                  {t('gateway.move')}
                </Button>
              </div>
            )}
          </>
        )}

        {failed && (
          <p role="alert" className="font-medium text-danger">
            {t('gateway.failed')}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('gateway.confirmTitle', { device: deviceName, gateway: targetName })}
        description={t('gateway.warning')}
        confirmLabel={t('gateway.move')}
        cancelLabel={t('gateway.keep')}
        onConfirm={() => void confirmMove()}
        busy={move.isPending}
      />
    </Card>
  );
}
