import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatRelativeTime } from '../../i18n/format';
import { ApiError } from '../../services/apiClient';
import {
  useMakeDefaultGateway,
  useProfileGateways,
  useRemoveGateway,
  useSetProfileGateway,
  type ProfileGateway
} from '../../services/queries/devices';
import { useNodes } from '../../services/queries/nodes';
import { canChooseGateway } from '../../services/roles';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CodeText,
  ConfirmDialog,
  ErrorState,
  FormField,
  Input,
  Select,
  Skeleton,
  StatusBadge,
  Table,
  useToast,
  type TableColumn
} from '../../ui';

// A device's public endpoint: a host (letters, digits, dots, brackets, colons, hyphens) and a port.
const ENDPOINT_PATTERN = /^[A-Za-z0-9.[\]:-]{1,255}:([0-9]{1,5})$/;

export function isValidGatewayEndpoint(value: string): boolean {
  const match = ENDPOINT_PATTERN.exec(value.trim());
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535;
}

/** Why the server refused to remove a gateway, in words the person can act on. */
function removeRefusal(error: unknown, name: string, t: (key: string, options?: object) => string): string {
  if (error instanceof ApiError && error.code === 'profile_gateway_serves_devices') {
    const details = (error.details ?? {}) as { devices?: unknown };
    const count = typeof details.devices === 'number' ? details.devices : 0;
    return t('gateway.servesDevices', { name, count });
  }
  if (error instanceof ApiError && error.code === 'profile_gateway_is_default') {
    return t('gateway.isDefault', { name });
  }
  return t('gateway.failed');
}

/**
 * The devices that serve the phones and computers joining with the WireGuard app. An
 * organisation may have several; new devices join the default one, and an administrator
 * moves a device to another from its page in Devices. Only a platform administrator or an
 * administrator changes this list (routes/devices.js checks users.role); everyone else
 * reads it. Every value shown is the server's.
 */
