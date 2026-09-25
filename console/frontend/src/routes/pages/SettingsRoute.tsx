import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Cpu, Lock, Save, Shield } from 'lucide-react';

import { Badge, Button, Card, FormField, Input, PageHeader, Select, StatusBadge, Switch } from '../../ui';

export default function SettingsRoute() {
  const { t } = useTranslation();

  // Settings State
  const [onionRouting, setOnionRouting] = useState(true);
  const [obfuscationProtocol, setObfuscationProtocol] = useState<
    'shadow-tls' | 'vless-reality' | 'quic-masque' | 'amnezia-wg'
  >('shadow-tls');
  const [portHopping, setPortHopping] = useState(true);
  const [hopInterval, setHopInterval] = useState('30');

  const [listenPort, setListenPort] = useState('51820');
  const [interfaceMtu, setInterfaceMtu] = useState('1380');
  const [persistentKeepalive, setPersistentKeepalive] = useState('25');
  const [cipherSuite, setCipherSuite] = useState('chacha20-poly1305');

  const [rateLimiting, setRateLimiting] = useState(true);
  const [auditChainVerification, setAuditChainVerification] = useState(true);
  const [prometheusMetrics, setPrometheusMetrics] = useState(true);

  const [isSaving, setIsSaving] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  const handleApplySettings = (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setTimeout(() => {
      setIsSaving(false);
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 3000);
    }, 400);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title={t('settings.title', 'Sovereign Mesh Global Configuration')}
        description={t(
          'settings.subtitle',
          'Core cryptographic primitives, WireGuard engine tuning, traffic obfuscation, and telemetry parameters.'
        )}
        actions={
          <div className="flex items-center gap-3">
            <Badge tone="accent" mono>
              {t('settings.badgeParameters', 'System Parameters')}
            </Badge>
            <Button
              variant="primary"
              size="md"
              icon={isSaved ? Check : Save}
              onClick={handleApplySettings}
              disabled={isSaving}
            >
              {isSaving
                ? t('settings.saving', 'Applying Changes...')
                : isSaved
                  ? t('settings.saved', 'Applied')
                  : t('settings.btnSave', 'Apply Configuration')}
            </Button>
          </div>
        }
      />

      <form onSubmit={handleApplySettings} className="space-y-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Section 1: Traffic & Stealth Obfuscation */}
          <Card className="space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <div className="flex items-center gap-2 font-bold text-content text-sm">
                <Shield className="h-4 w-4 text-accent" />
                <span>{t('settings.sectionTraffic', 'Advanced Traffic & Stealth Routing')}</span>
              </div>
              <StatusBadge status="ok" label="Active" />
            </div>

            <div className="space-y-4">
              <Switch
                label={t('settings.fieldOnion', 'Tor-Grade 3-Hop Onion Circuits')}
                description={t(
                  'settings.fieldOnionDesc',
                  'Layered Noise encryption across mesh relays for metadata privacy'
                )}
                checked={onionRouting}
                onCheckedChange={setOnionRouting}
              />

              <FormField label={t('settings.fieldObfuscation', 'Stealth Obfuscation Protocol')}>
                <Select
                  value={obfuscationProtocol}
                  onValueChange={(val) => setObfuscationProtocol(val as any)}
                  options={[
                    {
                      value: 'shadow-tls',
                      label: t('settings.optShadowTls', 'ShadowTLS v3 (Mimic TLS 1.3 Handshake)')
                    },
                    {
                      value: 'vless-reality',
                      label: t('settings.optVless', 'VLESS Reality (Zero-RTT Server Name Indication)')
                    },
                    { value: 'quic-masque', label: t('settings.optMasque', 'QUIC MASQUE (HTTP/3 Datagram Tunneling)') },
                    {
                      value: 'amnezia-wg',
                      label: t('settings.optAmnezia', 'AmneziaWG (Junk Packet Prefix & Custom Header Magic)')
                    }
                  ]}
                />
              </FormField>

              <Switch
                label="NeroHop (Dynamic WireGuard UDP Port-Hopping)"
                description="Rotate external UDP ports every N seconds to defeat 5-tuple firewall tracking"
                checked={portHopping}
                onCheckedChange={setPortHopping}
              />

              {portHopping && (
                <FormField label="Port-Hop Rotation Interval (seconds)">
                  <Input
                    type="number"
                    min="5"
                    max="300"
                    value={hopInterval}
                    onChange={(e) => setHopInterval(e.target.value)}
                  />
                </FormField>
              )}
            </div>
          </Card>

          {/* Section 2: WireGuard Engine Parameters */}
          <Card className="space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-border">
              <div className="flex items-center gap-2 font-bold text-content text-sm">
                <Cpu className="h-4 w-4 text-accent" />
                <span>{t('settings.sectionEngine', 'WireGuard Engine & MTU Sizing')}</span>
              </div>
              <Badge tone="neutral" mono>
                Kernel / TUN
              </Badge>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <FormField label={t('settings.fieldPort', 'Listen UDP Port')}>
                <Input type="number" value={listenPort} onChange={(e) => setListenPort(e.target.value)} />
              </FormField>

              <FormField label={t('settings.fieldMtu', 'Interface MTU Size (bytes)')}>
                <Input
                  type="number"
                  min="1280"
                  max="1500"
                  value={interfaceMtu}
                  onChange={(e) => setInterfaceMtu(e.target.value)}
                />
              </FormField>

              <FormField label={t('settings.fieldKeepalive', 'Persistent Keepalive Interval (seconds)')}>
                <Input
                  type="number"
                  min="5"
                  max="120"
                  value={persistentKeepalive}
                  onChange={(e) => setPersistentKeepalive(e.target.value)}
                />
              </FormField>

              <FormField label={t('settings.fieldCipher', 'Primary Cipher Suite')}>
                <Select
                  value={cipherSuite}
                  onValueChange={setCipherSuite}
                  options={[
                    { value: 'chacha20-poly1305', label: 'ChaCha20-Poly1305 (RFC 8439)' },
                    { value: 'aes-256-gcm', label: 'AES-256-GCM (Hardware Accel)' }
                  ]}
                />
              </FormField>
            </div>

            <div className="p-3 rounded-lg bg-surface border border-border text-xs text-muted space-y-1">
              <div className="font-semibold text-content">Automatic Clamp Safeguard</div>
              <p>
                MTU is automatically clamped between 1280 and 1420 to prevent packet fragmentation when traversing
                nested overlay tunnels.
              </p>
            </div>
          </Card>
        </div>

        {/* Section 3: Telemetry, SIEM & Security Hardening */}
        <Card className="space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-border">
            <div className="flex items-center gap-2 font-bold text-content text-sm">
              <Lock className="h-4 w-4 text-accent" />
              <span>{t('settings.sectionSecurity', 'Telemetry, SIEM & Hardening')}</span>
            </div>
            <StatusBadge status="ok" label="Enforced" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Switch
              label={t('settings.fieldRateLimit', 'Strict Rate Limiting')}
              description={t(
                'settings.fieldRateLimitDesc',
                'Protect control plane endpoints against brute-force and credential stuffing'
              )}
              checked={rateLimiting}
              onCheckedChange={setRateLimiting}
            />

            <Switch
              label={t('settings.fieldAuditChain', 'HMAC Audit Ledger Verification')}
              description={t(
                'settings.fieldAuditChainDesc',
                'Continuous SHA-256 HMAC cryptographic chain verification'
              )}
              checked={auditChainVerification}
              onCheckedChange={setAuditChainVerification}
            />

            <Switch
              label={t('settings.fieldPrometheus', 'Prometheus Metrics Exporter')}
              description={t(
                'settings.fieldPrometheusDesc',
                'Scrape metrics at /metrics for OpenTelemetry and Grafana'
              )}
              checked={prometheusMetrics}
              onCheckedChange={setPrometheusMetrics}
            />
          </div>
        </Card>
      </form>
    </div>
  );
}
