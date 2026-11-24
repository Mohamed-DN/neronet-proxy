import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../context/AuthContext';
import { ApiError } from '../services/apiClient';
import { isProfileGateway, useDeleteOwnDevice, useNodes } from '../services/queries/nodes';
import type { MeshNode } from '../services/types';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { cn } from '../ui/cn';
import { PageHeader } from '../ui/PageHeader';
import { EmptyState, ErrorState, Skeleton } from '../ui/States';
import { useToast } from '../ui/Toast';
import { deviceStatus } from './deviceStatus';
import { DeviceList } from './DeviceList';
import DownloadApps from './DownloadApps';
import SignedInApps from './SignedInApps';

const PRIMARY_LARGE =
  'inline-flex h-11 items-center justify-center gap-2 rounded-control border border-transparent bg-accent px-4 text-body font-medium text-accent-contrast hover:bg-accent-strong focus-visible:outline-focus';

/**
 * The phone-first page: the person's own devices, whether any is blocked, a
 * small picture of them, the way to add one, and the apps to install. The
 * server returns the whole organisation to some roles, so the list is filtered
 * to the signed-in person here.
 */
export default function MeRoute() {
  const { t } = useTranslation('portal');
  const { user } = useAuth();
  const nodes = useNodes();
  const now = Date.now();
  const { notify } = useToast();
  const removeDevice = useDeleteOwnDevice();
  const navigate = useNavigate();
  // The same confirmation serves both actions: removing a device, and making its access again.
  const [removing, setRemoving] = useState<{ node: MeshNode; rebuild: boolean } | null>(null);
  const [removeFailed, setRemoveFailed] = useState<'failed' | 'gatewayInUse' | 'deviceBlocked' | null>(null);
  const removingNode = removing?.node ?? null;
  const rebuild = removing?.rebuild === true;
  const removingName = removingNode ? (removingNode.name ?? removingNode.hostname ?? t('me.unnamed')) : '';

  const confirmRemove = () => {
    if (!removingNode) return;
    const name = removingName;
    setRemoveFailed(null);
    removeDevice.mutate(removingNode.id, {
      onSuccess: () => {
        setRemoving(null);
        // There is no way to issue a new access for an existing device yet, so making it again
        // is removing it and adding it with the same name; the old access is gone either way.
        if (rebuild) navigate('/me/add', { state: { name } });
        else notify(t('me.remove.done', { name }), { tone: 'success' });
      },
      onError: (error) =>
        setRemoveFailed(
          error instanceof ApiError && error.code === 'profile_gateway_in_use'
            ? 'gatewayInUse'
            : error instanceof ApiError && error.code === 'device_blocked'
              ? 'deviceBlocked'
              : 'failed'
        )
    });
  };

  // The gateway that serves the organisation's WireGuard profiles is infrastructure, not
  // a personal device: removing it would cut every profile device, so it is not listed here.
  const mine = useMemo(
    () => (user ? (nodes.data ?? []).filter((node) => node.user_id === user.id && !isProfileGateway(node)) : []),
    [nodes.data, user]
  );
  const statuses = mine.map((node) => ({ node, status: deviceStatus(node, now) }));
  const blocked = statuses.filter((s) => s.status === 'blocked').length;

  const hasList = !nodes.isPending && !nodes.isError && mine.length > 0;

  const addLink = (
    <Link to="/me/add" className={PRIMARY_LARGE}>
      {t('me.add')}
    </Link>
  );

  return (
    <>
      <PageHeader title={t('me.title')} description={t('me.description')} />

      {nodes.isPending ? (
        <div className="space-y-3">
          <Skeleton lines={3} />
          <p role="status" className="sr-only">
            {t('me.loading')}
          </p>
        </div>
      ) : nodes.isError ? (
        <ErrorState
          title={t('me.error.title')}
          body={t('me.error.body')}
          error={nodes.error}
          onRetry={() => void nodes.refetch()}
        />
      ) : mine.length === 0 ? (
        <EmptyState title={t('me.empty.title')} body={t('me.empty.body')} action={addLink} />
      ) : (
        <>
          {blocked > 0 && (
            <p
              role="status"
              className="mb-6 flex items-start gap-2 rounded-card border border-warning/40 bg-warning-subtle p-3 text-body text-content"
            >
              <TriangleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>{t('me.blocked', { count: blocked })}</span>
            </p>
          )}

          <DeviceList
            devices={mine}
            now={now}
            onRemove={(node) => {
              setRemoveFailed(null);
              setRemoving({ node, rebuild: false });
            }}
            onRebuild={(node) => {
              setRemoveFailed(null);
              setRemoving({ node, rebuild: true });
            }}
          />
        </>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !removeDevice.isPending) setRemoving(null);
        }}
        title={t(rebuild ? 'me.rebuild.title' : 'me.remove.title', { name: removingName })}
        description={t(rebuild ? 'me.rebuild.body' : 'me.remove.body', { name: removingName })}
        confirmLabel={t(rebuild ? 'me.rebuild.confirm' : 'me.remove.confirm')}
        tone="danger"
        busy={removeDevice.isPending}
        onConfirm={confirmRemove}
      >
        {removeFailed && (
          <p
            role="alert"
            className="rounded-control border border-danger/40 bg-danger-subtle p-3 text-caption text-danger"
          >
            {t(`me.remove.${removeFailed}`, {
              name: removingName
            })}
          </p>
        )}
      </ConfirmDialog>

      <SignedInApps />

      <DownloadApps />

      {/* The fixed bar repeats the empty state's own call to action, so it exists only with a list. */}
      {hasList && (
        <>
          {/* Room for the fixed bar on a phone, so it never covers the last thing on the page. */}
          <div aria-hidden="true" className="h-20 sm:hidden" />
          <div
            className={cn(
              'fixed inset-x-0 bottom-0 z-sticky border-t border-border-subtle bg-surface-raised p-4',
              'pb-[max(1rem,env(safe-area-inset-bottom))] sm:static sm:border-0 sm:bg-transparent sm:p-0 sm:pt-8'
            )}
          >
            <div className="mx-auto flex w-full max-w-[640px] sm:justify-end">
              <Link to="/me/add" className={cn(PRIMARY_LARGE, 'w-full sm:w-auto')}>
                {t('me.add')}
              </Link>
            </div>
          </div>
        </>
      )}
    </>
  );
}
