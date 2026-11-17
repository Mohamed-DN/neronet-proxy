import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import { Check, Copy, FileLock2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { QrCode } from '../devices/QrCode';
import { DropCryptoUnavailable, DropIntegrityError, ciphertextLength } from '../drop/dropCrypto';
import { parseDropLink } from '../drop/link';
import {
  DropTransferError,
  receiveFile,
  useDropConfig,
  useDropInbox,
  useDropRecipients,
  useDropRefresh,
  useSendFile,
  type DropItem,
  type ReceiveResult,
  type SendResult
} from '../drop/transfer';
import { formatBytes, formatDateTime } from '../i18n/format';
import { ApiError, apiPut } from '../services/apiClient';
import { Button } from '../ui/Button';
import { cn } from '../ui/cn';
import { PageHeader } from '../ui/PageHeader';
import { Select } from '../ui/Select';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { Switch } from '../ui/Switch';
import { useToast } from '../ui/Toast';

const FIELD =
  'block w-full rounded-control border border-border-strong bg-surface-raised px-3 text-body text-content focus-visible:outline-focus';
const ALERT = 'rounded-control border border-danger/40 bg-danger-subtle p-3 text-caption text-danger';

function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
}

/**
 * NeroDrop (ADR 0033): send a file to a member of the organisation, end-to-end
 * encrypted in this browser, and receive the files sent to you. The key travels only
 * in the link's fragment; the console and the gateway see ciphertext and metadata.
 */
export default function DropRoute() {
  const { t } = useTranslation('drop');
  const location = useLocation();
  const navigate = useNavigate();
  const config = useDropConfig();
  const inbox = useDropInbox();
  const [opened, setOpened] = useState<{ id: string; key: Uint8Array } | null>(null);

  // A link opened in the address bar: keep the key in memory and take it out of the
  // address, so it does not stay in the history or reach a screenshot of the bar.
  useEffect(() => {
    const parsed = location.hash ? parseDropLink(location.hash) : null;
    if (parsed) {
      setOpened(parsed);
      navigate({ pathname: location.pathname, hash: '' }, { replace: true });
    }
  }, [location.hash, location.pathname, navigate]);

  const openedItem = opened ? (inbox.data ?? []).find((item) => item.id === opened.id) : undefined;

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />

      {opened && (
        <ReceivePanel
          key={opened.id}
          id={opened.id}
          fileKey={opened.key}
          item={openedItem}
          onClose={() => setOpened(null)}
        />
      )}

      {config.isPending ? (
        <div className="space-y-3">
          <Skeleton lines={4} />
          <p role="status" className="sr-only">
            {t('loading')}
          </p>
        </div>
      ) : config.isError ? (
        <ErrorState
          title={t('error.title')}
          body={t('error.body')}
          error={config.error}
          onRetry={() => void config.refetch()}
        />
      ) : !config.data.enabled ? (
        <EmptyState title={t('disabled.title')} body={t('disabled.body')} />
      ) : !config.data.available ? (
        <EmptyState title={t('unavailable.title')} body={t('unavailable.body')} />
      ) : config.data.may_send ? (
        <SendSection maxBytes={config.data.max_bytes} />
      ) : (
        <p className="text-body text-muted">{t('readOnly')}</p>
      )}

      <InboxSection
        items={inbox.data}
        isPending={inbox.isPending}
        error={inbox.isError ? inbox.error : null}
        onRetry={() => void inbox.refetch()}
        onOpen={setOpened}
      />

      <details className="mt-10 rounded-card border border-border-subtle p-4 text-body text-content">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-medium focus-visible:outline-focus">
          <ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-accent" />
          {t('privacy.summary')}
        </summary>
        <div className="mt-3 space-y-3 text-muted">
          <p>{t('privacy.encrypted')}</p>
          <p>{t('privacy.path')}</p>
          <p>{t('privacy.link')}</p>
          <p>{t('privacy.later')}</p>
        </div>
      </details>

      {config.data?.can_manage && <AdminSwitch enabled={config.data.enabled} />}
    </>
  );
}

