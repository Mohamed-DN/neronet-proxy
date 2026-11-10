import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownLeft, ArrowUpRight, Bell, LogOut, PlusCircle, Zap } from 'lucide-react';

import { useAuth } from '../context/AuthContext';
import { useStatsOverview } from '../services/queries';
import { effectiveRole, roleTier } from '../services/roles';
import { Button, LanguageSwitcher, NotMeasured, ThemeToggle } from '../ui';

export interface HeaderProps {
  onOpenEnrollModal?: () => void;
}

export default function Header({ onOpenEnrollModal }: HeaderProps) {
  const { t } = useTranslation('chrome');
  const { t: tGlossary } = useTranslation('glossary');
  const { user, logout } = useAuth();
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  // The ticker printed "RX: 88.4 MB/s | TX: 64.1 MB/s | Circuits: 142" as
  // literal text in the markup. It now reads the same query the overview does,
  // and draws "not measured" where the control plane has no rate to report:
  // the rate is null until the collector has two samples to derive it from.
  const overview = useStatsOverview();
  const stats = overview.status === 'success' ? overview.data : null;

  const rate = (value: number | null | undefined) =>
    typeof value === 'number' ? <span className="font-bold tabular-nums">{value} MiB/s</span> : <NotMeasured />;

  const role = effectiveRole(user);
  // A read-only role has nothing to add, so the action is not offered to it.
  const canAdd = roleTier(role) !== 'read';

  return (
    <header className="console-header sticky top-0 z-sticky flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-raised px-6 py-2">
      <div className="flex min-w-0 items-center gap-6">
        <div
          aria-label={t('header.throughput')}
          className="console-header-throughput hidden items-center gap-4 rounded-control border border-border bg-surface-sunken px-3 py-1.5 text-caption lg:flex"
        >
          <span className="flex items-center gap-1.5 text-content">
            <ArrowDownLeft aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
            <span className="text-muted">{t('header.rx')}:</span>
            {rate(stats?.total_bandwidth_rx_mb_s)}
          </span>
          <span aria-hidden="true" className="text-border">
            |
          </span>
          <span className="flex items-center gap-1.5 text-content">
            <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 text-info" />
            <span className="text-muted">{t('header.tx')}:</span>
            {rate(stats?.total_bandwidth_tx_mb_s)}
          </span>
          <span aria-hidden="true" className="text-border">
            |
          </span>
          {/* This read "Circuits: 142". Circuits are built on request and never
              stored, so there is no count to report; devices online is a figure
              the control plane holds. */}
          <span className="flex items-center gap-1.5 text-content">
            <Zap aria-hidden="true" className="h-3.5 w-3.5 text-success" />
            <span className="text-muted">{t('header.nodesUp')}:</span>
            {stats ? (
              <span className="font-bold tabular-nums">{`${stats.active_nodes}/${stats.total_nodes}`}</span>
            ) : (
              <NotMeasured />
            )}
          </span>
        </div>
      </div>

      <div className="console-header-actions flex min-w-0 flex-wrap items-center gap-3">
        {canAdd && (
          <Button variant="secondary" size="sm" onClick={onOpenEnrollModal}>
            <PlusCircle aria-hidden="true" className="h-3.5 w-3.5" />
            <span>{t('header.enrol')}</span>
          </Button>
        )}

        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>

        <div className="relative">
          <button
            type="button"
            onClick={() => setNotificationsOpen(!notificationsOpen)}
            aria-expanded={notificationsOpen}
            aria-label={t('header.notifications')}
            className="rounded-control border border-border bg-surface-sunken p-2 text-muted transition-colors hover:text-content focus-visible:outline-focus"
          >
            <Bell aria-hidden="true" className="h-4 w-4" />
          </button>

          {notificationsOpen && (
            <div className="absolute right-0 z-popover mt-2 w-80 space-y-2 rounded-card border border-border bg-surface-raised p-3 shadow-popover">
              <div className="flex items-center justify-between border-b border-border-subtle pb-2 text-caption font-semibold">
                <span className="text-content">{t('header.alerts')}</span>
              </div>
              {/* The two entries that used to be here were written into the
                  markup: a named node with an unsigned kernel module and
                  another at 14% battery, on every deployment. There is no
                  notification feed behind this control yet, and inventing one
                  is worse than showing that it is empty. */}
              <p className="py-4 text-center text-caption text-subtle">{t('header.noAlerts')}</p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-l border-border pl-2" aria-label={t('header.account')}>
          <div
            aria-hidden="true"
            className="flex h-7 w-7 items-center justify-center rounded-pill bg-accent text-caption font-bold text-accent-contrast"
          >
            {user?.username?.[0]?.toUpperCase() ?? 'U'}
          </div>
          <div className="hidden text-left sm:block">
            <div className="text-caption font-semibold text-content">{user?.username}</div>
            {role && <div className="text-micro text-muted">{tGlossary(`roles.${role}.term`)}</div>}
          </div>
          {/* The console had no way to end a session short of destroying the account. */}
          <button
            type="button"
            onClick={() => void logout()}
            aria-label={t('header.signOut')}
            title={t('header.signOut')}
            className="rounded-control border border-border bg-surface-sunken p-2 text-muted transition-colors hover:text-content focus-visible:outline-focus"
          >
            <LogOut aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}
