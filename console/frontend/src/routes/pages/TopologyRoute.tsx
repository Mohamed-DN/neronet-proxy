import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  ExternalLink,
  KeyRound,
  Link2,
  List,
  Lock,
  Minus,
  Network,
  Plus,
  RotateCcw,
  Scissors,
  Search,
  ShieldAlert,
  Server,
  Monitor,
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
import { EmptyState, ErrorState, Skeleton } from '../../ui/States';
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
import './TopologyRoute.css';

export type RoleFilter = 'ALL' | 'RELAY' | 'EXIT_BRIDGE' | 'CLIENT_ORIGIN' | 'HYBRID';
export type ViewMode = 'CANVAS' | 'LIST';
export type GroupBy = 'compartment' | 'country' | 'role' | 'none';
export type EdgeMode = 'auto' | 'all' | 'selected' | 'none';

const GRAPH_WIDTH = 1200;
const GRAPH_HEIGHT = 640;
const BASE_NODE_RADIUS = 16;

const MIN_SCALE = 0.3;
const MAX_SCALE = 6;
const ZOOM_STEP = 1.2;
// Pointer travel, in scene units, past which a press is a drag rather than a click.
const MOVE_EPS = 3;
// It is the number of lines, not of nodes, that makes a mesh unreadable: a full mesh
// of 13 nodes is already 78 of them. Above this many, "auto" draws only what departs
// from the full mesh -- cut links -- plus the selected node's policy connections.
const EDGE_AUTO_LINK_LIMIT = 30;
const LABEL_LIMIT = 40;

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
  expanded: boolean;
  unhealthy: number;
  quarantined: number;
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

/** Stable spatial groups: refresh order never moves an identity. Large groups
 * start folded, keeping the overview useful without rendering every peer. */
