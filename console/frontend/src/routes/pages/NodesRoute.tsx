import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Search, ShieldAlert, ShieldCheck, Zap } from 'lucide-react';

import { formatRelativeTime } from '../../i18n/format';
import { PageFrame } from '../PageFrame';
import { DeviceGatewayCard } from './DeviceGatewayCard';
import { GlossaryHint } from '../GlossaryHint';
import { ROUTES, nodePath } from '../paths';
import { useShell } from '../shell';
import {
  fleetCounts,
  isProfileGateway,
  isReachable,
  useLiftQuarantineNode,
  useNode,
  useNodePing,
  useNodes,
  useQuarantineNode,
  useRevokeNode
} from '../../services/queries/nodes';
import type { MeshNode } from '../../services/types';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { CodeText } from '../../ui/CodeText';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Dialog } from '../../ui/Dialog';
import { FormField } from '../../ui/FormField';
import { Input } from '../../ui/Input';
import { PageHeader } from '../../ui/PageHeader';
import { EmptyState, ErrorState, FilteredEmptyState, Skeleton } from '../../ui/States';
import { Stat } from '../../ui/Stat';
import { StatusBadge } from '../../ui/StatusBadge';
import { Table, type TableColumn } from '../../ui/Table';

export type FilterKey = 'ALL' | 'ACTIVE' | 'QUARANTINED' | 'UNVERIFIED' | 'HIGH_RISK';

const KNOWN_ROLES = ['EXIT_BRIDGE', 'CLIENT_ORIGIN', 'RELAY', 'HYBRID'] as const;

/** The ping answer. `measured: false` means no response time exists yet, not zero. */
interface PingAnswer {
  rtt_ms: number | null;
  jitter_ms: number | null;
  measured?: boolean;
}

type PingOutcome = { kind: 'replied'; rtt: string; jitter: string } | { kind: 'notMeasured' } | { kind: 'failed' };

/** Maps a yes/no check to words. A check the server did not send is "not reported", never "no". */
function formatCheck(value: boolean | null | undefined, yes: string, no: string, notReported: string) {
  if (value === true) return yes;
  if (value === false) return no;
  return notReported;
}

