import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Copy, UserPlus } from 'lucide-react';

import { useAuth } from '../../../context/AuthContext';
import { QrCode } from '../../../devices/QrCode';
import { formatDate, formatDateTime } from '../../../i18n/format';
import { ApiError } from '../../../services/apiClient';
import {
  useCreateInvitation,
  useInvitations,
  useRevokeInvitation,
  type CreatedInvitation,
  type Invitation,
  type InvitationStatus
} from '../../../services/queries/invitations';
import { useOrganizations } from '../../../services/queries/users';
import { effectiveRole, invitableRoles, type InvitableRole } from '../../../services/roles';
import { INVITE_PATH } from '../../paths';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  FormField,
  Input,
  Select,
  Table,
  type TableColumn,
  useToast
} from '../../../ui';

const LIFETIMES = [1, 3, 7, 14, 30] as const;
const DEFAULT_LIFETIME = 7;

const STATUS_TONE: Record<InvitationStatus, BadgeTone> = {
  pending: 'info',
  used: 'success',
  expired: 'neutral',
  revoked: 'neutral'
};

function inviteLink(token: string): string {
  return `${window.location.origin}${INVITE_PATH}#${token}`;
}

export interface InvitationsPanelProps {
  /** The create dialog is controlled, so the page header can open it too. */
  inviteOpen: boolean;
  onInviteOpenChange: (open: boolean) => void;
}

/**
 * Invitations of one organisation: who was invited, what became of it, and a way to
 * withdraw one still waiting. Creating one shows the link, the code and a QR code a
 * single time; the server keeps none of them, so closing the dialog forgets them.
 */
export function InvitationsPanel({ inviteOpen, onInviteOpenChange }: InvitationsPanelProps) {
  const { t, i18n } = useTranslation(['invitations', 'glossary', 'ui']);
  const { user } = useAuth();
  const { notify } = useToast();
  const allowed = invitableRoles(effectiveRole(user));

  const orgs = useOrganizations();
  const [chosenOrg, setChosenOrg] = useState<string | null>(null);
  const orgList = orgs.data ?? [];
  const orgId = chosenOrg ?? orgList[0]?.id ?? null;

  const invitations = useInvitations(orgId);
  const revoke = useRevokeInvitation(orgId ?? '');
  const [toWithdraw, setToWithdraw] = useState<Invitation | null>(null);

  const roleLabel = (role: string) => t(`roles.${role}.term`, { ns: 'glossary', defaultValue: role });
  const nameOf = (inv: Invitation) => inv.display_name_hint || t('panel.noName');

  function statusLabel(inv: Invitation): string {
    if (inv.status === 'used') {
      return inv.used_by_username
        ? t('panel.status.used', { name: inv.used_by_username })
        : t('panel.status.usedUnknown');
    }
    return t(`panel.status.${inv.status}`);
  }

  const columns: TableColumn<Invitation>[] = useMemo(
    () => [
      { id: 'name', header: t('panel.colName'), cell: (inv) => <span className="text-content">{nameOf(inv)}</span> },
      { id: 'role', header: t('panel.colRole'), cell: (inv) => roleLabel(inv.role) },
      {
        id: 'status',
        header: t('panel.colStatus'),
        cell: (inv) => <Badge tone={STATUS_TONE[inv.status] ?? 'neutral'}>{statusLabel(inv)}</Badge>
      },
      {
        id: 'expires',
        header: t('panel.colExpires'),
        cell: (inv) => <span className="text-muted">{formatDate(i18n.language, inv.expires_at) ?? '—'}</span>
      },
      {
        id: 'by',
        header: t('panel.colCreatedBy'),
        cell: (inv) => <span className="text-muted">{inv.created_by_username ?? '—'}</span>
      },
      {
        id: 'actions',
        header: t('panel.colActions'),
        cell: (inv) =>
          inv.status === 'pending' ? (
            <Button
              variant="secondary"
              size="sm"
              aria-label={t('panel.withdrawLabel', { name: nameOf(inv) })}
              onClick={() => setToWithdraw(inv)}
            >
              {t('panel.withdraw')}
            </Button>
          ) : null
      }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, i18n.language]
  );

  async function confirmWithdraw() {
    if (!toWithdraw) return;
    try {
      await revoke.mutateAsync(toWithdraw.id);
      notify(t('withdraw.done'), { tone: 'success' });
    } catch {
      notify(t('withdraw.failed'), { tone: 'danger' });
    } finally {
      setToWithdraw(null);
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-prose">
          <h3 className="text-base font-bold text-content">{t('panel.title')}</h3>
          <p className="text-caption text-muted">{t('panel.description')}</p>
        </div>
        {allowed.length > 0 && orgId && (
          <Button variant="primary" size="md" icon={UserPlus} onClick={() => onInviteOpenChange(true)}>
            {t('panel.invite')}
          </Button>
        )}
      </div>

      {orgList.length > 1 && (
        <FormField label={t('panel.organisation')} className="max-w-xs">
          <Select
            value={orgId ?? undefined}
            onValueChange={setChosenOrg}
            options={orgList.map((o) => ({ value: o.id, label: o.name }))}
          />
        </FormField>
      )}

      {!orgs.isPending && !orgId ? (
        <p className="text-caption text-muted">{t('panel.noOrganisation')}</p>
      ) : (
        <Table<Invitation>
          caption={t('panel.tableCaption')}
          columns={columns}
          rows={invitations.data ?? []}
          rowKey={(inv) => inv.id}
          loading={orgs.isPending || invitations.isPending}
          error={invitations.isError ? t('panel.loadFailed') : null}
          onRetry={() => void invitations.refetch()}
          empty={<EmptyState title={t('panel.empty.title')} body={t('panel.empty.body')} />}
        />
      )}

      {orgId && (
        <CreateInvitationDialog
          key={orgId}
          orgId={orgId}
          roles={allowed}
          open={inviteOpen}
          onOpenChange={onInviteOpenChange}
        />
      )}

      <ConfirmDialog
        open={Boolean(toWithdraw)}
        onOpenChange={(open) => !open && setToWithdraw(null)}
        title={t('withdraw.title', { name: toWithdraw ? nameOf(toWithdraw) : '' })}
        description={t('withdraw.body')}
        confirmLabel={t('withdraw.confirm')}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => void confirmWithdraw()}
      />
    </Card>
  );
}

