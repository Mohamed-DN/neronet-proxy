import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../services/apiClient';
import {
  InvalidPeeringCode,
  useAcceptPeeringCode,
  useCreatePeeringCode,
  usePeeringAgreements,
  useRevokePeering,
  type CreatePeeringCodeInput,
  type PeeringAgreement
} from '../../services/queries/peering';
import { formatDate } from '../../i18n/format';
import {
  Button,
  CodeText,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  NotMeasured,
  PageHeader,
  Select,
  Skeleton,
  Table,
  Tabs,
  type SelectOption,
  type TableColumn
} from '../../ui';
import { PageFrame } from '../PageFrame';

const DAY_OPTIONS = ['7', '30', '90', '365'] as const;

/** The same rule the server applies: four octets from 0 to 255, and a prefix from 0 to 32. */
function isValidCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split('/');
  if (!address || prefix === undefined || rest.length > 0) return false;
  const mask = Number(prefix);
  if (!/^\d+$/.test(prefix) || mask < 0 || mask > 32) return false;
  const octets = address.split('.');
  return octets.length === 4 && octets.every((o) => /^\d+$/.test(o) && Number(o) <= 255);
}

function isFingerprintRequest(error: unknown): error is ApiError & { details: { fingerprint: string } } {
  if (!(error instanceof ApiError) || error.status !== 428) return false;
  const details = error.details as { fingerprint?: unknown } | null;
  return typeof details?.fingerprint === 'string';
}

type Notice = { tone: 'success' | 'error'; text: string } | null;