export default function NodesRoute() {
  const { t, i18n } = useTranslation('nodes');
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const shell = useShell();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKey>('ALL');

  const [quarantineDialogOpen, setQuarantineDialogOpen] = useState(false);
  const [quarantineReason, setQuarantineReason] = useState('');
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const [pingOutcome, setPingOutcome] = useState<PingOutcome | null>(null);
  const [actionFailed, setActionFailed] = useState(false);

  const nodesQuery = useNodes();
  const selectedNodeQuery = useNode(id);

  const quarantineMutation = useQuarantineNode();
  const liftQuarantineMutation = useLiftQuarantineNode();
  const revokeMutation = useRevokeNode();
  const pingMutation = useNodePing();

  const nodes = nodesQuery.data ?? [];
  const selectedNode = selectedNodeQuery.data;

  const counts = useMemo(() => fleetCounts(nodes), [nodes]);

  const allUnverified = useMemo(
    () => nodes.length > 0 && nodes.every((n) => !n.posture_status || n.posture_status === 'unverified'),
    [nodes]
  );
  const unverifiedCount = useMemo(
    () => nodes.filter((n) => !n.posture_status || n.posture_status === 'unverified').length,
    [nodes]
  );

  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return nodes.filter((n) => {
      if (filter === 'ACTIVE' && (!isReachable(n) || n.is_quarantined)) return false;
      if (filter === 'QUARANTINED' && !n.is_quarantined) return false;
      if (filter === 'UNVERIFIED' && n.posture_status && n.posture_status !== 'unverified') return false;
      if (filter === 'HIGH_RISK' && (typeof n.risk_score !== 'number' || n.risk_score <= 75)) return false;

      if (!q) return true;
      return [n.name, n.hostname, n.id, n.overlay_ipv4, n.role, n.public_key].some((field) =>
        (field ?? '').toLowerCase().includes(q)
      );
    });
  }, [nodes, search, filter]);

  // What a row is, before what role it plays: the profile gateway and a WireGuard-app
  // device both carry CLIENT_ORIGIN, which would read "User device" for either.
  const typeLabel = (node: MeshNode) => {
    if (isProfileGateway(node)) return t('deviceType.GATEWAY', { ns: 'glossary' });
    if (node.device_kind === 'profile') return t('deviceType.PROFILE', { ns: 'glossary' });
    const known = KNOWN_ROLES.find((r) => r === node.role);
    return known ? t(`deviceType.${known}`, { ns: 'glossary' }) : t('deviceType.unknown', { ns: 'glossary' });
  };

  const handleOpenDetail = (nodeId: string) => {
    setPingOutcome(null);
    setActionFailed(false);
    navigate(nodePath(nodeId));
  };

  const handleCloseDetail = () => {
    setPingOutcome(null);
    setActionFailed(false);
    setQuarantineDialogOpen(false);
    setRevokeConfirmOpen(false);
    navigate(ROUTES.nodes);
  };

  const handlePing = async () => {
    if (!id) return;
    setActionFailed(false);
    try {
      const answer = (await pingMutation.mutateAsync(id)) as PingAnswer;
      if (answer.measured === false || answer.rtt_ms == null) {
        setPingOutcome({ kind: 'notMeasured' });
      } else {
        setPingOutcome({
          kind: 'replied',
          rtt: answer.rtt_ms.toFixed(1),
          jitter: answer.jitter_ms == null ? '—' : answer.jitter_ms.toFixed(1)
        });
      }
    } catch {
      setPingOutcome({ kind: 'failed' });
    }
  };

  const handleConfirmQuarantine = async () => {
    if (!id) return;
    const reason = quarantineReason.trim() || t('detail.blockDefaultReason');
    try {
      await quarantineMutation.mutateAsync({ id, reason });
      setQuarantineDialogOpen(false);
      setQuarantineReason('');
      setActionFailed(false);
    } catch {
      setActionFailed(true);
    }
  };

  const handleConfirmRevoke = async () => {
    if (!id) return;
    try {
      await revokeMutation.mutateAsync({ id, reason: t('detail.revokeDefaultReason') });
      setRevokeConfirmOpen(false);
      handleCloseDetail();
    } catch {
      setActionFailed(true);
    }
  };

  const handleLift = async () => {
    if (!selectedNode) return;
    setActionFailed(false);
    try {
      await liftQuarantineMutation.mutateAsync({ id: selectedNode.id });
    } catch {
      setActionFailed(true);
    }
  };

  const columns: TableColumn<MeshNode>[] = [
    {
      id: 'device',
      header: t('columns.device'),
      cell: (n) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-semibold text-text">{n.name || n.hostname || n.id}</span>
          <span className="text-xs text-muted font-mono">{n.id}</span>
        </div>
      )
    },
    {
      id: 'address',
      header: (
        <span className="inline-flex items-center gap-1">
          {t('columns.address')}
          <GlossaryHint term="overlayAddress" />
        </span>
      ),
      cell: (n) =>
        n.overlay_ipv4 ? (
          <CodeText copyable>{n.overlay_ipv4}</CodeText>
        ) : (
          <span data-state="not-measured" className="text-muted">
            —
          </span>
        )
    },
    {
      id: 'type',
      header: t('columns.type'),
      cell: (n) => <Badge tone="neutral">{typeLabel(n)}</Badge>
    },
    {
      id: 'checks',
      header: (
        <span className="inline-flex items-center gap-1">
          {t('columns.checks')}
          <GlossaryHint term="posture" />
        </span>
      ),
      cell: (n) => {
        if (n.posture_status === 'verified_compliant') {
          return <StatusBadge status="ok" label={t('posture.passed')} />;
        }
        if (n.posture_status === 'non_compliant') {
          return <StatusBadge status="critical" label={t('posture.failed')} />;
        }
        // When no device has reported, the page says so once above the table and
        // the rows stay quiet; the word is still there for a screen reader.
        if (allUnverified) {
          return (
            <span data-state="not-measured" className="text-muted">
              <span aria-hidden="true">—</span>
              <span className="sr-only">{t('posture.unverified')}</span>
            </span>
          );
        }
        return (
          <span data-state="not-measured">
            <StatusBadge status="not-measured" label={t('posture.unverified')} />
          </span>
        );
      }
    },
    {
      id: 'reachability',
      header: t('columns.reachability'),
      cell: (n) => {
        if (n.is_quarantined) {
          return <StatusBadge status="critical" label={t('reachability.blocked')} />;
        }
        if (isReachable(n)) {
          return <StatusBadge status="ok" label={t('reachability.online')} />;
        }
        // A WireGuard-app device never heartbeats; only its gateway-reported handshake
        // says anything, and without one nothing has been measured.
        if (n.device_kind === 'profile') {
          const when = formatRelativeTime(i18n.language, n.last_handshake_at);
          if (!when) {
            return (
              <span data-state="not-measured">
                <StatusBadge status="not-measured" label={t('reachability.notMeasured')} />
              </span>
            );
          }
          return <StatusBadge status="unknown" label={t('reachability.lastConnected', { when })} />;
        }
        return <StatusBadge status="unknown" label={t('reachability.offline')} />;
      }
    },
    {
      id: 'risk',
      header: t('columns.risk'),
      numeric: true,
      cell: (n) => {
        if (typeof n.risk_score === 'number') {
          const tone = n.risk_score > 75 ? 'danger' : n.risk_score > 30 ? 'warning' : 'success';
          return <Badge tone={tone}>{n.risk_score}</Badge>;
        }
        return (
          <span data-state="not-measured" className="text-muted">
            —
          </span>
        );
      }
    },
    {
      id: 'actions',
      header: t('columns.actions'),
      numeric: true,
      cell: (n) => (
        <Button
          variant="secondary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            handleOpenDetail(n.id);
          }}
        >
          {t('row.openDetails')}
        </Button>
      )
    }
  ];

  const resetFilters = () => {
    setSearch('');
    setFilter('ALL');
  };

  const filterLabels: Record<FilterKey, string> = {
    ALL: t('filter.all'),
    ACTIVE: t('filter.reachable'),
    QUARANTINED: t('filter.blocked'),
    UNVERIFIED: t('filter.unverified'),
    HIGH_RISK: t('filter.highRisk')
  };

  return (
    <PageFrame>
      <div className="flex flex-col gap-6">
        <PageHeader
          title={t('title')}
          description={t('description')}
          primaryAction={
            <Button variant="primary" onClick={shell.openEnroll}>
              {t('addDevice')}
            </Button>
          }
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label={t('counts.total')} value={counts.total} />
          <Stat label={t('counts.reachable')} value={counts.reachable} />
          <div className="relative">
            <Stat label={t('counts.blocked')} value={counts.quarantined} />
            <GlossaryHint className="absolute right-0 top-0" term="quarantine" />
          </div>
          <div className="relative">
            <Stat label={t('counts.unverified')} value={unverifiedCount} />
            <GlossaryHint className="absolute right-0 top-0" term="posture" />
          </div>
        </div>

        {allUnverified && (
          <p data-testid="all-unverified-note" className="text-caption text-muted">
            {t('posture.allUnverified')}
          </p>
        )}

        <Card className="p-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('searchPlaceholder')}
                className="pl-9"
              />
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
              {(['ALL', 'ACTIVE', 'QUARANTINED', 'UNVERIFIED', 'HIGH_RISK'] as FilterKey[]).map((key) => (
                <Button
                  key={key}
                  variant={filter === key ? 'primary' : 'ghost'}
                  size="sm"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                >
                  {filterLabels[key]}
                </Button>
              ))}
            </div>
          </div>
        </Card>

        {nodesQuery.isLoading ? (
          <Card className="p-6">
            <Skeleton lines={6} />
          </Card>
        ) : nodesQuery.isError ? (
          <ErrorState
            title={t('loadFailed.title')}
            body={t('loadFailed.body')}
            error={nodesQuery.error}
            onRetry={() => void nodesQuery.refetch()}
          />
        ) : nodes.length === 0 ? (
          <Card className="p-8">
            <EmptyState
              title={t('empty.title')}
              body={t('empty.body')}
              action={
                <Button variant="secondary" onClick={shell.openEnroll}>
                  {t('addDevice')}
                </Button>
              }
            />
          </Card>
        ) : filteredNodes.length === 0 ? (
          <FilteredEmptyState
            title={t('filtered.title')}
            body={t('filtered.body')}
            resetLabel={t('filtered.reset')}
            onReset={resetFilters}
          />
        ) : (
          <Card className="p-0 overflow-hidden">
            <Table columns={columns} rows={filteredNodes} rowKey={(n) => n.id} caption={t('title')} />
          </Card>
        )}
      </div>

      <Dialog
        open={Boolean(id)}
        onOpenChange={(open) => {
          if (!open) handleCloseDetail();
        }}
        title={selectedNode?.name || selectedNode?.hostname || id || t('detail.title')}
        description={t('detail.description')}
        size="lg"
      >
        {selectedNodeQuery.isLoading ? (
          <Skeleton lines={6} />
        ) : selectedNodeQuery.isError ? (
          <ErrorState
            body={t('detail.loadFailed')}
            error={selectedNodeQuery.error}
            onRetry={() => void selectedNodeQuery.refetch()}
          />
        ) : selectedNode ? (
          <div className="flex flex-col gap-6 py-2">
            {selectedNode.is_quarantined ? (
              <div
                role="status"
                className="p-4 rounded-lg bg-danger-subtle border border-danger/30 text-danger flex flex-col gap-1.5"
              >
                <div className="flex items-center gap-2 font-semibold">
                  <ShieldAlert className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
                  <span>{t('detail.alert')}</span>
                </div>
                {selectedNode.quarantine_reason && (
                  <p className="text-sm opacity-90 pl-7">
                    <span className="font-medium">{t('detail.reason')}:</span> {selectedNode.quarantine_reason}
                  </p>
                )}
              </div>
            ) : null}

            <Card className="p-4">
              <CardHeader
                as="h2"
                title={t('detail.securityChecks')}
                actions={
                  selectedNode.posture_status === 'verified_compliant' ? (
                    <StatusBadge status="ok" label={t('posture.passed')} />
                  ) : selectedNode.posture_status === 'non_compliant' ? (
                    <StatusBadge status="critical" label={t('posture.failed')} />
                  ) : (
                    <span data-state="not-measured">
                      <StatusBadge status="not-measured" label={t('posture.unverified')} />
                    </span>
                  )
                }
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3 text-sm">
                <div>
                  <span className="text-muted block text-xs">{t('detail.diskEncrypted')}</span>
                  <span className="font-medium">
                    {formatCheck(
                      selectedNode.posture_checks?.disk_encrypted,
                      t('detail.yes'),
                      t('detail.no'),
                      t('detail.notReported')
                    )}
                  </span>
                </div>

                <div>
                  <span className="text-muted block text-xs">{t('detail.firewall')}</span>
                  <span className="font-medium">
                    {formatCheck(
                      selectedNode.posture_checks?.firewall_active,
                      t('detail.on'),
                      t('detail.off'),
                      t('detail.notReported')
                    )}
                  </span>
                </div>

                <div>
                  <span className="text-muted block text-xs">{t('detail.os')}</span>
                  {selectedNode.posture_checks?.os_name ? (
                    <span className="font-medium">
                      {selectedNode.posture_checks.os_name} {selectedNode.posture_checks.os_version || ''}
                    </span>
                  ) : (
                    <span className="text-muted">{t('detail.notReported')}</span>
                  )}
                </div>

                <div>
                  <span className="text-muted block text-xs">{t('detail.rootless')}</span>
                  <span className="font-medium">
                    {selectedNode.posture_checks?.is_rootless === true
                      ? t('detail.yes')
                      : selectedNode.posture_checks?.is_rootless === false
                        ? t('detail.runsAsAdmin')
                        : t('detail.notReported')}
                  </span>
                </div>
              </div>
            </Card>

            <Card className="p-4">
              <CardHeader as="h2" title={t('detail.kind')} />
              <div className="flex flex-col gap-3 mt-3 text-sm">
                <p className="font-medium">
                  {isProfileGateway(selectedNode)
                    ? t('kind.gateway')
                    : selectedNode.device_kind === 'profile'
                      ? t('kind.profile')
                      : selectedNode.device_kind === 'mesh'
                        ? t('kind.mesh')
                        : t('detail.notReported')}
                </p>
                <div>
                  <span className="text-muted block text-xs">{t('detail.publicKey')}</span>
                  {selectedNode.public_key ? (
                    <CodeText copyable>{selectedNode.public_key}</CodeText>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <span className="text-muted block text-xs">{t('detail.address')}</span>
                    {selectedNode.overlay_ipv4 ? (
                      <CodeText copyable>{selectedNode.overlay_ipv4}</CodeText>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </div>
                  <div>
                    <span className="text-muted block text-xs">{t('detail.subnet')}</span>
                    <span className="font-medium">{selectedNode.compartment_id || t('detail.defaultSubnet')}</span>
                  </div>
                </div>
              </div>
            </Card>

            {selectedNode.device_kind === 'profile' && <DeviceGatewayCard device={selectedNode} />}

            <Card className="p-4">
              <CardHeader as="h2" title={t('detail.connectionTest')} />
              <div className="flex flex-wrap items-center justify-between gap-4 mt-3">
                <Button variant="secondary" size="sm" onClick={handlePing} loading={pingMutation.isPending}>
                  <Zap className="w-4 h-4 mr-2 text-warning" aria-hidden="true" />
                  {pingMutation.isPending ? t('detail.testing') : t('detail.testButton')}
                </Button>

                {pingOutcome?.kind === 'replied' && (
                  <span role="status" className="text-sm font-medium text-success">
                    {t('detail.replied', { rtt: pingOutcome.rtt, jitter: pingOutcome.jitter })}
                  </span>
                )}
                {pingOutcome?.kind === 'notMeasured' && (
                  <span role="status" className="text-sm text-muted">
                    {t('detail.notMeasured')}
                  </span>
                )}
                {pingOutcome?.kind === 'failed' && (
                  <span role="alert" className="text-sm font-medium text-danger">
                    {t('detail.testFailed')}
                  </span>
                )}
              </div>
            </Card>

            <Card className="p-4 border-danger/30">
              <CardHeader as="h2" title={t('detail.actions')} />
              <div className="flex flex-wrap items-center gap-3 mt-3">
                {selectedNode.is_quarantined ? (
                  <Button variant="secondary" onClick={handleLift} loading={liftQuarantineMutation.isPending}>
                    <ShieldCheck className="w-4 h-4 mr-2 text-success" aria-hidden="true" />
                    {t('detail.unblock')}
                  </Button>
                ) : (
                  <Button variant="danger" onClick={() => setQuarantineDialogOpen(true)}>
                    <ShieldAlert className="w-4 h-4 mr-2" aria-hidden="true" />
                    {t('detail.block')}
                  </Button>
                )}

                <Button
                  variant="danger"
                  disabled={isProfileGateway(selectedNode)}
                  aria-describedby={isProfileGateway(selectedNode) ? 'gateway-revoke-locked' : undefined}
                  onClick={() => setRevokeConfirmOpen(true)}
                >
                  {t('detail.revoke')}
                </Button>
              </div>
              {isProfileGateway(selectedNode) && (
                <p id="gateway-revoke-locked" className="mt-3 text-sm text-muted">
                  {t('detail.gatewayLocked')}
                </p>
              )}
              {actionFailed && (
                <p role="alert" className="mt-3 text-sm font-medium text-danger">
                  {t('actionFailed')}
                </p>
              )}
            </Card>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={quarantineDialogOpen}
        onOpenChange={setQuarantineDialogOpen}
        title={t('detail.blockTitle')}
        description={t('detail.blockBody')}
        footer={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setQuarantineDialogOpen(false)}>
              {t('detail.close')}
            </Button>
            <Button variant="danger" onClick={handleConfirmQuarantine} loading={quarantineMutation.isPending}>
              {t('detail.block')}
            </Button>
          </div>
        }
      >
        <FormField label={t('detail.blockReason')}>
          <Input
            value={quarantineReason}
            onChange={(e) => setQuarantineReason(e.target.value)}
            placeholder={t('detail.blockDefaultReason')}
          />
        </FormField>
      </Dialog>

      <ConfirmDialog
        open={revokeConfirmOpen}
        onOpenChange={setRevokeConfirmOpen}
        title={t('detail.revokeTitle', { name: selectedNode?.name || selectedNode?.id || '' })}
        description={t('detail.revokeBody')}
        confirmPhrase={selectedNode?.name || selectedNode?.id || ''}
        confirmLabel={t('detail.revokeConfirm')}
        tone="danger"
        onConfirm={handleConfirmRevoke}
        busy={revokeMutation.isPending}
      />
    </PageFrame>
  );
}
