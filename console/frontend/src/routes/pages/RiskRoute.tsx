import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatDateTime } from '../../i18n/format';
import { useNodes } from '../../services/queries';
import {
  useBlockDevice,
  useRiskEvents,
  useRiskLeaderboard,
  useRiskSummary,
  type RiskEvent,
  type RiskRow
} from '../../services/queries/risk';
import type { MeshNode } from '../../services/types';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FilteredEmptyState,
  PageHeader,
  Row,
  RowList,
  Skeleton,
  Stat,
  Table,
  type TableColumn
} from '../../ui';
import { PageFrame } from '../PageFrame';

type Band = 'all' | 'critical' | 'medium' | 'low';

const KNOWN_TYPES = ['EXIT_BRIDGE', 'CLIENT_ORIGIN', 'RELAY', 'HYBRID'];
const KNOWN_EVENTS = [
  'NODE_QUARANTINED',
  'NODE_QUARANTINE',
  'NODE_LIFT_QUARANTINE',
  'IMPOSSIBLE_TRAVEL_DETECTED',
  'POSTURE_VIOLATION',
  'GEO_DRIFT_DETECTED',
  'NODE_ATTESTED',
  'RISK_ATTESTATION'
];

/** The bands the console and the engine share: below 40, 40 to 75, and above 75 (blocked automatically). */
function bandOf(score: number): Exclude<Band, 'all'> {
  if (score > 75) return 'critical';
  if (score >= 40) return 'medium';
  return 'low';
}

type Notice = { tone: 'success' | 'error'; text: string } | null;

