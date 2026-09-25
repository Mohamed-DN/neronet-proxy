import { useMemo, useState } from 'react';
import { AlertTriangle, Clock, Flame, Lock, RefreshCw, Shield, ShieldAlert, Skull } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  useApproveDualAuthDestruction,
  useDualAuthRequests,
  useHeartbeatOwnerDms,
  useImposeLegalHold,
  useLegalHolds,
  useNukeOverview,
  useOwnerDmsStatus,
  useRejectDualAuthDestruction,
  useReleaseLegalHold,
  useRequestDualAuthDestruction,
  useTriggerOwnerWipe
} from '../../services/queries';
import type { DualAuthRequest, LegalHold } from '../../services/types';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CodeText,
  Dialog,
  FormField,
  Input,
  PageHeader,
  Select,
  Stat,
  StatusBadge,
  Table,
  type TableColumn,
  Tabs
} from '../../ui';
import { PageFrame } from '../PageFrame';

export default function NukeRoute() {
  const { t } = useTranslation('ui');

  // Queries
  const { data: overview, refetch: refetchOverview } = useNukeOverview();
  const { data: legalHolds = [], isLoading: holdsLoading, refetch: refetchHolds } = useLegalHolds();
  const { data: dualAuthRequests = [], isLoading: authLoading, refetch: refetchAuth } = useDualAuthRequests();
  const { refetch: refetchDms } = useOwnerDmsStatus();

  // Mutations
  const imposeHoldMutation = useImposeLegalHold();
  const releaseHoldMutation = useReleaseLegalHold();
  const requestDestructionMutation = useRequestDualAuthDestruction();
  const approveDestructionMutation = useApproveDualAuthDestruction();
  const rejectDestructionMutation = useRejectDualAuthDestruction();
  const heartbeatMutation = useHeartbeatOwnerDms();
  const purgeMutation = useTriggerOwnerWipe();

  // Navigation state
  const [activeTab, setActiveTab] = useState('dualAuth');

  // Search & Filter
  const [dualAuthSearch, setDualAuthSearch] = useState('');
  const [dualAuthStatusFilter, setDualAuthStatusFilter] = useState('ALL');
  const [holdSearch, setHoldSearch] = useState('');
  const [holdStatusFilter, setHoldStatusFilter] = useState('ALL');

  // Modals state
  const [requestModalOpen, setRequestModalOpen] = useState(false);
  const [approveTarget, setApproveTarget] = useState<DualAuthRequest | null>(null);
  const [inspectTarget, setInspectTarget] = useState<DualAuthRequest | null>(null);
  const [imposeModalOpen, setImposeModalOpen] = useState(false);
  const [releaseTarget, setReleaseTarget] = useState<LegalHold | null>(null);
  const [purgeModalOpen, setPurgeModalOpen] = useState(false);

  // Form states: Request Destruction
  const [reqTargetType, setReqTargetType] = useState<'organization' | 'global'>('organization');
  const [reqTargetId, setReqTargetId] = useState('');
  const [reqComment, setReqComment] = useState('');
  const [reqConfirmation, setReqConfirmation] = useState('');
  const [reqError, setReqError] = useState<string | null>(null);

  // Form states: Approve Destruction
  const [approveComment, setApproveComment] = useState('');
  const [approveCertified, setApproveCertified] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  // Form states: Impose Legal Hold
  const [imposeOrgId, setImposeOrgId] = useState('');
  const [imposeReason, setImposeReason] = useState('');
  const [imposeError, setImposeError] = useState<string | null>(null);

  // Form states: DMS Heartbeat
  const [dmsPassphrase, setDmsPassphrase] = useState('');
  const [dmsMsg, setDmsMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Form states: Emergency Purge
  const [purgePhrase, setPurgePhrase] = useState('');
  const [purgePassword, setPurgePassword] = useState('');
  const [purgeError, setPurgeError] = useState<string | null>(null);

  const handleRefreshAll = () => {
    refetchOverview();
    refetchHolds();
    refetchAuth();
    refetchDms();
  };

  // Filtered Dual-Auth requests
  const filteredDualAuth = useMemo(() => {
    return dualAuthRequests.filter((r) => {
      if (dualAuthStatusFilter !== 'ALL' && r.status !== dualAuthStatusFilter) return false;
      if (dualAuthSearch.trim()) {
        const q = dualAuthSearch.toLowerCase();
        const tid = (r.target_id || '').toLowerCase();
        const init = (r.initiator_user_id || '').toLowerCase();
        const c = (r.initiator_comment || '').toLowerCase();
        const s = (r.status || '').toLowerCase();
        return tid.includes(q) || init.includes(q) || c.includes(q) || s.includes(q);
      }
      return true;
    });
  }, [dualAuthRequests, dualAuthStatusFilter, dualAuthSearch]);

  // Filtered Legal Holds
  const filteredHolds = useMemo(() => {
    return legalHolds.filter((h) => {
      if (holdStatusFilter === 'ACTIVE' && !h.active) return false;
      if (holdStatusFilter === 'RELEASED' && h.active) return false;
      if (holdSearch.trim()) {
        const q = holdSearch.toLowerCase();
        const org = (h.organization_id || '').toLowerCase();
        const reason = (h.reason || '').toLowerCase();
        const id = (h.id || '').toLowerCase();
        const user = (h.imposed_by_user_id || '').toLowerCase();
        return org.includes(q) || reason.includes(q) || id.includes(q) || user.includes(q);
      }
      return true;
    });
  }, [legalHolds, holdStatusFilter, holdSearch]);

  // Table columns: Dual-Auth
  const dualAuthColumns: TableColumn<DualAuthRequest>[] = [
    {
      id: 'target',
      header: t('nuke.dualAuth.columns.target'),
      cell: (r) => (
        <div className="flex items-center gap-2">
          <Badge tone={r.target_type === 'global' ? 'danger' : 'accent'} mono>
            {r.target_type.toUpperCase()}
          </Badge>
          <CodeText>{r.target_id}</CodeText>
        </div>
      )
    },
    {
      id: 'initiator',
      header: t('nuke.dualAuth.columns.initiator'),
      cell: (r) => <span className="font-mono text-caption text-content">{r.initiator_user_id}</span>
    },
    {
      id: 'comment',
      header: t('nuke.dualAuth.columns.comment'),
      cell: (r) => (
        <span className="truncate text-caption text-subtle max-w-xs block" title={r.initiator_comment || ''}>
          {r.initiator_comment || '—'}
        </span>
      )
    },
    {
      id: 'status',
      header: t('nuke.dualAuth.columns.status'),
      cell: (r) => {
        if (r.status === 'pending') {
          return <StatusBadge status="warning" label={t('nuke.dualAuth.status.pending')} />;
        }
        if (r.status === 'executed') {
          return <StatusBadge status="critical" label={t('nuke.dualAuth.status.executed')} />;
        }
        if (r.status === 'rejected') {
          return <StatusBadge status="unknown" label={t('nuke.dualAuth.status.rejected')} />;
        }
        return <StatusBadge status="not-measured" label={t('nuke.dualAuth.status.expired')} />;
      }
    },
    {
      id: 'expiresAt',
      header: t('nuke.dualAuth.columns.expiresAt'),
      cell: (r) => <span className="font-mono text-caption text-muted">{new Date(r.expires_at).toLocaleString()}</span>
    },
    {
      id: 'actions',
      header: t('nuke.dualAuth.columns.actions'),
      cell: (r) => (
        <div className="flex items-center gap-1.5">
          {r.status === 'pending' && (
            <>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  setApproveTarget(r);
                  setApproveComment('');
                  setApproveCertified(false);
                  setApproveError(null);
                }}
              >
                {t('nuke.dualAuth.actions.approve')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (confirm(t('nuke.dualAuth.actions.reject') + '?')) {
                    await rejectDestructionMutation.mutateAsync({
                      id: r.id,
                      comment: 'Rejected by administrator via console'
                    });
                  }
                }}
              >
                {t('nuke.dualAuth.actions.reject')}
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={() => setInspectTarget(r)}>
            {t('nuke.dualAuth.actions.details')}
          </Button>
        </div>
      )
    }
  ];

  // Table columns: Legal Holds
  const holdColumns: TableColumn<LegalHold>[] = [
    {
      id: 'id',
      header: t('nuke.legalHolds.columns.id'),
      cell: (h) => <CodeText>{h.id}</CodeText>
    },
    {
      id: 'organization',
      header: t('nuke.legalHolds.columns.organization'),
      cell: (h) => (
        <div className="flex items-center gap-1.5">
          <Shield className="h-4 w-4 text-warning shrink-0" />
          <span className="font-medium text-caption text-content">{h.organization_id}</span>
        </div>
      )
    },
    {
      id: 'reason',
      header: t('nuke.legalHolds.columns.reason'),
      cell: (h) => (
        <span className="text-caption text-content font-medium" title={h.reason}>
          {h.reason}
        </span>
      )
    },
    {
      id: 'imposedBy',
      header: t('nuke.legalHolds.columns.imposedBy'),
      cell: (h) => <span className="font-mono text-caption text-muted">{h.imposed_by_user_id}</span>
    },
    {
      id: 'createdAt',
      header: t('nuke.legalHolds.columns.createdAt'),
      cell: (h) => <span className="font-mono text-caption text-muted">{new Date(h.created_at).toLocaleString()}</span>
    },
    {
      id: 'status',
      header: t('nuke.legalHolds.columns.status'),
      cell: (h) =>
        h.active ? (
          <StatusBadge status="critical" label={t('nuke.legalHolds.status.active')} />
        ) : (
          <StatusBadge status="ok" label={t('nuke.legalHolds.status.released')} />
        )
    },
    {
      id: 'actions',
      header: t('nuke.legalHolds.columns.actions'),
      cell: (h) =>
        h.active ? (
          <Button variant="secondary" size="sm" onClick={() => setReleaseTarget(h)}>
            {t('nuke.legalHolds.actions.release')}
          </Button>
        ) : (
          <span className="text-micro text-subtle">—</span>
        )
    }
  ];

  // Submission handlers
  const handleRequestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setReqError(null);

    if (reqConfirmation.trim() !== 'CONFIRM DESTRUCTION') {
      setReqError("You must type exactly 'CONFIRM DESTRUCTION'");
      return;
    }

    if (!reqTargetId.trim()) {
      setReqError('Target identifier is required');
      return;
    }

    try {
      await requestDestructionMutation.mutateAsync({
        target_type: reqTargetType,
        target_id: reqTargetId.trim(),
        comment: reqComment.trim()
      });
      setRequestModalOpen(false);
      setReqTargetId('');
      setReqComment('');
      setReqConfirmation('');
    } catch (err: any) {
      setReqError(err?.message || 'Failed to submit destruction request');
    }
  };

  const handleApproveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!approveTarget) return;
    setApproveError(null);

    if (!approveCertified) {
      setApproveError('You must check the confirmation checkbox to authorize destruction');
      return;
    }

    try {
      await approveDestructionMutation.mutateAsync({
        id: approveTarget.id,
        comment: approveComment.trim()
      });
      setApproveTarget(null);
    } catch (err: any) {
      setApproveError(err?.message || 'Failed to execute destruction approval');
    }
  };

  const handleImposeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setImposeError(null);

    if (!imposeOrgId.trim()) {
      setImposeError('Organization ID is required');
      return;
    }
    if (!imposeReason.trim()) {
      setImposeError('Reason / legal reference is required');
      return;
    }

    try {
      await imposeHoldMutation.mutateAsync({
        organization_id: imposeOrgId.trim(),
        reason: imposeReason.trim()
      });
      setImposeModalOpen(false);
      setImposeOrgId('');
      setImposeReason('');
    } catch (err: any) {
      setImposeError(err?.message || 'Failed to impose legal hold');
    }
  };

  const handleReleaseConfirm = async () => {
    if (!releaseTarget) return;
    try {
      await releaseHoldMutation.mutateAsync(releaseTarget.id);
      setReleaseTarget(null);
    } catch (err: any) {
      alert(err?.message || 'Failed to release legal hold');
    }
  };

  const handleHeartbeatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDmsMsg(null);
    try {
      await heartbeatMutation.mutateAsync(dmsPassphrase);
      setDmsPassphrase('');
      setDmsMsg({ text: 'Heartbeat confirmed. Global wipe timer reset successfully.', ok: true });
    } catch (err: any) {
      setDmsMsg({ text: err?.message || 'Invalid owner passphrase', ok: false });
    }
  };

  const handlePurgeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPurgeError(null);

    if (purgePhrase !== 'DESTROY EVERYTHING PERMANENTLY') {
      setPurgeError("Phrase must match exactly 'DESTROY EVERYTHING PERMANENTLY'");
      return;
    }
    if (!purgePassword) {
      setPurgeError('Super-admin password is required');
      return;
    }

    try {
      await purgeMutation.mutateAsync({
        confirmation_phrase: purgePhrase,
        password: purgePassword
      });
      setPurgeModalOpen(false);
      alert('Global wipe triggered successfully');
    } catch (err: any) {
      setPurgeError(err?.message || 'Purge rejected by server');
    }
  };

  // Check if approveTarget has active legal hold
  const approveTargetHold = useMemo(() => {
    if (!approveTarget) return null;
    return legalHolds.find(
      (h) => h.active && (approveTarget.target_type === 'global' || h.organization_id === approveTarget.target_id)
    );
  }, [approveTarget, legalHolds]);

  return (
    <PageFrame>
      <div className="flex flex-col gap-6">
        {/* Page Header */}
        <PageHeader
          title={t('nuke.title')}
          description={t('nuke.description')}
          meta={
            <Badge tone={overview?.keys_status === 'destroyed' ? 'danger' : 'accent'} mono>
              {overview?.keys_status === 'destroyed' ? t('nuke.stats.shredded') : t('nuke.stats.activeEpoch')}
            </Badge>
          }
          actions={
            <>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  setRequestModalOpen(true);
                  setReqError(null);
                }}
              >
                <Flame className="h-4 w-4 mr-1.5 shrink-0" />
                {t('nuke.dualAuth.requestBtn')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setImposeModalOpen(true);
                  setImposeError(null);
                }}
              >
                <ShieldAlert className="h-4 w-4 mr-1.5 shrink-0" />
                {t('nuke.legalHolds.imposeBtn')}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleRefreshAll} title="Refresh">
                <RefreshCw className="h-4 w-4 shrink-0" />
              </Button>
            </>
          }
        />

        {/* Top 4 Stat Cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <Stat
              label={t('nuke.stats.keysStatus')}
              value={overview?.keys_status?.toUpperCase() || 'ACTIVE'}
              hint="AES-256-GCM Envelope"
            />
          </Card>
          <Card>
            <Stat
              label={t('nuke.stats.legalHolds')}
              value={overview?.active_legal_holds ?? legalHolds.filter((h) => h.active).length}
              hint={(overview?.active_legal_holds || 0) > 0 ? t('nuke.stats.holdsBlocked') : t('nuke.stats.noHolds')}
            />
          </Card>
          <Card>
            <Stat
              label={t('nuke.stats.dualAuthGate')}
              value={overview?.pending_authorizations ?? dualAuthRequests.filter((r) => r.status === 'pending').length}
              hint={
                (overview?.pending_authorizations || 0) > 0 ? t('nuke.stats.pendingAuth') : t('nuke.stats.allClear')
              }
            />
          </Card>
          <Card>
            <Stat
              label={t('nuke.stats.deadManSwitch')}
              value={overview?.owner_dms_armed ? t('nuke.stats.armed') : t('nuke.stats.disarmed')}
              hint="Owner DMS Fail-Safe"
            />
          </Card>
        </div>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          label="NeroNuke Governance Sections"
          items={[
            {
              value: 'dualAuth',
              label: t('nuke.tabs.dualAuth'),
              badge: (
                <Badge tone="warning" mono>
                  {dualAuthRequests.filter((r) => r.status === 'pending').length}
                </Badge>
              ),
              content: (
                <div className="flex flex-col gap-4">
                  {/* 4-Eyes Banner */}
                  <Card className="border-warning/30 bg-warning-subtle/20">
                    <div className="flex items-start gap-3">
                      <Lock className="h-5 w-5 text-warning shrink-0 mt-0.5" />
                      <div>
                        <h2 className="text-body font-semibold text-content">{t('nuke.dualAuth.bannerTitle')}</h2>
                        <p className="mt-0.5 text-caption text-muted">{t('nuke.dualAuth.bannerText')}</p>
                      </div>
                    </div>
                  </Card>

                  {/* Dual-Auth Table Card */}
                  <Card flush>
                    <div className="p-4 flex flex-wrap items-center justify-between gap-3 border-b border-border">
                      <div className="flex-1 min-w-[240px] max-w-md relative">
                        <Input
                          aria-label={t('nuke.dualAuth.searchPlaceholder')}
                          placeholder={t('nuke.dualAuth.searchPlaceholder')}
                          value={dualAuthSearch}
                          onChange={(e) => setDualAuthSearch(e.target.value)}
                        />
                      </div>
                      <div className="w-48">
                        <Select
                          label="Filter by Status"
                          value={dualAuthStatusFilter}
                          onValueChange={setDualAuthStatusFilter}
                          options={[
                            { value: 'ALL', label: 'All Statuses' },
                            { value: 'pending', label: 'Pending Approval' },
                            { value: 'executed', label: 'Executed' },
                            { value: 'rejected', label: 'Rejected' },
                            { value: 'expired', label: 'Expired' }
                          ]}
                        />
                      </div>
                    </div>
                    <Table
                      caption="Dual Authorization Destruction Requests"
                      columns={dualAuthColumns}
                      rows={filteredDualAuth}
                      rowKey={(r) => r.id}
                      loading={authLoading}
                    />
                  </Card>
                </div>
              )
            },
            {
              value: 'legalHolds',
              label: t('nuke.tabs.legalHolds'),
              badge: (
                <Badge tone="danger" mono>
                  {legalHolds.filter((h) => h.active).length}
                </Badge>
              ),
              content: (
                <div className="flex flex-col gap-4">
                  {/* Legal Hold Banner */}
                  <Card className="border-danger/30 bg-danger-subtle/20">
                    <div className="flex items-start gap-3">
                      <ShieldAlert className="h-5 w-5 text-danger shrink-0 mt-0.5" />
                      <div>
                        <h2 className="text-body font-semibold text-content">{t('nuke.legalHolds.bannerTitle')}</h2>
                        <p className="mt-0.5 text-caption text-muted">{t('nuke.legalHolds.bannerText')}</p>
                      </div>
                    </div>
                  </Card>

                  {/* Legal Holds Table Card */}
                  <Card flush>
                    <div className="p-4 flex flex-wrap items-center justify-between gap-3 border-b border-border">
                      <div className="flex-1 min-w-[240px] max-w-md">
                        <Input
                          aria-label={t('nuke.legalHolds.searchPlaceholder')}
                          placeholder={t('nuke.legalHolds.searchPlaceholder')}
                          value={holdSearch}
                          onChange={(e) => setHoldSearch(e.target.value)}
                        />
                      </div>
                      <div className="w-48">
                        <Select
                          label="Filter by Status"
                          value={holdStatusFilter}
                          onValueChange={setHoldStatusFilter}
                          options={[
                            { value: 'ALL', label: 'All Holds' },
                            { value: 'ACTIVE', label: 'Active Holds' },
                            { value: 'RELEASED', label: 'Released Holds' }
                          ]}
                        />
                      </div>
                    </div>
                    <Table
                      caption="Legal Holds and Compliance Orders"
                      columns={holdColumns}
                      rows={filteredHolds}
                      rowKey={(h) => h.id}
                      loading={holdsLoading}
                    />
                  </Card>
                </div>
              )
            },
            {
              value: 'deadManSwitch',
              label: t('nuke.tabs.deadManSwitch'),
              content: (
                <div className="flex flex-col gap-6">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Owner DMS Heartbeat */}
                    <Card>
                      <CardHeader title={t('nuke.dms.heartbeatReset')} description={t('nuke.dms.heartbeatDesc')} />
                      <form onSubmit={handleHeartbeatSubmit} className="flex flex-col gap-4">
                        <FormField label="Owner Master Passphrase" required>
                          <Input
                            type="password"
                            placeholder={t('nuke.dms.passphrasePlaceholder')}
                            value={dmsPassphrase}
                            onChange={(e) => setDmsPassphrase(e.target.value)}
                            required
                          />
                        </FormField>
                        {dmsMsg && (
                          <p
                            className={
                              dmsMsg.ok
                                ? 'text-caption text-success font-medium'
                                : 'text-caption text-danger font-medium'
                            }
                          >
                            {dmsMsg.text}
                          </p>
                        )}
                        <Button type="submit" variant="primary" disabled={!dmsPassphrase}>
                          <Clock className="h-4 w-4 mr-2" />
                          {t('nuke.dms.resetBtn')}
                        </Button>
                      </form>
                    </Card>

                    {/* Warrant Canary */}
                    <Card>
                      <CardHeader
                        title={t('nuke.dms.canaryTitle')}
                        description={t('nuke.dms.canaryUpdated')}
                        actions={
                          <Badge tone="success" mono>
                            {t('nuke.dms.canaryValid')}
                          </Badge>
                        }
                      />
                      <div className="p-3 bg-surface-sunken rounded border border-border text-micro font-mono whitespace-pre-wrap leading-relaxed">
                        {`-----BEGIN NERONET WARRANT CANARY-----
Status: ZERO SUBPOENAS OR GAG ORDERS RECEIVED
Algorithm: Ed25519 Signed Signal
Verification: Validated at /.well-known/canary.txt

The operating team has received NO secret warrants,
FISA court orders, or requests demanding backdoors.
-----END NERONET WARRANT CANARY-----`}
                      </div>
                    </Card>
                  </div>

                  {/* Emergency Manual Global Purge */}
                  <Card className="border-danger/60 bg-danger-subtle/10">
                    <CardHeader
                      title={
                        <span className="flex items-center gap-2 text-danger">
                          <Skull className="h-5 w-5" />
                          {t('nuke.dms.emergencyTitle')}
                        </span>
                      }
                      description={t('nuke.dms.emergencyDesc')}
                      actions={
                        <Button
                          variant="danger"
                          onClick={() => {
                            setPurgeModalOpen(true);
                            setPurgePhrase('');
                            setPurgePassword('');
                            setPurgeError(null);
                          }}
                        >
                          {t('nuke.dms.emergencyBtn')}
                        </Button>
                      }
                    />
                  </Card>
                </div>
              )
            }
          ]}
        />

        {/* MODAL 1: Request Destruction Modal */}
        <Dialog
          open={requestModalOpen}
          onOpenChange={setRequestModalOpen}
          title={t('nuke.dualAuth.requestModal.title')}
          description={t('nuke.dualAuth.requestModal.description')}
          footer={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setRequestModalOpen(false)}>
                {t('nuke.dualAuth.requestModal.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={handleRequestSubmit}
                disabled={reqConfirmation.trim() !== 'CONFIRM DESTRUCTION' || !reqTargetId.trim()}
              >
                {t('nuke.dualAuth.requestModal.submit')}
              </Button>
            </div>
          }
        >
          <form onSubmit={handleRequestSubmit} className="flex flex-col gap-4 py-2">
            <FormField label={t('nuke.dualAuth.requestModal.targetType')} required>
              <Select
                label="Target Scope"
                value={reqTargetType}
                onValueChange={(v) => setReqTargetType(v as any)}
                options={[
                  { value: 'organization', label: 'Organization-Level Data Keys' },
                  { value: 'global', label: 'Global Sovereign Mesh Data Keys' }
                ]}
              />
            </FormField>

            <FormField label={t('nuke.dualAuth.requestModal.targetId')} required>
              <Input
                placeholder="e.g. org-target-1"
                value={reqTargetId}
                onChange={(e) => setReqTargetId(e.target.value)}
                required
                mono
              />
            </FormField>

            <FormField label={t('nuke.dualAuth.requestModal.comment')}>
              <Input
                placeholder="Administrative reason or ticket reference..."
                value={reqComment}
                onChange={(e) => setReqComment(e.target.value)}
              />
            </FormField>

            <FormField
              label={t('nuke.dualAuth.requestModal.confirmation')}
              hint="Type CONFIRM DESTRUCTION in all caps"
              error={reqError}
              required
            >
              <Input
                placeholder="CONFIRM DESTRUCTION"
                value={reqConfirmation}
                onChange={(e) => setReqConfirmation(e.target.value)}
                required
              />
            </FormField>
          </form>
        </Dialog>

        {/* MODAL 2: Approve & Execute Modal */}
        <Dialog
          open={Boolean(approveTarget)}
          onOpenChange={(open) => !open && setApproveTarget(null)}
          title={t('nuke.dualAuth.approveModal.title')}
          footer={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setApproveTarget(null)}>
                {t('nuke.dualAuth.approveModal.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={handleApproveSubmit}
                disabled={!approveCertified || Boolean(approveTargetHold)}
              >
                {t('nuke.dualAuth.approveModal.execute')}
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-4 py-2">
            <div className="p-3 rounded bg-danger-subtle/30 border border-danger/40 text-caption text-danger flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
              <span>{t('nuke.dualAuth.approveModal.warning')}</span>
            </div>

            {approveTargetHold && (
              <div className="p-3 rounded bg-warning-subtle/30 border border-warning/40 text-caption text-warning flex items-start gap-2">
                <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5" />
                <span>
                  {t('nuke.dualAuth.approveModal.holdBlocked')} ({approveTargetHold.reason})
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-caption">
              <div>
                <span className="text-subtle block">{t('nuke.dualAuth.approveModal.initiatorLabel')}</span>
                <span className="font-mono text-content font-semibold">{approveTarget?.initiator_user_id}</span>
              </div>
              <div>
                <span className="text-subtle block">{t('nuke.dualAuth.approveModal.targetLabel')}</span>
                <span className="font-mono text-content font-semibold">
                  {approveTarget?.target_id} ({approveTarget?.target_type})
                </span>
              </div>
            </div>

            <FormField label={t('nuke.dualAuth.approveModal.commentLabel')}>
              <Input
                placeholder="Approval rationale..."
                value={approveComment}
                onChange={(e) => setApproveComment(e.target.value)}
              />
            </FormField>

            <label className="flex items-start gap-2 cursor-pointer pt-2">
              <input
                type="checkbox"
                checked={approveCertified}
                onChange={(e) => setApproveCertified(e.target.checked)}
                className="mt-1"
              />
              <span className="text-caption text-content">{t('nuke.dualAuth.approveModal.confirmationPrompt')}</span>
            </label>

            {approveError && <p className="text-caption text-danger">{approveError}</p>}
          </div>
        </Dialog>

        {/* MODAL 3: Inspect Modal */}
        <Dialog
          open={Boolean(inspectTarget)}
          onOpenChange={(open) => !open && setInspectTarget(null)}
          title="Destruction Request Inspection"
          footer={
            <Button variant="secondary" onClick={() => setInspectTarget(null)}>
              Close
            </Button>
          }
        >
          {inspectTarget && (
            <div className="flex flex-col gap-3 py-2 text-caption">
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">Authorization ID</span>
                <CodeText>{inspectTarget.id}</CodeText>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">Target</span>
                <span className="font-mono font-semibold text-content">
                  {inspectTarget.target_type}: {inspectTarget.target_id}
                </span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">Initiator</span>
                <span className="font-mono text-content">{inspectTarget.initiator_user_id}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">Initiator Comment</span>
                <span className="text-content">{inspectTarget.initiator_comment || 'None'}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">Approver</span>
                <span className="font-mono text-content">{inspectTarget.approver_user_id || 'Pending'}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">Approver Comment</span>
                <span className="text-content">{inspectTarget.approver_comment || 'None'}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">Status</span>
                <Badge tone={inspectTarget.status === 'executed' ? 'danger' : 'warning'}>
                  {inspectTarget.status.toUpperCase()}
                </Badge>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">Expires At</span>
                <span className="font-mono text-content">{new Date(inspectTarget.expires_at).toLocaleString()}</span>
              </div>
            </div>
          )}
        </Dialog>

        {/* MODAL 4: Impose Legal Hold Modal */}
        <Dialog
          open={imposeModalOpen}
          onOpenChange={setImposeModalOpen}
          title={t('nuke.legalHolds.imposeModal.title')}
          description={t('nuke.legalHolds.imposeModal.description')}
          footer={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setImposeModalOpen(false)}>
                {t('nuke.legalHolds.imposeModal.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={handleImposeSubmit}
                disabled={!imposeOrgId.trim() || !imposeReason.trim()}
              >
                {t('nuke.legalHolds.imposeModal.submit')}
              </Button>
            </div>
          }
        >
          <form onSubmit={handleImposeSubmit} className="flex flex-col gap-4 py-2">
            <FormField label={t('nuke.legalHolds.imposeModal.organizationId')} required>
              <Input
                placeholder="e.g. org-enterprise-target"
                value={imposeOrgId}
                onChange={(e) => setImposeOrgId(e.target.value)}
                required
                mono
              />
            </FormField>

            <FormField
              label={t('nuke.legalHolds.imposeModal.reason')}
              hint="Case number, regulatory subpoena, or court order"
              error={imposeError}
              required
            >
              <Input
                placeholder="Court Order #2026-CV-9824 Preservation Order"
                value={imposeReason}
                onChange={(e) => setImposeReason(e.target.value)}
                required
              />
            </FormField>
          </form>
        </Dialog>

        {/* MODAL 5: Release Legal Hold Modal */}
        <Dialog
          open={Boolean(releaseTarget)}
          onOpenChange={(open) => !open && setReleaseTarget(null)}
          title={t('nuke.legalHolds.releaseModal.title')}
          description={t('nuke.legalHolds.releaseModal.description')}
          footer={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setReleaseTarget(null)}>
                {t('nuke.legalHolds.releaseModal.cancel')}
              </Button>
              <Button variant="danger" onClick={handleReleaseConfirm}>
                {t('nuke.legalHolds.releaseModal.confirm')}
              </Button>
            </div>
          }
        >
          {releaseTarget && (
            <div className="py-2 text-caption flex flex-col gap-2">
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-subtle">Hold ID</span>
                <CodeText>{releaseTarget.id}</CodeText>
              </div>
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-subtle">Organization</span>
                <span className="font-mono font-semibold text-content">{releaseTarget.organization_id}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-subtle">Reason</span>
                <span className="text-content font-medium">{releaseTarget.reason}</span>
              </div>
            </div>
          )}
        </Dialog>

        {/* MODAL 6: Emergency Global Purge Modal */}
        <Dialog
          open={purgeModalOpen}
          onOpenChange={setPurgeModalOpen}
          title={t('nuke.dms.emergencyModal.title')}
          footer={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setPurgeModalOpen(false)}>
                {t('nuke.dms.emergencyModal.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={handlePurgeSubmit}
                disabled={purgePhrase !== 'DESTROY EVERYTHING PERMANENTLY' || !purgePassword}
              >
                {t('nuke.dms.emergencyModal.confirm')}
              </Button>
            </div>
          }
        >
          <form onSubmit={handlePurgeSubmit} className="flex flex-col gap-4 py-2">
            <div className="p-3 bg-danger-subtle/30 border border-danger/50 rounded text-caption text-danger font-bold">
              {t('nuke.dms.emergencyModal.warning')}
            </div>

            <FormField
              label={t('nuke.dms.emergencyModal.phrasePrompt')}
              hint="Type DESTROY EVERYTHING PERMANENTLY in all caps"
              required
            >
              <Input
                placeholder="DESTROY EVERYTHING PERMANENTLY"
                value={purgePhrase}
                onChange={(e) => setPurgePhrase(e.target.value)}
                required
              />
            </FormField>

            <FormField label={t('nuke.dms.emergencyModal.passwordPrompt')} error={purgeError} required>
              <Input
                type="password"
                placeholder="Super-admin password..."
                value={purgePassword}
                onChange={(e) => setPurgePassword(e.target.value)}
                required
              />
            </FormField>
          </form>
        </Dialog>
      </div>
    </PageFrame>
  );
}
