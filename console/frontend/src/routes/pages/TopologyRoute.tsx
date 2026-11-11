import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  KeyRound,
  List,
  Lock,
  Network,
  Plus,
  RotateCcw,
  Search,
  Shuffle,
  ShieldAlert,
  ZoomIn,
  ZoomOut
} from 'lucide-react';

import { PageFrame } from '../PageFrame';
import { PageHeader } from '../../ui/PageHeader';
import { ROUTES, nodePath } from '../paths';
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
import { StatusBadge } from '../../ui/StatusBadge';
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
  SPACING,
  centerOn,
  cullLabels,
  denseByDefault,
  groupFolded,
  groupValue,
  layoutMesh,
  linkState,
  nodeKind,
  nodeState,
  policyNeighborhood,
  searchNodes,
  type GroupBy,
  type LinkState,
  type NodeKind,
  type Point,
  type ViewTransform,
  LINK_STATES,
  NODE_KINDS,
  UNFOLD_SCALE
} from './topologyGraph';
import {
  MeshMap,
  ZOOM_STEP,
  zoomAt,
  type DrawnGroup,
  type DrawnLink,
  type DrawnNode,
  type Frame
} from './mesh/MeshMap';
import { MeshLegend } from './mesh/MeshLegend';
import { MeshMirror, type MirrorGroup } from './mesh/MeshMirror';
import { DeviceDetails, InspectorFrame, LinkDetails, stateLabelKey, type PeerRow } from './mesh/MeshInspector';
import './TopologyRoute.css';

export type ViewMode = 'CANVAS' | 'LIST';
export type { GroupBy } from './topologyGraph';

const HULL_PAD = SPACING * 0.6;
const PEER_LIMIT = 50;
const SEARCH_LIMIT = 8;

