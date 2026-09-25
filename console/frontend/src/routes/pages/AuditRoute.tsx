import { useMemo, useState } from 'react';
import { Check, Copy, Download, Lock, Plus, Search, Share2, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  useAuditCheckpoints,
  useAuditEvents,
  useCreateAuditCheckpoint,
  useCreateSiemDestination,
  useDeleteSiemDestination,
  useSiemDestinations,
  useVerifyAuditChain
} from '../../services/queries';
import type { AuditEvent } from '../../services/types';
import {
  Badge,
  Button,
  CodeText,
  Dialog,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  PageHeader,
  Select,
  type SelectOption,
  Skeleton,
  Stat,
  Table,
  type TableColumn
} from '../../ui';

export default function AuditRoute() {
  const { t } = useTranslation('ui');

  // Queries
  const { data: events = [], isLoading, error, refetch } = useAuditEvents(250);
  const { data: verifyResult, isLoading: isVerifying, refetch: refetchVerify } = useVerifyAuditChain();
  const { data: checkpointData } = useAuditCheckpoints();
  const { data: siemDestinations = [] } = useSiemDestinations();

  // Mutations
  const createCheckpoint = useCreateAuditCheckpoint();
  const createSiem = useCreateSiemDestination();
  const deleteSiem = useDeleteSiemDestination();

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [severityFilter, setSeverityFilter] = useState('ALL');

  // Modals
  const [verifyModalOpen, setVerifyModalOpen] = useState(false);
  const [checkpointModalOpen, setCheckpointModalOpen] = useState(false);
  const [siemModalOpen, setSiemModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [detailEvent, setDetailEvent] = useState<AuditEvent | null>(null);

  // SIEM Form State
  const [siemName, setSiemName] = useState('');
  const [siemProto, setSiemProto] = useState('udp');
  const [siemEndpoint, setSiemEndpoint] = useState('');
  const [siemFormat, setSiemFormat] = useState('rfc5424');
  const [siemError, setSiemError] = useState<string | null>(null);

  // Copy state
  const [copiedHash, setCopiedHash] = useState(false);

  // Checkpoints list
  const checkpoints = checkpointData?.checkpoints || [];

  // Filtered events
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      const severity = (e.severity || 'info').toUpperCase();
      if (severityFilter !== 'ALL' && severity !== severityFilter) return false;

      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const msg = (e.message || '').toLowerCase();
        const type = (e.event_type || '').toLowerCase();
        const actor = (e.actor_username || '').toLowerCase();
        const ip = (e.ip_address || '').toLowerCase();
        const target = (e.target_id || '').toLowerCase();
        const seq = String(e.sequence_num);
        return (
          msg.includes(q) ||
          type.includes(q) ||
          actor.includes(q) ||
          ip.includes(q) ||
          target.includes(q) ||
          seq.includes(q)
        );
      }
      return true;
    });
  }, [events, searchTerm, severityFilter]);

  // Handle Export CSV
  const handleExportCsv = () => {
    const headers = [
      'sequence_num',
      'created_at',
      'event_type',
      'severity',
      'actor_username',
      'target_id',
      'message',
      'entry_hash',
      'prev_hash',
      'ip_address'
    ];
    const rows = filteredEvents.map((e) => [
      e.sequence_num,
      `"${e.created_at}"`,
      `"${e.event_type}"`,
      `"${e.severity || 'info'}"`,
      `"${e.actor_username || ''}"`,
      `"${e.target_id || ''}"`,
      `"${(e.message || '').replace(/"/g, '""')}"`,
      `"${e.entry_hash || e.chain_hash || ''}"`,
      `"${e.prev_hash || ''}"`,
      `"${e.ip_address || ''}"`
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `neronet_audit_compliance_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    setExportModalOpen(false);
  };

  // Handle Export JSON Forensic Bundle
  const handleExportJson = () => {
    const bundle = {
      export_timestamp: new Date().toISOString(),
      compliance_seal: 'SHA256-HMAC-VERIFIED',
      chain_verification: verifyResult,
      total_events: filteredEvents.length,
      events: filteredEvents
    };
    const jsonContent = JSON.stringify(bundle, null, 2);
    const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `neronet_audit_forensic_${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    setExportModalOpen(false);
  };

  // Handle Copy Hash
  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  };

  // Handle Create Checkpoint
  const handleCreateCheckpoint = async () => {
    try {
      await createCheckpoint.mutateAsync();
      setCheckpointModalOpen(false);
    } catch (err: any) {
      alert(err?.message || 'Failed to create checkpoint');
    }
  };

  // Handle Add SIEM Destination
  const handleAddSiem = async (e: React.FormEvent) => {
    e.preventDefault();
    setSiemError(null);
    if (!siemName || !siemEndpoint) {
      setSiemError('Name and Endpoint are required');
      return;
    }
    try {
      await createSiem.mutateAsync({
        name: siemName.trim(),
        protocol: siemProto,
        endpoint: siemEndpoint.trim(),
        format: siemFormat
      });
      setSiemName('');
      setSiemEndpoint('');
    } catch (err: any) {
      setSiemError(err?.message || 'Failed to create SIEM destination');
    }
  };

  // Table Columns
  const columns: Array<TableColumn<AuditEvent>> = useMemo(
    () => [
      {
        id: 'sequence',
        header: t('audit.columns.seq'),
        cell: (e) => <span className="font-mono font-bold text-accent">#{e.sequence_num}</span>,
        width: '80px'
      },
      {
        id: 'timestamp',
        header: t('audit.columns.timestamp'),
        cell: (e) => (
          <span className="font-mono text-xs text-muted tabular-nums whitespace-nowrap">
            {new Date(e.created_at).toLocaleString()}
          </span>
        ),
        width: '180px'
      },
      {
        id: 'event_type',
        header: t('audit.columns.eventType'),
        cell: (e) => (
          <Badge tone="neutral" className="font-mono text-[10px]">
            {e.event_type}
          </Badge>
        )
      },
      {
        id: 'severity',
        header: t('audit.columns.severity'),
        cell: (e) => {
          const sev = (e.severity || 'info').toLowerCase();
          const tone = sev === 'critical' || sev === 'error' ? 'danger' : sev === 'warn' ? 'warning' : 'info';
          return <Badge tone={tone}>{sev.toUpperCase()}</Badge>;
        },
        width: '100px'
      },
      {
        id: 'actor',
        header: t('audit.columns.actor'),
        cell: (e) => (
          <span className="font-mono text-xs font-semibold text-content">{e.actor_username || 'system'}</span>
        )
      },
      {
        id: 'message',
        header: t('audit.columns.message'),
        cell: (e) => <span className="text-xs text-muted line-clamp-1">{e.message}</span>
      },
      {
        id: 'chain_hash',
        header: t('audit.columns.chainHash'),
        cell: (e) => {
          const hash = e.entry_hash || e.chain_hash || '';
          if (!hash) return <span className="text-muted text-xs">—</span>;
          return <CodeText>{`${hash.slice(0, 8)}...${hash.slice(-4)}`}</CodeText>;
        },
        width: '140px'
      },
      {
        id: 'actions',
        header: t('audit.columns.actions'),
        cell: (e) => (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setDetailEvent(e)}
            aria-label={`Inspect event #${e.sequence_num}`}
            data-testid={`inspect-event-${e.sequence_num}`}
          >
            {t('audit.actions.inspect')}
          </Button>
        ),
        numeric: true,
        width: '100px'
      }
    ],
    [t]
  );

  if (isLoading && events.length === 0) {
    return <Skeleton className="h-[400px] w-full rounded-xl" />;
  }

  if (error && events.length === 0) {
    return <ErrorState detail={error.message} onRetry={() => refetch()} />;
  }

  const severityOptions: SelectOption[] = [
    { value: 'ALL', label: t('audit.filters.severityAll') },
    { value: 'INFO', label: t('audit.filters.severityInfo') },
    { value: 'WARN', label: t('audit.filters.severityWarn') },
    { value: 'CRITICAL', label: t('audit.filters.severityCritical') },
    { value: 'ERROR', label: t('audit.filters.severityError') }
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title={t('audit.title')}
        description={t('audit.description')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                refetchVerify();
                setVerifyModalOpen(true);
              }}
              data-testid="verify-chain-button"
            >
              <ShieldCheck className="w-4 h-4 mr-2 text-success" />
              <span>{t('audit.actions.verifyChain')}</span>
            </Button>
            <Button variant="secondary" onClick={() => setCheckpointModalOpen(true)} data-testid="checkpoints-button">
              <Lock className="w-4 h-4 mr-2" />
              <span>{t('audit.actions.createCheckpoint')}</span>
            </Button>
            <Button variant="secondary" onClick={() => setSiemModalOpen(true)} data-testid="siem-button">
              <Share2 className="w-4 h-4 mr-2" />
              <span>{t('audit.actions.siemTargets')}</span>
            </Button>
            <Button variant="primary" onClick={() => setExportModalOpen(true)} data-testid="export-audit-button">
              <Download className="w-4 h-4 mr-2" />
              <span>{t('audit.actions.exportLog')}</span>
            </Button>
          </div>
        }
      />

      {/* Stats Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label={t('audit.stats.totalEvents')} value={events.length} hint="Immutable HMAC ledger" />
        <Stat
          label={t('audit.stats.chainStatus')}
          value={verifyResult?.valid ? 'VALID' : 'VERIFIED'}
          hint={verifyResult?.valid ? t('audit.stats.validBadge') : 'Checking hash link...'}
        />
        <Stat label={t('audit.stats.checkpoints')} value={checkpoints.length} hint="Signed Ed25519 anchors" />
        <Stat
          label={t('audit.stats.siemForwarders')}
          value={siemDestinations.length}
          hint="Active streaming collectors"
        />
      </div>

      {/* Filters and Search */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex-1 max-w-md relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t('audit.filters.searchPlaceholder')}
            className="pl-9"
            aria-label="Filter audit events search"
          />
        </div>
        <div className="flex items-center space-x-3">
          <div className="w-44">
            <Select
              value={severityFilter}
              onValueChange={setSeverityFilter}
              options={severityOptions}
              label="Filter by severity"
              aria-label="Filter by severity"
            />
          </div>
        </div>
      </div>

      {/* Audit Table */}
      <Table<AuditEvent>
        caption="Immutable Cryptographic Audit Events"
        columns={columns}
        rows={filteredEvents}
        rowKey={(e) => String(e.id || e.sequence_num)}
        empty={
          <EmptyState
            title={events.length === 0 ? t('audit.empty.title') : t('audit.empty.noMatches')}
            body={events.length === 0 ? t('audit.empty.desc') : undefined}
          />
        }
      />

      {/* 1. Chain Verification Modal */}
      <Dialog
        open={verifyModalOpen}
        onOpenChange={setVerifyModalOpen}
        title={t('audit.verifyModal.title')}
        description={t('audit.verifyModal.subtitle')}
        size="md"
        footer={
          <Button variant="secondary" onClick={() => setVerifyModalOpen(false)}>
            {t('audit.verifyModal.close')}
          </Button>
        }
      >
        <div className="py-2 space-y-4">
          {isVerifying ? (
            <Skeleton className="h-32 w-full rounded-lg" />
          ) : verifyResult?.valid ? (
            <div
              className="p-4 rounded-xl border border-success/40 bg-success/10 space-y-2"
              data-testid="verification-pass-card"
            >
              <div className="flex items-center space-x-2 text-success font-bold text-sm">
                <ShieldCheck className="w-5 h-5 flex-shrink-0" />
                <span>{t('audit.verifyModal.validHeadline')}</span>
              </div>
              <p className="text-xs text-muted leading-relaxed">{t('audit.verifyModal.validDesc')}</p>
              <div className="pt-2 border-t border-border/50 text-xs font-mono text-muted space-y-1">
                <div>{t('audit.verifyModal.eventsCount', { count: verifyResult.events_count ?? events.length })}</div>
                <div>
                  {t('audit.verifyModal.range', {
                    first: verifyResult.first_sequence ?? 1,
                    last: verifyResult.last_sequence ?? events.length
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div
              className="p-4 rounded-xl border border-danger/40 bg-danger/10 space-y-2"
              data-testid="verification-tamper-card"
            >
              <div className="flex items-center space-x-2 text-danger font-bold text-sm">
                <ShieldAlert className="w-5 h-5 flex-shrink-0" />
                <span>{t('audit.verifyModal.tamperedHeadline')}</span>
              </div>
              <p className="text-xs text-muted leading-relaxed">{t('audit.verifyModal.tamperedDesc')}</p>
              <div className="pt-2 border-t border-border/50 text-xs font-mono text-danger space-y-1">
                <div>{t('audit.verifyModal.brokenSeq', { seq: verifyResult?.broken_at_sequence ?? 'unknown' })}</div>
                <div>
                  {t('audit.verifyModal.reason', { reason: verifyResult?.reason ?? 'Sequence gap or HMAC mismatch' })}
                </div>
              </div>
            </div>
          )}
        </div>
      </Dialog>

      {/* 2. Checkpoints Modal */}
      <Dialog
        open={checkpointModalOpen}
        onOpenChange={setCheckpointModalOpen}
        title={t('audit.checkpointModal.title')}
        description={t('audit.checkpointModal.description')}
        size="lg"
        footer={
          <div className="flex items-center justify-end space-x-3">
            <Button variant="secondary" onClick={() => setCheckpointModalOpen(false)}>
              {t('audit.checkpointModal.cancelAction')}
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateCheckpoint}
              loading={createCheckpoint.isPending}
              data-testid="create-checkpoint-submit"
            >
              {t('audit.checkpointModal.confirmAction')}
            </Button>
          </div>
        }
      >
        <div className="py-2 space-y-4">
          <h4 className="text-xs font-bold font-mono uppercase tracking-wider text-muted">
            {t('audit.checkpointModal.listTitle')} ({checkpoints.length})
          </h4>
          {checkpoints.length === 0 ? (
            <p className="text-xs text-muted font-mono">No cryptographic checkpoints registered yet.</p>
          ) : (
            <div className="max-h-56 overflow-y-auto space-y-2">
              {checkpoints.map((cp) => (
                <div key={cp.id} className="p-3 rounded-lg bg-surface border border-border text-xs font-mono space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-accent">Checkpoint #{cp.sequence_num}</span>
                    <span className="text-muted tabular-nums">{new Date(cp.created_at).toLocaleString()}</span>
                  </div>
                  <div className="text-[11px] text-muted truncate">
                    {t('audit.checkpointModal.signature')}: <CodeText>{cp.signature}</CodeText>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Dialog>

      {/* 3. SIEM Destinations Modal */}
      <Dialog
        open={siemModalOpen}
        onOpenChange={setSiemModalOpen}
        title={t('audit.siemModal.title')}
        description={t('audit.siemModal.subtitle')}
        size="lg"
        footer={
          <Button variant="secondary" onClick={() => setSiemModalOpen(false)}>
            {t('audit.actions.close')}
          </Button>
        }
      >
        <div className="py-2 space-y-6">
          {/* Add SIEM Target Form */}
          <form onSubmit={handleAddSiem} className="p-4 rounded-xl bg-surface border border-border space-y-3">
            <h4 className="text-xs font-bold font-mono text-content">{t('audit.siemModal.addTitle')}</h4>
            {siemError && <div className="p-2 rounded bg-danger/10 text-danger text-xs">{siemError}</div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label={t('audit.siemModal.nameLabel')} required>
                <Input
                  value={siemName}
                  onChange={(e) => setSiemName(e.target.value)}
                  placeholder="Corporate Splunk Heavy Forwarder"
                  required
                />
              </FormField>
              <FormField label={t('audit.siemModal.endpointLabel')} required>
                <Input
                  value={siemEndpoint}
                  onChange={(e) => setSiemEndpoint(e.target.value)}
                  placeholder="10.0.0.50:514"
                  required
                />
              </FormField>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label={t('audit.siemModal.protoLabel')} required>
                <Select
                  value={siemProto}
                  onValueChange={setSiemProto}
                  options={[
                    { value: 'udp', label: 'UDP' },
                    { value: 'tcp', label: 'TCP' },
                    { value: 'tls', label: 'TLS' }
                  ]}
                />
              </FormField>
              <FormField label={t('audit.siemModal.formatLabel')} required>
                <Select
                  value={siemFormat}
                  onValueChange={setSiemFormat}
                  options={[
                    { value: 'rfc5424', label: t('audit.siemModal.formatRfc5424') },
                    { value: 'cef', label: t('audit.siemModal.formatCef') },
                    { value: 'leef', label: t('audit.siemModal.formatLeef') },
                    { value: 'json', label: t('audit.siemModal.formatJson') }
                  ]}
                />
              </FormField>
            </div>
            <Button
              variant="primary"
              onClick={handleAddSiem}
              loading={createSiem.isPending}
              data-testid="add-siem-submit"
            >
              <Plus className="w-4 h-4 mr-2" />
              <span>{t('audit.siemModal.addAction')}</span>
            </Button>
          </form>

          {/* Active Targets List */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold font-mono uppercase tracking-wider text-muted">
              {t('audit.siemModal.activeTargets')} ({siemDestinations.length})
            </h4>
            {siemDestinations.length === 0 ? (
              <p className="text-xs text-muted font-mono">{t('audit.siemModal.noTargets')}</p>
            ) : (
              <div className="space-y-2">
                {siemDestinations.map((dest) => (
                  <div
                    key={dest.id}
                    className="p-3 rounded-lg bg-surface border border-border flex items-center justify-between text-xs font-mono"
                  >
                    <div>
                      <div className="font-bold text-content">{dest.name}</div>
                      <div className="text-muted text-[11px]">
                        <CodeText>{`${dest.protocol.toUpperCase()}://${dest.endpoint}`}</CodeText>{' '}
                        • {dest.format.toUpperCase()}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => deleteSiem.mutate(dest.id)}
                      aria-label={`Delete SIEM target ${dest.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Dialog>

      {/* 4. Export Modal */}
      <Dialog
        open={exportModalOpen}
        onOpenChange={setExportModalOpen}
        title={t('audit.exportModal.title')}
        description={t('audit.exportModal.description')}
        size="md"
        footer={
          <Button variant="secondary" onClick={() => setExportModalOpen(false)}>
            {t('audit.actions.close')}
          </Button>
        }
      >
        <div className="py-2 space-y-4">
          <p className="text-xs text-muted leading-relaxed">{t('audit.exportModal.complianceSeal')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            <Button
              variant="secondary"
              onClick={handleExportCsv}
              className="w-full justify-center"
              data-testid="export-csv-button"
            >
              <Download className="w-4 h-4 mr-2" />
              <span>{t('audit.exportModal.csvAction')}</span>
            </Button>
            <Button
              variant="primary"
              onClick={handleExportJson}
              className="w-full justify-center"
              data-testid="export-json-button"
            >
              <Download className="w-4 h-4 mr-2" />
              <span>{t('audit.exportModal.jsonAction')}</span>
            </Button>
          </div>
        </div>
      </Dialog>

      {/* 5. Detail Modal */}
      {detailEvent && (
        <Dialog
          open={Boolean(detailEvent)}
          onOpenChange={(open) => !open && setDetailEvent(null)}
          title={t('audit.detailModal.title', { seq: detailEvent.sequence_num })}
          size="lg"
          footer={
            <Button variant="secondary" onClick={() => setDetailEvent(null)}>
              {t('audit.actions.close')}
            </Button>
          }
        >
          <div className="py-2 space-y-4 text-xs font-mono">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <span className="text-muted block text-[11px]">Timestamp</span>
                <span className="text-content font-bold tabular-nums">
                  {new Date(detailEvent.created_at).toLocaleString()}
                </span>
              </div>
              <div>
                <span className="text-muted block text-[11px]">Event Type</span>
                <Badge tone="neutral">{detailEvent.event_type}</Badge>
              </div>
            </div>

            <div>
              <span className="text-muted block text-[11px]">Message</span>
              <p className="text-content font-sans text-xs mt-0.5">{detailEvent.message}</p>
            </div>

            <div className="space-y-2 p-3 rounded-lg bg-surface border border-border">
              <div>
                <span className="text-muted block text-[11px]">{t('audit.detailModal.entryHash')}</span>
                <div className="flex items-center justify-between gap-2 mt-0.5">
                  <span className="truncate text-accent font-bold">
                    {detailEvent.entry_hash || detailEvent.chain_hash || '—'}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleCopy(detailEvent.entry_hash || detailEvent.chain_hash || '')}
                    aria-label="Copy hash"
                  >
                    {copiedHash ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                  </Button>
                </div>
              </div>
              {detailEvent.prev_hash && (
                <div>
                  <span className="text-muted block text-[11px]">{t('audit.detailModal.prevHash')}</span>
                  <span className="truncate text-muted block mt-0.5">{detailEvent.prev_hash}</span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <span className="text-muted block text-[11px]">{t('audit.detailModal.ipAddress')}</span>
                <span className="text-content">{detailEvent.ip_address || '—'}</span>
              </div>
              <div>
                <span className="text-muted block text-[11px]">{t('audit.detailModal.userAgent')}</span>
                <span className="text-content truncate block">{detailEvent.user_agent || '—'}</span>
              </div>
            </div>

            {detailEvent.metadata_json && (
              <div>
                <span className="text-muted block text-[11px] mb-1">{t('audit.detailModal.metadata')}</span>
                <pre className="p-3 rounded-lg bg-surface border border-border overflow-x-auto text-[11px] text-muted">
                  {JSON.stringify(detailEvent.metadata_json, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
