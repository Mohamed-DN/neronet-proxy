import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Circle, CircleDot, CheckCircle2, Plus } from 'lucide-react';
import type { UseQueryResult } from '@tanstack/react-query';

import { PageFrame } from '../PageFrame';
import { QrCode } from '../../devices/QrCode';
import { ApiError } from '../../services/apiClient';
import {
  useAddCustomDomain,
  useCloudPcs,
  useCreateAccessLink,
  useCustomDomains,
  useDeleteCustomDomain,
  useVerifyCustomDomain,
  type CloudPc,
  type CustomDomain
} from '../../services/queries/cloudpc';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Checkbox';
import { CodeText } from '../../ui/CodeText';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { Dialog } from '../../ui/Dialog';
import { FormField } from '../../ui/FormField';
import { Input } from '../../ui/Input';
import { PageHeader } from '../../ui/PageHeader';
import { RowList, Row } from '../../ui/RowList';
import { Select } from '../../ui/Select';
import { EmptyState, ErrorState, NotMeasured, Skeleton } from '../../ui/States';
import { Table, type TableColumn } from '../../ui/Table';
import { Tabs } from '../../ui/Tabs';
import { useToast } from '../../ui/Toast';

/*
 * The virtual computers page. It lists the computers, makes access links for
 * them and maps company domains to them. It does not run a streaming service,
 * and says so: the access link is a token this console issues, and it will not
 * connect until a streaming service exists.
 */

const NO_COMPUTERS: CloudPc[] = [];
const NO_DOMAINS: CustomDomain[] = [];

type Tab = 'computers' | 'domains';

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

function formatGb(megabytes: number): string {
  return Number((megabytes / 1024).toFixed(1)).toString();
}

interface QueryViewProps<T> {
  query: UseQueryResult<T, Error>;
  isEmpty: (data: T) => boolean;
  emptyTitle: string;
  emptyBody: string;
  children: (data: T) => React.ReactNode;
}

/**
 * Loading, failure, empty and data, in the order the console requires: a
 * failed query shows its error ahead of whatever it last held.
 */
function QueryView<T>({ query, isEmpty, emptyTitle, emptyBody, children }: QueryViewProps<T>) {
  const { t } = useTranslation('ui');
  const { t: tc } = useTranslation('cloudpc');

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        detail={query.error?.message ?? null}
        body={isForbidden(query.error) ? undefined : tc('error.load')}
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.data === undefined) {
    return (
      <div>
        <p className="sr-only" role="status">
          {t('state.loading')}
        </p>
        <Skeleton lines={3} />
      </div>
    );
  }
  if (isEmpty(query.data)) return <EmptyState title={emptyTitle} body={emptyBody} />;
  return <>{children(query.data)}</>;
}

function ComputerStatus({ status }: { status: string | null | undefined }) {
  const { t } = useTranslation('cloudpc');
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption text-content">
        <CircleDot aria-hidden="true" className="h-3.5 w-3.5 text-success" />
        {t('status.running')}
      </span>
    );
  }
  if (status === 'stopped') {
    return (
      <span className="inline-flex items-center gap-1.5 text-caption text-muted">
        <Circle aria-hidden="true" className="h-3.5 w-3.5" />
        {t('status.stopped')}
      </span>
    );
  }
  // A status the console does not name is shown as the server sent it; a missing one is unknown.
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-muted">
      <Circle aria-hidden="true" className="h-3.5 w-3.5" />
      {status ? status : t('status.unknown')}
    </span>
  );
}

function computerResources(pc: CloudPc, t: (key: string, options?: Record<string, unknown>) => string) {
  const ram = typeof pc.memory_mb === 'number' ? t('resources.gb', { value: formatGb(pc.memory_mb) }) : null;
  const disk = typeof pc.storage_gb === 'number' ? t('resources.gb', { value: pc.storage_gb }) : null;
  return (
    <span className="flex flex-wrap gap-x-4 tabular-nums">
      <span>
        {t('resources.cpu')}: {typeof pc.cpu_cores === 'number' ? pc.cpu_cores : <NotMeasured />}
      </span>
      <span>
        {t('resources.ram')}: {ram ?? <NotMeasured />}
      </span>
      <span>
        {t('resources.disk')}: {disk ?? <NotMeasured />}
      </span>
      {pc.gpu_acceleration === true && (
        <span>
          {t('resources.gpu')}: {t('resources.gpuAvailable')}
        </span>
      )}
    </span>
  );
}

