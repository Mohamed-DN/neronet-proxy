import { useMemo, useState } from 'react';
import { Play, Plus, Search, ShieldAlert, ShieldCheck, Sliders, Trash2, Edit2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { GlossaryHint } from '../GlossaryHint';

import {
  useAclDefaultPolicy,
  useAclRules,
  useCompiledPolicy,
  useCreateAclRule,
  useDeleteAclRule,
  useNodes,
  useSimulateAcl,
  useUpdateAclDefaultPolicy,
  useUpdateAclRule
} from '../../services/queries';
import type { AclRule, AclSimulationResult } from '../../services/types';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CodeText,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Skeleton,
  PageHeader,
  Select,
  type SelectOption,
  Stat,
  Switch,
  Table,
  type TableColumn
} from '../../ui';

interface RuleFormState {
  id?: string;
  priority: number;
  source_cidr: string;
  destination_cidr: string;
  protocol: 'ALL' | 'TCP' | 'UDP' | 'ICMP';
  port_start: number;
  port_end: number;
  action: 'ACCEPT' | 'DROP';
  description: string;
  enabled: boolean;
}

const DEFAULT_FORM: RuleFormState = {
  priority: 100,
  source_cidr: '100.64.0.0/10',
  destination_cidr: '100.64.0.0/10',
  protocol: 'ALL',
  port_start: 0,
  port_end: 65535,
  action: 'ACCEPT',
  description: '',
  enabled: true
};

