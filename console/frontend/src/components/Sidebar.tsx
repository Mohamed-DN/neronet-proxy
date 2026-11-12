import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, NavLink } from 'react-router';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Cpu,
  FileText,
  Globe2,
  Boxes,
  LayoutDashboard,
  Monitor,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Skull,
  UserRound,
  Users,
  type LucideIcon
} from 'lucide-react';

import { useAuth } from '../context/AuthContext';
import { filterNavSections } from '../services/features.js';
import type { Features } from '../services/types';
import { canSee, effectiveRole, type PageId } from '../services/roles';
import { ROUTES, type RouteId } from '../routes/paths';
import { cn, IconButton } from '../ui';

const COLLAPSE_KEY = 'neronet_sidebar_collapsed';

/*
 * Every route id is a page id. The compiler rejects a route that has no entry
 * here, so a page cannot appear in the navigation without its role being
 * decided in services/roles.ts.
 */
const PAGE_OF: Record<RouteId, PageId> = {
  overview: 'overview',
  topology: 'topology',
  subnets: 'subnets',
  nodes: 'nodes',
  onion: 'onion',
  peering: 'peering',
  cloudpc: 'cloudpc',
  risk: 'risk',
  acls: 'acls',
  audit: 'audit',
  users: 'users',
  settings: 'settings',
  nuke: 'nuke',
  me: 'me',
  meAdd: 'meAdd',
  glossary: 'glossary'
};

interface NavItem {
  id: RouteId;
  icon: LucideIcon;
  count?: number;
  alertCount?: number;
  danger?: boolean;
  feature?: keyof Features;
}

interface NavSection {
  key: string;
  items: NavItem[];
}

export interface SidebarProps {
  features: Features;
  nodeCount?: number;
  reachableCount?: number;
  quarantinedCount?: number;
  highRiskCount?: number;
  nukeArmed?: boolean;
  nukeScheduledAt?: string | null;
  onExecuteWipe?: () => void;
}

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === 'true';
  } catch {
    return false;
  }
}