interface CreateDialogProps {
  orgId: string;
  roles: InvitableRole[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function CreateInvitationDialog({ orgId, roles, open, onOpenChange }: CreateDialogProps) {
  const { t } = useTranslation(['invitations', 'glossary', 'ui']);
  const create = useCreateInvitation(orgId);
  const [hint, setHint] = useState('');
  const [role, setRole] = useState<InvitableRole>('member');
  const [days, setDays] = useState<number>(DEFAULT_LIFETIME);
  const [error, setError] = useState<string | null>(null);
  // The secret lives here and nowhere else: in memory, until the dialog closes.
  const [created, setCreated] = useState<CreatedInvitation | null>(null);

  useEffect(() => {
    if (open) return;
    setCreated(null);
    setHint('');
    setRole('member');
    setDays(DEFAULT_LIFETIME);
    setError(null);
  }, [open]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const trimmed = hint.trim();
      const result = await create.mutateAsync({
        role,
        expires_in_days: days,
        ...(trimmed ? { display_name_hint: trimmed } : {})
      });
      setCreated(result);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? t('create.forbidden') : t('create.failed'));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={created ? t('result.title') : t('create.title')}
      description={created ? undefined : t('create.description')}
    >
      {created ? (
        <InvitationResult created={created} onDone={() => onOpenChange(false)} />
      ) : (
        <form onSubmit={onSubmit} noValidate className="space-y-4 pt-2">
          <FormField label={t('create.name')} hint={t('create.nameHint')}>
            <Input value={hint} onChange={(e) => setHint(e.target.value)} maxLength={128} autoComplete="off" />
          </FormField>
          <FormField label={t('create.role')} hint={t(`roles.${role}.body`, { ns: 'glossary', defaultValue: '' })}>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as InvitableRole)}
              options={roles.map((r) => ({
                value: r,
                label: t(`roles.${r}.term`, { ns: 'glossary', defaultValue: r })
              }))}
            />
          </FormField>
          <FormField label={t('create.lifetime')}>
            <Select
              value={String(days)}
              onValueChange={(value) => setDays(Number(value))}
              options={LIFETIMES.map((d) => ({ value: String(d), label: t('create.days', { count: d }) }))}
            />
          </FormField>
          {error && (
            <p role="alert" className="text-caption text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              {t('create.cancel')}
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending} loadingLabel={t('create.working')}>
              {t('create.submit')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function InvitationResult({ created, onDone }: { created: CreatedInvitation; onDone: () => void }) {
  const { t, i18n } = useTranslation(['invitations', 'ui']);
  const { notify } = useToast();
  const link = inviteLink(created.token);
  const address = `${window.location.host}${INVITE_PATH}`;
  const codeLabelId = useId();
  const linkLabelId = useId();

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify(t('result.copied'), { tone: 'success' });
    } catch {
      notify(t('code.copyFailed', { ns: 'ui' }), { tone: 'danger' });
    }
  }

  return (
    <div className="space-y-5 pt-2">
      <p className="flex items-start gap-2 rounded-control border border-warning/40 bg-warning-subtle p-3 text-body text-content">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <span>{t('result.warning')}</span>
      </p>

      <section aria-labelledby={codeLabelId} className="space-y-2 text-center">
        <h3 id={codeLabelId} className="text-label font-medium text-muted">
          {t('result.codeLabel')}
        </h3>
        {/* The one thing a person may read aloud over the phone: large, mono, grouped. */}
        <p className="select-all font-mono text-2xl font-semibold tracking-[0.18em] text-content sm:text-3xl">
          {created.code}
        </p>
        <p className="text-caption text-subtle">{t('result.codeHint', { address })}</p>
        <Button variant="secondary" size="md" icon={Copy} onClick={() => void copy(created.code)}>
          {t('result.copyCode')}
        </Button>
      </section>

      <section aria-labelledby={linkLabelId} className="space-y-2 border-t border-border-subtle pt-4">
        <h3 id={linkLabelId} className="text-label font-medium text-muted">
          {t('result.linkLabel')}
        </h3>
        <p className="select-all break-all rounded-control bg-surface-sunken p-2 font-mono text-caption text-content">
          {link}
        </p>
        <Button variant="secondary" size="md" icon={Copy} onClick={() => void copy(link)}>
          {t('result.copyLink')}
        </Button>
      </section>

      <div className="flex flex-col items-center gap-2 border-t border-border-subtle pt-4">
        <div className="rounded-card bg-white p-2">
          <QrCode value={link} label={t('result.qrAlt')} size={184} />
        </div>
        <p className="text-caption text-subtle">{t('result.qrHint')}</p>
      </div>

      <p className="text-caption text-muted">
        {t('result.expires', { date: formatDateTime(i18n.language, created.invitation.expires_at) ?? '' })}
      </p>

      <div className="flex justify-end border-t border-border pt-4">
        <Button variant="primary" onClick={onDone}>
          {t('result.done')}
        </Button>
      </div>
    </div>
  );
}
