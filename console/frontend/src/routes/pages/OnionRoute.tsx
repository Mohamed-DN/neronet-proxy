import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { ApiError } from '../../services/apiClient';
import { useNodes } from '../../services/queries';
import { useToggleOnion } from '../../services/queries/onion';
import type { MeshNode } from '../../services/types';
import {
  CodeText,
  EmptyState,
  ErrorState,
  NotMeasured,
  PageHeader,
  Skeleton,
  Switch,
  Table,
  type TableColumn
} from '../../ui';
import { GlossaryHint } from '../GlossaryHint';
import { PageFrame } from '../PageFrame';

const KNOWN_TYPES = ['EXIT_BRIDGE', 'CLIENT_ORIGIN', 'RELAY', 'HYBRID'];

/** True or false when the server reported the setting; undefined when it did not. */
function threeStops(node: MeshNode): boolean | undefined {
  const value = node.onion_routing_enabled;
  if (value === null || value === undefined) return undefined;
  return Boolean(value);
}

export default function OnionRoute() {
  const { t } = useTranslation(['onion', 'glossary']);
  const nodesQuery = useNodes();
  const toggle = useToggleOnion();
  const [toggleError, setToggleError] = useState<string | null>(null);

  const nodes = nodesQuery.data ?? [];

  if (nodesQuery.isLoading && !nodesQuery.data) {
    return (
      <PageFrame>
        <Skeleton className="h-[320px] w-full rounded-xl" />
      </PageFrame>
    );
  }

  if (nodesQuery.error && !nodesQuery.data) {
    return (
      <PageFrame>
        <ErrorState body={t('error.load')} error={nodesQuery.error} onRetry={() => void nodesQuery.refetch()} />
      </PageFrame>
    );
  }

  const setCount = nodes.filter((node) => threeStops(node) === true).length;
  const exitCount = nodes.filter((node) => node.role === 'EXIT_BRIDGE').length;

  function handleToggle(node: MeshNode, enabled: boolean) {
    setToggleError(null);
    toggle.mutate(
      { nodeId: node.id, enabled },
      {
        onError: (error) => {
          const moduleOff = error instanceof ApiError && error.status === 403;
          setToggleError(moduleOff ? t('error.moduleOff') : t('error.save'));
        }
      }
    );
  }

  const columns: Array<TableColumn<MeshNode>> = [
    {
      id: 'device',
      header: t('columns.device'),
      cell: (node) => node.name || node.hostname || node.id
    },
    {
      id: 'address',
      header: t('columns.address'),
      cell: (node) => {
        const address = node.overlay_ipv4;
        return address ? <CodeText>{address}</CodeText> : <NotMeasured />;
      }
    },
    {
      id: 'type',
      header: t('columns.type'),
      cell: (node) =>
        node.role && KNOWN_TYPES.includes(node.role)
          ? t(`deviceType.${node.role}`, { ns: 'glossary' })
          : t('deviceType.unknown', { ns: 'glossary' })
    },
    {
      id: 'country',
      header: t('columns.country'),
      cell: (node) => node.country_code || t('value.unknownCountry')
    },
    {
      id: 'state',
      header: t('columns.state'),
      cell: (node) => {
        const enabled = threeStops(node);
        if (enabled === undefined) return <NotMeasured />;
        const name = node.name || node.hostname || node.id;
        return (
          <div className="flex items-center gap-3">
            <Switch
              checked={enabled}
              label={t('action.toggle', { name })}
              disabled={toggle.isPending && toggle.variables?.nodeId === node.id}
              onCheckedChange={(next) => handleToggle(node, next)}
            />
            <span className="text-muted">{enabled ? t('value.set') : t('value.direct')}</span>
          </div>
        );
      }
    }
  ];

  return (
    <PageFrame>
      <div className="space-y-6">
        <PageHeader title={t('title')} description={t('description')} meta={<GlossaryHint term="onion" />} />

        <div className="flex items-start gap-3 rounded-md border border-warning/40 bg-warning/10 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-medium text-content">{t('banner.title')}</p>
            <p className="text-body text-muted">{t('banner.body')}</p>
          </div>
        </div>

        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-caption text-muted">{t('stats.set')}</dt>
            <dd className="text-heading font-semibold tabular-nums text-content">
              {setCount}{' '}
              <span className="text-caption font-normal text-muted">{t('stats.ofTotal', { n: nodes.length })}</span>
            </dd>
          </div>
          <div>
            <dt className="text-caption text-muted">{t('stats.exits')}</dt>
            <dd className="text-heading font-semibold tabular-nums text-content">{exitCount}</dd>
            <dd className="text-caption text-muted">{t('stats.exitsHint')}</dd>
          </div>
        </dl>

        {toggleError && (
          <p role="alert" className="text-body text-danger">
            {toggleError}
          </p>
        )}

        {nodes.length === 0 ? (
          <EmptyState title={t('empty.title')} body={t('empty.body')} />
        ) : (
          <Table<MeshNode> caption={t('table.caption')} columns={columns} rows={nodes} rowKey={(node) => node.id} />
        )}
      </div>
    </PageFrame>
  );
}