function clusterLayout(
  nodes: TopologyNode[],
  groupBy: GroupBy,
  otherLabel: string,
  expansion: Record<string, boolean>,
  revealMatches: boolean
): { placed: PlacedNode[]; clusters: ClusterBox[] } {
  const groups = new Map<string, { label: string; nodes: TopologyNode[] }>();
  for (const node of nodes) {
    const { key, label } = groupValue(node, groupBy);
    const group = groups.get(key) ?? { label: label || otherLabel, nodes: [] };
    group.nodes.push(node);
    groups.set(key, group);
  }
  const keys = [...groups.keys()].sort();
  const placed: PlacedNode[] = [];
  const clusters: ClusterBox[] = [];
  const centre = { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
  keys.forEach((key, index) => {
    const group = groups.get(key)!;
    const members = [...group.nodes].sort((a, b) => a.id.localeCompare(b.id));
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / keys.length + Math.sin(index * 2.1) * 0.15;
    const single = keys.length === 1;
    const orbit = single ? 0 : 1;
    const expanded = revealMatches || (expansion[key] ?? members.length <= 16);
    const cx = centre.x + Math.cos(angle) * orbit * (340 + (index % 3) * 35);
    const cy = single && !expanded ? centre.y - 180 : centre.y + Math.sin(angle) * orbit * (162 + (index % 3) * 21);
    const r = single ? 270 : Math.max(48, Math.min(92, 225 * Math.sin(Math.PI / keys.length)));
    clusters.push({
      key,
      label: group.label,
      cx,
      cy,
      r,
      count: members.length,
      expanded,
      unhealthy: members.filter((node) => !node.is_healthy && !node.is_quarantined).length,
      quarantined: members.filter((node) => node.is_quarantined).length
    });
    if (!expanded) return;
    members.forEach((node, ni) => {
      // Golden-angle placement breaks the regular necklace without idle motion.
      const theta = -1.1 + ni * 2.3999632297;
      const radius = single
        ? 150 + Math.sqrt((ni + 1) / members.length) * 100
        : members.length === 1
          ? 0
          : Math.sqrt((ni + 0.5) / members.length) * (r - 22);
      placed.push({
        node,
        x: cx + Math.cos(theta) * radius * (single ? 1.55 : 1),
        y: cy + Math.sin(theta) * radius * (single ? 0.8 : 1)
      });
    });
  });
  if (clusters.length > 1 && clusters.length <= 100) {
    const origins = new Map(clusters.map((cluster) => [cluster.key, { x: cluster.cx, y: cluster.cy }]));
    for (let pass = 0; pass < 24; pass++) {
      for (let i = 0; i < clusters.length; i++)
        for (let j = i + 1; j < clusters.length; j++) {
          const a = clusters[i]!,
            b = clusters[j]!;
          const dx = b.cx - a.cx,
            dy = b.cy - a.cy;
          const distance = Math.hypot(dx, dy) || 1;
          const required = a.r + b.r + 30;
          if (distance >= required) continue;
          const shift = (required - distance) / 2;
          a.cx -= (dx / distance) * shift;
          a.cy -= (dy / distance) * shift;
          b.cx += (dx / distance) * shift;
          b.cy += (dy / distance) * shift;
        }
      for (const cluster of clusters) {
        cluster.cx = clamp(cluster.cx, cluster.r + 90, GRAPH_WIDTH - cluster.r - 90);
        cluster.cy = clamp(cluster.cy, cluster.r + 38, GRAPH_HEIGHT - cluster.r - 38);
      }
    }
    const byKey = new Map(clusters.map((cluster) => [cluster.key, cluster]));
    for (const point of placed) {
      const key = groupValue(point.node, groupBy).key;
      const origin = origins.get(key)!;
      const cluster = byKey.get(key)!;
      point.x += cluster.cx - origin.x;
      point.y += cluster.cy - origin.y;
    }
  }
  return { placed, clusters };
}

function nodeRadiusFor(count: number): number {
  if (count <= 30) return BASE_NODE_RADIUS;
  if (count <= 120) return 9;
  return 6;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Straight peer segments stop short of node bodies. Coordination is an
 * annotation: leave a clear gap behind it rather than inventing a routed bend. */
function peerPath(a: Point, b: Point, nodeRadius: number): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length <= 2 * (nodeRadius + 2)) return '';
  const inset = (nodeRadius + 2) / length;
  const start = inset;
  const end = 1 - inset;
  const centre = { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
  const segment = (from: number, to: number) =>
    `M ${a.x + from * dx} ${a.y + from * dy} L ${a.x + to * dx} ${a.y + to * dy}`;
  // Clip only behind the visible coordination annotation, never bare canvas.
  const halfWidth = 58;
  let enter = start,
    leave = end;
  for (const [origin, delta, lower, upper] of [
    [a.x, dx, centre.x - halfWidth, centre.x + halfWidth],
    [a.y, dy, centre.y - 30, centre.y + 70]
  ] as [number, number, number, number][]) {
    if (Math.abs(delta) < 0.000001) {
      if (origin < lower || origin > upper) return segment(start, end);
      continue;
    }
    const first = (lower - origin) / delta,
      second = (upper - origin) / delta;
    enter = Math.max(enter, Math.min(first, second));
    leave = Math.min(leave, Math.max(first, second));
  }
  if (enter >= leave) return segment(start, end);
  return [enter > start ? segment(start, enter) : '', leave < end ? segment(leave, end) : ''].filter(Boolean).join(' ');
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
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    window.matchMedia?.('(max-width: 640px)').matches ? 'LIST' : 'CANVAS'
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<SelectedLink | null>(null);
  const [linkActionError, setLinkActionError] = useState<string | null>(null);

  const [groupBy, setGroupBy] = useState<GroupBy>('compartment');
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [evidenceView, setEvidenceView] = useState<'policy' | 'observed'>('policy');
  const [edgeMode, setEdgeMode] = useState<EdgeMode>('auto');

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
  const [canvasElement, setCanvasElement] = useState<SVGSVGElement | null>(null);
  const bindCanvas = useCallback((element: SVGSVGElement | null) => {
    svgRef.current = element;
    setCanvasElement(element);
  }, []);
  useEffect(() => {
    if (!canvasElement || typeof ResizeObserver === 'undefined') return;
    const measure = () => setCanvasWidth(canvasElement.getBoundingClientRect().width || GRAPH_WIDTH);
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(canvasElement);
    return () => observer.disconnect();
  }, [canvasElement]);
  const labelUnit = Math.max(1, GRAPH_WIDTH / Math.max(1, canvasWidth));
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
  const otherLabel = t(groupBy === 'none' ? 'topology.radial.allNodes' : 'topology.canvas.clusterOther');
  const { placed: basePlaced, clusters } = useMemo(
    () => clusterLayout(filteredNodes, groupBy, otherLabel, expandedGroups, Boolean(searchQuery.trim())),
    [filteredNodes, groupBy, otherLabel, expandedGroups, searchQuery]
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
  const showLabels = nodeCount <= LABEL_LIMIT || view.scale >= 1.8;
  // Stable positions make updates comparable and honour reduced motion.
  const renderPos = useMemo(() => new Map(placedNodes.map(({ node, x, y }) => [node.id, { x, y }])), [placedNodes]);

  // "focus" is what auto falls back to on a busy mesh: the exceptions plus the
  // selection. "selected" is the stricter manual mode: the selection alone.
  const resolvedEdgeMode: 'all' | 'focus' | 'selected' | 'none' =
    edgeMode === 'auto' ? (filteredLinks.length > EDGE_AUTO_LINK_LIMIT ? 'focus' : 'all') : edgeMode;

  const visibleLinks = useMemo(() => {
    // The current API exposes policy pairs, never authenticated peer-path evidence.
    // Keep observed paths explicitly unmeasured until the transport contract exists.
    if (evidenceView === 'observed' || resolvedEdgeMode === 'none') return EMPTY_LINKS;
    if (resolvedEdgeMode === 'all') return filteredLinks;
    return filteredLinks.filter((l) => {
      const touchesNode = selectedNodeId && (l.source === selectedNodeId || l.target === selectedNodeId);
      const isSelected =
        selectedLink &&
        ((l.source === selectedLink.source && l.target === selectedLink.target) ||
          (l.source === selectedLink.target && l.target === selectedLink.source));
      const isException = l.is_visible === false;
      return Boolean(touchesNode || isSelected || (resolvedEdgeMode === 'focus' && isException));
    });
  }, [evidenceView, resolvedEdgeMode, filteredLinks, selectedNodeId, selectedLink]);

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
          label={
            row.is_quarantined
              ? t('topology.nodeDrawer.quarantined')
              : row.is_healthy
                ? t('topology.nodeDrawer.healthy')
                : t('topology.nodeDrawer.unhealthy')
          }
        />
      )
    }
  ];

  const totalNodes = nodes.length;
  const noNodesAtAll = totalNodes === 0;

  const controlButtonClass =
    'inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface text-content transition-colors hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus';

  const drawClusters = true;
  const needsSelectionHint =
    (resolvedEdgeMode === 'selected' || resolvedEdgeMode === 'focus') && !selectedNodeId && !selectedLink;

  return (
    <PageFrame>
      <div className="mesh-route">
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

        <div className="mesh-summary" aria-label={t('topology.radial.summary')}>
          <span>
            <strong>{filteredNodes.length}</strong> {t('topology.stats.nodes')}
          </span>
          <span>
            <strong>{filteredLinks.filter((link) => link.is_visible !== false).length}</strong>{' '}
            {t('topology.radial.allowedPairs')}
          </span>
          <span>
            <strong>{compartments.length}</strong> {t('topology.stats.compartments')}
          </span>
          {topology?.policy_is_open && (
            <details className="mesh-policy-disclosure">
              <summary>
                <ShieldAlert aria-hidden="true" size={14} />
                {t('topology.radial.openPolicy')}
              </summary>
              <p>{t('topology.policyOpenNotice')}</p>
            </details>
          )}
          <span className="sm:ml-auto">
            {isUnlocked ? t('topology.vault.unlockedBadge') : t('topology.vault.lockedBadge')}
          </span>
        </div>

        {!noNodesAtAll && (
          <div className="mesh-filters flex flex-col gap-3 sm:flex-row sm:items-center">
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

        {topologyQuery.isPending ? (
          <div role="status" aria-label={t('topology.radial.loading')} className="p-6">
            <Skeleton lines={8} />
          </div>
        ) : topologyQuery.isError ? (
          <ErrorState onRetry={() => void topologyQuery.refetch()} />
        ) : noNodesAtAll ? (
          <Card>
            <EmptyState title={t('topology.empty.title')} body={t('topology.empty.enrollFirst')} />
          </Card>
        ) : viewMode === 'CANVAS' ? (
          <Card flush className="mesh-surface overflow-hidden">
            {filteredNodes.length === 0 ? (
              <div className="p-8">
                <EmptyState title={t('topology.empty.title')} body={t('topology.empty.desc')} />
              </div>
            ) : (
              <div className="mesh-workspace">
                <div className="mesh-map-panel">
                  <div className="mesh-toolbar">
                    <div className="mesh-evidence" aria-label={t('topology.radial.evidence')}>
                      <button
                        type="button"
                        aria-pressed={evidenceView === 'policy'}
                        onClick={() => setEvidenceView('policy')}
                      >
                        {t('topology.radial.policy')}
                      </button>
                      <button
                        type="button"
                        aria-pressed={evidenceView === 'observed'}
                        onClick={() => {
                          setEvidenceView('observed');
                          setSelectedLink(null);
                        }}
                      >
                        {t('topology.radial.observed')}
                      </button>
                    </div>
                    <div className="mesh-options flex flex-col gap-2 sm:flex-row sm:items-center">
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
                  </div>
                  <div className="relative">
                    <svg
                      ref={bindCanvas}
                      viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
                      className="mesh-canvas w-full touch-none select-none"
                      preserveAspectRatio="xMidYMid meet"
                      role="group"
                      tabIndex={-1}
                      aria-label={t('topology.title')}
                      style={{ cursor: 'grab' }}
                      onPointerDown={onBackgroundPointerDown}
                    >
                      <defs>
                        <pattern id="mesh-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                          <path d="M 24 0 L 0 0 0 24" fill="none" className="stroke-border" strokeWidth="0.5" />
                        </pattern>
                      </defs>
                      <rect width={GRAPH_WIDTH} height={GRAPH_HEIGHT} fill="url(#mesh-grid)" opacity="0.5" />
                      <g
                        ref={sceneRef}
                        transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}
                        style={{ transition: animateView && prefersMotion ? 'transform 180ms ease-out' : 'none' }}
                      >
                        {drawClusters &&
                          clusters.map((cluster) => (
                            <g key={`cluster-${cluster.key}`}>
                              <circle
                                cx={cluster.cx}
                                cy={cluster.cy}
                                r={cluster.expanded ? cluster.r : 32}
                                className={
                                  cluster.quarantined
                                    ? 'fill-danger-subtle stroke-danger'
                                    : cluster.unhealthy
                                      ? 'fill-warning-subtle stroke-warning'
                                      : 'fill-surface stroke-border-strong'
                                }
                                fillOpacity={cluster.expanded ? 0.12 : 0.8}
                                strokeOpacity={cluster.expanded ? 0.35 : 1}
                                strokeDasharray={cluster.expanded ? '3 5' : undefined}
                              />
                              <g
                                role="button"
                                tabIndex={0}
                                aria-expanded={cluster.expanded}
                                aria-label={[
                                  t(cluster.expanded ? 'topology.radial.collapse' : 'topology.radial.expand', {
                                    name: cluster.label
                                  }),
                                  cluster.unhealthy
                                    ? t('topology.radial.groupUnhealthy', { count: cluster.unhealthy })
                                    : '',
                                  cluster.quarantined
                                    ? t('topology.radial.groupQuarantined', { count: cluster.quarantined })
                                    : ''
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                                className="mesh-group-control"
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={() =>
                                  setExpandedGroups((previous) => ({ ...previous, [cluster.key]: !cluster.expanded }))
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    setExpandedGroups((previous) => ({
                                      ...previous,
                                      [cluster.key]: !cluster.expanded
                                    }));
                                  }
                                }}
                              >
                                <rect
                                  x={cluster.cx - 110}
                                  y={cluster.expanded ? cluster.cy - cluster.r - 40 : cluster.cy - 28}
                                  width={220}
                                  height={cluster.expanded ? 56 : 116}
                                  rx={5}
                                  fill="transparent"
                                />
                                {cluster.expanded ? (
                                  <Minus
                                    x={cluster.cx - Math.min(100, cluster.label.length * 3.2 + 28)}
                                    y={cluster.cy - cluster.r - 30}
                                    width={14}
                                    height={14}
                                    className="text-content"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Plus
                                    x={cluster.cx - Math.min(100, cluster.label.length * 3.2 + 28)}
                                    y={cluster.cy + 41}
                                    width={14}
                                    height={14}
                                    className="text-content"
                                    aria-hidden="true"
                                  />
                                )}
                                {!cluster.expanded && (
                                  <text
                                    x={cluster.cx}
                                    y={cluster.cy + 5}
                                    textAnchor="middle"
                                    className="fill-content text-[18px] font-semibold"
                                  >
                                    {cluster.count}
                                  </text>
                                )}
                                <text
                                  x={cluster.cx}
                                  y={cluster.expanded ? cluster.cy - cluster.r - 18 : cluster.cy + 53}
                                  textAnchor="middle"
                                  className="fill-content text-[12px] font-medium"
                                >
                                  {cluster.label} · {cluster.count}
                                </text>
                                {cluster.unhealthy > 0 && (
                                  <text
                                    x={cluster.cx}
                                    y={cluster.expanded ? cluster.cy - cluster.r - 2 : cluster.cy + 70}
                                    textAnchor="middle"
                                    className="fill-content text-[11px]"
                                  >
                                    {t('topology.radial.groupUnhealthy', { count: cluster.unhealthy })}
                                  </text>
                                )}
                                {cluster.quarantined > 0 && (
                                  <text
                                    x={cluster.cx}
                                    y={
                                      cluster.expanded
                                        ? cluster.cy - cluster.r + (cluster.unhealthy ? 14 : -2)
                                        : cluster.cy + (cluster.unhealthy ? 85 : 70)
                                    }
                                    textAnchor="middle"
                                    className="fill-content text-[11px]"
                                  >
                                    {t('topology.radial.groupQuarantined', { count: cluster.quarantined })}
                                  </text>
                                )}
                              </g>
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
                          const isNeighbourLink = selectedNodeId === link.source || selectedNodeId === link.target;
                          const modeClass = isCut
                            ? 'stroke-danger'
                            : isNeighbourLink
                              ? 'stroke-accent'
                              : 'stroke-border-strong';
                          return (
                            <g
                              key={`${link.source}-${link.target}`}
                              data-mesh-link="policy"
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
                              <title>{isCut ? t('topology.canvas.cutBadge') : t('topology.radial.policy')}</title>
                              <path d={path} fill="none" stroke="transparent" strokeWidth={12} />
                              <path
                                d={path}
                                fill="none"
                                strokeWidth={isSelectedLink || isNeighbourLink ? 2 : 1}
                                opacity={selectedNodeId && !isNeighbourLink ? 0.18 : 0.8}
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
                              ? 'fill-accent-subtle'
                              : 'fill-warning-subtle';
                          const strokeClass = isQuarantined
                            ? 'stroke-danger'
                            : node.is_healthy
                              ? 'stroke-accent'
                              : 'stroke-warning';
                          const faded = neighbourIds !== null && !neighbourIds.has(node.id);
                          return (
                            <g
                              key={node.id}
                              role="button"
                              tabIndex={0}
                              aria-label={`${node.name || node.id} — ${node.role}`}
                              aria-pressed={isSelected}
                              className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
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
                              <circle cx={x} cy={y} r={Math.max(22, nodeRadius)} fill="transparent" />
                              {nodeRadius >= 9 &&
                                (node.role === 'CLIENT_ORIGIN' ? (
                                  <Monitor
                                    x={x - 7}
                                    y={y - 7}
                                    width={14}
                                    height={14}
                                    className="text-content pointer-events-none"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Server
                                    x={x - 7}
                                    y={y - 7}
                                    width={14}
                                    height={14}
                                    className="text-content pointer-events-none"
                                    aria-hidden="true"
                                  />
                                ))}
                              {(showLabels || isSelected) && (
                                <g className="pointer-events-none mesh-node-label">
                                  <text
                                    x={x}
                                    y={y + nodeRadius + 20 * labelUnit}
                                    textAnchor="middle"
                                    className="fill-content font-semibold"
                                    style={{ fontSize: 14 * labelUnit }}
                                  >
                                    {(node.name || node.id).slice(0, 28)}
                                  </text>
                                  <text
                                    x={x}
                                    y={y + nodeRadius + 38 * labelUnit}
                                    textAnchor="middle"
                                    className="fill-subtle font-mono"
                                    style={{ fontSize: 12 * labelUnit }}
                                  >
                                    {node.overlay_ipv4 || '—'} · {node.country || '—'}
                                  </text>
                                  <text
                                    x={x}
                                    y={y + nodeRadius + 54 * labelUnit}
                                    textAnchor="middle"
                                    className="fill-subtle"
                                    style={{ fontSize: 12 * labelUnit }}
                                  >
                                    {t(
                                      node.is_quarantined
                                        ? 'topology.nodeDrawer.quarantined'
                                        : node.is_healthy
                                          ? 'topology.nodeDrawer.healthy'
                                          : 'topology.nodeDrawer.unhealthy'
                                    )}
                                  </text>
                                </g>
                              )}
                            </g>
                          );
                        })}
                        <g className="pointer-events-none" aria-label={t('topology.radial.controlPlane')}>
                          <rect
                            x={GRAPH_WIDTH / 2 - 58}
                            y={GRAPH_HEIGHT / 2 - 30}
                            width={116}
                            height={100}
                            rx={8}
                            className="fill-surface-sunken stroke-border"
                            strokeDasharray="2 4"
                          />
                          <circle
                            cx={GRAPH_WIDTH / 2}
                            cy={GRAPH_HEIGHT / 2}
                            r={20}
                            className="fill-surface stroke-border-strong"
                            strokeWidth={1.5}
                          />
                          <Network
                            x={GRAPH_WIDTH / 2 - 9}
                            y={GRAPH_HEIGHT / 2 - 9}
                            width={18}
                            height={18}
                            className="text-accent"
                            aria-hidden="true"
                          />
                          <text
                            x={GRAPH_WIDTH / 2}
                            y={GRAPH_HEIGHT / 2 + 40}
                            textAnchor="middle"
                            className="fill-content text-[12px] font-semibold"
                          >
                            {t('topology.radial.controlPlane')}
                          </text>
                          <text
                            x={GRAPH_WIDTH / 2}
                            y={GRAPH_HEIGHT / 2 + 57}
                            textAnchor="middle"
                            className="fill-subtle text-[10px]"
                          >
                            {t('topology.radial.coordination')}
                          </text>
                        </g>
                      </g>
                    </svg>

                    {evidenceView === 'policy' && needsSelectionHint && (
                      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
                        <span className="rounded-full border border-border bg-surface/90 px-3 py-1 text-caption text-muted shadow-sm backdrop-blur">
                          {t('topology.canvas.edgesSelectHint')}
                        </span>
                      </div>
                    )}

                    {/* Camera controls, floated over the canvas. */}
                    <div className="absolute left-4 bottom-4 flex gap-1.5">
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

                  {evidenceView === 'observed' && (
                    <p role="status" className="mesh-unmeasured">
                      {t('topology.radial.unmeasured')}
                    </p>
                  )}
                  <p className="mesh-explanation text-caption text-subtle">
                    {t(evidenceView === 'policy' ? 'topology.radial.policyExplain' : 'topology.radial.observedExplain')}{' '}
                    {t('topology.canvas.hint')}
                  </p>

                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-muted">
                    <span className="flex items-center gap-1.5">
                      <span className="w-4 border-t border-accent" /> {t('topology.radial.policy')}
                    </span>
                    {/* Only what the view can know. Nothing measures whether a pair is
                      relayed or onion-routed, and there is no OpenVPN transport, so
                      those used to sit here describing paths the mesh never took. */}
                    <span className="flex items-center gap-1.5">
                      <span className="w-4 border-t-2 border-dashed border-danger" /> {t('topology.canvas.cutBadge')}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full border border-dashed border-warning" />{' '}
                      {t('topology.nodeDrawer.unhealthy')}
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

                {(selectedLink || selectedNode) && (
                  <aside className="mesh-inspector" aria-label={t('topology.nodeDrawer.title')}>
                    <button
                      type="button"
                      className="mesh-inspector-close"
                      aria-label={t('topology.radial.closeDetails')}
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
                          <h2 className="text-body font-semibold text-content">{t('topology.canvas.linkTitle')}</h2>
                          <Badge tone={isLinkCut ? 'danger' : 'accent'}>
                            {isLinkCut ? t('topology.canvas.cutBadge') : t('topology.radial.allowed')}
                          </Badge>
                        </div>

                        <div className="flex flex-col gap-1 text-caption">
                          <span className="font-mono text-content">{linkSourceNode?.name || selectedLink.source}</span>
                          <span className="text-muted">↕</span>
                          <span className="font-mono text-content">{linkTargetNode?.name || selectedLink.target}</span>
                        </div>

                        <div className="text-caption">
                          <span className="text-subtle">{t('topology.radial.transport')}: </span>
                          <span>{t('state.notMeasured')}</span>
                        </div>

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
                                : selectedNode.is_healthy
                                  ? t('topology.nodeDrawer.healthy')
                                  : t('topology.nodeDrawer.unhealthy')
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

                        <div className="text-caption text-subtle">
                          {t('topology.radial.transport')}: {t('state.notMeasured')}
                        </div>
                        <div className="text-caption text-muted">
                          {t('topology.radial.allowedPairs')}: {selectedNodeLinks.length}
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
                  </aside>
                )}
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
      </div>
    </PageFrame>
  );
}

export default TopologyRoute;
