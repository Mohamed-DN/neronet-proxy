import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  ExternalLink,
  KeyRound,
  Link2,
  List,
  Lock,
  Network,
  RotateCcw,
  Scissors,
  Search,
  ShieldAlert,
  ZoomIn,
  ZoomOut
} from 'lucide-react';

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

import {
  useAclRules,
  useCompartments,
  useCreateAclRule,
  useDeleteAclRule,
  useLockGhostVaults,
  useTopology,
  useUnlockGhostVaults
} from '../../services/queries';
import type { AclRule, Compartment, TopologyLink, TopologyNode } from '../../services/types';

export type RoleFilter = 'ALL' | 'RELAY' | 'EXIT_BRIDGE' | 'CLIENT_ORIGIN' | 'HYBRID';
export type ViewMode = 'CANVAS' | 'LIST';
export type GroupBy = 'compartment' | 'country' | 'role' | 'none';
export type EdgeMode = 'auto' | 'all' | 'selected' | 'none';

const GRAPH_WIDTH = 720;
const GRAPH_HEIGHT = 420;
const BASE_NODE_RADIUS = 16;

const MIN_SCALE = 0.3;
const MAX_SCALE = 6;
const ZOOM_STEP = 1.2;
// Pointer travel, in scene units, past which a press is a drag rather than a click.
const MOVE_EPS = 3;
// It is the number of lines, not of nodes, that makes a mesh unreadable: a full mesh
// of 13 nodes is already 78 of them. Above this many, "auto" draws only what departs
// from the full mesh -- cut links, relayed or onion paths -- plus the selected node's.
const EDGE_AUTO_LINK_LIMIT = 30;
const LABEL_LIMIT = 40;
const DRIFT_LIMIT = 80;

const ZERO: Point = { x: 0, y: 0 };

interface Point {
  x: number;
  y: number;
}

interface PlacedNode {
  node: TopologyNode;
  x: number;
  y: number;
}

interface ClusterBox {
  key: string;
  label: string;
  cx: number;
  cy: number;
  r: number;
  count: number;
}

/** The pan/zoom of the whole scene. Nodes keep their own coordinates; this only
 *  moves and scales the camera over them. */
interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

type Interaction =
  | { kind: 'pan'; startVB: Point; startTx: number; startTy: number; moved: boolean }
  | { kind: 'node'; nodeId: string; grabDX: number; grabDY: number; moved: boolean }
  | null;

interface SelectedLink {
  source: string;
  target: string;
}

function groupValue(node: TopologyNode, groupBy: GroupBy): { key: string; label: string } {
  if (groupBy === 'compartment') {
    return { key: node.compartment_id ?? '__none__', label: node.compartment_name ?? '' };
  }
  if (groupBy === 'country') {
    const c = (node.country ?? '').toUpperCase();
    return { key: c || '__none__', label: c };
  }
  if (groupBy === 'role') {
    return { key: node.role ?? '__none__', label: node.role ?? '' };
  }
  return { key: '__all__', label: '' };
}

/**
 * Lays the fleet out as clusters rather than one ring. Grouping the nodes -- by
 * compartment, region or role -- is what keeps a large mesh legible: a thousand
 * nodes become a few dozen labelled clusters instead of one hairball. The circular
 * seed inside each cluster is deterministic; the operator can still drag any node,
 * and those overrides are kept in component state.
 */
