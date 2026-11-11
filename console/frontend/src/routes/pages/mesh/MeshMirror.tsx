import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TopologyNode } from '../../../services/types';
import type { NodeKind, NodeState } from '../topologyGraph';
import { KindSample } from './glyphs';

export interface MirrorGroup {
  key: string;
  label: string;
  items: Array<{ node: TopologyNode; kind: NodeKind; state: NodeState; connections: number }>;
}

interface MeshMirrorProps {
  groups: MirrorGroup[];
  activeId: string | null;
  selectedId: string | null;
  onFocusItem: (id: string | null) => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}

/**
 * The map as a list, for keyboards and screen readers. One tab stop: arrow keys,
 * Home and End move between devices, Enter opens the details, Escape closes them.
 * It stays out of sight until it holds focus, then shows over the map while the
 * map draws a focus ring on the same device.
 */
export function MeshMirror({ groups, activeId, selectedId, onFocusItem, onOpen, onClose }: MeshMirrorProps) {
  const { t } = useTranslation('topology');
  const listRef = useRef<HTMLDivElement | null>(null);
  const order = groups.flatMap((group) => group.items.map((item) => item.node.id));
  const current = activeId && order.includes(activeId) ? activeId : (selectedId ?? order[0] ?? null);

  const focusId = (id: string | undefined) => {
    if (!id) return;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-mirror-id]') ?? [];
    [...buttons].find((button) => button.dataset.mirrorId === id)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const index = current ? order.indexOf(current) : -1;
    if (event.key === 'ArrowDown') focusId(order[Math.min(order.length - 1, index + 1)]);
    else if (event.key === 'ArrowUp') focusId(order[Math.max(0, index - 1)]);
    else if (event.key === 'Home') focusId(order[0]);
    else if (event.key === 'End') focusId(order[order.length - 1]);
    else if (event.key === 'Escape') onClose();
    else return;
    event.preventDefault();
  };

  if (order.length === 0) return null;

  return (
    <div
      ref={listRef}
      className="mesh-mirror"
      role="group"
      aria-label={t('mirror.label')}
      aria-describedby="mesh-mirror-help"
    >
      <p id="mesh-mirror-help" className="mesh-mirror-help">
        {t('mirror.help')}
      </p>
      {groups.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h3 className="mesh-mirror-heading">{group.label}</h3>
          <ul>
            {group.items.map(({ node, kind, state, connections }) => (
              <li key={node.id}>
                <button
                  type="button"
                  data-mirror-id={node.id}
                  tabIndex={node.id === current ? 0 : -1}
                  aria-current={node.id === selectedId ? 'true' : undefined}
                  onFocus={() => onFocusItem(node.id)}
                  onKeyDown={onKeyDown}
                  onBlur={(event) => {
                    if (!listRef.current?.contains(event.relatedTarget as Node | null)) onFocusItem(null);
                  }}
                  onClick={() => onOpen(node.id)}
                >
                  <KindSample kind={kind} state={state} />
                  <span className="mesh-mirror-name">{node.name || node.id}</span>
                  <span className="mesh-mirror-meta">
                    {`, ${t(`kind.${kind}`)}, ${t(`nodeState.${state}`)}, ${t('mirror.connections', { count: connections })}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