export function GatewaysCard({ user }: { user: Parameters<typeof canChooseGateway>[0] }) {
  const { t, i18n } = useTranslation(['settings', 'ui']);
  const { notify } = useToast();
  const gateways = useProfileGateways();
  const nodes = useNodes();
  const setGateway = useSetProfileGateway();
  const makeDefault = useMakeDefaultGateway();
  const remove = useRemoveGateway();
  const mayManage = canChooseGateway(user);

  const list = gateways.data ?? [];
  // A device can become a gateway when it is an enrolled node and not one already.
  const candidates = useMemo(
    () => (nodes.data ?? []).filter((n) => n.device_kind !== 'profile' && !list.some((g) => g.node_id === n.id)),
    [nodes.data, list]
  );

  const [nodeId, setNodeId] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProfileGateway | null>(null);

  useEffect(() => {
    if (!candidates.some((n) => n.id === nodeId)) setNodeId(candidates[0]?.id ?? '');
  }, [candidates, nodeId]);

  const add = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (!isValidGatewayEndpoint(endpoint)) {
      setFormError(t('gateway.endpointInvalid'));
      return;
    }
    const node = candidates.find((n) => n.id === nodeId);
    try {
      await setGateway.mutateAsync({ node_id: nodeId, endpoint: endpoint.trim() });
      setEndpoint('');
      notify(t('gateway.added', { name: node?.name || nodeId }), { tone: 'success' });
    } catch {
      setFormError(t('gateway.failed'));
    }
  };

  const handleMakeDefault = async (gateway: ProfileGateway) => {
    setRowError(null);
    try {
      await makeDefault.mutateAsync(gateway.node_id);
      notify(t('gateway.defaultSaved', { name: gateway.name }), { tone: 'success' });
    } catch {
      setRowError(t('gateway.failed'));
    }
  };

  const handleRemove = async () => {
    if (!removing) return;
    const gateway = removing;
    setRowError(null);
    try {
      await remove.mutateAsync(gateway.node_id);
      notify(t('gateway.removed', { name: gateway.name }), { tone: 'success' });
    } catch (error) {
      setRowError(removeRefusal(error, gateway.name, t));
    } finally {
      setRemoving(null);
    }
  };

  const columns: TableColumn<ProfileGateway>[] = [
    {
      id: 'name',
      header: t('gateway.columns.name'),
      cell: (g) => <span className="font-semibold text-content">{g.name}</span>
    },
    {
      id: 'endpoint',
      header: t('gateway.columns.endpoint'),
      cell: (g) => <CodeText>{g.endpoint}</CodeText>
    },
    {
      id: 'default',
      header: t('gateway.columns.default'),
      cell: (g) =>
        g.is_default ? (
          <Badge tone="info">{t('gateway.defaultBadge')}</Badge>
        ) : (
          <span className="text-subtle" aria-hidden="true">
            —
          </span>
        )
    },
    {
      id: 'devices',
      header: t('gateway.columns.devices'),
      numeric: true,
      cell: (g) => <span>{g.devices}</span>
    },
    {
      id: 'lastSeen',
      header: t('gateway.columns.lastSeen'),
      cell: (g) => {
        const when = formatRelativeTime(i18n.language, g.last_seen_at);
        if (!when) return <span className="text-subtle">{t('gateway.never')}</span>;
        return g.online ? <span>{when}</span> : <StatusBadge status="warning" label={t('gateway.offline', { when })} />;
      }
    }
  ];
  if (mayManage) {
    columns.push({
      id: 'actions',
      header: t('gateway.columns.actions'),
      numeric: true,
      cell: (g) => (
        <div className="flex justify-end gap-2">
          {!g.is_default && (
            <Button
              size="sm"
              variant="secondary"
              loading={makeDefault.isPending && makeDefault.variables === g.node_id}
              aria-label={t('gateway.makeDefaultFor', { name: g.name })}
              onClick={() => void handleMakeDefault(g)}
            >
              {t('gateway.makeDefault')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('gateway.removeFor', { name: g.name })}
            onClick={() => setRemoving(g)}
          >
            {t('gateway.remove')}
          </Button>
        </div>
      )
    });
  }

  return (
    <Card>
      <CardHeader as="h2" title={t('gateway.title')} description={t('gateway.body')} />

      {gateways.isLoading ? (
        <Skeleton lines={3} />
      ) : gateways.isError ? (
        <ErrorState body={t('gateway.loadFailed')} error={gateways.error} onRetry={() => void gateways.refetch()} />
      ) : list.length === 0 ? (
        <p className="text-caption text-subtle">{t('gateway.none')}</p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <Table columns={columns} rows={list} rowKey={(g) => g.node_id} caption={t('gateway.caption')} />
        </div>
      )}

      {rowError && (
        <p role="alert" className="pt-3 text-caption text-danger">
          {rowError}
        </p>
      )}

      {mayManage ? (
        <form onSubmit={add} className="mt-4 space-y-4 border-t border-border pt-4">
          <h3 className="text-body font-semibold text-content">{t('gateway.addTitle')}</h3>
          {candidates.length === 0 && !nodes.isLoading ? (
            <p className="text-caption text-subtle">{t('gateway.noCandidate')}</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} mono />
              </FormField>
            </div>
          )}
          {formError && (
            <p role="alert" className="text-caption text-danger">
              {formError}
            </p>
          )}
          <Button type="submit" variant="secondary" loading={setGateway.isPending} disabled={!nodeId}>
            {t('gateway.add')}
          </Button>
        </form>
      ) : (
        <p className="pt-3 text-caption text-subtle">{t('gateway.onlyAdmin')}</p>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t('gateway.removeTitle', { name: removing?.name ?? '' })}
        description={t('gateway.removeBody')}
        confirmLabel={t('gateway.removeConfirm')}
        cancelLabel={t('gateway.removeCancel')}
        tone="danger"
        onConfirm={() => void handleRemove()}
        busy={remove.isPending}
      />
    </Card>
  );
}
