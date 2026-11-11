import { useTranslation } from 'react-i18next';
import { ExternalLink, Link2, Scissors, X } from 'lucide-react';
import type { TopologyLink, TopologyNode } from '../../../services/types';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { CodeText } from '../../../ui/CodeText';
import { StatusBadge, type Status } from '../../../ui/StatusBadge';
import { GlossaryHint } from '../../GlossaryHint';
import { formatRelativeTime } from '../../../i18n/format';
import type { LinkState, NodeKind, NodeState } from '../topologyGraph';
import { KindSample, LinkSample } from './glyphs';

const STATUS: Record<NodeState, Status> = {
  online: 'ok',
  degraded: 'warning',
  offline: 'unknown',
  quarantined: 'critical',
  unmeasured: 'not-measured'
};

export interface PeerRow {
  node: TopologyNode;
  kind: NodeKind;
  /** The direct link to the selected device, or null for a peer two steps away. */
  link: TopologyLink | null;
  state: LinkState | null;
}

interface DeviceDetailsProps {
  node: TopologyNode;
  kind: NodeKind;
  state: NodeState;
  now: number;
  gateway: TopologyNode | null;
  allowedCount: number;
  measuredSummary: string | null;
  peers: PeerRow[];
  peerTotal: number;
  hops: 1 | 2;
  onHops: (hops: 1 | 2) => void;
  onPeer: (id: string) => void;
  onLink: (link: TopologyLink) => void;
  onOpenDevice: () => void;
}

interface LinkDetailsProps {
  source: TopologyNode | null;
  target: TopologyNode | null;
  link: TopologyLink;
  state: LinkState;
  cut: boolean;
  error: string | null;
  notice: string | null;
  busy: boolean;
  canRestore: boolean;
  onPeer: (id: string) => void;
  onBlock: () => void;
  onRestore: () => void;
}

export function stateLabelKey(state: NodeState): string {
  return `nodeState.${state}`;
}

