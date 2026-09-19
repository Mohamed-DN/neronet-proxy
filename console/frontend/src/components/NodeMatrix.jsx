import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import {
  Server,
  Search,
  Filter,
  Activity,
  Shield,
  ShieldCheck,
  ShieldAlert,
  Battery,
  BatteryCharging,
  Cpu,
  Radio,
  Compass,
  Copy,
  Check,
  MoreVertical,
  SlidersHorizontal,
  LayoutGrid,
  List,
  Sparkles,
  Smartphone,
  Laptop,
  Terminal,
  Monitor
} from 'lucide-react';

export default function NodeMatrix({ onSelectNode, onOpenEnrollModal }) {
  const { role } = useAuth();
  const [nodes, setNodes] = useState([]);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('ALL');
  const [postureFilter, setPostureFilter] = useState('ALL');
  const [viewMode, setViewMode] = useState('table'); // 'table' | 'grid'
  const [copiedVip, setCopiedVip] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadNodes() {
      try {
        const list = await api.nodes.list(role);
        setNodes(list);
      } catch (err) {
        console.error('Failed to load nodes:', err);
      } finally {
        setLoading(false);
      }
    }
    loadNodes();
  }, [role]);

  const handleCopyVip = (vip) => {
    navigator.clipboard.writeText(vip);
    setCopiedVip(vip);
    setTimeout(() => setCopiedVip(null), 2000);
  };

  const filteredNodes = nodes.filter((n) => {
    const nodeName = n.name || n.hostname || '';
    const nodeIp = n.overlay_ipv4 || n.mesh_ip || '';
    const nodeCountry = n.country_code || '';

    const matchesSearch =
      nodeName.toLowerCase().includes(search.toLowerCase()) ||
      nodeIp.includes(search) ||
      nodeCountry.toLowerCase().includes(search.toLowerCase());

    const matchesRole =
      roleFilter === 'ALL' ||
      n.role === roleFilter ||
      (roleFilter === 'CLIENT_ORIGIN' && (n.role === 'CLIENT_ORIGIN' || n.role === 'EDGE_CLIENT'));

    const isQuarantined = Boolean(n.is_quarantined);
    const isHealthy = Boolean(n.is_healthy !== undefined ? n.is_healthy : n.status === 'active') && !isQuarantined;

    const matchesPosture =
      postureFilter === 'ALL' ||
      (postureFilter === 'HEALTHY' && isHealthy) ||
      (postureFilter === 'DEGRADED' && !isHealthy && !isQuarantined) ||
      (postureFilter === 'QUARANTINED' && isQuarantined);

    return matchesSearch && matchesRole && matchesPosture;
  });

  // Posture has three states and the console must be able to say "we do not know".
  // Anything the API does not classify is treated as unverified, never as passing.
  const postureLabel = (status) => {
    switch (status) {
      case 'verified_compliant':
        return 'Verified compliant';
      case 'non_compliant':
        return 'Non-compliant';
      default:
        return 'Unverified';
    }
  };

  const postureColour = (status) => {
    switch (status) {
      case 'verified_compliant':
        return 'text-neon-emerald';
      case 'non_compliant':
        return 'text-neon-rose font-bold';
      default:
        return 'text-slate-400';
    }
  };

  const postureIcon = (status) => {
    switch (status) {
      case 'verified_compliant':
        return <ShieldCheck className="w-3.5 h-3.5 text-neon-emerald" />;
      case 'non_compliant':
        return <ShieldAlert className="w-3.5 h-3.5 text-neon-rose" />;
      default:
        return <Shield className="w-3.5 h-3.5 text-slate-500" />;
    }
  };

  const getPlatformIcon = (os) => {
    switch (os) {
      case 'macos':
      case 'ios':
        return <Laptop className="w-3.5 h-3.5 text-slate-300" />;
      case 'android':
        return <Smartphone className="w-3.5 h-3.5 text-neon-emerald" />;
      case 'windows':
        return <Monitor className="w-3.5 h-3.5 text-neon-cyan" />;
      case 'linux':
      default:
        return <Terminal className="w-3.5 h-3.5 text-neon-indigo" />;
    }
  };

  if (!loading && nodes.length === 0) {
    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-100 flex items-center space-x-2.5">
              <span>Mesh Node Matrix</span>
              <span className="text-xs font-mono px-2 py-0.5 rounded bg-dark-border text-slate-400">0 Total</span>
            </h1>
            <p className="text-xs text-slate-400 mt-1 font-mono">
              Cryptographic device inventory, posture verification, and Noise tunnel endpoints.
            </p>
          </div>
          <button
            onClick={onOpenEnrollModal}
            className="flex items-center space-x-2 px-4 py-2 rounded-xl bg-accent-primary hover:bg-sky-400 text-slate-950 font-bold text-xs shadow-lg shadow-sky-500/20 transition-all font-mono cursor-pointer"
          >
            <Sparkles className="w-4 h-4" />
            <span>+ Enroll Node</span>
          </button>
        </div>

        {/* Cyber Empty State */}
        <div className="p-12 rounded-2xl bg-dark-card border border-dark-border flex flex-col items-center justify-center text-center space-y-4 shadow-xl">
          <div className="w-16 h-16 rounded-2xl bg-dark-canvas border border-dark-border flex items-center justify-center text-accent-primary glow-sky shadow-lg">
            <Server className="w-8 h-8 text-accent-primary" />
          </div>
          <div className="max-w-md space-y-2">
            <h3 className="text-base font-bold text-slate-100 font-mono">No mesh nodes registered yet</h3>
            <p className="text-xs text-slate-400 font-sans leading-relaxed">
              No active nodes found in this mesh workspace. Click '+ Enroll Node' to generate a cryptographic Noise
              profile or scan an onboarding QR code.
            </p>
          </div>
          <button
            onClick={onOpenEnrollModal}
            className="mt-2 flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-accent-primary hover:bg-sky-400 text-slate-950 font-bold text-xs shadow-lg shadow-sky-500/25 transition-all font-mono cursor-pointer"
          >
            <Sparkles className="w-4 h-4" />
            <span>+ Enroll Node</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Top Header & Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center space-x-2">
            <span>Sovereign Node Matrix & Posture Inventory</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/40">
              {filteredNodes.length} Devices Registered
            </span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Zero-Trust verified nodes with real-time heartbeat telemetry, overlay VIP assignments, and cryptographic
            posture.
          </p>
        </div>

        {/* View mode toggle & Enroll Button */}
        <div className="flex items-center space-x-2">
          <div className="flex items-center bg-dark-card border border-dark-border rounded-lg p-1">
            <button
              onClick={() => setViewMode('table')}
              className={`p-1.5 rounded transition-all ${
                viewMode === 'table'
                  ? 'bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/40'
                  : 'text-slate-400 hover:text-white'
              }`}
              title="Table View"
            >
              <List className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded transition-all ${
                viewMode === 'grid'
                  ? 'bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/40'
                  : 'text-slate-400 hover:text-white'
              }`}
              title="Grid View"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={onOpenEnrollModal}
            className="px-3 py-1.5 rounded-lg bg-gradient-to-r from-neon-cyan to-neon-indigo text-dark-canvas text-xs font-bold font-mono hover:brightness-110 transition-all shadow-lg"
          >
            + Enroll Node
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="p-3 rounded-xl bg-dark-card border border-dark-border flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
        <div className="flex items-center space-x-2 flex-1 min-w-[200px]">
          <div className="relative w-full max-w-sm">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search hostname, VIP 100.64.0.x, country..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-dark-canvas border border-dark-border rounded-lg text-slate-200 placeholder-slate-500 focus:outline-none focus:border-neon-cyan font-mono text-xs"
            />
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-1.5">
            <span className="text-slate-500">Role:</span>
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className="px-2 py-1 bg-dark-canvas border border-dark-border rounded text-slate-200 focus:outline-none focus:border-neon-cyan text-xs"
            >
              <option value="ALL">All Roles</option>
              <option value="CLIENT_ORIGIN">Client Origin</option>
              <option value="EXIT_BRIDGE">Exit Bridge</option>
              <option value="HYBRID">Hybrid Node</option>
              <option value="RELAY">Regional Relay</option>
            </select>
          </div>

          <div className="flex items-center space-x-1.5">
            {/* This filter selects on liveness, not on posture. It is labelled for
                what it does. */}
            <span className="text-slate-500">Reachability:</span>
            <select
              value={postureFilter}
              onChange={(e) => setPostureFilter(e.target.value)}
              className="px-2 py-1 bg-dark-canvas border border-dark-border rounded text-slate-200 focus:outline-none focus:border-neon-cyan text-xs"
            >
              <option value="ALL">All States</option>
              <option value="HEALTHY">Reachable</option>
              <option value="DEGRADED">Not answering</option>
              <option value="QUARANTINED">Quarantined</option>
            </select>
          </div>
        </div>
      </div>

      {/* View: Table View */}
      {viewMode === 'table' ? (
        <div className="rounded-xl bg-dark-card border border-dark-border overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-dark-canvas/80 text-slate-400 uppercase text-[10px] tracking-wider border-b border-dark-border">
                <tr>
                  <th className="p-3.5">Device / Node Name</th>
                  <th className="p-3.5">Overlay VIPs</th>
                  <th className="p-3.5">Role & Class</th>
                  <th className="p-3.5">Posture / Reachability</th>
                  <th className="p-3.5">RTT Latency</th>
                  <th className="p-3.5">Telemetry (CPU/RAM/Bat)</th>
                  <th className="p-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-border">
                {filteredNodes.map((n) => {
                  const isQuarantined = !!n.is_quarantined;
                  const isHealthy = n.is_healthy && !isQuarantined;
                  return (
                    <tr
                      key={n.id}
                      onClick={() => onSelectNode && onSelectNode(n)}
                      className="hover:bg-dark-card-hover cursor-pointer transition-colors group"
                    >
                      {/* Name & OS */}
                      <td className="p-3.5">
                        <div className="flex items-center space-x-2.5">
                          <div className="p-1.5 rounded-lg bg-dark-canvas border border-dark-border">
                            {getPlatformIcon(n.os_type)}
                          </div>
                          <div>
                            <div className="font-bold text-slate-100 group-hover:text-neon-cyan transition-colors">
                              {n.name}
                            </div>
                            <div className="text-[10px] text-slate-500">
                              {n.country_code} ({n.city || 'Regional'}) &bull; ASN {n.asn || 0}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* VIPs */}
                      <td className="p-3.5">
                        <div className="flex items-center space-x-1.5">
                          <span className="text-neon-cyan font-bold">{n.overlay_ipv4}</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopyVip(n.overlay_ipv4);
                            }}
                            className="p-1 text-slate-500 hover:text-white"
                          >
                            {copiedVip === n.overlay_ipv4 ? (
                              <Check className="w-3 h-3 text-neon-emerald" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                        <div className="text-[10px] text-slate-500 truncate max-w-[140px]">{n.overlay_ipv6}</div>
                      </td>

                      {/* Role & Class */}
                      <td className="p-3.5">
                        <div className="flex flex-col space-y-1">
                          <div className="flex items-center space-x-1.5">
                            <span
                              className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold w-max ${
                                n.role === 'RELAY'
                                  ? 'bg-neon-emerald/20 text-neon-emerald border border-neon-emerald/40'
                                  : n.role === 'EXIT_BRIDGE'
                                    ? 'bg-neon-indigo/20 text-neon-indigo border border-neon-indigo/40'
                                    : n.role === 'HYBRID'
                                      ? 'bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/40'
                                      : 'bg-dark-canvas text-slate-300 border border-dark-border'
                              }`}
                            >
                              {n.role}
                            </span>
                            {Boolean(n.onion_routing_enabled || n.onion_hops > 0) ? (
                              <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/30">
                                3-Hop Onion
                              </span>
                            ) : (
                              <span className="inline-block px-1.5 py-0.5 rounded text-[9px] text-slate-500 bg-dark-canvas border border-dark-border">
                                Direct
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] text-slate-500">{n.ip_class}</span>
                        </div>
                      </td>

                      {/* Posture and reachability. This column used to say "Compliant"
                          for any node that was simply answering, which is a liveness
                          reading wearing a compliance label. The two are now shown as
                          the separate facts they are. */}
                      <td className="p-3.5">
                        <div className="flex items-center space-x-1.5">
                          {postureIcon(n.posture_status)}
                          <span className={postureColour(n.posture_status)}>{postureLabel(n.posture_status)}</span>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          {isQuarantined ? 'Quarantined' : isHealthy ? 'Reachable' : 'Not answering'}
                        </div>
                      </td>

                      {/* Latency */}
                      <td className="p-3.5">
                        <span
                          className={`font-bold ${
                            n.latency_ms < 30
                              ? 'text-neon-emerald'
                              : n.latency_ms < 100
                                ? 'text-neon-amber'
                                : 'text-neon-rose'
                          }`}
                        >
                          {n.latency_ms} ms
                        </span>
                      </td>

                      {/* Telemetry */}
                      <td className="p-3.5">
                        <div className="flex items-center space-x-3 text-[11px] text-slate-400">
                          {/* Nothing on a node samples CPU yet; the wire value 0
                              means "not measured", and printing it as 0% claimed an
                              idle host. */}
                          <span title="CPU Usage">CPU: {n.cpu_usage_pct ? `${n.cpu_usage_pct}%` : 'not measured'}</span>
                          <span title="RAM Usage">RAM: {n.memory_usage_pct || 0}%</span>
                          <span className="flex items-center space-x-1 text-slate-300" title="Battery">
                            {n.battery_pct === 100 ? (
                              <BatteryCharging className="w-3.5 h-3.5 text-neon-emerald" />
                            ) : (
                              <Battery className="w-3.5 h-3.5" />
                            )}
                            <span>{n.battery_pct || 100}%</span>
                          </span>
                        </div>
                      </td>

                      {/* Action Button */}
                      <td className="p-3.5 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (onSelectNode) onSelectNode(n);
                          }}
                          className="px-2.5 py-1 rounded bg-dark-canvas border border-dark-border text-slate-300 hover:text-neon-cyan hover:border-neon-cyan/40 text-xs transition-colors"
                        >
                          Manage &rarr;
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* View: Card Grid */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredNodes.map((n) => {
            const isQuarantined = !!n.is_quarantined;
            const isOnion = Boolean(n.onion_routing_enabled || n.onion_hops > 0);
            return (
              <div
                key={n.id}
                onClick={() => onSelectNode && onSelectNode(n)}
                className={`p-4 rounded-xl bg-dark-card border cursor-pointer transition-all hover:scale-[1.01] shadow-lg ${
                  isQuarantined
                    ? 'border-neon-rose/40 hover:border-neon-rose'
                    : 'border-dark-border hover:border-neon-cyan/40'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center space-x-2.5">
                    <div className="p-2 rounded-lg bg-dark-canvas border border-dark-border">
                      {getPlatformIcon(n.os_type)}
                    </div>
                    <div>
                      <div className="font-bold text-sm text-slate-100">{n.name}</div>
                      <div className="text-[10px] font-mono text-slate-500">
                        {n.country_code} &bull; {n.overlay_ipv4}
                      </div>
                    </div>
                  </div>
                  <span
                    className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold ${
                      isQuarantined ? 'bg-neon-rose/20 text-neon-rose' : 'bg-neon-emerald/20 text-neon-emerald'
                    }`}
                  >
                    {isQuarantined ? 'ISOLATED' : `${n.latency_ms}ms`}
                  </span>
                </div>

                <div className="mt-4 pt-3 border-t border-dark-border/80 flex items-center justify-between text-xs font-mono text-slate-400">
                  <div className="flex items-center space-x-1.5">
                    <span>
                      Role: <strong className="text-slate-200">{n.role}</strong>
                    </span>
                    {isOnion && (
                      <span className="px-1 py-0.2 rounded text-[9px] bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/30">
                        Onion
                      </span>
                    )}
                  </div>
                  <span>Battery: {n.battery_pct}%</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
