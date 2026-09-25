import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Globe2,
  Lock,
  KeyRound,
  Shield,
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
  EyeOff,
  List,
  Sparkles,
  AlertTriangle,
  ArrowRightLeft,
  Workflow,
  CheckCircle2,
  Network,
  Scissors,
  Link2,
  Unlink,
  RefreshCw,
  Hand
} from 'lucide-react';

import { PageFrame } from '../PageFrame';
import { PageHeader } from '../../ui/PageHeader';
import { nodePath } from '../paths';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card, CardHeader } from '../../ui/Card';
import { CodeText } from '../../ui/CodeText';
import { Dialog } from '../../ui/Dialog';
import { FormField } from '../../ui/FormField';
import { Input } from '../../ui/Input';
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { EmptyState } from '../../ui/States';
import { Stat } from '../../ui/Stat';
import { StatusBadge } from '../../ui/StatusBadge';
import { Table, type TableColumn } from '../../ui/Table';

import {
  useTopology,
  useCompartments,
  useUnlockGhostVaults,
  useLockGhostVaults,
  useUpdateTopologyLink,
  useReconnectAllTopologyLinks
} from '../../services/queries';
import type { TopologyNode, TopologyLink } from '../../services/types';

export type RoleFilter = 'ALL' | 'RELAY' | 'EXIT_BRIDGE' | 'CLIENT_ORIGIN' | 'HYBRID';
export type ViewMode = 'CANVAS' | 'LIST';
export type RoutingMode = 'direct' | 'derp' | 'openvpn' | 'onion';
export type CanvasTool = 'EXPLORE' | 'CUT' | 'CONNECT';

interface SimulationNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  data: TopologyNode;
  isDragging?: boolean;
}

