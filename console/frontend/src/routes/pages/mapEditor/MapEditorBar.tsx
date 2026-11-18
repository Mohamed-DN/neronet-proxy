import { Pencil, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Checkbox';
import { ColourDot } from './ColourDot';
import type { MapEditorApi } from './useMapEditor';

/**
 * The entry to editing and, while it is on, the banner that says what is going on: "Stai
 * modificando la rete", the end button, "Nuova linea", and what can be done with the devices
 * chosen. Renders nothing for a role that cannot change lines.
 */
export function MapEditorBar({ api, collapsed = false }: { api: MapEditorApi; collapsed?: boolean }) {
  const { t } = useTranslation('mapEditor');
  if (!api.canEdit) return null;

  if (!api.active) {
    return (
      <Button ref={api.enterRef} data-map-editor-enter icon={Pencil} onClick={api.start} title={t('enterHint')}>
        {t('enter')}
      </Button>
    );
  }

  const count = api.selected.size;
  return (
    <section
      aria-label={t('banner')}
      data-testid="map-editor-banner"
      className="space-y-3 rounded-plate border-2 border-ink bg-plate p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-body font-semibold text-ink">{t('banner')}</p>
        <div className="flex items-center gap-2">
          <Button icon={Plus} onClick={api.openCreate}>
            {t('newLine')}
          </Button>
          <Button variant="primary" data-map-editor-done onClick={api.finish}>
            {t('done')}
          </Button>
        </div>
      </div>

      <p className="text-caption text-ink-muted">{collapsed ? t('collapsedNote') : t('keyboardHint')}</p>

      {count === 0 ? (
        <p className="text-caption text-ink-muted">{t('selection.chooseHint')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('selection.count', { count })}>
          <p role="status" className="text-body font-medium text-ink">
            {t('selection.count', { count })}
          </p>
          <Button variant="primary" onClick={() => api.openMove()}>
            {t('selection.move')}
          </Button>
          <Button
            disabled={api.splitSource === null}
            aria-describedby={api.splitSource === null ? 'map-editor-split-hint' : undefined}
            onClick={api.openSplit}
          >
            {t('selection.split')}
          </Button>
          <Button variant="ghost" onClick={api.clear}>
            {t('selection.clear')}
          </Button>
          {api.splitSource === null && (
            <span id="map-editor-split-hint" className="text-caption text-ink-muted">
              {t('selection.splitNeedsOne')}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * The same editor as a list: every line with its devices behind checkboxes, and the line's name
 * opening its menu. It is the way in for a keyboard, a screen reader and a touch screen when the
 * map is a poster, and the whole editor on the topology page, which draws its own map.
 */
export function EditorPanel({ api }: { api: MapEditorApi }) {
  const { t } = useTranslation('mapEditor');
  if (!api.active) return null;
  return (
    <div className="space-y-3" data-testid="map-editor-panel">
      <div>
        <h3 className="text-body font-semibold text-ink">{t('panel.title')}</h3>
        <p className="max-w-[65ch] text-caption text-ink-muted">{t('panel.description')}</p>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        {api.lines.map((line) => (
          <section key={line.key} aria-label={line.label}>
            <h4 className="flex items-center gap-2 text-body font-semibold text-ink">
              <ColourDot colour={line.colour} />
              {line.id ? (
                <button
                  type="button"
                  data-editor-line={line.key}
                  aria-label={t('line.edit', { name: line.label })}
                  onClick={() => api.openLine(line.key)}
                  className="min-h-8 rounded-control px-1 text-left underline decoration-dotted underline-offset-4 hover:bg-surface-hover focus-visible:outline-focus"
                >
                  {line.label}
                </button>
              ) : (
                <span>{line.label}</span>
              )}
              <span className="font-normal text-ink-muted">{t('line.devices', { count: line.stations.length })}</span>
            </h4>
            <ul className="mt-1">
              {line.stations.map((station) => (
                <li key={station.id}>
                  <Checkbox
                    data-editor-station={station.id}
                    label={station.name}
                    checked={api.selected.has(station.id)}
                    onChange={() => api.toggle(station.id)}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
