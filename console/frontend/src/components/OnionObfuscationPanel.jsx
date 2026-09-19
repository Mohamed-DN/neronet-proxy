import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import {
  Shield,
  Layers,
  Activity,
  Globe2,
  Lock,
  Unlock,
  Radio,
  Shuffle,
  Zap,
  Sliders,
  CheckCircle2,
  AlertTriangle,
  Server,
  ArrowRight,
  RefreshCw,
  Cpu
} from 'lucide-react';

export default function OnionObfuscationPanel() {
  const { role } = useAuth();
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);

  // Global Multi-Hop State
  // masterOnion, paddingMode, timingJitter and exitPolicy lived here. None of them
  // left this component: no request, no column, no delivery to a node, and every
  // selection was lost on reload. The controls that drove them are gone.
  const [killSwitchGlobal, setKillSwitchGlobal] = useState(true);

  const loadNodes = async () => {
    try {
      setLoading(true);
      const list = await api.nodes.list(role);
      setNodes(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error('Failed to load nodes for onion panel:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadNodes();
  }, [role]);

  const handleToggleNodeOnion = async (nodeId, currentEnabled) => {
    try {
      const newEnabled = !currentEnabled;
      await api.nodes.action(nodeId, 'toggle_onion', { enabled: newEnabled });
      setNodes((prev) =>
        prev.map((n) =>
          n.id === nodeId ? { ...n, onion_routing_enabled: newEnabled ? 1 : 0, onion_hops: newEnabled ? 3 : 0 } : n
        )
      );
    } catch (err) {
      console.error('Failed to toggle node onion routing:', err);
    }
  };

  const handleToggleNodeKillSwitch = async (nodeId, currentKill) => {
    try {
      const newKill = !currentKill;
      await api.nodes.action(nodeId, 'toggle_kill_switch', { enabled: newKill });
      setNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, kill_switch_enabled: newKill ? 1 : 0 } : n)));
    } catch (err) {
      console.error('Failed to toggle kill switch:', err);
    }
  };

  const onionEnabledCount = nodes.filter((n) => Boolean(n.onion_routing_enabled)).length;

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-content flex items-center space-x-2">
            <Shield className="w-5 h-5 text-accent animate-pulse" />
            <span>Onion Routing</span>
            {/* Badged "Sphinx Cryptographic Mixnet". pkg/routing implements layered
                encapsulation with a per-hop ephemeral key, not the Sphinx packet
                format, and there is no mixnet. */}
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-accent/20 text-accent border border-accent/40">
              XChaCha20-Poly1305, per-hop keys
            </span>
          </h1>
          <p className="text-xs text-muted mt-1">
            Which devices route their traffic through three hops before it leaves the mesh.
          </p>
        </div>

        {/* A "MASTER 3-HOP: ACTIVE / BYPASSED" switch stood here. It set React
            state and nothing else: no request, no column, no delivery to any node,
            and it reset on reload. Onion routing is per device, and the toggles in
            the inventory below are the ones that reach the fleet. */}
      </div>

      {/* Global Status HUD Cards */}
      {/* The state of this feature, stated once and plainly, because every number
          on this page is otherwise easy to read as "it is running".

          pkg/routing implements the layering: per-hop ephemeral keys, XChaCha20
          with a random nonce per layer, fixed 1420-byte cells, bounds-checked
          peeling, and it is covered by tests including a regression suite. It is
          imported by pkg/control — the Go control plane no compose file deploys —
          and by those tests. cmd/sovereign-node does not import it.

          The toggles below write onion_routing_enabled and onion_hops to the
          control plane. HeartbeatResponse carries no onion field, so no node is
          told, and no node would act on it if it were. */}
      <div className="p-3.5 rounded-xl bg-warning/10 border border-warning/30 flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
        <div className="text-xs">
          <p className="font-bold text-warning font-mono">Recorded, not yet routed</p>
          <p className="text-muted mt-1 leading-relaxed">
            The onion layering is implemented and tested in <code className="text-muted">pkg/routing</code>, but the
            node daemon does not import it and the heartbeat carries no onion field. Enabling a device here records the
            intent in the control plane; no traffic is carried through a circuit yet.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Active Circuits */}
        <div className="p-4 rounded-xl bg-surface-raised border border-border space-y-2 shadow-lg">
          <div className="flex items-center justify-between text-xs font-mono text-muted">
            <span>Onion Routing Enabled</span>
            <Layers className="w-4 h-4 text-accent" />
          </div>
          <div className="flex items-baseline space-x-2">
            {/* Was Math.max(onionEnabledCount * 3, 12), so a mesh with onion
                routing switched off everywhere still reported twelve circuits.
                Circuits are built on request and never stored, so there is no
                count of them; this is the figure the control plane does hold. */}
            <span className="text-2xl font-bold text-content font-mono tabular-nums">{onionEnabledCount}</span>
            <span className="text-xs text-subtle font-mono">of {nodes.length} devices</span>
          </div>
          <div className="text-[11px] font-mono text-success flex items-center space-x-1">
            <CheckCircle2 className="w-3 h-3" />
            <span>Three hops before egress</span>
          </div>
        </div>

        {/* Card 2: Padding Rate */}
        <div className="p-4 rounded-xl bg-surface-raised border border-border space-y-2 shadow-lg">
          <div className="flex items-center justify-between text-xs font-mono text-muted">
            <span>Cell Padding</span>
            <Zap className="w-4 h-4 text-accent" />
          </div>
          {/* This showed a selectable chaff rate — 64 or 256 KB/s. No traffic
              generator exists. What does exist is in pkg/routing/cell.go: every
              cell is encoded to exactly 1420 bytes and the remainder filled from
              the CSPRNG, so payload length is not observable. It is always on and
              has no setting. */}
          <div className="flex items-baseline space-x-2">
            <span className="text-2xl font-bold text-content font-mono tabular-nums">1420</span>
            <span className="text-xs text-muted font-mono">bytes, fixed</span>
          </div>
          <div className="text-[11px] font-mono text-muted">
            <span>Payload length not observable</span>
          </div>
        </div>

        {/* Card 3: Timing Jitter */}
        <div className="p-4 rounded-xl bg-surface-raised border border-border space-y-2 shadow-lg">
          <div className="flex items-center justify-between text-xs font-mono text-muted">
            <span>Timing Jitter</span>
            <Activity className="w-4 h-4 text-info" />
          </div>
          {/* Reported a "Gaussian packet burst shaping" profile. The jitter that
              exists, OnionCircuit.ComputeJitterDelay, draws a uniform delay from
              crypto/rand — not Gaussian — and the node daemon never calls it. */}
          <div className="flex items-baseline space-x-2">
            <span className="text-2xl font-bold text-muted font-mono">Not applied</span>
          </div>
          <div className="text-[11px] font-mono text-muted">
            <span>Implemented in pkg/routing, not called by the node</span>
          </div>
        </div>

        {/* Card 4: Mean Circuit Latency */}
        <div className="p-4 rounded-xl bg-surface-raised border border-border space-y-2 shadow-lg">
          <div className="flex items-center justify-between text-xs font-mono text-muted">
            <span>Exit Bridges Available</span>
            <Globe2 className="w-4 h-4 text-success" />
          </div>
          {/* Was "Mean 3-Hop Circuit Latency", 42.8ms when the master switch was on
              and 14.5ms when off — two constants, and nothing measures the latency
              of a circuit. This is the figure that decides whether a three-hop path
              can be built at all. */}
          <div className="flex items-baseline space-x-2">
            <span className="text-2xl font-bold text-success font-mono tabular-nums">
              {nodes.filter((n) => n.role === 'EXIT_BRIDGE').length}
            </span>
            <span className="text-xs text-muted font-mono">for the final hop</span>
          </div>
          <div className="text-[11px] font-mono text-muted">
            <span>Path diversity requires distinct operators</span>
          </div>
        </div>
      </div>

      {/* Multi-Hop Cryptographic Pipeline Visualizer */}
      <div className="p-5 rounded-2xl bg-surface-raised border border-border space-y-4 shadow-xl">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center space-x-2 text-xs font-mono text-content">
            <Shuffle className="w-4 h-4 text-accent" />
            {/* A schematic of how a path is layered, not a live circuit. The hops
                were labelled "Relay US-East", "Relay EU-Central" and "Exit
                FASTEST", which read as nodes that had been selected; no circuit is
                being displayed here. "Zero Information Leakage" was an unqualified
                guarantee — the property the design provides is that no single hop
                learns both ends. */}
            <span className="font-bold">How a three-hop path is layered</span>
          </div>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-border-strong/20 text-muted border border-border-strong/30">
            Schematic
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 py-2 text-center text-xs font-mono">
          {/* Hop 0: Client */}
          <div className="p-3.5 rounded-xl bg-surface border border-border space-y-1.5 flex flex-col items-center justify-center">
            <div className="w-8 h-8 rounded-lg bg-accent/20 text-accent border border-accent/40 flex items-center justify-center mb-1">
              <Server className="w-4 h-4" />
            </div>
            <div className="font-bold text-content">Client Node</div>
            <div className="text-[10px] text-muted">Encapsulates 3 Layers</div>
            <span className="text-[9px] px-1.5 py-0.2 rounded bg-accent text-accent border border-accent">
              Noise_IKpsk2
            </span>
          </div>

          {/* Hop 1: Entry Guard */}
          <div className="p-3.5 rounded-xl bg-surface border border-border space-y-1.5 flex flex-col items-center justify-center">
            <div className="w-8 h-8 rounded-lg bg-success/20 text-success border border-success/40 flex items-center justify-center mb-1">
              <Lock className="w-4 h-4" />
            </div>
            <div className="font-bold text-content">Entry Guard</div>
            <div className="text-[10px] text-muted">Peels Outer Layer (1)</div>
            <span className="text-[9px] px-1.5 py-0.2 rounded bg-success text-success border border-success">
              Hop 1
            </span>
          </div>

          {/* Hop 2: Middle Relay */}
          <div className="p-3.5 rounded-xl bg-surface border border-border space-y-1.5 flex flex-col items-center justify-center">
            <div className="w-8 h-8 rounded-lg bg-info/20 text-info border border-info/40 flex items-center justify-center mb-1">
              <Layers className="w-4 h-4" />
            </div>
            <div className="font-bold text-content">Middle Relay</div>
            <div className="text-[10px] text-muted">Peels Middle Layer (2)</div>
            <span className="text-[9px] px-1.5 py-0.2 rounded bg-info text-info border border-info">Hop 2</span>
          </div>

          {/* Hop 3: Exit Bridge */}
          <div className="p-3.5 rounded-xl bg-surface border border-border space-y-1.5 flex flex-col items-center justify-center">
            <div className="w-8 h-8 rounded-lg bg-info/20 text-info border border-info/40 flex items-center justify-center mb-1">
              <Globe2 className="w-4 h-4" />
            </div>
            <div className="font-bold text-content">Exit Bridge</div>
            <div className="text-[10px] text-muted">Peels Inner Layer (3)</div>
            <span className="text-[9px] px-1.5 py-0.2 rounded bg-info text-info border border-info">Hop 3</span>
          </div>

          {/* Hop 4: Destination */}
          <div className="p-3.5 rounded-xl bg-surface border border-border space-y-1.5 flex flex-col items-center justify-center">
            <div className="w-8 h-8 rounded-lg bg-warning/20 text-warning border border-warning/40 flex items-center justify-center mb-1">
              <Radio className="w-4 h-4" />
            </div>
            <div className="font-bold text-content">Target Service</div>
            <div className="text-[10px] text-muted">Sees Exit IP Only</div>
            <span className="text-[9px] px-1.5 py-0.2 rounded bg-warning text-warning border border-warning">
              Cleartext / TLS Target
            </span>
          </div>
        </div>
      </div>

      {/* A "Traffic Padding & Jitter Modulation" panel stood here, offering a
          constant-bitrate padding mode (disabled / subtle / CBR) and a jitter
          profile (direct / low / paranoid), alongside an exit policy selector.
          All three were React state. Nothing was persisted, no request was made,
          no node received them, and every selection was lost on reload.

          What the system does have: cells are padded to a fixed 1420 bytes in
          pkg/routing/cell.go, always, with no setting; and ComputeJitterDelay
          exists on OnionCircuit but the node daemon never calls it. Restoring
          these controls means delivering them the way ACLs are delivered — a
          column, an epoch, and a node that acts on the value. */}

      {/* Per-Node Routing Table with 1-Click Onion Toggles */}
      <div className="p-5 rounded-2xl bg-surface-raised border border-border space-y-4 shadow-xl font-mono text-xs">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div className="flex items-center space-x-2 text-content font-bold">
            <Server className="w-4 h-4 text-accent" />
            <span>Mesh Node Onion Routing Inventory ({nodes.length} Nodes)</span>
          </div>
          <button
            onClick={loadNodes}
            className="flex items-center space-x-1 text-muted hover:text-content transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>

        {nodes.length === 0 ? (
          <div className="py-8 text-center text-subtle">
            No active nodes enrolled. Enroll a node to configure onion routing.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-muted text-[11px] border-b border-border">
                  <th className="pb-2 font-semibold">Node Name</th>
                  <th className="pb-2 font-semibold">Overlay VIP</th>
                  <th className="pb-2 font-semibold">Role</th>
                  <th className="pb-2 font-semibold">Country</th>
                  <th className="pb-2 font-semibold">Onion Hops</th>
                  <th className="pb-2 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {nodes.map((node) => {
                  const isOnion = Boolean(node.onion_routing_enabled);
                  const isKill = Boolean(node.kill_switch_enabled);
                  return (
                    <tr key={node.id} className="hover:bg-surface/50 transition-colors">
                      <td className="py-2.5 font-bold text-content">{node.name || node.hostname}</td>
                      <td className="py-2.5 text-muted">{node.overlay_ipv4 || node.mesh_ip}</td>
                      <td className="py-2.5">
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-surface border border-border text-muted">
                          {node.role}
                        </span>
                      </td>
                      <td className="py-2.5 text-muted">{node.country_code || 'US'}</td>
                      <td className="py-2.5">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            isOnion
                              ? 'bg-success/20 text-success border border-success/40'
                              : 'bg-surface-raised text-muted border border-border'
                          }`}
                        >
                          {isOnion ? '3-Hop Active' : 'Direct'}
                        </span>
                      </td>
                      <td className="py-2.5 text-right space-x-2">
                        <button
                          onClick={() => handleToggleNodeOnion(node.id, isOnion)}
                          className={`px-2.5 py-1 rounded text-xs font-bold transition-all ${
                            isOnion
                              ? 'bg-success/20 text-success border border-success/40 hover:bg-success/30'
                              : 'bg-surface border border-border text-muted hover:text-content'
                          }`}
                        >
                          {isOnion ? 'Disable Onion' : 'Enable 3-Hop'}
                        </button>
                        <button
                          onClick={() => handleToggleNodeKillSwitch(node.id, isKill)}
                          className={`px-2.5 py-1 rounded text-xs font-bold transition-all ${
                            isKill
                              ? 'bg-danger/20 text-danger border border-danger/40'
                              : 'bg-surface border border-border text-subtle hover:text-muted'
                          }`}
                        >
                          {isKill ? 'Kill-Switch: ON' : 'Kill-Switch: OFF'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
