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
        <div className="p-3 bg-surface-raised/95 border border-border rounded-xl shadow-2xl backdrop-blur-md text-xs font-mono">
          <div className="text-muted mb-1 flex items-center space-x-1.5">
            <Clock className="w-3 h-3 text-subtle" />
            <span>Time: {label}</span>
          </div>
          <div className="text-accent flex items-center justify-between space-x-4">
            <span>Inbound (RX):</span>
            <span className="font-bold">{payload[0]?.value} MB/s</span>
          </div>
          <div className="text-info flex items-center justify-between space-x-4">
            <span>Outbound (TX):</span>
            <span className="font-bold">{payload[1]?.value} MB/s</span>
          </div>
          {payload[0]?.payload?.latency && (
            <div className="text-success flex items-center justify-between space-x-4 pt-1 mt-1 border-t border-border">
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
          <h1 className="text-xl font-bold text-content flex items-center flex-wrap gap-x-2 gap-y-1">
            <span>Mesh Overview</span>
            <span
              className={`text-xs font-mono font-normal px-2 py-0.5 rounded border ${
                loadError ? 'bg-danger/20 text-danger border-danger/40' : 'bg-success/20 text-success border-success/40'
              }`}
            >
              {loadError ? 'Control plane unreachable' : 'Live'}
            </span>
          </h1>
          <p className="text-xs text-muted mt-1">Enrolled devices, what they are transferring, and where they are.</p>
        </div>
        <div className="flex items-center space-x-2">
          <button
            onClick={() => onNavigateTab && onNavigateTab('topology')}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-surface border border-border text-muted hover:text-accent hover:border-accent/40 text-xs font-mono transition-all"
          >
            <Globe2 className="w-3.5 h-3.5" />
            <span>View 3D Topology</span>
          </button>
        </div>
      </div>

      {loadError && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-danger/10 border border-danger/30">
          <AlertTriangle className="w-4 h-4 text-danger shrink-0 mt-0.5" />
          <div className="text-xs">
            <p className="text-danger font-mono font-bold">Figures below may be stale</p>
            <p className="text-muted mt-0.5">{loadError}</p>
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
            ? 'text-muted'
            : healthScore === 100
              ? 'text-success'
              : healthScore >= 80
                ? 'text-warning'
                : 'text-danger';

        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Metric 1: Nodes */}
            <div className="p-4 rounded-xl bg-surface-raised border border-border relative overflow-hidden group hover:border-border/80 transition-all shadow-lg">
              <div className="flex items-center justify-between text-muted mb-2">
                <span className="text-xs font-mono">Active Sovereign Nodes</span>
                <Server className="w-4 h-4 text-accent" />
              </div>
              <div className="flex items-baseline space-x-2">
                <span className="text-2xl font-bold text-content font-mono">{activeNodes}</span>
                <span className="text-xs text-subtle font-mono">/ {totalNodes} Enrolled</span>
              </div>
              <div className="mt-3 space-y-1 text-[11px] font-mono">
                <div className="flex items-center justify-between">
                  <span className="text-success flex items-center space-x-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-success"></span>
                    <span>{dash(verifiedCompliantNodes)} posture verified</span>
                  </span>
                  <span className="text-muted flex items-center space-x-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-border-strong"></span>
                    <span>{dash(unverifiedNodes)} unverified</span>
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-warning flex items-center space-x-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-warning"></span>
                    <span>{dash(nonCompliantNodes)} non-compliant</span>
                  </span>
                  <span className="text-danger flex items-center space-x-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-danger"></span>
                    <span>{quarantinedNodes} quarantined</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Metric 2: Users */}
            <div className="p-4 rounded-xl bg-surface-raised border border-border relative overflow-hidden group hover:border-border/80 transition-all shadow-lg">
              <div className="flex items-center justify-between text-muted mb-2">
                <span className="text-xs font-mono">Total Users</span>
                <Users className="w-4 h-4 text-info" />
              </div>
              <div className="flex items-baseline space-x-2">
                <span className="text-2xl font-bold text-content font-mono">{activeUsers}</span>
                <span className="text-xs text-subtle font-mono">Active Tenants</span>
              </div>
              {/* This used to print activeUsers/2 as "Hybrid BYOS" and the other half as
                  "Cloud Managed" — a made-up split, not a count of anything. There are
                  no tiers now, and there was never data behind that line. */}
              <div className="mt-3 text-[11px] font-mono text-subtle">All accounts have the same access</div>
            </div>

            {/* Metric 3: Aggregate Bandwidth */}
            <div className="p-4 rounded-xl bg-surface-raised border border-border relative overflow-hidden group hover:border-border/80 transition-all shadow-lg">
              <div className="flex items-center justify-between text-muted mb-2">
                <span className="text-xs font-mono">Live Line-Rate (Throughput)</span>
                <Activity className="w-4 h-4 text-success" />
              </div>
              <div className="flex items-baseline space-x-2">
                <span className="text-2xl font-bold text-content font-mono tabular-nums">{dash(totalBandwidth)}</span>
                <span className="text-xs text-muted font-mono">MB/s</span>
              </div>
              {haveRates ? (
                <div className="mt-3 flex items-center justify-between text-[11px] font-mono text-muted">
                  <span className="text-accent flex items-center space-x-1">
                    <ArrowDownLeft className="w-3 h-3" />
                    <span className="tabular-nums">RX: {rxBandwidth} MB/s</span>
                  </span>
                  <span className="text-info flex items-center space-x-1">
                    <ArrowUpRight className="w-3 h-3" />
                    <span className="tabular-nums">TX: {txBandwidth} MB/s</span>
                  </span>
                </div>
              ) : (
                <div className="mt-3 text-[11px] font-mono text-subtle">Needs two samples a minute apart</div>
              )}
            </div>

            {/* Metric 4: Posture Health Score */}
            <div className="p-4 rounded-xl bg-surface-raised border border-border relative overflow-hidden group hover:border-border/80 transition-all shadow-lg">
              <div className="flex items-center justify-between text-muted mb-2">
                <span className="text-xs font-mono">Mesh Posture Score</span>
                <ShieldCheck className="w-4 h-4 text-success" />
              </div>
              <div className="flex items-baseline space-x-2">
                <span className={`text-2xl font-bold font-mono tabular-nums ${postureColour}`}>
                  {healthScore === null ? '—' : `${healthScore}%`}
                </span>
                <span className="text-xs text-muted font-mono">{postureLabel}</span>
              </div>
              {/* This card used to print a fixed "Avg Latency: 16.2ms / Jitter: <1.2ms".
                  Neither was measured. The score below is the share of enrolled nodes
                  that answered inside the liveness window. */}
              <div className="mt-3 text-[11px] font-mono text-subtle tabular-nums">
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
        <div className="lg:col-span-2 p-5 rounded-xl bg-surface-raised border border-border space-y-4 shadow-xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-bold text-content flex items-center space-x-2 font-mono">
                <TrendingUp className="w-4 h-4 text-accent" />
                <span>Aggregate Network Throughput Timeseries</span>
              </h2>
              <p className="text-xs text-muted">Transfer rate across the fleet, sampled once a minute</p>
            </div>
            <div className="flex items-center space-x-1 bg-surface p-1 rounded-lg border border-border text-xs font-mono">
              {['1h', '6h', '24h', '7d'].map((r) => (
                <button
                  key={r}
                  onClick={() => setTimeRange(r)}
                  className={`px-2.5 py-1 rounded transition-all ${
                    timeRange === r
                      ? 'bg-accent/20 text-accent border border-accent/30'
                      : 'text-subtle hover:text-muted'
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
              <div className="h-full w-full flex flex-col items-center justify-center text-center border border-dashed border-border rounded-lg">
                <TrendingUp className="w-6 h-6 text-subtle mb-2" />
                <p className="text-sm text-muted font-mono">No samples in this range yet</p>
                <p className="text-xs text-subtle mt-1 max-w-xs">
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

          <div className="flex items-center justify-between text-xs font-mono text-muted pt-2 border-t border-border/80">
            <div className="flex items-center space-x-4">
              <span className="flex items-center space-x-1.5 text-accent">
                <span className="w-2.5 h-2.5 rounded-full bg-accent"></span>
                <span>Inbound (RX)</span>
              </span>
              <span className="flex items-center space-x-1.5 text-info">
                <span className="w-2.5 h-2.5 rounded-full bg-info"></span>
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
        <div className="p-5 rounded-xl bg-surface-raised border border-border space-y-4 shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-content flex items-center space-x-2 font-mono">
                <Globe2 className="w-4 h-4 text-info" />
                <span>Geographic Matrix</span>
              </h2>
              <span className="text-[10px] font-mono text-muted tabular-nums">
                {geoMatrix.length} {geoMatrix.length === 1 ? 'Country' : 'Countries'}
              </span>
            </div>
            <p className="text-xs text-muted mt-1">Where the enrolled nodes are</p>
          </div>

          <div className="space-y-3 my-2 overflow-y-auto max-h-72 pr-1">
            {geoMatrix.length === 0 && (
              <div className="p-4 text-center border border-dashed border-border rounded-lg">
                <p className="text-sm text-muted font-mono">No nodes enrolled</p>
                <p className="text-xs text-subtle mt-1">Countries appear here once a node registers from one.</p>
              </div>
            )}
            {geoMatrix.map((g) => (
              <div
                key={g.code}
                className="p-3 rounded-lg bg-surface border border-border flex items-center justify-between text-xs font-mono hover:border-border/80 transition-colors"
              >
                <div className="min-w-0">
                  <div className="font-bold text-content flex items-baseline gap-1.5">
                    <span className="truncate">{g.country}</span>
                    <span className="text-[10px] text-subtle font-normal shrink-0">{g.code}</span>
                  </div>
                  <div className="text-[11px] text-muted mt-0.5 tabular-nums whitespace-nowrap">
                    {g.live}/{g.nodes} up
                    {g.relays > 0 && <> &bull; {g.relays} relay</>}
                    {g.exits > 0 && <> &bull; {g.exits} exit</>}
                  </div>
                </div>

                <div className="text-right shrink-0 ml-3">
                  {/* A null latency means no node here has reported a measurement.
                      The previous build substituted 35ms for that case. */}
                  <div className="font-bold text-accent tabular-nums whitespace-nowrap">
                    {g.avg_latency === null || g.avg_latency === undefined ? (
                      <span className="text-subtle font-normal text-[10px]">no RTT</span>
                    ) : (
                      `${g.avg_latency}ms`
                    )}
                  </div>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      g.status === 'Online'
                        ? 'bg-success/20 text-success'
                        : g.status === 'Degraded'
                          ? 'bg-warning/20 text-warning'
                          : 'bg-danger/20 text-danger'
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
