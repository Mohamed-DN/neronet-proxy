import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import {
  Globe2,
  Maximize2,
  Minimize2,
  RotateCcw,
  Play,
  Pause,
  ZoomIn,
  ZoomOut,
  Shield,
  UserCheck,
  Server,
  Activity,
  Layers,
  Search,
  Zap,
  Radio,
  Network,
  AlertTriangle,
  Flame,
  Info
} from 'lucide-react';

const geometryCache = new Map();
const materialCache = new Map();

function getCachedOctahedron(radius) {
  const key = `octa_${radius}`;
  if (!geometryCache.has(key)) {
    geometryCache.set(key, new THREE.OctahedronGeometry(radius, 0));
  }
  return geometryCache.get(key);
}

function getCachedSphere(radius) {
  const key = `sphere_${radius}`;
  if (!geometryCache.has(key)) {
    geometryCache.set(key, new THREE.SphereGeometry(radius, 8, 8));
  }
  return geometryCache.get(key);
}

function getCachedTorus(radius, tube) {
  const key = `torus_${radius}_${tube}`;
  if (!geometryCache.has(key)) {
    geometryCache.set(key, new THREE.TorusGeometry(radius, tube, 6, 12));
  }
  return geometryCache.get(key);
}

function getCachedPhongMaterial(colorHex) {
  if (!materialCache.has(colorHex)) {
    materialCache.set(
      colorHex,
      new THREE.MeshPhongMaterial({
        color: new THREE.Color(colorHex),
        emissive: new THREE.Color(colorHex),
        emissiveIntensity: 0.5,
        shininess: 90,
        transparent: true,
        opacity: 0.95
      })
    );
  }
  return materialCache.get(colorHex);
}

function getCachedBasicMaterial(colorHex, opacity = 0.25, wireframe = true) {
  const key = `basic_${colorHex}_${opacity}_${wireframe}`;
  if (!materialCache.has(key)) {
    materialCache.set(
      key,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(colorHex),
        transparent: true,
        opacity,
        wireframe
      })
    );
  }
  return materialCache.get(key);
}

