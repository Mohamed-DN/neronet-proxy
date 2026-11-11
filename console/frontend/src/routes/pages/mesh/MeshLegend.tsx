import { useTranslation } from 'react-i18next';
import type { GroupGeometry, LinkState, NodeKind } from '../topologyGraph';
import { LINK_STATES, NODE_KINDS } from '../topologyGraph';
import { KindSample, LinkSample } from './glyphs';

interface MeshLegendProps {
  groups: Array<GroupGeometry & { folded: boolean }>;
  hiddenGroups: Set<string>;
  onToggleGroup: (key: string) => void;
  onShowAllGroups: (show: boolean) => void;
  onFoldGroup: (key: string, folded: boolean) => void;
  kindCounts: Record<NodeKind, number>;
  hiddenKinds: Set<NodeKind>;
  onToggleKind: (kind: NodeKind) => void;
  linkCounts: Record<LinkState, number>;
  /** False while no link carries a measured transport: direct and relayed read "—", not 0. */
  measured: boolean;
  linkShown: (state: LinkState) => boolean;
  onToggleLink: (state: LinkState) => void;
}

/**
 * The legend is also the filter: every entry shows or hides what it names, with
 * the same sample the map draws, so reading it and using it are one gesture.
 */
export function MeshLegend(props: MeshLegendProps) {
  const { t } = useTranslation('topology');
  const { groups, hiddenGroups } = props;
  const countText = (state: LinkState) =>
    !props.measured && (state === 'direct' || state === 'relayed') ? '—' : String(props.linkCounts[state]);

  return (
    <section id="mesh-legend" className="mesh-legend" aria-label={t('graph.communities')}>
      <div className="mesh-legend-heading">
        <h2>{t('graph.communities')}</h2>
        <span>{groups.length}</span>
      </div>
      <label className="mesh-legend-all">
        <input
          type="checkbox"
          checked={hiddenGroups.size === 0}
          ref={(element) => {
            if (element) element.indeterminate = hiddenGroups.size > 0 && hiddenGroups.size < groups.length;
          }}
          onChange={(event) => props.onShowAllGroups(event.target.checked)}
        />
        {t('graph.selectAll')}
      </label>
      <ul className="mesh-legend-groups">
        {groups.map((group) => (
          <li key={group.key} className={`mesh-legend-group mesh-community-${group.color}`}>
            <label className="mesh-legend-filter">
              <input
                type="checkbox"
                checked={!hiddenGroups.has(group.key)}
                onChange={() => props.onToggleGroup(group.key)}
              />
              <span className="mesh-legend-swatch" aria-hidden="true" />
              <span className="mesh-legend-name">{group.label}</span>
              <span className="mesh-legend-count">{group.count}</span>
            </label>
            <button
              type="button"
              className="mesh-group-control"
              aria-expanded={!group.folded}
              aria-label={[
                t(group.folded ? 'radial.expand' : 'radial.collapse', { name: group.label }),
                group.unhealthy ? t('radial.groupUnhealthy', { count: group.unhealthy }) : '',
                group.quarantined ? t('radial.groupQuarantined', { count: group.quarantined }) : ''
              ]
                .filter(Boolean)
                .join(', ')}
              onClick={() => props.onFoldGroup(group.key, !group.folded)}
            >
              <span>{t(group.folded ? 'graph.unfold' : 'graph.fold')}</span>
              {group.unhealthy > 0 && (
                <span className="mesh-legend-warning">{t('radial.groupUnhealthy', { count: group.unhealthy })}</span>
              )}
              {group.quarantined > 0 && (
                <span className="mesh-legend-danger">{t('radial.groupQuarantined', { count: group.quarantined })}</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <h2 className="mesh-legend-subheading">{t('legend.kinds')}</h2>
      <ul className="mesh-legend-toggles">
        {NODE_KINDS.map((kind) => (
          <li key={kind}>
            <button type="button" aria-pressed={!props.hiddenKinds.has(kind)} onClick={() => props.onToggleKind(kind)}>
              <KindSample kind={kind} />
              <span className="mesh-legend-name">{t(`kind.${kind}`)}</span>
              <span className="mesh-legend-count">{props.kindCounts[kind]}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="mesh-legend-note">{t('legend.kindNote')}</p>

      <h2 className="mesh-legend-subheading">{t('legend.links')}</h2>
      <ul className="mesh-legend-toggles">
        {LINK_STATES.map((state) => (
          <li key={state}>
            <button type="button" aria-pressed={props.linkShown(state)} onClick={() => props.onToggleLink(state)}>
              <LinkSample state={state} />
              <span className="mesh-legend-name">{t(`linkState.${state}`)}</span>
              <span className="mesh-legend-count">{countText(state)}</span>
            </button>
          </li>
        ))}
      </ul>
      {!props.measured && <p className="mesh-legend-note">{t('legend.notMeasured')}</p>}
      <p className="mesh-legend-note mesh-legend-footnote">{t('graph.scopedCounts')}</p>
    </section>
  );
}
