import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Globe2,
  Lock,
  KeyRound,
  Shield,
  ShieldAlert,
  Layers,
  Search,
  RotateCcw,
  Play,
  Pause,
  Maximize2,
  Minimize2,
  ExternalLink,
  Zap,
  Server,
  Radio,
  Eye,
  List,
  Sparkles,
  AlertTriangle
} from 'lucide-react';

import { PageFrame } from '../PageFrame';
import { PageHeader } from '../../ui/PageHeader';
import { nodePath, ROUTES } from '../paths';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { CodeText } from '../../ui/CodeText';
import { Dialog } from '../../ui/Dialog';
import { FormField } from '../../ui/FormField';
import { Input } from '../../ui/Input';
import { EmptyState, Skeleton } from '../../ui/States';
import { Stat } from '../../ui/Stat';
import { StatusBadge } from '../../ui/StatusBadge';
import { Table, type TableColumn } from '../../ui/Table';

import { useTopology, useCompartments, useUnlockGhostVaults, useLockGhostVaults } from '../../services/queries';
import type { TopologyNode, TopologyLink } from '../../services/types';

export type RoleFilter = 'ALL' | 'RELAY' | 'EXIT_BRIDGE' | 'CLIENT_ORIGIN' | 'HYBRID';
export type ViewMode = 'CANVAS' | 'LIST';

