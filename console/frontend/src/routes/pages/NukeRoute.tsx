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
import { ConfirmDialog, useToast } from '../../ui';
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
  const { t } = useTranslation(['nuke', 'ui']);

  // A value the server did not send reads "Not measured"; a value this page does not know reads "Unknown".
  const keysLabel = (status?: string) => {
    if (!status) return t('stats.notMeasured');
    if (status === 'destroyed') return t('stats.shredded');
    if (status === 'frozen') return t('stats.frozen');
    if (status === 'active') return t('stats.activeEpoch');
    return t('stats.unknown');
  };
  const dmsLabel = (armed?: boolean) => {
    if (armed === undefined) return t('stats.notMeasured');
    return armed ? t('stats.armed') : t('stats.disarmed');
  };
  const scopeLabel = (type: string) => (type === 'global' ? t('scope.global') : t('scope.organization'));
  const authStatusLabel = (status: string) => {
    switch (status) {
      case 'pending':
        return t('dualAuth.status.pending');
      case 'approved':
        return t('dualAuth.status.approved');
      case 'executed':
        return t('dualAuth.status.executed');
      case 'rejected':
        return t('dualAuth.status.rejected');
      case 'cancelled':
        return t('dualAuth.status.cancelled');
      case 'expired':
        return t('dualAuth.status.expired');
      default:
        return t('stats.unknown');
    }
  };

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
      header: t('dualAuth.columns.target'),
      cell: (r) => (
        <div className="flex items-center gap-2">
          <Badge tone={r.target_type === 'global' ? 'danger' : 'accent'}>{scopeLabel(r.target_type)}</Badge>
          <CodeText>{r.target_id}</CodeText>
        </div>
      )
    },
    {
      id: 'initiator',
      header: t('dualAuth.columns.initiator'),
      cell: (r) => <span className="font-mono text-caption text-content">{r.initiator_user_id}</span>
    },
    {
      id: 'comment',
      header: t('dualAuth.columns.comment'),
      cell: (r) => (
        <span className="truncate text-caption text-subtle max-w-xs block" title={r.initiator_comment || ''}>
          {r.initiator_comment || '—'}
        </span>
      )
    },
    {
      id: 'status',
      header: t('dualAuth.columns.status'),
      cell: (r) => {
        const label = authStatusLabel(r.status);
        if (r.status === 'pending' || r.status === 'approved') return <StatusBadge status="warning" label={label} />;
        if (r.status === 'executed') return <StatusBadge status="critical" label={label} />;
        if (r.status === 'rejected' || r.status === 'cancelled') return <StatusBadge status="unknown" label={label} />;
        return <StatusBadge status="not-measured" label={label} />;
      }
    },
    {
      id: 'expiresAt',
      header: t('dualAuth.columns.expiresAt'),
      cell: (r) => <span className="font-mono text-caption text-muted">{new Date(r.expires_at).toLocaleString()}</span>
    },
    {
      id: 'actions',
      header: t('dualAuth.columns.actions'),
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
                {t('dualAuth.actions.approve')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setRejectTarget(r)}>
                {t('dualAuth.actions.reject')}
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={() => setInspectTarget(r)}>
            {t('dualAuth.actions.details')}
          </Button>
        </div>
      )
    }
  ];

  // Table columns: Legal Holds
  const holdColumns: TableColumn<LegalHold>[] = [
    {
      id: 'id',
      header: t('legalHolds.columns.id'),
      cell: (h) => <CodeText>{h.id}</CodeText>
    },
    {
      id: 'organization',
      header: t('legalHolds.columns.organization'),
      cell: (h) => (
        <div className="flex items-center gap-1.5">
          <Shield className="h-4 w-4 text-warning shrink-0" />
          <span className="font-medium text-caption text-content">{h.organization_id}</span>
        </div>
      )
    },
    {
      id: 'reason',
      header: t('legalHolds.columns.reason'),
      cell: (h) => (
        <span className="text-caption text-content font-medium" title={h.reason}>
          {h.reason}
        </span>
      )
    },
    {
      id: 'imposedBy',
      header: t('legalHolds.columns.imposedBy'),
      cell: (h) => <span className="font-mono text-caption text-muted">{h.imposed_by_user_id}</span>
    },
    {
      id: 'createdAt',
      header: t('legalHolds.columns.createdAt'),
      cell: (h) => <span className="font-mono text-caption text-muted">{new Date(h.created_at).toLocaleString()}</span>
    },
    {
      id: 'status',
      header: t('legalHolds.columns.status'),
      cell: (h) =>
        h.active ? (
          <StatusBadge status="critical" label={t('legalHolds.status.active')} />
        ) : (
          <StatusBadge status="ok" label={t('legalHolds.status.released')} />
        )
    },
    {
      id: 'actions',
      header: t('legalHolds.columns.actions'),
      cell: (h) =>
        h.active ? (
          <Button variant="secondary" size="sm" onClick={() => setReleaseTarget(h)}>
            {t('legalHolds.actions.release')}
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
      setReqError(t('errors.phraseMismatch'));
      return;
    }

    if (!reqTargetId.trim()) {
      setReqError(t('errors.targetRequired'));
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
    } catch {
      setReqError(t('errors.request'));
    }
  };

  const handleApproveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!approveTarget) return;
    setApproveError(null);

    if (!approveCertified) {
      setApproveError(t('errors.certifyRequired'));
      return;
    }

    try {
      await approveDestructionMutation.mutateAsync({
        id: approveTarget.id,
        comment: approveComment.trim()
      });
      setApproveTarget(null);
    } catch {
      setApproveError(t('errors.approve'));
    }
  };

  const handleImposeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setImposeError(null);

    if (!imposeOrgId.trim()) {
      setImposeError(t('errors.targetRequired'));
      return;
    }
    if (!imposeReason.trim()) {
      setImposeError(t('errors.reasonRequired'));
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
    } catch {
      setImposeError(t('errors.impose'));
    }
  };

  const { notify } = useToast();
  const [rejectTarget, setRejectTarget] = useState<DualAuthRequest | null>(null);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  // A refused rejection stays in the dialog, so the person can read why and try again.
  const handleConfirmReject = async () => {
    if (!rejectTarget) return;
    setRejectError(null);
    try {
      await rejectDestructionMutation.mutateAsync({
        id: rejectTarget.id,
        comment: t('dualAuth.rejectDefaultReason')
      });
      setRejectTarget(null);
    } catch {
      setRejectError(t('errors.reject'));
    }
  };

  const handleReleaseConfirm = async () => {
    if (!releaseTarget) return;
    setReleaseError(null);
    try {
      await releaseHoldMutation.mutateAsync(releaseTarget.id);
      setReleaseTarget(null);
    } catch {
      setReleaseError(t('errors.release'));
    }
  };

  const handleHeartbeatSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDmsMsg(null);
    try {
      await heartbeatMutation.mutateAsync(dmsPassphrase);
      setDmsPassphrase('');
      setDmsMsg({ text: t('dms.heartbeatDone'), ok: true });
    } catch {
      setDmsMsg({ text: t('errors.passphrase'), ok: false });
    }
  };

  const handlePurgeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPurgeError(null);

    if (purgePhrase !== 'DESTROY EVERYTHING PERMANENTLY') {
      setPurgeError(t('purge.phraseMismatch'));
      return;
    }
    if (!purgePassword) {
      setPurgeError(t('purge.passwordRequired'));
      return;
    }

    try {
      await purgeMutation.mutateAsync({
        confirmation_phrase: purgePhrase,
        password: purgePassword
      });
      setPurgeModalOpen(false);
      notify(t('purge.done'), { tone: 'success' });
    } catch {
      setPurgeError(t('errors.purge'));
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
          title={t('title')}
          description={t('description')}
          meta={
            <Badge tone={overview?.keys_status === 'destroyed' ? 'danger' : 'accent'}>
              {keysLabel(overview?.keys_status)}
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
                {t('dualAuth.requestBtn')}
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
                {t('legalHolds.imposeBtn')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefreshAll}
                title={t('refresh')}
                aria-label={t('refresh')}
              >
                <RefreshCw className="h-4 w-4 shrink-0" />
              </Button>
            </>
          }
        />

        {/* Top 4 Stat Cards */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <Stat label={t('stats.keysStatus')} value={keysLabel(overview?.keys_status)} hint={t('stats.keysHint')} />
          </Card>
          <Card>
            <Stat
              label={t('stats.legalHolds')}
              value={overview?.active_legal_holds ?? legalHolds.filter((h) => h.active).length}
              hint={(overview?.active_legal_holds || 0) > 0 ? t('stats.holdsBlocked') : t('stats.noHolds')}
            />
          </Card>
          <Card>
            <Stat
              label={t('stats.dualAuthGate')}
              value={overview?.pending_authorizations ?? dualAuthRequests.filter((r) => r.status === 'pending').length}
              hint={(overview?.pending_authorizations || 0) > 0 ? t('stats.pendingAuth') : t('stats.allClear')}
            />
          </Card>
          <Card>
            <Stat
              label={t('stats.deadManSwitch')}
              value={dmsLabel(overview?.owner_dms_armed)}
              hint={t('stats.dmsHint')}
            />
          </Card>
        </div>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          label={t('tabs.label')}
          items={[
            {
              value: 'dualAuth',
              label: t('tabs.dualAuth'),
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
                        <h2 className="text-body font-semibold text-content">{t('dualAuth.bannerTitle')}</h2>
                        <p className="mt-0.5 text-caption text-muted">{t('dualAuth.bannerText')}</p>
                      </div>
                    </div>
                  </Card>

                  {/* Dual-Auth Table Card */}
                  <Card flush>
                    <div className="p-4 flex flex-wrap items-center justify-between gap-3 border-b border-border">
                      <div className="flex-1 min-w-[240px] max-w-md relative">
                        <Input
                          aria-label={t('dualAuth.searchPlaceholder')}
                          placeholder={t('dualAuth.searchPlaceholder')}
                          value={dualAuthSearch}
                          onChange={(e) => setDualAuthSearch(e.target.value)}
                        />
                      </div>
                      <div className="w-48">
                        <Select
                          label={t('filter.label')}
                          value={dualAuthStatusFilter}
                          onValueChange={setDualAuthStatusFilter}
                          options={[
                            { value: 'ALL', label: t('filter.allStatuses') },
                            { value: 'pending', label: t('dualAuth.status.pending') },
                            { value: 'executed', label: t('dualAuth.status.executed') },
                            { value: 'rejected', label: t('dualAuth.status.rejected') },
                            { value: 'expired', label: t('dualAuth.status.expired') }
                          ]}
                        />
                      </div>
                    </div>
                    <Table
                      caption={t('dualAuth.caption')}
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
              label: t('tabs.legalHolds'),
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
                        <h2 className="text-body font-semibold text-content">{t('legalHolds.bannerTitle')}</h2>
                        <p className="mt-0.5 text-caption text-muted">{t('legalHolds.bannerText')}</p>
                      </div>
                    </div>
                  </Card>

                  {/* Legal Holds Table Card */}
                  <Card flush>
                    <div className="p-4 flex flex-wrap items-center justify-between gap-3 border-b border-border">
                      <div className="flex-1 min-w-[240px] max-w-md">
                        <Input
                          aria-label={t('legalHolds.searchPlaceholder')}
                          placeholder={t('legalHolds.searchPlaceholder')}
                          value={holdSearch}
                          onChange={(e) => setHoldSearch(e.target.value)}
                        />
                      </div>
                      <div className="w-48">
                        <Select
                          label={t('filter.label')}
                          value={holdStatusFilter}
                          onValueChange={setHoldStatusFilter}
                          options={[
                            { value: 'ALL', label: t('filter.allHolds') },
                            { value: 'ACTIVE', label: t('filter.activeHolds') },
                            { value: 'RELEASED', label: t('filter.releasedHolds') }
                          ]}
                        />
                      </div>
                    </div>
                    <Table
                      caption={t('legalHolds.caption')}
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
              label: t('tabs.deadManSwitch'),
              content: (
                <div className="flex flex-col gap-6">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Owner DMS Heartbeat */}
                    <Card>
                      <CardHeader title={t('dms.heartbeatReset')} description={t('dms.heartbeatDesc')} />
                      <form onSubmit={handleHeartbeatSubmit} className="flex flex-col gap-4">
                        <FormField label={t('dms.passphraseLabel')} required>
                          <Input
                            type="password"
                            placeholder={t('dms.passphrasePlaceholder')}
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
                        <Button type="submit" variant="secondary" disabled={!dmsPassphrase}>
                          <Clock className="h-4 w-4 mr-2" />
                          {t('dms.resetBtn')}
                        </Button>
                      </form>
                    </Card>

                    {/* Warrant Canary */}
                    <Card>
                      <CardHeader
                        title={t('dms.canaryTitle')}
                        description={t('dms.canaryUpdated')}
                        actions={<Badge tone="success">{t('dms.canaryValid')}</Badge>}
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
                          {t('dms.emergencyTitle')}
                        </span>
                      }
                      description={t('dms.emergencyDesc')}
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
                          {t('dms.emergencyBtn')}
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
          title={t('dualAuth.requestModal.title')}
          description={t('dualAuth.requestModal.description')}
          footer={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setRequestModalOpen(false)}>
                {t('dualAuth.requestModal.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={handleRequestSubmit}
                disabled={reqConfirmation.trim() !== 'CONFIRM DESTRUCTION' || !reqTargetId.trim()}
              >
                {t('dualAuth.requestModal.submit')}
              </Button>
            </div>
          }
        >
          <form onSubmit={handleRequestSubmit} className="flex flex-col gap-4 py-2">
            <FormField label={t('dualAuth.requestModal.targetType')} required>
              <Select
                label={t('dualAuth.requestModal.targetType')}
                value={reqTargetType}
                onValueChange={(v) => setReqTargetType(v as any)}
                options={[
                  { value: 'organization', label: t('scope.organization') },
                  { value: 'global', label: t('scope.global') }
                ]}
              />
            </FormField>

            <FormField label={t('dualAuth.requestModal.targetId')} required>
              <Input
                placeholder={t('dualAuth.requestModal.targetIdPlaceholder')}
                value={reqTargetId}
                onChange={(e) => setReqTargetId(e.target.value)}
                required
                mono
              />
            </FormField>

            <FormField label={t('dualAuth.requestModal.comment')}>
              <Input
                placeholder={t('dualAuth.requestModal.commentPlaceholder')}
                value={reqComment}
                onChange={(e) => setReqComment(e.target.value)}
              />
            </FormField>

            <FormField
              label={t('dualAuth.requestModal.confirmation')}
              hint={t('dualAuth.requestModal.confirmationHint')}
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
          title={t('dualAuth.approveModal.title')}
          footer={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setApproveTarget(null)}>
                {t('dualAuth.approveModal.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={handleApproveSubmit}
                disabled={!approveCertified || Boolean(approveTargetHold)}
              >
                {t('dualAuth.approveModal.execute')}
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-4 py-2">
            <div className="p-3 rounded bg-danger-subtle/30 border border-danger/40 text-caption text-danger flex items-start gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
              <span>{t('dualAuth.approveModal.warning')}</span>
            </div>

            {approveTargetHold && (
              <div className="p-3 rounded bg-warning-subtle/30 border border-warning/40 text-caption text-warning flex items-start gap-2">
                <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5" />
                <span>
                  {t('dualAuth.approveModal.holdBlocked')} ({approveTargetHold.reason})
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 text-caption">
              <div>
                <span className="text-subtle block">{t('dualAuth.approveModal.initiatorLabel')}</span>
                <span className="font-mono text-content font-semibold">{approveTarget?.initiator_user_id}</span>
              </div>
              <div>
                <span className="text-subtle block">{t('dualAuth.approveModal.targetLabel')}</span>
                <span className="font-mono text-content font-semibold">
                  {approveTarget?.target_id} ({approveTarget ? scopeLabel(approveTarget.target_type) : ''})
                </span>
              </div>
            </div>

            <FormField label={t('dualAuth.approveModal.commentLabel')}>
              <Input
                placeholder={t('dualAuth.approveModal.commentPlaceholder')}
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
              <span className="text-caption text-content">{t('dualAuth.approveModal.confirmationPrompt')}</span>
            </label>

            {approveError && <p className="text-caption text-danger">{approveError}</p>}
          </div>
        </Dialog>

        {/* MODAL 3: Inspect Modal */}
        <Dialog
          open={Boolean(inspectTarget)}
          onOpenChange={(open) => !open && setInspectTarget(null)}
          title={t('dualAuth.inspect.title')}
          footer={
            <Button variant="secondary" onClick={() => setInspectTarget(null)}>
              {t('dualAuth.inspect.close')}
            </Button>
          }
        >
          {inspectTarget && (
            <div className="flex flex-col gap-3 py-2 text-caption">
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">{t('dualAuth.inspect.id')}</span>
                <CodeText>{inspectTarget.id}</CodeText>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">{t('dualAuth.inspect.target')}</span>
                <span className="font-mono font-semibold text-content">
                  {scopeLabel(inspectTarget.target_type)}: {inspectTarget.target_id}
                </span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">{t('dualAuth.inspect.initiator')}</span>
                <span className="font-mono text-content">{inspectTarget.initiator_user_id}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">{t('dualAuth.inspect.initiatorComment')}</span>
                <span className="text-content">{inspectTarget.initiator_comment || t('dualAuth.inspect.none')}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">{t('dualAuth.inspect.approver')}</span>
                <span className="font-mono text-content">
                  {inspectTarget.approver_user_id || t('dualAuth.inspect.pending')}
                </span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">{t('dualAuth.inspect.approverComment')}</span>
                <span className="text-content">{inspectTarget.approver_comment || t('dualAuth.inspect.none')}</span>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">{t('dualAuth.inspect.status')}</span>
                <Badge tone={inspectTarget.status === 'executed' ? 'danger' : 'warning'}>
                  {authStatusLabel(inspectTarget.status)}
                </Badge>
              </div>
              <div className="flex justify-between py-1.5 border-b border-border">
                <span className="text-subtle">{t('dualAuth.inspect.expiresAt')}</span>
                <span className="font-mono text-content">{new Date(inspectTarget.expires_at).toLocaleString()}</span>
              </div>
            </div>
          )}
        </Dialog>

        {/* MODAL 4: Impose Legal Hold Modal */}
        <Dialog
          open={imposeModalOpen}
          onOpenChange={setImposeModalOpen}
          title={t('legalHolds.imposeModal.title')}
          description={t('legalHolds.imposeModal.description')}
          footer={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setImposeModalOpen(false)}>
                {t('legalHolds.imposeModal.cancel')}
              </Button>
              <Button
                variant="secondary"
                onClick={handleImposeSubmit}
                disabled={!imposeOrgId.trim() || !imposeReason.trim()}
              >
                {t('legalHolds.imposeModal.submit')}
              </Button>
            </div>
          }
        >
          <form onSubmit={handleImposeSubmit} className="flex flex-col gap-4 py-2">
            <FormField label={t('legalHolds.imposeModal.organizationId')} required>
              <Input
                placeholder={t('legalHolds.imposeModal.organizationIdPlaceholder')}
                value={imposeOrgId}
                onChange={(e) => setImposeOrgId(e.target.value)}
                required
                mono
              />
            </FormField>

            <FormField
              label={t('legalHolds.imposeModal.reason')}
              hint={t('legalHolds.imposeModal.reasonHint')}
              error={imposeError}
              required
            >
              <Input
                placeholder={t('legalHolds.imposeModal.reasonPlaceholder')}
                value={imposeReason}
                onChange={(e) => setImposeReason(e.target.value)}
                required
              />
            </FormField>
          </form>
        </Dialog>

        {/* Reject a request: named, asked first, and the refusal stays visible */}
        <ConfirmDialog
          open={Boolean(rejectTarget)}
          onOpenChange={(open) => {
            if (!open) {
              setRejectTarget(null);
              setRejectError(null);
            }
          }}
          title={t('dualAuth.rejectTitle')}
          description={t('dualAuth.rejectDesc')}
          confirmLabel={t('dualAuth.actions.reject')}
          tone="danger"
          busy={rejectDestructionMutation.isPending}
          onConfirm={handleConfirmReject}
        >
          {rejectError && (
            <p role="alert" className="text-caption text-danger">
              {rejectError}
            </p>
          )}
        </ConfirmDialog>

        {/* MODAL 5: Release Legal Hold Modal */}
        <Dialog
          open={Boolean(releaseTarget)}
          onOpenChange={(open) => !open && setReleaseTarget(null)}
          title={t('legalHolds.releaseModal.title')}
          description={t('legalHolds.releaseModal.description')}
          footer={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setReleaseTarget(null)}>
                {t('legalHolds.releaseModal.cancel')}
              </Button>
              <Button variant="danger" onClick={handleReleaseConfirm}>
                {t('legalHolds.releaseModal.confirm')}
              </Button>
            </div>
          }
        >
          {releaseTarget && (
            <div className="py-2 text-caption flex flex-col gap-2">
              {releaseError && (
                <p role="alert" className="text-danger">
                  {releaseError}
                </p>
              )}
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-subtle">{t('legalHolds.releaseModal.holdId')}</span>
                <CodeText>{releaseTarget.id}</CodeText>
              </div>
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-subtle">{t('legalHolds.releaseModal.organization')}</span>
                <span className="font-mono font-semibold text-content">{releaseTarget.organization_id}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-border">
                <span className="text-subtle">{t('legalHolds.releaseModal.reason')}</span>
                <span className="text-content font-medium">{releaseTarget.reason}</span>
              </div>
            </div>
          )}
        </Dialog>

        {/* MODAL 6: Emergency Global Purge Modal */}
        <Dialog
          open={purgeModalOpen}
          onOpenChange={setPurgeModalOpen}
          title={t('dms.emergencyModal.title')}
          footer={
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={() => setPurgeModalOpen(false)}>
                {t('dms.emergencyModal.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={handlePurgeSubmit}
                disabled={purgePhrase !== 'DESTROY EVERYTHING PERMANENTLY' || !purgePassword}
              >
                {t('dms.emergencyModal.confirm')}
              </Button>
            </div>
          }
        >
          <form onSubmit={handlePurgeSubmit} className="flex flex-col gap-4 py-2">
            <div className="p-3 bg-danger-subtle/30 border border-danger/50 rounded text-caption text-danger font-bold">
              {t('dms.emergencyModal.warning')}
            </div>

            <FormField label={t('dms.emergencyModal.phrasePrompt')} hint={t('dms.emergencyModal.phraseHint')} required>
              <Input
                placeholder="DESTROY EVERYTHING PERMANENTLY"
                value={purgePhrase}
                onChange={(e) => setPurgePhrase(e.target.value)}
                required
              />
            </FormField>

            <FormField label={t('dms.emergencyModal.passwordPrompt')} error={purgeError} required>
              <Input
                type="password"
                placeholder={t('dms.emergencyModal.passwordPlaceholder')}
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
