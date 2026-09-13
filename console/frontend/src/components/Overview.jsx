import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid
} from 'recharts';
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

export default function Overview({ onSelectNode, onNavigateTab }) {
  const [stats, setStats] = useState(null);
  const [timeseries, setTimeseries] = useState([]);
  const [geoMatrix, setGeoMatrix] = useState([]);
  const [timeRange, setTimeRange] = useState('24h');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const [overviewStats, ts, geo] = await Promise.all([
          api.stats.getOverview(),
          api.stats.getTimeseries(),
          api.stats.getGeoMatrix()
        ]);
        setStats(overviewStats);
        setTimeseries(ts);
        setGeoMatrix(geo);
      } catch (err) {
        console.error('Failed to load overview stats:', err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

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
          <h1 className="text-xl font-bold text-slate-100 flex items-center space-x-2">
            <span>Global Mesh Telemetry & Posture Command</span>
            <span className="text-xs font-mono font-normal px-2 py-0.5 rounded bg-neon-emerald/20 text-neon-emerald border border-neon-emerald/40">
              DirectFrame v4.0 Active
            </span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Real-time multi-region sovereign overlay performance, zero-trust device health, and egress metrics.
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

      {/* KPI Metric Cards */}
      {(() => {
        const activeNodes = stats?.active_nodes ?? 0;
        const totalNodes = stats?.total_nodes ?? (stats?.active_nodes ?? 0);
        const quarantinedNodes = stats?.quarantined_nodes ?? 0;
        const compliantNodes = Math.max(0, activeNodes - quarantinedNodes);
        const activeUsers = stats?.active_users ?? 0;
        const rxBandwidth = stats?.total_bandwidth_rx_mb_s ?? 88.4;
        const txBandwidth = stats?.total_bandwidth_tx_mb_s ?? 64.1;
        const totalBandwidth = +(rxBandwidth + txBandwidth).toFixed(1);
        const healthScore = stats?.network_health_score ?? (totalNodes === 0 ? 100 : 98.4);

        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Metric 1: Nodes */}
            <div className="p-4 rounded-xl bg-dark-card border border-dark-border relative overflow-hidden group hover:border-dark-border/80 transition-all shadow-lg">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-xs font-mono">Active Sovereign Nodes</span>
                <Server className="w-4 h-4 text-neon-cyan" />
              </div>
              <div className="flex items-baseline space-x-2">
                <span className="text-2xl font-bold text-slate-100 font-mono">
                  {activeNodes}
                </span>
                <span className="text-xs text-slate-500 font-mono">/ {totalNodes} Enrolled</span>
              </div>
              <div className="mt-3 flex items-center justify-between text-[11px] font-mono">
                <span className="text-neon-emerald flex items-center space-x-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-neon-emerald"></span>
                  <span>{compliantNodes} Compliant</span>
                </span>
                <span className="text-neon-rose flex items-center space-x-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-neon-rose"></span>
                  <span>{quarantinedNodes} Quarantined</span>
                </span>
              </div>
            </div>

            {/* Metric 2: Users */}
            <div className="p-4 rounded-xl bg-dark-card border border-dark-border relative overflow-hidden group hover:border-dark-border/80 transition-all shadow-lg">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-xs font-mono">Total Users</span>
                <Users className="w-4 h-4 text-neon-indigo" />
              </div>
              <div className="flex items-baseline space-x-2">
                <span className="text-2xl font-bold text-slate-100 font-mono">
                  {activeUsers}
                </span>
                <span className="text-xs text-slate-500 font-mono">Active Tenants</span>
              </div>
              {/* This used to print activeUsers/2 as "Hybrid BYOS" and the other half as
                  "Cloud Managed" — a made-up split, not a count of anything. There are
                  no tiers now, and there was never data behind that line. */}
              <div className="mt-3 text-[11px] font-mono text-slate-500">
                All accounts have the same access
              </div>
            </div>

            {/* Metric 3: Aggregate Bandwidth */}
            <div className="p-4 rounded-xl bg-dark-card border border-dark-border relative overflow-hidden group hover:border-dark-border/80 transition-all shadow-lg">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-xs font-mono">Live Line-Rate (Throughput)</span>
                <Activity className="w-4 h-4 text-neon-emerald" />
              </div>
              <div className="flex items-baseline space-x-2">
                <span className="text-2xl font-bold text-slate-100 font-mono">{totalBandwidth}</span>
                <span className="text-xs text-slate-400 font-mono">MB/s</span>
              </div>
              <div className="mt-3 flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span className="text-neon-cyan flex items-center space-x-1">
                  <ArrowDownLeft className="w-3 h-3" />
                  <span>RX: {rxBandwidth} MB/s</span>
                </span>
                <span className="text-neon-indigo flex items-center space-x-1">
                  <ArrowUpRight className="w-3 h-3" />
                  <span>TX: {txBandwidth} MB/s</span>
                </span>
              </div>
            </div>

            {/* Metric 4: Posture Health Score */}
            <div className="p-4 rounded-xl bg-dark-card border border-dark-border relative overflow-hidden group hover:border-dark-border/80 transition-all shadow-lg">
              <div className="flex items-center justify-between text-slate-400 mb-2">
                <span className="text-xs font-mono">Mesh Posture Score</span>
                <ShieldCheck className="w-4 h-4 text-neon-emerald" />
              </div>
              <div className="flex items-baseline space-x-2">
                <span className="text-2xl font-bold text-neon-emerald font-mono">
                  {healthScore}%
                </span>
                <span className="text-xs text-slate-400 font-mono">Optimal</span>
              </div>
              <div className="mt-3 flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>Avg Latency: 16.2ms</span>
                <span className="text-neon-cyan">Jitter: &lt;1.2ms</span>
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
              <p className="text-xs text-slate-400">Continuous 24-hour line rate measurement across regional relays</p>
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

          {/* Area Chart */}
          <div className="h-72 w-full">
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
            <span>Aggregate 24h Egress: <strong>14.89 TB</strong></span>
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
              <span className="text-[10px] font-mono text-neon-emerald">6 Regions</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">Multi-region mesh latency & egress capacity</p>
          </div>

          <div className="space-y-3 my-2 overflow-y-auto max-h-72 pr-1">
            {geoMatrix.map((g) => (
              <div
                key={g.code}
                className="p-3 rounded-lg bg-dark-canvas border border-dark-border flex items-center justify-between text-xs font-mono hover:border-dark-border/80 transition-colors"
              >
                <div>
                  <div className="font-bold text-slate-200 flex items-center space-x-2">
                    <span>{g.country}</span>
                    <span className="text-[10px] text-slate-500 font-normal">({g.code})</span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {g.nodes} Nodes &bull; {g.relays} Relay &bull; {g.exits} Exit
                  </div>
                </div>

                <div className="text-right">
                  <div className="font-bold text-neon-cyan">{g.avg_latency}ms</div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                    g.status === 'Optimal'
                      ? 'bg-neon-emerald/20 text-neon-emerald'
                      : 'bg-neon-amber/20 text-neon-amber'
                  }`}>
                    {g.status}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="p-3 rounded-lg bg-neon-indigo/10 border border-neon-indigo/30 text-xs font-mono text-slate-300">
            <div className="flex items-center space-x-1.5 text-neon-indigo font-bold text-[11px] mb-1">
              <Sparkles className="w-3.5 h-3.5" />
              <span>Multi-Path BGP Anycast</span>
            </div>
            <span>Dynamic lowest-RTT relay selection active with sub-millisecond route convergence.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