interface SelectedLink {
  source: string;
  target: string;
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

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

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

  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    window.matchMedia?.('(max-width: 640px)').matches ? 'LIST' : 'CANVAS'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  const [groupBy, setGroupBy] = useState<GroupBy>('compartment');
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set());
  const [hiddenKinds, setHiddenKinds] = useState<Set<NodeKind>>(new Set());
  const [linkOverrides, setLinkOverrides] = useState<Partial<Record<LinkState, boolean>>>({});
  const [foldOverrides, setFoldOverrides] = useState<Record<string, boolean>>({});
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<SelectedLink | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [neighborhoodHops, setNeighborhoodHops] = useState<1 | 2>(1);
  const [legendOpen, setLegendOpen] = useState(() => !window.matchMedia?.('(max-width: 1100px)').matches);

  const [linkActionError, setLinkActionError] = useState<string | null>(null);
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  const [blockConfirmOpen, setBlockConfirmOpen] = useState(false);
  const [unlockDialogOpen, setUnlockDialogOpen] = useState(false);
  const [vaultPassword, setVaultPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const [view, setView] = useState<ViewTransform>({ scale: 1, tx: 0, ty: 0 });
  const [animateView, setAnimateView] = useState(false);
  const [dragged, setDragged] = useState<Record<string, Point>>({});
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const prefersMotion = usePrefersMotion();

  const [canvasSize, setCanvasSize] = useState({ width: 1000, height: 560 });
  const [canvasElement, setCanvasElement] = useState<SVGSVGElement | null>(null);
  const bindCanvas = useCallback((element: SVGSVGElement | null) => setCanvasElement(element), []);
  useEffect(() => {
    if (!canvasElement || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const box = canvasElement.getBoundingClientRect();
      if (box.width && box.height) setCanvasSize({ width: box.width, height: box.height });
    };
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(canvasElement);
    return () => observer.disconnect();
  }, [canvasElement]);

  const topology = topologyQuery.data;
  const nodes = topology?.nodes ?? EMPTY_NODES;
  const links = topology?.links ?? EMPTY_LINKS;
  const compartments = compartmentsQuery.data ?? EMPTY_COMPARTMENTS;
  const aclRules = aclRulesQuery.data?.rules ?? EMPTY_RULES;
  // "Now" is when the data arrived, so ages and states do not tick between refreshes.
  const now = topologyQuery.dataUpdatedAt || 0;

  const isUnlocked = useMemo(
    () => nodes.some((n) => n.is_ghost_vault) || compartments.some((c) => c.is_hidden),
    [nodes, compartments]
  );
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  // --- Layout: computed once per inventory, remembered per grouping ---------
  const memory = useRef<Partial<Record<GroupBy, Map<string, Point>>>>({});
  const otherLabel = t(groupBy === 'none' ? 'radial.allNodes' : 'canvas.clusterOther');
  const layout = useMemo(
    () => layoutMesh(nodes, links, groupBy, { otherLabel, previous: memory.current[groupBy] }),
    // layoutEpoch forces a fresh arrangement after "Rearrange" cleared the memory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, links, groupBy, otherLabel, layoutEpoch]
  );
  useEffect(() => {
    memory.current[groupBy] = layout.positions;
  }, [layout, groupBy]);
  const positionOf = useCallback(
    (id: string): Point | undefined => dragged[id] ?? layout.positions.get(id),
    [dragged, layout]
  );

  // Fit the whole inventory once; filters, refreshes and folding never refit the camera.
  const frame = useMemo<Frame>(() => {
    const points = [...layout.positions.values()];
    const xs = points.map((point) => point.x),
      ys = points.map((point) => point.y);
    const pad = HULL_PAD + SPACING;
    const left = Math.min(0, ...xs) - pad,
      right = Math.max(0, ...xs) + pad;
    const top = Math.min(0, ...ys) - pad - 20,
      bottom = Math.max(0, ...ys) + pad + 20;
    const aspect = canvasSize.width / Math.max(1, canvasSize.height);
    // A floor so three devices are not blown up to fill the screen.
    const width = Math.max(right - left, (bottom - top) * aspect, 560);
    const height = width / aspect;
    const cx = (left + right) / 2,
      cy = (top + bottom) / 2;
    return { x: cx - width / 2, y: cy - height / 2, width, height, cx, cy };
  }, [layout, canvasSize]);
  const unit = frame.width / Math.max(1, canvasSize.width) / view.scale;

  // --- Search -----------------------------------------------------------------
  const query = searchQuery.trim();
  const results = useMemo(() => searchNodes(nodes, query, SEARCH_LIMIT), [nodes, query]);
  const matchIds = useMemo(
    () => new Set(query ? searchNodes(nodes, query, Number.POSITIVE_INFINITY).map((node) => node.id) : []),
    [nodes, query]
  );

  // --- What is shown ----------------------------------------------------------
  const kindOf = useMemo(() => new Map(nodes.map((node) => [node.id, nodeKind(node)])), [nodes]);
  const stateOf = useMemo(() => new Map(nodes.map((node) => [node.id, nodeState(node, now)])), [nodes, now]);
  const groupKeyOf = useMemo(
    () => new Map(nodes.map((node) => [node.id, groupValue(node, groupBy).key])),
    [nodes, groupBy]
  );
  const shownNodes = useMemo(
    () => nodes.filter((node) => !hiddenGroups.has(groupKeyOf.get(node.id)!) && !hiddenKinds.has(kindOf.get(node.id)!)),
    [nodes, hiddenGroups, hiddenKinds, groupKeyOf, kindOf]
  );
  const shownIds = useMemo(() => new Set(shownNodes.map((node) => node.id)), [shownNodes]);
  const shownLinks = useMemo(
    () => links.filter((link) => shownIds.has(link.source) && shownIds.has(link.target)),
    [links, shownIds]
  );
  const linkStates = useMemo(
    () =>
      new Map(
        shownLinks.map((link) => [
          pairKey(link.source, link.target),
          linkState(link, nodeById.get(link.source), nodeById.get(link.target), now)
        ])
      ),
    [shownLinks, nodeById, now]
  );
  const stateOfLink = (link: TopologyLink) => linkStates.get(pairKey(link.source, link.target)) ?? 'unmeasured';
  const linkCounts = useMemo(() => {
    const counts = Object.fromEntries(LINK_STATES.map((state) => [state, 0])) as Record<LinkState, number>;
    for (const state of linkStates.values()) counts[state] += 1;
    return counts;
  }, [linkStates]);
  const measured = links.some((link) => typeof link.transport === 'string' && link.transport !== '');
  const permittedCount = links.filter((link) => link.is_visible !== false).length;
  const dense = denseByDefault(nodes.length, permittedCount);
  const linkShown = (state: LinkState) => linkOverrides[state] ?? !(dense && state === 'unmeasured');

  const kindCounts = useMemo(() => {
    const counts = Object.fromEntries(NODE_KINDS.map((kind) => [kind, 0])) as Record<NodeKind, number>;
    for (const kind of kindOf.values()) counts[kind] += 1;
    return counts;
  }, [kindOf]);

  const revealed = useMemo(() => {
    const keys = new Set<string>();
    for (const id of [...matchIds, selectedNodeId, focusedId, selectedLink?.source, selectedLink?.target])
      if (id && groupKeyOf.has(id)) keys.add(groupKeyOf.get(id)!);
    return keys;
  }, [matchIds, selectedNodeId, focusedId, selectedLink, groupKeyOf]);
  const legendGroups = layout.groups.map((group) => ({
    ...group,
    folded: groupFolded(group.count, view.scale, foldOverrides[group.key], revealed.has(group.key))
  }));
  const foldedKeys = new Set(legendGroups.filter((group) => group.folded).map((group) => group.key));

  const neighbourIds = useMemo(
    () => (selectedNodeId ? policyNeighborhood(selectedNodeId, shownLinks, neighborhoodHops) : null),
    [selectedNodeId, shownLinks, neighborhoodHops]
  );
  const firstHopIds = useMemo(
    () => (selectedNodeId ? policyNeighborhood(selectedNodeId, shownLinks, 1) : null),
    [selectedNodeId, shownLinks]
  );

  const selectedNode = selectedNodeId ? (nodeById.get(selectedNodeId) ?? null) : null;
  const isSelectedLink = (link: TopologyLink) =>
    Boolean(
      selectedLink &&
        ((link.source === selectedLink.source && link.target === selectedLink.target) ||
          (link.source === selectedLink.target && link.target === selectedLink.source))
    );

  // --- Drawing ----------------------------------------------------------------
  const drawnNodes: DrawnNode[] = shownNodes
    .filter((node) => !foldedKeys.has(groupKeyOf.get(node.id)!))
    .map((node) => {
      const point = positionOf(node.id)!;
      return {
        node,
        x: point.x,
        y: point.y,
        kind: kindOf.get(node.id)!,
        state: stateOf.get(node.id)!,
        match: matchIds.has(node.id),
        selected: node.id === selectedNodeId,
        focused: node.id === focusedId,
        dimmed: (query !== '' && !matchIds.has(node.id)) || (neighbourIds !== null && !neighbourIds.has(node.id)),
        showLabel: false,
        groupColor: 0
      };
    });
  const labelPriority = (drawn: DrawnNode) =>
    drawn.selected || drawn.focused
      ? 4
      : drawn.match
        ? 3
        : drawn.kind === 'gateway'
          ? 2
          : drawn.state !== 'online'
            ? 1
            : 0;
  // On-screen distance between neighbours. Ordinary names only appear when there is
  // room for them; selected, found and gateway names need less, and selection always shows.
  const screenSpacing = SPACING / unit;
  const labelRoom = (priority: number) => (priority >= 3 ? 0 : priority >= 1 ? 34 : 56);
  const keptLabels = cullLabels(
    drawnNodes
      .filter((drawn) => (!drawn.dimmed || drawn.focused) && screenSpacing >= labelRoom(labelPriority(drawn)))
      .map((drawn) => {
        const width = Math.min(28, (drawn.node.name || drawn.node.id).length) * 6.6 * unit;
        return {
          id: drawn.node.id,
          x: drawn.x,
          y: drawn.y + 10 * unit,
          width: width + 6 * unit,
          height: 18 * unit,
          priority: labelPriority(drawn)
        };
      })
  );
  for (const drawn of drawnNodes) drawn.showLabel = keptLabels.has(drawn.node.id);
  const drawnIds = new Set(drawnNodes.map((drawn) => drawn.node.id));

  const drawnLinks: DrawnLink[] = shownLinks
    .filter((link) => drawnIds.has(link.source) && drawnIds.has(link.target))
    .flatMap((link) => {
      const state = stateOfLink(link);
      const touches = selectedNodeId !== null && (link.source === selectedNodeId || link.target === selectedNodeId);
      const selected = isSelectedLink(link);
      if (!linkShown(state) && !touches && !selected) return [];
      // In two-hop mode the edges from first-hop peers onward are the path to the
      // selection, so they keep full weight instead of fading.
      const onPath =
        touches ||
        (neighborhoodHops === 2 &&
          neighbourIds !== null &&
          firstHopIds !== null &&
          neighbourIds.has(link.source) &&
          neighbourIds.has(link.target) &&
          (firstHopIds.has(link.source) || firstHopIds.has(link.target)));
      const a = positionOf(link.source)!,
        b = positionOf(link.target)!;
      const name = (id: string) => nodeById.get(id)?.name || id;
      return [
        {
          key: pairKey(link.source, link.target),
          link,
          state,
          a,
          b,
          label: `${name(link.source)} — ${name(link.target)}`,
          strong: onPath,
          faded:
            (selectedNodeId !== null && !onPath) ||
            (query !== '' && !matchIds.has(link.source) && !matchIds.has(link.target)),
          selected
        }
      ];
    });

  const drawnGroups: DrawnGroup[] = legendGroups
    .filter((group) => !hiddenGroups.has(group.key))
    .map((group) => {
      const problems = [
        group.unhealthy ? t('radial.groupUnhealthy', { count: group.unhealthy }) : '',
        group.quarantined ? t('radial.groupQuarantined', { count: group.quarantined }) : ''
      ]
        .filter(Boolean)
        .join(', ');
      return {
        geometry: group,
        folded: group.folded,
        label: group.label,
        bubbleLabel: t('bubble.label', { name: group.label, count: group.count }),
        problems
      };
    });

  const selectedDrawn = drawnNodes.find((drawn) => drawn.selected);
  const selectedLabel = selectedDrawn
    ? {
        x: selectedDrawn.x,
        y: selectedDrawn.y,
        name: (selectedDrawn.node.name || selectedDrawn.node.id).slice(0, 28),
        detail: selectedDrawn.node.overlay_ipv4 || '—'
      }
    : null;

  // --- Camera -----------------------------------------------------------------
  const onView = useCallback((update: (current: ViewTransform) => ViewTransform, animate: boolean) => {
    setAnimateView(animate);
    setView(update);
  }, []);
  const focusPoint = (point: Point, minScale = 1.8) => {
    setAnimateView(prefersMotion);
    setView((current) => centerOn(point, frame, Math.max(current.scale, minScale)));
  };
  /** Pans only when the device is outside the middle of the view, so arrow keys do not jolt it. */
  const keepInView = (id: string) => {
    const point = positionOf(id);
    if (!point) return;
    const sx = point.x * view.scale + view.tx,
      sy = point.y * view.scale + view.ty;
    const marginX = frame.width * 0.15,
      marginY = frame.height * 0.15;
    if (
      sx < frame.x + marginX ||
      sx > frame.x + frame.width - marginX ||
      sy < frame.y + marginY ||
      sy > frame.y + frame.height - marginY
    ) {
      setAnimateView(prefersMotion);
      setView((current) => centerOn(point, frame, current.scale));
    }
  };

  // --- Selection --------------------------------------------------------------
  const selectNode = useCallback((id: string) => {
    setSelectedNodeId(id);
    setSelectedLink(null);
    setLinkActionError(null);
    setLinkNotice(null);
  }, []);
  const goToNode = (id: string) => {
    selectNode(id);
    const point = positionOf(id);
    if (point) focusPoint(point);
  };
  const selectLink = useCallback((link: TopologyLink) => {
    setSelectedLink({ source: link.source, target: link.target });
    setSelectedNodeId(null);
    setLinkActionError(null);
    setLinkNotice(null);
  }, []);
  const clearSelection = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedLink(null);
  }, []);
  const closeInspector = () => {
    const returnTo = selectedNodeId;
    clearSelection();
    const buttons = document.querySelectorAll<HTMLButtonElement>('[data-mirror-id]');
    ([...buttons].find((button) => button.dataset.mirrorId === returnTo) ?? buttons[0])?.focus();
  };
  const onMoveNode = useCallback((id: string, point: Point) => setDragged((prev) => ({ ...prev, [id]: point })), []);
  const openGroup = (key: string) => {
    const group = layout.groups.find((candidate) => candidate.key === key);
    if (!group) return;
    const fit = Math.min(frame.width, frame.height) / (group.r * 2.4);
    setAnimateView(prefersMotion);
    setView(centerOn({ x: group.cx, y: group.cy }, frame, Math.max(UNFOLD_SCALE, Math.min(4, fit))));
  };

  // --- Link actions -----------------------------------------------------------
  const linkSourceNode = selectedLink ? (nodeById.get(selectedLink.source) ?? null) : null;
  const linkTargetNode = selectedLink ? (nodeById.get(selectedLink.target) ?? null) : null;
  const selectedLinkData = selectedLink ? (shownLinks.find(isSelectedLink) ?? null) : null;

  // The DROP rules that actually sever this pair, matched on overlay VIP in either
  // direction. Their presence -- not a local flag -- is what "blocked" means, and
  // their ids are what an unblock deletes.
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
    if (survivors.length > 0) setLinkActionError(t('canvas.restorePartial', { ids: survivors.join(', ') }));
    else setLinkNotice(t('canvas.restoreDone'));
  };
  const linkBusy = createRule.isPending || deleteRule.isPending;

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

  // --- Inspector data ---------------------------------------------------------
  const selectedLinks = selectedNode
    ? shownLinks.filter(
        (link) => link.is_visible !== false && (link.source === selectedNode.id || link.target === selectedNode.id)
      )
    : [];
  // Blocked pairs are listed too, so a keyboard can reach the link to unblock it.
  const directLinkTo = new Map(
    shownLinks
      .filter((link) => selectedNodeId !== null && (link.source === selectedNodeId || link.target === selectedNodeId))
      .map((link) => [link.source === selectedNodeId ? link.target : link.source, link])
  );
  const peerNodes = selectedNode
    ? shownNodes.filter(
        (node) =>
          node.id !== selectedNode.id && (neighbourIds?.has(node.id) || directLinkTo.get(node.id)?.is_visible === false)
      )
    : [];
  const peers: PeerRow[] = peerNodes.slice(0, PEER_LIMIT).map((node) => {
    const link = directLinkTo.get(node.id) ?? null;
    return { node, kind: kindOf.get(node.id)!, link, state: link ? stateOfLink(link) : null };
  });
  const gatewayNode = nodes.find((node) => node.is_profile_gateway === true) ?? null;
  const measuredSummary = (() => {
    const direct = selectedLinks.filter((link) => stateOfLink(link) === 'direct').length;
    const relayed = selectedLinks.filter((link) => stateOfLink(link) === 'relayed').length;
    if (direct + relayed === 0) return null;
    return t('inspector.pathMeasured', { direct, relayed });
  })();

  // --- Mirror -----------------------------------------------------------------
  const connectionCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const link of shownLinks) {
      if (link.is_visible === false) continue;
      counts.set(link.source, (counts.get(link.source) ?? 0) + 1);
      counts.set(link.target, (counts.get(link.target) ?? 0) + 1);
    }
    return counts;
  }, [shownLinks]);
  const mirrorGroups: MirrorGroup[] = layout.groups
    .filter((group) => !hiddenGroups.has(group.key))
    .map((group) => ({
      key: group.key,
      label: group.label,
      items: shownNodes
        .filter((node) => groupKeyOf.get(node.id) === group.key)
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
        .map((node) => ({
          node,
          kind: kindOf.get(node.id)!,
          state: stateOf.get(node.id)!,
          connections: connectionCount.get(node.id) ?? 0
        }))
    }))
    .filter((group) => group.items.length > 0);

  // --- List view --------------------------------------------------------------
  const listRows = query
    ? shownNodes.filter((node) => matchIds.has(node.id) || (node.id ?? '').toLowerCase().includes(query.toLowerCase()))
    : shownNodes;
  const listColumns: TableColumn<TopologyNode>[] = [
    {
      id: 'node',
      header: t('columns.node'),
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="text-body font-semibold text-content">{row.name || row.id}</span>
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
      cell: (row) => <span>{t(`kind.${kindOf.get(row.id) ?? 'device'}`)}</span>
    },
    {
      id: 'overlayIp',
      header: t('nodeDrawer.overlayIp'),
      cell: (row) =>
        row.overlay_ipv4 ? <CodeText>{row.overlay_ipv4}</CodeText> : <span className="text-muted">—</span>
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
          <span className="text-caption text-muted">{`${row.latency_ms} ms`}</span>
        )
    },
    {
      id: 'status',
      header: t('columns.status'),
      cell: (row) => {
        const state = stateOf.get(row.id) ?? 'unmeasured';
        const status =
          state === 'online'
            ? 'ok'
            : state === 'degraded'
              ? 'warning'
              : state === 'quarantined'
                ? 'critical'
                : 'not-measured';
        return <StatusBadge status={status} label={t(stateLabelKey(state))} />;
      }
    }
  ];

  const noNodesAtAll = nodes.length === 0;
  const single = nodes.length === 1;
  const groupOptions = [
    { value: 'compartment', label: t('canvas.groupCompartment') },
    { value: 'country', label: t('canvas.groupCountry') },
    { value: 'role', label: t('canvas.groupRole') },
    { value: 'none', label: t('canvas.groupNone') }
  ];
  const controlButtonClass = 'mesh-camera-button';

  const searchBox = (
    <div className="mesh-search">
      <Search className="mesh-search-icon" aria-hidden="true" />
      <Input
        value={searchQuery}
        onChange={(event) => {
          setSearchQuery(event.target.value);
          setSearchOpen(true);
          setActiveResult(0);
        }}
        onFocus={() => setSearchOpen(true)}
        onBlur={() => setSearchOpen(false)}
        onKeyDown={(event) => {
          if (viewMode !== 'CANVAS' || results.length === 0) return;
          if (event.key === 'ArrowDown') setActiveResult((index) => Math.min(results.length - 1, index + 1));
          else if (event.key === 'ArrowUp') setActiveResult((index) => Math.max(0, index - 1));
          else if (event.key === 'Enter') {
            goToNode(results[activeResult]!.id);
            setSearchOpen(false);
          } else if (event.key === 'Escape') setSearchOpen(false);
          else return;
          event.preventDefault();
        }}
        placeholder={t('searchPlaceholder')}
        aria-label={t('searchPlaceholder')}
        role={viewMode === 'CANVAS' ? 'combobox' : undefined}
        aria-expanded={viewMode === 'CANVAS' ? searchOpen && query !== '' : undefined}
        aria-controls={viewMode === 'CANVAS' ? 'mesh-search-results' : undefined}
        aria-activedescendant={
          viewMode === 'CANVAS' && searchOpen && results[activeResult] ? `mesh-result-${activeResult}` : undefined
        }
        aria-autocomplete={viewMode === 'CANVAS' ? 'list' : undefined}
        className="pl-9"
      />
      {viewMode === 'CANVAS' && searchOpen && query !== '' && (
        <div id="mesh-search-results" role="listbox" aria-label={t('search.results')} className="mesh-search-results">
          {results.length === 0 ? (
            <div role="option" aria-selected="false" aria-disabled="true" className="mesh-search-empty">
              {t('search.none')}
            </div>
          ) : (
            results.map((node, index) => (
              <div
                key={node.id}
                id={`mesh-result-${index}`}
                role="option"
                tabIndex={-1}
                aria-selected={index === activeResult}
                onMouseDown={(event) => {
                  event.preventDefault();
                  goToNode(node.id);
                  setSearchOpen(false);
                }}
              >
                <span>{node.name || node.id}</span>
                <span className="mesh-search-meta">{node.overlay_ipv4 || t(`kind.${kindOf.get(node.id)}`)}</span>
              </div>
            ))
          )}
        </div>
      )}
      {viewMode === 'CANVAS' && query !== '' && (
        <p className="sr-only" role="status">
          {t('search.count', { count: matchIds.size })}
        </p>
      )}
    </div>
  );

  return (
    <PageFrame>
      <div className="mesh-route">
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={
            <div className="flex items-center gap-2">
              {!(topologyQuery.isSuccess && noNodesAtAll) && (
                <>
                  <Button
                    variant={viewMode === 'CANVAS' ? 'primary' : 'secondary'}
                    size="sm"
                    icon={Network}
                    aria-pressed={viewMode === 'CANVAS'}
                    onClick={() => setViewMode('CANVAS')}
                  >
                    {t('view.canvasMode')}
                  </Button>
                  <Button
                    variant={viewMode === 'LIST' ? 'primary' : 'secondary'}
                    size="sm"
                    icon={List}
                    aria-pressed={viewMode === 'LIST'}
                    onClick={() => setViewMode('LIST')}
                  >
                    {t('view.listMode')}
                  </Button>
                </>
              )}
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
            <strong>{shownNodes.length}</strong> {t('stats.nodes')}
          </span>
          <span>
            <strong>{shownLinks.filter((link) => link.is_visible !== false).length}</strong> {t('radial.allowedPairs')}
          </span>
          <span>
            <strong>{layout.groups.length}</strong> {t('stats.compartments')}
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
          <span className="mesh-summary-end">{isUnlocked ? t('vault.unlockedBadge') : t('vault.lockedBadge')}</span>
        </div>

        {topologyQuery.isPending ? (
          <div role="status" aria-label={t('radial.loading')} className="p-6">
            <Skeleton lines={8} />
          </div>
        ) : topologyQuery.isError ? (
          <ErrorState onRetry={() => void topologyQuery.refetch()} />
        ) : noNodesAtAll ? (
          <Card>
            <EmptyState
              title={t('empty.title')}
              body={t('empty.enrollFirst')}
              action={
                <Button variant="primary" icon={Plus} onClick={() => navigate(ROUTES.meAdd)}>
                  {t('empty.action')}
                </Button>
              }
            />
          </Card>
        ) : viewMode === 'LIST' ? (
          <>
            <div className="mesh-toolbar mesh-toolbar--list">{searchBox}</div>
            <Card flush>
              <Table<TopologyNode>
                caption={t('title')}
                columns={listColumns}
                rows={listRows}
                rowKey={(row) => row.id}
                empty={<EmptyState title={t('empty.filteredTitle')} body={t('empty.desc')} />}
              />
            </Card>
          </>
        ) : (
          <Card flush className="mesh-surface">
            <div className="mesh-toolbar">
              {searchBox}
              <div className="mesh-toolbar-group">
                <span className="mesh-toolbar-label">{t('canvas.groupByLabel')}</span>
                <div className="w-40">
                  <Select
                    value={groupBy}
                    onValueChange={(value) => {
                      setGroupBy(value as GroupBy);
                      setHiddenGroups(new Set());
                      setFoldOverrides({});
                    }}
                    options={groupOptions}
                    aria-label={t('canvas.groupByLabel')}
                  />
                </div>
              </div>
              <button
                type="button"
                className="mesh-legend-toggle"
                aria-expanded={legendOpen}
                aria-controls="mesh-legend"
                onClick={() => setLegendOpen((open) => !open)}
              >
                {t('legend.toggle')}
              </button>
            </div>
            <div className={legendOpen ? 'mesh-workspace mesh-workspace--legend' : 'mesh-workspace'}>
              {legendOpen && (
                <MeshLegend
                  groups={legendGroups}
                  hiddenGroups={hiddenGroups}
                  onToggleGroup={(key) =>
                    setHiddenGroups((previous) => {
                      const next = new Set(previous);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  onShowAllGroups={(show) =>
                    setHiddenGroups(show ? new Set() : new Set(layout.groups.map((group) => group.key)))
                  }
                  onFoldGroup={(key, folded) => setFoldOverrides((previous) => ({ ...previous, [key]: folded }))}
                  kindCounts={kindCounts}
                  hiddenKinds={hiddenKinds}
                  onToggleKind={(kind) =>
                    setHiddenKinds((previous) => {
                      const next = new Set(previous);
                      if (next.has(kind)) next.delete(kind);
                      else next.add(kind);
                      return next;
                    })
                  }
                  linkCounts={linkCounts}
                  measured={measured}
                  linkShown={linkShown}
                  onToggleLink={(state) =>
                    setLinkOverrides((previous) => ({ ...previous, [state]: !linkShown(state) }))
                  }
                />
              )}
              <div className="mesh-map-panel">
                {dense && !linkShown('unmeasured') && !single && (
                  <p className="mesh-notice" role="note">
                    <span>{t('notice.dense')}</span>
                    <button
                      type="button"
                      onClick={() => setLinkOverrides((previous) => ({ ...previous, unmeasured: true }))}
                    >
                      {t('notice.showAll', { count: linkCounts.unmeasured })}
                    </button>
                  </p>
                )}
                <div className="mesh-stage">
                  <MeshMap
                    frame={frame}
                    view={view}
                    animate={animateView && prefersMotion}
                    unit={unit}
                    hullPad={HULL_PAD}
                    groups={drawnGroups}
                    links={drawnLinks}
                    nodes={drawnNodes}
                    selectedLabel={selectedLabel}
                    bindCanvas={bindCanvas}
                    onView={onView}
                    onSelectNode={selectNode}
                    onSelectLink={selectLink}
                    onClear={clearSelection}
                    onMoveNode={onMoveNode}
                    onOpenGroup={openGroup}
                  />
                  <MeshMirror
                    groups={mirrorGroups}
                    activeId={focusedId}
                    selectedId={selectedNodeId}
                    onFocusItem={(id) => {
                      setFocusedId(id);
                      if (id) keepInView(id);
                    }}
                    onOpen={(id) => {
                      selectNode(id);
                      keepInView(id);
                    }}
                    onClose={clearSelection}
                  />
                  {shownNodes.length === 0 && (
                    <div className="mesh-no-matches" role="status">
                      <p>{t('graph.noMatches')}</p>
                      <button
                        type="button"
                        onClick={() => {
                          setHiddenGroups(new Set());
                          setHiddenKinds(new Set());
                        }}
                      >
                        {t('graph.resetFilters')}
                      </button>
                    </div>
                  )}
                  {single && (
                    <div className="mesh-single" role="note">
                      <p className="mesh-single-title">{t('single.title')}</p>
                      <p>{t('single.body')}</p>
                      <Button variant="secondary" size="sm" icon={Plus} onClick={() => navigate(ROUTES.meAdd)}>
                        {t('empty.action')}
                      </Button>
                    </div>
                  )}
                  <div className="mesh-camera">
                    <button
                      type="button"
                      className={controlButtonClass}
                      aria-label={t('canvas.zoomIn')}
                      title={t('canvas.zoomIn')}
                      onClick={() =>
                        onView((current) => zoomAt(current, { x: frame.cx, y: frame.cy }, ZOOM_STEP), true)
                      }
                    >
                      <ZoomIn className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={controlButtonClass}
                      aria-label={t('canvas.zoomOut')}
                      title={t('canvas.zoomOut')}
                      onClick={() =>
                        onView((current) => zoomAt(current, { x: frame.cx, y: frame.cy }, 1 / ZOOM_STEP), true)
                      }
                    >
                      <ZoomOut className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={controlButtonClass}
                      aria-label={t('canvas.resetView')}
                      title={t('canvas.resetView')}
                      onClick={() => onView(() => ({ scale: 1, tx: 0, ty: 0 }), true)}
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={controlButtonClass}
                      aria-label={t('canvas.relayout')}
                      title={t('canvas.relayout')}
                      onClick={() => {
                        memory.current = {};
                        setDragged({});
                        setLayoutEpoch((epoch) => epoch + 1);
                        onView(() => ({ scale: 1, tx: 0, ty: 0 }), true);
                      }}
                    >
                      <Shuffle className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <p className="mesh-explanation">{t('canvas.hint')}</p>
              </div>

              {(selectedLink && selectedLinkData) || selectedNode ? (
                <InspectorFrame onClose={closeInspector}>
                  {selectedLink && selectedLinkData ? (
                    <LinkDetails
                      source={linkSourceNode}
                      target={linkTargetNode}
                      link={selectedLinkData}
                      state={stateOfLink(selectedLinkData)}
                      cut={isLinkCut}
                      error={linkActionError}
                      notice={linkNotice}
                      busy={linkBusy}
                      canRestore={dropRulesForPair.length > 0}
                      onPeer={goToNode}
                      onBlock={() => setBlockConfirmOpen(true)}
                      onRestore={() => void handleRestore()}
                    />
                  ) : selectedNode ? (
                    <DeviceDetails
                      node={selectedNode}
                      kind={kindOf.get(selectedNode.id)!}
                      state={stateOf.get(selectedNode.id)!}
                      now={now}
                      gateway={gatewayNode}
                      allowedCount={selectedLinks.length}
                      measuredSummary={measuredSummary}
                      peers={peers}
                      peerTotal={peerNodes.length}
                      hops={neighborhoodHops}
                      onHops={setNeighborhoodHops}
                      onPeer={goToNode}
                      onLink={selectLink}
                      onOpenDevice={() => navigate(nodePath(selectedNode.id))}
                    />
                  ) : null}
                </InspectorFrame>
              ) : null}
            </div>
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
