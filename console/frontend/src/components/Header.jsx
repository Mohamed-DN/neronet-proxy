import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import { LanguageSwitcher, ThemeToggle } from '../ui';
import { Shield, ArrowDownLeft, ArrowUpRight, PlusCircle, Bell, Search, UserCheck, Zap } from 'lucide-react';

export default function Header({ onOpenEnrollModal }) {
  const { t } = useTranslation('chrome');
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
    <header className="h-16 border-b border-border bg-surface-raised sticky top-0 z-sticky px-6 flex items-center justify-between">
      {/* Left Area: Search & Context Path */}
      <div className="flex items-center space-x-6">
        <div className="relative">
          <Search aria-hidden="true" className="w-4 h-4 text-subtle absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            aria-label={t('header.searchLabel')}
            placeholder={t('header.search')}
            className="w-72 pl-9 pr-4 py-1.5 text-caption bg-surface-sunken border border-border-strong rounded-control text-content placeholder:text-subtle focus-visible:outline-focus font-mono"
          />
        </div>

        {/* Aggregate Throughput Ticker */}
        <div
          aria-label={t('header.throughput')}
          className="hidden lg:flex items-center space-x-4 px-3 py-1.5 rounded-control bg-surface-sunken border border-border text-caption font-mono"
        >
          <div className="flex items-center space-x-1.5 text-content">
            <ArrowDownLeft aria-hidden="true" className="w-3.5 h-3.5 text-accent" />
            <span className="text-muted">{t('header.rx')}:</span>
            <span className="font-bold tabular-nums">{rate(live?.total_bandwidth_rx_mb_s)}</span>
          </div>
          <span aria-hidden="true" className="text-border">
            |
          </span>
          <div className="flex items-center space-x-1.5 text-content">
            <ArrowUpRight aria-hidden="true" className="w-3.5 h-3.5 text-info" />
            <span className="text-muted">{t('header.tx')}:</span>
            <span className="font-bold tabular-nums">{rate(live?.total_bandwidth_tx_mb_s)}</span>
          </div>
          <span aria-hidden="true" className="text-border">
            |
          </span>
          {/* This read "Circuits: 142". Circuits are built on request and never
              stored, so there is no count to report; live nodes is a figure the
              control plane actually holds. */}
          <div className="flex items-center space-x-1.5 text-content">
            <Zap aria-hidden="true" className="w-3.5 h-3.5 text-success" />
            <span className="text-muted">{t('header.nodesUp')}:</span>
            <span className="font-bold tabular-nums">{live ? `${live.active_nodes}/${live.total_nodes}` : '—'}</span>
          </div>
        </div>
      </div>

      {/* Right Area: Role Switcher & User HUD */}
      <div className="flex items-center space-x-4">
        {/* Enroll Node Button */}
        <button
          type="button"
          onClick={onOpenEnrollModal}
          className="flex items-center space-x-2 px-3 py-1.5 rounded-control bg-accent text-accent-contrast font-semibold text-caption hover:bg-accent-strong transition-colors focus-visible:outline-focus"
        >
          <PlusCircle aria-hidden="true" className="w-3.5 h-3.5" />
          <span>{t('header.enrol')}</span>
        </button>

        {/* Role Scoper Switcher */}
        <div
          role="radiogroup"
          aria-label={t('header.roleScope')}
          className="flex items-center bg-surface-sunken border border-border rounded-control p-1 space-x-1"
        >
          <button
            type="button"
            role="radio"
            aria-checked={isSuperAdmin}
            onClick={() => switchRole('super-admin')}
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-sm text-caption font-mono font-medium transition-colors focus-visible:outline-focus ${
              isSuperAdmin ? 'bg-info-subtle text-info border border-info/40' : 'text-muted hover:text-content'
            }`}
            title={t('header.superAdminHint')}
          >
            <Shield aria-hidden="true" className="w-3 h-3" />
            <span>{t('header.superAdmin')}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!isSuperAdmin}
            onClick={() => switchRole('user')}
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-sm text-caption font-mono font-medium transition-colors focus-visible:outline-focus ${
              !isSuperAdmin
                ? 'bg-success-subtle text-success border border-success/40'
                : 'text-muted hover:text-content'
            }`}
            title={t('header.userHint')}
          >
            <UserCheck aria-hidden="true" className="w-3 h-3" />
            <span>{t('header.user')}</span>
          </button>
        </div>

        {/* Language and theme. WP-402 owns the final placement. */}
        <div className="flex items-center gap-2">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>

        {/* Notifications Bell */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setNotificationsOpen(!notificationsOpen)}
            aria-expanded={notificationsOpen}
            aria-label={t('header.notificationsUnread')}
            className="p-2 rounded-control bg-surface-sunken border border-border text-muted hover:text-content transition-colors relative focus-visible:outline-focus"
          >
            <Bell aria-hidden="true" className="w-4 h-4" />
            <span aria-hidden="true" className="absolute top-1 right-1 w-2 h-2 rounded-pill bg-danger"></span>
          </button>

          {/* Notifications Dropdown */}
          {notificationsOpen && (
            <div className="absolute right-0 mt-2 w-80 bg-surface-raised border border-border rounded-card shadow-popover z-popover p-3 space-y-2">
              <div className="flex items-center justify-between pb-2 border-b border-border-subtle text-caption font-semibold">
                <span className="text-content">{t('header.alerts')}</span>
                <button type="button" className="text-micro text-accent hover:underline focus-visible:outline-focus">
                  {t('header.markAllRead')}
                </button>
              </div>
              <div className="space-y-2 max-h-60 overflow-y-auto text-caption font-mono">
                <div className="p-2 rounded-sm bg-danger-subtle border border-danger/30 text-content">
                  <div className="flex items-center justify-between text-micro text-danger font-bold">
                    <span>Posture Alert</span>
                    <span>1h ago</span>
                  </div>
                  <p className="text-micro text-muted mt-1">
                    Node &apos;compromised-kali-box&apos; isolated: Unsigned kernel module detected.
                  </p>
                </div>
                <div className="p-2 rounded-sm bg-warning-subtle border border-warning/30 text-content">
                  <div className="flex items-center justify-between text-micro text-warning font-bold">
                    <span>Battery Cutoff</span>
                    <span>3h ago</span>
                  </div>
                  <p className="text-micro text-muted mt-1">
                    Node &apos;carols-galaxy-s24-ultra&apos; battery low (14%), exit routing disabled.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* User Identity Pill */}
        <div className="flex items-center space-x-2 pl-2 border-l border-border" aria-label={t('header.account')}>
          <div
            aria-hidden="true"
            className="w-7 h-7 rounded-pill bg-accent flex items-center justify-center font-mono font-bold text-caption text-accent-contrast"
          >
            {user?.username?.[0]?.toUpperCase() || 'U'}
          </div>
          <div className="hidden sm:block text-left font-mono">
            <div className="text-caption font-semibold text-content">{user?.username}</div>
            <div className="text-micro text-muted">
              {user?.role === 'super-admin' ? t('header.superAdmin') : t('header.user')}
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
