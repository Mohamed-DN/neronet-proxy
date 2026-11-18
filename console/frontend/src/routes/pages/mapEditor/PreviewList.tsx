import { useTranslation } from 'react-i18next';

import type { ReachPreview } from '../../../services/types';
import { namesLine, previewSentence } from './editorModel';

/** How many devices are spelled out; the rest are counted in the summary. */
const SHOWN = 8;

/**
 * What a move or a cut changes, in plain words, one sentence per device with the names behind
 * the counts. The server returns at most 20 names per side; the rest are counted.
 */
export function PreviewList({ preview }: { preview: ReachPreview }) {
  const { t } = useTranslation('mapEditor');
  const nodes = preview.nodes.slice(0, SHOWN);
  const more = preview.nodes.length - nodes.length;
  return (
    <div className="space-y-3" data-testid="reach-preview">
      <ul aria-label={t('preview.list')} className="space-y-3">
        {nodes.map((node) => {
          const gains = namesLine(t, 'gainNames', node.gains);
          const losses = namesLine(t, 'lossNames', node.losses);
          return (
            <li key={node.node_id}>
              <p className="text-body font-medium text-ink">{previewSentence(t, node)}</p>
              {gains && <p className="text-caption text-ink-muted">{gains}</p>}
              {losses && <p className="text-caption text-ink-muted">{losses}</p>}
            </li>
          );
        })}
      </ul>
      {more > 0 && <p className="text-caption text-ink-muted">{t('move.moreDevices', { count: more })}</p>}
      {preview.nodes.length > 1 && (
        <p className="text-caption text-ink-muted">
          {t('move.pairs', { gains: preview.summary.gains, losses: preview.summary.losses })}
        </p>
      )}
      {(preview.ignored ?? 0) > 0 && (
        <p className="text-caption text-ink-muted">{t('move.ignored', { count: preview.ignored })}</p>
      )}
    </div>
  );
}
