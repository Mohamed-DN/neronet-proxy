import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import {
  ShieldCheck,
  ShieldAlert,
  Sliders,
  Network,
  Plus,
  Trash2,
  CheckCircle2,
  Lock,
  ArrowRight,
  Battery,
  Clock,
  Globe2,
  Sparkles
} from 'lucide-react';

export default function SettingsACL() {
  const [rules, setRules] = useState([]);
  const [isAddingRule, setIsAddingRule] = useState(false);

  // New Rule Form
  const [priority, setPriority] = useState(50);
  // The form used to collect Tailscale-style selectors — tag:developers,
  // tag:cloud_pc, "8443/TCP (WebRTC)" — for an engine that matches on CIDRs and
  // numeric port ranges. Tags are not implemented anywhere in this system, so a
  // rule written that way could never match a packet. These are the fields the
  // engine actually evaluates.
  const [source, setSource] = useState('100.64.0.0/10');
  const [destination, setDestination] = useState('100.64.0.0/10');
  const [protocol, setProtocol] = useState('ALL');
  const [portStart, setPortStart] = useState(0);
  const [portEnd, setPortEnd] = useState(65535);
  const [action, setAction] = useState('ACCEPT');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState(null);
  const [policyIsOpen, setPolicyIsOpen] = useState(false);
  const [epoch, setEpoch] = useState(null);

  // Posture settings toggles
  const [batteryCutoff, setBatteryCutoff] = useState(true);
  const [dnsLeakGuard, setDnsLeakGuard] = useState(true);
  const [heartbeatTimeoutSec, setHeartbeatTimeoutSec] = useState(60);

  const loadRules = async () => {
    const res = await api.acl.list();
    setRules(res.rules);
    setPolicyIsOpen(res.policyIsOpen);
    setEpoch(res.epoch);
  };

  useEffect(() => {
    loadRules();
  }, []);

  const handleCreateRule = async (e) => {
    e.preventDefault();
    setFormError(null);

    try {
      await api.acl.create({
        priority: Number(priority),
        source_cidr: source,
        destination_cidr: destination,
        protocol,
        port_start: Number(portStart),
        port_end: Number(portEnd),
        action,
        description: description || `${action} ${protocol} from ${source} to ${destination}`
      });
      setIsAddingRule(false);
      setDescription('');
      await loadRules();
    } catch (err) {
      // A malformed CIDR is rejected by the engine. Showing the reason beats a
      // form that closes as though it had worked.
      setFormError(err?.message || 'The rule was rejected');
    }
  };

  const handleDeleteRule = async (id) => {
    try {
      await api.acl.delete(id);
      await loadRules();
    } catch (err) {
      setFormError(err?.message || 'The rule could not be deleted');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center space-x-2">
            <span>Zero-Trust ACL Rules & Network Policies</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-neon-emerald/20 text-neon-emerald border border-neon-emerald/40">
              Kernel WireGuard BPF Enforced
            </span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Declarative security access control matrix, regional subnet failover routes, and posture threshold safeguards.
          </p>
        </div>

        <button
          onClick={() => setIsAddingRule(true)}
          className="flex items-center space-x-2 px-4 py-2 rounded-lg bg-gradient-to-r from-neon-cyan to-neon-indigo text-dark-canvas font-bold font-mono text-xs hover:brightness-110 transition-all shadow-lg"
        >
          <Plus className="w-4 h-4" />
          <span>Add ACL Rule</span>
        </button>
      </div>

      {/* Visual ACL Rules Table */}
      <div className="rounded-xl bg-dark-card border border-dark-border overflow-hidden shadow-xl">
        <div className="p-4 border-b border-dark-border flex items-center justify-between">
          <div className="flex items-center space-x-2 font-bold text-slate-100 font-mono text-sm">
            <ShieldCheck className="w-4 h-4 text-neon-cyan" />
            <span>Active Access Control Matrix</span>
          </div>
          <span className="text-xs font-mono text-slate-500">{rules.length} Rules Enforced</span>
        </div>

        {policyIsOpen && (
          <div className="m-4 p-3 rounded-lg bg-neon-amber/10 border border-neon-amber/30 text-xs">
            <p className="text-neon-amber font-bold font-mono">No rule is defined — the mesh is open</p>
            <p className="text-slate-400 mt-1 leading-relaxed">
              Node enforcement is default-deny, so an empty policy delivered to the
              fleet would stop all traffic. The control plane compiles allow-all
              while this table is empty: every node may reach every other. Writing
              the first rule closes the mesh to everything it does not permit.
            </p>
          </div>
        )}

        {epoch !== null && (
          <div className="px-4 pt-3 text-[11px] font-mono text-slate-500 tabular-nums">
            Policy epoch {epoch} — nodes re-sync on their next heartbeat
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-dark-canvas text-slate-400 uppercase text-[10px] tracking-wider border-b border-dark-border">
              <tr>
                <th className="p-3.5">Priority</th>
                <th className="p-3.5">Source CIDR</th>
                <th className="p-3.5">Destination CIDR</th>
                <th className="p-3.5">Protocol &amp; Ports</th>
                <th className="p-3.5">Action Policy</th>
                <th className="p-3.5">Description</th>
                <th className="p-3.5 text-right">Delete</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-border">
              {rules.map((r) => (
                <tr key={r.id} className="hover:bg-dark-card-hover transition-colors">
                  <td className="p-3.5 font-bold text-slate-200">#{r.priority}</td>
                  <td className="p-3.5 text-neon-cyan font-bold">{r.source_cidr}</td>
                  <td className="p-3.5 text-neon-indigo font-bold">{r.destination_cidr}</td>
                  <td className="p-3.5 text-slate-300 tabular-nums">
                    {r.protocol}
                    {Number(r.port_start) === 0 && Number(r.port_end) === 65535
                      ? ' · all ports'
                      : ` · ${r.port_start}-${r.port_end}`}
                  </td>
                  <td className="p-3.5">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      r.action === 'ACCEPT'
                        ? 'bg-neon-emerald/20 text-neon-emerald border border-neon-emerald/40'
                        : 'bg-neon-rose/20 text-neon-rose border border-neon-rose/40'
                    }`}>
                      {r.action}
                    </span>
                  </td>
                  <td className="p-3.5 text-slate-400 max-w-xs truncate">{r.description}</td>
                  <td className="p-3.5 text-right">
                    <button
                      onClick={() => handleDeleteRule(r.id)}
                      className="p-1.5 rounded bg-dark-canvas border border-dark-border text-slate-400 hover:text-neon-rose transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Subnet Route Failover & Posture Policies Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Card 1: Subnet Route Failover */}
        <div className="p-5 rounded-2xl bg-dark-card border border-dark-border space-y-4 shadow-xl">
          <div className="flex items-center space-x-2 font-bold text-slate-100 font-mono text-sm">
            <Network className="w-4 h-4 text-neon-indigo" />
            <span>Subnet Route Failover Priority</span>
          </div>
          <p className="text-xs text-slate-400">
            Autonomous multi-path routing order if regional relay experiences packet loss &gt; 5%.
          </p>

          <div className="space-y-2 text-xs font-mono">
            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border flex items-center justify-between">
              <span className="text-slate-300">1. US-East (Ashburn IAD)</span>
              <span className="text-neon-emerald font-bold">PRIMARY (12ms)</span>
            </div>
            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border flex items-center justify-between">
              <span className="text-slate-300">2. EU-Central (Frankfurt FRA)</span>
              <span className="text-neon-cyan font-bold">SECONDARY (20ms)</span>
            </div>
            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border flex items-center justify-between">
              <span className="text-slate-300">3. AP-East (Tokyo TYO)</span>
              <span className="text-slate-500 font-bold">TERTIARY (38ms)</span>
            </div>
          </div>
        </div>

        {/* Card 2: Posture Engine Thresholds */}
        <div className="p-5 rounded-2xl bg-dark-card border border-dark-border space-y-4 shadow-xl">
          <div className="flex items-center space-x-2 font-bold text-slate-100 font-mono text-sm">
            <Sliders className="w-4 h-4 text-neon-emerald" />
            <span>Zero-Trust Posture Thresholds</span>
          </div>
          <p className="text-xs text-slate-400">
            Automated circuit shutdown and quarantine conditions for client devices.
          </p>

          <div className="space-y-3 text-xs font-mono">
            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border flex items-center justify-between">
              <div>
                <div className="text-slate-200 font-bold">Battery Cutoff (&lt; 20%)</div>
                <div className="text-[10px] text-slate-500">Disable exit node relaying on low battery</div>
              </div>
              <button
                onClick={() => setBatteryCutoff(!batteryCutoff)}
                className={`px-3 py-1 rounded text-xs font-bold border transition-all ${
                  batteryCutoff
                    ? 'bg-neon-emerald/20 text-neon-emerald border-neon-emerald/40'
                    : 'bg-dark-card text-slate-500 border-dark-border'
                }`}
              >
                {batteryCutoff ? 'ENABLED' : 'DISABLED'}
              </button>
            </div>

            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border flex items-center justify-between">
              <div>
                <div className="text-slate-200 font-bold">DNS Leak Guard</div>
                <div className="text-[10px] text-slate-500">Force overlay DNS (100.64.0.1) only</div>
              </div>
              <button
                onClick={() => setDnsLeakGuard(!dnsLeakGuard)}
                className={`px-3 py-1 rounded text-xs font-bold border transition-all ${
                  dnsLeakGuard
                    ? 'bg-neon-emerald/20 text-neon-emerald border-neon-emerald/40'
                    : 'bg-dark-card text-slate-500 border-dark-border'
                }`}
              >
                {dnsLeakGuard ? 'ENFORCED' : 'OFF'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Add Rule Modal */}
      {isAddingRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-dark-card border border-dark-border rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl p-6 space-y-4">
            <h2 className="text-base font-bold text-slate-100 font-mono flex items-center space-x-2">
              <Plus className="w-4 h-4 text-neon-cyan" />
              <span>Create Zero-Trust ACL Rule</span>
            </h2>

            <form onSubmit={handleCreateRule} className="space-y-4 text-xs font-mono">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Priority (1-100)</label>
                  <input
                    type="number"
                    value={priority}
                    onChange={(e) => setPriority(Number(e.target.value))}
                    className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded text-slate-100 focus:outline-none focus:border-neon-cyan"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Action</label>
                  <select
                    value={action}
                    onChange={(e) => setAction(e.target.value)}
                    className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded text-slate-100 focus:outline-none focus:border-neon-cyan"
                  >
                    <option value="ACCEPT">ACCEPT</option>
                    <option value="DROP">DROP</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Source CIDR</label>
                <input
                  type="text"
                  required
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="100.64.0.0/10"
                  className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded text-slate-100 focus:outline-none focus:border-neon-cyan"
                />
                <p className="text-[10px] text-slate-500 mt-1">
                  Overlay addresses. A single device is /32.
                </p>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Destination CIDR</label>
                <input
                  type="text"
                  required
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder="100.64.0.0/10"
                  className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded text-slate-100 focus:outline-none focus:border-neon-cyan"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Protocol</label>
                  <select
                    value={protocol}
                    onChange={(e) => setProtocol(e.target.value)}
                    className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded text-slate-100 focus:outline-none focus:border-neon-cyan"
                  >
                    <option value="ALL">ALL</option>
                    <option value="TCP">TCP</option>
                    <option value="UDP">UDP</option>
                    <option value="ICMP">ICMP</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Port from</label>
                  <input
                    type="number" min="0" max="65535" required
                    value={portStart}
                    onChange={(e) => setPortStart(e.target.value)}
                    className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded text-slate-100 tabular-nums focus:outline-none focus:border-neon-cyan"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Port to</label>
                  <input
                    type="number" min="0" max="65535" required
                    value={portEnd}
                    onChange={(e) => setPortEnd(e.target.value)}
                    className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded text-slate-100 tabular-nums focus:outline-none focus:border-neon-cyan"
                  />
                </div>
              </div>

              {formError && (
                <div className="p-2.5 rounded bg-neon-rose/10 border border-neon-rose/30 text-[11px] text-neon-rose">
                  {formError}
                </div>
              )}

              <div>
                <label className="block text-slate-400 mb-1">Rule Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional rationale"
                  className="w-full px-3 py-2 bg-dark-canvas border border-dark-border rounded text-slate-100 focus:outline-none focus:border-neon-cyan"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-3">
                <button
                  type="button"
                  onClick={() => setIsAddingRule(false)}
                  className="px-4 py-2 rounded bg-dark-border text-slate-300 text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded bg-gradient-to-r from-neon-cyan to-neon-indigo text-dark-canvas font-bold text-xs hover:brightness-110"
                >
                  Save Rule
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
