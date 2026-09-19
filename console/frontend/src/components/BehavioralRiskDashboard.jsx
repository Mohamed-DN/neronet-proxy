import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import {
  Activity,
  ShieldAlert,
  ShieldCheck,
  AlertTriangle,
  Flame,
  Zap,
  Globe,
  Radio,
  Lock,
  Unlock,
  CheckCircle2,
  RefreshCw,
  Clock,
  Compass,
  Server,
  Filter,
  Layers
} from 'lucide-react';

export default function BehavioralRiskDashboard({ onSelectNode }) {
  const [summary, setSummary] = useState(null);
  const [events, setEvents] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterSeverity, setFilterSeverity] = useState('ALL');

  const loadData = async () => {
    try {
      const [sumData, eventData, leaderData] = await Promise.all([
        api.risk.getSummary(),
        api.risk.listEvents(),
        api.risk.getLeaderboard()
      ]);
      setSummary(sumData);
      setEvents(Array.isArray(eventData) ? eventData : []);
      setLeaderboard(Array.isArray(leaderData) ? leaderData : []);
    } catch (err) {
      console.error('Failed to load behavioral risk data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  // These reported nothing on failure, and a failed request used to be applied to a
  // local object and answered `{ success: true }`, so quarantining a node appeared
  // to work with the control plane unreachable.
  const handleQuarantine = async (nodeId) => {
    try {
      await api.risk.quarantine(nodeId, 'Operator manual quarantine from Behavioral Risk Dashboard');
      loadData();
    } catch (err) {
      window.alert(`${nodeId} was not quarantined: ${err.message}`);
    }
  };

  const handleClearRisk = async (nodeId) => {
    try {
      await api.risk.clearRisk(nodeId);
      loadData();
    } catch (err) {
      window.alert(`The risk score for ${nodeId} was not cleared: ${err.message}`);
    }
  };

  const filteredEvents = events.filter((e) => {
    if (filterSeverity === 'ALL') return true;
    return e.severity === filterSeverity;
  });

  // Posture counts come from what each node attested. "Fully compliant posture" is
  // only true when every enrolled node is verified_compliant, which on a fleet that
  // measures nothing is never.
  const posture = summary?.posture;
  const postureTotal = posture ? posture.verified_compliant + posture.unverified + posture.non_compliant : 0;
  const lowRiskCaption = !posture
    ? 'Posture not reported'
    : postureTotal > 0 && posture.verified_compliant === postureTotal
      ? 'Fully compliant posture'
      : `Posture: ${posture.verified_compliant} verified, ${posture.unverified} unverified, ${posture.non_compliant} non-compliant`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-100 flex items-center space-x-2">
            <Activity className="w-5 h-5 text-accent-primary animate-pulse" />
            <span>Continuous Behavioral Risk & Anomaly Engine</span>
            {/* This badge read "PostGIS + pgvector". Neither is used: PostGIS was
                removed by migration 004 and pgvector was never installed. Scores
                come from the rules in services/RiskEngine.js. */}
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Real-time telemetry analysis: impossible travel detection (&gt;1000 km/h), wire RTT drift, and automated
            quarantine triggers.
          </p>
        </div>

        <button
          onClick={loadData}
          className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-dark-card border border-dark-border text-slate-300 hover:text-white text-xs font-mono transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Telemetry</span>
        </button>
      </div>

      {/* KPI Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 font-mono">
        {/* Low Risk */}
        <div className="p-4 rounded-2xl bg-dark-card border border-emerald-500/30 shadow-xl space-y-1">
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>Low Risk (&lt; 40)</span>
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-emerald-400">{summary?.distribution?.low ?? '—'} Nodes</div>
          {/* This read "Fully compliant posture" under a count of low risk scores. A
              low score means nothing was seen going wrong; it is not a measurement of
              the host. The claim is made only when every node has actually attested
              every required check. */}
          <div className="text-[10px] text-slate-500">{lowRiskCaption}</div>
        </div>

        {/* Medium Risk */}
        <div className="p-4 rounded-2xl bg-dark-card border border-amber-500/30 shadow-xl space-y-1">
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>Elevated (40 - 75)</span>
            <AlertTriangle className="w-4 h-4 text-amber-400" />
          </div>
          <div className="text-2xl font-bold text-amber-400">{summary?.distribution?.medium ?? '—'} Nodes</div>
          <div className="text-[10px] text-slate-500">Above the quarantine threshold</div>
        </div>

        {/* Critical Risk */}
        <div className="p-4 rounded-2xl bg-dark-card border border-red-500/40 shadow-xl space-y-1 bg-red-950/20">
          <div className="text-xs text-red-300 flex items-center justify-between">
            <span>Critical (&gt; 75)</span>
            <Flame className="w-4 h-4 text-red-400 animate-bounce" />
          </div>
          <div className="text-2xl font-bold text-red-400">{summary?.distribution?.high ?? '—'} Nodes</div>
          <div className="text-[10px] text-red-400/80">Auto-quarantined to 100.64.250.0/24</div>
        </div>

        {/* Average Mesh Score */}
        <div className="p-4 rounded-2xl bg-dark-card border border-accent-primary/30 shadow-xl space-y-1">
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>Avg Risk Score</span>
            <Activity className="w-4 h-4 text-accent-primary" />
          </div>
          <div className="text-2xl font-bold text-slate-100">{summary?.average_risk_score ?? '—'} / 100</div>
          {/* There is no moving window: the score is the value stored on the node row. */}
          <div className="text-[10px] text-slate-500">Mean across enrolled nodes</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Node Risk Leaderboard (Left 2 Columns) */}
        <div className="lg:col-span-2 rounded-2xl bg-dark-card border border-dark-border overflow-hidden shadow-xl flex flex-col">
          <div className="p-4 border-b border-dark-border flex items-center justify-between bg-dark-canvas/50">
            <div className="flex items-center space-x-2">
              <Server className="w-4 h-4 text-accent-primary" />
              <span className="text-xs font-bold font-mono text-slate-300 uppercase tracking-wider">
                Node Risk Leaderboard
              </span>
            </div>
            <span className="text-xs font-mono text-slate-500">{leaderboard.length} Nodes</span>
          </div>

          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-dark-canvas/80 text-slate-400 border-b border-dark-border">
                <tr>
                  <th className="p-3.5">Device</th>
                  <th className="p-3.5">Risk Score</th>
                  <th className="p-3.5">Risk Breakdown Factors</th>
                  <th className="p-3.5">Status</th>
                  <th className="p-3.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dark-border">
                {leaderboard.map((node) => {
                  const score = node.risk_score || 0;
                  const isHigh = score > 75;
                  const isMed = score >= 40 && score <= 75;
                  const isQuarantined = Boolean(node.is_quarantined);

                  return (
                    <tr
                      key={node.id}
                      onClick={() => onSelectNode && onSelectNode(node)}
                      className="hover:bg-dark-card-hover/50 transition-colors cursor-pointer"
                    >
                      <td className="p-3.5">
                        <div className="font-bold text-slate-100">{node.name}</div>
                        <div className="text-[11px] text-slate-400">{node.overlay_ipv4}</div>
                        <div className="text-[10px] text-slate-500">
                          {node.country_code} &bull; {node.city || 'Regional'}
                        </div>
                      </td>

                      <td className="p-3.5 min-w-[140px]">
                        <div className="space-y-1">
                          <div className="flex justify-between text-xs font-bold">
                            <span className={isHigh ? 'text-red-400' : isMed ? 'text-amber-400' : 'text-emerald-400'}>
                              {score} / 100
                            </span>
                          </div>
                          <div className="w-full bg-dark-canvas rounded-full h-2 overflow-hidden border border-dark-border">
                            <div
                              className={`h-full rounded-full ${
                                isHigh ? 'bg-red-500' : isMed ? 'bg-amber-400' : 'bg-emerald-400'
                              }`}
                              style={{ width: `${Math.min(100, score)}%` }}
                            ></div>
                          </div>
                        </div>
                      </td>

                      <td className="p-3.5">
                        <div className="flex flex-wrap gap-1">
                          {Array.isArray(node.risk_factors) && node.risk_factors.length > 0 ? (
                            node.risk_factors.map((rf, idx) => (
                              <span
                                key={idx}
                                className="text-[9px] px-1.5 py-0.2 rounded bg-red-950/60 text-red-300 border border-red-500/40"
                              >
                                {rf}
                              </span>
                            ))
                          ) : isHigh ? (
                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-red-950/60 text-red-300 border border-red-500/40">
                              IMPOSSIBLE_TRAVEL (+50)
                            </span>
                          ) : (
                            <span className="text-[9px] px-1.5 py-0.2 rounded bg-dark-canvas text-slate-500">
                              NORMAL_TELEMETRY
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="p-3.5">
                        <span
                          className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold border ${
                            isQuarantined
                              ? 'bg-red-500/20 text-red-400 border-red-500/40 animate-pulse'
                              : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                          }`}
                        >
                          {isQuarantined ? <Lock className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3" />}
                          <span>{isQuarantined ? 'QUARANTINED' : 'ACTIVE'}</span>
                        </span>
                      </td>

                      <td className="p-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                        {isQuarantined || isHigh ? (
                          <button
                            onClick={() => handleClearRisk(node.id)}
                            className="px-2.5 py-1 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/30 text-xs font-bold"
                          >
                            Clear Flag
                          </button>
                        ) : (
                          <button
                            onClick={() => handleQuarantine(node.id)}
                            className="px-2.5 py-1 rounded bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500/25 text-xs font-bold"
                          >
                            Lockdown
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Live Anomaly Feed (Right 1 Column) */}
        <div className="rounded-2xl bg-dark-card border border-dark-border overflow-hidden shadow-xl flex flex-col">
          <div className="p-4 border-b border-dark-border flex items-center justify-between bg-dark-canvas/50">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              <span className="text-xs font-bold font-mono text-slate-300 uppercase tracking-wider">
                Live Anomaly Event Feed
              </span>
            </div>

            <select
              value={filterSeverity}
              onChange={(e) => setFilterSeverity(e.target.value)}
              className="text-[11px] font-mono bg-dark-canvas border border-dark-border rounded px-2 py-0.5 text-slate-300 focus:outline-none"
            >
              <option value="ALL">All</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
            </select>
          </div>

          <div className="p-4 space-y-3 flex-1 overflow-y-auto max-h-[500px]">
            {filteredEvents.map((evt) => {
              const isCrit = evt.severity === 'critical' || evt.severity === 'high';
              return (
                <div
                  key={evt.id}
                  className={`p-3 rounded-xl border text-xs font-mono space-y-1.5 ${
                    isCrit
                      ? 'bg-red-950/30 border-red-500/40 text-red-200'
                      : 'bg-amber-950/20 border-amber-500/30 text-amber-200'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold flex items-center space-x-1.5">
                      <Flame className={`w-3.5 h-3.5 ${isCrit ? 'text-red-400' : 'text-amber-400'}`} />
                      <span>{evt.type || evt.event_type}</span>
                    </span>
                    <span className="text-[10px] text-slate-400">
                      {new Date(evt.timestamp || evt.created_at).toLocaleTimeString()}
                    </span>
                  </div>

                  <p className="text-[11px] text-slate-300">{evt.description || evt.message}</p>

                  <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1 border-t border-dark-border/60">
                    <span>
                      Node: <strong className="text-slate-200">{evt.node_name || evt.target_id}</strong>
                    </span>
                    <span className="font-bold text-red-400">+{evt.risk_delta || 50} pts</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