export default function CloudPcRoute() {
  return (
    <PageFrame>
      <CloudPcPage />
    </PageFrame>
  );
}

function CloudPcPage() {
  const { t } = useTranslation('cloudpc');
  const { notify } = useToast();
  const computersQuery = useCloudPcs();
  const domainsQuery = useCustomDomains();
  const createLink = useCreateAccessLink();
  const addDomain = useAddCustomDomain();
  const deleteDomain = useDeleteCustomDomain();
  const verifyDomain = useVerifyCustomDomain();

  const [tab, setTab] = useState<Tab>('computers');
  const [actionError, setActionError] = useState<string | null>(null);
  const [verifyNote, setVerifyNote] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [linkFor, setLinkFor] = useState<CloudPc | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState({ domain: '', computerId: '', sso: true, mfa: true });
  const [removing, setRemoving] = useState<CustomDomain | null>(null);

  const link = createLink.data;
  const computers = computersQuery.data ?? NO_COMPUTERS;
  const domains = domainsQuery.data ?? NO_DOMAINS;
  const selectedComputerId = draft.computerId || computers[0]?.id || '';

  function openLink(pc: CloudPc) {
    setLinkFor(pc);
    createLink.reset();
    createLink.mutate(pc.id);
  }

  function closeLink(open: boolean) {
    if (open) return;
    setLinkFor(null);
    createLink.reset();
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      notify(t('link.copied'), { tone: 'success' });
    } catch {
      notify(t('error.action'), { tone: 'danger' });
    }
  }

  function submitDomain(event: React.FormEvent) {
    event.preventDefault();
    const pc = computers.find((c) => c.id === selectedComputerId);
    const domain = draft.domain.trim();
    if (!pc || !domain) return;
    addDomain.mutate(
      {
        domain,
        cpc_id: pc.id,
        cpc_name: pc.name,
        sso_enforced: draft.sso,
        otp_gateway_required: draft.mfa
      },
      {
        onSuccess: () => {
          setAddOpen(false);
          setDraft({ domain: '', computerId: '', sso: true, mfa: true });
          notify(t('domains.linked', { domain }), { tone: 'success' });
        }
      }
    );
  }

  function confirmRemove() {
    if (!removing) return;
    const domain = removing.domain;
    deleteDomain.mutate(domain, {
      onSuccess: () => {
        setRemoving(null);
        setActionError(null);
        notify(t('domains.removed', { domain }), { tone: 'success' });
      },
      onError: (error) => {
        setRemoving(null);
        setActionError(error.message);
      }
    });
  }

  function checkDomain(domain: string) {
    setVerifyNote(null);
    verifyDomain.mutate(domain, {
      onSuccess: (result) => {
        if (result.verified === true) {
          setVerifyNote({ tone: 'success', text: t('domains.verified', { domain }) });
        } else {
          setVerifyNote({
            tone: 'danger',
            text: t('domains.notVerified', { domain, reason: result.reason || t('domains.checkFailed') })
          });
        }
      },
      onError: (error) => setVerifyNote({ tone: 'danger', text: `${t('error.action')} ${error.message}` })
    });
  }

  const domainColumns: Array<TableColumn<CustomDomain>> = [
    {
      id: 'domain',
      header: t('domains.columns.domain'),
      cell: (d) => (
        <div className="min-w-0">
          <div className="font-medium text-content">{d.domain}</div>
          {d.cname_target && (
            <div className="text-caption text-muted">{t('domains.pointsTo', { target: d.cname_target })}</div>
          )}
        </div>
      )
    },
    {
      id: 'computer',
      header: t('domains.columns.computer'),
      cell: (d) => (
        <div className="min-w-0">
          <div className="text-content">{d.cpc_name ?? <NotMeasured />}</div>
          <CodeText>{d.cpc_id}</CodeText>
        </div>
      )
    },
    {
      id: 'status',
      header: t('domains.columns.status'),
      cell: (d) => (
        <div className="text-caption text-muted">
          <div>{t('domains.dns', { status: d.dns_status ?? t('status.unknown') })}</div>
          <div>{t('domains.tls', { status: d.ssl_status ?? t('status.unknown') })}</div>
        </div>
      )
    },
    {
      id: 'access',
      header: t('domains.columns.access'),
      cell: (d) => (
        <div className="text-caption text-muted">
          <div>{d.sso_enforced ? t('domains.sso') : t('domains.noSso')}</div>
          {d.otp_gateway_required && <div>{t('domains.mfa')}</div>}
        </div>
      )
    },
    {
      id: 'actions',
      header: t('domains.columns.actions'),
      cell: (d) => (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            aria-label={t('domains.verifyFor', { domain: d.domain })}
            onClick={() => checkDomain(d.domain)}
          >
            {t('domains.verify')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('domains.removeFor', { domain: d.domain })}
            onClick={() => setRemoving(d)}
          >
            {t('domains.remove')}
          </Button>
        </div>
      )
    }
  ];

  const computersLabel = computersQuery.data
    ? t('tabs.computers', { count: computers.length })
    : t('tabs.computersPlain');
  const domainsLabel = domainsQuery.data ? t('tabs.domains', { count: domains.length }) : t('tabs.domainsPlain');

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        primaryAction={
          <Button variant="primary" icon={Plus} onClick={() => setAddOpen(true)}>
            {t('primary.linkDomain')}
          </Button>
        }
      />

      {actionError && (
        <p role="alert" className="mb-4 flex items-start gap-2 text-body text-content">
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <span>
            {t('error.action')} <span className="text-muted">{actionError}</span>
          </span>
        </p>
      )}

      <Tabs
        label={t('tabs.label')}
        value={tab}
        onValueChange={(value) => setTab(value as Tab)}
        items={[
          {
            value: 'computers',
            label: computersLabel,
            content: (
              <QueryView
                query={computersQuery}
                isEmpty={(list) => list.length === 0}
                emptyTitle={t('empty.title')}
                emptyBody={t('empty.body')}
              >
                {(list) => (
                  <RowList label={t('tabs.computersPlain')}>
                    {list.map((pc) => (
                      <Row
                        key={pc.id}
                        title={pc.name}
                        meta={computerResources(pc, t)}
                        status={<ComputerStatus status={pc.status} />}
                        actions={
                          <Button size="sm" variant="secondary" onClick={() => openLink(pc)}>
                            {t('computers.createLink')}
                          </Button>
                        }
                      />
                    ))}
                  </RowList>
                )}
              </QueryView>
            )
          },
          {
            value: 'domains',
            label: domainsLabel,
            content: (
              <QueryView
                query={domainsQuery}
                isEmpty={(list) => list.length === 0}
                emptyTitle={t('domains.empty.title')}
                emptyBody={t('domains.empty.body')}
              >
                {(list) => (
                  <div className="flex flex-col gap-3">
                    {verifyNote && (
                      <p
                        role={verifyNote.tone === 'danger' ? 'alert' : 'status'}
                        className="flex items-start gap-2 text-body text-content"
                      >
                        {verifyNote.tone === 'danger' ? (
                          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                        ) : (
                          <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                        )}
                        <span>{verifyNote.text}</span>
                      </p>
                    )}
                    <Table<CustomDomain>
                      columns={domainColumns}
                      rows={list}
                      rowKey={(d) => d.domain}
                      caption={t('tabs.domainsPlain')}
                    />
                  </div>
                )}
              </QueryView>
            )
          }
        ]}
      />

      <Dialog
        open={linkFor !== null}
        onOpenChange={closeLink}
        title={t('link.title', { name: linkFor?.name ?? '' })}
        description={t('link.description')}
        size="md"
        footer={<Button onClick={() => closeLink(false)}>{t('link.close')}</Button>}
      >
        {createLink.isPending && (
          <div role="status" className="flex flex-col gap-3 text-body text-muted">
            <Skeleton lines={2} />
            <span>{t('link.preparing')}</span>
          </div>
        )}
        {createLink.isError && (
          <p role="alert" className="text-body text-content">
            {t('link.error')} <span className="text-muted">{createLink.error?.message}</span>
          </p>
        )}
        {link && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-5 sm:flex-row">
              <div className="shrink-0">
                <QrCode value={link.viewer_url} label={t('link.qrLabel')} size={160} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <p className="flex items-center gap-2 text-body font-medium text-content">
                  <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-success" />
                  {t('link.created')}
                </p>
                <p className="flex items-start gap-2 text-caption text-content">
                  <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  {t('link.notConnecting')}
                </p>
                <FormField label={t('link.viewerLabel')}>
                  <div className="flex gap-2">
                    <Input readOnly mono value={link.viewer_url} />
                    <Button variant="secondary" onClick={() => void copyLink(link.viewer_url)}>
                      {t('link.copy')}
                    </Button>
                  </div>
                </FormField>
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-body font-semibold text-content">{t('link.addresses')}</h3>
              <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-caption">
                <dt className="text-muted">{t('link.server')}</dt>
                <dd>{link.signaling_url ? <CodeText>{link.signaling_url}</CodeText> : <NotMeasured />}</dd>
                <dt className="text-muted">{t('link.code')}</dt>
                <dd>{link.stream_token ? <CodeText>{link.stream_token}</CodeText> : <NotMeasured />}</dd>
                <dt className="text-muted">{t('link.format')}</dt>
                <dd className="text-content">{link.codec ?? <NotMeasured />}</dd>
              </dl>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title={t('addDomain.title')}
        description={t('addDomain.description')}
        size="md"
        footer={
          <>
            <Button onClick={() => setAddOpen(false)}>{t('addDomain.cancel')}</Button>
            <Button
              variant="primary"
              type="submit"
              form="cloudpc-add-domain"
              loading={addDomain.isPending}
              disabled={computers.length === 0}
            >
              {t('addDomain.submit')}
            </Button>
          </>
        }
      >
        <form id="cloudpc-add-domain" onSubmit={submitDomain} className="flex flex-col gap-4">
          <FormField label={t('addDomain.domainLabel')} required>
            <Input
              mono
              required
              placeholder={t('addDomain.placeholder')}
              value={draft.domain}
              onChange={(event) => setDraft({ ...draft, domain: event.target.value })}
            />
          </FormField>
          {computers.length === 0 ? (
            <p className="text-caption text-muted">{t('addDomain.noComputers')}</p>
          ) : (
            <FormField label={t('addDomain.computerLabel')}>
              <Select
                value={selectedComputerId}
                onValueChange={(value) => setDraft({ ...draft, computerId: value })}
                options={computers.map((pc) => ({ value: pc.id, label: pc.name }))}
              />
            </FormField>
          )}
          <div className="flex flex-col gap-2">
            <Checkbox
              label={t('addDomain.sso')}
              checked={draft.sso}
              onChange={(event) => setDraft({ ...draft, sso: event.target.checked })}
            />
            <Checkbox
              label={t('addDomain.mfa')}
              checked={draft.mfa}
              onChange={(event) => setDraft({ ...draft, mfa: event.target.checked })}
            />
          </div>
          {addDomain.isError && (
            <p role="alert" className="text-body text-content">
              {t('addDomain.error')} <span className="text-muted">{addDomain.error?.message}</span>
            </p>
          )}
        </form>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t('domains.removeTitle', { domain: removing?.domain ?? '' })}
        description={t('domains.removeBody')}
        confirmLabel={t('domains.removeConfirm')}
        tone="danger"
        busy={deleteDomain.isPending}
        onConfirm={confirmRemove}
      />
    </>
  );
}