function clusterLayout(
  nodes: TopologyNode[],
  groupBy: GroupBy,
  otherLabel: string
): { placed: PlacedNode[]; clusters: ClusterBox[] } {
  if (nodes.length === 0) return { placed: [], clusters: [] };

  const groups = new Map<string, { label: string; nodes: TopologyNode[] }>();
  for (const n of nodes) {
    const { key, label } = groupValue(n, groupBy);
    const g = groups.get(key) ?? { label: label || otherLabel, nodes: [] };
    g.nodes.push(n);
    groups.set(key, g);
  }

  const keys = [...groups.keys()];
  const k = keys.length;
  const cols = Math.ceil(Math.sqrt(k));
  const rows = Math.ceil(k / cols);
  const padX = 44;
  const padY = 48;
  const cellW = (GRAPH_WIDTH - padX * 2) / cols;
  const cellH = (GRAPH_HEIGHT - padY * 2) / rows;
  const clusterR = Math.max(18, Math.min(cellW, cellH) / 2 - 18);

  const placed: PlacedNode[] = [];
  const clusters: ClusterBox[] = [];

  keys.forEach((key, gi) => {
    const col = gi % cols;
    const row = Math.floor(gi / cols);
    const cx = padX + cellW * (col + 0.5);
    const cy = padY + cellH * (row + 0.5);
    const g = groups.get(key)!;
    const m = g.nodes.length;
    clusters.push({ key, label: g.label || otherLabel, cx, cy, r: clusterR + 8, count: m });

    if (m === 1) {
      placed.push({ node: g.nodes[0]!, x: cx, y: cy });
      return;
    }
    // Phyllotaxis (sunflower) packing spreads the nodes evenly to the cluster edge.
    g.nodes.forEach((node, i) => {
      const rr = clusterR * Math.sqrt((i + 0.5) / m);
      const theta = i * 2.399963229728653;
      placed.push({ node, x: cx + rr * Math.cos(theta), y: cy + rr * Math.sin(theta) });
    });
  });

  return { placed, clusters };
}

function nodeRadiusFor(count: number): number {
  if (count <= 30) return BASE_NODE_RADIUS;
  if (count <= 120) return 9;
  return 6;
}

/** A small, deterministic idle wobble so the canvas feels alive without a physics
 *  engine. Bounded to a couple of pixels and skipped for nodes the operator pinned. */