export default function TopologyRoute() {
  const { t } = useTranslation('ui');
  const navigate = useNavigate();

  // Queries & Mutations
  const topologyQuery = useTopology();
  const compartmentsQuery = useCompartments();
  const unlockMutation = useUnlockGhostVaults();
  const lockMutation = useLockGhostVaults();

  // Local filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState<RoleFilter>('ALL');
  const [selectedCompartment, setSelectedCompartment] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<ViewMode>('CANVAS');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [autoRotate, setAutoRotate] = useState(true);

  // Dialogs & selection
  const [unlockDialogOpen, setUnlockDialogOpen] = useState(false);
  const [vaultPassword, setVaultPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<TopologyNode | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rotationAngle, setRotationAngle] = useState(0);

  const topology = topologyQuery.data;
  const nodes = topology?.nodes ?? [];
  const links = topology?.links ?? [];
  const compartments = compartmentsQuery.data ?? [];

  // Determine whether any ghost vault is unlocked
  const isUnlocked = useMemo(() => {
    return nodes.some((n) => n.is_ghost_vault) || compartments.some((c) => c.is_hidden);
  }, [nodes, compartments]);

  // Filtered nodes
  const filteredNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return nodes.filter((n) => {
      // Search text
      if (q) {
        const name = (n.name ?? '').toLowerCase();
        const id = (n.id ?? '').toLowerCase();
        const ip = (n.overlay_ipv4 ?? '').toLowerCase();
        if (!name.includes(q) && !id.includes(q) && !ip.includes(q)) return false;
      }
      // Role filter
      if (selectedRole !== 'ALL' && n.role !== selectedRole) return false;
      // Compartment filter
      if (selectedCompartment !== 'ALL' && n.compartment_id !== selectedCompartment) return false;
      return true;
    });
  }, [nodes, searchQuery, selectedRole, selectedCompartment]);

  // Filtered links: link exists if both source and target nodes are in filteredNodes
  const filteredLinks = useMemo(() => {
    const visibleIds = new Set(filteredNodes.map((n) => n.id));
    return links.filter((l) => visibleIds.has(l.source) && visibleIds.has(l.target));
  }, [links, filteredNodes]);

  // Handle Vault Unlock
  const handleUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!vaultPassword) return;
    setUnlockError(null);
    try {
      await unlockMutation.mutateAsync(vaultPassword);
      setUnlockDialogOpen(false);
      setVaultPassword('');
    } catch (err: unknown) {
      setUnlockError(err instanceof Error ? err.message : t('topology.vault.unlockFailed'));
    }
  };

  // Handle Vault Lock
  const handleLockVaults = async () => {
    try {
      await lockMutation.mutateAsync();
      setSelectedNode(null);
    } catch {
      // Locking failed
    }
  };

  // Auto-rotate loop for canvas animation
  useEffect(() => {
    if (!autoRotate || viewMode !== 'CANVAS') return;
    const interval = setInterval(() => {
      setRotationAngle((prev) => (prev + 0.005) % (Math.PI * 2));
    }, 30);
    return () => clearInterval(interval);
  }, [autoRotate, viewMode]);

  // Interactive 2D Canvas rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewMode !== 'CANVAS') return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      // Headless / JSDOM without canvas context
      return;
    }
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(width, height) * 0.35;

    ctx.clearRect(0, 0, width, height);

    if (filteredNodes.length === 0) return;

    // Calculate node coordinates in circular/mesh layout with rotation
    const nodeCoords = new Map<string, { x: number; y: number }>();
    filteredNodes.forEach((node, idx) => {
      const angle = (idx / filteredNodes.length) * Math.PI * 2 + rotationAngle;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;
      nodeCoords.set(node.id, { x, y });
    });

    // Draw Links
    ctx.lineWidth = 1.5;
    filteredLinks.forEach((link) => {
      const src = nodeCoords.get(link.source);
      const dst = nodeCoords.get(link.target);
      if (src && dst) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.35)'; // Accent indigo link
        ctx.moveTo(src.x, src.y);
        ctx.lineTo(dst.x, dst.y);
        ctx.stroke();
      }
    });

    // Draw Nodes
    filteredNodes.forEach((node) => {
      const coords = nodeCoords.get(node.id);
      if (!coords) return;

      const isHovered = hoveredNode?.id === node.id;
      const isSelected = selectedNode?.id === node.id;
      const nodeRadius = isHovered || isSelected ? 16 : 12;

      // Outer aura for Ghost Vault nodes
      if (node.is_ghost_vault) {
        ctx.beginPath();
        ctx.arc(coords.x, coords.y, nodeRadius + 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(168, 85, 247, 0.25)'; // Purple aura
        ctx.fill();
        ctx.strokeStyle = '#c084fc';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Main Node Circle
      ctx.beginPath();
      ctx.arc(coords.x, coords.y, nodeRadius, 0, Math.PI * 2);

      if (node.is_quarantined) {
        ctx.fillStyle = '#ef4444'; // Red danger
      } else if (node.is_ghost_vault) {
        ctx.fillStyle = '#a855f7'; // Purple stealth
      } else if (node.role === 'RELAY') {
        ctx.fillStyle = '#10b981'; // Green relay
      } else if (node.role === 'EXIT_BRIDGE') {
        ctx.fillStyle = '#6366f1'; // Indigo exit
      } else if (node.role === 'HYBRID') {
        ctx.fillStyle = '#06b6d4'; // Cyan hybrid
      } else {
        ctx.fillStyle = '#38bdf8'; // Blue client
      }
      ctx.fill();

      // Border ring
      ctx.lineWidth = isSelected ? 3 : 1.5;
      ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.4)';
      ctx.stroke();

      // Node Label
      ctx.font = isHovered || isSelected ? 'bold 12px Inter, sans-serif' : '11px Inter, sans-serif';
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.fillText(node.name || node.id, coords.x, coords.y + nodeRadius + 14);
    });
  }, [filteredNodes, filteredLinks, hoveredNode, selectedNode, rotationAngle, viewMode]);

  // Handle Canvas Click to Select Node
  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const clickY = (e.clientY - rect.top) * (canvas.height / rect.height);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = Math.min(canvas.width, canvas.height) * 0.35;

    // Check hit test against nodes
    for (let idx = 0; idx < filteredNodes.length; idx++) {
      const node = filteredNodes[idx];
      const angle = (idx / filteredNodes.length) * Math.PI * 2 + rotationAngle;
      const x = centerX + Math.cos(angle) * radius;
      const y = centerY + Math.sin(angle) * radius;

      const dist = Math.hypot(clickX - x, clickY - y);
      if (dist <= 20) {
        setSelectedNode(node);
        return;
      }
    }
    setSelectedNode(null);
  };

  // Table Columns for Accessible List Mode
  const tableColumns: TableColumn<TopologyNode>[] = useMemo(
    () => [
      {
        id: 'name',
        header: t('nodes.columns.node'),
        cell: (node) => (
          <div className="flex items-center gap-2">
            <span className="font-semibold text-content">{node.name}</span>
            {node.is_ghost_vault && (
              <Badge tone="accent" size="sm">
                <Sparkles className="w-3 h-3 mr-1 inline" />
                {t('topology.nodeDrawer.ghostVaultNode')}
              </Badge>
            )}
          </div>
        )
      },
      {
        id: 'role',
        header: t('nodes.columns.role'),
        cell: (node) => (
          <Badge
            tone={
              node.role === 'RELAY'
                ? 'success'
                : node.role === 'EXIT_BRIDGE'
                  ? 'accent'
                  : node.role === 'HYBRID'
                    ? 'warning'
                    : 'neutral'
            }
          >
            {node.role}
          </Badge>
        )
      },
      {
        id: 'overlay_ipv4',
        header: t('nodes.columns.ipv4'),
        cell: (node) => <CodeText>{node.overlay_ipv4 ?? '—'}</CodeText>
      },
      {
        id: 'compartment',
        header: t('topology.nodeDrawer.compartment'),
        cell: (node) => (
          <Badge tone={node.is_ghost_vault ? 'accent' : 'neutral'}>{node.compartment_name || 'Default Mesh'}</Badge>
        )
      },
      {
        id: 'latency',
        header: t('topology.nodeDrawer.latency'),
        cell: (node) => (
          <span className="tabular-nums text-subtle">
            {node.latency_ms !== null ? `${node.latency_ms.toFixed(1)} ms` : '—'}
          </span>
        )
      },
      {
        id: 'status',
        header: t('nodes.columns.reachability'),
        cell: (node) =>
          node.is_quarantined ? (
            <Badge tone="danger">{t('nodes.reachability.quarantined')}</Badge>
          ) : node.is_healthy ? (
            <Badge tone="success">{t('nodes.reachability.online')}</Badge>
          ) : (
            <Badge tone="neutral">{t('nodes.reachability.offline')}</Badge>
          )
      },
      {
        id: 'actions',
        header: t('nodes.columns.actions'),
        numeric: true,
        cell: (node) => (
          <Button variant="ghost" size="sm" onClick={() => navigate(nodePath(node.id))}>
            <ExternalLink className="w-3.5 h-3.5 mr-1" />
            {t('topology.nodeDrawer.viewDetails')}
          </Button>
        )
      }
    ],
    [t, navigate]
  );

  return (
    <PageFrame>
      <div className="flex flex-col gap-6">
        {/* Page Header with Ghost Vault Actions */}
        <PageHeader
          title={t('topology.title')}
          description={t('topology.description')}
          actions={
            <div className="flex items-center gap-3">
              {isUnlocked ? (
                <>
                  <Badge tone="accent">
                    <Sparkles className="w-3.5 h-3.5 mr-1" />
                    {t('topology.vault.unlockedBadge')}
                  </Badge>
                  <Button variant="secondary" size="sm" onClick={handleLockVaults} loading={lockMutation.isPending}>
                    <Lock className="w-3.5 h-3.5 mr-1 text-warning" />
                    {t('topology.vault.lockAction')}
                  </Button>
                </>
              ) : (
                <>
                  <Badge tone="neutral">{t('topology.vault.lockedBadge')}</Badge>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setUnlockError(null);
                      setVaultPassword('');
                      setUnlockDialogOpen(true);
                    }}
                  >
                    <KeyRound className="w-3.5 h-3.5 mr-1" />
                    {t('topology.vault.unlockAction')}
                  </Button>
                </>
              )}
            </div>
          }
        />

        {/* Stats Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat
            label={t('topology.stats.nodes')}
            value={filteredNodes.length}
            description={t('topology.stats.nodes')}
          />
          <Stat
            label={t('topology.stats.links')}
            value={filteredLinks.length}
            description={t('topology.stats.links')}
          />
          <Stat
            label={t('topology.stats.compartments')}
            value={compartments.length}
            description={t('topology.stats.compartments')}
          />
          <Stat
            label={t('topology.stats.vaultStatus')}
            value={isUnlocked ? t('topology.vault.unlockedBadge') : t('topology.vault.lockedBadge')}
            description={isUnlocked ? 'Black Ops Vaults active' : 'Plausible deniability active'}
          />
        </div>

        {/* Permissive Mesh Policy Notice */}
        {topology?.policy_is_open && (
          <div className="flex items-center gap-3 p-3 rounded-card bg-warning-subtle border border-warning/30 text-warning text-sm">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span>{t('topology.policyOpenNotice')}</span>
          </div>
        )}

        {/* Controls Toolbar */}
        <Card className="p-4">
          <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-4">
            {/* Search Input */}
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted pointer-events-none" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('topology.searchPlaceholder')}
                className="pl-9"
              />
            </div>

            {/* Filter Selectors & Mode Controls */}
            <div className="flex flex-wrap items-center gap-3">
              {/* Role Filter */}
              <select
                aria-label={t('nodes.columns.role')}
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value as RoleFilter)}
                className="h-9 rounded-control border border-border-strong bg-surface-raised px-3 text-sm text-content focus-visible:outline-focus"
              >
                <option value="ALL">{t('topology.filterRoleAll')}</option>
                <option value="RELAY">{t('topology.filterRoleRelay')}</option>
                <option value="EXIT_BRIDGE">{t('topology.filterRoleExit')}</option>
                <option value="CLIENT_ORIGIN">{t('topology.filterRoleClient')}</option>
                <option value="HYBRID">{t('topology.filterRoleHybrid')}</option>
              </select>

              {/* Compartment Filter */}
              <select
                aria-label={t('topology.nodeDrawer.compartment')}
                value={selectedCompartment}
                onChange={(e) => setSelectedCompartment(e.target.value)}
                className="h-9 rounded-control border border-border-strong bg-surface-raised px-3 text-sm text-content focus-visible:outline-focus"
              >
                <option value="ALL">{t('topology.filterCompartmentAll')}</option>
                {compartments.map((comp) => (
                  <option key={comp.id} value={comp.id}>
                    {comp.name} {comp.is_hidden ? `(${t('topology.nodeDrawer.ghostVaultNode')})` : ''}
                  </option>
                ))}
              </select>

              {/* View Mode Toggle */}
              <div className="flex items-center rounded-control border border-border-strong p-0.5 bg-surface-sunken">
                <button
                  type="button"
                  onClick={() => setViewMode('CANVAS')}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                    viewMode === 'CANVAS'
                      ? 'bg-surface-raised text-content shadow-sm'
                      : 'text-subtle hover:text-content'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5 mr-1.5 inline" />
                  {t('topology.view.canvasMode')}
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('LIST')}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                    viewMode === 'LIST' ? 'bg-surface-raised text-content shadow-sm' : 'text-subtle hover:text-content'
                  }`}
                >
                  <List className="w-3.5 h-3.5 mr-1.5 inline" />
                  {t('topology.view.listMode')}
                </button>
              </div>

              {/* Canvas Controls */}
              {viewMode === 'CANVAS' && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setAutoRotate(!autoRotate)}
                    title={t('topology.view.autoRotate')}
                  >
                    {autoRotate ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRotationAngle(0)}
                    title={t('topology.view.resetView')}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsFullscreen(!isFullscreen)}
                    title={isFullscreen ? t('topology.view.exitFullScreen') : t('topology.view.fullScreen')}
                  >
                    {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                  </Button>
                </>
              )}
            </div>
          </div>
        </Card>

        {/* Main Content Area */}
        {topologyQuery.isLoading ? (
          <Skeleton className="h-[500px] w-full rounded-card" />
        ) : filteredNodes.length === 0 ? (
          <Card className="p-8">
            <EmptyState
              title={t('topology.empty.title')}
              description={t('topology.empty.desc')}
              action={
                <Button variant="primary" onClick={() => navigate(ROUTES.nodes)}>
                  {t('topology.empty.enrollFirst')}
                </Button>
              }
            />
          </Card>
        ) : viewMode === 'CANVAS' ? (
          /* Interactive Canvas View */
          <Card
            ref={containerRef}
            className={`relative overflow-hidden flex items-center justify-center bg-surface-sunken border border-border-strong ${
              isFullscreen ? 'fixed inset-0 z-50 rounded-none' : 'h-[600px]'
            }`}
          >
            <canvas
              ref={canvasRef}
              width={900}
              height={600}
              onClick={handleCanvasClick}
              className="cursor-pointer max-w-full max-h-full"
            />

            {/* Legend Overlay */}
            <div className="absolute bottom-4 left-4 p-3 rounded-card bg-surface-raised/90 border border-border/80 backdrop-blur-md text-xs font-mono space-y-1.5 pointer-events-none shadow-lg">
              <div className="text-muted font-bold mb-1 flex items-center gap-1.5">
                <Globe2 className="w-3.5 h-3.5 text-accent" />
                <span>Topology Mesh Legend</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-success" />
                  <span className="text-subtle">Regional Relay</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-accent" />
                  <span className="text-subtle">Exit Bridge</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-info" />
                  <span className="text-subtle">Client Origin</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-warning" />
                  <span className="text-subtle">Hybrid Peer</span>
                </div>
                <div className="flex items-center gap-1.5 col-span-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-purple-500 ring-2 ring-purple-300" />
                  <span className="text-purple-400 font-semibold">Ghost Vault (Stealth)</span>
                </div>
              </div>
            </div>
          </Card>
        ) : (
          /* Accessible Table List View */
          <Card className="p-4">
            <CardHeader as="h2" title={t('topology.title')} />
            <Table
              columns={tableColumns}
              rows={filteredNodes}
              rowKey={(node) => node.id}
              caption={t('topology.title')}
            />
          </Card>
        )}

        {/* Ghost Vault Unlock Dialog */}
        <Dialog
          open={unlockDialogOpen}
          onOpenChange={setUnlockDialogOpen}
          title={t('topology.vault.dialogTitle')}
          description={t('topology.vault.dialogDesc')}
          footer={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setUnlockDialogOpen(false)}>
                {t('topology.vault.cancel')}
              </Button>
              <Button variant="primary" onClick={handleUnlockSubmit} loading={unlockMutation.isPending}>
                {t('topology.vault.confirmUnlock')}
              </Button>
            </div>
          }
        >
          <form onSubmit={handleUnlockSubmit} className="flex flex-col gap-4 py-2">
            <FormField label={t('topology.vault.passwordLabel')}>
              <Input
                type="password"
                value={vaultPassword}
                onChange={(e) => setVaultPassword(e.target.value)}
                placeholder={t('topology.vault.passwordPlaceholder')}
                autoFocus
              />
            </FormField>
            {unlockError && <p className="text-xs text-danger font-medium">{unlockError}</p>}
          </form>
        </Dialog>

        {/* Selected Node Specs Dialog */}
        <Dialog
          open={!!selectedNode}
          onOpenChange={(open) => {
            if (!open) setSelectedNode(null);
          }}
          title={selectedNode?.name ?? t('topology.nodeDrawer.title')}
          description={selectedNode?.overlay_ipv4 ?? ''}
          footer={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setSelectedNode(null)}>
                {t('topology.nodeDrawer.close')}
              </Button>
              {selectedNode && (
                <Button variant="primary" onClick={() => navigate(nodePath(selectedNode.id))}>
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                  {t('topology.nodeDrawer.viewDetails')}
                </Button>
              )}
            </div>
          }
        >
          {selectedNode && (
            <div className="flex flex-col gap-4 py-2 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col">
                  <span className="text-caption text-subtle">{t('topology.nodeDrawer.role')}</span>
                  <span className="font-semibold text-content">{selectedNode.role}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-caption text-subtle">{t('topology.nodeDrawer.country')}</span>
                  <span className="font-semibold text-content">{selectedNode.country}</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-caption text-subtle">{t('topology.nodeDrawer.overlayIp')}</span>
                  <CodeText>{selectedNode.overlay_ipv4 ?? '—'}</CodeText>
                </div>
                <div className="flex flex-col">
                  <span className="text-caption text-subtle">{t('topology.nodeDrawer.latency')}</span>
                  <span className="tabular-nums font-semibold text-content">
                    {selectedNode.latency_ms !== null ? `${selectedNode.latency_ms.toFixed(1)} ms` : '—'}
                  </span>
                </div>
                <div className="flex flex-col col-span-2">
                  <span className="text-caption text-subtle">{t('topology.nodeDrawer.compartment')}</span>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="font-medium text-content">{selectedNode.compartment_name}</span>
                    {selectedNode.is_ghost_vault && (
                      <Badge tone="accent">
                        <Sparkles className="w-3 h-3 mr-1 inline" />
                        {t('topology.nodeDrawer.ghostVaultNode')}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </Dialog>
      </div>
    </PageFrame>
  );
}
