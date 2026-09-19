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
      <div className="w-full max-w-lg bg-surface-raised border-l border-border h-full flex flex-col shadow-2xl overflow-y-auto">
        {/* Drawer Header */}
        <div className="p-5 border-b border-border flex items-center justify-between bg-surface/70 sticky top-0 z-10 backdrop-blur-md">
          <div className="flex items-center space-x-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center border ${
                isQuarantined
                  ? 'bg-danger/10 border-danger/40 text-danger'
                  : 'bg-accent/10 border-accent/40 text-accent'
              }`}
            >
              <Server className="w-5 h-5" />
            </div>
            <div>
              <div className="font-bold text-sm text-content flex items-center space-x-2">
                <span>{currentNode.name}</span>
                {isQuarantined ? (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-danger/20 text-danger border border-danger/40 font-semibold animate-pulse">
                    QUARANTINED
                  </span>
                ) : isExitNode ? (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/20 text-accent border border-accent/40 font-semibold">
                    EXIT NODE
                  </span>
                ) : (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-success/20 text-success border border-success/40 font-semibold">
                    HEALTHY
                  </span>
                )}
              </div>
              <div className="text-xs font-mono text-muted">
                {currentNode.overlay_ipv4} &bull; {currentNode.country_code} &bull; ASN {currentNode.asn || 7922}
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {/* Risk Score Header Badge */}
            <div
              className={`px-2 py-1 rounded-lg border text-xs font-mono font-bold flex items-center space-x-1 ${
                riskScore > 75
                  ? 'bg-danger/60 text-danger border-danger/50'
                  : riskScore >= 40
                    ? 'bg-warning/60 text-warning border-warning/50'
                    : 'bg-success/60 text-success border-success/50'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>Risk: {riskScore}/100</span>
            </div>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-muted hover:text-content hover:bg-surface-hover transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Drawer Content */}
        <div className="p-5 space-y-5 flex-1">
          {/* Identity & Crypto Card */}
          <div className="p-4 rounded-xl bg-surface border border-border space-y-3">
            <div className="text-xs font-semibold text-muted flex items-center justify-between">
              <span>Cryptographic Identity</span>
              <span className="text-[10px] font-mono text-subtle">Noise_IKpsk2_25519</span>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div>
                <div className="text-[10px] text-subtle">Public Key (Curve25519)</div>
                <div className="flex items-center justify-between bg-surface-raised p-1.5 rounded border border-border mt-0.5">
                  <span className="truncate text-muted text-[11px]">{currentNode.public_key}</span>
                  <button
                    onClick={() => handleCopyKey(currentNode.public_key)}
                    className="p-1 text-muted hover:text-white"
                  >
                    {copiedKey ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <div>
                  <div className="text-[10px] text-subtle">Overlay IPv6</div>
                  <div className="text-[11px] text-info truncate">
                    {currentNode.overlay_ipv6 || 'fd7a:115c:a1e0::10'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-subtle">Traffic Class</div>
                  <div className="text-[11px] text-muted">{currentNode.ip_class || 'RESIDENTIAL'}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Action 1: Live Ping Device */}
          <div className="p-4 rounded-xl bg-surface border border-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Radio className={`w-4 h-4 ${isPinging ? 'text-accent animate-spin' : 'text-accent'}`} />
                <span className="text-xs font-semibold text-content">Live ICMP Ping & Latency Sparkline</span>
              </div>
              <button
                onClick={handlePing}
                disabled={isPinging || isQuarantined}
                className="px-3 py-1 rounded bg-accent/20 text-accent border border-accent/40 hover:bg-accent/30 text-xs font-mono font-bold transition-all disabled:opacity-40 flex items-center space-x-1.5"
              >
                <RotateCw className={`w-3 h-3 ${isPinging ? 'animate-spin' : ''}`} />
                <span>{isPinging ? 'Pinging...' : 'Ping Node'}</span>
              </button>
            </div>

            {/* Sparkline / Ping History Bar */}
            {pingHistory.length > 0 ? (
              <div className="space-y-2">
                <div className="h-16 flex items-end space-x-1 p-2 bg-surface-raised rounded-lg border border-border">
                  {pingHistory.map((p, i) => (
                    <div key={i} className="flex-1 flex flex-col items-center group relative">
                      <div
                        className="w-full rounded-t bg-accent transition-all duration-300 group-hover:brightness-125"
                        style={{ height: `${Math.min(100, (p.rtt / 60) * 100)}%` }}
                      ></div>
                      <div className="text-[9px] font-mono text-subtle mt-1">{p.rtt}ms</div>
                    </div>
                  ))}
                </div>

                {pingStats && (
                  <div className="grid grid-cols-4 gap-2 text-center text-xs font-mono p-2 bg-surface-raised/50 rounded border border-border/60">
                    <div>
                      <div className="text-[9px] text-subtle">LAST RTT</div>
                      <div className="text-accent font-bold">{pingStats.rtt_ms}ms</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-subtle">JITTER</div>
                      <div className="text-info font-bold">{pingStats.jitter_ms}ms</div>
                    </div>
                    <div>
                      <div className="text-[9px] text-subtle">MIN / MAX</div>
                      <div className="text-muted font-bold">
                        {pingStats.min_ms}/{pingStats.max_ms}
                      </div>
                    </div>
                    <div>
                      <div className="text-[9px] text-subtle">LOSS</div>
                      <div className="text-success font-bold">{pingStats.packet_loss_pct}%</div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-subtle font-mono italic">
                {isQuarantined
                  ? 'Node is quarantined. ICMP echo requests dropped by Zero-Trust firewall.'
                  : "Click 'Ping Node' to measure real-time wire-level round-trip latency and jitter."}
              </p>
            )}
          </div>

          {/* Action 2: Kill Switch Toggle (R7) */}
          <div className="p-4 rounded-xl bg-surface border border-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <PowerOff className={`w-4 h-4 ${isKillSwitchEnabled ? 'text-success' : 'text-muted'}`} />
                <div>
                  <div className="text-xs font-semibold text-content flex items-center space-x-2">
                    <span>WireGuard Kill Switch</span>
                    <span
                      className={`text-[9px] font-mono px-1.5 py-0.2 rounded border ${
                        isKillSwitchEnabled
                          ? 'bg-success/20 text-success border-success/40 font-bold'
                          : 'bg-surface-raised text-muted border-border'
                      }`}
                    >
                      {isKillSwitchEnabled ? 'ENFORCED' : 'OFF'}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted">
                    Blocks all non-overlay WAN traffic if mesh connection drops
                  </div>
                </div>
              </div>
              <button
                onClick={handleToggleKillSwitch}
                disabled={isTogglingKillSwitch || isQuarantined}
                className={`px-3 py-1.5 rounded text-xs font-mono font-bold transition-all border ${
                  isKillSwitchEnabled
                    ? 'bg-success/20 text-success border-success/50 shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                    : 'bg-surface-raised border-border text-muted hover:text-white'
                } disabled:opacity-40`}
              >
                {isTogglingKillSwitch
                  ? 'Updating...'
                  : isKillSwitchEnabled
                    ? 'Active (Protected)'
                    : 'Enable Kill Switch'}
              </button>
            </div>
            <div className="text-[10px] font-mono text-subtle bg-surface-raised p-2 rounded border border-border">
              Kernel firewall rule: <code>iptables -A OUTPUT ! -o neronet0 -j DROP</code> (Zero WAN leak).
            </div>
          </div>

          {/* Action 3: Set as Exit Node */}
          <div className="p-4 rounded-xl bg-surface border border-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Compass className="w-4 h-4 text-info" />
                <div>
                  <div className="text-xs font-semibold text-content">Sovereign Exit Node</div>
                  <div className="text-[11px] text-muted">Route WAN egress traffic through this physical node</div>
                </div>
              </div>
              <button
                onClick={handleToggleExit}
                disabled={isUpdatingExit || isQuarantined}
                className={`px-3 py-1.5 rounded text-xs font-mono font-bold transition-all border ${
                  isExitNode
                    ? 'bg-info/30 text-info border-info shadow-[0_0_12px_rgba(139,92,246,0.3)]'
                    : 'bg-surface-raised border-border text-muted hover:text-white'
                } disabled:opacity-40`}
              >
                {isUpdatingExit ? 'Updating...' : isExitNode ? 'Active Exit' : 'Set as Exit'}
              </button>
            </div>

            <div className="space-y-1.5 text-[11px] font-mono text-muted bg-surface-raised p-2.5 rounded-lg border border-border">
              <div className="flex items-center justify-between">
                <span>DNS Leak Guard:</span>
                <span className="text-success font-bold">100.64.0.1 (Internal Mesh DNS)</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Egress Masking:</span>
                <span className="text-content">
                  {currentNode.country_code} ({currentNode.city || 'Regional'})
                </span>
              </div>
            </div>
          </div>

          {/* Action 4: 3-Hop Onion Obfuscation */}
          <div className="p-4 rounded-xl bg-surface border border-border space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Zap className={`w-4 h-4 ${isOnionEnabled ? 'text-accent' : 'text-muted'}`} />
                <div>
                  <div className="text-xs font-semibold text-content">3-Hop Onion Obfuscation</div>
                  <div className="text-[11px] text-muted">Tor-grade multi-hop traffic circuit routing</div>
                </div>
              </div>
              <button
                onClick={handleToggleOnion}
                disabled={isTogglingOnion || isQuarantined}
                className={`px-3 py-1.5 rounded text-xs font-mono font-bold transition-all border ${
                  isOnionEnabled
                    ? 'bg-accent/20 text-accent border-accent shadow-[0_0_12px_rgba(56,189,248,0.3)]'
                    : 'bg-surface-raised border-border text-muted hover:text-white'
                } disabled:opacity-40`}
              >
                {isTogglingOnion ? 'Toggling...' : isOnionEnabled ? '3 Hops Active' : 'Direct (0-Hop)'}
              </button>
            </div>

            <div className="space-y-1.5 text-[11px] font-mono text-muted bg-surface-raised p-2.5 rounded-lg border border-border">
              <div className="flex items-center justify-between">
                <span>Circuit Hops:</span>
                <span className={`font-bold ${isOnionEnabled ? 'text-accent' : 'text-muted'}`}>
                  {isOnionEnabled ? '3 Relays (Layered Noise)' : 'Direct Egress (0-Hop)'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Latency Impact:</span>
                <span className={isOnionEnabled ? 'text-warning' : 'text-success'}>
                  {isOnionEnabled ? '+35ms (Tor-grade Obfuscation)' : '0ms (Lowest Latency)'}
                </span>
              </div>
            </div>
          </div>

          {/* Action 5: Quarantine / Posture Isolation (with Subnet 100.64.250.0/24 indicator) */}
          <div
            className={`p-4 rounded-xl border space-y-3 ${
              isQuarantined ? 'bg-danger/10 border-danger/50 shadow-lg' : 'bg-surface border-border'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <ShieldAlert className={`w-4 h-4 ${isQuarantined ? 'text-danger' : 'text-muted'}`} />
                <div>
                  <div className={`text-xs font-semibold ${isQuarantined ? 'text-danger' : 'text-content'}`}>
                    Zero-Trust Quarantine & Subnet Isolation
                  </div>
                  <div className="text-[11px] text-muted">
                    Instantly isolate node and move to restricted quarantine subnet
                  </div>
                </div>
              </div>
              <button
                onClick={handleToggleQuarantine}
                disabled={isQuarantining}
                className={`px-3 py-1.5 rounded text-xs font-mono font-bold transition-all border flex items-center space-x-1.5 ${
                  isQuarantined
                    ? 'bg-success/20 text-success border-success/40 hover:bg-success/30'
                    : 'bg-danger/20 text-danger border-danger/40 hover:bg-danger/30 shadow-[0_0_12px_rgba(239,68,68,0.3)]'
                }`}
              >
                {isQuarantined ? <Unlock className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                <span>{isQuarantining ? 'Processing...' : isQuarantined ? 'Lift Quarantine' : 'Quarantine Node'}</span>
              </button>
            </div>

            {isQuarantined ? (
              <div className="p-3 rounded-lg bg-danger/50 border border-danger/40 text-xs font-mono text-danger space-y-1">
                <div className="flex items-center space-x-1.5 font-bold text-danger">
                  <AlertTriangle className="w-4 h-4 text-danger" />
                  <span>Subnet Reallocation Active: 100.64.250.0/24</span>
                </div>
                <p className="text-[11px] text-danger/80">
                  Node ingress/egress is isolated into the Zero-Trust sandbox subnet <code>100.64.250.0/24</code>. All
                  lateral mesh communications are dropped.
                </p>
                {currentNode.quarantine_reason && (
                  <div className="text-[10px] text-danger pt-1 border-t border-danger/60">
                    <strong>Reason:</strong> {currentNode.quarantine_reason}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[10px] font-mono text-subtle">
                Triggering quarantine immediately reassigns VIP to <code>100.64.250.0/24</code> and revokes lateral
                routing.
              </div>
            )}
          </div>
        </div>

        {/* Drawer Footer: Revoke Device */}
        <div className="p-4 border-t border-border bg-surface/80 flex items-center justify-between sticky bottom-0">
          <button
            onClick={handleRevoke}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded bg-surface-raised border border-danger/30 text-danger hover:bg-danger/20 text-xs font-mono transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Revoke Device</span>
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded bg-border text-muted hover:text-white text-xs font-mono transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
