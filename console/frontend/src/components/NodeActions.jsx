import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import {
  X,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Compass,
  Zap,
  Activity,
  Server,
  Lock,
  Unlock,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  RotateCw,
  Copy,
  Check,
  Send,
  PowerOff,
  Flame,
  Globe,
  Sliders
} from 'lucide-react';

export default function NodeActions({ node, isOpen, onClose, onNodeUpdated, onNodeRevoked, onNavigateTab }) {
  const [currentNode, setCurrentNode] = useState(node);
  const [pingHistory, setPingHistory] = useState([]);
  const [isPinging, setIsPinging] = useState(false);
  const [pingStats, setPingStats] = useState(null);
  const [isUpdatingExit, setIsUpdatingExit] = useState(false);
  const [isTogglingOnion, setIsTogglingOnion] = useState(false);
  const [isTogglingKillSwitch, setIsTogglingKillSwitch] = useState(false);
  const [isQuarantining, setIsQuarantining] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  useEffect(() => {
    setCurrentNode(node);
    setPingHistory([]);
    setPingStats(null);
  }, [node]);

  if (!isOpen || !currentNode) return null;

  const handlePing = async () => {
    setIsPinging(true);
    try {
      const res = await api.nodes.action(currentNode.id, 'ping');
      if (res && res.result) {
        const newPing = {
          seq: pingHistory.length + 1,
          rtt: res.result.rtt_ms,
          jitter: res.result.jitter_ms,
          timestamp: new Date().toLocaleTimeString()
        };
        const updatedHistory = [...pingHistory.slice(-9), newPing];
        setPingHistory(updatedHistory);
        setPingStats(res.result);
      }
    } catch (err) {
      console.error('Ping failed:', err);
    } finally {
      setIsPinging(false);
    }
  };

  const handleToggleExit = async () => {
    setIsUpdatingExit(true);
    try {
      const res = await api.nodes.action(currentNode.id, 'set_exit');
      if (res && res.node) {
        setCurrentNode(res.node);
        if (onNodeUpdated) onNodeUpdated(res.node);
      }
    } catch (err) {
      console.error('Exit toggle failed:', err);
    } finally {
      setIsUpdatingExit(false);
    }
  };

  const handleToggleOnion = async () => {
    setIsTogglingOnion(true);
    try {
      const res = await api.nodes.action(currentNode.id, 'toggle_onion');
      if (res && res.node) {
        setCurrentNode(res.node);
        if (onNodeUpdated) onNodeUpdated(res.node);
      }
    } catch (err) {
      console.error('Onion toggle failed:', err);
    } finally {
      setIsTogglingOnion(false);
    }
  };

  const handleToggleKillSwitch = async () => {
    setIsTogglingKillSwitch(true);
    try {
      const res = await api.nodes.action(currentNode.id, 'toggle_kill_switch');
      if (res && res.node) {
        setCurrentNode(res.node);
        if (onNodeUpdated) onNodeUpdated(res.node);
      }
    } catch (err) {
      console.error('Kill switch toggle failed:', err);
    } finally {
      setIsTogglingKillSwitch(false);
    }
  };

  const handleToggleQuarantine = async () => {
    setIsQuarantining(true);
    try {
      const actionType = currentNode.is_quarantined ? 'lift_quarantine' : 'quarantine';
      const res = await api.nodes.action(currentNode.id, actionType, {
        reason: 'Zero-Trust quarantine isolation: reassigned to 100.64.250.0/24 subnet'
      });
      if (res && res.node) {
        setCurrentNode(res.node);
        if (onNodeUpdated) onNodeUpdated(res.node);
      }
    } catch (err) {
      console.error('Quarantine action failed:', err);
    } finally {
      setIsQuarantining(false);
    }
  };

  const handleRevoke = async () => {
    if (window.confirm(`Are you sure you want to permanently revoke node "${currentNode.name}" from the mesh?`)) {
      await api.nodes.action(currentNode.id, 'revoke');
      if (onNodeRevoked) onNodeRevoked(currentNode.id);
      onClose();
    }
  };

  const handleCopyKey = (key) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  const isExitNode = currentNode.role === 'EXIT_BRIDGE';
  const isOnionEnabled = Boolean(currentNode.onion_routing_enabled || (currentNode.onion_hops || 0) > 0);
  const isKillSwitchEnabled = Boolean(currentNode.kill_switch_enabled);
  const isQuarantined = Boolean(currentNode.is_quarantined);
  const riskScore = currentNode.risk_score || (isQuarantined ? 85 : 12);

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-black/60 backdrop-blur-xs flex justify-end animate-in fade-in duration-150">
      <div className="w-full max-w-lg bg-dark-card border-l border-dark-border h-full flex flex-col shadow-2xl overflow-y-auto">
        {/* Drawer Header */}
        <div className="p-5 border-b border-dark-border flex items-center justify-between bg-dark-canvas/70 sticky top-0 z-10 backdrop-blur-md">
          <div className="flex items-center space-x-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center border ${
                isQuarantined
                  ? 'bg-red-500/10 border-red-500/40 text-red-400 glow-red'
                  : 'bg-accent-primary/10 border-accent-primary/40 text-accent-primary glow-sky'
              }`}
            >
              <Server className="w-5 h-5" />
            </div>
            <div>
              <div className="font-bold text-sm text-slate-100 flex items-center space-x-2">
                <span>{currentNode.name}</span>
                {isQuarantined ? (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/40 font-semibold animate-pulse">
                    QUARANTINED
                  </span>
                ) : isExitNode ? (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent-primary/20 text-accent-primary border border-accent-primary/40 font-semibold">
                    EXIT NODE
                  </span>
                ) : (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 font-semibold">
                    HEALTHY
                  </span>
                )}
              </div>
              <div className="text-xs font-mono text-slate-400">
                {currentNode.overlay_ipv4} &bull; {currentNode.country_code} &bull; ASN {currentNode.asn || 7922}
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Risk Score Header Badge */}
            <div
              className={`px-2 py-1 rounded-lg border text-xs font-mono font-bold flex items-center space-x-1 ${
                riskScore > 75
                  ? 'bg-red-950/60 text-red-400 border-red-500/50'
                  : riskScore >= 40
                    ? 'bg-amber-950/60 text-amber-400 border-amber-500/50'
                    : 'bg-emerald-950/60 text-emerald-400 border-emerald-500/50'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Risk: {riskScore}/100</span>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-dark-card-hover transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Drawer Content */}
        <div className="p-5 space-y-5 flex-1">
          {/* A "Send File via NeroDrop — Direct encrypted P2P transfer (64KB
              BLAKE3)" action sat here. NeroDrop is shelved and removed from the
              navigation, and BLAKE3 is not a dependency of this project; the
              button opened a transfer that could not start. */}

          {/* Identity & Crypto Card */}
          <div className="p-4 rounded-xl bg-dark-canvas border border-dark-border space-y-3">
            <div className="text-xs font-semibold text-slate-300 flex items-center justify-between">
              <span>Cryptographic Identity</span>
              <span className="text-[10px] font-mono text-slate-500">Noise_IKpsk2_25519</span>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div>
                <div className="text-[10px] text-slate-500">Public Key (Curve25519)</div>
                <div className="flex items-center justify-between bg-dark-card p-1.5 rounded border border-dark-border mt-0.5">
                  <span className="truncate text-slate-300 text-[11px]">{currentNode.public_key}</span>
                  <button
                    onClick={() => handleCopyKey(currentNode.public_key)}
                    className="p-1 text-slate-400 hover:text-white"
                  >
                    {copiedKey ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <div>
                  <div className="text-[10px] text-slate-500">Overlay IPv6</div>
                  <div className="text-[11px] text-violet-400 truncate">
                    {currentNode.overlay_ipv6 || 'fd7a:115c:a1e0::10'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">Traffic Class</div>
                  <div className="text-[11px] text-slate-300">{currentNode.ip_class || 'RESIDENTIAL'}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Action 1: Live Ping Device */}
          <div className="p-4 rounded-xl bg-dark-canvas border border-dark-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Radio
                  className={`w-4 h-4 ${isPinging ? 'text-accent-primary animate-spin' : 'text-accent-primary'}`}
                />
                <span className="text-xs font-semibold text-slate-200">Live ICMP Ping & Latency Sparkline</span>
              </div>
              <button
                onClick={handlePing}
                disabled={isPinging || isQuarantined}
                className="px-3 py-1 rounded bg-accent-primary/20 text-accent-primary border border-accent-primary/40 hover:bg-accent-primary/30 text-xs font-mono font-bold transition-all disabled:opacity-40 flex items-center space-x-1.5"
              >
                <RotateCw className={`w-3 h-3 ${isPinging ? 'animate-spin' : ''}`} />
                <span>{isPinging ? 'Pinging...' : 'Ping Node'}</span>
              </button>
            </div>

            {/* Sparkline / Ping History Bar */}
            {pingHistory.length > 0 ? (
              <div className="space-y-2">
                <div className="h-16 flex items-end space-x-1 p-2 bg-dark-card rounded-lg border border-dark-border">
                  {pingHistory.map((p, i) => (
                    <div key={i} className="flex-1 flex flex-col items-center group relative">
                      <div
                        className="w-full rounded-t bg-gradient-to-t from-accent-primary to-accent-alert transition-all duration-300 group-hover:brightness-125"
                        style={{ height: `${Math.min(100, (p.rtt / 60) * 100)}%` }}
                      ></div>
                      <div className="text-[9px] font-mono text-slate-500 mt-1">{p.rtt}ms</div>
                    </div>
                  ))}
                </div>

                {pingStats && (
                  <div className="grid grid-cols-4 gap-2 text-center text-xs font-mono p-2 bg-dark-card/50 rounded border border-dark-border/60">
                    <div>
                      <div className="text-[9px] text-slate-500">LAST RTT</div>
                      <div className="text-accent-primary font-bold">{pingStats.rtt_ms}ms</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-slate-500">JITTER</div>
                      <div className="text-violet-400 font-bold">{pingStats.jitter_ms}ms</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-slate-500">MIN / MAX</div>
                      <div className="text-slate-300 font-bold">
                        {pingStats.min_ms}/{pingStats.max_ms}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] text-slate-500">LOSS</div>
                      <div className="text-emerald-400 font-bold">{pingStats.packet_loss_pct}%</div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-slate-500 font-mono italic">
                {isQuarantined
                  ? 'Node is quarantined. ICMP echo requests dropped by Zero-Trust firewall.'
                  : "Click 'Ping Node' to measure real-time wire-level round-trip latency and jitter."}
              </p>
            )}
          </div>

          {/* Action 2: Kill Switch Toggle (R7) */}
          <div className="p-4 rounded-xl bg-dark-canvas border border-dark-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <PowerOff className={`w-4 h-4 ${isKillSwitchEnabled ? 'text-emerald-400' : 'text-slate-400'}`} />
                <div>
                  <div className="text-xs font-semibold text-slate-200 flex items-center space-x-2">
                    <span>WireGuard Kill Switch</span>
                    <span
                      className={`text-[9px] font-mono px-1.5 py-0.2 rounded border ${
                        isKillSwitchEnabled
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40 font-bold'
                          : 'bg-slate-800 text-slate-400 border-slate-700'
                      }`}
                    >
                      {isKillSwitchEnabled ? 'ENFORCED' : 'OFF'}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Blocks all non-overlay WAN traffic if mesh connection drops
                  </div>
                </div>
              </div>
              <button
                onClick={handleToggleKillSwitch}
                disabled={isTogglingKillSwitch || isQuarantined}
                className={`px-3 py-1.5 rounded text-xs font-mono font-bold transition-all border ${
                  isKillSwitchEnabled
                    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/50 shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                    : 'bg-dark-card border-dark-border text-slate-400 hover:text-white'
                } disabled:opacity-40`}
              >
                {isTogglingKillSwitch
                  ? 'Updating...'
                  : isKillSwitchEnabled
                    ? 'Active (Protected)'
                    : 'Enable Kill Switch'}
              </button>
            </div>
            <div className="text-[10px] font-mono text-slate-500 bg-dark-card p-2 rounded border border-dark-border">
              Kernel firewall rule: <code>iptables -A OUTPUT ! -o neronet0 -j DROP</code> (Zero WAN leak).
            </div>
          </div>

          {/* Action 3: Set as Exit Node */}
          <div className="p-4 rounded-xl bg-dark-canvas border border-dark-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Compass className="w-4 h-4 text-violet-400" />
                <div>
                  <div className="text-xs font-semibold text-slate-200">Sovereign Exit Node</div>
                  <div className="text-[11px] text-slate-400">Route WAN egress traffic through this physical node</div>
                </div>
              </div>
              <button
                onClick={handleToggleExit}
                disabled={isUpdatingExit || isQuarantined}
                className={`px-3 py-1.5 rounded text-xs font-mono font-bold transition-all border ${
                  isExitNode
                    ? 'bg-violet-500/30 text-violet-300 border-violet-500 shadow-[0_0_12px_rgba(139,92,246,0.3)]'
                    : 'bg-dark-card border-dark-border text-slate-400 hover:text-white'
                } disabled:opacity-40`}
              >
                {isUpdatingExit ? 'Updating...' : isExitNode ? 'Active Exit' : 'Set as Exit'}
              </button>
            </div>

            <div className="space-y-1.5 text-[11px] font-mono text-slate-400 bg-dark-card p-2.5 rounded-lg border border-dark-border">
              <div className="flex items-center justify-between">
                <span>DNS Leak Guard:</span>
                <span className="text-emerald-400 font-bold">100.64.0.1 (Internal Mesh DNS)</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Egress Masking:</span>
                <span className="text-slate-200">
                  {currentNode.country_code} ({currentNode.city || 'Regional'})
                </span>
              </div>
            </div>
          </div>

          {/* Action 4: 3-Hop Onion Obfuscation */}
          <div className="p-4 rounded-xl bg-dark-canvas border border-dark-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Zap className={`w-4 h-4 ${isOnionEnabled ? 'text-accent-primary' : 'text-slate-400'}`} />
                <div>
                  <div className="text-xs font-semibold text-slate-200">3-Hop Onion Obfuscation</div>
                  <div className="text-[11px] text-slate-400">Tor-grade multi-hop traffic circuit routing</div>
                </div>
              </div>
              <button
                onClick={handleToggleOnion}
                disabled={isTogglingOnion || isQuarantined}
                className={`px-3 py-1.5 rounded text-xs font-mono font-bold transition-all border ${
                  isOnionEnabled
                    ? 'bg-accent-primary/20 text-accent-primary border-accent-primary shadow-[0_0_12px_rgba(56,189,248,0.3)]'
                    : 'bg-dark-card border-dark-border text-slate-400 hover:text-white'
                } disabled:opacity-40`}
              >
                {isTogglingOnion ? 'Toggling...' : isOnionEnabled ? '3 Hops Active' : 'Direct (0-Hop)'}
              </button>
            </div>

            <div className="space-y-1.5 text-[11px] font-mono text-slate-400 bg-dark-card p-2.5 rounded-lg border border-dark-border">
              <div className="flex items-center justify-between">
                <span>Circuit Hops:</span>
                <span className={`font-bold ${isOnionEnabled ? 'text-accent-primary' : 'text-slate-300'}`}>
                  {isOnionEnabled ? '3 Relays (Layered Noise)' : 'Direct Egress (0-Hop)'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Latency Impact:</span>
                <span className={isOnionEnabled ? 'text-amber-400' : 'text-emerald-400'}>
                  {isOnionEnabled ? '+35ms (Tor-grade Obfuscation)' : '0ms (Lowest Latency)'}
                </span>
              </div>
            </div>
          </div>

          {/* Action 5: Quarantine / Posture Isolation (with Subnet 100.64.250.0/24 indicator) */}
          <div
            className={`p-4 rounded-xl border space-y-3 ${
              isQuarantined ? 'bg-red-500/10 border-red-500/50 shadow-lg' : 'bg-dark-canvas border-dark-border'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <ShieldAlert className={`w-4 h-4 ${isQuarantined ? 'text-red-400' : 'text-slate-400'}`} />
                <div>
                  <div className={`text-xs font-semibold ${isQuarantined ? 'text-red-400' : 'text-slate-200'}`}>
                    Zero-Trust Quarantine & Subnet Isolation
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Instantly isolate node and move to restricted quarantine subnet
                  </div>
                </div>
              </div>
              <button
                onClick={handleToggleQuarantine}
                disabled={isQuarantining}
                className={`px-3 py-1.5 rounded text-xs font-mono font-bold transition-all border flex items-center space-x-1.5 ${
                  isQuarantined
                    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/30'
                    : 'bg-red-500/20 text-red-400 border-red-500/40 hover:bg-red-500/30 shadow-[0_0_12px_rgba(239,68,68,0.3)]'
                }`}
              >
                {isQuarantined ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                <span>{isQuarantining ? 'Processing...' : isQuarantined ? 'Lift Quarantine' : 'Quarantine Node'}</span>
              </button>
            </div>

            {isQuarantined ? (
              <div className="p-3 rounded-lg bg-red-950/50 border border-red-500/40 text-xs font-mono text-red-200 space-y-1">
                <div className="flex items-center space-x-1.5 font-bold text-red-300">
                  <AlertTriangle className="w-4 h-4 text-red-400" />
                  <span>Subnet Reallocation Active: 100.64.250.0/24</span>
                </div>
                <p className="text-[11px] text-red-300/80">
                  Node ingress/egress is isolated into the Zero-Trust sandbox subnet <code>100.64.250.0/24</code>. All
                  lateral mesh communications are dropped.
                </p>
                {currentNode.quarantine_reason && (
                  <div className="text-[10px] text-red-400 pt-1 border-t border-red-800/60">
                    <strong>Reason:</strong> {currentNode.quarantine_reason}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[10px] font-mono text-slate-500">
                Triggering quarantine immediately reassigns VIP to <code>100.64.250.0/24</code> and revokes lateral
                routing.
              </div>
            )}
          </div>
        </div>

        {/* Drawer Footer: Revoke Device */}
        <div className="p-4 border-t border-dark-border bg-dark-canvas/80 flex items-center justify-between sticky bottom-0">
          <button
            onClick={handleRevoke}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-dark-card border border-red-500/30 text-red-400 hover:bg-red-500/20 text-xs font-mono transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Revoke Device</span>
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded bg-dark-border text-slate-300 hover:text-white text-xs font-mono transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