function SendSection({ maxBytes }: { maxBytes: number }) {
  const { t, i18n } = useTranslation('drop');
  const recipients = useDropRecipients(true);
  const send = useSendFile();
  const ids = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [recipientId, setRecipientId] = useState<string | undefined>(undefined);
  const [oneTime, setOneTime] = useState(true);
  const [errors, setErrors] = useState<{ file?: string; recipient?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<(SendResult & { recipient: string; oneTime: boolean }) | null>(null);
  const size = formatBytes(i18n.language, maxBytes, 0) ?? '';

  const options = useMemo(
    () => (recipients.data ?? []).map((r) => ({ value: r.id, label: r.username })),
    [recipients.data]
  );

  const chooseFile = (chosen: File | null) => {
    setFailure(null);
    setFile(chosen);
    setErrors((e) => ({
      ...e,
      file: chosen && ciphertextLength(chosen.size) > maxBytes ? t('send.tooLarge', { size }) : undefined
    }));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = {
      file: !file ? t('send.noFile') : errors.file,
      recipient: !recipientId ? t('send.noRecipient') : undefined
    };
    setErrors(next);
    setFailure(null);
    if (!file || !recipientId || next.file || next.recipient) return;
    const recipient = options.find((o) => o.value === recipientId)?.label ?? '';
    send.mutate(
      {
        file,
        recipientId,
        oneTime,
        onStage: (stage, done, total) =>
          setProgress(
            t(stage === 'encrypting' ? 'send.encrypting' : 'send.uploading', { percent: percent(done, total) })
          )
      },
      {
        onSuccess: (sent) => {
          setProgress(null);
          setResult({ ...sent, recipient, oneTime });
        },
        onError: (error) => {
          setProgress(null);
          setFailure(sendFailure(error, t, size));
        }
      }
    );
  };

  if (result) {
    return (
      <SendResultView
        result={result}
        onAgain={() => {
          setResult(null);
          setFile(null);
          setRecipientId(undefined);
          if (fileInput.current) fileInput.current.value = '';
        }}
      />
    );
  }

  return (
    <section aria-labelledby={`${ids}-heading`} className="mt-2">
      <h2 id={`${ids}-heading`} className="text-heading font-medium text-content">
        {t('send.heading')}
      </h2>
      <form noValidate onSubmit={submit} className="mt-4 space-y-6">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-file`} className="text-label font-medium text-content">
            {t('send.file')}
          </label>
          <p id={`${ids}-file-hint`} className="text-caption text-subtle">
            {t('send.fileHint', { size })}
          </p>
          <input
            ref={fileInput}
            id={`${ids}-file`}
            type="file"
            aria-describedby={`${ids}-file-hint${errors.file ? ` ${ids}-file-error` : ''}`}
            aria-invalid={errors.file ? true : undefined}
            onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
            className={cn(
              FIELD,
              'min-h-11 py-2 file:mr-3 file:rounded-control file:border-0 file:bg-surface-sunken file:px-3 file:py-1.5 file:text-body file:text-content'
            )}
          />
          {file && !errors.file && (
            <p className="text-caption text-muted">
              {t('send.chosen', { name: file.name, size: formatBytes(i18n.language, file.size) ?? '' })}
            </p>
          )}
          {errors.file && (
            <p id={`${ids}-file-error`} role="alert" className="text-caption text-danger">
              {errors.file}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span id={`${ids}-recipient-label`} className="text-label font-medium text-content">
            {t('send.recipient')}
          </span>
          <Select
            label={t('send.recipient')}
            value={recipientId ?? ''}
            onValueChange={(v) => {
              setRecipientId(v);
              setErrors((e) => ({ ...e, recipient: undefined }));
            }}
            options={options}
            placeholder={t('send.recipientPlaceholder')}
            invalid={Boolean(errors.recipient)}
            disabled={recipients.isPending}
            className="h-11"
          />
          {errors.recipient && (
            <p role="alert" className="text-caption text-danger">
              {errors.recipient}
            </p>
          )}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-label font-medium text-content">{t('send.keep')}</legend>
          <KeepOption
            id={`${ids}-once`}
            name={`${ids}-keep`}
            checked={oneTime}
            onSelect={() => setOneTime(true)}
            label={t('send.once')}
            hint={t('send.onceHint')}
          />
          <KeepOption
            id={`${ids}-day`}
            name={`${ids}-keep`}
            checked={!oneTime}
            onSelect={() => setOneTime(false)}
            label={t('send.day')}
            hint={t('send.dayHint')}
          />
        </fieldset>

        {progress && (
          <div className="space-y-2">
            <p role="status" className="text-caption text-muted">
              {progress}
            </p>
          </div>
        )}
        {failure && (
          <p role="alert" className={ALERT}>
            {failure}
          </p>
        )}

        <Button
          type="submit"
          size="lg"
          icon={FileLock2}
          loading={send.isPending}
          loadingLabel={t('send.busy')}
          className="w-full sm:w-auto"
        >
          {t('send.submit')}
        </Button>
      </form>
    </section>
  );
}

function KeepOption({
  id,
  name,
  checked,
  onSelect,
  label,
  hint
}: {
  id: string;
  name: string;
  checked: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-control border p-3',
        checked ? 'border-accent ring-1 ring-accent' : 'border-border-subtle'
      )}
    >
      <input
        id={id}
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        aria-describedby={`${id}-hint`}
        className="mt-1 h-4 w-4 shrink-0 accent-[rgb(var(--color-accent))] focus-visible:outline-focus"
      />
      <div>
        <label htmlFor={id} className="block min-h-6 cursor-pointer text-body text-content">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-caption text-muted">
          {hint}
        </p>
      </div>
    </div>
  );
}

function sendFailure(error: unknown, t: (key: string, options?: Record<string, unknown>) => string, size: string) {
  if (error instanceof DropCryptoUnavailable) return t('send.noCrypto');
  if (error instanceof ApiError) {
    if (error.code === 'drop_too_large') return t('send.tooLarge', { size });
    if (error.code === 'too_many_transfers') return t('send.tooMany');
  }
  if (error instanceof DropTransferError) {
    if (error.status === 507) return t('send.full');
    if (error.status === 413) return t('send.tooLarge', { size });
  }
  return t('send.failed');
}

function SendResultView({
  result,
  onAgain
}: {
  result: SendResult & { recipient: string; oneTime: boolean };
  onAgain: () => void;
}) {
  const { t, i18n } = useTranslation('drop');
  const { notify } = useToast();
  const ids = useId();
  const [copied, setCopied] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const date = formatDateTime(i18n.language, result.expiresAt) ?? '';

  // The page changed under the button that was pressed: move focus to what replaced it.
  useEffect(() => heading.current?.focus(), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.link);
      setCopied(true);
      notify(t('result.copied'), { tone: 'success' });
    } catch {
      setCopied(false);
    }
  };

  return (
    <section aria-labelledby={`${ids}-heading`} className="mt-2">
      <h2 id={`${ids}-heading`} ref={heading} tabIndex={-1} className="text-heading font-medium text-content">
        {t('result.heading', { name: result.recipient })}
      </h2>
      <p className="mt-2 max-w-prose text-body text-muted">{t('result.body', { name: result.recipient })}</p>

      <div className="mt-6 grid gap-6 rounded-card border border-border-subtle bg-surface-raised p-4 sm:grid-cols-[auto_1fr] sm:items-center">
        <div className="mx-auto rounded-control bg-white p-2 sm:mx-0">
          <QrCode value={result.link} label={t('result.qr', { name: result.recipient })} size={192} />
        </div>
        <div>
          <p className="text-label font-medium text-content">{t('result.code')}</p>
          <p className="mt-1 font-mono text-display font-semibold tabular-nums tracking-wider text-content">
            {result.shortCode}
          </p>
          <p className="mt-1 text-caption text-muted">{t('result.codeHint', { name: result.recipient })}</p>
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-1.5">
        <label htmlFor={`${ids}-link`} className="text-label font-medium text-content">
          {t('result.link')}
        </label>
        <div className="flex gap-2">
          <input
            id={`${ids}-link`}
            readOnly
            value={result.link}
            onFocus={(e) => e.currentTarget.select()}
            className={cn(FIELD, 'h-11 min-w-0 flex-1 font-mono text-caption')}
          />
          <Button type="button" variant="secondary" size="lg" icon={copied ? Check : Copy} onClick={() => void copy()}>
            {t('result.copy')}
          </Button>
        </div>
        <p className="text-caption text-muted">
          {t(result.oneTime ? 'result.expiresOnce' : 'result.expiresDay', { date })}
        </p>
      </div>

      <Button type="button" variant="ghost" size="lg" className="mt-6" onClick={onAgain}>
        {t('result.another')}
      </Button>
    </section>
  );
}

function InboxSection({
  items,
  isPending,
  error,
  onRetry,
  onOpen
}: {
  items: DropItem[] | undefined;
  isPending: boolean;
  error: Error | null;
  onRetry: () => void;
  onOpen: (opened: { id: string; key: Uint8Array }) => void;
}) {
  const { t, i18n } = useTranslation('drop');
  const ids = useId();
  const [pasted, setPasted] = useState('');
  const [bad, setBad] = useState(false);

  const open = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = parseDropLink(pasted);
    setBad(!parsed);
    if (parsed) {
      setPasted('');
      onOpen(parsed);
    }
  };

  return (
    <section aria-labelledby={`${ids}-heading`} className="mt-12">
      <h2 id={`${ids}-heading`} className="text-heading font-medium text-content">
        {t('inbox.heading')}
      </h2>
      <div className="mt-3">
        {isPending ? (
          <>
            <Skeleton lines={2} />
            <p role="status" className="sr-only">
              {t('inbox.loading')}
            </p>
          </>
        ) : error && !items ? (
          <ErrorState title={t('inbox.error.title')} body={t('inbox.error.body')} error={error} onRetry={onRetry} />
        ) : !items || items.length === 0 ? (
          <EmptyState title={t('inbox.empty.title')} body={t('inbox.empty.body')} />
        ) : (
          <ul className="divide-y divide-border-subtle rounded-card border border-border-subtle">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-3">
                <div>
                  <p className="text-body font-medium text-content">{t('inbox.from', { name: item.peer.username })}</p>
                  <p className="text-caption text-muted">
                    {t('inbox.details', {
                      size: formatBytes(i18n.language, item.ciphertext_bytes) ?? '',
                      date: formatDateTime(i18n.language, item.expires_at) ?? ''
                    })}
                    {item.status === 'received' && <> {t('inbox.received')}</>}
                  </p>
                  {/* The key lives only in the sender's link (ADR 0033), so the server cannot open the file. */}
                  {item.status !== 'received' && <p className="text-caption text-muted">{t('inbox.needsLink')}</p>}
                </div>
                <p className="text-caption text-muted">
                  <span className="sr-only">{t('inbox.code')} </span>
                  <span className="font-mono tabular-nums text-content">{item.short_code}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <form onSubmit={open} noValidate className="mt-6 flex flex-col gap-1.5">
        <label htmlFor={`${ids}-paste`} className="text-label font-medium text-content">
          {t('inbox.paste')}
        </label>
        <p id={`${ids}-paste-hint`} className="text-caption text-subtle">
          {t('inbox.pasteHint')}
        </p>
        <div className="flex gap-2">
          <input
            id={`${ids}-paste`}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={pasted}
            onChange={(e) => {
              setPasted(e.target.value);
              setBad(false);
            }}
            aria-describedby={`${ids}-paste-hint${bad ? ` ${ids}-paste-error` : ''}`}
            aria-invalid={bad || undefined}
            className={cn(FIELD, 'h-11 min-w-0 flex-1')}
          />
          <Button type="submit" variant="secondary" size="lg">
            {t('inbox.open')}
          </Button>
        </div>
        {bad && (
          <p id={`${ids}-paste-error`} role="alert" className="text-caption text-danger">
            {t('inbox.badLink')}
          </p>
        )}
      </form>
    </section>
  );
}

function ReceivePanel({
  id,
  fileKey,
  item,
  onClose
}: {
  id: string;
  fileKey: Uint8Array;
  item: DropItem | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation('drop');
  const ids = useId();
  const refresh = useDropRefresh();
  const [progress, setProgress] = useState<number | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState<(ReceiveResult & { url: string }) | null>(null);

  useEffect(
    () => () => {
      if (done) URL.revokeObjectURL(done.url);
    },
    [done]
  );

  const start = async () => {
    setFailure(null);
    setProgress(0);
    try {
      const received = await receiveFile(id, fileKey, (got, total) => setProgress(percent(got, total)));
      setDone({ ...received, url: URL.createObjectURL(received.blob) });
      refresh();
    } catch (error) {
      setFailure(receiveFailure(error, t));
    } finally {
      setProgress(null);
    }
  };

  const name = item?.peer.username;
  return (
    <section
      aria-labelledby={`${ids}-heading`}
      className="mb-10 rounded-card border-2 border-accent bg-surface-raised p-4 text-content"
    >
      <h2 id={`${ids}-heading`} className="text-heading font-medium">
        {name ? t('receive.heading', { name }) : t('receive.headingUnknown')}
      </h2>
      {item && <p className="mt-1 font-mono text-caption tabular-nums text-muted">{item.short_code}</p>}
      <p className="mt-2 text-body text-muted">{t('receive.body')}</p>

      {done ? (
        <div className="mt-4 space-y-3">
          <p role="status" className="flex items-start gap-2 text-body">
            <ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            {t('receive.done')}
          </p>
          <a
            href={done.url}
            download={done.manifest.name || 'nerodrop-file'}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-control border border-transparent bg-accent px-4 text-body font-medium text-accent-contrast hover:bg-accent-strong focus-visible:outline-focus"
          >
            {t('receive.save', { name: done.manifest.name || 'nerodrop-file' })}
          </a>
          {item?.one_time && <p className="text-caption text-muted">{t('receive.onceGone')}</p>}
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          {progress !== null && (
            <p role="status" className="text-caption text-muted">
              {t('receive.progress', { percent: progress })}
            </p>
          )}
          {failure && (
            <p role="alert" className={ALERT}>
              {failure}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="lg"
              loading={progress !== null}
              loadingLabel={t('receive.busy')}
              onClick={() => void start()}
            >
              {t('receive.start')}
            </Button>
            <Button type="button" variant="ghost" size="lg" onClick={onClose}>
              {t('receive.close')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function receiveFailure(error: unknown, t: (key: string) => string): string {
  if (error instanceof DropCryptoUnavailable) return t('send.noCrypto');
  if (error instanceof DropIntegrityError) return t('receive.wrongLink');
  if (error instanceof ApiError) {
    if (error.status === 404) return t('receive.notFound');
    if (error.status === 410) return t('receive.gone');
  }
  if (error instanceof DropTransferError && (error.status === 404 || error.status === 401)) return t('receive.gone');
  return t('receive.failed');
}

function AdminSwitch({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation('drop');
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: (value: boolean) => apiPut('/drop/policy', { enabled: value }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['drop', 'config'] })
  });
  return (
    <div className="mt-8 rounded-card border border-border-subtle p-4">
      <Switch
        checked={enabled}
        onCheckedChange={(value) => save.mutate(value)}
        label={t('admin.label')}
        description={t('admin.description')}
        disabled={save.isPending}
      />
      {save.isError && (
        <p role="alert" className="mt-2 text-caption text-danger">
          {t('admin.failed')}
        </p>
      )}
    </div>
  );
}
