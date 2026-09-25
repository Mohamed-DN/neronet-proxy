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
  Network
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
  useUpdateTopologyLink
} from '../../services/queries';
import type { TopologyNode, TopologyLink } from '../../services/types';

export type RoleFilter = 'ALL' | 'RELAY' | 'EXIT_BRIDGE' | 'CLIENT_ORIGIN' | 'HYBRID';
export type ViewMode = 'CANVAS' | 'LIST';
export type RoutingMode = 'direct' | 'derp' | 'openvpn' | 'onion';

interface SimulationNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  isDragging: boolean;
  data: TopologyNode;
}

export default function TopologyRoute() {
  const { t } = useTranslation('ui');
  const navigate = useNavigate();

  // Queries & Mutations
  const topologyQuery = useTopology();
  const compartmentsQuery = useCompartments();
  const unlockMutation = useUnlockGhostVaults();
  const lockMutation = useLockGhostVaults();
  const updateLinkMutation = useUpdateTopologyLink();

  // Local filter states
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRole, setSelectedRole] = useState<RoleFilter>('ALL');
  const [selectedCompartment, setSelectedCompartment] = useState<string>('ALL');
  const [viewMode, setViewMode] = useState<ViewMode>('CANVAS');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [physicsActive, setPhysicsActive] = useState(true);

  // Dialogs & selection
  const [unlockDialogOpen, setUnlockDialogOpen] = useState(false);
  const [vaultPassword, setVaultPassword] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);

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

  // Link editor state
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [editMode, setEditMode] = useState<RoutingMode>('direct');
  const [editRelay, setEditRelay] = useState('derp-eu');
  const [editVisible, setEditVisible] = useState(true);

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
    const width = canvas ? canvas.width : 1000;
    const height = canvas ? canvas.height : 600;
    const cx = width / 2;
    const cy = height / 2;

    const currentMap = simNodesRef.current;
    const newMap = new Map<string, SimulationNode>();

    filteredNodes.forEach((node, idx) => {
      const existing = currentMap.get(node.id);
      if (existing) {
        existing.data = node;
        newMap.set(node.id, existing);
      } else {
        const angle = (idx / Math.max(1, filteredNodes.length)) * Math.PI * 2;
        const radius = Math.min(width, height) * 0.35 + (Math.random() * 40 - 20);
        newMap.set(node.id, {
          id: node.id,
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
          vx: (Math.random() - 0.5) * 2,
          vy: (Math.random() - 0.5) * 2,
          radius: 14,
          isDragging: false,
          data: node
        });
      }
    });

    simNodesRef.current = newMap;
  }, [filteredNodes]);

  // Reset physics layout
  const resetLayout = useCallback(() => {
    const canvas = canvasRef.current;
    const width = canvas ? canvas.width : 1000;
    const height = canvas ? canvas.height : 600;
    const cx = width / 2;
    const cy = height / 2;

    const map = simNodesRef.current;
    const total = map.size;
    let idx = 0;
    map.forEach((n) => {
      const angle = (idx / Math.max(1, total)) * Math.PI * 2;
      const radius = Math.min(width, height) * 0.32;
      n.x = cx + Math.cos(angle) * radius;
      n.y = cy + Math.sin(angle) * radius;
      n.vx = (Math.random() - 0.5) * 3;
      n.vy = (Math.random() - 0.5) * 3;
      idx++;
    });
  }, []);

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
      setSelectedLink(null);
    } catch {
      // Locking failed
    }
  };

  // Open Link Editor
  const openLinkEditor = (sourceNode: TopologyNode, targetNode: TopologyNode, link: TopologyLink) => {
    setSelectedLink({ source: sourceNode, target: targetNode, link });
    setEditMode((link.mode as RoutingMode) || 'direct');
    setEditRelay((link.relay_id as string) || 'derp-eu');
    setEditVisible(link.is_visible !== false);
    setLinkModalOpen(true);
  };

  // Save Link Configuration
  const handleSaveLink = async () => {
    if (!selectedLink) return;
    try {
      await updateLinkMutation.mutateAsync({
        source_node_id: selectedLink.source.id,
        target_node_id: selectedLink.target.id,
        mode: editMode,
        relay_id: editMode === 'derp' ? editRelay : null,
        is_visible: editVisible
      });
      setLinkModalOpen(false);
    } catch (err) {
      console.error('Failed to update topology link:', err);
    }
  };

  // Physics & Canvas Animation Loop
  useEffect(() => {
    if (viewMode !== 'CANVAS') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      return;
    }
    if (!ctx) return;

    let running = true;

    const render = (time: number) => {
      if (!running) return;
      const width = canvas.width;
      const height = canvas.height;
      const cx = width / 2;
      const cy = height / 2;
      const simNodes = simNodesRef.current;
      const mouse = mousePosRef.current;

      pulseOffsetRef.current = (pulseOffsetRef.current + 0.02) % 1;

      // 1. PHYSICS STEP
      if (physicsActive) {
        const nodeList = Array.from(simNodes.values());
        const nLen = nodeList.length;

        // A. Repulsion between all node pairs (Coulomb force)
        for (let i = 0; i < nLen; i++) {
          const a = nodeList[i];
          for (let j = i + 1; j < nLen; j++) {
            const b = nodeList[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const distSq = dx * dx + dy * dy;
            const dist = Math.sqrt(distSq) || 1;
            if (dist < 380) {
              const force = 3200 / (distSq + 150);
              const fx = (dx / dist) * force;
              const fy = (dy / dist) * force;
              if (!a.isDragging) { a.vx -= fx; a.vy -= fy; }
              if (!b.isDragging) { b.vx += fx; b.vy += fy; }
            }
          }
        }

        // B. Spring attraction along links (Hooke force)
        filteredLinks.forEach((link) => {
          const u = simNodes.get(link.source);
          const v = simNodes.get(link.target);
          if (u && v) {
            const dx = v.x - u.x;
            const dy = v.y - u.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const targetDist = 180;
            const delta = dist - targetDist;
            const spring = delta * 0.035;
            const fx = (dx / dist) * spring;
            const fy = (dy / dist) * spring;
            if (!u.isDragging) { u.vx += fx; u.vy += fy; }
            if (!v.isDragging) { v.vx -= fx; v.vy -= fy; }
          }
        });

        // C. Center Gravity & Ambient Wave
        nodeList.forEach((n, idx) => {
          if (!n.isDragging) {
            const gx = (cx - n.x) * 0.012;
            const gy = (cy - n.y) * 0.012;
            n.vx += gx;
            n.vy += gy;

            // Ambient gentle oscillation
            const ambient = Math.sin(time * 0.0015 + idx) * 0.25;
            n.vx += ambient;
            n.vy += ambient;
          }
        });

        // D. Interactive Mouse Repulsion Wave
        if (mouse) {
          nodeList.forEach((n) => {
            if (!n.isDragging) {
              const mdx = n.x - mouse.x;
              const mdy = n.y - mouse.y;
              const mDist = Math.sqrt(mdx * mdx + mdy * mdy);
              const waveRadius = 160;
              if (mDist < waveRadius && mDist > 0) {
                const intensity = (1 - mDist / waveRadius);
                const push = intensity * intensity * 12.0;
                n.vx += (mdx / mDist) * push;
                n.vy += (mdy / mDist) * push;
              }
            }
          });
        }

        // E. Damping, Position Integration & Boundary
        nodeList.forEach((n) => {
          if (!n.isDragging) {
            n.vx *= 0.88;
            n.vy *= 0.88;
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

        const isLinkHovered = hoveredLink &&
          ((hoveredLink.source === link.source && hoveredLink.target === link.target) ||
           (hoveredLink.source === link.target && hoveredLink.target === link.source));
        const isLinkSelected = selectedLink &&
          ((selectedLink.source.id === link.source && selectedLink.target.id === link.target) ||
           (selectedLink.source.id === link.target && selectedLink.target.id === link.source));

        ctx.beginPath();
        ctx.moveTo(u.x, u.y);
        ctx.lineTo(v.x, v.y);

        // Styling based on mode and state
        if (link.is_visible === false) {
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = isLinkHovered ? '#f87171' : 'rgba(239, 68, 68, 0.45)';
          ctx.lineWidth = isLinkHovered ? 2.5 : 1.5;
        } else {
          ctx.setLineDash([]);
          if (link.mode === 'derp') {
            ctx.strokeStyle = isLinkHovered || isLinkSelected ? '#34d399' : 'rgba(16, 185, 129, 0.45)';
            ctx.lineWidth = isLinkHovered || isLinkSelected ? 3 : 2;
          } else if (link.mode === 'openvpn') {
            ctx.strokeStyle = isLinkHovered || isLinkSelected ? '#c084fc' : 'rgba(168, 85, 247, 0.45)';
            ctx.lineWidth = isLinkHovered || isLinkSelected ? 3 : 2;
          } else if (link.mode === 'onion') {
            ctx.strokeStyle = isLinkHovered || isLinkSelected ? '#fbbf24' : 'rgba(245, 158, 11, 0.45)';
            ctx.lineWidth = isLinkHovered || isLinkSelected ? 3 : 2;
          } else {
            // Direct WireGuard
            ctx.strokeStyle = isLinkHovered || isLinkSelected ? '#38bdf8' : 'rgba(56, 189, 248, 0.35)';
            ctx.lineWidth = isLinkHovered || isLinkSelected ? 3 : 1.5;
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Animated Packet Particle flow
        if (link.is_visible !== false) {
          const tP = (pulseOffsetRef.current + (u.x % 10) * 0.1) % 1;
          const px = u.x + (v.x - u.x) * tP;
          const py = u.y + (v.y - u.y) * tP;
          ctx.beginPath();
          ctx.arc(px, py, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = link.mode === 'derp' ? '#34d399' : link.mode === 'openvpn' ? '#c084fc' : '#38bdf8';
          ctx.fill();
        }
      });

      // B. Draw Nodes
      simNodes.forEach((n) => {
        const isHovered = hoveredNode?.id === n.id;
        const isSelected = selectedNode?.id === n.id;
        const baseRadius = isHovered || isSelected ? 17 : 13;

        // Outer Aura
        if (n.data.is_ghost_vault) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, baseRadius + 6, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(168, 85, 247, 0.25)';
          ctx.fill();
        } else if (isSelected || isHovered) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, baseRadius + 5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
          ctx.fill();
        }

        // Main Node Fill
        ctx.beginPath();
        ctx.arc(n.x, n.y, baseRadius, 0, Math.PI * 2);

        if (n.data.is_quarantined) {
          ctx.fillStyle = '#ef4444';
        } else if (n.data.is_ghost_vault) {
          ctx.fillStyle = '#a855f7';
        } else if (n.data.role === 'RELAY') {
          ctx.fillStyle = '#10b981';
        } else if (n.data.role === 'EXIT_BRIDGE') {
          ctx.fillStyle = '#6366f1';
        } else if (n.data.role === 'HYBRID') {
          ctx.fillStyle = '#06b6d4';
        } else {
          ctx.fillStyle = '#38bdf8';
        }
        ctx.fill();

        // Node Border Ring
        ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.stroke();

        // Country code / short label inside
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = n.data.country || 'N';
        ctx.fillText(label, n.x, n.y);

        // Hostname / Label below node
        ctx.font = '10px JetBrains Mono, monospace';
        ctx.fillStyle = isHovered || isSelected ? '#38bdf8' : '#94a3b8';
        ctx.textBaseline = 'top';
        const displayName = n.data.name || `Node-${n.id.slice(-6)}`;
        ctx.fillText(displayName, n.x, n.y + baseRadius + 4);
      });

      animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);

    return () => {
      running = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [viewMode, physicsActive, filteredLinks, hoveredNode, selectedNode, hoveredLink, selectedLink]);

  // Pointer Interaction Handlers
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const simNodes = simNodesRef.current;
    let clickedNode: SimulationNode | null = null;

    // Check node hit
    simNodes.forEach((n) => {
      const dx = n.x - x;
      const dy = n.y - y;
      if (Math.sqrt(dx * dx + dy * dy) <= n.radius + 6) {
        clickedNode = n;
      }
    });

    if (clickedNode) {
      clickedNode.isDragging = true;
      isDraggingAnyRef.current = true;
      setSelectedNode(clickedNode.data);
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }

    // Check link hit
    let clickedLinkObj: { source: TopologyNode; target: TopologyNode; link: TopologyLink } | null = null;
    filteredLinks.forEach((link) => {
      const u = simNodes.get(link.source);
      const v = simNodes.get(link.target);
      if (!u || !v) return;

      // Distance from point (x, y) to segment (u, v)
      const l2 = (v.x - u.x) * (v.x - u.x) + (v.y - u.y) * (v.y - u.y);
      if (l2 === 0) return;
      const tP = Math.max(0, Math.min(1, ((x - u.x) * (v.x - u.x) + (y - u.y) * (v.y - u.y)) / l2));
      const projX = u.x + tP * (v.x - u.x);
      const projY = u.y + tP * (v.y - u.y);
      const dist = Math.sqrt((x - projX) * (x - projX) + (y - projY) * (y - projY));

      if (dist < 12) {
        clickedLinkObj = { source: u.data, target: v.data, link };
      }
    });

    if (clickedLinkObj) {
      openLinkEditor(clickedLinkObj.source, clickedLinkObj.target, clickedLinkObj.link);
    } else {
      setSelectedNode(null);
      setSelectedLink(null);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    mousePosRef.current = { x, y };

    const simNodes = simNodesRef.current;

    // If dragging a node
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
      if (Math.sqrt(dx * dx + dy * dy) <= n.radius + 6) {
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

        if (dist < 10) {
          foundLink = { source: link.source, target: link.target, x, y, link };
        }
      });
      setHoveredLink(foundLink);
    } else {
      setHoveredLink(null);
    }
  };

  const handlePointerUp = () => {
    simNodesRef.current.forEach((n) => {
      n.isDragging = false;
    });
    isDraggingAnyRef.current = false;
  };

  const handlePointerLeave = () => {
    mousePosRef.current = null;
    setHoveredNode(null);
    setHoveredLink(null);
    handlePointerUp();
  };

  // Table columns for LIST view
  const columns: TableColumn<TopologyNode>[] = [
    {
      id: 'name',
      header: 'Nome Nodo',
      cell: (row) => (
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-accent" />
          <span className="font-mono font-medium">{row.name || `Node-${row.id.slice(-6)}`}</span>
          {row.is_ghost_vault && <Badge variant="warning">Ghost Vault</Badge>}
        </div>
      )
    },
    {
      id: 'role',
      header: 'Ruolo Mesh',
      cell: (row) => <Badge variant={row.role === 'RELAY' ? 'success' : 'neutral'}>{row.role}</Badge>
    },
    {
      id: 'country',
      header: 'Nazione',
      cell: (row) => <CodeText>{row.country || 'N/A'}</CodeText>
    },
    {
      id: 'ip',
      header: 'VIP Overlay',
      cell: (row) => <CodeText>{row.overlay_ipv4 || '-'}</CodeText>
    },
    {
      id: 'status',
      header: 'Stato',
      cell: (row) => (
        <StatusBadge
          status={row.is_quarantined ? 'quarantined' : row.is_healthy ? 'online' : 'offline'}
          label={row.is_quarantined ? 'In Quarantena' : row.is_healthy ? 'Attivo' : 'Disconnesso'}
        />
      )
    }
  ];

  return (
    <PageFrame>
      <PageHeader
        title="Topologia Mesh Sovrana"
        subtitle="Ragnatela 2D dinamica a fisica attiva, routing P2P, relay DERP e isolamento Zero-Trust"
        badge={
          <Badge variant={isUnlocked ? 'warning' : 'neutral'}>
            {isUnlocked ? 'Ghost Vaults Sbloccati' : 'Mesh Standard'}
          </Badge>
        }
        actions={
          <div className="flex items-center gap-2">
            {isUnlocked ? (
              <Button variant="secondary" onClick={handleLockVaults}>
                <Lock className="mr-1.5 h-4 w-4" />
                Blocca Vault
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setUnlockDialogOpen(true)}>
                <KeyRound className="mr-1.5 h-4 w-4" />
                Sblocca Ghost Vault
              </Button>
            )}
            <Button
              variant={viewMode === 'CANVAS' ? 'primary' : 'secondary'}
              onClick={() => setViewMode(viewMode === 'CANVAS' ? 'LIST' : 'CANVAS')}
            >
              {viewMode === 'CANVAS' ? <List className="mr-1.5 h-4 w-4" /> : <Network className="mr-1.5 h-4 w-4" />}
              {viewMode === 'CANVAS' ? 'Vista Lista' : 'Vista Ragnatela'}
            </Button>
          </div>
        }
      />

      {/* Top Filter Bar */}
      <Card className="mb-6 p-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
            <Input
              className="pl-9"
              placeholder="Cerca per nome, IP o ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Select
            value={selectedRole}
            onChange={(val) => setSelectedRole(val as RoleFilter)}
            options={[
              { value: 'ALL', label: 'Tutti i Ruoli' },
              { value: 'CLIENT_ORIGIN', label: 'Client Origin' },
              { value: 'EXIT_BRIDGE', label: 'Exit Bridge' },
              { value: 'RELAY', label: 'Relay Nodes' }
            ]}
          />
          <Select
            value={selectedCompartment}
            onChange={(val) => setSelectedCompartment(val)}
            options={[
              { value: 'ALL', label: 'Tutti i Compartimenti' },
              ...compartments.map((c) => ({ value: c.id, label: c.name }))
            ]}
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPhysicsActive(!physicsActive)}
              title={physicsActive ? 'Pausa Fisica' : 'Avvia Fisica'}
            >
              {physicsActive ? <Pause className="h-4 w-4 text-accent" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="sm" onClick={resetLayout} title="Ripristina Layout">
              <RotateCcw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsFullscreen(!isFullscreen)}
              title={isFullscreen ? 'Riduci' : 'Schermo Intero'}
            >
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </Card>

      {/* Main View Area */}
      {viewMode === 'CANVAS' ? (
        <div className="relative">
          <Card className="relative overflow-hidden border border-border bg-slate-950/70 p-0 shadow-2xl">
            {/* Canvas Element with cursor dynamics */}
            <canvas
              ref={canvasRef}
              width={1100}
              height={620}
              className="w-full cursor-crosshair touch-none select-none"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerLeave={handlePointerLeave}
            />

            {/* Quick interactive hint */}
            <div className="pointer-events-none absolute bottom-3 left-4 flex items-center gap-3 text-xs font-mono text-slate-400">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-sky-400 animate-pulse" /> Trascina i nodi per muovere la ragnatela
              </span>
              <span>•</span>
              <span>Muovi il mouse per respingere e far vibrare i fili</span>
              <span>•</span>
              <span>Clicca su una linea per configurare routing e visibilità</span>
            </div>

            {/* Link Hover Tooltip */}
            {hoveredLink && (
              <div
                className="pointer-events-none absolute z-20 rounded-md bg-slate-900/90 px-3 py-1.5 font-mono text-xs text-sky-300 shadow-xl border border-sky-500/30 backdrop-blur-md"
                style={{ left: Math.min(hoveredLink.x + 15, 950), top: Math.max(hoveredLink.y - 30, 20) }}
              >
                🔗 Clicca per configurare collegamento [{hoveredLink.source.slice(-6)} ↔ {hoveredLink.target.slice(-6)}]
              </div>
            )}
          </Card>

          {/* Selected Node Drawer / Info Card */}
          {selectedNode && (
            <Card className="mt-4 p-4 border-l-4 border-l-sky-500">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-sky-500/20 p-2 text-sky-400">
                    <Server className="h-5 w-5" />
                  </div>
                  <div>
                    <h4 className="font-mono text-base font-bold text-content">
                      {selectedNode.name || `Node-${selectedNode.id.slice(-6)}`}
                    </h4>
                    <p className="font-mono text-xs text-muted">ID: {selectedNode.id} | VIP: {selectedNode.overlay_ipv4 || '-'}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <Badge variant={selectedNode.role === 'RELAY' ? 'success' : 'neutral'}>
                    {selectedNode.role}
                  </Badge>
                  <CodeText>{selectedNode.country || 'N/A'}</CodeText>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => navigate(nodePath(selectedNode.id))}
                  >
                    Dettagli Nodo <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </Card>
          )}
        </div>
      ) : (
        <Card className="p-4">
          <Table columns={columns} data={filteredNodes} keyField="id" />
        </Card>
      )}

      {/* Link Configuration Dialog (Modalità Routing & Visibilità) */}
      <Dialog
        isOpen={linkModalOpen}
        onClose={() => setLinkModalOpen(false)}
        title="Configurazione Connessione Mesh Tra Dispositivi"
      >
        {selectedLink && (
          <div className="space-y-5">
            {/* Device Pair Summary */}
            <div className="flex items-center justify-between rounded-lg bg-surface-raised p-3 border border-border">
              <div className="text-left">
                <span className="text-xs text-muted font-mono block">Dispositivo A</span>
                <span className="font-mono font-bold text-content">{selectedLink.source.name || selectedLink.source.id.slice(-8)}</span>
                <span className="text-xs text-sky-400 block font-mono">{selectedLink.source.overlay_ipv4}</span>
              </div>
              <ArrowRightLeft className="h-5 w-5 text-accent animate-pulse" />
              <div className="text-right">
                <span className="text-xs text-muted font-mono block">Dispositivo B</span>
                <span className="font-mono font-bold text-content">{selectedLink.target.name || selectedLink.target.id.slice(-8)}</span>
                <span className="text-xs text-sky-400 block font-mono">{selectedLink.target.overlay_ipv4}</span>
              </div>
            </div>

            {/* Routing Mode Selector */}
            <FormField label="Modalità di Trasporto & Instradamento" htmlFor="routing-mode">
              <div className="grid grid-cols-2 gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => setEditMode('direct')}
                  className={`rounded-lg p-3 text-left border transition-all ${
                    editMode === 'direct'
                      ? 'border-sky-500 bg-sky-500/10 text-sky-300'
                      : 'border-border bg-surface hover:border-slate-600'
                  }`}
                >
                  <div className="font-mono font-bold text-sm flex items-center gap-1.5">
                    <Zap className="h-4 w-4" /> Direct WireGuard
                  </div>
                  <p className="text-xs text-muted mt-1">Connessione P2P netstack diretta, minima latenza.</p>
                </button>

                <button
                  type="button"
                  onClick={() => setEditMode('derp')}
                  className={`rounded-lg p-3 text-left border transition-all ${
                    editMode === 'derp'
                      ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300'
                      : 'border-border bg-surface hover:border-slate-600'
                  }`}
                >
                  <div className="font-mono font-bold text-sm flex items-center gap-1.5">
                    <Radio className="h-4 w-4" /> DERP Relay Proxy
                  </div>
                  <p className="text-xs text-muted mt-1">Transito via server DERP cifrato per bypass NAT.</p>
                </button>

                <button
                  type="button"
                  onClick={() => setEditMode('openvpn')}
                  className={`rounded-lg p-3 text-left border transition-all ${
                    editMode === 'openvpn'
                      ? 'border-purple-500 bg-purple-500/10 text-purple-300'
                      : 'border-border bg-surface hover:border-slate-600'
                  }`}
                >
                  <div className="font-mono font-bold text-sm flex items-center gap-1.5">
                    <Shield className="h-4 w-4" /> OpenVPN / Stealth TLS
                  </div>
                  <p className="text-xs text-muted mt-1">Camouflage porta 443 TLS contro Deep Packet Inspection.</p>
                </button>

                <button
                  type="button"
                  onClick={() => setEditMode('onion')}
                  className={`rounded-lg p-3 text-left border transition-all ${
                    editMode === 'onion'
                      ? 'border-amber-500 bg-amber-500/10 text-amber-300'
                      : 'border-border bg-surface hover:border-slate-600'
                  }`}
                >
                  <div className="font-mono font-bold text-sm flex items-center gap-1.5">
                    <Workflow className="h-4 w-4" /> Onion Multi-Hop
                  </div>
                  <p className="text-xs text-muted mt-1">Circuito anonimo a 3 salti con routing a cipolla.</p>
                </button>
              </div>
            </FormField>

            {/* DERP Relay Choice if in DERP mode */}
            {editMode === 'derp' && (
              <FormField label="Seleziona DERP Relay di Passaggio" htmlFor="select-derp">
                <Select
                  value={editRelay}
                  onChange={(val) => setEditRelay(val)}
                  options={[
                    { value: 'derp-eu', label: 'derp-eu (Francoforte, Germania - 8444/TCP 3478/UDP)' },
                    { value: 'derp-us', label: 'derp-us (New York, USA - 8445/TCP 3479/UDP)' }
                  ]}
                />
              </FormField>
            )}

            {/* Visibility / Zero-Trust Isolation Toggle */}
            <div className="rounded-lg bg-surface-raised p-4 border border-border">
              <div className="flex items-center justify-between">
                <div>
                  <h5 className="font-mono font-bold text-sm text-content flex items-center gap-2">
                    {editVisible ? <Eye className="h-4 w-4 text-emerald-400" /> : <EyeOff className="h-4 w-4 text-red-400" />}
                    Visibilità Reciproca nel Mesh
                  </h5>
                  <p className="text-xs text-muted mt-1">
                    {editVisible
                      ? 'I dispositivi sono visibili nella Netmap e autorizzati a scambiare traffico crittografato.'
                      : 'Isola i due dispositivi: le route vengono rimosse e la regola ACL DROP blocca ogni pacchetto.'}
                  </p>
                </div>
                <Switch
                  checked={editVisible}
                  onChange={(checked) => setEditVisible(checked)}
                  label="Visibilità"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-3 pt-3 border-t border-border">
              <Button variant="secondary" onClick={() => setLinkModalOpen(false)}>
                Annulla
              </Button>
              <Button
                variant="primary"
                onClick={handleSaveLink}
                loading={updateLinkMutation.isPending}
              >
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
                Salva Modifiche
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* Ghost Vault Unlock Dialog */}
      <Dialog
        isOpen={unlockDialogOpen}
        onClose={() => setUnlockDialogOpen(false)}
        title="Sblocca Ghost Vault Crittografici"
      >
        <form onSubmit={handleUnlockSubmit} className="space-y-4">
          <p className="text-sm text-muted">
            Inserisci la passphrase del compartimento per elevare la sessione a livello root e renderizzare i nodi invisibili.
          </p>
          <FormField label="Passphrase Compartimento Segreto" htmlFor="vault-password">
            <Input
              id="vault-password"
              type="password"
              value={vaultPassword}
              onChange={(e) => setVaultPassword(e.target.value)}
              placeholder="••••••••••••••••"
              autoFocus
            />
          </FormField>
          {unlockError && (
            <p className="text-xs text-danger font-mono">{unlockError}</p>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setUnlockDialogOpen(false)}>
              Annulla
            </Button>
            <Button variant="primary" type="submit" loading={unlockMutation.isPending}>
              Sblocca
            </Button>
          </div>
        </form>
      </Dialog>
    </PageFrame>
  );
}