export default function AclsRoute() {
  const { t } = useTranslation('ui');

  // Queries
  const { data: aclData, isLoading, error, refetch } = useAclRules();
  const { data: defaultPolicyData } = useAclDefaultPolicy();
  const { data: nodes = [] } = useNodes();

  // Mutations
  const createRule = useCreateAclRule();
  const updateRule = useUpdateAclRule();
  const deleteRule = useDeleteAclRule();
  const updateDefaultPolicy = useUpdateAclDefaultPolicy();
  const simulateAcl = useSimulateAcl();

  // Filters & Search
  const [searchTerm, setSearchTerm] = useState('');
  const [actionFilter, setActionFilter] = useState<'ALL' | 'ACCEPT' | 'DROP'>('ALL');
  const [protoFilter, setProtoFilter] = useState<string>('ALL');

  // Modals state
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [formData, setFormData] = useState<RuleFormState>(DEFAULT_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  // Delete modal
  const [deleteTarget, setDeleteTarget] = useState<AclRule | null>(null);

  // Policy toggle confirm modal
  const [policyConfirmOpen, setPolicyConfirmOpen] = useState(false);

  // Preview & Simulator modal
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTab, setPreviewTab] = useState<'compiled' | 'simulator'>('compiled');
  const [selectedNodeId, setSelectedNodeId] = useState<string>(nodes[0]?.id || '');
  const { data: compiledPolicy, isLoading: isCompiledLoading } = useCompiledPolicy(selectedNodeId || null);

  // Simulator form state
  const [simSource, setSimSource] = useState('100.64.10.1');
  const [simDest, setSimDest] = useState('100.64.10.2');
  const [simProto, setSimProto] = useState('TCP');
  const [simPort, setSimPort] = useState(443);
  const [simResult, setSimResult] = useState<AclSimulationResult | null>(null);

  // Rules list
  const rules = aclData?.rules || [];
  const epoch = aclData?.epoch ?? 1;
  const policyIsOpen = aclData?.policy_is_open ?? rules.length === 0;
  const defaultPolicy = defaultPolicyData?.default_policy || 'deny';

  // Filtered rows
  const filteredRules = useMemo(() => {
    return rules.filter((r) => {
      const src = r.source_cidr || r.src_cidr || '';
      const dst = r.destination_cidr || r.dst_cidr || '';
      const desc = r.description || '';
      const prio = String(r.priority || '');
      const action = (r.action || '').toUpperCase();
      const proto = (r.protocol || r.proto || 'ALL').toUpperCase();

      if (actionFilter !== 'ALL' && action !== actionFilter) return false;
      if (protoFilter !== 'ALL' && proto !== protoFilter) return false;

      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        return (
          src.toLowerCase().includes(q) ||
          dst.toLowerCase().includes(q) ||
          desc.toLowerCase().includes(q) ||
          prio.includes(q)
        );
      }
      return true;
    });
  }, [rules, searchTerm, actionFilter, protoFilter]);

  // Form Handlers
  const handleOpenCreate = () => {
    setEditingRuleId(null);
    setFormData({
      ...DEFAULT_FORM,
      priority: rules.length > 0 ? Math.max(...rules.map((r) => r.priority || 100)) + 10 : 100
    });
    setFormError(null);
    setRuleModalOpen(true);
  };

  const handleOpenEdit = (rule: AclRule) => {
    setEditingRuleId(rule.id);
    setFormData({
      id: rule.id,
      priority: rule.priority ?? 100,
      source_cidr: rule.source_cidr || rule.src_cidr || '0.0.0.0/0',
      destination_cidr: rule.destination_cidr || rule.dst_cidr || '0.0.0.0/0',
      protocol: (rule.protocol || rule.proto || 'ALL').toUpperCase() as RuleFormState['protocol'],
      port_start: rule.port_start ?? 0,
      port_end: rule.port_end ?? 65535,
      action: (rule.action || 'ACCEPT').toUpperCase() as RuleFormState['action'],
      description: rule.description || '',
      enabled: rule.enabled ?? true
    });
    setFormError(null);
    setRuleModalOpen(true);
  };

  const handlePresetSelect = (preset: string) => {
    switch (preset) {
      case 'all-mesh':
        setFormData((prev) => ({
          ...prev,
          source_cidr: '100.64.0.0/10',
          destination_cidr: '100.64.0.0/10',
          protocol: 'ALL',
          port_start: 0,
          port_end: 65535,
          action: 'ACCEPT',
          description: t('acl.form.presetAllMesh')
        }));
        break;
      case 'egress':
        setFormData((prev) => ({
          ...prev,
          source_cidr: '100.64.0.0/10',
          destination_cidr: '0.0.0.0/0',
          protocol: 'ALL',
          port_start: 0,
          port_end: 65535,
          action: 'ACCEPT',
          description: t('acl.form.presetEgress')
        }));
        break;
      case 'https':
        setFormData((prev) => ({
          ...prev,
          protocol: 'TCP',
          port_start: 443,
          port_end: 443,
          action: 'ACCEPT',
          description: t('acl.form.presetHttps')
        }));
        break;
      case 'dns':
        setFormData((prev) => ({
          ...prev,
          protocol: 'UDP',
          port_start: 53,
          port_end: 53,
          action: 'ACCEPT',
          description: t('acl.form.presetDns')
        }));
        break;
      case 'ssh':
        setFormData((prev) => ({
          ...prev,
          protocol: 'TCP',
          port_start: 22,
          port_end: 22,
          action: 'ACCEPT',
          description: t('acl.form.presetSsh')
        }));
        break;
      case 'wireguard':
        setFormData((prev) => ({
          ...prev,
          protocol: 'UDP',
          port_start: 51820,
          port_end: 51820,
          action: 'ACCEPT',
          description: t('acl.form.presetWireguard')
        }));
        break;
    }
  };

  const handleSubmitRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    try {
      if (editingRuleId) {
        await updateRule.mutateAsync({
          id: editingRuleId,
          updates: {
            priority: Number(formData.priority),
            source_cidr: formData.source_cidr.trim(),
            destination_cidr: formData.destination_cidr.trim(),
            protocol: formData.protocol,
            port_start: Number(formData.port_start),
            port_end: Number(formData.port_end),
            action: formData.action,
            description: formData.description.trim(),
            enabled: formData.enabled
          }
        });
      } else {
        await createRule.mutateAsync({
          priority: Number(formData.priority),
          source_cidr: formData.source_cidr.trim(),
          destination_cidr: formData.destination_cidr.trim(),
          protocol: formData.protocol,
          port_start: Number(formData.port_start),
          port_end: Number(formData.port_end),
          action: formData.action,
          description:
            formData.description.trim() ||
            `${formData.action} ${formData.protocol} ${formData.source_cidr} -> ${formData.destination_cidr}`,
          enabled: formData.enabled
        });
      }
      setRuleModalOpen(false);
    } catch (err: any) {
      setFormError(err?.message || 'Failed to persist ACL rule');
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteRule.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch (err: any) {
      setFormError(err?.message || 'Failed to delete rule');
    }
  };

  const handleToggleDefaultPolicy = async () => {
    const nextPolicy = defaultPolicy === 'deny' ? 'open' : 'deny';
    try {
      await updateDefaultPolicy.mutateAsync(nextPolicy);
      setPolicyConfirmOpen(false);
    } catch (err: any) {
      alert(err?.message || 'Failed to change default policy');
    }
  };

  const handleRunSimulation = async () => {
    try {
      const res = await simulateAcl.mutateAsync({
        source_ip: simSource.trim(),
        destination_ip: simDest.trim(),
        protocol: simProto,
        port: Number(simPort)
      });
      setSimResult(res);
    } catch (err: any) {
      alert(err?.message || 'Simulation failed');
    }
  };

  // Table Columns
  const columns: Array<TableColumn<AclRule>> = useMemo(
    () => [
      {
        id: 'priority',
        header: t('acl.columns.priority'),
        cell: (r) => <span className="font-mono font-bold text-accent">#{r.priority ?? 100}</span>,
        width: '80px'
      },
      {
        id: 'source',
        header: t('acl.columns.sourceCidr'),
        cell: (r) => <CodeText>{r.source_cidr || r.src_cidr || '0.0.0.0/0'}</CodeText>
      },
      {
        id: 'destination',
        header: t('acl.columns.destCidr'),
        cell: (r) => <CodeText>{r.destination_cidr || r.dst_cidr || '0.0.0.0/0'}</CodeText>
      },
      {
        id: 'protocol_ports',
        header: t('acl.columns.protoPorts'),
        cell: (r) => {
          const proto = (r.protocol || r.proto || 'ALL').toUpperCase();
          const pStart = r.port_start ?? 0;
          const pEnd = r.port_end ?? 65535;
          const portsDesc = pStart === 0 && pEnd === 65535 ? t('acl.columns.allPorts') : `${pStart} - ${pEnd}`;
          return (
            <span className="font-mono text-xs">
              <span className="font-bold">{proto}</span> • {portsDesc}
            </span>
          );
        }
      },
      {
        id: 'action',
        header: t('acl.columns.action'),
        cell: (r) => {
          const isAccept = (r.action || 'ACCEPT').toUpperCase() === 'ACCEPT';
          return (
            <Badge tone={isAccept ? 'success' : 'danger'}>
              {isAccept ? t('acl.form.actionAccept') : t('acl.form.actionDrop')}
            </Badge>
          );
        },
        width: '130px'
      },
      {
        id: 'status',
        header: t('acl.columns.status'),
        cell: (r) => (
          <Badge tone={r.enabled !== false ? 'neutral' : 'warning'}>
            {r.enabled !== false ? 'Active' : 'Disabled'}
          </Badge>
        ),
        width: '90px'
      },
      {
        id: 'description',
        header: t('acl.columns.description'),
        cell: (r) => <span className="text-muted text-xs line-clamp-1">{r.description || '—'}</span>
      },
      {
        id: 'actions',
        header: t('acl.columns.actions'),
        cell: (r) => (
          <div className="flex items-center space-x-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => handleOpenEdit(r)}
              aria-label={`${t('acl.columns.actions')} ${r.id}`}
            >
              <Edit2 className="w-3.5 h-3.5" />
            </Button>
            <Button size="sm" variant="danger" onClick={() => setDeleteTarget(r)} aria-label={`Delete rule ${r.id}`}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        ),
        numeric: true,
        width: '110px'
      }
    ],
    [t]
  );

  if (isLoading && !aclData) {
    return <Skeleton className="h-[400px] w-full rounded-xl" />;
  }

  if (error && !aclData) {
    return <ErrorState detail={error.message} onRetry={() => refetch()} />;
  }

  const actionOptions: SelectOption[] = [
    { value: 'ALL', label: t('acl.filterActionAll') },
    { value: 'ACCEPT', label: t('acl.filterActionAccept') },
    { value: 'DROP', label: t('acl.filterActionDrop') }
  ];

  const protoOptions: SelectOption[] = [
    { value: 'ALL', label: t('acl.filterProtoAll') },
    { value: 'TCP', label: 'TCP' },
    { value: 'UDP', label: 'UDP' },
    { value: 'ICMP', label: 'ICMP' }
  ];

  const presetOptions: SelectOption[] = [
    { value: 'custom', label: t('acl.form.presetCustom') },
    { value: 'all-mesh', label: t('acl.form.presetAllMesh') },
    { value: 'egress', label: t('acl.form.presetEgress') },
    { value: 'https', label: t('acl.form.presetHttps') },
    { value: 'dns', label: t('acl.form.presetDns') },
    { value: 'ssh', label: t('acl.form.presetSsh') },
    { value: 'wireguard', label: t('acl.form.presetWireguard') }
  ];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <PageHeader
        title={t('acl.title')}
        description={t('acl.description')}
        meta={
          <GlossaryHint
            text={t('glossary.acl.body')}
            label={t('glossary.ariaLabel', { term: t('glossary.acl.term') })}
          />
        }
        actions={
          <div className="flex items-center space-x-3">
            <Button variant="secondary" onClick={() => setPreviewOpen(true)} data-testid="preview-simulator-button">
              <Play className="w-4 h-4 mr-2" />
              <span>{t('acl.previewSimulate')}</span>
            </Button>
            <Button variant="primary" onClick={handleOpenCreate} data-testid="add-rule-button">
              <Plus className="w-4 h-4 mr-2" />
              <span>{t('acl.addRule')}</span>
            </Button>
          </div>
        }
      />

      {/* Stats Overview */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat
          label={t('acl.stats.activeRules')}
          value={rules.length}
          hint={rules.length === 0 ? t('acl.stats.hintPermissive') : t('acl.stats.hintZeroTrust')}
        />
        <Stat
          label={t('acl.stats.defaultPolicy')}
          value={defaultPolicy.toUpperCase()}
          hint={defaultPolicy === 'deny' ? t('acl.stats.hintStrict') : t('acl.stats.hintPermissiveAllow')}
        />
        <Stat label={t('acl.stats.policyEpoch')} value={`#${epoch}`} hint={t('acl.stats.epochHint')} />
        <Stat label={t('acl.stats.enforcingNodes')} value={nodes.length} hint={t('acl.stats.hintEnforcing')} />
      </div>

      {/* Mesh Policy Open vs Zero-Trust Status Banner */}
      {policyIsOpen ? (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 space-y-1">
          <div className="flex items-center space-x-2 text-warning font-bold text-sm">
            <ShieldAlert className="w-5 h-5 flex-shrink-0" />
            <span>{t('acl.statusBanner.openTitle')}</span>
          </div>
          <p className="text-xs text-muted leading-relaxed pl-7">{t('acl.statusBanner.openDesc')}</p>
        </div>
      ) : (
        <div className="rounded-xl border border-success/40 bg-success/10 p-4 space-y-1">
          <div className="flex items-center space-x-2 text-success font-bold text-sm">
            <ShieldCheck className="w-5 h-5 flex-shrink-0" />
            <span>{t('acl.statusBanner.enforcedTitle')}</span>
          </div>
          <p className="text-xs text-muted leading-relaxed pl-7">{t('acl.statusBanner.enforcedDesc')}</p>
        </div>
      )}

      {/* Organization Default Policy Card */}
      <Card>
        <CardHeader
          as="h2"
          title={t('acl.defaultPolicyCard.title')}
          description={t('acl.defaultPolicyCard.description')}
        />
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2">
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <Badge tone={defaultPolicy === 'deny' ? 'success' : 'warning'}>
                {defaultPolicy === 'deny' ? t('acl.defaultPolicyCard.denyLabel') : t('acl.defaultPolicyCard.openLabel')}
              </Badge>
              <span className="text-xs text-muted">
                {defaultPolicy === 'deny' ? t('acl.defaultPolicyCard.denyExpl') : t('acl.defaultPolicyCard.openExpl')}
              </span>
            </div>
          </div>
          <Button
            variant={defaultPolicy === 'deny' ? 'secondary' : 'primary'}
            onClick={() => setPolicyConfirmOpen(true)}
            loading={updateDefaultPolicy.isPending}
            data-testid="toggle-default-policy-button"
          >
            <Sliders className="w-4 h-4 mr-2" />
            <span>
              {defaultPolicy === 'deny'
                ? t('acl.defaultPolicyCard.toggleToOpen')
                : t('acl.defaultPolicyCard.toggleToDeny')}
            </span>
          </Button>
        </div>
      </Card>

      {/* Rules Table Filters & Search */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex-1 max-w-md relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <Input
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t('acl.searchPlaceholder')}
            className="pl-9"
            aria-label="Filter rules search"
          />
        </div>
        <div className="flex items-center space-x-3">
          <div className="w-36">
            <Select
              value={actionFilter}
              onValueChange={(val) => setActionFilter(val as any)}
              options={actionOptions}
              label="Filter by action"
              aria-label="Filter by action"
            />
          </div>
          <div className="w-36">
            <Select
              value={protoFilter}
              onValueChange={setProtoFilter}
              options={protoOptions}
              label="Filter by protocol"
              aria-label="Filter by protocol"
            />
          </div>
        </div>
      </div>

      {/* Rules Table */}
      <Table<AclRule>
        caption="Active Zero-Trust Access Control Rules"
        columns={columns}
        rows={filteredRules}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title={rules.length === 0 ? t('acl.empty.title') : t('acl.empty.noMatches')}
            body={rules.length === 0 ? t('acl.empty.desc') : undefined}
            action={
              rules.length === 0 ? (
                <Button variant="primary" onClick={handleOpenCreate}>
                  <Plus className="w-4 h-4 mr-2" />
                  <span>{t('acl.addRule')}</span>
                </Button>
              ) : undefined
            }
          />
        }
      />

      {/* Rule Builder / Editor Dialog */}
      <Dialog
        open={ruleModalOpen}
        onOpenChange={setRuleModalOpen}
        title={editingRuleId ? t('acl.form.editTitle') : t('acl.form.createTitle')}
        description={t('acl.form.subtitle')}
        size="lg"
        footer={
          <div className="flex items-center justify-end space-x-3">
            <Button variant="secondary" onClick={() => setRuleModalOpen(false)}>
              {t('acl.form.cancelAction')}
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmitRule}
              loading={createRule.isPending || updateRule.isPending}
              data-testid="save-rule-button"
            >
              {editingRuleId ? t('acl.form.saveAction') : t('acl.form.createAction')}
            </Button>
          </div>
        }
      >
        <form onSubmit={handleSubmitRule} className="space-y-4 py-2">
          {formError && (
            <div className="p-3 rounded-lg bg-danger/10 border border-danger/30 text-xs text-danger">{formError}</div>
          )}

          {!editingRuleId && (
            <FormField label={t('acl.form.presetLabel')}>
              <Select
                value="custom"
                onValueChange={handlePresetSelect}
                options={presetOptions}
                aria-label="Quick preset"
              />
            </FormField>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label={t('acl.form.priorityLabel')} hint={t('acl.form.priorityHint')} required>
              <Input
                type="number"
                min={1}
                max={65535}
                value={formData.priority}
                onChange={(e) =>
                  setFormData((p) => ({
                    ...p,
                    priority: Number(e.target.value)
                  }))
                }
                required
              />
            </FormField>

            <FormField label={t('acl.form.actionLabel')} required>
              <Select
                value={formData.action}
                onValueChange={(val) => setFormData((p) => ({ ...p, action: val as any }))}
                options={[
                  { value: 'ACCEPT', label: t('acl.form.actionAccept') },
                  { value: 'DROP', label: t('acl.form.actionDrop') }
                ]}
              />
            </FormField>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label={t('acl.form.sourceLabel')} hint={t('acl.form.sourcePlaceholder')} required>
              <Input
                value={formData.source_cidr}
                onChange={(e) => setFormData((p) => ({ ...p, source_cidr: e.target.value }))}
                placeholder="100.64.0.0/10"
                required
              />
            </FormField>

            <FormField label={t('acl.form.destLabel')} hint={t('acl.form.destPlaceholder')} required>
              <Input
                value={formData.destination_cidr}
                onChange={(e) =>
                  setFormData((p) => ({
                    ...p,
                    destination_cidr: e.target.value
                  }))
                }
                placeholder="100.64.0.0/10"
                required
              />
            </FormField>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <FormField label={t('acl.form.protoLabel')} required>
              <Select
                value={formData.protocol}
                onValueChange={(val) => setFormData((p) => ({ ...p, protocol: val as any }))}
                options={[
                  { value: 'ALL', label: 'ALL' },
                  { value: 'TCP', label: 'TCP' },
                  { value: 'UDP', label: 'UDP' },
                  { value: 'ICMP', label: 'ICMP' }
                ]}
              />
            </FormField>

            <FormField label={t('acl.form.portStartLabel')} required>
              <Input
                type="number"
                min={0}
                max={65535}
                value={formData.port_start}
                onChange={(e) =>
                  setFormData((p) => ({
                    ...p,
                    port_start: Number(e.target.value)
                  }))
                }
                required
              />
            </FormField>

            <FormField label={t('acl.form.portEndLabel')} required>
              <Input
                type="number"
                min={0}
                max={65535}
                value={formData.port_end}
                onChange={(e) =>
                  setFormData((p) => ({
                    ...p,
                    port_end: Number(e.target.value)
                  }))
                }
                required
              />
            </FormField>
          </div>

          <FormField label={t('acl.form.descLabel')}>
            <Input
              value={formData.description}
              onChange={(e) => setFormData((p) => ({ ...p, description: e.target.value }))}
              placeholder={t('acl.form.descPlaceholder')}
            />
          </FormField>

          <FormField label={t('acl.form.enabledLabel')}>
            <Switch
              checked={formData.enabled}
              onCheckedChange={(checked) => setFormData((p) => ({ ...p, enabled: checked }))}
              description={formData.enabled ? 'Rule is active in netstack' : 'Rule is disabled'}
            />
          </FormField>
        </form>
      </Dialog>

      {/* Delete Rule Confirmation Dialog */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t('acl.delete.title', {
          priority: deleteTarget?.priority || 100
        })}
        description={t('acl.delete.description', {
          id: deleteTarget?.id || '',
          source: deleteTarget?.source_cidr || deleteTarget?.src_cidr || '',
          destination: deleteTarget?.destination_cidr || deleteTarget?.dst_cidr || ''
        })}
        confirmLabel={t('acl.delete.confirmAction')}
        tone="danger"
        busy={deleteRule.isPending}
        onConfirm={handleConfirmDelete}
      />

      {/* Default Policy Toggle Confirmation Dialog */}
      <ConfirmDialog
        open={policyConfirmOpen}
        onOpenChange={setPolicyConfirmOpen}
        title={t('acl.defaultPolicyCard.confirmTitle')}
        description={t('acl.defaultPolicyCard.confirmDesc', {
          policy: (defaultPolicy === 'deny' ? 'OPEN' : 'DENY').toUpperCase()
        })}
        confirmLabel={t('acl.defaultPolicyCard.confirmAction')}
        tone={defaultPolicy === 'deny' ? 'primary' : 'danger'}
        busy={updateDefaultPolicy.isPending}
        onConfirm={handleToggleDefaultPolicy}
      />

      {/* Preview & Simulator Modal */}
      <Dialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title={t('acl.preview.title')}
        description={t('acl.preview.subtitle')}
        size="lg"
        footer={
          <Button variant="secondary" onClick={() => setPreviewOpen(false)}>
            {t('acl.preview.close')}
          </Button>
        }
      >
        <div className="space-y-4 py-2">
          {/* Tabs header */}
          <div className="flex border-b border-border">
            <button
              onClick={() => setPreviewTab('compiled')}
              className={`px-4 py-2 text-xs font-bold font-mono transition-colors border-b-2 ${
                previewTab === 'compiled'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-content'
              }`}
            >
              {t('acl.preview.tabCompiled')}
            </button>
            <button
              onClick={() => setPreviewTab('simulator')}
              className={`px-4 py-2 text-xs font-bold font-mono transition-colors border-b-2 ${
                previewTab === 'simulator'
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-content'
              }`}
            >
              {t('acl.preview.tabSimulator')}
            </button>
          </div>

          {previewTab === 'compiled' ? (
            <div className="space-y-4">
              <FormField label={t('acl.preview.selectNode')}>
                <Select
                  value={selectedNodeId}
                  onValueChange={setSelectedNodeId}
                  options={
                    nodes.map((n) => ({
                      value: n.id,
                      label: `${n.name || n.id} (${n.overlay_ipv4 || 'No VIP'})`
                    })) || []
                  }
                  placeholder={nodes.length === 0 ? t('acl.preview.noNodes') : undefined}
                />
              </FormField>

              {isCompiledLoading ? (
                <Skeleton className="h-40 w-full rounded-lg" />
              ) : compiledPolicy ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between text-xs font-mono p-2 rounded bg-surface border border-border">
                    <span className="text-muted">
                      {t('acl.preview.nodeVip', {
                        ip: compiledPolicy.overlay_ipv4
                      })}
                    </span>
                    <Badge tone="neutral">Epoch #{compiledPolicy.epoch}</Badge>
                  </div>

                  {/* Inbound Rules */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold font-mono uppercase tracking-wider text-muted">
                      {t('acl.preview.inboundTitle')}
                    </h4>
                    {compiledPolicy.inbound_rules.length === 0 ? (
                      <p className="text-xs text-muted font-mono">{t('acl.preview.noRulesCompiled')}</p>
                    ) : (
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {compiledPolicy.inbound_rules.map((ir, i) => (
                          <div
                            key={i}
                            className="p-2 rounded bg-surface text-xs font-mono flex items-center justify-between border border-border/50"
                          >
                            <span>
                              {t('acl.preview.peerVip')}: <CodeText>{ir.allowed_peer_vip}</CodeText> • {ir.protocol}
                            </span>
                            <Badge tone={ir.action === 'ACCEPT' ? 'success' : 'danger'}>{ir.action}</Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Outbound Rules */}
                  <div className="space-y-2">
                    <h4 className="text-xs font-bold font-mono uppercase tracking-wider text-muted">
                      {t('acl.preview.outboundTitle')}
                    </h4>
                    {compiledPolicy.outbound_rules.length === 0 ? (
                      <p className="text-xs text-muted font-mono">{t('acl.preview.noRulesCompiled')}</p>
                    ) : (
                      <div className="max-h-40 overflow-y-auto space-y-1">
                        {compiledPolicy.outbound_rules.map((orRule, i) => (
                          <div
                            key={i}
                            className="p-2 rounded bg-surface text-xs font-mono flex items-center justify-between border border-border/50"
                          >
                            <span>
                              {t('acl.preview.peerVip')}: <CodeText>{orRule.allowed_peer_vip}</CodeText> •{' '}
                              {orRule.protocol}
                            </span>
                            <Badge tone={orRule.action === 'ACCEPT' ? 'success' : 'danger'}>{orRule.action}</Badge>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <EmptyState title="No compiled policy" body="Select a registered node to inspect its policy." />
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label={t('acl.preview.simSourceIp')} required>
                  <Input value={simSource} onChange={(e) => setSimSource(e.target.value)} placeholder="100.64.10.1" />
                </FormField>
                <FormField label={t('acl.preview.simDestIp')} required>
                  <Input value={simDest} onChange={(e) => setSimDest(e.target.value)} placeholder="100.64.10.2" />
                </FormField>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <FormField label={t('acl.preview.simProto')} required>
                  <Select
                    value={simProto}
                    onValueChange={setSimProto}
                    options={[
                      { value: 'TCP', label: 'TCP' },
                      { value: 'UDP', label: 'UDP' },
                      { value: 'ICMP', label: 'ICMP' }
                    ]}
                  />
                </FormField>
                <FormField label={t('acl.preview.simPort')} required>
                  <Input
                    type="number"
                    min={0}
                    max={65535}
                    value={simPort}
                    onChange={(e) => setSimPort(Number(e.target.value))}
                  />
                </FormField>
              </div>

              <Button
                variant="primary"
                onClick={handleRunSimulation}
                loading={simulateAcl.isPending}
                className="w-full"
                data-testid="simulate-packet-submit"
              >
                <Play className="w-4 h-4 mr-2" />
                <span>{t('acl.preview.simButton')}</span>
              </Button>

              {simResult && (
                <div
                  className={`p-4 rounded-xl border text-xs font-mono space-y-2 ${
                    simResult.verdict === 'ACCEPT' ? 'border-success/40 bg-success/10' : 'border-danger/40 bg-danger/10'
                  }`}
                  data-testid="simulation-result-card"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm">
                      {simResult.verdict === 'ACCEPT' ? t('acl.preview.verdictAccept') : t('acl.preview.verdictDrop')}
                    </span>
                    <Badge tone={simResult.verdict === 'ACCEPT' ? 'success' : 'danger'}>{simResult.verdict}</Badge>
                  </div>
                  <p className="text-muted leading-relaxed">{simResult.reason}</p>
                  {simResult.matched_rule && (
                    <div className="pt-2 border-t border-border/50 text-[11px] text-muted">
                      {t('acl.preview.matchedRule', {
                        priority: simResult.matched_rule.priority,
                        id: simResult.matched_rule.id
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}
