import { useTranslation } from 'react-i18next';

import { ApiError } from '../../services/apiClient';
import {
  useOrganizationConnectionOrder,
  usePreviewConnectionOrder,
  useSetOrganizationConnectionOrder,
  type OrderChange
} from '../../services/queries/connectionOrder';
import { effectiveRole } from '../../services/roles';
import { Card, CardHeader, ErrorState, Skeleton, Switch, useToast } from '../../ui';
import { ConnectionOrderEditor, orderSentence, originLabel } from './ConnectionOrderEditor';

type RoleUser = Parameters<typeof effectiveRole>[0];
type T = (key: string, options?: Record<string, unknown>) => string;

/**
 * Settings, "Connection order" (ADR 0037): the order the organisation's devices try the ways to
 * connect, Automatico by default, and whether members may choose for their own devices. An owner
 * or administrator edits it; everyone else reads it. Lines and devices can override it.
 */
export function ConnectionOrderCard({ user }: { user: RoleUser }) {
  const { t } = useTranslation(['connection', 'settings']);
  const tt = t as unknown as T;
  const { notify } = useToast();
  const query = useOrganizationConnectionOrder();
  const save = useSetOrganizationConnectionOrder();
  const preview = usePreviewConnectionOrder();
  const role = effectiveRole(user);
  const mayManage = role === 'super-admin' || role === 'owner' || role === 'admin';
  const data = query.data;

  async function onSave(next: OrderChange) {
    await save.mutateAsync(next);
    notify(t('saved'), { tone: 'success' });
  }

  async function toggleMembers(on: boolean) {
    try {
      await save.mutateAsync({ members_may_choose: on });
      notify(t('saved'), { tone: 'success' });
    } catch (error) {
      notify(error instanceof ApiError && error.status === 403 ? t('settings:forbidden') : t('failed'), {
        tone: 'danger'
      });
    }
  }

  return (
    <Card>
      <CardHeader as="h2" title={t('org.title')} description={t('org.body')} />
      {query.isLoading ? (
        <Skeleton lines={4} />
      ) : query.isError || !data || !Array.isArray(data.allowed) ? (
        <ErrorState title={t('loadError')} detail={query.error?.message} onRetry={() => query.refetch()} />
      ) : (
        <div className="space-y-5">
          <p className="text-body">
            {t('summary.now', {
              order: orderSentence(tt, data.effective.order, data.effective.forced),
              origin: originLabel(tt, data.effective.origin)
            })}
          </p>
          <ConnectionOrderEditor
            idPrefix="org-order"
            allowed={data.allowed}
            own={data.own}
            inherited={{ order: data.default_order, origin: { scope: 'default' } }}
            inheritLabel={t('org.automatic')}
            mayEdit={mayManage}
            readOnlyNote={t('org.onlyAdmin')}
            onPreview={(next) => preview.mutateAsync({ scope: 'organization', settings: next })}
            onSave={onSave}
          />
          <div className="border-t border-border-subtle pt-4">
            <Switch
              checked={data.members_may_choose}
              disabled={!mayManage || save.isPending}
              onCheckedChange={(on) => void toggleMembers(on)}
              label={t('org.members')}
              description={t('org.membersHint')}
            />
          </div>
        </div>
      )}
    </Card>
  );
}