export default function RiskRoute() {
  const { t, i18n } = useTranslation(['risk', 'glossary']);
  const summaryQuery = useRiskSummary();
  const leaderboardQuery = useRiskLeaderboard();
  const eventsQuery = useRiskEvents();
  const nodesQuery = useNodes();
  const block = useBlockDevice();

  const [band, setBand] = useState<Band>('all');
  const [target, setTarget] = useState<RiskRow | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const nodesById = useMemo(() => {
    const map = new Map<string, MeshNode>();
    for (const node of nodesQuery.data ?? []) map.set(node.id, node);
    return map;
  }, [nodesQuery.data]);

  if ((summaryQuery.isLoading || leaderboardQuery.isLoading) && !summaryQuery.data && !leaderboardQuery.data) {
    return (
      <PageFrame>
        <Skeleton className="h-[400px] w-full rounded-xl" />
      </PageFrame>
    );
  }

  if ((summaryQuery.error && !summaryQuery.data) || (leaderboardQuery.error && !leaderboardQuery.data)) {
    const failure = summaryQuery.error ?? leaderboardQuery.error;
    return (
      <PageFrame>
        <ErrorState
          body={t('error.load')}
          error={failure}
          detail={failure?.message}
          onRetry={() => {
            void summaryQuery.refetch();
            void leaderboardQuery.refetch();
          }}
        />
      </PageFrame>
    );
  }

  const summary = summaryQuery.data;
  const rows = leaderboardQuery.data ?? [];
  const total = summary?.total_nodes;
  // With no devices the engine's average is 0, which is not a measurement.
  const average = total === 0 ? null : (summary?.average_risk_score ?? null);
  const visible = band === 'all' ? rows : rows.filter((row) => bandOf(row.risk_score) === band);

  function typeLabel(node: MeshNode | undefined): string {
    return node?.role && KNOWN_TYPES.includes(node.role)
      ? t(`deviceType.${node.role}`, { ns: 'glossary' })
      : t('deviceType.unknown', { ns: 'glossary' });
  }

  function statusOf(row: RiskRow, node: MeshNode | undefined) {
    if (row.is_quarantined) return t('status.blocked');
    if (node?.posture_status === 'verified_compliant') return t('status.allPassed');
    return t('status.notReported');
  }

  function refreshAll() {
    void summaryQuery.refetch();
    void leaderboardQuery.refetch();
    void eventsQuery.refetch();
    void nodesQuery.refetch();
  }

  function confirmBlock() {
    if (!target) return;
    const device = target;
    block.mutate(
      { id: device.node_id, reason: t('blockReason') },
      {
        onSuccess: () => {
          setTarget(null);
          setNotice({ tone: 'success', text: t('block.done') });
        },
        onError: () => {
          setTarget(null);
          setNotice({ tone: 'error', text: t('block.failed') });
        }
      }
    );
  }

  const columns: Array<TableColumn<RiskRow>> = [
    {
      id: 'device',
      header: t('columns.device'),
      cell: (row) => {
        const node = nodesById.get(row.node_id);
        return (
          <div className="space-y-0.5">
            <p className="font-medium text-content">{row.name || row.node_id}</p>
            <p className="text-caption text-muted">{typeLabel(node)}</p>
          </div>
        );
      }
    },
    {
      id: 'score',
      header: t('columns.score'),
      numeric: true,
      cell: (row) => <span className="tabular-nums">{row.risk_score}</span>
    },
    { id: 'status', header: t('columns.status'), cell: (row) => statusOf(row, nodesById.get(row.node_id)) },
    {
      id: 'action',
      header: t('columns.action'),
      cell: (row) =>
        row.is_quarantined ? null : (
          <Button size="sm" variant="secondary" onClick={() => setTarget(row)}>
            {t('action.block')}
          </Button>
        )
    }
  ];

  const bandButtons: Array<{ value: Band; label: string }> = [
    { value: 'all', label: t('filters.all') },
    { value: 'critical', label: t('filters.critical') },
    { value: 'medium', label: t('filters.medium') },
    { value: 'low', label: t('filters.low') }
  ];

  return (
    <PageFrame>
      <div className="space-y-6">
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={
            <Button variant="secondary" onClick={refreshAll}>
              {t('refresh')}
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

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={t('band.low')} value={summary?.distribution?.low ?? null} />
          <Stat label={t('band.medium')} value={summary?.distribution?.medium ?? null} hint={t('band.mediumHint')} />
          <Stat label={t('band.critical')} value={summary?.distribution?.high ?? null} hint={t('band.criticalHint')} />
          <Stat label={t('average')} value={average} hint={t('averageHint')} />
        </div>

        <div role="group" aria-label={t('filters.label')} className="flex flex-wrap gap-2">
          {bandButtons.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={band === option.value ? 'primary' : 'secondary'}
              aria-pressed={band === option.value}
              onClick={() => setBand(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>

        <Table<RiskRow>
          caption={t('leaderboard')}
          columns={columns}
          rows={visible}
          rowKey={(row) => row.node_id}
          empty={
            rows.length === 0 ? (
              <EmptyState body={t('empty.leaderboard')} />
            ) : (
              <FilteredEmptyState
                title={t('filter.emptyTitle')}
                body={t('filter.emptyBody')}
                resetLabel={t('filter.clear')}
                onReset={() => setBand('all')}
              />
            )
          }
        />

        <section aria-labelledby="risk-feed-heading" className="space-y-3">
          <h2 id="risk-feed-heading" className="text-heading font-semibold text-content">
            {t('feed')}
          </h2>
          {eventsQuery.error && !eventsQuery.data ? (
            <ErrorState body={t('error.feed')} error={eventsQuery.error} onRetry={() => void eventsQuery.refetch()} />
          ) : (eventsQuery.data ?? []).length === 0 ? (
            <EmptyState body={t('empty.feed')} />
          ) : (
            <RowList label={t('feed')}>
              {(eventsQuery.data ?? []).map((event: RiskEvent) => {
                const node = event.node_id ? nodesById.get(event.node_id) : undefined;
                const device = node?.name || event.node_id || '';
                const when = formatDateTime(i18n.language, event.created_at);
                const known = KNOWN_EVENTS.includes(event.event_type) ? event.event_type : 'OTHER';
                return (
                  <Row
                    key={String(event.id)}
                    title={t(`event.types.${known}`)}
                    meta={[device, when].filter(Boolean).join(' · ') || undefined}
                    status={
                      typeof event.risk_delta === 'number' ? (
                        <span className="tabular-nums">{t('event.delta', { n: event.risk_delta })}</span>
                      ) : (
                        <span>
                          <span aria-hidden="true">—</span>
                          <span className="sr-only">{t('event.deltaUnknown')}</span>
                        </span>
                      )
                    }
                  />
                );
              })}
            </RowList>
          )}
        </section>

        <ConfirmDialog
          open={target !== null}
          onOpenChange={(open) => {
            if (!open) setTarget(null);
          }}
          title={t('block.title', { name: target?.name || target?.node_id || '' })}
          description={t('block.body')}
          confirmLabel={t('action.block')}
          tone="danger"
          busy={block.isPending}
          onConfirm={confirmBlock}
        />
      </div>
    </PageFrame>
  );
}
