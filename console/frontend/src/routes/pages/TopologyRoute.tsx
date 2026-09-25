import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, KeyRound, List, Lock, Network, Search, ShieldAlert } from 'lucide-react';

import { PageFrame } from '../PageFrame';
import { PageHeader } from '../../ui/PageHeader';
import { GlossaryHint } from '../GlossaryHint';
import { nodePath } from '../paths';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { CodeText } from '../../ui/CodeText';
import { Dialog } from '../../ui/Dialog';
import { FormField } from '../../ui/FormField';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { EmptyState } from '../../ui/States';
import { Stat } from '../../ui/Stat';
import { StatusBadge, type Status } from '../../ui/StatusBadge';
import { Table, type TableColumn } from '../../ui/Table';

import { useCompartments, useLockGhostVaults, useTopology, useUnlockGhostVaults } from '../../services/queries';
import type { Compartment, TopologyLink, TopologyNode } from '../../services/types';

export type RoleFilter = 'ALL' | 'RELAY' | 'EXIT_BRIDGE' | 'CLIENT_ORIGIN' | 'HYBRID';
export type ViewMode = 'CANVAS' | 'LIST';

const GRAPH_WIDTH = 640;
const GRAPH_HEIGHT = 360;
const NODE_RADIUS = 16;

interface PlacedNode {
  node: TopologyNode;
  x: number;
  y: number;
}

/**
 * A fixed, deterministic circular layout: no physics, no drag, no per-render
 * jitter. The graphic exists to be read, not played with, and a stable layout
 * is the one that a screenshot or a support ticket can point at.
 */
function layoutNodes(nodes: TopologyNode[]): PlacedNode[] {
  const cx = GRAPH_WIDTH / 2;
  const cy = GRAPH_HEIGHT / 2;
  const radius = Math.min(GRAPH_WIDTH, GRAPH_HEIGHT) / 2 - NODE_RADIUS - 28;
  const count = nodes.length;
  if (count === 1) {
    const only = nodes[0];
    return only ? [{ node: only, x: cx, y: cy }] : [];
  }
  return nodes.map((node, i) => {
    const angle = (i / count) * 2 * Math.PI - Math.PI / 2;
    return {
      node,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle)
    };
  });
}

/** Categorical colour per transport mode, from the same token palette Recharts uses. */
const LINK_MODE_STROKE: Record<string, string> = {
  direct: 'stroke-chart-1',
  derp: 'stroke-chart-2',
  onion: 'stroke-chart-3',
  openvpn: 'stroke-chart-4'
};

function nodeStatus(node: TopologyNode): Status {
  if (node.is_quarantined) return 'critical';
  if (node.is_healthy) return 'ok';
  return 'warning';
}

// Stable references so a query still loading its first page does not hand
// every dependent useMemo a fresh empty array on every render.
const EMPTY_NODES: TopologyNode[] = [];
const EMPTY_LINKS: TopologyLink[] = [];
const EMPTY_COMPARTMENTS: Compartment[] = [];

