import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import {
  Shield,
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  PlusCircle,
  Bell,
  Search,
  UserCheck,
  Zap,
  Lock,
  Layers
} from 'lucide-react';

export default function Header({ onOpenEnrollModal, activeTab }) {
  const { user, role, switchRole } = useAuth();
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  // The ticker printed "RX: 88.4 MB/s | TX: 64.1 MB/s | Circuits: 142" as literal
  // text in the markup. It now reads the same endpoint the overview does.
  const [live, setLive] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.stats
        .getOverview()
        .then((s) => {
          if (!cancelled) setLive(s);
        })
        .catch(() => {
          if (!cancelled) setLive(null);
        });

    load();
    const poll = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);

  const rate = (v) => (v === null || v === undefined ? '—' : `${v} MB/s`);

  const isSuperAdmin = role === 'super-admin';

  return (
    <header className="h-16 border-b border-border bg-surface-raised/90 backdrop-blur-md sticky top-0 z-30 px-6 flex items-center justify-between">
      {/* Left Area: Search & Context Path */}
      <div className="flex items-center space-x-6">
        <div className="relative">
          <Search className="w-4 h-4 text-subtle absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search nodes, VIPs, users, audit logs..."
            className="w-72 pl-9 pr-4 py-1.5 text-xs bg-surface border border-border rounded-lg text-content placeholder-subtle focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 font-mono transition-all"
          />
        </div>

        {/* Aggregate Throughput Ticker */}
        <div className="hidden lg:flex items-center space-x-4 px-3 py-1.5 rounded-lg bg-surface border border-border/80 text-xs font-mono">
          <div className="flex items-center space-x-1.5 text-accent">
            <ArrowDownLeft className="w-3.5 h-3.5" />
            <span className="text-muted">RX:</span>
            <span className="font-bold tabular-nums">{rate(live?.total_bandwidth_rx_mb_s)}</span>
          </div>
          <span className="text-border">|</span>
          <div className="flex items-center space-x-1.5 text-info">
            <ArrowUpRight className="w-3.5 h-3.5" />
            <span className="text-muted">TX:</span>
            <span className="font-bold tabular-nums">{rate(live?.total_bandwidth_tx_mb_s)}</span>
          </div>
          <span className="text-border">|</span>
          {/* This read "Circuits: 142". Circuits are built on request and never
              stored, so there is no count to report; live nodes is a figure the
              control plane actually holds. */}
          <div className="flex items-center space-x-1.5 text-success">
            <Zap className="w-3.5 h-3.5" />
            <span className="text-muted">Nodes up:</span>
            <span className="font-bold tabular-nums">{live ? `${live.active_nodes}/${live.total_nodes}` : '—'}</span>
          </div>
        </div>
      </div>

      {/* Right Area: Role Switcher & User HUD */}
      <div className="flex items-center space-x-4">
        {/* Enroll Node Button */}
        <button
          onClick={onOpenEnrollModal}
          className="flex items-center space-x-2 px-3 py-1.5 rounded-lg bg-accent text-accent-contrast font-semibold text-xs hover:brightness-110 transition-all"
        >
          <PlusCircle className="w-3.5 h-3.5 text-surface" />
          <span>Enroll Device</span>
        </button>

        {/* Role Scoper Switcher */}
        <div className="flex items-center bg-surface border border-border rounded-lg p-1 space-x-1">
          <button
            onClick={() => switchRole('super-admin')}
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs font-mono font-medium transition-all ${
              isSuperAdmin ? 'bg-info/20 text-info border border-info/40 shadow-sm' : 'text-muted hover:text-content'
            }`}
            title="Super-Admin View: Global mesh overview, all relays and tenant nodes"
          >
            <Shield className="w-3 h-3" />
            <span>Super-Admin</span>
          </button>
          <button
            onClick={() => switchRole('user')}
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs font-mono font-medium transition-all ${
              !isSuperAdmin
                ? 'bg-success/20 text-success border border-success/40 shadow-sm'
                : 'text-muted hover:text-content'
            }`}
            title="Tenant User View: Isolated mesh scoped strictly to Alice's personal devices"
          >
            <UserCheck className="w-3 h-3" />
            <span>User (Alice)</span>
          </button>
        </div>

        {/* Notifications Bell */}
        <div className="relative">
          <button
            onClick={() => setNotificationsOpen(!notificationsOpen)}
            className="p-2 rounded-lg bg-surface border border-border text-muted hover:text-content transition-colors relative"
          >
            <Bell className="w-4 h-4" />
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-danger animate-ping"></span>
            <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-danger"></span>
          </button>

          {/* Notifications Dropdown */}
          {notificationsOpen && (
            <div className="absolute right-0 mt-2 w-80 bg-surface-raised border border-border rounded-xl shadow-2xl z-50 p-3 space-y-2">
              <div className="flex items-center justify-between pb-2 border-b border-border text-xs font-semibold">
                <span className="text-content">Security Alerts (2)</span>
                <span className="text-[10px] text-accent cursor-pointer hover:underline">Mark all read</span>
              </div>
              <div className="space-y-2 max-h-60 overflow-y-auto text-xs font-mono">
                <div className="p-2 rounded bg-danger/10 border border-danger/30 text-muted">
                  <div className="flex items-center justify-between text-[11px] text-danger font-bold">
                    <span>Posture Alert</span>
                    <span>1h ago</span>
                  </div>
                  <p className="text-[10px] text-muted mt-1">
                    Node 'compromised-kali-box' isolated: Unsigned kernel module detected.
                  </p>
                </div>
                <div className="p-2 rounded bg-warning/10 border border-warning/30 text-muted">
                  <div className="flex items-center justify-between text-[11px] text-warning font-bold">
                    <span>Battery Cutoff</span>
                    <span>3h ago</span>
                  </div>
                  <p className="text-[10px] text-muted mt-1">
                    Node 'carols-galaxy-s24-ultra' battery low (14%), exit routing disabled.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* User Identity Pill */}
        <div className="flex items-center space-x-2 pl-2 border-l border-border">
          <div className="w-7 h-7 rounded-full bg-accent flex items-center justify-center font-mono font-bold text-xs text-white">
            {user?.username?.[0]?.toUpperCase() || 'U'}
          </div>
          <div className="hidden sm:block text-left font-mono">
            <div className="text-xs font-semibold text-content">{user?.username}</div>
            <div className="text-[10px] text-muted capitalize">
              {user?.role === 'super-admin' ? 'Super admin' : 'User'}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
