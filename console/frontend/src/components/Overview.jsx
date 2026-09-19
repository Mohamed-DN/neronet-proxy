import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import {
  Server,
  Users,
  Activity,
  ShieldCheck,
  ArrowDownLeft,
  ArrowUpRight,
  Globe2,
  AlertTriangle,
  Zap,
  TrendingUp,
  Clock,
  Sparkles
} from 'lucide-react';

/**
 * Renders a byte count at a sensible unit, or a dash when there is nothing to show.
 * Binary units, because that is what the node counters measure in.
 */
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : value >= 100 ? 0 : 1)} ${units[i]}`;
}

export default function Overview({ onSelectNode, onNavigateTab }) {
  const [stats, setStats] = useState(null);
  const [timeseries, setTimeseries] = useState([]);
  const [geoMatrix, setGeoMatrix] = useState([]);
  const [timeRange, setTimeRange] = useState('24h');
  const [loading, setLoading] = useState(true);

  const [loadError, setLoadError] = useState(null);

  // Re-runs when the range changes: the selector used to set state that nothing
  // read, so every range showed the same fixed series.
  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      try {
        const [overviewStats, ts, geo] = await Promise.all([
          api.stats.getOverview(),
          api.stats.getTimeseries(timeRange),
          api.stats.getGeoMatrix()
        ]);
        if (cancelled) return;
        setStats(overviewStats);
        setTimeseries(ts);
        setGeoMatrix(geo);
        setLoadError(null);
      } catch (err) {
        if (cancelled) return;
        // A console that cannot reach its control plane must say so. It used to log
        // to the developer console and keep the previous figures on screen.
        setLoadError(err?.message || 'The control plane did not respond');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadData();
    const poll = setInterval(loadData, 30000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [timeRange]);

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div className="p-3 bg-dark-card/95 border border-dark-border rounded-xl shadow-2xl backdrop-blur-md text-xs font-mono">
          <div className="text-slate-400 mb-1 flex items-center space-x-1.5">
            <Clock className="w-3 h-3 text-slate-500" />
            <span>Time: {label}</span>
          </div>
          <div className="text-neon-cyan flex items-center justify-between space-x-4">
            <span>Inbound (RX):</span>
            <span className="font-bold">{payload[0]?.value} MB/s</span>
          </div>
          <div className="text-neon-indigo flex items-center justify-between space-x-4">
            <span>Outbound (TX):</span>
            <span className="font-bold">{payload[1]?.value} MB/s</span>
          </div>
          {payload[0]?.payload?.latency && (
            <div className="text-neon-emerald flex items-center justify-between space-x-4 pt-1 mt-1 border-t border-dark-border">
              <span>Avg Latency:</span>
              <span className="font-bold">{payload[0].payload.latency} ms</span>
            </div>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="space-y-6">
      {/* Top Banner / Heading */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          {/* The badge here read "DirectFrame v4.0 Active" in green whatever the state
              of the fleet. It now reports whether the console is reading live data. */}
          <h1 className="text-xl font-bold text-slate-100 flex items-center flex-wrap gap-x-2 gap-y-1">
            <span>Mesh Overview</span>
            <span
              className={`text-xs font-mono font-normal px-2 py-0.5 rounded border ${
                loadError
                  ? 'bg-neon-rose/20 text-neon-rose border-neon-rose/40'
                  : 'bg-neon-emerald/20 text-neon-emerald border-neon-emerald/40'
              }`}
            >
              {loadError ? 'Control plane unreachable' : 'Live'}
            </span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Enrolled devices, what they are transferring, and where they are.
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => onNavigateTab && onNavigateTab('topology')}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-dark-canvas border border-dark-border text-slate-300 hover:text-neon-cyan hover:border-neon-cyan/40 text-xs font-mono transition-all"
          >
            <Globe2 className="w-3.5 h-3.5" />
            <span>View 3D Topology</span>
          </button>
        </div>
      </div>

      {loadError && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-neon-rose/10 border border-neon-rose/30">
          <AlertTriangle className="w-4 h-4 text-neon-rose shrink-0 mt-0.5" />
          <div className="text-xs">
            <p className="text-neon-rose font-mono font-bold">Figures below may be stale</p>
            <p className="text-slate-400 mt-0.5">{loadError}</p>
          </div>
        </div>
      )}

      {/* KPI Metric Cards */}
      {(() => {
        const activeNodes = stats?.active_nodes ?? 0;
        const totalNodes = stats?.total_nodes ?? stats?.active_nodes ?? 0;
        const quarantinedNodes = stats?.quarantined_nodes ?? 0;
        // This card used to show "N Compliant", where N was active minus quarantined
        // -- a liveness figure under a compliance label, on a fleet where no node has
        // ever had its posture measured. These three come from what each node
        // attested; quarantine is a separate fact and is shown as one.
        const verifiedCompliantNodes = stats?.posture_verified_compliant_nodes ?? null;
        const unverifiedNodes = stats?.posture_unverified_nodes ?? null;
        const nonCompliantNodes = stats?.posture_non_compliant_nodes ?? null;
        const activeUsers = stats?.active_users ?? 0;
        // null means the control plane has not measured this yet, which is not the
        // same as zero. Both are rendered, and they are rendered differently.
        const rxBandwidth = stats?.total_bandwidth_rx_mb_s ?? null;
        const txBandwidth = stats?.total_bandwidth_tx_mb_s ?? null;
        const haveRates = rxBandwidth !== null && txBandwidth !== null;
        const totalBandwidth = haveRates ? +(rxBandwidth + txBandwidth).toFixed(2) : null;
        const healthScore = stats?.network_health_score ?? null;
        const dash = (v) => (v === null || v === undefined ? '—' : v);

        const postureLabel =
          healthScore === null
            ? 'Not measured'
            : healthScore === 100
              ? 'All nodes reachable'
              : healthScore >= 80
                ? 'Degraded'
                : healthScore > 0
                  ? 'Impaired'
                  : 'Fleet offline';

        const postureColour =
          healthScore === null
            ? 'text-slate-400'
            : healthScore === 100
              ? 'text-neon-emerald'
              : healthScore >= 80
                ? 'text-neon-amber'
                : 'text-neon-rose';

        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Metric 1: Nodes */}
            <div className="p-4 rounded-xl bg-dark-card border border-dark-border relative overflow-hidden group hover:border-dark-border/80 transition-all shadow-lg">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-xs font-mono">Active Sovereign Nodes</span>
                <Server className="w-4 h-4 text-neon-cyan" />
              </div>
              <div className="flex items-baseline space-x-2">
                <span className="text-2xl font-bold text-slate-100 font-mono">{activeNodes}</span>
                <span className="text-xs text-slate-500 font-mono">/ {totalNodes} Enrolled</span>
              </div>
              <div className="mt-3 space-y-1 text-[11px] font-mono">
                <div className="flex items-center justify-between">
                  <span className="text-neon-emerald flex items-center space-x-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-neon-emerald"></span>
                    <span>{dash(verifiedCompliantNodes)} posture verified</span>
                  </span>
                  <span className="text-slate-400 flex items-center space-x-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                    <span>{dash(unverifiedNodes)} unverified</span>
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-neon-amber flex items-center space-x-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-neon-amber"></span>
                    <span>{dash(nonCompliantNodes)} non-compliant</span>
                  </span>
                  <span className="text-neon-rose flex items-center space-x-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-neon-rose"></span>
                    <span>{quarantinedNodes} quarantined</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Metric 2: Users */}
            <div className="p-4 rounded-xl bg-dark-card border border-dark-border relative overflow-hidden group hover:border-dark-border/80 transition-all shadow-lg">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-xs font-mono">Total Users</span>
                <Users className="w-4 h-4 text-neon-indigo" />
              </div>
              <div className="flex items-baseline space-x-2">
                <span className="text-2xl font-bold text-slate-100 font-mono">{activeUsers}</span>
                <span className="text-xs text-slate-500 font-mono">Active Tenants</span>
              </div>
              {/* This used to print activeUsers/2 as "Hybrid BYOS" and the other half as
                  "Cloud Managed" — a made-up split, not a count of anything. There are
                  no tiers now, and there was never data behind that line. */}
              <div className="mt-3 text-[11px] font-mono text-slate-500">All accounts have the same access</div>
            </div>

            {/* Metric 3: Aggregate Bandwidth */}
            <div className="p-4 rounded-xl bg-dark-card border border-dark-border relative overflow-hidden group hover:border-dark-border/80 transition-all shadow-lg">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-xs font-mono">Live Line-Rate (Throughput)</span>
                <Activity className="w-4 h-4 text-neon-emerald" />
              </div>
              <div className="flex items-baseline space-x-2">
                <span className="text-2xl font-bold text-slate-100 font-mono tabular-nums">{dash(totalBandwidth)}</span>
                <span className="text-xs text-slate-400 font-mono">MB/s</span>
              </div>
              {haveRates ? (
                <div className="mt-3 flex items-center justify-between text-[11px] font-mono text-slate-400">
                  <span className="text-neon-cyan flex items-center space-x-1">
                    <ArrowDownLeft className="w-3 h-3" />
                    <span className="tabular-nums">RX: {rxBandwidth} MB/s</span>
                  </span>
                  <span className="text-neon-indigo flex items-center space-x-1">
                    <ArrowUpRight className="w-3 h-3" />
                    <span className="tabular-nums">TX: {txBandwidth} MB/s</span>
                  </span>
                </div>
              ) : (
                <div className="mt-3 text-[11px] font-mono text-slate-500">Needs two samples a minute apart</div>
              )}
            </div>

            {/* Metric 4: Posture Health Score */}
            <div className="p-4 rounded-xl bg-dark-card border border-dark-border relative overflow-hidden group hover:border-dark-border/80 transition-all shadow-lg">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-xs font-mono">Mesh Posture Score</span>
                <ShieldCheck className="w-4 h-4 text-neon-emerald" />
              </div>
              <div className="flex items-baseline space-x-2">
                <span className={`text-2xl font-bold font-mono tabular-nums ${postureColour}`}>
                  {healthScore === null ? '—' : `${healthScore}%`}
                </span>
                <span className="text-xs text-slate-400 font-mono">{postureLabel}</span>
              </div>
              {/* This card used to print a fixed "Avg Latency: 16.2ms / Jitter: <1.2ms".
                  Neither was measured. The score below is the share of enrolled nodes
                  that answered inside the liveness window. */}
              <div className="mt-3 text-[11px] font-mono text-slate-500 tabular-nums">
                {activeNodes} of {totalNodes} reachable
                {stats?.liveness_window_seconds ? ` within ${stats.liveness_window_seconds}s` : ''}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Main Grid: Live Bandwidth Chart & Geographic Matrix */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Recharts Live Throughput Curve (2 Cols) */}
        <div className="lg:col-span-2 p-5 rounded-xl bg-dark-card border border-dark-border space-y-4 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-slate-100 flex items-center space-x-2 font-mono">
                <TrendingUp className="w-4 h-4 text-neon-cyan" />
                <span>Aggregate Network Throughput Timeseries</span>
              </h2>
              <p className="text-xs text-slate-400">Transfer rate across the fleet, sampled once a minute</p>
            </div>
            <div className="flex items-center space-x-1 bg-dark-canvas p-1 rounded-lg border border-dark-border text-xs font-mono">
              {['1h', '6h', '24h', '7d'].map((r) => (
                <button
                  key={r}
                  onClick={() => setTimeRange(r)}
                  className={`px-2.5 py-1 rounded transition-all ${
                    timeRange === r
                      ? 'bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/30'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {/* Area Chart. An empty series is a real state on a fresh deployment: the
              collector samples once a minute and needs two points to draw a rate. */}
          <div className="h-72 w-full">
            {timeseries.length === 0 ? (
              <div className="h-full w-full flex flex-col items-center justify-center text-center border border-dashed border-dark-border rounded-lg">
                <TrendingUp className="w-6 h-6 text-slate-600 mb-2" />
                <p className="text-sm text-slate-300 font-mono">No samples in this range yet</p>
                <p className="text-xs text-slate-500 mt-1 max-w-xs">
                  Throughput is sampled once a minute. Two samples are needed before a rate can be drawn.
                </p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeseries} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorRx" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.0} />
                    </linearGradient>
                    <linearGradient id="colorTx" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis
                    dataKey="time"
                    stroke="#71717a"
                    tick={{ fill: '#71717a', fontSize: 11, fontFamily: 'monospace' }}
                  />
                  <YAxis
                    stroke="#71717a"
                    tick={{ fill: '#71717a', fontSize: 11, fontFamily: 'monospace' }}
                    unit=" MB/s"
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="rx"
                    stroke="#06b6d4"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorRx)"
                    name="Inbound (RX)"
                  />
                  <Area
                    type="monotone"
                    dataKey="tx"
                    stroke="#6366f1"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorTx)"
                    name="Outbound (TX)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="flex items-center justify-between text-xs font-mono text-slate-400 pt-2 border-t border-dark-border/80">
            <div className="flex items-center space-x-4">
              <span className="flex items-center space-x-1.5 text-neon-cyan">
                <span className="w-2.5 h-2.5 rounded-full bg-neon-cyan"></span>
                <span>Inbound (RX)</span>
              </span>
              <span className="flex items-center space-x-1.5 text-neon-indigo">
                <span className="w-2.5 h-2.5 rounded-full bg-neon-indigo"></span>
                <span>Outbound (TX)</span>
              </span>
            </div>
            {/* Was a hardcoded "14.89 TB". This is the sum of the counters the nodes
                report, which is a lifetime total rather than a figure for the range. */}
            <span>
              Transferred since enrolment:{' '}
              <strong className="tabular-nums">{formatBytes(stats?.total_bandwidth_bytes)}</strong>
            </span>
          </div>
        </div>

        {/* Right: Geographic Distribution Matrix (1 Col) */}
        <div className="p-5 rounded-xl bg-dark-card border border-dark-border space-y-4 shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-100 flex items-center space-x-2 font-mono">
                <Globe2 className="w-4 h-4 text-neon-indigo" />
                <span>Geographic Matrix</span>
              </h2>
              <span className="text-[10px] font-mono text-slate-400 tabular-nums">
                {geoMatrix.length} {geoMatrix.length === 1 ? 'Country' : 'Countries'}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">Where the enrolled nodes are</p>
          </div>

          <div className="space-y-3 my-2 overflow-y-auto max-h-72 pr-1">
            {geoMatrix.length === 0 && (
              <div className="p-4 text-center border border-dashed border-dark-border rounded-lg">
                <p className="text-sm text-slate-300 font-mono">No nodes enrolled</p>
                <p className="text-xs text-slate-500 mt-1">Countries appear here once a node registers from one.</p>
              </div>
            )}
            {geoMatrix.map((g) => (
              <div
                key={g.code}
                className="p-3 rounded-lg bg-dark-canvas border border-dark-border flex items-center justify-between text-xs font-mono hover:border-dark-border/80 transition-colors"
              >
                <div className="min-w-0">
                  <div className="font-bold text-slate-200 flex items-baseline gap-1.5">
                    <span className="truncate">{g.country}</span>
                    <span className="text-[10px] text-slate-500 font-normal shrink-0">{g.code}</span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums whitespace-nowrap">
                    {g.live}/{g.nodes} up
                    {g.relays > 0 && <> &bull; {g.relays} relay</>}
                    {g.exits > 0 && <> &bull; {g.exits} exit</>}
                  </div>
                </div>

                <div className="text-right shrink-0 ml-3">
                  {/* A null latency means no node here has reported a measurement.
                      The previous build substituted 35ms for that case. */}
                  <div className="font-bold text-neon-cyan tabular-nums whitespace-nowrap">
                    {g.avg_latency === null || g.avg_latency === undefined ? (
                      <span className="text-slate-500 font-normal text-[10px]">no RTT</span>
                    ) : (
                      `${g.avg_latency}ms`
                    )}
                  </div>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      g.status === 'Online'
                        ? 'bg-neon-emerald/20 text-neon-emerald'
                        : g.status === 'Degraded'
                          ? 'bg-neon-amber/20 text-neon-amber'
                          : 'bg-neon-rose/20 text-neon-rose'
                    }`}
                  >
                    {g.status}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* A "Multi-Path BGP Anycast — sub-millisecond route convergence" badge
              sat here. There is no BGP and no anycast in this system; relay choice
              is made by the circuit builder in the control plane. */}
        </div>
      </div>
    </div>
  );
}