export function TopologyRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // Queries & Mutations
  const topologyQuery = useTopology();
  const compartmentsQuery = useCompartments();
  const unlockMutation = useUnlockGhostVaults();
  const lockMutation = useLockGhostVaults();
  const updateLinkMutation = useUpdateTopologyLink();
  const reconnectAllMutation = useReconnectAllTopologyLinks();

  // Local filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState<RoleFilter>('ALL');
  const [selectedCompartment, setSelectedCompartment] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<ViewMode>('CANVAS');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [physicsActive, setPhysicsActive] = useState(true);

  // Active Interactive Tool: EXPLORE (hand), CUT (scissors), CONNECT (wire)
  const [activeTool, setActiveTool] = useState<CanvasTool>('EXPLORE');

  // Connecting wire state (in CONNECT tool)
  const [connectSourceNode, setConnectSourceNode] = useState<TopologyNode | null>(null);

  // Selected entities
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<TopologyNode | null>(null);
  const [selectedLink, setSelectedLink] = useState<{
    source: TopologyNode;
    target: TopologyNode;
    link: TopologyLink;
  } | null>(null);
  const [hoveredLink, setHoveredLink] = useState<{
    source: string;
    target: string;
    x: number;
    y: number;
    link: TopologyLink;
  } | null>(null);

  // Link editor modal state
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [editSourceNode, setEditSourceNode] = useState<TopologyNode | null>(null);
  const [editTargetNode, setEditTargetNode] = useState<TopologyNode | null>(null);
  const [editMode, setEditMode] = useState<RoutingMode>('direct');
  const [editRelay, setEditRelay] = useState('derp-eu');
  const [editVisible, setEditVisible] = useState(true);

  // Ghost Vault Unlock Dialog
  const [unlockDialogOpen, setUnlockDialogOpen] = useState(false);
  const [vaultPassword, setVaultPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Physics simulation references
  const simNodesRef = useRef<Map<string, SimulationNode>>(new Map());
  const mousePosRef = useRef<{ x: number; y: number } | null>(null);
  const isDraggingAnyRef = useRef(false);
  const animFrameRef = useRef<number | null>(null);
  const pulseOffsetRef = useRef(0);

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

  // Filtered links
  const filteredLinks = useMemo(() => {
    const visibleIds = new Set(filteredNodes.map((n) => n.id));
    return links.filter((l) => visibleIds.has(l.source) && visibleIds.has(l.target));
  }, [links, filteredNodes]);

  // Sync simulation nodes with filteredNodes
  useEffect(() => {
    const canvas = canvasRef.current;
    const width = canvas ? canvas.width : 1100;
    const height = canvas ? canvas.height : 620;
    const cx = width / 2;
    const cy = height / 2;

    const currentMap = simNodesRef.current;
    const newMap = new Map<string, SimulationNode>();

    const count = filteredNodes.length;
    const radius = Math.min(width, height) * 0.35;

    filteredNodes.forEach((node, i) => {
      const existing = currentMap.get(node.id);
      if (existing) {
        existing.data = node;
        newMap.set(node.id, existing);
      } else {
        const angle = (i / Math.max(1, count)) * 2 * Math.PI - Math.PI / 2;
        const x = cx + radius * Math.cos(angle) + (Math.random() - 0.5) * 40;
        const y = cy + radius * Math.sin(angle) + (Math.random() - 0.5) * 40;
        newMap.set(node.id, {
          id: node.id,
          x,
          y,
          vx: 0,
          vy: 0,
          radius: 19,
          data: node,
          isDragging: false
        });
      }
    });

    simNodesRef.current = newMap;
  }, [filteredNodes]);

  // Accurate coordinate converter that handles canvas CSS scaling
  const getCanvasCoords = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }, []);

  // Helper to open link editor modal
  const openLinkEditor = useCallback((sourceNode: TopologyNode, targetNode: TopologyNode, link?: TopologyLink) => {
    setEditSourceNode(sourceNode);
    setEditTargetNode(targetNode);
    setSelectedLink({
      source: sourceNode,
      target: targetNode,
      link: link || {
        source: sourceNode.id,
        target: targetNode.id,
        protocol: 'WG',
        mode: 'direct',
        is_visible: true
      }
    });
    setEditMode(link?.mode || 'direct');
    setEditRelay(link?.relay_id || 'derp-eu');
    setEditVisible(link ? link.is_visible !== false : true);
    setLinkModalOpen(true);
  }, []);

  // Quick Cut Link action (sets is_visible = false)
  const handleQuickCutLink = useCallback(
    async (link: TopologyLink) => {
      try {
        await updateLinkMutation.mutateAsync({
          source_node_id: link.source,
          target_node_id: link.target,
          mode: link.mode || 'direct',
          relay_id: link.relay_id || null,
          is_visible: false
        });
      } catch (err) {
        console.error('Failed to cut link:', err);
      }
    },
    [updateLinkMutation]
  );

  // Quick Reconnect Link action (sets is_visible = true)
  const handleQuickReconnectLink = useCallback(
    async (link: TopologyLink) => {
      try {
        await updateLinkMutation.mutateAsync({
          source_node_id: link.source,
          target_node_id: link.target,
          mode: link.mode || 'direct',
          relay_id: link.relay_id || null,
          is_visible: true
        });
      } catch (err) {
        console.error('Failed to reconnect link:', err);
      }
    },
    [updateLinkMutation]
  );

  // Save Link Configuration from modal
  const handleSaveLink = async () => {
    if (!editSourceNode || !editTargetNode) return;
    try {
      await updateLinkMutation.mutateAsync({
        source_node_id: editSourceNode.id,
        target_node_id: editTargetNode.id,
        mode: editMode,
        relay_id: editMode === 'derp' ? editRelay : null,
        is_visible: editVisible
      });
      setLinkModalOpen(false);
    } catch (err) {
      console.error('Failed to save link configuration:', err);
    }
  };

  // Reconnect All links
  const handleReconnectAll = async () => {
    try {
      await reconnectAllMutation.mutateAsync();
    } catch (err) {
      console.error('Failed to reconnect all links:', err);
    }
  };

  // -------------------------------------------------------------
  // 2D FORCE-DIRECTED PHYSICS ENGINE & RENDERING LOOP
  // -------------------------------------------------------------
  useEffect(() => {
    if (viewMode !== 'CANVAS') return;

    let running = true;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    const cx = width / 2;
    const cy = height / 2;

    const render = () => {
      if (!running) return;

      pulseOffsetRef.current = (pulseOffsetRef.current + 0.4) % 100;
      const simNodes = simNodesRef.current;
      const nodeList = Array.from(simNodes.values());
      const mouse = mousePosRef.current;

      // 1. PHYSICS STEP
      if (physicsActive) {
        // A. Repulsion between all nodes (Coulomb force)
        for (let i = 0; i < nodeList.length; i++) {
          const u = nodeList[i];
          for (let j = i + 1; j < nodeList.length; j++) {
            const v = nodeList[j];
            const dx = v.x - u.x;
            const dy = v.y - u.y;
            const distSq = dx * dx + dy * dy || 1;
            const dist = Math.sqrt(distSq);

            if (dist < 320) {
              const repForce = 1400 / distSq;
              const fx = (dx / dist) * repForce;
              const fy = (dy / dist) * repForce;
              if (!u.isDragging) {
                u.vx -= fx;
                u.vy -= fy;
              }
              if (!v.isDragging) {
                v.vx += fx;
                v.vy += fy;
              }
            }
          }
        }

        // B. Spring attraction along links (Hooke force)
        filteredLinks.forEach((link) => {
          if (link.is_visible === false) return; // Cut links don't pull
          const u = simNodes.get(link.source);
          const v = simNodes.get(link.target);
          if (u && v) {
            const dx = v.x - u.x;
            const dy = v.y - u.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const idealDist = 170;
            const spring = (dist - idealDist) * 0.003;
            const fx = (dx / dist) * spring;
            const fy = (dy / dist) * spring;
            if (!u.isDragging) {
              u.vx += fx;
              u.vy += fy;
            }
            if (!v.isDragging) {
              v.vx -= fx;
              v.vy += fy;
            }
          }
        });

        // C. Center Gravity (gently keeps entire spiderweb centered)
        nodeList.forEach((n) => {
          if (!n.isDragging) {
            const gx = (cx - n.x) * 0.008;
            const gy = (cy - n.y) * 0.008;
            n.vx += gx;
            n.vy += gy;
          }
        });

        // D. Gentle mouse interaction (smooth micro-ripple, NO violent fleeing)
        if (mouse) {
          nodeList.forEach((n) => {
            if (!n.isDragging) {
              const mdx = n.x - mouse.x;
              const mdy = n.y - mouse.y;
              const mDist = Math.sqrt(mdx * mdx + mdy * mdy);
              // Only apply when between 35px and 120px to avoid running away under the cursor!
              if (mDist > 40 && mDist < 120) {
                const push = (1 - mDist / 120) * 0.45;
                n.vx += (mdx / mDist) * push;
                n.vy += (mdy / mDist) * push;
              }
            }
          });
        }

        // E. Damping & Position Integration
        nodeList.forEach((n) => {
          if (!n.isDragging) {
            n.vx *= 0.85;
            n.vy *= 0.85;
            n.x += n.vx;
            n.y += n.vy;
            n.x = Math.max(35, Math.min(width - 35, n.x));
            n.y = Math.max(35, Math.min(height - 35, n.y));
          }
        });
      }

      // 2. RENDERING STEP
      ctx.clearRect(0, 0, width, height);

      // A. Draw Links (Edges)
      filteredLinks.forEach((link) => {
        const u = simNodes.get(link.source);
        const v = simNodes.get(link.target);
        if (!u || !v) return;

        const isLinkHovered =
          hoveredLink &&
          ((hoveredLink.source === link.source && hoveredLink.target === link.target) ||
            (hoveredLink.source === link.target && hoveredLink.target === link.source));
        const isLinkSelected =
          selectedLink &&
          ((selectedLink.source.id === link.source && selectedLink.target.id === link.target) ||
            (selectedLink.source.id === link.target && selectedLink.target.id === link.source));

        const isCut = link.is_visible === false;

        ctx.beginPath();
        ctx.moveTo(u.x, u.y);
        ctx.lineTo(v.x, v.y);

        if (isCut) {
          // Severed / Cut line (dashed crimson with scissor marker)
          ctx.setLineDash([5, 5]);
          ctx.strokeStyle = isLinkHovered || isLinkSelected ? '#ef4444' : 'rgba(239, 68, 68, 0.4)';
          ctx.lineWidth = isLinkHovered || isLinkSelected ? 3 : 1.5;
        } else {
          ctx.setLineDash([]);
          if (link.mode === 'derp') {
            ctx.strokeStyle = isLinkHovered || isLinkSelected ? '#34d399' : 'rgba(16, 185, 129, 0.5)';
            ctx.lineWidth = isLinkHovered || isLinkSelected ? 3.5 : 2;
          } else if (link.mode === 'openvpn') {
            ctx.strokeStyle = isLinkHovered || isLinkSelected ? '#c084fc' : 'rgba(168, 85, 247, 0.5)';
            ctx.lineWidth = isLinkHovered || isLinkSelected ? 3.5 : 2;
          } else if (link.mode === 'onion') {
            ctx.strokeStyle = isLinkHovered || isLinkSelected ? '#fbbf24' : 'rgba(245, 158, 11, 0.5)';
            ctx.lineWidth = isLinkHovered || isLinkSelected ? 3.5 : 2;
          } else {
            // Direct WireGuard
            ctx.strokeStyle = isLinkHovered || isLinkSelected ? '#38bdf8' : 'rgba(56, 189, 248, 0.38)';
            ctx.lineWidth = isLinkHovered || isLinkSelected ? 3.5 : 1.5;
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw midpoint badges for specialized or cut links
        const mx = (u.x + v.x) / 2;
        const my = (u.y + v.y) / 2;

        if (isCut) {
          // Scissor indicator on cut link
          ctx.save();
          ctx.fillStyle = '#ef4444';
          ctx.beginPath();
          ctx.arc(mx, my, 8, 0, 2 * Math.PI);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('✂', mx, my);
          ctx.restore();
        } else if (link.mode === 'derp' || link.mode === 'openvpn' || link.mode === 'onion') {
          ctx.save();
          const badgeColor = link.mode === 'derp' ? '#10b981' : link.mode === 'openvpn' ? '#a855f7' : '#f59e0b';
          const label = link.mode === 'derp' ? 'DERP' : link.mode === 'openvpn' ? 'TLS' : '3-HOP';
          ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
          ctx.strokeStyle = badgeColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(mx - 18, my - 7, 36, 14, 4);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = badgeColor;
          ctx.font = '8px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, mx, my);
          ctx.restore();
        }

        // Draw flowing pulse dot on hovered or selected active links
        if (!isCut && (isLinkHovered || isLinkSelected)) {
          const tP = (pulseOffsetRef.current % 100) / 100;
          const px = u.x + (v.x - u.x) * tP;
          const py = u.y + (v.y - u.y) * tP;
          ctx.beginPath();
          ctx.arc(px, py, 4, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.shadowColor = '#38bdf8';
          ctx.shadowBlur = 10;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      });

      // B. Draw interactive connecting wire if user is currently connecting nodes
      if (activeTool === 'CONNECT' && connectSourceNode && mouse) {
        const srcSim = simNodes.get(connectSourceNode.id);
        if (srcSim) {
          ctx.save();
          ctx.beginPath();
          ctx.setLineDash([6, 4]);
          ctx.moveTo(srcSim.x, srcSim.y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2.5;
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.beginPath();
          ctx.arc(mouse.x, mouse.y, 6, 0, 2 * Math.PI);
          ctx.fillStyle = '#38bdf8';
          ctx.fill();
          ctx.restore();
        }
      }

      // C. Draw Nodes
      nodeList.forEach((n) => {
        const isNodeHovered = hoveredNode?.id === n.id;
        const isNodeSelected = selectedNode?.id === n.id;
        const isConnectSource = connectSourceNode?.id === n.id;

        // Outer Aura for selected or hovered nodes
        if (isNodeSelected || isConnectSource) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.radius + 10, 0, 2 * Math.PI);
          ctx.fillStyle = isConnectSource ? 'rgba(56, 189, 248, 0.35)' : 'rgba(168, 85, 247, 0.35)';
          ctx.fill();

          ctx.beginPath();
          ctx.arc(n.x, n.y, n.radius + 6, 0, 2 * Math.PI);
          ctx.strokeStyle = isConnectSource ? '#38bdf8' : '#a855f7';
          ctx.lineWidth = 2;
          ctx.stroke();
        } else if (isNodeHovered) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.radius + 6, 0, 2 * Math.PI);
          ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
          ctx.fill();
        }

        // Node Circle Body
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.radius, 0, 2 * Math.PI);

        if (n.data.role === 'RELAY') {
          ctx.fillStyle = '#818cf8';
        } else if (n.data.role === 'EXIT_BRIDGE') {
          ctx.fillStyle = '#a78bfa';
        } else {
          ctx.fillStyle = '#38bdf8';
        }
        ctx.fill();

        // Node Border Ring
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = isNodeSelected ? '#ffffff' : '#0f172a';
        ctx.stroke();

        // Node Label (Country Code or Initials)
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = n.data.country || n.data.name?.slice(0, 2).toUpperCase() || 'ND';
        ctx.fillText(label, n.x, n.y);

        // Hostname / ID Text below node
        ctx.fillStyle = isNodeHovered || isNodeSelected ? '#f8fafc' : '#94a3b8';
        ctx.font = isNodeSelected ? 'bold 11px monospace' : '10px monospace';
        const displayName = n.data.name || n.data.id.slice(0, 10);
        ctx.fillText(displayName, n.x, n.y + n.radius + 12);
      });

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      running = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [
    viewMode,
    physicsActive,
    filteredLinks,
    hoveredNode,
    selectedNode,
    hoveredLink,
    selectedLink,
    activeTool,
    connectSourceNode
  ]);

  // -------------------------------------------------------------
  // POINTER INTERACTION HANDLERS (Precise Scaling & Tool Actions)
  // -------------------------------------------------------------
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasCoords(e);
    const simNodes = simNodesRef.current;

    // Check Node Hit
    let clickedNode: SimulationNode | null = null;
    simNodes.forEach((n) => {
      const dx = n.x - x;
      const dy = n.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= n.radius + 14) {
        clickedNode = n;
      }
    });

    // Check Link Hit
    let clickedLinkObj: { source: TopologyNode; target: TopologyNode; link: TopologyLink } | null = null;
    filteredLinks.forEach((link) => {
      const u = simNodes.get(link.source);
      const v = simNodes.get(link.target);
      if (!u || !v) return;

      const l2 = (v.x - u.x) * (v.x - u.x) + (v.y - u.y) * (v.y - u.y);
      if (l2 === 0) return;
      const tP = Math.max(0, Math.min(1, ((x - u.x) * (v.x - u.x) + (y - u.y) * (v.y - u.y)) / l2));
      const projX = u.x + tP * (v.x - u.x);
      const projY = u.y + tP * (v.y - u.y);
      const dist = Math.sqrt((x - projX) * (x - projX) + (y - projY) * (y - projY));

      if (dist < 14) {
        clickedLinkObj = { source: u.data, target: v.data, link };
      }
    });

    // Handle CONNECT Tool
    if (activeTool === 'CONNECT') {
      if (clickedNode) {
        if (!connectSourceNode) {
          setConnectSourceNode(clickedNode.data);
        } else if (connectSourceNode.id !== clickedNode.data.id) {
          // Connected source to target! Open dialog to select transport mode
          openLinkEditor(connectSourceNode, clickedNode.data);
          setConnectSourceNode(null);
          setActiveTool('EXPLORE');
        }
      } else {
        setConnectSourceNode(null);
      }
      return;
    }

    // Handle CUT Tool (Immediate Cut on Click)
    if (activeTool === 'CUT') {
      if (clickedLinkObj) {
        handleQuickCutLink(clickedLinkObj.link);
      }
      return;
    }

    // Handle EXPLORE Tool
    if (clickedNode) {
      clickedNode.isDragging = true;
      isDraggingAnyRef.current = true;
      setSelectedNode(clickedNode.data);
      setSelectedLink(null);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    if (clickedLinkObj) {
      setSelectedLink(clickedLinkObj);
      setSelectedNode(null);
      openLinkEditor(clickedLinkObj.source, clickedLinkObj.target, clickedLinkObj.link);
      return;
    }

    // Clicked empty space
    setSelectedNode(null);
    setSelectedLink(null);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasCoords(e);
    mousePosRef.current = { x, y };

    const simNodes = simNodesRef.current;

    // Handle dragging node
    simNodes.forEach((n) => {
      if (n.isDragging) {
        n.x = x;
        n.y = y;
        n.vx = 0;
        n.vy = 0;
      }
    });

    if (isDraggingAnyRef.current) return;

    // Check hover node
    let foundNode: TopologyNode | null = null;
    simNodes.forEach((n) => {
      const dx = n.x - x;
      const dy = n.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= n.radius + 14) {
        foundNode = n.data;
      }
    });
    setHoveredNode(foundNode);

    // Check hover link
    if (!foundNode) {
      let foundLink: { source: string; target: string; x: number; y: number; link: TopologyLink } | null = null;
      filteredLinks.forEach((link) => {
        const u = simNodes.get(link.source);
        const v = simNodes.get(link.target);
        if (!u || !v) return;

        const l2 = (v.x - u.x) * (v.x - u.x) + (v.y - u.y) * (v.y - u.y);
        if (l2 === 0) return;
        const tP = Math.max(0, Math.min(1, ((x - u.x) * (v.x - u.x) + (y - u.y) * (v.y - u.y)) / l2));
        const projX = u.x + tP * (v.x - u.x);
        const projY = u.y + tP * (v.y - u.y);
        const dist = Math.sqrt((x - projX) * (x - projX) + (y - projY) * (y - projY));

        if (dist < 14) {
          foundLink = { source: link.source, target: link.target, x: projX, y: projY, link };
        }
      });
      setHoveredLink(foundLink);
    } else {
      setHoveredLink(null);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    isDraggingAnyRef.current = false;
    simNodesRef.current.forEach((n) => {
      n.isDragging = false;
    });
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  const handlePointerLeave = () => {
    mousePosRef.current = null;
    setHoveredNode(null);
    setHoveredLink(null);
    isDraggingAnyRef.current = false;
    simNodesRef.current.forEach((n) => {
      n.isDragging = false;
    });
  };

  // Find links connected to selected node
  const selectedNodeLinks = useMemo(() => {
    if (!selectedNode) return [];
    return filteredLinks.filter((l) => l.source === selectedNode.id || l.target === selectedNode.id);
  }, [selectedNode, filteredLinks]);

  // List View Columns
  const listColumns: TableColumn<TopologyNode>[] = [
    {
      header: 'Dispositivo',
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-slate-100">{row.name || row.id}</span>
          {row.is_ghost_vault && (
            <Badge variant="warning" className="text-[10px]">
              Ghost Vault
            </Badge>
          )}
        </div>
      )
    },
    {
      header: 'Ruolo',
      cell: (row) => <Badge variant={row.role === 'RELAY' ? 'info' : 'neutral'}>{row.role}</Badge>
    },
    {
      header: 'Overlay IP',
      cell: (row) => <CodeText>{row.overlay_ipv4 || '—'}</CodeText>
    },
    {
      header: 'Paese',
      cell: (row) => <span className="font-mono text-xs">{row.country || 'Global'}</span>
    },
    {
      header: 'Latenza',
      cell: (row) => (
        <span className="font-mono text-xs text-slate-300">{row.latency_ms ? `${row.latency_ms} ms` : '—'}</span>
      )
    },
    {
      header: 'Stato',
      cell: (row) => (
        <StatusBadge status={row.is_quarantined ? 'quarantined' : row.is_healthy ? 'healthy' : 'degraded'} />
      )
    }
  ];

  return (
    <PageFrame>
      <PageHeader
        title="Topologia di Rete Sovrana"
        description="Mappa interattiva della mesh a ragnatela con fisica vettoriale. Seleziona nodi, taglia fili, traccia collegamenti e configura la modalità di trasporto."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant={viewMode === 'CANVAS' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setViewMode('CANVAS')}
            >
              <Network className="mr-1.5 h-4 w-4" /> Canvas Ragnatela
            </Button>
            <Button
              variant={viewMode === 'LIST' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => setViewMode('LIST')}
            >
              <List className="mr-1.5 h-4 w-4" /> Elenco Nodi
            </Button>
            {isUnlocked ? (
              <Button variant="danger" size="sm" onClick={() => lockMutation.mutate()} loading={lockMutation.isPending}>
                <Lock className="mr-1.5 h-4 w-4" /> Blocca Ghost Vault
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setUnlockDialogOpen(true)}>
                <KeyRound className="mr-1.5 h-4 w-4" /> Sblocca Ghost Vault
              </Button>
            )}
          </div>
        }
      />

      {/* Top Controls & Metrics */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Nodi nel Grafo" value={filteredNodes.length} />
        <Stat label="Collegamenti Ragnatela" value={filteredLinks.filter((l) => l.is_visible !== false).length} />
        <Stat label="Collegamenti Tagliati" value={filteredLinks.filter((l) => l.is_visible === false).length} />
        <Stat label="Topologia Mesh" value="Attiva (100%)" description="Crittografia WireGuard P2P" />
      </div>

      {viewMode === 'CANVAS' ? (
        <Card className="relative overflow-hidden border border-border bg-slate-950/80 p-0 shadow-2xl">
          {/* Top Interactive Toolset Header */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-slate-900/90 px-4 py-2.5 backdrop-blur-md">
            {/* Tool Selection Segmented Pill */}
            <div className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 p-1">
              <button
                type="button"
                onClick={() => {
                  setActiveTool('EXPLORE');
                  setConnectSourceNode(null);
                }}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                  activeTool === 'EXPLORE'
                    ? 'bg-sky-500 text-white shadow'
                    : 'text-slate-300 hover:bg-slate-700/60 hover:text-white'
                }`}
              >
                <Hand className="h-3.5 w-3.5" /> Esplora / Sposta
              </button>

              <button
                type="button"
                onClick={() => {
                  setActiveTool('CUT');
                  setConnectSourceNode(null);
                }}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                  activeTool === 'CUT'
                    ? 'bg-rose-600 text-white shadow'
                    : 'text-slate-300 hover:bg-slate-700/60 hover:text-white'
                }`}
              >
                <Scissors className="h-3.5 w-3.5" /> ✂️ Taglia Fili
              </button>

              <button
                type="button"
                onClick={() => {
                  setActiveTool('CONNECT');
                }}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                  activeTool === 'CONNECT'
                    ? 'bg-indigo-600 text-white shadow'
                    : 'text-slate-300 hover:bg-slate-700/60 hover:text-white'
                }`}
              >
                <Link2 className="h-3.5 w-3.5" /> 🔗 Collega Nodi
              </button>
            </div>

            {/* Quick Actions & Physics Toggle */}
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleReconnectAll}
                loading={reconnectAllMutation.isPending}
                title="Ripristina tutti i collegamenti tagliati nel mesh"
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Riconnetti Tutto
              </Button>

              <Button variant="secondary" size="sm" onClick={() => setPhysicsActive(!physicsActive)}>
                {physicsActive ? (
                  <>
                    <Pause className="mr-1.5 h-3.5 w-3.5 text-amber-400" /> Ferma Fisica
                  </>
                ) : (
                  <>
                    <Play className="mr-1.5 h-3.5 w-3.5 text-emerald-400" /> Avvia Fisica
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* Active Tool Notification Banner */}
          {activeTool === 'CUT' && (
            <div className="bg-rose-950/70 border-b border-rose-800/50 px-4 py-2 text-xs font-mono text-rose-300 flex items-center justify-between">
              <span>
                ✂️ <strong>MODALITÀ FORBICI ATTIVA:</strong> Clicca su qualsiasi linea per tagliarla all'istante e
                isolare il traffico tra i due nodi.
              </span>
              <button onClick={() => setActiveTool('EXPLORE')} className="underline hover:text-white">
                Esci
              </button>
            </div>
          )}

          {activeTool === 'CONNECT' && (
            <div className="bg-indigo-950/70 border-b border-indigo-800/50 px-4 py-2 text-xs font-mono text-indigo-300 flex items-center justify-between">
              <span>
                🔗 <strong>MODALITÀ COLLEGAMENTO:</strong>{' '}
                {connectSourceNode
                  ? `Nodo sorgente selezionato (${connectSourceNode.name || connectSourceNode.id}). Ora clicca sul nodo destinazione.`
                  : 'Clicca sul primo nodo da collegare.'}
              </span>
              <button
                onClick={() => {
                  setActiveTool('EXPLORE');
                  setConnectSourceNode(null);
                }}
                className="underline hover:text-white"
              >
                Annulla
              </button>
            </div>
          )}

          {/* Canvas Element with cursor dynamics */}
          <canvas
            ref={canvasRef}
            width={1100}
            height={620}
            className={`w-full touch-none select-none ${
              activeTool === 'CUT'
                ? 'cursor-crosshair'
                : activeTool === 'CONNECT'
                  ? 'cursor-pointer'
                  : 'cursor-grab active:cursor-grabbing'
            }`}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerLeave}
          />

          {/* Legend and Hints Bar */}
          <div className="pointer-events-none absolute bottom-3 left-4 flex flex-wrap items-center gap-4 text-xs font-mono text-slate-400">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-sky-400" /> Direct WireGuard
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400" /> DERP Relay
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-purple-400" /> OpenVPN Stealth
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-rose-500" /> Reciso / Tagliato
            </span>
          </div>

          {/* Floating Selected Node Card (Side Drawer Overlay) */}
          {selectedNode && (
            <div className="absolute top-16 right-4 w-80 rounded-xl border border-slate-700 bg-slate-900/95 p-4 shadow-2xl backdrop-blur-md z-20">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                    <h4 className="font-mono text-sm font-bold text-white">{selectedNode.name || selectedNode.id}</h4>
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-slate-400">{selectedNode.overlay_ipv4}</p>
                </div>
                <button
                  onClick={() => setSelectedNode(null)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                >
                  ✕
                </button>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded bg-slate-800/80 p-2">
                  <span className="text-slate-400 block text-[10px]">Ruolo</span>
                  <span className="font-semibold text-sky-400">{selectedNode.role}</span>
                </div>
                <div className="rounded bg-slate-800/80 p-2">
                  <span className="text-slate-400 block text-[10px]">Paese</span>
                  <span className="font-semibold text-white">{selectedNode.country || 'Global'}</span>
                </div>
              </div>

              {/* Connections list */}
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-slate-300 font-medium mb-1.5">
                  <span>Collegamenti Attivi ({selectedNodeLinks.filter((l) => l.is_visible !== false).length})</span>
                </div>
                <div className="max-h-32 overflow-y-auto space-y-1 text-xs font-mono">
                  {selectedNodeLinks.map((l) => {
                    const peerId = l.source === selectedNode.id ? l.target : l.source;
                    const peerNode = nodes.find((n) => n.id === peerId);
                    const isCut = l.is_visible === false;
                    return (
                      <div
                        key={`${l.source}-${l.target}`}
                        className="flex items-center justify-between rounded bg-slate-800/50 px-2 py-1"
                      >
                        <span className={isCut ? 'text-rose-400 line-through' : 'text-slate-200'}>
                          {peerNode?.name || peerId.slice(0, 10)}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-sky-400 uppercase">{l.mode || 'direct'}</span>
                          {isCut ? (
                            <button
                              onClick={() => handleQuickReconnectLink(l)}
                              className="text-xs text-emerald-400 hover:text-emerald-300 font-bold"
                              title="Riconnetti"
                            >
                              🔗
                            </button>
                          ) : (
                            <button
                              onClick={() => handleQuickCutLink(l)}
                              className="text-xs text-rose-400 hover:text-rose-300 font-bold"
                              title="Taglia"
                            >
                              ✂️
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Actions */}
              <div className="mt-4 flex flex-col gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setConnectSourceNode(selectedNode);
                    setActiveTool('CONNECT');
                  }}
                >
                  <Link2 className="mr-1.5 h-3.5 w-3.5" /> Collega ad un altro nodo
                </Button>
                <Button variant="secondary" size="sm" onClick={() => navigate(nodePath(selectedNode.id))}>
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Scheda Dispositivo
                </Button>
              </div>
            </div>
          )}
        </Card>
      ) : (
        <Card>
          <Table columns={listColumns} data={filteredNodes} keyExtractor={(row) => row.id} />
        </Card>
      )}

      {/* LINK CONFIGURATION & MODE CHANGER MODAL */}
      <Dialog isOpen={linkModalOpen} onClose={() => setLinkModalOpen(false)} title="Configura Canale Mesh P2P">
        {editSourceNode && editTargetNode && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-slate-900/60 p-3">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span>Dispositivo A</span>
                <span>Dispositivo B</span>
              </div>
              <div className="flex items-center justify-between font-mono font-bold text-white text-sm">
                <span>{editSourceNode.name || editSourceNode.id.slice(0, 12)}</span>
                <ArrowRightLeft className="h-4 w-4 text-sky-400" />
                <span>{editTargetNode.name || editTargetNode.id.slice(0, 12)}</span>
              </div>
            </div>

            <FormField label="Modalità di Trasporto Overlay">
              <Select value={editMode} onChange={(e) => setEditMode(e.target.value as RoutingMode)}>
                <option value="direct">⚡ Direct WireGuard (P2P kernel/userspace)</option>
                <option value="derp">🌐 DERP Relay di passaggio (Bypass NAT simmetrico)</option>
                <option value="openvpn">🔒 OpenVPN Stealth Tunnel (TLS 443 mimicry)</option>
                <option value="onion">🧅 Onion Multi-Hop Circuit (3-hop routing)</option>
              </Select>
            </FormField>

            {editMode === 'derp' && (
              <FormField label="Relay DERP di Passaggio">
                <Select value={editRelay} onChange={(e) => setEditRelay(e.target.value)}>
                  <option value="derp-eu">derp-eu (Francoforte, Germania - 8444/3478)</option>
                  <option value="derp-us">derp-us (New York, USA - 8445/3479)</option>
                </Select>
              </FormField>
            )}

            <div className="flex items-center justify-between rounded-lg border border-border bg-slate-900/40 p-3">
              <div>
                <span className="text-sm font-medium text-slate-200 block">Stato Connessione nel Mesh</span>
                <span className="text-xs text-slate-400">
                  {editVisible
                    ? 'I due nodi comunicano normalmente.'
                    : 'Connessione tagliata: regola DROP attiva nel firewall.'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant={editVisible ? 'danger' : 'primary'}
                  size="sm"
                  onClick={() => setEditVisible(!editVisible)}
                >
                  {editVisible ? (
                    <>
                      <Scissors className="mr-1 h-3.5 w-3.5" /> Taglia Filo
                    </>
                  ) : (
                    <>
                      <Link2 className="mr-1 h-3.5 w-3.5" /> Riconnetti
                    </>
                  )}
                </Button>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={() => setLinkModalOpen(false)}>
                Annulla
              </Button>
              <Button variant="primary" onClick={handleSaveLink} loading={updateLinkMutation.isPending}>
                <CheckCircle2 className="mr-1.5 h-4 w-4" /> Salva Modifiche
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* Ghost Vault Unlock Modal */}
      <Dialog isOpen={unlockDialogOpen} onClose={() => setUnlockDialogOpen(false)} title="Sblocca Ghost Vault">
        <div className="space-y-4">
          <FormField label="Password Master Ghost Vault" error={unlockError || undefined}>
            <Input
              type="password"
              value={vaultPassword}
              onChange={(e) => setVaultPassword(e.target.value)}
              placeholder="Inserisci password crittografica"
            />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setUnlockDialogOpen(false)}>
              Annulla
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  await unlockMutation.mutateAsync(vaultPassword);
                  setUnlockDialogOpen(false);
                } catch {
                  setUnlockError('Password non valida o mancata autorizzazione');
                }
              }}
              loading={unlockMutation.isPending}
            >
              Sblocca
            </Button>
          </div>
        </div>
      </Dialog>
    </PageFrame>
  );
}

export default TopologyRoute;