function Row({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function DeviceDetails(props: DeviceDetailsProps) {
  const { t, i18n } = useTranslation('topology');
  const { node, kind, state } = props;
  const seen = formatRelativeTime(
    i18n.language,
    (node.last_seen_at as string | null | undefined) ?? null,
    new Date(props.now)
  );
  const path =
    kind === 'profile'
      ? props.gateway
        ? t('inspector.pathGateway', { name: props.gateway.name || props.gateway.id })
        : t('inspector.pathGatewayUnknown')
      : (props.measuredSummary ?? t('state.notMeasured'));

  return (
    <div className="mesh-inspector-body">
      <div className="mesh-inspector-title">
        <KindSample kind={kind} state={state} />
        <h2>{node.name || node.id}</h2>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={STATUS[state]} label={t(stateLabelKey(state))} />
        {node.is_ghost_vault && <Badge tone="warning">{t('nodeDrawer.ghostVaultNode')}</Badge>}
      </div>
      {node.overlay_ipv4 && (
        <span className="flex items-center gap-1">
          <CodeText>{node.overlay_ipv4}</CodeText>
          <GlossaryHint
            text={t('glossary:terms.overlayAddress.body')}
            label={t('glossary:ariaLabel', { term: t('glossary:terms.overlayAddress.term') })}
          />
        </span>
      )}

      <dl className="mesh-facts">
        <Row term={t('nodeDrawer.role')}>{t(`kind.${kind}`)}</Row>
        <Row term={t('nodeDrawer.compartment')}>{node.compartment_name || '—'}</Row>
        <Row term={t('inspector.lastSeen')}>{seen ?? '—'}</Row>
        <Row term={t('nodeDrawer.latency')}>
          {node.latency_ms !== null && node.latency_ms !== undefined ? `${node.latency_ms} ms` : t('state.notMeasured')}
        </Row>
        <Row term={t('inspector.path')}>{path}</Row>
        <Row term={t('nodeDrawer.country')}>{node.country || '—'}</Row>
      </dl>
      <p className="mesh-inspector-meta">
        {t('radial.allowedPairs')}: {props.allowedCount}
      </p>

      <div className="mesh-neighborhood" role="group" aria-label={t('graph.neighborhood')}>
        <div className="mesh-neighborhood-heading">
          <h3>{t('graph.neighborhood')}</h3>
          <span data-neighbour-count>{props.peerTotal}</span>
        </div>
        <div className="mesh-hop-controls">
          {([1, 2] as const).map((hops) => (
            <button key={hops} type="button" aria-pressed={props.hops === hops} onClick={() => props.onHops(hops)}>
              {t('graph.hops', { count: hops })}
            </button>
          ))}
        </div>
        <p>{t('graph.policyOnly')}</p>
        <ul>
          {props.peers.map((peer) => (
            <li key={peer.node.id}>
              <button type="button" className="mesh-peer" onClick={() => props.onPeer(peer.node.id)}>
                <KindSample kind={peer.kind} />
                <span className="mesh-peer-name">{peer.node.name || peer.node.id}</span>
                <span className="mesh-peer-state">
                  {peer.state ? t(`linkState.${peer.state}`) : t('inspector.secondHop')}
                </span>
              </button>
              {peer.link && peer.state && (
                <button
                  type="button"
                  className="mesh-peer-link"
                  aria-label={`${t('canvas.linkTitle')}: ${node.name || node.id} — ${peer.node.name || peer.node.id}`}
                  title={t('inspector.openConnection')}
                  onClick={() => props.onLink(peer.link!)}
                >
                  <LinkSample state={peer.state} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {props.peerTotal > props.peers.length && <p>{t('graph.neighborLimit')}</p>}
      </div>

      <Button variant="secondary" size="sm" icon={ExternalLink} onClick={props.onOpenDevice}>
        {t('nodeDrawer.viewDetails')}
      </Button>
    </div>
  );
}

export function LinkDetails(props: LinkDetailsProps) {
  const { t, i18n } = useTranslation('topology');
  const handshake = formatRelativeTime(
    i18n.language,
    (props.link.last_handshake_at as string | null | undefined) ?? null
  );
  const endpoint = (node: TopologyNode | null, id: string) => (
    <button type="button" className="mesh-peer" onClick={() => props.onPeer(id)}>
      <span className="mesh-peer-name">{node?.name || id}</span>
    </button>
  );
  return (
    <div className="mesh-inspector-body">
      <div className="mesh-inspector-title">
        <LinkSample state={props.state} />
        <h2>{t('canvas.linkTitle')}</h2>
      </div>
      <div>
        <Badge tone={props.cut ? 'danger' : 'neutral'}>{t(`linkState.${props.state}`)}</Badge>
      </div>
      <div className="mesh-endpoints">
        {endpoint(props.source, props.link.source)}
        {endpoint(props.target, props.link.target)}
      </div>
      <dl className="mesh-facts">
        <Row term={t('radial.transport')}>
          {props.state === 'direct' || props.state === 'relayed'
            ? t(`linkState.${props.state}`)
            : t('state.notMeasured')}
        </Row>
        <Row term={t('inspector.lastHandshake')}>{handshake ?? '—'}</Row>
      </dl>
      <p className="mesh-inspector-meta">{t('canvas.cutExplain')}</p>
      {props.error && (
        <p role="alert" className="text-caption text-danger">
          {props.error}
        </p>
      )}
      {props.notice && (
        <p role="status" className="text-caption text-success">
          {props.notice}
        </p>
      )}
      {props.cut ? (
        <Button
          variant="secondary"
          size="sm"
          icon={Link2}
          onClick={props.onRestore}
          loading={props.busy}
          disabled={!props.canRestore}
        >
          {t('canvas.restoreAction')}
        </Button>
      ) : (
        <Button variant="danger" size="sm" icon={Scissors} onClick={props.onBlock} loading={props.busy}>
          {t('canvas.cutAction')}
        </Button>
      )}
    </div>
  );
}

export function InspectorFrame({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const { t } = useTranslation('topology');
  return (
    <aside className="mesh-inspector" aria-label={t('nodeDrawer.title')}>
      <button type="button" className="mesh-inspector-close" aria-label={t('radial.closeDetails')} onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </button>
      {children}
    </aside>
  );
}