function driftOffset(id: string, t: number): Point {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  const phase = (h % 628) / 100;
  return { x: Math.sin(t * 0.7 + phase) * 2.2, y: Math.cos(t * 0.5 + phase * 1.3) * 2.2 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Scale the view by `factor` while keeping the scene point under `center`
 *  (in viewBox coordinates) pinned, so a wheel zooms toward the cursor. */
function zoomAt(view: ViewTransform, center: Point, factor: number): ViewTransform {
  const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  const applied = scale / view.scale;
  return {
    scale,
    tx: center.x - applied * (center.x - view.tx),
    ty: center.y - applied * (center.y - view.ty)
  };
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

function vipOf(rule: AclRule, field: 'source' | 'destination'): string {
  const raw = field === 'source' ? (rule.source_cidr ?? rule.src_cidr) : (rule.destination_cidr ?? rule.dst_cidr);
  return (raw ?? '').split('/')[0] ?? '';
}

function usePrefersMotion(): boolean {
  const [motion, setMotion] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: no-preference)');
    setMotion(mq.matches);
    const onChange = () => setMotion(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  return motion;
}

// Stable references so a query still loading its first page does not hand
// every dependent useMemo a fresh empty array on every render.
const EMPTY_NODES: TopologyNode[] = [];
const EMPTY_LINKS: TopologyLink[] = [];
const EMPTY_COMPARTMENTS: Compartment[] = [];
const EMPTY_RULES: AclRule[] = [];

export function TopologyRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const topologyQuery = useTopology();
  const compartmentsQuery = useCompartments();
  const aclRulesQuery = useAclRules();
  const unlockMutation = useUnlockGhostVaults();
  const lockMutation = useLockGhostVaults();
  const createRule = useCreateAclRule();
  const deleteRule = useDeleteAclRule();

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState<RoleFilter>('ALL');
  const [selectedCompartment, setSelectedCompartment] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<ViewMode>('CANVAS');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<SelectedLink | null>(null);
  const [linkActionError, setLinkActionError] = useState<string | null>(null);

  const [groupBy, setGroupBy] = useState<GroupBy>('country');
  const [edgeMode, setEdgeMode] = useState<EdgeMode>('auto');

  // Camera and dragged-node positions. The camera starts centred; node overrides
  // start empty and fill in as the operator drags.
  const [view, setView] = useState<ViewTransform>({ scale: 1, tx: 0, ty: 0 });
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [animateView, setAnimateView] = useState(false);
  const [driftT, setDriftT] = useState(0);

  const [unlockDialogOpen, setUnlockDialogOpen] = useState(false);
  const [vaultPassword, setVaultPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const sceneRef = useRef<SVGGElement | null>(null);
  const interactionRef = useRef<Interaction>(null);

  const prefersMotion = usePrefersMotion();

  const topology = topologyQuery.data;
  const nodes = topology?.nodes ?? EMPTY_NODES;
  const links = topology?.links ?? EMPTY_LINKS;
  const compartments = compartmentsQuery.data ?? EMPTY_COMPARTMENTS;
  const aclRules = aclRulesQuery.data?.rules ?? EMPTY_RULES;

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

  // The clustered seed, then the operator's per-node overrides laid on top.
  const otherLabel = t('topology.canvas.clusterOther');
  const { placed: basePlaced, clusters } = useMemo(
    () => clusterLayout(filteredNodes, groupBy, otherLabel),
    [filteredNodes, groupBy, otherLabel]
  );
  const placedNodes = useMemo<PlacedNode[]>(
    () =>
      basePlaced.map((p) => {
        const override = positions[p.node.id];
        return override ? { node: p.node, x: override.x, y: override.y } : p;
      }),
    [basePlaced, positions]
  );
  const positionById = useMemo(() => {
    const map = new Map<string, PlacedNode>();
    placedNodes.forEach((p) => map.set(p.node.id, p));
    return map;
  }, [placedNodes]);

  const nodeCount = filteredNodes.length;
  const nodeRadius = nodeRadiusFor(nodeCount);
  const showLabels = nodeCount <= LABEL_LIMIT;
  const driftEnabled = prefersMotion && nodeCount <= DRIFT_LIMIT;

  // Idle wobble. Throttled to ~30fps and only for a fleet small enough that
  // animating the DOM stays cheap.
  useEffect(() => {
    if (!driftEnabled) {
      setDriftT(0);
      return undefined;
    }
    let raf = 0;
    let last = 0;
    const start = performance.now();
    const loop = (now: number) => {
      if (now - last > 33) {
        setDriftT((now - start) / 1000);
        last = now;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [driftEnabled]);

  // Effective on-screen position = layout (or drag override) plus idle drift, used
  // for both the node and its links so they stay attached.
  const renderPos = useMemo(() => {
    const map = new Map<string, Point>();
    placedNodes.forEach(({ node, x, y }) => {
      const pinned = positions[node.id] !== undefined;
      const off = driftEnabled && !pinned ? driftOffset(node.id, driftT) : ZERO;
      map.set(node.id, { x: x + off.x, y: y + off.y });
    });
    return map;
  }, [placedNodes, positions, driftEnabled, driftT]);

  // "focus" is what auto falls back to on a busy mesh: the exceptions plus the
  // selection. "selected" is the stricter manual mode: the selection alone.
  const resolvedEdgeMode: 'all' | 'focus' | 'selected' | 'none' =
    edgeMode === 'auto' ? (filteredLinks.length > EDGE_AUTO_LINK_LIMIT ? 'focus' : 'all') : edgeMode;

  const visibleLinks = useMemo(() => {
    if (resolvedEdgeMode === 'none') return EMPTY_LINKS;
    if (resolvedEdgeMode === 'all') return filteredLinks;
    return filteredLinks.filter((l) => {
      const touchesNode = selectedNodeId && (l.source === selectedNodeId || l.target === selectedNodeId);
      const isSelected =
        selectedLink &&
        ((l.source === selectedLink.source && l.target === selectedLink.target) ||
          (l.source === selectedLink.target && l.target === selectedLink.source));
      const isException = l.is_visible === false || (l.mode !== undefined && l.mode !== 'direct');
      return Boolean(touchesNode || isSelected || (resolvedEdgeMode === 'focus' && isException));
    });
  }, [resolvedEdgeMode, filteredLinks, selectedNodeId, selectedLink]);

  // With a node selected, everything it does not reach directly fades back.
  const neighbourIds = useMemo(() => {
    if (!selectedNodeId) return null;
    const ids = new Set<string>([selectedNodeId]);
    for (const l of filteredLinks) {
      if (l.is_visible === false) continue;
      if (l.source === selectedNodeId) ids.add(l.target);
      if (l.target === selectedNodeId) ids.add(l.source);
    }
    return ids;
  }, [selectedNodeId, filteredLinks]);

  const selectedNode = selectedNodeId ? (nodes.find((n) => n.id === selectedNodeId) ?? null) : null;
  const selectedNodeLinks = useMemo(() => {
    if (!selectedNode) return [];
    return filteredLinks.filter((l) => l.source === selectedNode.id || l.target === selectedNode.id);
  }, [selectedNode, filteredLinks]);

  const linkSourceNode = selectedLink ? (nodes.find((n) => n.id === selectedLink.source) ?? null) : null;
  const linkTargetNode = selectedLink ? (nodes.find((n) => n.id === selectedLink.target) ?? null) : null;

  const selectedLinkData = useMemo(() => {
    if (!selectedLink) return null;
    return (
      filteredLinks.find(
        (l) =>
          (l.source === selectedLink.source && l.target === selectedLink.target) ||
          (l.source === selectedLink.target && l.target === selectedLink.source)
      ) ?? null
    );
  }, [selectedLink, filteredLinks]);

  // The DROP rules that actually sever this pair, matched on overlay VIP in either
  // direction. Their presence -- not a local flag -- is what "cut" means, and their
  // ids are what a restore deletes.
  const dropRulesForPair = useMemo(() => {
    if (!linkSourceNode?.overlay_ipv4 || !linkTargetNode?.overlay_ipv4) return [];
    const a = linkSourceNode.overlay_ipv4;
    const b = linkTargetNode.overlay_ipv4;
    return aclRules.filter((r) => {
      if (String(r.action).toUpperCase() !== 'DROP') return false;
      const s = vipOf(r, 'source');
      const d = vipOf(r, 'destination');
      return (s === a && d === b) || (s === b && d === a);
    });
  }, [aclRules, linkSourceNode, linkTargetNode]);

  const isLinkCut = selectedLinkData?.is_visible === false || dropRulesForPair.length > 0;

  // --- Camera and drag interaction ------------------------------------------

  const clientToVB = useCallback((clientX: number, clientY: number): Point | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  const clientToScene = useCallback((clientX: number, clientY: number): Point | null => {
    const g = sceneRef.current;
    const ctm = g?.getScreenCTM();
    if (!g || !ctm) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }, []);

  const handleMove = useCallback(
    (e: PointerEvent) => {
      const it = interactionRef.current;
      if (!it) return;
      if (it.kind === 'pan') {
        const vb = clientToVB(e.clientX, e.clientY);
        if (!vb) return;
        const dx = vb.x - it.startVB.x;
        const dy = vb.y - it.startVB.y;
        if (Math.abs(dx) > MOVE_EPS || Math.abs(dy) > MOVE_EPS) it.moved = true;
        setView((v) => ({ ...v, tx: it.startTx + dx, ty: it.startTy + dy }));
      } else {
        const scene = clientToScene(e.clientX, e.clientY);
        if (!scene) return;
        const nx = scene.x - it.grabDX;
        const ny = scene.y - it.grabDY;
        it.moved = true;
        setPositions((prev) => ({ ...prev, [it.nodeId]: { x: nx, y: ny } }));
      }
    },
    [clientToVB, clientToScene]
  );

  const handleUp = useCallback(() => {
    const it = interactionRef.current;
    interactionRef.current = null;
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
    if (!it) return;
    if (!it.moved) {
      if (it.kind === 'node') {
        setSelectedNodeId(it.nodeId);
        setSelectedLink(null);
        setLinkActionError(null);
      } else {
        setSelectedNodeId(null);
        setSelectedLink(null);
      }
    }
  }, [handleMove]);

  const beginInteraction = useCallback(() => {
    setAnimateView(false);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }, [handleMove, handleUp]);

  // Native, non-passive wheel handler so zooming does not scroll the page.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const vb = clientToVB(e.clientX, e.clientY);
      if (!vb) return;
      setAnimateView(false);
      setView((v) => zoomAt(v, vb, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [clientToVB]);

  useEffect(
    () => () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    },
    [handleMove, handleUp]
  );

  const onBackgroundPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const vb = clientToVB(e.clientX, e.clientY);
    if (!vb) return;
    interactionRef.current = { kind: 'pan', startVB: vb, startTx: view.tx, startTy: view.ty, moved: false };
    beginInteraction();
  };

  const onNodePointerDown = (e: React.PointerEvent<SVGGElement>, nodeId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const placed = renderPos.get(nodeId);
    const scene = clientToScene(e.clientX, e.clientY);
    const grabDX = placed && scene ? scene.x - placed.x : 0;
    const grabDY = placed && scene ? scene.y - placed.y : 0;
    interactionRef.current = { kind: 'node', nodeId, grabDX, grabDY, moved: false };
    beginInteraction();
  };

  const zoomBy = (factor: number) => {
    setAnimateView(true);
    setView((v) => zoomAt(v, { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 }, factor));
  };

  const resetView = () => {
    setAnimateView(true);
    setView({ scale: 1, tx: 0, ty: 0 });
    setPositions({});
  };

  const selectLink = (link: TopologyLink) => {
    setSelectedLink({ source: link.source, target: link.target });
    setSelectedNodeId(null);
    setLinkActionError(null);
  };

  const handleCut = async () => {
    const a = linkSourceNode?.overlay_ipv4;
    const b = linkTargetNode?.overlay_ipv4;
    if (!a || !b) {
      setLinkActionError(t('topology.canvas.needsOverlayIp'));
      return;
    }
    setLinkActionError(null);
    const dropRule = (src: string, dst: string): Partial<AclRule> => ({
      priority: 50,
      source_cidr: `${src}/32`,
      destination_cidr: `${dst}/32`,
      protocol: 'ALL',
      action: 'DROP',
      description: 'mesh-canvas-cut'
    });
    try {
      // Two directional rules so the route is severed both ways, not just outbound.
      await createRule.mutateAsync(dropRule(a, b));
      await createRule.mutateAsync(dropRule(b, a));
    } catch {
      setLinkActionError(t('topology.canvas.cutFailed'));
    }
  };

  const handleRestore = async () => {
    setLinkActionError(null);
    try {
      for (const rule of dropRulesForPair) {
        await deleteRule.mutateAsync(rule.id);
      }
    } catch {
      setLinkActionError(t('topology.canvas.restoreFailed'));
    }
  };

  const linkBusy = createRule.isPending || deleteRule.isPending;

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

  const groupOptions = [
    { value: 'compartment', label: t('topology.canvas.groupCompartment') },
    { value: 'country', label: t('topology.canvas.groupCountry') },
    { value: 'role', label: t('topology.canvas.groupRole') },
    { value: 'none', label: t('topology.canvas.groupNone') }
  ];

  const edgeOptions = [
    { value: 'auto', label: t('topology.canvas.edgesAuto') },
    { value: 'all', label: t('topology.canvas.edgesAll') },
    { value: 'selected', label: t('topology.canvas.edgesSelected') },
    { value: 'none', label: t('topology.canvas.edgesNone') }
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

  const controlButtonClass =
    'inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface/90 text-muted shadow-sm backdrop-blur transition-colors hover:border-border-strong hover:text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus';

  const drawClusters = groupBy !== 'none' && clusters.length > 1;
  const needsSelectionHint =
    (resolvedEdgeMode === 'selected' || resolvedEdgeMode === 'focus') && !selectedNodeId && !selectedLink;

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
                <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="flex items-center gap-2">
                    <span className="text-caption text-muted">{t('topology.canvas.groupByLabel')}</span>
                    <div className="w-40">
                      <Select
                        value={groupBy}
                        onValueChange={(v) => setGroupBy(v as GroupBy)}
                        options={groupOptions}
                        aria-label={t('topology.canvas.groupByLabel')}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-caption text-muted">{t('topology.canvas.edgesLabel')}</span>
                    <div className="w-44">
                      <Select
                        value={edgeMode}
                        onValueChange={(v) => setEdgeMode(v as EdgeMode)}
                        options={edgeOptions}
                        aria-label={t('topology.canvas.edgesLabel')}
                      />
                    </div>
                  </div>
                  <span className="text-caption text-muted sm:ml-auto">
                    {t('topology.canvas.nodeCountBadge', { count: nodeCount })}
                  </span>
                </div>

                <div className="relative">
                  <svg
                    ref={svgRef}
                    viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
                    className="h-[460px] w-full touch-none select-none rounded-card bg-surface-sunken"
                    preserveAspectRatio="xMidYMid meet"
                    role="group"
                    aria-label={t('topology.title')}
                    style={{ cursor: 'grab' }}
                    onPointerDown={onBackgroundPointerDown}
                  >
                    <g
                      ref={sceneRef}
                      transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}
                      style={{ transition: animateView ? 'transform 180ms ease-out' : 'none' }}
                    >
                      {drawClusters &&
                        clusters.map((cluster) => (
                          <g key={`cluster-${cluster.key}`} className="pointer-events-none">
                            <circle
                              cx={cluster.cx}
                              cy={cluster.cy}
                              r={cluster.r}
                              className="fill-surface/40 stroke-border"
                              strokeWidth={1}
                              strokeDasharray="2 3"
                            />
                            <text
                              x={cluster.cx}
                              y={cluster.cy - cluster.r - 6}
                              textAnchor="middle"
                              className="fill-muted text-[10px] font-semibold uppercase tracking-wide"
                            >
                              {cluster.label} · {cluster.count}
                            </text>
                          </g>
                        ))}

                      {visibleLinks.map((link) => {
                        const u = renderPos.get(link.source);
                        const v = renderPos.get(link.target);
                        if (!u || !v) return null;
                        const isCut = link.is_visible === false;
                        const isSelectedLink =
                          selectedLink &&
                          ((selectedLink.source === link.source && selectedLink.target === link.target) ||
                            (selectedLink.source === link.target && selectedLink.target === link.source));
                        const modeClass = isCut
                          ? 'stroke-danger'
                          : (LINK_MODE_STROKE[link.mode ?? 'direct'] ?? 'stroke-border-strong');
                        return (
                          <g
                            key={`${link.source}-${link.target}`}
                            role="button"
                            tabIndex={0}
                            aria-label={`${t('topology.canvas.linkTitle')}: ${positionById.get(link.source)?.node.name || link.source} — ${positionById.get(link.target)?.node.name || link.target}`}
                            className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={() => selectLink(link)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                selectLink(link);
                              }
                            }}
                          >
                            <title>{isCut ? t('topology.canvas.cutBadge') : (link.mode ?? 'direct')}</title>
                            <line x1={u.x} y1={u.y} x2={v.x} y2={v.y} stroke="transparent" strokeWidth={12} />
                            <line
                              x1={u.x}
                              y1={u.y}
                              x2={v.x}
                              y2={v.y}
                              strokeWidth={isSelectedLink ? 3.5 : isCut ? 1.5 : 2}
                              strokeDasharray={isCut ? '4 4' : undefined}
                              className={isSelectedLink ? 'stroke-content' : modeClass}
                            />
                          </g>
                        );
                      })}

                      {placedNodes.map(({ node }) => {
                        const pos = renderPos.get(node.id);
                        if (!pos) return null;
                        const { x, y } = pos;
                        const isSelected = selectedNode?.id === node.id;
                        const isQuarantined = node.is_quarantined;
                        const fillClass = isQuarantined ? 'fill-danger-subtle' : 'fill-accent-subtle';
                        const strokeClass = isQuarantined ? 'stroke-danger' : 'stroke-accent';
                        const faded = neighbourIds !== null && !neighbourIds.has(node.id);
                        return (
                          <g
                            key={node.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`${node.name || node.id} — ${node.role}`}
                            aria-pressed={isSelected}
                            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                            style={{ cursor: 'grab', opacity: faded ? 0.3 : 1, transition: 'opacity 200ms ease-out' }}
                            onPointerDown={(e) => onNodePointerDown(e, node.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                setSelectedNodeId(node.id);
                                setSelectedLink(null);
                              }
                            }}
                          >
                            <title>{`${node.name || node.id} — ${node.role}`}</title>
                            {node.is_ghost_vault && (
                              <circle
                                cx={x}
                                cy={y}
                                r={nodeRadius + 5}
                                className="fill-none stroke-info"
                                strokeDasharray="3 3"
                                strokeWidth={1.5}
                              />
                            )}
                            <circle
                              cx={x}
                              cy={y}
                              r={nodeRadius}
                              strokeWidth={isSelected ? 3 : 2}
                              className={`${fillClass} ${isSelected ? 'stroke-content' : strokeClass}`}
                            />
                            {nodeRadius >= 9 && (
                              <text
                                x={x}
                                y={y}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                className={`${isQuarantined ? 'fill-danger-contrast' : 'fill-accent-contrast'} pointer-events-none text-[9px] font-bold`}
                              >
                                {(node.country || node.name || node.id).slice(0, 2).toUpperCase()}
                              </text>
                            )}
                            {(showLabels || isSelected) && (
                              <text
                                x={x}
                                y={y + nodeRadius + 11}
                                textAnchor="middle"
                                className="pointer-events-none fill-content text-[9px] font-mono"
                              >
                                {(node.name || node.id).slice(0, 14)}
                              </text>
                            )}
                          </g>
                        );
                      })}
                    </g>
                  </svg>

                  {needsSelectionHint && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                      <span className="rounded-full border border-border bg-surface/90 px-3 py-1 text-caption text-muted shadow-sm backdrop-blur">
                        {t('topology.canvas.edgesSelectHint')}
                      </span>
                    </div>
                  )}

                  {/* Camera controls, floated over the canvas. */}
                  <div className="absolute right-3 top-3 flex flex-col gap-1.5">
                    <button
                      type="button"
                      className={controlButtonClass}
                      aria-label={t('topology.canvas.zoomIn')}
                      title={t('topology.canvas.zoomIn')}
                      onClick={() => zoomBy(ZOOM_STEP)}
                    >
                      <ZoomIn className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={controlButtonClass}
                      aria-label={t('topology.canvas.zoomOut')}
                      title={t('topology.canvas.zoomOut')}
                      onClick={() => zoomBy(1 / ZOOM_STEP)}
                    >
                      <ZoomOut className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={controlButtonClass}
                      aria-label={t('topology.canvas.resetView')}
                      title={t('topology.canvas.resetView')}
                      onClick={resetView}
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>

                <p className="mt-2 text-caption text-muted">{t('topology.canvas.hint')}</p>

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
                    <span className="w-4 border-t-2 border-dashed border-danger" /> {t('topology.canvas.cutBadge')}
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
                {selectedLink ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="text-body font-semibold text-content">{t('topology.canvas.linkTitle')}</h2>
                      <Badge tone={isLinkCut ? 'danger' : 'accent'}>
                        {isLinkCut ? t('topology.canvas.cutBadge') : t('topology.canvas.activeBadge')}
                      </Badge>
                    </div>

                    <div className="flex flex-col gap-1 text-caption">
                      <span className="font-mono text-content">{linkSourceNode?.name || selectedLink.source}</span>
                      <span className="text-muted">↕</span>
                      <span className="font-mono text-content">{linkTargetNode?.name || selectedLink.target}</span>
                    </div>

                    {selectedLinkData?.mode && (
                      <div className="text-caption">
                        <span className="text-muted">{t('topology.canvas.mode')}: </span>
                        <span className="font-medium text-content">{selectedLinkData.mode}</span>
                      </div>
                    )}

                    <p className="text-caption text-muted">{t('topology.canvas.cutExplain')}</p>

                    {linkActionError && <p className="text-caption text-danger">{linkActionError}</p>}

                    {isLinkCut ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={Link2}
                        onClick={handleRestore}
                        loading={linkBusy}
                        disabled={dropRulesForPair.length === 0}
                      >
                        {t('topology.canvas.restoreAction')}
                      </Button>
                    ) : (
                      <Button variant="danger" size="sm" icon={Scissors} onClick={handleCut} loading={linkBusy}>
                        {t('topology.canvas.cutAction')}
                      </Button>
                    )}
                  </div>
                ) : selectedNode ? (
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
                  <EmptyState title={t('topology.nodeDrawer.title')} body={t('topology.canvas.selectPrompt')} />
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