export default function PeeringRoute() {
  const { t, i18n } = useTranslation(['peering', 'ui']);
  const agreementsQuery = usePeeringAgreements();
  const createCode = useCreatePeeringCode();
  const acceptCode = useAcceptPeeringCode();
  const revoke = useRevokePeering();

  const [createOpen, setCreateOpen] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [scope, setScope] = useState<'ALL' | 'SPECIFIC_SUBNETS'>('ALL');
  const [ranges, setRanges] = useState('');
  const [days, setDays] = useState<(typeof DAY_OPTIONS)[number]>('90');
  const [formError, setFormError] = useState<{ field: 'endpoint' | 'ranges'; text: string } | null>(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [createFailed, setCreateFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  const [pasted, setPasted] = useState('');
  const [pendingFingerprint, setPendingFingerprint] = useState<{ code: string; fingerprint: string } | null>(null);
  const [pasteNotice, setPasteNotice] = useState<Notice>(null);

  const [revokeTarget, setRevokeTarget] = useState<PeeringAgreement | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [tab, setTab] = useState('active');

  const pasteId = useId();
  const pasteHintId = useId();

  if (agreementsQuery.isLoading && !agreementsQuery.data) {
    return (
      <PageFrame>
        <Skeleton className="h-[320px] w-full rounded-xl" />
      </PageFrame>
    );
  }

  if (agreementsQuery.error && !agreementsQuery.data) {
    return (
      <PageFrame>
        <ErrorState
          body={t('error.load')}
          detail={agreementsQuery.error.message}
          onRetry={() => void agreementsQuery.refetch()}
        />
      </PageFrame>
    );
  }

  const agreements = agreementsQuery.data ?? [];
  const active = agreements.filter((a) => a.status !== 'pending');
  const waiting = agreements.filter((a) => a.status === 'pending');

  function resetCreate() {
    setEndpoint('');
    setScope('ALL');
    setRanges('');
    setDays('90');
    setFormError(null);
    setCreatedCode(null);
    setCreateFailed(false);
    setCopied(false);
    createCode.reset();
  }

  function openCreate() {
    resetCreate();
    setCreateOpen(true);
  }

  function submitCreate() {
    setFormError(null);
    setCreateFailed(false);
    if (!endpoint.trim().startsWith('https://')) {
      setFormError({ field: 'endpoint', text: t('create.endpointInvalid') });
      return;
    }
    const subnets = ranges
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (scope === 'SPECIFIC_SUBNETS' && (subnets.length === 0 || !subnets.every(isValidCidr))) {
      setFormError({ field: 'ranges', text: t('create.subnetsInvalid') });
      return;
    }
    const input: CreatePeeringCodeInput = {
      initiator_endpoint: endpoint.trim(),
      scope_mode: scope,
      shared_subnets: scope === 'SPECIFIC_SUBNETS' ? subnets : [],
      expires_at: new Date(Date.now() + Number(days) * 86_400_000).toISOString()
    };
    createCode.mutate(input, {
      onSuccess: (code) => setCreatedCode(code),
      onError: () => setCreateFailed(true)
    });
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function acceptError(error: unknown, code: string) {
    if (isFingerprintRequest(error)) {
      setPendingFingerprint({ code, fingerprint: error.details.fingerprint });
      setPasteNotice(null);
      return;
    }
    setPendingFingerprint(null);
    if (error instanceof InvalidPeeringCode) {
      setPasteNotice({ tone: 'error', text: t('paste.invalid') });
      return;
    }
    setPasteNotice({ tone: 'error', text: t('paste.failed') });
  }

  function acceptSuccess() {
    setPasted('');
    setPendingFingerprint(null);
    setPasteNotice({ tone: 'success', text: t('paste.accepted') });
  }

  function submitPaste() {
    setPasteNotice(null);
    acceptCode.mutate({ code: pasted }, { onSuccess: acceptSuccess, onError: (e) => acceptError(e, pasted) });
  }

  function confirmFingerprint() {
    if (!pendingFingerprint) return;
    const { code, fingerprint } = pendingFingerprint;
    acceptCode.mutate(
      { code, expectedFingerprint: fingerprint },
      { onSuccess: acceptSuccess, onError: (e) => acceptError(e, code) }
    );
  }

  function confirmRevoke() {
    if (!revokeTarget) return;
    const target = revokeTarget;
    revoke.mutate(target.id, {
      onSuccess: () => {
        setRevokeTarget(null);
        setNotice({ tone: 'success', text: t('revoke.done') });
      },
      onError: () => {
        setRevokeTarget(null);
        setNotice({ tone: 'error', text: t('revoke.failed') });
      }
    });
  }

  const scopeOptions: SelectOption[] = [
    { value: 'ALL', label: t('create.scopeOptions.ALL') },
    { value: 'SPECIFIC_SUBNETS', label: t('create.scopeOptions.SPECIFIC_SUBNETS') }
  ];

  const dayOptions: SelectOption[] = DAY_OPTIONS.map((value) => ({
    value,
    label: t(`create.d${value}`)
  }));

  function scopeText(a: PeeringAgreement): string {
    if (a.scope_mode === 'SPECIFIC_SUBNETS') {
      if (!a.shared_subnets?.length) return t('scope.none');
      return t('scope.SPECIFIC_SUBNETS', { list: a.shared_subnets.join(', ') });
    }
    if (a.scope_mode === 'SPECIFIC_DEVICES') {
      return t('scope.SPECIFIC_DEVICES', { count: a.shared_device_ids?.length ?? 0 });
    }
    return t('scope.ALL');
  }

  const columns: Array<TableColumn<PeeringAgreement>> = [
    {
      id: 'network',
      header: t('columns.network'),
      cell: (a) => (
        <div className="space-y-1">
          <p className="font-medium text-content">{a.peer_name}</p>
          <CodeText>{a.initiator_endpoint}</CodeText>
        </div>
      )
    },
    { id: 'shared', header: t('columns.shared'), cell: (a) => scopeText(a) },
    {
      id: 'received',
      header: t('columns.received'),
      numeric: true,
      // The server imports no devices when a code is accepted, so an empty list
      // is not a count of devices received: it is not measured.
      cell: (a) =>
        Array.isArray(a.imported_nodes) && a.imported_nodes.length > 0 ? a.imported_nodes.length : <NotMeasured />
    },
    {
      id: 'expires',
      header: t('columns.expires'),
      cell: (a) => formatDate(i18n.language, a.expires_at) ?? <NotMeasured />
    },
    { id: 'status', header: t('columns.status'), cell: (a) => t(`status.${a.status}`) },
    {
      id: 'actions',
      header: t('columns.actions'),
      cell: (a) =>
        a.status === 'revoked' || a.status === 'expired' ? null : (
          <Button size="sm" variant="secondary" onClick={() => setRevokeTarget(a)}>
            {t('revoke.action')}
          </Button>
        )
    }
  ];

  const tabItems = [
    {
      value: 'active',
      label: t('tabs.active', { n: active.length }),
      content: (
        <Table<PeeringAgreement>
          caption={t('tabs.active', { n: active.length })}
          columns={columns}
          rows={active}
          rowKey={(a) => a.id}
          empty={<EmptyState title={t('empty.title')} body={t('empty.body')} />}
        />
      )
    },
    {
      value: 'waiting',
      label: t('tabs.waiting', { n: waiting.length }),
      content: (
        <Table<PeeringAgreement>
          caption={t('tabs.waiting', { n: waiting.length })}
          columns={columns}
          rows={waiting}
          rowKey={(a) => a.id}
          empty={<EmptyState title={t('empty.title')} body={t('empty.body')} />}
        />
      )
    },
    {
      value: 'paste',
      label: t('tabs.paste'),
      content: (
        <div className="max-w-[65ch] space-y-4">
          <div className="space-y-1">
            <h2 className="text-heading font-semibold text-content">{t('paste.title')}</h2>
            <p id={pasteHintId} className="text-body text-muted">
              {t('paste.body')}
            </p>
          </div>
          <label htmlFor={pasteId} className="block text-caption font-medium text-content">
            {t('paste.title')}
          </label>
          <textarea
            id={pasteId}
            aria-describedby={pasteHintId}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={t('paste.placeholder')}
            rows={5}
            className="w-full rounded-md border border-border-strong bg-surface-sunken p-3 font-mono text-caption text-content focus-visible:outline-focus"
          />
          {pasteNotice && (
            <p
              role={pasteNotice.tone === 'error' ? 'alert' : 'status'}
              className={pasteNotice.tone === 'error' ? 'text-body text-danger' : 'text-body text-success'}
            >
              {pasteNotice.text}
            </p>
          )}
          {pendingFingerprint ? (
            <div className="space-y-3 rounded-md border border-border p-4">
              <h3 className="text-body font-semibold text-content">{t('paste.fingerprintTitle')}</h3>
              <p className="text-body text-muted">{t('paste.fingerprintBody')}</p>
              <CodeText>{pendingFingerprint.fingerprint}</CodeText>
              <div>
                <Button variant="secondary" loading={acceptCode.isPending} onClick={confirmFingerprint}>
                  {t('paste.fingerprintConfirm')}
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="secondary" loading={acceptCode.isPending} disabled={!pasted.trim()} onClick={submitPaste}>
              {t('paste.submit')}
            </Button>
          )}
        </div>
      )
    }
  ];

  return (
    <PageFrame>
      <div className="space-y-6">
        <PageHeader
          title={t('title')}
          description={t('description')}
          primaryAction={
            <Button variant="primary" onClick={openCreate}>
              {t('actions.create')}
            </Button>
          }
        />

        {notice && (
          <p
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={notice.tone === 'error' ? 'text-body text-danger' : 'text-body text-success'}
          >
            {notice.text}
          </p>
        )}

        <Tabs items={tabItems} value={tab} onValueChange={setTab} label={t('tabs.label')} />

        <Dialog
          open={createOpen}
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open) resetCreate();
          }}
          title={t('create.title')}
          description={t('create.body')}
          footer={
            createdCode ? (
              <Button onClick={() => setCreateOpen(false)}>{t('create.done')}</Button>
            ) : (
              <>
                <Button onClick={() => setCreateOpen(false)}>{t('dialog.cancel', { ns: 'ui' })}</Button>
                <Button variant="primary" loading={createCode.isPending} onClick={submitCreate}>
                  {t('create.submit')}
                </Button>
              </>
            )
          }
        >
          {createdCode ? (
            <div className="space-y-3">
              <p className="text-body text-muted">{t('create.result')}</p>
              <CodeText copyable>{createdCode}</CodeText>
              <p className="text-caption text-muted">{copied ? t('create.copied') : null}</p>
              <Button variant="secondary" onClick={() => void copyCode(createdCode)}>
                {t('create.copy')}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {createFailed && (
                <p role="alert" className="text-body text-danger">
                  {t('create.failed')}
                </p>
              )}
              <FormField
                label={t('create.endpoint')}
                hint={t('create.endpointHint')}
                error={formError?.field === 'endpoint' ? formError.text : null}
                required
              >
                <Input mono value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://" />
              </FormField>
              <FormField label={t('create.scope')}>
                <Select
                  value={scope}
                  onValueChange={(value) => setScope(value as 'ALL' | 'SPECIFIC_SUBNETS')}
                  options={scopeOptions}
                />
              </FormField>
              {scope === 'SPECIFIC_SUBNETS' && (
                <FormField
                  label={t('create.subnets')}
                  error={formError?.field === 'ranges' ? formError.text : null}
                  required
                >
                  <Input mono value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="10.0.0.0/8" />
                </FormField>
              )}
              <FormField label={t('create.duration')}>
                <Select
                  value={days}
                  onValueChange={(value) => setDays(value as (typeof DAY_OPTIONS)[number])}
                  options={dayOptions}
                />
              </FormField>
            </div>
          )}
        </Dialog>

        <ConfirmDialog
          open={revokeTarget !== null}
          onOpenChange={(open) => {
            if (!open) setRevokeTarget(null);
          }}
          title={t('revoke.title', { name: revokeTarget?.peer_name ?? '' })}
          description={t('revoke.body')}
          confirmLabel={t('revoke.action')}
          tone="danger"
          busy={revoke.isPending}
          onConfirm={confirmRevoke}
        />
      </div>
    </PageFrame>
  );
}
