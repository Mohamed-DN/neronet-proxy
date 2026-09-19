import React, { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  Globe2,
  Server,
  Share2,
  Users,
  Box,
  ShieldCheck,
  FileText,
  Settings,
  ShieldAlert,
  Cpu,
  Radio,
  Network,
  Activity,
  MapPin,
  Flame,
  ChevronDown,
  ChevronRight,
  Monitor,
  Skull,
  AlertTriangle,
  Shield
} from 'lucide-react';

import { filterNavSections } from '../services/features';

export default function Sidebar({
  activeTab,
  setActiveTab,
  features,
  nodeCount = 0,
  reachableCount = 0,
  quarantinedCount = 0,
  highRiskCount = 0,
  nukeArmed = false,
  nukeScheduledAt = null,
  onNukeClick,
  onExecuteWipe
}) {
  const reachablePct = nodeCount === 0 ? 0 : Math.round((reachableCount / nodeCount) * 100);

  const [collapsedSections, setCollapsedSections] = useState({
    mesh: false,
    compute: false,
    security: false,
    danger: false
  });

  const [timeRemaining, setTimeRemaining] = useState('');

  useEffect(() => {
    if (!nukeArmed && !nukeScheduledAt) return;

    const updateCountdown = () => {
      if (nukeScheduledAt) {
        const diff = new Date(nukeScheduledAt).getTime() - Date.now();
        if (diff <= 0) {
          setTimeRemaining('00:00:00 - TRIGGERED');
        } else {
          const hours = Math.floor(diff / (1000 * 60 * 60));
          const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
          const secs = Math.floor((diff % (1000 * 60)) / 1000);
          setTimeRemaining(
            `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
          );
        }
      } else if (nukeArmed) {
        setTimeRemaining('ARMED - INSTANT');
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [nukeArmed, nukeScheduledAt]);

  const toggleSection = (sectionKey) => {
    setCollapsedSections((prev) => ({
      ...prev,
      [sectionKey]: !prev[sectionKey]
    }));
  };

  const navSections = [
    {
      key: 'mesh',
      title: 'Mesh & Network',
      items: [
        { id: 'overview', label: 'Global Overview', icon: LayoutDashboard },
        { id: 'topology', label: '3D Mesh Topology', icon: Globe2, badge: '3D' },
        { id: 'nodes', label: 'Node Matrix', icon: Server, count: nodeCount },
        { id: 'onion', label: 'Onion & Obfuscation', icon: Shield, badge: '3-Hop' },
        { id: 'peering', label: 'Cross-Mesh Peering', icon: Network, badge: 'Ed25519' },
        { id: 'geofencing', label: 'Geo-Fencing Map', icon: MapPin, badge: 'Geo' }
      ]
    },
    {
      key: 'compute',
      title: 'Compute & Storage',
      items: [{ id: 'cloudpc', label: 'Sovereign Cloud PC', icon: Monitor, badge: 'WebRTC', feature: 'cloud_pc' }]
    },
    {
      key: 'security',
      title: 'Security & Governance',
      items: [
        { id: 'risk', label: 'Behavioral Risk Score', icon: Activity, alertCount: highRiskCount },
        { id: 'acls', label: 'Zero-Trust ACLs', icon: ShieldCheck },
        { id: 'audit', label: 'Forensic Audit Logs', icon: FileText, alertCount: quarantinedCount },
        { id: 'users', label: 'User Directory', icon: Users }
      ]
    },
    {
      key: 'danger',
      title: 'System & Danger Zone',
      items: [
        { id: 'settings', label: 'Mesh Settings', icon: Settings },
        { id: 'nuke', label: 'NeroNuke Self-Destruct', icon: Skull, danger: true, badge: '3-Tier' }
      ]
    }
  ];

  return (
    <aside className="w-64 bg-surface-raised border-r border-border flex flex-col justify-between shrink-0 h-screen sticky top-0 z-40 select-none">
      {/* Scrollable Nav Container */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {/* Brand Header */}
        <div className="p-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/40 flex items-center justify-center">
              <Radio className="w-4 h-4 text-accent animate-pulse" />
            </div>
            <div>
              <div className="font-bold text-sm tracking-wider text-content">NERONET</div>
              <div className="text-[10px] font-mono tracking-widest text-muted uppercase">Sovereign Mesh v4.0</div>
            </div>
          </div>
        </div>

        {/* PERSISTENT PINNED ☢ DESTROY NOW RED BUTTON */}
        {(nukeArmed || nukeScheduledAt) && (
          <div className="p-3 mx-3 my-2.5 rounded-xl bg-danger/15 border-2 border-danger animate-pulse-subtle shadow-2xl">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center space-x-1.5 text-xs font-bold text-danger tracking-wider">
                <Skull className="w-4 h-4 text-danger animate-bounce" />
                <span className="text-[11px] font-mono uppercase text-danger">☢ DESTROY ARMED</span>
              </div>
              <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-danger/80 text-white font-bold animate-pulse">
                PINNED
              </span>
            </div>
            <div className="text-[11px] font-mono text-danger font-bold bg-black/50 px-2 py-1 rounded border border-danger/40 text-center mb-2">
              ⏱ {timeRemaining}
            </div>
            <button
              onClick={() => {
                if (onExecuteWipe) {
                  onExecuteWipe();
                } else if (onNukeClick) {
                  onNukeClick();
                } else {
                  setActiveTab('nuke');
                }
              }}
              className="w-full py-2 px-3 rounded-lg bg-danger hover:bg-danger text-white text-xs font-bold font-mono tracking-wider uppercase transition-all flex items-center justify-center space-x-1.5 shadow-lg active:scale-95 border border-danger cursor-pointer"
            >
              <Skull className="w-4 h-4 text-white" />
              <span>☢ DESTROY NOW</span>
            </button>
          </div>
        )}

        {/* Live Status Indicator */}
        <div className="mx-3 my-2.5 p-2 rounded-lg bg-surface/80 border border-border flex items-center justify-between text-xs font-mono">
          <div className="flex items-center space-x-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-success"></span>
            </span>
            <span className="text-muted text-[11px]">CORE MESH</span>
          </div>
          <span className="text-success text-[11px] font-bold">ONLINE</span>
        </div>

        {/* Linear/Vercel Collapsible Navigation Sections */}
        <nav className="px-3 space-y-4 pb-4">
          {filterNavSections(navSections, features).map((section) => {
            const isCollapsed = collapsedSections[section.key];
            return (
              <div key={section.key} className="space-y-1">
                {/* Section Header with Collapsible Chevron */}
                <button
                  onClick={() => toggleSection(section.key)}
                  className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-mono font-semibold text-muted hover:text-content uppercase tracking-wider transition-colors"
                >
                  <span>{section.title}</span>
                  {isCollapsed ? (
                    <ChevronRight className="w-3 h-3 text-subtle" />
                  ) : (
                    <ChevronDown className="w-3 h-3 text-subtle" />
                  )}
                </button>

                {/* Section Items */}
                {!isCollapsed && (
                  <div className="space-y-0.5">
                    {section.items.map((item) => {
                      const Icon = item.icon;
                      const isActive = activeTab === item.id;
                      const isDanger = item.danger;
                      return (
                        <button
                          key={item.id}
                          onClick={() => setActiveTab(item.id)}
                          className={`w-full flex items-center justify-between px-2.5 py-2 rounded-lg text-xs font-medium transition-all group ${
                            isActive
                              ? isDanger
                                ? 'bg-danger/20 text-danger border border-danger/40'
                                : 'bg-accent/10 text-accent border border-accent/30'
                              : isDanger
                                ? 'text-danger hover:text-danger hover:bg-danger/40 border border-transparent'
                                : 'text-muted hover:text-content hover:bg-surface-hover border border-transparent'
                          }`}
                        >
                          <div className="flex items-center space-x-2.5">
                            <Icon
                              className={`w-4 h-4 transition-colors ${
                                isActive
                                  ? isDanger
                                    ? 'text-danger'
                                    : 'text-accent'
                                  : isDanger
                                    ? 'text-danger group-hover:text-danger'
                                    : 'text-subtle group-hover:text-muted'
                              }`}
                            />
                            <span className="truncate">{item.label}</span>
                          </div>

                          <div className="flex items-center space-x-1 shrink-0">
                            {item.badge && (
                              <span
                                className={`text-[9px] font-mono font-semibold px-1.5 py-0.2 rounded border ${
                                  isDanger
                                    ? 'bg-danger/40 text-danger border-danger/50'
                                    : 'bg-info/20 text-info border-info/40'
                                }`}
                              >
                                {item.badge}
                              </span>
                            )}
                            {item.count !== undefined && (
                              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-border text-muted">
                                {item.count}
                              </span>
                            )}
                            {item.alertCount > 0 && (
                              <span className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-danger/20 text-danger border border-danger/40 animate-pulse font-bold">
                                {item.alertCount}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      {/* Footer System Status
          This panel used to claim "HA Ready" beside a bar fixed at 98.4% labelled
          "Security: 98.4%". Neither figure was computed, and the deployment is a
          single control-plane instance, not a highly available one. The bar now
          shows the share of enrolled nodes that answered inside the liveness
          window, which is the one number of the three that can be measured. */}
      <div className="p-3.5 border-t border-border bg-surface/50 space-y-2.5 shrink-0">
        <div className="flex items-center justify-between text-xs text-muted font-mono">
          <span className="flex items-center space-x-1.5">
            <Cpu className="w-3.5 h-3.5 text-subtle" />
            <span className="text-[11px]">NeroNet v4</span>
          </span>
          <span className="text-[11px] font-semibold tabular-nums text-muted">
            {nodeCount === 0 ? 'No nodes' : `${reachableCount}/${nodeCount} up`}
          </span>
        </div>
        <div
          className="w-full bg-border rounded-full h-1.5 overflow-hidden"
          role="progressbar"
          aria-valuenow={reachablePct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Nodes reachable"
        >
          <div
            className={`h-full transition-[width] duration-500 ${
              reachablePct === 100 ? 'bg-success' : reachablePct >= 80 ? 'bg-warning' : 'bg-danger'
            }`}
            style={{ width: `${reachablePct}%` }}
          ></div>
        </div>
        <div className="flex justify-between text-[9px] font-mono text-subtle">
          <span>Reachable: {nodeCount === 0 ? 'n/a' : `${reachablePct}%`}</span>
          <span>{quarantinedCount > 0 ? `${quarantinedCount} quarantined` : 'None quarantined'}</span>
        </div>
      </div>
    </aside>
  );
}