export default function Sidebar({
  features,
  nodeCount = 0,
  reachableCount = 0,
  quarantinedCount = 0,
  highRiskCount = 0,
  nukeArmed = false,
  nukeScheduledAt = null,
  onExecuteWipe
}: SidebarProps) {
  const { t } = useTranslation('chrome');
  const { user } = useAuth();
  const role = effectiveRole(user);
  const reachablePct = nodeCount === 0 ? 0 : Math.round((reachableCount / nodeCount) * 100);

  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    mesh: false,
    compute: false,
    security: false,
    danger: false,
    you: false
  });
  const [timeRemaining, setTimeRemaining] = useState('');

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, String(collapsed));
    } catch {
      // The choice still applies to this session.
    }
  }, [collapsed]);

  useEffect(() => {
    if (!nukeArmed && !nukeScheduledAt) return;

    const updateCountdown = () => {
      if (nukeScheduledAt) {
        const diff = new Date(nukeScheduledAt).getTime() - Date.now();
        if (diff <= 0) {
          setTimeRemaining(t('sidebar.triggered'));
        } else {
          const hours = Math.floor(diff / (1000 * 60 * 60));
          const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
          const secs = Math.floor((diff % (1000 * 60)) / 1000);
          setTimeRemaining(
            `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
          );
        }
      } else if (nukeArmed) {
        setTimeRemaining(t('sidebar.armedInstant'));
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [nukeArmed, nukeScheduledAt, t]);

  const toggleSection = (sectionKey: string) => {
    setCollapsedSections((prev) => ({ ...prev, [sectionKey]: !prev[sectionKey] }));
  };

  const navSections: NavSection[] = [
    {
      key: 'mesh',
      items: [
        { id: 'overview', icon: LayoutDashboard },
        { id: 'topology', icon: Globe2 },
        { id: 'subnets', icon: Boxes },
        { id: 'nodes', icon: Server, count: nodeCount },
        { id: 'onion', icon: Shield },
        { id: 'peering', icon: Network }
      ]
    },
    {
      key: 'compute',
      items: [{ id: 'cloudpc', icon: Monitor, feature: 'cloud_pc' }]
    },
    {
      key: 'security',
      items: [
        { id: 'risk', icon: Activity, alertCount: highRiskCount },
        { id: 'acls', icon: ShieldCheck },
        { id: 'audit', icon: FileText, alertCount: quarantinedCount },
        { id: 'users', icon: Users }
      ]
    },
    {
      key: 'danger',
      items: [
        { id: 'settings', icon: Settings },
        { id: 'nuke', icon: Skull, danger: true }
      ]
    },
    {
      key: 'you',
      items: [{ id: 'me', icon: UserRound }]
    }
  ];

  // The role decides what is listed; the server still refuses what it must.
  const visibleSections = navSections.map((section) => ({
    ...section,
    items: section.items.filter((item) => canSee(PAGE_OF[item.id], role, features))
  }));
  const sections = filterNavSections(visibleSections, features) as NavSection[];

  return (
    <aside
      data-shell-sidebar
      className={cn(
        // The column stretches to the height of the page (flex default), so
        // the panel and its rule run to the bottom of a long page.
        'z-drawer shrink-0 select-none self-stretch',
        'border-r border-border bg-surface-raised transition-[width]',
        collapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* The content stays in view while the page scrolls. It is capped at the
          window height with max-h, never sized by it, so a tall page cannot
          feed back into its own height. */}
      <div data-shell-sidebar-inner className="sticky top-0 flex h-full max-h-screen flex-col justify-between">
        <div className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="flex items-center justify-between gap-2 border-b border-border p-4">
            {!collapsed && (
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-accent/40 bg-accent/10">
                  <Radio aria-hidden="true" className="h-4 w-4 text-accent" />
                </div>
                <div className="min-w-0">
                  <div className="truncate text-body font-bold tracking-wider text-content">{t('brand.name')}</div>
                  <div className="truncate text-caption text-muted">{t('brand.tagline')}</div>
                </div>
              </div>
            )}
            <IconButton
              label={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
              icon={collapsed ? PanelLeftOpen : PanelLeftClose}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((prev) => !prev)}
            />
          </div>

          {(nukeArmed || nukeScheduledAt) && !collapsed && (
            <div className="mx-3 my-2.5 space-y-2 rounded-xl border-2 border-danger bg-danger/15 p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-caption font-semibold text-danger">
                  <Skull aria-hidden="true" className="h-4 w-4" />
                  {t('sidebar.armed')}
                </span>
                <span className="rounded-sm bg-danger px-1.5 py-0.5 text-micro font-semibold text-danger-contrast">
                  {t('sidebar.armedPinned')}
                </span>
              </div>
              <div className="rounded-sm border border-danger/40 bg-surface px-2 py-1 text-center text-micro font-semibold tabular-nums text-danger">
                {timeRemaining}
              </div>
              <button
                type="button"
                onClick={onExecuteWipe}
                className="flex w-full items-center justify-center gap-1.5 rounded-control border border-danger bg-danger px-3 py-2 text-caption font-semibold text-danger-contrast transition-colors hover:bg-danger-strong focus-visible:outline-focus"
              >
                <Skull aria-hidden="true" className="h-4 w-4" />
                <span>{t('sidebar.destroyNow')}</span>
              </button>
            </div>
          )}

          <nav aria-label={t('nav.landmark')} className="space-y-4 px-3 pb-4 pt-2">
            {sections.map((section) => {
              const isCollapsed = collapsedSections[section.key];
              return (
                <div key={section.key} className="space-y-1">
                  {!collapsed && (
                    <button
                      type="button"
                      onClick={() => toggleSection(section.key)}
                      aria-expanded={!isCollapsed}
                      className="flex w-full items-center justify-between px-2 py-1 text-caption font-medium text-subtle transition-colors hover:text-content focus-visible:outline-focus"
                    >
                      <span>{t(`nav.sections.${section.key}`)}</span>
                      {isCollapsed ? (
                        <ChevronRight aria-hidden="true" className="h-3 w-3 text-subtle" />
                      ) : (
                        <ChevronDown aria-hidden="true" className="h-3 w-3 text-subtle" />
                      )}
                    </button>
                  )}

                  {(!isCollapsed || collapsed) && (
                    <div className="space-y-0.5">
                      {section.items.map((item) => {
                        const Icon = item.icon;
                        const label = t(`nav.items.${item.id}`);
                        return (
                          <NavLink
                            key={item.id}
                            to={ROUTES[item.id]}
                            title={collapsed ? label : undefined}
                            className={({ isActive }) =>
                              cn(
                                'relative flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-caption font-medium transition-colors focus-visible:outline-focus',
                                isActive
                                  ? cn(
                                      'before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full',
                                      item.danger ? 'text-danger before:bg-danger' : 'text-accent before:bg-accent'
                                    )
                                  : item.danger
                                    ? 'text-danger hover:bg-danger/10'
                                    : 'text-muted hover:bg-surface-hover hover:text-content'
                              )
                            }
                          >
                            <span className="flex min-w-0 items-center gap-2.5">
                              <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                              <span className={cn('truncate', collapsed && 'sr-only')}>{label}</span>
                            </span>

                            {!collapsed && (
                              <span className="flex shrink-0 items-center gap-1">
                                {item.count !== undefined && (
                                  <span className="rounded-sm bg-border px-1.5 text-micro tabular-nums text-muted">
                                    {item.count}
                                  </span>
                                )}
                                {item.alertCount !== undefined && item.alertCount > 0 && (
                                  <span className="rounded-sm border border-danger/40 bg-danger-subtle px-1.5 text-micro font-semibold tabular-nums text-danger">
                                    {item.alertCount}
                                    <span className="sr-only"> {t('nav.alertCount', { count: item.alertCount })}</span>
                                  </span>
                                )}
                              </span>
                            )}
                          </NavLink>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
        </div>

        {/* The bar shows the share of enrolled devices that answered inside the
          liveness window. It used to show a constant 98.4% labelled "Security",
          beside an "HA Ready" claim for a single-instance deployment. */}
        {!collapsed && (
          <div className="shrink-0 space-y-2.5 border-t border-border bg-surface/50 p-3.5">
            <div className="flex items-center justify-between text-caption text-muted">
              <span className="flex items-center gap-1.5">
                <Cpu aria-hidden="true" className="h-3.5 w-3.5 text-subtle" />
                <span className="text-micro">{t('brand.tagline')}</span>
              </span>
              <span className="text-micro font-semibold tabular-nums">
                {nodeCount === 0
                  ? t('sidebar.noNodes')
                  : t('sidebar.nodesReachable', { reachable: reachableCount, total: nodeCount })}
              </span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-border"
              role="progressbar"
              aria-valuenow={reachablePct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={t('sidebar.reachabilityBar')}
            >
              <div
                className={cn(
                  'h-full transition-[width] duration-500',
                  reachablePct === 100 ? 'bg-success' : reachablePct >= 80 ? 'bg-warning' : 'bg-danger'
                )}
                style={{ width: `${reachablePct}%` }}
              />
            </div>
            <div className="flex justify-between text-micro text-subtle">
              <span>
                {nodeCount === 0
                  ? t('sidebar.reachableUnknown')
                  : t('sidebar.reachable', { percent: `${reachablePct}%` })}
              </span>
              <span>
                {quarantinedCount > 0
                  ? t('sidebar.quarantined', { count: quarantinedCount })
                  : t('sidebar.noneQuarantined')}
              </span>
            </div>
            <Link
              to={ROUTES.glossary}
              className="inline-flex min-h-6 items-center rounded-sm text-micro text-muted underline hover:text-content focus-visible:outline-focus"
            >
              {t('sidebar.glossaryLink')}
            </Link>
          </div>
        )}
      </div>
    </aside>
  );
}
