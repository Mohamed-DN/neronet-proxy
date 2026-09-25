import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, ShieldAlert, ShieldCheck, Zap } from 'lucide-react';

import { PageFrame } from '../PageFrame';
import { ROUTES, nodePath } from '../paths';
import { useShell } from '../shell';
import {
  fleetCounts,
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
import { EmptyState, Skeleton } from '../../ui/States';
import { Stat } from '../../ui/Stat';
import { StatusBadge } from '../../ui/StatusBadge';
import { Table, type TableColumn } from '../../ui/Table';

export type FilterKey = 'ALL' | 'ACTIVE' | 'QUARANTINED' | 'UNVERIFIED' | 'HIGH_RISK';

export default function NodesRoute() {
  const { t } = useTranslation('ui');
  const navigate = useNavigate();
  const { id } = useParams<{ id?: string }>();
  const shell = useShell();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterKey>('ALL');

  // Detail dialog actions state
  const [quarantineDialogOpen, setQuarantineDialogOpen] = useState(false);
  const [quarantineReason, setQuarantineReason] = useState('');
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const [pingResult, setPingResult] = useState<{ rtt_ms: number; jitter_ms: number } | null>(null);

  // Queries & Mutations
  const nodesQuery = useNodes();
  const selectedNodeQuery = useNode(id);

  const quarantineMutation = useQuarantineNode();
  const liftQuarantineMutation = useLiftQuarantineNode();
  const revokeMutation = useRevokeNode();
  const pingMutation = useNodePing();

  const nodes = nodesQuery.data ?? [];
  const selectedNode = selectedNodeQuery.data;

  const counts = useMemo(() => fleetCounts(nodes), [nodes]);

  const unverifiedCount = useMemo(
    () => nodes.filter((n) => !n.posture_status || n.posture_status === 'unverified').length,
    [nodes]
  );

  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return nodes.filter((n) => {
      // Filter tab
      if (filter === 'ACTIVE' && (!isReachable(n) || n.is_quarantined)) return false;
      if (filter === 'QUARANTINED' && !n.is_quarantined) return false;
      if (filter === 'UNVERIFIED' && n.posture_status && n.posture_status !== 'unverified') return false;
      if (filter === 'HIGH_RISK' && (typeof n.risk_score !== 'number' || n.risk_score <= 75)) return false;

      // Text search
      if (!q) return true;
      const name = (n.name ?? '').toLowerCase();
      const hostname = (n.hostname ?? '').toLowerCase();
      const idStr = (n.id ?? '').toLowerCase();
      const v4 = (n.overlay_ipv4 ?? '').toLowerCase();
      const role = (n.role ?? '').toLowerCase();
      const pubKey = (n.public_key ?? '').toLowerCase();
      return (
        name.includes(q) ||
        hostname.includes(q) ||
        idStr.includes(q) ||
        v4.includes(q) ||
        role.includes(q) ||
        pubKey.includes(q)
      );
    });
  }, [nodes, search, filter]);

  const handleOpenDetail = (nodeId: string) => {
    setPingResult(null);
    navigate(nodePath(nodeId));
  };

  const handleCloseDetail = () => {
    setPingResult(null);
    setQuarantineDialogOpen(false);
    setRevokeConfirmOpen(false);
    navigate(ROUTES.nodes);
  };

  const handlePing = async () => {
    if (!id) return;
    try {
      const res = await pingMutation.mutateAsync(id);
      setPingResult({ rtt_ms: res.rtt_ms, jitter_ms: res.jitter_ms });
    } catch {
      // Failed ping
    }
  };

  const handleConfirmQuarantine = async () => {
    if (!id) return;
    const reason = quarantineReason.trim() || t('nodes.detail.quarantineDefaultReason');
    await quarantineMutation.mutateAsync({ id, reason });
    setQuarantineDialogOpen(false);
    setQuarantineReason('');
  };

  const handleConfirmRevoke = async () => {
    if (!id) return;
    await revokeMutation.mutateAsync({ id, reason: 'Administrative key revocation' });
    setRevokeConfirmOpen(false);
    handleCloseDetail();
  };

  const columns: TableColumn<MeshNode>[] = [
    {
      id: 'node',
      header: t('nodes.columns.node'),
      cell: (n) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-text">{n.name || n.hostname || n.id}</span>
            {n.country_code && <Badge tone="neutral">{n.country_code}</Badge>}
          </div>
          <span className="text-xs text-muted font-mono">{n.id}</span>
        </div>
      )
    },
    {
      id: 'ipv4',
      header: t('nodes.columns.ipv4'),
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
      id: 'role',
      header: t('nodes.columns.role'),
      cell: (n) => <Badge tone={n.role === 'EXIT_BRIDGE' ? 'accent' : 'neutral'}>{n.role || 'CLIENT_ORIGIN'}</Badge>
    },
    {
      id: 'posture',
      header: t('nodes.columns.posture'),
      cell: (n) => {
        if (n.posture_status === 'verified_compliant') {
          return <StatusBadge status="ok" label={t('nodes.posture.verifiedCompliant')} />;
        }
        if (n.posture_status === 'non_compliant') {
          return <StatusBadge status="critical" label={t('nodes.posture.nonCompliant')} />;
        }
        return (
          <span data-state="not-measured">
            <StatusBadge status="not-measured" label={t('nodes.posture.unverified')} />
          </span>
        );
      }
    },
    {
      id: 'reachability',
      header: t('nodes.columns.reachability'),
      cell: (n) => {
        if (n.is_quarantined) {
          return <StatusBadge status="critical" label={t('nodes.reachability.quarantined')} />;
        }
        if (isReachable(n)) {
          return <StatusBadge status="ok" label={t('nodes.reachability.online')} />;
        }
        return <StatusBadge status="unknown" label={t('nodes.reachability.offline')} />;
      }
    },
    {
      id: 'risk',
      header: t('nodes.columns.risk'),
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
      header: t('nodes.columns.actions'),
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
          {t('nodes.columns.actions')}
        </Button>
      )
    }
  ];

  return (
    <PageFrame>
      <div className="flex flex-col gap-6">
        <PageHeader
          title={t('nodes.title')}
          description={t('nodes.description')}
          actions={
            <Button variant="primary" onClick={shell.openEnroll}>
              {t('nodes.enrollNode')}
            </Button>
          }
        />

        {/* Fleet KPI Counts */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label={t('nodes.counts.total')} value={counts.total} />
          <Stat label={t('nodes.counts.reachable')} value={counts.reachable} />
          <Stat label={t('nodes.counts.quarantined')} value={counts.quarantined} />
          <Stat label={t('nodes.counts.unverified')} value={unverifiedCount} />
        </div>

        {/* Filter and Search Bar */}
        <Card className="p-4">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('nodes.searchPlaceholder')}
                className="pl-9"
              />
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
              {(['ALL', 'ACTIVE', 'QUARANTINED', 'UNVERIFIED', 'HIGH_RISK'] as FilterKey[]).map((key) => {
                const labelMap: Record<FilterKey, string> = {
                  ALL: t('nodes.filterAll'),
                  ACTIVE: t('nodes.filterActive'),
                  QUARANTINED: t('nodes.filterQuarantined'),
                  UNVERIFIED: t('nodes.filterUnverified'),
                  HIGH_RISK: t('nodes.filterHighRisk')
                };
                const isSelected = filter === key;
                return (
                  <Button key={key} variant={isSelected ? 'primary' : 'ghost'} size="sm" onClick={() => setFilter(key)}>
                    {labelMap[key]}
                  </Button>
                );
              })}
            </div>
          </div>
        </Card>

        {/* Nodes Table or Empty State */}
        {nodesQuery.isLoading ? (
          <Card className="p-6">
            <Skeleton lines={6} />
          </Card>
        ) : filteredNodes.length === 0 ? (
          <Card className="p-8">
            <EmptyState
              title={t('nodes.empty.noNodes')}
              body={nodes.length === 0 ? t('nodes.empty.enrollFirst') : t('nodes.empty.noNodesDesc')}
              action={
                nodes.length === 0 ? (
                  <Button variant="primary" onClick={shell.openEnroll}>
                    {t('nodes.enrollNode')}
                  </Button>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <Card className="p-0 overflow-hidden">
            <Table columns={columns} rows={filteredNodes} rowKey={(n) => n.id} caption={t('nodes.title')} />
          </Card>
        )}
      </div>

      {/* Node Detail Dialog / Drawer */}
      <Dialog
        open={Boolean(id)}
        onOpenChange={(open) => {
          if (!open) handleCloseDetail();
        }}
        title={selectedNode?.name || selectedNode?.hostname || id || t('nodes.detail.title')}
        description={t('nodes.detail.title')}
        size="lg"
      >
        {selectedNodeQuery.isLoading ? (
          <Skeleton lines={6} />
        ) : selectedNode ? (
          <div className="flex flex-col gap-6 py-2">
            {/* Quarantine Alert Banner if Quarantined */}
            {selectedNode.is_quarantined ? (
              <div className="p-4 rounded-lg bg-danger-subtle border border-danger/30 text-danger flex flex-col gap-1.5">
                <div className="flex items-center gap-2 font-semibold">
                  <ShieldAlert className="w-5 h-5 flex-shrink-0" />
                  <span>{t('nodes.detail.quarantineAlert')}</span>
                </div>
                {selectedNode.quarantine_reason && (
                  <p className="text-sm opacity-90 pl-7">
                    <span className="font-medium">{t('nodes.detail.quarantineReason')}:</span>{' '}
                    {selectedNode.quarantine_reason}
                  </p>
                )}
              </div>
            ) : null}

            {/* Hardware Attestation Card */}
            <Card className="p-4">
              <CardHeader
                as="h2"
                title={t('nodes.detail.hardwareAttestation')}
                actions={
                  selectedNode.posture_status === 'verified_compliant' ? (
                    <StatusBadge status="ok" label={t('nodes.posture.verifiedCompliant')} />
                  ) : selectedNode.posture_status === 'non_compliant' ? (
                    <StatusBadge status="critical" label={t('nodes.posture.nonCompliant')} />
                  ) : (
                    <span data-state="not-measured">
                      <StatusBadge status="not-measured" label={t('nodes.posture.unverified')} />
                    </span>
                  )
                }
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3 text-sm">
                <div>
                  <span className="text-muted block text-xs">{t('nodes.detail.diskEncryption')}</span>
                  {selectedNode.posture_checks?.disk_encrypted === true ? (
                    <StatusBadge status="ok" label="Encrypted" />
                  ) : selectedNode.posture_checks?.disk_encrypted === false ? (
                    <StatusBadge status="critical" label="Plaintext" />
                  ) : (
                    <span data-state="not-measured" className="text-muted">
                      {t('nodes.detail.notMeasured')}
                    </span>
                  )}
                </div>

                <div>
                  <span className="text-muted block text-xs">{t('nodes.detail.firewall')}</span>
                  {selectedNode.posture_checks?.firewall_active === true ? (
                    <StatusBadge status="ok" label="Active" />
                  ) : selectedNode.posture_checks?.firewall_active === false ? (
                    <StatusBadge status="critical" label="Inactive" />
                  ) : (
                    <span data-state="not-measured" className="text-muted">
                      {t('nodes.detail.notMeasured')}
                    </span>
                  )}
                </div>

                <div>
                  <span className="text-muted block text-xs">{t('nodes.detail.os')}</span>
                  {selectedNode.posture_checks?.os_name ? (
                    <span className="font-medium">
                      {selectedNode.posture_checks.os_name} {selectedNode.posture_checks.os_version || ''}
                    </span>
                  ) : (
                    <span data-state="not-measured" className="text-muted">
                      {t('nodes.detail.notMeasured')}
                    </span>
                  )}
                </div>

                <div>
                  <span className="text-muted block text-xs">{t('nodes.detail.rootless')}</span>
                  {typeof selectedNode.posture_checks?.is_rootless === 'boolean' ? (
                    <span className="font-medium">
                      {selectedNode.posture_checks.is_rootless ? 'Yes (Rootless)' : 'No (Root)'}
                    </span>
                  ) : (
                    <span data-state="not-measured" className="text-muted">
                      {t('nodes.detail.notMeasured')}
                    </span>
                  )}
                </div>
              </div>
            </Card>

            {/* Cryptographic Identity & Network Parameters */}
            <Card className="p-4">
              <CardHeader as="h2" title={t('nodes.detail.title')} />
              <div className="flex flex-col gap-3 mt-3 text-sm">
                <div>
                  <span className="text-muted block text-xs">{t('nodes.detail.publicKey')}</span>
                  {selectedNode.public_key ? (
                    <CodeText copyable>{selectedNode.public_key}</CodeText>
                  ) : (
                    <span data-state="not-measured" className="text-muted">
                      —
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <span className="text-muted block text-xs">{t('nodes.columns.ipv4')}</span>
                    {selectedNode.overlay_ipv4 ? (
                      <CodeText copyable>{selectedNode.overlay_ipv4}</CodeText>
                    ) : (
                      <span data-state="not-measured" className="text-muted">
                        —
                      </span>
                    )}
                  </div>
                  <div>
                    <span className="text-muted block text-xs">{t('nodes.detail.compartment')}</span>
                    <span className="font-medium">
                      {selectedNode.compartment_id || t('nodes.detail.noCompartment')}
                    </span>
                  </div>
                </div>
              </div>
            </Card>

            {/* Live Diagnostics */}
            <Card className="p-4">
              <CardHeader as="h2" title={t('nodes.detail.diagnostics')} />
              <div className="flex items-center justify-between gap-4 mt-3">
                <Button variant="secondary" size="sm" onClick={handlePing} loading={pingMutation.isPending}>
                  <Zap className="w-4 h-4 mr-2 text-warning" />
                  {pingMutation.isPending ? t('nodes.detail.pinging') : t('nodes.detail.pingButton')}
                </Button>

                {pingResult && (
                  <span className="text-sm font-medium text-success">
                    {t('nodes.detail.pingSuccess', {
                      rtt: pingResult.rtt_ms.toFixed(1),
                      jitter: pingResult.jitter_ms.toFixed(1)
                    })}
                  </span>
                )}
              </div>
            </Card>

            {/* Security Actions */}
            <Card className="p-4 border-danger/30">
              <CardHeader as="h2" title={t('nodes.detail.actions')} />
              <div className="flex flex-wrap items-center gap-3 mt-3">
                {selectedNode.is_quarantined ? (
                  <Button
                    variant="secondary"
                    onClick={() => liftQuarantineMutation.mutateAsync({ id: selectedNode.id })}
                    loading={liftQuarantineMutation.isPending}
                  >
                    <ShieldCheck className="w-4 h-4 mr-2 text-success" />
                    {t('nodes.detail.liftQuarantineAction')}
                  </Button>
                ) : (
                  <Button variant="danger" onClick={() => setQuarantineDialogOpen(true)}>
                    <ShieldAlert className="w-4 h-4 mr-2" />
                    {t('nodes.detail.quarantineAction')}
                  </Button>
                )}

                <Button variant="danger" onClick={() => setRevokeConfirmOpen(true)}>
                  {t('nodes.detail.revokeAction')}
                </Button>
              </div>
            </Card>
          </div>
        ) : null}
      </Dialog>

      {/* Quarantine Reason Dialog */}
      <Dialog
        open={quarantineDialogOpen}
        onOpenChange={setQuarantineDialogOpen}
        title={t('nodes.detail.quarantineConfirmTitle')}
        description={t('nodes.detail.quarantineConfirmDesc')}
        footer={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setQuarantineDialogOpen(false)}>
              {t('nodes.detail.close')}
            </Button>
            <Button variant="danger" onClick={handleConfirmQuarantine} loading={quarantineMutation.isPending}>
              {t('nodes.detail.quarantineConfirmAction')}
            </Button>
          </div>
        }
      >
        <FormField label={t('nodes.detail.quarantineReason')}>
          <Input
            value={quarantineReason}
            onChange={(e) => setQuarantineReason(e.target.value)}
            placeholder={t('nodes.detail.quarantineDefaultReason')}
          />
        </FormField>
      </Dialog>

      {/* Revoke Key Confirmation Dialog */}
      <ConfirmDialog
        open={revokeConfirmOpen}
        onOpenChange={setRevokeConfirmOpen}
        title={t('nodes.detail.revokeConfirmTitle')}
        description={t('nodes.detail.revokeConfirmDesc')}
        confirmPhrase={selectedNode?.name || selectedNode?.id || ''}
        tone="danger"
        onConfirm={handleConfirmRevoke}
        busy={revokeMutation.isPending}
      />
    </PageFrame>
  );
}
