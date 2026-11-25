import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { APP_CONNECT_PATH } from '../routes/paths';
import { useAppSessions, useRevokeAppSession, type AppSession } from '../services/queries/appSessions';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';

/**
 * The apps this person signed in with the device code, each with the one thing a person
 * may want to do to it: sign it out. Signing out cuts the app's connection as well, which
 * the confirmation says before it happens.
 */
export default function SignedInApps() {
  const { t, i18n } = useTranslation('apps');
  const sessions = useAppSessions('own');
  const revoke = useRevokeAppSession();
  const { notify } = useToast();
  const [asking, setAsking] = useState<AppSession | null>(null);
  const [failed, setFailed] = useState(false);

  if (sessions.isPending || sessions.isError) return null;

  // Apps that work, and apps whose approval ended and can be put right or removed for good.
  const active = (sessions.data ?? []).filter((s) => s.status === 'active' || s.status === 'suspended');
  const forGood = asking?.status === 'suspended';
  const format = (iso: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

  return (
    <section aria-labelledby="signed-in-apps" className="mt-10 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="signed-in-apps" className="text-heading font-semibold text-content">
          {t('list.title')}
        </h2>
        <Link
          to={APP_CONNECT_PATH}
          className="text-body font-medium text-accent hover:underline focus-visible:outline-focus"
        >
          {t('list.connect')}
        </Link>
      </div>
      {active.length === 0 ? (
        <p className="text-body text-muted">{t('list.empty')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle rounded-card border border-border bg-surface-raised">
          {active.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0 space-y-1">
                <p className="truncate text-body font-medium text-content">{s.device_name}</p>
                <p className="flex flex-wrap items-center gap-2 text-caption text-muted">
                  <Badge>{t(`platform.${s.platform}`)}</Badge>
                  {s.status === 'suspended' && <Badge tone="warning">{t('list.suspended')}</Badge>}
                  <span>
                    {s.last_used_at ? t('list.lastUsed', { when: format(s.last_used_at) }) : t('list.neverUsed')}
                  </span>
                </p>
                {s.status === 'suspended' && <p className="text-caption text-muted">{t('list.suspendedNote')}</p>}
              </div>
              <Button
                variant="secondary"
                onClick={() => {
                  setFailed(false);
                  setAsking(s);
                }}
              >
                {s.status === 'suspended' ? t('list.removeForGood') : t('list.signOut')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setAsking(null);
        }}
        title={t(forGood ? 'list.forGood.title' : 'list.confirm.title', { name: asking?.device_name ?? '' })}
        description={t(forGood ? 'list.forGood.body' : 'list.confirm.body', { name: asking?.device_name ?? '' })}
        confirmLabel={t(forGood ? 'list.forGood.confirm' : 'list.confirm.confirm')}
        tone="danger"
        busy={revoke.isPending}
        onConfirm={() => {
          if (!asking) return;
          const name = asking.device_name;
          setFailed(false);
          revoke.mutate(asking.id, {
            onSuccess: () => {
              setAsking(null);
              notify(t(forGood ? 'list.forGood.done' : 'list.confirm.done', { name }), { tone: 'success' });
            },
            onError: () => setFailed(true)
          });
        }}
      >
        {failed && (
          <p
            role="alert"
            className="rounded-control border border-danger/40 bg-danger-subtle p-3 text-caption text-danger"
          >
            {t('list.confirm.failed')}
          </p>
        )}
      </ConfirmDialog>
    </section>
  );
}