export function TopologyRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const topologyQuery = useTopology();
  const compartmentsQuery = useCompartments();
  const unlockMutation = useUnlockGhostVaults();
  const lockMutation = useLockGhostVaults();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState<RoleFilter>('ALL');
  const [selectedCompartment, setSelectedCompartment] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<ViewMode>('CANVAS');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const [unlockDialogOpen, setUnlockDialogOpen] = useState(false);
  const [vaultPassword, setVaultPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const topology = topologyQuery.data;
  const nodes = topology?.nodes ?? EMPTY_NODES;
  const links = topology?.links ?? EMPTY_LINKS;
  const compartments = compartmentsQuery.data ?? EMPTY_COMPARTMENTS;

  const isUnlocked = useMemo(
    () => nodes.some((n) => n.is_ghost_vault) || compartments.some((c) => c.is_hidden),
    [nodes, compartments]
  );

  const filteredNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return nodes.filter((n) => {
      if (q) {
        const name = (n.name ?? '').toLowerCase();
        const id = (n.id ?? '').toLowerCase();
        const ip = (n.overlay_ipv4 ?? '').toLowerCase();
        if (!name.includes(q) && !id.includes(q) && !ip.includes(q)) return false;
      }
      if (selectedRole !== 'ALL' && n.role !== selectedRole) return false;
      if (selectedCompartment !== 'ALL' && n.compartment_id !== selectedCompartment) return false;
      return true;
    });
  }, [nodes, searchQuery, selectedRole, selectedCompartment]);

  const filteredLinks = useMemo(() => {
    const visibleIds = new Set(filteredNodes.map((n) => n.id));
    return links.filter((l) => visibleIds.has(l.source) && visibleIds.has(l.target));
  }, [links, filteredNodes]);

  const placedNodes = useMemo(() => layoutNodes(filteredNodes), [filteredNodes]);
  const positionById = useMemo(() => {
    const map = new Map<string, PlacedNode>();
    placedNodes.forEach((p) => map.set(p.node.id, p));
    return map;
  }, [placedNodes]);

  const selectedNode = selectedNodeId ? (nodes.find((n) => n.id === selectedNodeId) ?? null) : null;
  const selectedNodeLinks = useMemo(() => {
    if (!selectedNode) return [];
    return filteredLinks.filter((l) => l.source === selectedNode.id || l.target === selectedNode.id);
  }, [selectedNode, filteredLinks]);

  const roleOptions = [
    { value: 'ALL', label: t('topology.filterRoleAll') },
    { value: 'RELAY', label: t('topology.filterRoleRelay') },
    { value: 'EXIT_BRIDGE', label: t('topology.filterRoleExit') },
    { value: 'CLIENT_ORIGIN', label: t('topology.filterRoleClient') },
    { value: 'HYBRID', label: t('topology.filterRoleHybrid') }
  ];

  const compartmentOptions = [
    { value: 'ALL', label: t('topology.filterCompartmentAll') },
    ...compartments.map((c: Compartment) => ({ value: c.id, label: c.name }))
  ];

  const handleUnlock = async () => {
    setUnlockError(null);
    try {
      await unlockMutation.mutateAsync(vaultPassword);
      setUnlockDialogOpen(false);
      setVaultPassword('');
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : t('topology.vault.unlockFailed'));
    }
  };

  const listColumns: TableColumn<TopologyNode>[] = [
    {
      id: 'node',
      header: t('topology.columns.node'),
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-body font-semibold text-content">{row.name || row.id}</span>
          {row.is_ghost_vault && (
            <Badge tone="warning" className="text-[10px]">
              {t('topology.nodeDrawer.ghostVaultNode')}
            </Badge>
          )}
        </div>
      )
    },
    {
      id: 'role',
      header: t('topology.columns.role'),
      cell: (row) => <Badge tone={row.role === 'RELAY' ? 'accent' : 'neutral'}>{row.role}</Badge>
    },
    {
      id: 'overlayIp',
      header: t('topology.nodeDrawer.overlayIp'),
      cell: (row) =>
        row.overlay_ipv4 ? <CodeText>{row.overlay_ipv4}</CodeText> : <span className="text-muted">—</span>
    },
    {
      id: 'country',
      header: t('topology.nodeDrawer.country'),
      cell: (row) => <span className="font-mono text-caption">{row.country || '—'}</span>
    },
    {
      id: 'compartment',
      header: t('topology.nodeDrawer.compartment'),
      cell: (row) => <span className="text-caption text-muted">{row.compartment_name || '—'}</span>
    },
    {
      id: 'latency',
      header: t('topology.nodeDrawer.latency'),
      numeric: true,
      cell: (row) => (
        <span className="font-mono text-caption text-muted">
          {row.latency_ms !== null && row.latency_ms !== undefined ? `${row.latency_ms} ms` : '—'}
        </span>
      )
    },
    {
      id: 'status',
      header: t('topology.columns.status'),
      cell: (row) => (
        <StatusBadge
          status={nodeStatus(row)}
          label={row.is_quarantined ? t('topology.nodeDrawer.quarantined') : t('topology.nodeDrawer.healthy')}
        />
      )
    }
  ];

  const totalNodes = nodes.length;
  const noNodesAtAll = totalNodes === 0;

  return (
    <PageFrame>
      <PageHeader
        title={t('topology.title')}
        description={t('topology.description')}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={viewMode === 'CANVAS' ? 'primary' : 'secondary'}
              size="sm"
              icon={Network}
              onClick={() => setViewMode('CANVAS')}
            >
              {t('topology.view.canvasMode')}
            </Button>
            <Button
              variant={viewMode === 'LIST' ? 'primary' : 'secondary'}
              size="sm"
              icon={List}
              onClick={() => setViewMode('LIST')}
            >
              {t('topology.view.listMode')}
            </Button>
            {isUnlocked ? (
              <Button
                variant="danger"
                size="sm"
                icon={Lock}
                onClick={() => lockMutation.mutate()}
                loading={lockMutation.isPending}
              >
                {t('topology.vault.lockAction')}
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={KeyRound}
                onClick={() => {
                  setUnlockError(null);
                  setVaultPassword('');
                  setUnlockDialogOpen(true);
                }}
              >
                {t('topology.vault.unlockAction')}
              </Button>
            )}
          </div>
        }
      />

      {topology?.policy_is_open && (
        <div className="mb-4 flex items-center gap-2 rounded-card border border-warning/30 bg-warning-subtle px-3 py-2 text-caption text-warning">
          <ShieldAlert aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>{t('topology.policyOpenNotice')}</span>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('topology.stats.nodes')} value={filteredNodes.length} />
        <Stat label={t('topology.stats.links')} value={filteredLinks.filter((l) => l.is_visible !== false).length} />
        <Stat label={t('topology.stats.compartments')} value={compartments.length} />
        <Stat
          label={t('topology.stats.vaultStatus')}
          value={isUnlocked ? t('topology.vault.unlockedBadge') : t('topology.vault.lockedBadge')}
        />
      </div>

      {!noNodesAtAll && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative max-w-md flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('topology.searchPlaceholder')}
              className="pl-9"
              aria-label={t('topology.searchPlaceholder')}
            />
          </div>
          <div className="w-full sm:w-48">
            <Select
              value={selectedRole}
              onValueChange={(v) => setSelectedRole(v as RoleFilter)}
              options={roleOptions}
              aria-label={t('topology.filterRoleAll')}
            />
          </div>
          <div className="w-full sm:w-56">
            <Select
              value={selectedCompartment}
              onValueChange={setSelectedCompartment}
              options={compartmentOptions}
              aria-label={t('topology.filterCompartmentAll')}
            />
          </div>
        </div>
      )}

      {noNodesAtAll ? (
        <Card>
          <EmptyState title={t('topology.empty.title')} body={t('topology.empty.enrollFirst')} />
        </Card>
      ) : viewMode === 'CANVAS' ? (
        <Card flush className="overflow-hidden">
          {filteredNodes.length === 0 ? (
            <div className="p-8">
              <EmptyState title={t('topology.empty.title')} body={t('topology.empty.desc')} />
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3">
              <div className="border-b border-border p-4 lg:col-span-2 lg:border-b-0 lg:border-r">
                <svg
                  viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
                  className="h-[320px] w-full"
                  preserveAspectRatio="xMidYMid meet"
                >
                  {filteredLinks.map((link) => {
                    const u = positionById.get(link.source);
                    const v = positionById.get(link.target);
                    if (!u || !v) return null;
                    const isCut = link.is_visible === false;
                    const modeClass = isCut
                      ? 'stroke-border-strong'
                      : (LINK_MODE_STROKE[link.mode ?? 'direct'] ?? 'stroke-border-strong');
                    return (
                      <line
                        key={`${link.source}-${link.target}`}
                        x1={u.x}
                        y1={u.y}
                        x2={v.x}
                        y2={v.y}
                        strokeWidth={isCut ? 1.5 : 2}
                        strokeDasharray={isCut ? '4 4' : undefined}
                        className={modeClass}
                      >
                        <title>{isCut ? t('topology.legend.isolated') : (link.mode ?? 'direct')}</title>
                      </line>
                    );
                  })}

                  {placedNodes.map(({ node, x, y }) => {
                    const isSelected = selectedNode?.id === node.id;
                    const isQuarantined = node.is_quarantined;
                    const fillClass = isQuarantined ? 'fill-danger-subtle' : 'fill-accent-subtle';
                    const strokeClass = isQuarantined ? 'stroke-danger' : 'stroke-accent';
                    return (
                      <g
                        key={node.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`${node.name || node.id} — ${node.role}`}
                        aria-pressed={isSelected}
                        className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                        onClick={() => setSelectedNodeId(node.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedNodeId(node.id);
                          }
                        }}
                      >
                        <title>{`${node.name || node.id} — ${node.role}`}</title>
                        {node.is_ghost_vault && (
                          <circle
                            cx={x}
                            cy={y}
                            r={NODE_RADIUS + 5}
                            className="fill-none stroke-info"
                            strokeDasharray="3 3"
                            strokeWidth={1.5}
                          />
                        )}
                        <circle
                          cx={x}
                          cy={y}
                          r={NODE_RADIUS}
                          strokeWidth={isSelected ? 3 : 2}
                          className={`${fillClass} ${isSelected ? 'stroke-content' : strokeClass}`}
                        />
                        <text
                          x={x}
                          y={y}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          className={`${isQuarantined ? 'fill-danger-contrast' : 'fill-accent-contrast'} text-[9px] font-bold`}
                        >
                          {(node.country || node.name || node.id).slice(0, 2).toUpperCase()}
                        </text>
                        <text
                          x={x}
                          y={y + NODE_RADIUS + 12}
                          textAnchor="middle"
                          className="fill-content text-[9px] font-mono"
                        >
                          {(node.name || node.id).slice(0, 14)}
                        </text>
                      </g>
                    );
                  })}
                </svg>

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-chart-1" /> {t('topology.legend.direct')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-chart-2" /> {t('topology.legend.derp')}
                    <GlossaryHint
                      text={t('glossary.derp.body')}
                      label={t('glossary.ariaLabel', {
                        term: t('glossary.derp.term')
                      })}
                    />
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-chart-3" /> {t('topology.legend.onion')}
                    <GlossaryHint
                      text={t('glossary.onion.body')}
                      label={t('glossary.ariaLabel', {
                        term: t('glossary.onion.term')
                      })}
                    />
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-chart-4" /> {t('topology.legend.openvpn')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-danger" /> {t('topology.nodeDrawer.quarantined')}
                    <GlossaryHint
                      text={t('glossary.quarantine.body')}
                      label={t('glossary.ariaLabel', {
                        term: t('glossary.quarantine.term')
                      })}
                    />
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full border border-dashed border-info" />{' '}
                    {t('topology.nodeDrawer.ghostVaultNode')}
                  </span>
                </div>
              </div>

              <div className="p-4">
                {selectedNode ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h2 className="font-mono text-body font-semibold text-content">
                          {selectedNode.name || selectedNode.id}
                        </h2>
                        {selectedNode.overlay_ipv4 && (
                          <span className="mt-0.5 flex items-center gap-1">
                            <CodeText>{selectedNode.overlay_ipv4}</CodeText>
                            <GlossaryHint
                              text={t('glossary.overlayAddress.body')}
                              label={t('glossary.ariaLabel', {
                                term: t('glossary.overlayAddress.term')
                              })}
                            />
                          </span>
                        )}
                      </div>
                      <StatusBadge
                        status={nodeStatus(selectedNode)}
                        label={
                          selectedNode.is_quarantined
                            ? t('topology.nodeDrawer.quarantined')
                            : t('topology.nodeDrawer.healthy')
                        }
                      />
                    </div>

                    {selectedNode.is_ghost_vault && (
                      <Badge tone="warning">{t('topology.nodeDrawer.ghostVaultNode')}</Badge>
                    )}

                    <dl className="grid grid-cols-2 gap-2 text-caption">
                      <div>
                        <dt className="text-muted">{t('topology.nodeDrawer.role')}</dt>
                        <dd className="font-medium text-content">{selectedNode.role}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">{t('topology.nodeDrawer.country')}</dt>
                        <dd className="font-medium text-content">{selectedNode.country || '—'}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">{t('topology.nodeDrawer.latency')}</dt>
                        <dd className="font-medium text-content">
                          {selectedNode.latency_ms !== null && selectedNode.latency_ms !== undefined
                            ? `${selectedNode.latency_ms} ms`
                            : t('state.notMeasured')}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted">{t('topology.nodeDrawer.compartment')}</dt>
                        <dd className="font-medium text-content">{selectedNode.compartment_name || '—'}</dd>
                      </div>
                    </dl>

                    <div className="text-caption text-muted">
                      {t('topology.stats.links')}: {selectedNodeLinks.length}
                    </div>

                    <Button
                      variant="secondary"
                      size="sm"
                      icon={ExternalLink}
                      onClick={() => navigate(nodePath(selectedNode.id))}
                    >
                      {t('topology.nodeDrawer.viewDetails')}
                    </Button>
                  </div>
                ) : (
                  <EmptyState title={t('topology.nodeDrawer.title')} body={t('topology.description')} />
                )}
              </div>
            </div>
          )}
        </Card>
      ) : (
        <Card flush>
          <Table<TopologyNode>
            caption={t('topology.title')}
            columns={listColumns}
            rows={filteredNodes}
            rowKey={(row) => row.id}
            empty={<EmptyState title={t('topology.empty.title')} body={t('topology.empty.desc')} />}
          />
        </Card>
      )}

      <Dialog
        open={unlockDialogOpen}
        onOpenChange={(open) => {
          setUnlockDialogOpen(open);
          if (!open) setUnlockError(null);
        }}
        title={t('topology.vault.dialogTitle')}
        description={t('topology.vault.dialogDesc')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setUnlockDialogOpen(false)}>
              {t('topology.vault.cancel')}
            </Button>
            <Button variant="primary" onClick={handleUnlock} loading={unlockMutation.isPending}>
              {t('topology.vault.confirmUnlock')}
            </Button>
          </>
        }
      >
        <FormField label={t('topology.vault.passwordLabel')} error={unlockError}>
          <Input
            type="password"
            value={vaultPassword}
            onChange={(e) => setVaultPassword(e.target.value)}
            placeholder={t('topology.vault.passwordPlaceholder')}
          />
        </FormField>
      </Dialog>
    </PageFrame>
  );
}

export default TopologyRoute;