export default function Topology3D({ onSelectNode }) {
  const { role } = useAuth();
  const [nodes, setNodes] = useState([]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRoleFilter, setSelectedRoleFilter] = useState('ALL');
  const [hoveredNode, setHoveredNode] = useState(null);
  const [autoRotate, setAutoRotate] = useState(true);

  const containerRef = useRef(null);
  const fgRef = useRef(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 580 });

  // Update container dimensions on resize
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth || 800,
          height: isFullscreen ? window.innerHeight - 120 : 580
        });
      }
    };

    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    return () => window.removeEventListener('resize', updateDimensions);
  }, [isFullscreen]);

  // Load nodes from API based on role
  const [meshLinks, setMeshLinks] = useState([]);
  const [policyIsOpen, setPolicyIsOpen] = useState(false);

  const loadNodes = useCallback(async () => {
    try {
      const [nodeList, topology] = await Promise.all([api.nodes.list(role), api.stats.getTopology()]);
      setNodes(Array.isArray(nodeList) ? nodeList : []);
      setMeshLinks(topology.links);
      setPolicyIsOpen(topology.policyIsOpen);
    } catch (err) {
      console.error('Failed to load topology nodes:', err);
    }
  }, [role]);

  useEffect(() => {
    loadNodes();
    const poll = setInterval(loadNodes, 30000);
    return () => clearInterval(poll);
  }, [loadNodes]);

  const isSuperAdmin = role === 'super-admin';

  // Build Graph Data (Nodes + Mesh Links)
  const graphData = useMemo(() => {
    if (!nodes.length) return { nodes: [], links: [] };

    const filtered = nodes.filter((n) => {
      const nodeName = n.name || n.hostname || '';
      const nodeIp = n.overlay_ipv4 || n.mesh_ip || '';
      const matchesSearch = nodeName.toLowerCase().includes(searchQuery.toLowerCase()) || nodeIp.includes(searchQuery);
      const matchesRole =
        selectedRoleFilter === 'ALL' ||
        (selectedRoleFilter === 'PEERED' && (n.is_peered || n.role === 'PEERED')) ||
        (selectedRoleFilter === 'QUARANTINED' && (n.is_quarantined || (n.risk_score || 0) > 75)) ||
        (selectedRoleFilter === 'CLIENT_ORIGIN' && (n.role === 'CLIENT_ORIGIN' || n.role === 'EDGE_CLIENT')) ||
        n.role === selectedRoleFilter;
      return matchesSearch && matchesRole;
    });

    const graphNodes = [];
    const graphLinks = [];

    // Node styling. Roles and state decide colour and size; nothing here invents a
    // node that does not exist.
    filtered.forEach((node) => {
      const isQuarantined = Boolean(node.is_quarantined || (node.risk_score || 0) > 75);
      const isPeered = Boolean(node.is_peered || node.role === 'PEERED');

      let nodeColor = '#38bdf8';
      let nodeVal = 7;

      if (isQuarantined) {
        nodeColor = '#ef4444';
        nodeVal = 9;
      } else if (isPeered) {
        nodeColor = '#a855f7';
        nodeVal = 8;
      } else if (node.role === 'RELAY') {
        nodeColor = '#10b981';
        nodeVal = 12;
      } else if (node.role === 'EXIT_BRIDGE') {
        nodeColor = '#6366f1';
        nodeVal = 9;
      } else if (node.role === 'HYBRID') {
        nodeColor = '#06b6d4';
        nodeVal = 8;
      }

      graphNodes.push({
        id: node.id,
        name: node.name || node.hostname || node.id,
        role: node.role === 'EDGE_CLIENT' ? 'CLIENT_ORIGIN' : node.role || 'CLIENT_ORIGIN',
        overlay_ipv4: node.overlay_ipv4 || node.mesh_ip || '',
        country_code: node.country_code,
        city: node.city,
        // Null rather than a stand-in: this node has not reported a round trip.
        latency_ms: Number(node.latency_ms) > 0 ? Number(node.latency_ms) : null,
        risk_score: node.risk_score || 0,
        is_quarantined: isQuarantined,
        is_peered: isPeered,
        val: nodeVal,
        color: nodeColor,
        rawNode: node
      });
    });

    // Edges come from the control plane, which compiles them from the ACL policy.
    //
    // They used to be generated here. Relays were joined in a full mesh that nobody
    // had configured, every other node was attached to relays[idx % relays.length]
    // and the result was labelled "nearest relay" though the choice was round-robin,
    // and a tenant who was not a super-admin had a relay invented for them outright
    // — id relay-iad-core, "neronet-relay-iad-01" in Ashburn, 100.64.0.1 — which
    // appeared in their topology as though they owned it.
    const presentIds = new Set(graphNodes.map((n) => n.id));

    meshLinks.forEach((link) => {
      // A link whose endpoints are not both on screen would resolve to undefined
      // inside the force layout and take the canvas down with it. Filters and
      // per-tenant scoping both produce this case.
      if (!presentIds.has(link.source) || !presentIds.has(link.target)) return;

      const a = graphNodes.find((n) => n.id === link.source);
      const b = graphNodes.find((n) => n.id === link.target);
      const degraded = a?.is_quarantined || b?.is_quarantined;

      graphLinks.push({
        source: link.source,
        target: link.target,
        color: degraded ? 'rgba(239, 68, 68, 0.35)' : 'rgba(56, 189, 248, 0.35)',
        curvature: 0.12,
        speed: 0.006
      });
    });

    let totalAllocatedParticles = 0;
    const maxGlobalParticles = 50;
    graphLinks.forEach((link) => {
      if (totalAllocatedParticles < maxGlobalParticles) {
        const canTake = Math.min(2, maxGlobalParticles - totalAllocatedParticles);
        link.particles = canTake;
        totalAllocatedParticles += canTake;
      } else {
        link.particles = 0;
      }
    });

    return { nodes: graphNodes, links: graphLinks };
  }, [nodes, meshLinks, searchQuery, selectedRoleFilter]);

  const handleNodeHover = useCallback((node) => {
    setHoveredNode(node || null);
    if (containerRef.current) {
      containerRef.current.style.cursor = node ? 'pointer' : 'default';
    }
  }, []);

  const handleNodeClick = useCallback(
    (graphNode) => {
      if (!graphNode) return;
      const matched = nodes.find((n) => n.id === graphNode.id);
      if (matched && onSelectNode) {
        onSelectNode(matched);
      } else if (graphNode.rawNode && onSelectNode) {
        onSelectNode(graphNode.rawNode);
      }
    },
    [nodes, onSelectNode]
  );

  const handleResetCamera = useCallback(() => {
    if (fgRef.current) {
      fgRef.current.cameraPosition({ x: 0, y: 0, z: 320 }, { x: 0, y: 0, z: 0 }, 1000);
    }
  }, []);

  useEffect(() => {
    if (fgRef.current) {
      try {
        fgRef.current.d3Force('charge')?.strength(-30);
        fgRef.current.d3VelocityDecay(0.3);
        fgRef.current.d3AlphaDecay(0.035);
      } catch (e) {}
    }
  }, [graphData]);

  useEffect(() => {
    if (fgRef.current) {
      try {
        const scene = fgRef.current.scene();
        if (scene && !scene.getObjectByName('neronet_starfield')) {
          const starCount = 400;
          const starGeo = new THREE.BufferGeometry();
          const positions = new Float32Array(starCount * 3);
          for (let i = 0; i < starCount * 3; i += 3) {
            positions[i] = (Math.random() - 0.5) * 1400;
            positions[i + 1] = (Math.random() - 0.5) * 1400;
            positions[i + 2] = (Math.random() - 0.5) * 1400;
          }
          starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          const starMat = new THREE.PointsMaterial({
            color: 0x64748b,
            size: 1.5,
            transparent: true,
            opacity: 0.55
          });
          const starfield = new THREE.Points(starGeo, starMat);
          starfield.name = 'neronet_starfield';
          scene.add(starfield);
        }
      } catch (e) {}
    }
  }, [dimensions]);

  const nodeThreeObject = useCallback((node) => {
    const group = new THREE.Group();
    const radius = node.role === 'RELAY' ? 5.5 : Math.max(3.5, node.val * 0.55);
    const geometry = node.role === 'RELAY' ? getCachedOctahedron(radius) : getCachedSphere(radius);
    const material = getCachedPhongMaterial(node.color);
    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);

    const haloGeometry = getCachedOctahedron(radius * 1.35);
    const haloMaterial = getCachedBasicMaterial(node.color, 0.22, true);
    const halo = new THREE.Mesh(haloGeometry, haloMaterial);
    group.add(halo);

    if (node.is_quarantined || (node.risk_score || 0) > 75) {
      const dangerGeometry = getCachedTorus(radius * 1.8, 0.5);
      const dangerMaterial = getCachedBasicMaterial('#ef4444', 0.85, false);
      const dangerRing = new THREE.Mesh(dangerGeometry, dangerMaterial);
      dangerRing.rotation.x = Math.PI / 2;
      group.add(dangerRing);
    }

    if (node.is_peered) {
      const peerGeometry = getCachedTorus(radius * 1.6, 0.4);
      const peerMaterial = getCachedBasicMaterial('#a855f7', 0.8, false);
      const peerRing = new THREE.Mesh(peerGeometry, peerMaterial);
      peerRing.rotation.y = Math.PI / 3;
      group.add(peerRing);
    }

    return group;
  }, []);

  return (
    <div className={`space-y-4 ${isFullscreen ? 'fixed inset-0 z-50 bg-surface p-6' : ''}`}>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-content flex items-center space-x-2">
            <Globe2 className="w-5 h-5 text-accent animate-pulse" />
            <span>Interactive 3D Spiderweb Topology</span>
          </h1>
        </div>
        <div className="flex items-center space-x-2">
          <input
            type="text"
            placeholder="Filter node or VIP..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="px-3 py-1.5 text-xs bg-surface-raised border border-border rounded-lg text-content placeholder-subtle focus:outline-none w-44 sm:w-56"
          />
          <button
            onClick={() => setIsFullscreen(!isFullscreen)}
            className="p-2 rounded-lg bg-surface-raised border border-border text-muted"
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative w-full h-[580px] rounded-2xl bg-surface border border-border overflow-hidden shadow-2xl"
      >
        <ForceGraph3D
          ref={fgRef}
          width={dimensions.width}
          height={dimensions.height}
          graphData={graphData}
          backgroundColor="#030712"
          showNavInfo={false}
          nodeThreeObject={nodeThreeObject}
          nodeLabel={(node) => `${node.name || node.hostname || node.id}`}
          onNodeHover={handleNodeHover}
          onNodeClick={handleNodeClick}
          linkWidth={0.8}
          linkColor={(link) => link.color}
          linkCurvature={(link) => link.curvature || 0}
          linkDirectionalParticles={(link) => link.particles || 0}
          linkDirectionalParticleSpeed={(link) => link.speed || 0.005}
          linkDirectionalParticleWidth={1.8}
          linkDirectionalParticleColor={(link) => link.color}
          enableNodeDrag={true}
          enableNavigationControls={true}
          controlType="orbit"
        />

        <div className="absolute top-4 left-4 p-3.5 rounded-xl bg-surface-raised/90 border border-border/80 backdrop-blur-md text-xs font-mono shadow-xl pointer-events-none">
          <div className="flex items-center space-x-2 text-content font-bold">
            <Layers className="w-4 h-4 text-accent" />
            <span>{isSuperAdmin ? 'SCOPE: GLOBAL MESH' : 'SCOPE: TENANT ISOLATED'}</span>
          </div>
          {/* With no ACL rule written, the control plane compiles allow-all: every
              node may reach every other. The full mesh on screen is then the absence
              of a policy, not a policy, and the distinction matters enough to name. */}
          {policyIsOpen && (
            <div className="mt-1.5 px-2 py-1 rounded bg-warning/15 border border-warning/40 text-[10px] text-warning leading-snug max-w-[15rem]">
              No ACL rule is defined, so every node may reach every other. These edges are the default, not a configured
              policy.
            </div>
          )}
          <div className="text-[11px] text-muted space-y-0.5 pt-1">
            <div className="flex justify-between space-x-4">
              <span>Rendered Nodes:</span>
              <strong className="text-white">{graphData.nodes.length}</strong>
            </div>
            {/* These are the paths the policy permits, not circuits. A circuit is
                built on request through chosen hops and is not held anywhere the
                console can count. */}
            <div className="flex justify-between space-x-4">
              <span>Permitted Paths:</span>
              <strong className="text-accent">{graphData.links.length}</strong>
            </div>
            <div className="flex justify-between space-x-4">
              <span>Engine:</span>
              <strong className="text-success">Three.js WebGL Force-3D</strong>
            </div>
          </div>
        </div>

        {/* HUD Top Right: Controls */}
        <div className="absolute top-4 right-4 flex items-center space-x-1.5 p-1.5 rounded-xl bg-surface-raised/90 border border-border/80 backdrop-blur-md shadow-xl">
          <button
            onClick={() => {
              if (fgRef.current) {
                const controls = fgRef.current.controls();
                if (controls) {
                  controls.autoRotate = !autoRotate;
                  setAutoRotate(!autoRotate);
                }
              }
            }}
            className={`p-2 rounded-lg text-xs font-mono transition-all ${
              autoRotate ? 'bg-accent/20 text-accent border border-accent/40' : 'text-muted hover:text-white'
            }`}
            title="Toggle Auto-Rotation"
          >
            {autoRotate ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={handleResetCamera}
            className="p-2 rounded-lg text-muted hover:text-white text-xs hover:bg-border/60 transition-colors"
            title="Reset Perspective"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* HUD Bottom Left: Color Legend */}
        <div className="absolute bottom-4 left-4 p-3 rounded-xl bg-surface-raised/90 border border-border/80 backdrop-blur-md text-[11px] font-mono space-y-1.5 pointer-events-none shadow-xl">
          <div className="text-muted font-bold mb-1 flex items-center space-x-1.5">
            <Info className="w-3 h-3 text-muted" />
            <span>3D Topology Legend</span>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <div className="flex items-center space-x-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-success"></span>
              <span className="text-muted">Regional Relay</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-info"></span>
              <span className="text-muted">Exit Gateway</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-accent"></span>
              <span className="text-muted">Client Device</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-info"></span>
              <span className="text-info font-semibold">Peered Node</span>
            </div>
            <div className="flex items-center space-x-1.5 col-span-2">
              <span className="w-2.5 h-2.5 rounded-full bg-danger animate-ping"></span>
              <span className="text-danger font-semibold">Risk &gt; 75 / Quarantined</span>
            </div>
          </div>
        </div>

        {/* Hover Tooltip HUD */}
        {hoveredNode && (
          <div className="absolute bottom-4 right-4 p-4 rounded-xl bg-surface-raised/95 border border-accent/50 backdrop-blur-md text-xs font-mono shadow-2xl pointer-events-none min-w-[250px] animate-in fade-in duration-100">
            <div className="flex items-center justify-between border-b border-border pb-1.5 mb-2">
              <span className="font-bold text-content">{hoveredNode.name}</span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded border ${
                  hoveredNode.is_quarantined
                    ? 'bg-danger/20 text-danger border-danger/40'
                    : hoveredNode.is_peered
                      ? 'bg-info/20 text-info border-info/40'
                      : 'bg-accent/20 text-accent border-accent/40'
                }`}
              >
                {hoveredNode.is_peered ? 'PEERED' : hoveredNode.role}
              </span>
            </div>
            <div className="space-y-1 text-[11px] text-muted">
              <div className="flex justify-between">
                <span>Overlay IPv4:</span>
                <span className="text-content">{hoveredNode.overlay_ipv4}</span>
              </div>
              <div className="flex justify-between">
                <span>Location:</span>
                <span className="text-content">
                  {hoveredNode.country_code} ({hoveredNode.city || 'Regional'})
                </span>
              </div>
              <div className="flex justify-between">
                <span>Wire Latency:</span>
                <span className="text-success font-bold">{hoveredNode.latency_ms} ms</span>
              </div>
              <div className="flex justify-between">
                <span>Behavioral Risk:</span>
                <span
                  className={
                    (hoveredNode.risk_score || 0) > 75
                      ? 'text-danger font-bold'
                      : (hoveredNode.risk_score || 0) >= 40
                        ? 'text-warning font-bold'
                        : 'text-success'
                  }
                >
                  {hoveredNode.risk_score || 0} / 100
                </span>
              </div>
              {/* This said "Compliant" for any node that was not quarantined, which
                  is the absence of an enforcement action, not a measurement. */}
              <div className="flex justify-between">
                <span>Posture:</span>
                <span
                  className={
                    hoveredNode.posture_status === 'verified_compliant'
                      ? 'text-success'
                      : hoveredNode.posture_status === 'non_compliant'
                        ? 'text-danger font-bold'
                        : 'text-muted'
                  }
                >
                  {hoveredNode.posture_status === 'verified_compliant'
                    ? 'VERIFIED COMPLIANT'
                    : hoveredNode.posture_status === 'non_compliant'
                      ? 'NON-COMPLIANT'
                      : 'UNVERIFIED'}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Quarantine:</span>
                <span className={hoveredNode.is_quarantined ? 'text-danger font-bold' : 'text-muted'}>
                  {hoveredNode.is_quarantined ? 'QUARANTINED (100.64.250.0/24)' : 'None'}
                </span>
              </div>
            </div>
            <div className="mt-2.5 pt-2 border-t border-border text-[10px] text-accent font-bold text-center">
              Click Node to Open Action Drawer &rarr;
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
