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
  X,
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
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { EmptyState, ErrorState, NotMeasured, Skeleton } from '../../ui/States';
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
import {
  communityLayout,
  groupValue,
  policyNeighborhood,
  policyOverview,
  type PlacedNode,
  type GroupBy
} from './topologyGraph';
import './TopologyRoute.css';

export type RoleFilter = 'ALL' | 'RELAY' | 'EXIT_BRIDGE' | 'CLIENT_ORIGIN' | 'HYBRID';
export type ViewMode = 'CANVAS' | 'LIST';
export type { GroupBy } from './topologyGraph';
export type EdgeMode = 'auto' | 'all' | 'selected' | 'none';

const GRAPH_WIDTH = 1200;
const GRAPH_HEIGHT = 640;
const BASE_NODE_RADIUS = 9;

const MIN_SCALE = 0.3;
const MAX_SCALE = 6;
const ZOOM_STEP = 1.2;
// Pointer travel, in scene units, past which a press is a drag rather than a click.
const MOVE_EPS = 3;
// A moderate mesh opens connected. Above this budget automatic mode retains a
// deterministic overview plus cut exceptions and the selected peer's policy pairs.
const EDGE_AUTO_LINK_LIMIT = 160;
const LABEL_LIMIT = 20;

interface Point {
  x: number;
  y: number;
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

function nodeRadiusFor(count: number): number {
  if (count <= 30) return BASE_NODE_RADIUS;
  if (count <= 120) return 9;
  return 6;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A modest curve carries one policy pair, never intermediate hops. */
function peerPath(a: Point, b: Point, radius: number): string {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 2 * (radius + 2)) return '';
  const inset = (radius + 2) / length;
  const bend = Math.min(24, length * 0.08);
  return `M ${a.x + dx * inset} ${a.y + dy * inset} Q ${(a.x + b.x) / 2 - (dy / length) * bend} ${(a.y + b.y) / 2 + (dx / length) * bend} ${b.x - dx * inset} ${b.y - dy * inset}`;
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
  const { t } = useTranslation('topology');
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
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    window.matchMedia?.('(max-width: 640px)').matches ? 'LIST' : 'CANVAS'
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<SelectedLink | null>(null);
  const [linkActionError, setLinkActionError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [blockConfirmOpen, setBlockConfirmOpen] = useState(false);

  const [groupBy, setGroupBy] = useState<GroupBy>('compartment');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [evidenceView, setEvidenceView] = useState<'policy' | 'observed'>('policy');
  const [edgeMode, setEdgeMode] = useState<EdgeMode>('auto');
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [neighborhoodHops, setNeighborhoodHops] = useState<1 | 2>(1);
  const [communitiesOpen, setCommunitiesOpen] = useState(() => !window.matchMedia?.('(max-width: 1280px)').matches);

  // Camera and dragged-node positions. The camera starts centred; node overrides
  // start empty and fill in as the operator drags.
  const [view, setView] = useState<ViewTransform>({ scale: 1, tx: 0, ty: 0 });
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [animateView, setAnimateView] = useState(false);

  const [unlockDialogOpen, setUnlockDialogOpen] = useState(false);
  const [vaultPassword, setVaultPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(GRAPH_WIDTH);
  const [canvasHeight, setCanvasHeight] = useState(GRAPH_HEIGHT);
  const [canvasElement, setCanvasElement] = useState<SVGSVGElement | null>(null);
  const bindCanvas = useCallback((element: SVGSVGElement | null) => {
    svgRef.current = element;
    setCanvasElement(element);
  }, []);
  useEffect(() => {
    if (!canvasElement || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const box = canvasElement.getBoundingClientRect();
      setCanvasWidth(box.width || GRAPH_WIDTH);
      setCanvasHeight(box.height || GRAPH_HEIGHT);
    };
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(canvasElement);
    return () => observer.disconnect();
  }, [canvasElement]);
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
      if (hiddenGroups.has(groupValue(n, groupBy).key)) return false;
      if (selectedRole !== 'ALL' && n.role !== selectedRole) return false;
      if (selectedCompartment !== 'ALL' && n.compartment_id !== selectedCompartment) return false;
      return true;
    });
  }, [nodes, searchQuery, selectedRole, selectedCompartment, hiddenGroups, groupBy]);

  const filteredLinks = useMemo(() => {
    const visibleIds = new Set(filteredNodes.map((n) => n.id));
    return links.filter((l) => visibleIds.has(l.source) && visibleIds.has(l.target));
  }, [links, filteredNodes]);

  // The clustered seed, then the operator's per-node overrides laid on top.
  const otherLabel = t(groupBy === 'none' ? 'radial.allNodes' : 'canvas.clusterOther');
  const { placed: basePlaced, clusters } = useMemo(
    () => communityLayout(nodes, groupBy, otherLabel, expandedGroups, Boolean(searchQuery.trim())),
    [nodes, groupBy, otherLabel, expandedGroups, searchQuery]
  );
  const placedNodes = useMemo<PlacedNode[]>(
    () =>
      basePlaced
        .filter((p) => filteredNodes.some((node) => node.id === p.node.id))
        .map((p) => {
          const override = positions[p.node.id];
          return override ? { node: p.node, x: override.x, y: override.y } : p;
        }),
    [basePlaced, positions, filteredNodes]
  );
  const positionById = useMemo(() => {
    const map = new Map<string, PlacedNode>();
    placedNodes.forEach((p) => map.set(p.node.id, p));
    return map;
  }, [placedNodes]);

  // Fit the stable inventory envelope to the actual plot aspect ratio. Filters,
  // metric refreshes and dragging do not silently refit the operator's camera.
  const sceneFrame = useMemo(() => {
    const single = clusters.length === 1;
    const left = Math.min(...clusters.map((group) => group.cx - group.r * (single ? 1.6 : 1)), 600) - 70;
    const right = Math.max(...clusters.map((group) => group.cx + group.r * (single ? 1.6 : 1)), 600) + 70;
    const top = Math.min(...clusters.map((group) => group.cy - group.r), 320) - 55;
    const bottom = Math.max(...clusters.map((group) => group.cy + group.r), 320) + 65;
    const aspect = canvasWidth / Math.max(1, canvasHeight);
    const width = Math.max(right - left, (bottom - top) * aspect);
    const height = width / aspect;
    return {
      x: (left + right - width) / 2,
      y: (top + bottom - height) / 2,
      width,
      height,
      cx: (left + right) / 2,
      cy: (top + bottom) / 2
    };
  }, [clusters, canvasWidth, canvasHeight]);
  const labelUnit = sceneFrame.width / Math.max(1, canvasWidth);

  const nodeCount = filteredNodes.length;
  const nodeRadius = nodeRadiusFor(nodeCount);
  const showLabels = nodeCount <= LABEL_LIMIT || view.scale >= 1.8;
  // Stable positions make updates comparable and honour reduced motion.
  const renderPos = useMemo(() => new Map(placedNodes.map(({ node, x, y }) => [node.id, { x, y }])), [placedNodes]);

  // Busy meshes retain a bounded connected overview, plus exceptions and selection.
  const resolvedEdgeMode: 'all' | 'focus' | 'selected' | 'none' =
    edgeMode === 'auto' ? (filteredLinks.length > EDGE_AUTO_LINK_LIMIT ? 'focus' : 'all') : edgeMode;

  const visibleLinks = useMemo(() => {
    // The current API exposes policy pairs, never authenticated peer-path evidence.
    // Keep observed paths explicitly unmeasured until the transport contract exists.
    if (evidenceView === 'observed' || resolvedEdgeMode === 'none') return EMPTY_LINKS;
    if (resolvedEdgeMode === 'all') return filteredLinks;
    const overview = resolvedEdgeMode === 'focus' ? policyOverview(filteredLinks, EDGE_AUTO_LINK_LIMIT) : null;
    return filteredLinks.filter((l) => {
      const touchesNode = selectedNodeId && (l.source === selectedNodeId || l.target === selectedNodeId);
      const isSelected =
        selectedLink &&
        ((l.source === selectedLink.source && l.target === selectedLink.target) ||
          (l.source === selectedLink.target && l.target === selectedLink.source));
      const isException = l.is_visible === false;
      return Boolean(touchesNode || isSelected || (resolvedEdgeMode === 'focus' && (isException || overview?.has(l))));
    });
  }, [evidenceView, resolvedEdgeMode, filteredLinks, selectedNodeId, selectedLink]);

  const neighbourIds = useMemo(
    () => (selectedNodeId ? policyNeighborhood(selectedNodeId, filteredLinks, neighborhoodHops) : null),
    [selectedNodeId, filteredLinks, neighborhoodHops]
  );
  // Peers one hop away. In two-hop mode their edges to second-hop peers are the
  // visible path to the selection, so they keep full weight instead of fading.
  const firstHopIds = useMemo(
    () => (selectedNodeId && neighborhoodHops === 2 ? policyNeighborhood(selectedNodeId, filteredLinks, 1) : null),
    [selectedNodeId, filteredLinks, neighborhoodHops]
  );
  const communityByKey = useMemo(() => new Map(clusters.map((group) => [group.key, group])), [clusters]);
  const communityClass = (node: TopologyNode) =>
    `mesh-community-${communityByKey.get(groupValue(node, groupBy).key)?.color ?? 0}`;

  const selectedNode = selectedNodeId ? (nodes.find((n) => n.id === selectedNodeId) ?? null) : null;
  const selectedNodeLinks = useMemo(() => {
    if (!selectedNode) return [];
    return filteredLinks.filter(
      (l) => l.is_visible !== false && (l.source === selectedNode.id || l.target === selectedNode.id)
    );
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
    const svg = canvasElement;
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
  }, [canvasElement, clientToVB]);

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
    setView((v) => zoomAt(v, { x: sceneFrame.cx, y: sceneFrame.cy }, factor));
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
    setLinkNotice(null);
  };

  /**
   * Blocks a link as one unit: two DROP rules, one per direction. If the second
   * rule fails, the first is deleted again so the link is never half blocked. If
   * that delete also fails, the surviving rule id is named for the operator.
   */
  const handleCut = async () => {
    setBlockConfirmOpen(false);
    const a = linkSourceNode?.overlay_ipv4;
    const b = linkTargetNode?.overlay_ipv4;
    if (!a || !b) {
      setLinkNotice(null);
      setLinkActionError(t('canvas.needsOverlayIp'));
      return;
    }
    setLinkActionError(null);
    setLinkNotice(null);
    const dropRule = (src: string, dst: string): Partial<AclRule> => ({
      priority: 50,
      source_cidr: `${src}/32`,
      destination_cidr: `${dst}/32`,
      protocol: 'ALL',
      action: 'DROP',
      description: 'mesh-canvas-cut'
    });

    let firstRuleId: string;
    try {
      const created = await createRule.mutateAsync(dropRule(a, b));
      firstRuleId = created.rule.id;
    } catch {
      setLinkActionError(t('canvas.cutFailed'));
      return;
    }

    try {
      await createRule.mutateAsync(dropRule(b, a));
    } catch {
      try {
        await deleteRule.mutateAsync(firstRuleId);
        setLinkActionError(t('canvas.cutFailed'));
      } catch {
        setLinkActionError(t('canvas.partial', { id: firstRuleId }));
      }
      return;
    }

    setLinkNotice(t('canvas.done'));
  };

  /**
   * Unblocks a link: deletes each DROP rule of the pair, then reads the rule list
   * again. A rule still present after the refetch is named, not reported as gone.
   */
  const handleRestore = async () => {
    setLinkActionError(null);
    setLinkNotice(null);
    const ids = dropRulesForPair.map((rule) => rule.id);
    for (const id of ids) {
      try {
        await deleteRule.mutateAsync(id);
      } catch {
        // The refetch below decides what survived; nothing is assumed here.
      }
    }
    const refreshed = await aclRulesQuery.refetch();
    const survivors = (refreshed.data?.rules ?? []).filter((rule) => ids.includes(rule.id)).map((rule) => rule.id);
    if (survivors.length > 0) {
      setLinkActionError(t('canvas.restorePartial', { ids: survivors.join(', ') }));
    } else {
      setLinkNotice(t('canvas.restoreDone'));
    }
  };

  const linkBusy = createRule.isPending || deleteRule.isPending;

  const roleOptions = [
    { value: 'ALL', label: t('filterRoleAll') },
    { value: 'RELAY', label: t('filterRoleRelay') },
    { value: 'EXIT_BRIDGE', label: t('filterRoleExit') },
    { value: 'CLIENT_ORIGIN', label: t('filterRoleClient') },
    { value: 'HYBRID', label: t('filterRoleHybrid') }
  ];

  const compartmentOptions = [
    { value: 'ALL', label: t('filterCompartmentAll') },
    ...compartments.map((c: Compartment) => ({ value: c.id, label: c.name }))
  ];

  const groupOptions = [
    { value: 'compartment', label: t('canvas.groupCompartment') },
    { value: 'country', label: t('canvas.groupCountry') },
    { value: 'role', label: t('canvas.groupRole') },
    { value: 'none', label: t('canvas.groupNone') }
  ];

  const edgeOptions = [
    { value: 'auto', label: t('canvas.edgesAuto') },
    { value: 'all', label: t('canvas.edgesAll') },
    { value: 'selected', label: t('canvas.edgesSelected') },
    { value: 'none', label: t('canvas.edgesNone') }
  ];

  const handleUnlock = async () => {
    setUnlockError(null);
    try {
      await unlockMutation.mutateAsync(vaultPassword);
      setUnlockDialogOpen(false);
      setVaultPassword('');
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : t('vault.unlockFailed'));
    }
  };

  const listColumns: TableColumn<TopologyNode>[] = [
    {
      id: 'node',
      header: t('columns.node'),
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-body font-semibold text-content">{row.name || row.id}</span>
          {row.is_ghost_vault && (
            <Badge tone="warning" className="text-[10px]">
              {t('nodeDrawer.ghostVaultNode')}
            </Badge>
          )}
        </div>
      )
    },
    {
      id: 'role',
      header: t('columns.role'),
      cell: (row) => <Badge tone={row.role === 'RELAY' ? 'accent' : 'neutral'}>{row.role}</Badge>
    },
    {
      id: 'overlayIp',
      header: t('nodeDrawer.overlayIp'),
      cell: (row) =>
        row.overlay_ipv4 ? <CodeText>{row.overlay_ipv4}</CodeText> : <span className="text-muted">—</span>
    },
    {
      id: 'country',
      header: t('nodeDrawer.country'),
      cell: (row) => <span className="font-mono text-caption">{row.country || '—'}</span>
    },
    {
      id: 'compartment',
      header: t('nodeDrawer.compartment'),
      cell: (row) => <span className="text-caption text-muted">{row.compartment_name || '—'}</span>
    },
    {
      id: 'latency',
      header: t('nodeDrawer.latency'),
      numeric: true,
      cell: (row) =>
        row.latency_ms === null || row.latency_ms === undefined ? (
          <NotMeasured />
        ) : (
          <span className="font-mono text-caption text-muted">{`${row.latency_ms} ms`}</span>
        )
    },
    {
      id: 'status',
      header: t('columns.status'),
      cell: (row) => (
        <StatusBadge
          status={nodeStatus(row)}
          label={
            row.is_quarantined
              ? t('nodeDrawer.quarantined')
              : row.is_healthy
                ? t('nodeDrawer.healthy')
                : t('nodeDrawer.unhealthy')
          }
        />
      )
    }
  ];

  const totalNodes = nodes.length;
  const noNodesAtAll = totalNodes === 0;

  const controlButtonClass =
    'inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface text-content transition-colors hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus';

  const needsSelectionHint =
    (resolvedEdgeMode === 'selected' || resolvedEdgeMode === 'focus') && !selectedNodeId && !selectedLink;

  return (
    <PageFrame>
      <div className="mesh-route">
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant={viewMode === 'CANVAS' ? 'primary' : 'secondary'}
                size="sm"
                icon={Network}
                onClick={() => setViewMode('CANVAS')}
              >
                {t('view.canvasMode')}
              </Button>
              <Button
                variant={viewMode === 'LIST' ? 'primary' : 'secondary'}
                size="sm"
                icon={List}
                onClick={() => setViewMode('LIST')}
              >
                {t('view.listMode')}
              </Button>
              {isUnlocked ? (
                <Button
                  variant="danger"
                  size="sm"
                  icon={Lock}
                  onClick={() => lockMutation.mutate()}
                  loading={lockMutation.isPending}
                >
                  {t('vault.lockAction')}
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
                  {t('vault.unlockAction')}
                </Button>
              )}
            </div>
          }
        />

        <div className="mesh-summary" aria-label={t('radial.summary')}>
          <span>
            <strong>{filteredNodes.length}</strong> {t('stats.nodes')}
          </span>
          <span>
            <strong>{filteredLinks.filter((link) => link.is_visible !== false).length}</strong>{' '}
            {t('radial.allowedPairs')}
          </span>
          <span>
            <strong>{compartments.length}</strong> {t('stats.compartments')}
          </span>
          {topology?.policy_is_open && (
            <details className="mesh-policy-disclosure">
              <summary>
                <ShieldAlert aria-hidden="true" size={14} />
                {t('radial.openPolicy')}
              </summary>
              <p>{t('policyOpenNotice')}</p>
            </details>
          )}
          <span className="sm:ml-auto">{isUnlocked ? t('vault.unlockedBadge') : t('vault.lockedBadge')}</span>
        </div>

        {!noNodesAtAll && (
          <div className="mesh-filters flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative max-w-md flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('searchPlaceholder')}
                className="pl-9"
                aria-label={t('searchPlaceholder')}
              />
            </div>
            <div className="w-full sm:w-48">
              <Select
                value={selectedRole}
                onValueChange={(v) => setSelectedRole(v as RoleFilter)}
                options={roleOptions}
                aria-label={t('filterRoleAll')}
              />
            </div>
            <div className="w-full sm:w-56">
              <Select
                value={selectedCompartment}
                onValueChange={setSelectedCompartment}
                options={compartmentOptions}
                aria-label={t('filterCompartmentAll')}
              />
            </div>
            {hiddenGroups.size > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setHiddenGroups(new Set())}>
                {t('graph.resetFilters')}
              </Button>
            )}
          </div>
        )}

        {topologyQuery.isPending ? (
          <div role="status" aria-label={t('radial.loading')} className="p-6">
            <Skeleton lines={8} />
          </div>
        ) : topologyQuery.isError ? (
          <ErrorState onRetry={() => void topologyQuery.refetch()} />
        ) : noNodesAtAll ? (
          <Card>
            <EmptyState title={t('empty.title')} body={t('empty.enrollFirst')} />
          </Card>
        ) : viewMode === 'CANVAS' ? (
          <Card flush className="mesh-surface overflow-hidden">
            {
              <div className="mesh-workspace">
                <section
                  id="mesh-communities"
                  className="mesh-communities"
                  hidden={!communitiesOpen}
                  aria-label={t('graph.communities')}
                >
                  <div className="mesh-community-heading">
                    <h2>{t('graph.communities')}</h2>
                    <span>{clusters.length}</span>
                  </div>
                  <p className="mesh-community-caption">{t('graph.inventoryGroups')}</p>
                  <label className="mesh-community-all">
                    <input
                      type="checkbox"
                      checked={hiddenGroups.size === 0}
                      ref={(element) => {
                        if (element)
                          element.indeterminate = hiddenGroups.size > 0 && hiddenGroups.size < clusters.length;
                      }}
                      onChange={(event) =>
                        setHiddenGroups(event.target.checked ? new Set() : new Set(clusters.map((group) => group.key)))
                      }
                    />
                    {t('graph.selectAll')}
                  </label>
                  <div className="mesh-community-list">
                    {clusters.map((cluster) => (
                      <div key={cluster.key} className={`mesh-community-row mesh-community-${cluster.color}`}>
                        <label className="mesh-community-filter">
                          <input
                            type="checkbox"
                            checked={!hiddenGroups.has(cluster.key)}
                            onChange={() =>
                              setHiddenGroups((previous) => {
                                const next = new Set(previous);
                                if (next.has(cluster.key)) next.delete(cluster.key);
                                else next.add(cluster.key);
                                return next;
                              })
                            }
                          />
                          <span className="mesh-community-dot" aria-hidden="true" />
                          <span className="mesh-community-name">{cluster.label}</span>
                          <span className="mesh-community-count">{cluster.count}</span>
                        </label>
                        <button
                          type="button"
                          className="mesh-group-control"
                          aria-expanded={cluster.expanded}
                          aria-label={[
                            t(cluster.expanded ? 'radial.collapse' : 'radial.expand', {
                              name: cluster.label
                            }),
                            cluster.unhealthy ? t('radial.groupUnhealthy', { count: cluster.unhealthy }) : '',
                            cluster.quarantined ? t('radial.groupQuarantined', { count: cluster.quarantined }) : ''
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                          onClick={() =>
                            setExpandedGroups((previous) => ({ ...previous, [cluster.key]: !cluster.expanded }))
                          }
                        >
                          <span>{t(cluster.expanded ? 'graph.fold' : 'graph.unfold')}</span>
                          {cluster.unhealthy > 0 && (
                            <span className="text-warning">
                              {t('radial.groupUnhealthy', { count: cluster.unhealthy })}
                            </span>
                          )}
                          {cluster.quarantined > 0 && (
                            <span className="text-danger">
                              {t('radial.groupQuarantined', { count: cluster.quarantined })}
                            </span>
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="mesh-community-footnote">{t('graph.scopedCounts')}</p>
                </section>
                <div className="mesh-map-panel">
                  <div className="mesh-toolbar">
                    <div className="mesh-evidence" aria-label={t('radial.evidence')}>
                      <button
                        type="button"
                        aria-pressed={evidenceView === 'policy'}
                        onClick={() => setEvidenceView('policy')}
                      >
                        {t('radial.policy')}
                      </button>
                      <button
                        type="button"
                        aria-pressed={evidenceView === 'observed'}
                        onClick={() => {
                          setEvidenceView('observed');
                          setSelectedLink(null);
                        }}
                      >
                        {t('radial.observed')}
                      </button>
                      <button
                        type="button"
                        className="mesh-community-toggle"
                        aria-expanded={communitiesOpen}
                        aria-controls="mesh-communities"
                        onClick={() => setCommunitiesOpen((open) => !open)}
                      >
                        {t('graph.communities')} <span>{clusters.length}</span>
                      </button>
                    </div>
                    <div className="mesh-options flex flex-col gap-2 sm:flex-row sm:items-center">
                      <div className="flex items-center gap-2">
                        <span className="text-caption text-muted">{t('canvas.groupByLabel')}</span>
                        <div className="w-40">
                          <Select
                            value={groupBy}
                            onValueChange={(v) => {
                              setGroupBy(v as GroupBy);
                              setHiddenGroups(new Set());
                            }}
                            options={groupOptions}
                            aria-label={t('canvas.groupByLabel')}
                          />
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-caption text-muted">{t('canvas.edgesLabel')}</span>
                        <div className="w-44">
                          <Select
                            value={edgeMode}
                            onValueChange={(v) => setEdgeMode(v as EdgeMode)}
                            options={edgeOptions}
                            aria-label={t('canvas.edgesLabel')}
                          />
                        </div>
                      </div>
                      <span className="text-caption text-muted sm:ml-auto">
                        {t('canvas.nodeCountBadge', { count: nodeCount })}
                      </span>
                    </div>
                  </div>
                  <div className="relative">
                    <svg
                      ref={bindCanvas}
                      viewBox={`${sceneFrame.x} ${sceneFrame.y} ${sceneFrame.width} ${sceneFrame.height}`}
                      className="mesh-canvas w-full touch-none select-none"
                      preserveAspectRatio="xMidYMid meet"
                      role="group"
                      tabIndex={-1}
                      aria-label={t('title')}
                      style={{ cursor: 'grab' }}
                      onPointerDown={onBackgroundPointerDown}
                    >
                      <g
                        ref={sceneRef}
                        transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}
                        style={{ transition: animateView && prefersMotion ? 'transform 180ms ease-out' : 'none' }}
                      >
                        {clusters
                          .filter(
                            (cluster) =>
                              !cluster.expanded &&
                              !hiddenGroups.has(cluster.key) &&
                              filteredNodes.some((node) => groupValue(node, groupBy).key === cluster.key)
                          )
                          .map((cluster) => (
                            <g
                              key={cluster.key}
                              className={`mesh-aggregate mesh-community-${cluster.color}`}
                              role="button"
                              tabIndex={0}
                              aria-label={t('graph.aggregate', { name: cluster.label, count: cluster.count })}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={() => setExpandedGroups((previous) => ({ ...previous, [cluster.key]: true }))}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault();
                                  setExpandedGroups((previous) => ({ ...previous, [cluster.key]: true }));
                                }
                              }}
                            >
                              <circle cx={cluster.cx} cy={cluster.cy} r={24 * labelUnit} />
                              <text
                                x={cluster.cx}
                                y={cluster.cy + 5}
                                textAnchor="middle"
                                className="mesh-aggregate-count"
                                style={{ fontSize: 18 * labelUnit }}
                              >
                                {cluster.count}
                              </text>
                              <text
                                x={cluster.cx}
                                y={cluster.cy + 48 * labelUnit}
                                textAnchor="middle"
                                className="fill-content"
                                style={{ fontSize: 13 * labelUnit }}
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
                          const path = peerPath(u, v, nodeRadius);
                          const isSelectedLink =
                            selectedLink &&
                            ((selectedLink.source === link.source && selectedLink.target === link.target) ||
                              (selectedLink.source === link.target && selectedLink.target === link.source));
                          const isNeighbourLink =
                            selectedNodeId === link.source ||
                            selectedNodeId === link.target ||
                            (firstHopIds !== null &&
                              neighbourIds !== null &&
                              neighbourIds.has(link.source) &&
                              neighbourIds.has(link.target) &&
                              (firstHopIds.has(link.source) || firstHopIds.has(link.target)));
                          const modeClass = isCut ? 'stroke-danger' : 'mesh-community-stroke';
                          return (
                            <g
                              key={`${link.source}-${link.target}`}
                              data-mesh-link="policy"
                              role="button"
                              tabIndex={0}
                              aria-label={`${t('canvas.linkTitle')}: ${positionById.get(link.source)?.node.name || link.source} — ${positionById.get(link.target)?.node.name || link.target}`}
                              className={`mesh-policy-edge ${communityClass(positionById.get(link.source)!.node)} cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus`}
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={() => selectLink(link)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  selectLink(link);
                                }
                              }}
                            >
                              <title>{isCut ? t('canvas.cutBadge') : t('radial.policy')}</title>
                              <path d={path} fill="none" stroke="transparent" strokeWidth={12} />
                              <path
                                d={path}
                                fill="none"
                                strokeWidth={isSelectedLink || isNeighbourLink ? 2 : 1.5}
                                vectorEffect="non-scaling-stroke"
                                opacity={selectedNodeId && !isNeighbourLink ? 0.12 : 0.95}
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
                          const fillClass = isQuarantined
                            ? 'fill-danger-subtle'
                            : node.is_healthy
                              ? 'mesh-community-fill'
                              : 'fill-warning-subtle';
                          const strokeClass = isQuarantined
                            ? 'stroke-danger'
                            : node.is_healthy
                              ? 'mesh-community-stroke'
                              : 'stroke-warning';
                          const faded = neighbourIds !== null && !neighbourIds.has(node.id);
                          return (
                            <g
                              key={node.id}
                              role="button"
                              tabIndex={0}
                              aria-label={`${node.name || node.id} — ${node.role}`}
                              aria-pressed={isSelected}
                              data-node-id={node.id}
                              className={`${communityClass(node)} focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus`}
                              style={{ cursor: 'grab', opacity: faded ? 0.3 : 1 }}
                              data-neighbour={faded ? 'false' : 'true'}
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
                                strokeDasharray={!node.is_healthy && !isQuarantined ? '4 3' : undefined}
                                className={`${fillClass} ${isSelected ? 'stroke-content' : strokeClass}`}
                              />
                              <circle cx={x} cy={y} r={Math.max(22 * labelUnit, nodeRadius)} fill="transparent" />
                              {/* The selected label is painted in an overlay after every peer (below). */}
                              {showLabels && !isSelected && (
                                <g className="pointer-events-none mesh-node-label">
                                  <text
                                    x={x}
                                    y={y + nodeRadius + 20 * labelUnit}
                                    textAnchor="middle"
                                    className="fill-content font-semibold"
                                    style={{ fontSize: 13 * labelUnit }}
                                  >
                                    {(node.name || node.id).slice(0, 28)}
                                  </text>
                                  {view.scale >= 1.8 && (
                                    <text
                                      x={x}
                                      y={y + nodeRadius + 38 * labelUnit}
                                      textAnchor="middle"
                                      className="fill-subtle font-mono"
                                      style={{ fontSize: 11 * labelUnit }}
                                    >
                                      {node.overlay_ipv4 || '—'} · {node.country || '—'}
                                    </text>
                                  )}
                                </g>
                              )}
                            </g>
                          );
                        })}

                        {(() => {
                          // Painted last so neighbouring peers never cover it; DOM order of the
                          // focusable peers (and therefore keyboard order) stays unchanged.
                          if (!selectedNode || !placedNodes.some(({ node }) => node.id === selectedNode.id))
                            return null;
                          const pos = renderPos.get(selectedNode.id);
                          if (!pos) return null;
                          return (
                            <g aria-hidden="true" data-selected-label className="pointer-events-none mesh-node-label">
                              <text
                                x={pos.x}
                                y={pos.y + nodeRadius + 20 * labelUnit}
                                textAnchor="middle"
                                className="fill-content font-semibold"
                                style={{ fontSize: 13 * labelUnit }}
                              >
                                {(selectedNode.name || selectedNode.id).slice(0, 28)}
                              </text>
                              <text
                                x={pos.x}
                                y={pos.y + nodeRadius + 38 * labelUnit}
                                textAnchor="middle"
                                className="fill-subtle font-mono"
                                style={{ fontSize: 11 * labelUnit }}
                              >
                                {selectedNode.overlay_ipv4 || '—'} · {selectedNode.country || '—'}
                              </text>
                            </g>
                          );
                        })()}
                      </g>
                    </svg>

                    {filteredNodes.length === 0 && (
                      <div className="mesh-no-matches" role="status">
                        <p>{t('graph.noMatches')}</p>
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery('');
                            setSelectedRole('ALL');
                            setSelectedCompartment('ALL');
                            setHiddenGroups(new Set());
                          }}
                        >
                          {t('graph.resetFilters')}
                        </button>
                      </div>
                    )}
                    {evidenceView === 'policy' && needsSelectionHint && (
                      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                        <span className="rounded-full border border-border bg-surface/90 px-3 py-1 text-caption text-muted shadow-sm backdrop-blur">
                          {t('canvas.edgesSelectHint')}
                        </span>
                      </div>
                    )}

                    {/* Camera controls, floated over the canvas. */}
                    <div className="absolute left-4 bottom-4 flex gap-1.5">
                      <button
                        type="button"
                        className={controlButtonClass}
                        aria-label={t('canvas.zoomIn')}
                        title={t('canvas.zoomIn')}
                        onClick={() => zoomBy(ZOOM_STEP)}
                      >
                        <ZoomIn className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={controlButtonClass}
                        aria-label={t('canvas.zoomOut')}
                        title={t('canvas.zoomOut')}
                        onClick={() => zoomBy(1 / ZOOM_STEP)}
                      >
                        <ZoomOut className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={controlButtonClass}
                        aria-label={t('canvas.resetView')}
                        title={t('canvas.resetView')}
                        onClick={resetView}
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  {evidenceView === 'observed' && (
                    <p role="status" className="mesh-unmeasured">
                      {t('radial.unmeasured')}
                    </p>
                  )}
                  {evidenceView === 'policy' && resolvedEdgeMode === 'focus' && (
                    <p className="mesh-overview-caption">
                      {t('graph.overviewSubset', { shown: visibleLinks.length, total: filteredLinks.length })}
                    </p>
                  )}
                  <p className="mesh-explanation text-caption text-subtle">
                    {t(evidenceView === 'policy' ? 'radial.policyExplain' : 'radial.observedExplain')}{' '}
                    {t('canvas.hint')}
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-muted">
                    <span className="flex items-center gap-1.5">
                      <span className="w-4 border-t border-accent" /> {t('radial.policy')}
                    </span>
                    {/* Only what the view can know. Nothing measures whether a pair is
                      relayed or onion-routed, and there is no OpenVPN transport, so
                      those used to sit here describing paths the mesh never took. */}
                    <span className="flex items-center gap-1.5">
                      <span className="w-4 border-t-2 border-dashed border-danger" /> {t('canvas.cutBadge')}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full border border-dashed border-warning" />{' '}
                      {t('nodeDrawer.unhealthy')}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-danger" /> {t('nodeDrawer.quarantined')}
                      <GlossaryHint
                        text={t('glossary:terms.quarantine.body')}
                        label={t('glossary:ariaLabel', {
                          term: t('glossary:terms.quarantine.term')
                        })}
                      />
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full border border-dashed border-info" />{' '}
                      {t('nodeDrawer.ghostVaultNode')}
                    </span>
                  </div>
                </div>

                {(selectedLink || selectedNode) && (
                  <aside className="mesh-inspector" aria-label={t('nodeDrawer.title')}>
                    <button
                      type="button"
                      className="mesh-inspector-close"
                      aria-label={t('radial.closeDetails')}
                      onClick={() => {
                        setSelectedNodeId(null);
                        setSelectedLink(null);
                        svgRef.current?.focus();
                      }}
                    >
                      <X size={18} aria-hidden="true" />
                    </button>
                    {selectedLink ? (
                      <div className="flex flex-col gap-3">
                        <div className="flex items-start justify-between gap-2">
                          <h2 className="text-body font-semibold text-content">{t('canvas.linkTitle')}</h2>
                          <Badge tone={isLinkCut ? 'danger' : 'accent'}>
                            {isLinkCut ? t('canvas.cutBadge') : t('radial.allowed')}
                          </Badge>
                        </div>

                        <div className="flex flex-col gap-1 text-caption">
                          <span className="font-mono text-content">{linkSourceNode?.name || selectedLink.source}</span>
                          <span className="text-muted">↕</span>
                          <span className="font-mono text-content">{linkTargetNode?.name || selectedLink.target}</span>
                        </div>

                        <div className="text-caption">
                          <span className="text-subtle">{t('radial.transport')}: </span>
                          <span>{t('state.notMeasured')}</span>
                        </div>

                        <p className="text-caption text-muted">{t('canvas.cutExplain')}</p>

                        {linkActionError && (
                          <p role="alert" className="text-caption text-danger">
                            {linkActionError}
                          </p>
                        )}
                        {linkNotice && (
                          <p role="status" className="text-caption text-success">
                            {linkNotice}
                          </p>
                        )}

                        {isLinkCut ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            icon={Link2}
                            onClick={handleRestore}
                            loading={linkBusy}
                            disabled={dropRulesForPair.length === 0}
                          >
                            {t('canvas.restoreAction')}
                          </Button>
                        ) : (
                          <Button
                            variant="danger"
                            size="sm"
                            icon={Scissors}
                            onClick={() => setBlockConfirmOpen(true)}
                            loading={linkBusy}
                          >
                            {t('canvas.cutAction')}
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
                                  text={t('glossary:terms.overlayAddress.body')}
                                  label={t('glossary:ariaLabel', {
                                    term: t('glossary:terms.overlayAddress.term')
                                  })}
                                />
                              </span>
                            )}
                          </div>
                          <StatusBadge
                            status={nodeStatus(selectedNode)}
                            label={
                              selectedNode.is_quarantined
                                ? t('nodeDrawer.quarantined')
                                : selectedNode.is_healthy
                                  ? t('nodeDrawer.healthy')
                                  : t('nodeDrawer.unhealthy')
                            }
                          />
                        </div>

                        {selectedNode.is_ghost_vault && <Badge tone="warning">{t('nodeDrawer.ghostVaultNode')}</Badge>}

                        <dl className="grid grid-cols-2 gap-2 text-caption">
                          <div>
                            <dt className="text-muted">{t('nodeDrawer.role')}</dt>
                            <dd className="font-medium text-content">{selectedNode.role}</dd>
                          </div>
                          <div>
                            <dt className="text-muted">{t('nodeDrawer.country')}</dt>
                            <dd className="font-medium text-content">{selectedNode.country || '—'}</dd>
                          </div>
                          <div>
                            <dt className="text-muted">{t('nodeDrawer.latency')}</dt>
                            <dd className="font-medium text-content">
                              {selectedNode.latency_ms !== null && selectedNode.latency_ms !== undefined
                                ? `${selectedNode.latency_ms} ms`
                                : t('state.notMeasured')}
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted">{t('nodeDrawer.compartment')}</dt>
                            <dd className="font-medium text-content">{selectedNode.compartment_name || '—'}</dd>
                          </div>
                        </dl>

                        <div className="text-caption text-subtle">
                          {t('radial.transport')}: {t('state.notMeasured')}
                        </div>
                        <div className="text-caption text-muted">
                          {t('radial.allowedPairs')}: {selectedNodeLinks.length}
                        </div>
                        <div className="mesh-neighborhood" role="group" aria-label={t('graph.neighborhood')}>
                          <div className="mesh-neighborhood-heading">
                            <h3>{t('graph.neighborhood')}</h3>
                            <span className="mesh-community-count" data-neighbour-count>
                              {neighbourIds ? Math.max(0, neighbourIds.size - 1) : 0}
                            </span>
                          </div>
                          <div className="mesh-hop-controls">
                            {([1, 2] as const).map((hops) => (
                              <button
                                key={hops}
                                type="button"
                                aria-pressed={neighborhoodHops === hops}
                                onClick={() => setNeighborhoodHops(hops)}
                              >
                                {t('graph.hops', { count: hops })}
                              </button>
                            ))}
                          </div>
                          <p>{t('graph.policyOnly')}</p>
                          <ul>
                            {filteredNodes
                              .filter((node) => node.id !== selectedNode.id && neighbourIds?.has(node.id))
                              .slice(0, 50)
                              .map((node) => (
                                <li key={node.id}>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setSelectedNodeId(node.id);
                                      setExpandedGroups((previous) => ({
                                        ...previous,
                                        [groupValue(node, groupBy).key]: true
                                      }));
                                    }}
                                  >
                                    {node.name || node.id}
                                    <span>{node.role}</span>
                                  </button>
                                </li>
                              ))}
                          </ul>
                          {neighbourIds && neighbourIds.size > 51 && <p>{t('graph.neighborLimit')}</p>}
                        </div>

                        <Button
                          variant="secondary"
                          size="sm"
                          icon={ExternalLink}
                          onClick={() => navigate(nodePath(selectedNode.id))}
                        >
                          {t('nodeDrawer.viewDetails')}
                        </Button>
                      </div>
                    ) : (
                      <EmptyState title={t('nodeDrawer.title')} body={t('canvas.selectPrompt')} />
                    )}
                  </aside>
                )}
              </div>
            }
          </Card>
        ) : (
          <Card flush>
            <Table<TopologyNode>
              caption={t('title')}
              columns={listColumns}
              rows={filteredNodes}
              rowKey={(row) => row.id}
              empty={<EmptyState title={t('empty.title')} body={t('empty.desc')} />}
            />
          </Card>
        )}

        <ConfirmDialog
          open={blockConfirmOpen}
          onOpenChange={setBlockConfirmOpen}
          title={t('canvas.confirmTitle')}
          description={t('canvas.confirmBody')}
          confirmLabel={t('canvas.cutAction')}
          tone="danger"
          onConfirm={() => void handleCut()}
          busy={linkBusy}
        />

        <Dialog
          open={unlockDialogOpen}
          onOpenChange={(open) => {
            setUnlockDialogOpen(open);
            if (!open) setUnlockError(null);
          }}
          title={t('vault.dialogTitle')}
          description={t('vault.dialogDesc')}
          footer={
            <>
              <Button variant="secondary" onClick={() => setUnlockDialogOpen(false)}>
                {t('vault.cancel')}
              </Button>
              <Button variant="primary" onClick={handleUnlock} loading={unlockMutation.isPending}>
                {t('vault.confirmUnlock')}
              </Button>
            </>
          }
        >
          <FormField label={t('vault.passwordLabel')} error={unlockError}>
            <Input
              type="password"
              value={vaultPassword}
              onChange={(e) => setVaultPassword(e.target.value)}
              placeholder={t('vault.passwordPlaceholder')}
            />
          </FormField>
        </Dialog>
      </div>
    </PageFrame>
  );
}

export default TopologyRoute;
