import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../ui/Button';
import { Dialog } from '../../../ui/Dialog';
import { useToast } from '../../../ui/Toast';
import { cn } from '../../../ui/cn';
import { useMoveToCompartment, usePreviewMove } from '../../../services/queries';
import { ColourDot } from './ColourDot';
import type { EditorLine } from './editorModel';
import { errorText } from './errors';
import { PreviewList } from './PreviewList';

export interface MoveDialogProps {
  /** The devices to move. */
  ids: string[];
  /** The line to move them to; when absent the dialog first asks. */
  to?: string;
  /** The name of `to` when the line is too new to be in `lines` yet. */
  toLabel?: string;
  lines: EditorLine[];
  /** Closes the dialog. `moved` is set when the move was made. */
  onClose: (moved?: { ids: string[]; to: string }) => void;
}

/**
 * Moving devices, in two steps that cannot be skipped: choose the line (unless a drop already
 * did), then read what the move changes and confirm. Nothing is written before the confirm; the
 * preview is the server's own what-if, so it names exactly the devices that would gain or lose.
 */
export function MoveDialog({ ids, to: initialTo, toLabel, lines, onClose }: MoveDialogProps) {
  const { t } = useTranslation('mapEditor');
  const { notify } = useToast();
  const [target, setTarget] = useState<string | undefined>(initialTo);
  const preview = usePreviewMove();
  const move = useMoveToCompartment();
  const [failure, setFailure] = useState<string | null>(null);

  const idsKey = ids.join('\u0000');
  const { mutate: runPreview, reset: resetPreview } = preview;
  useEffect(() => {
    if (!target) return;
    runPreview({ nodeIds: ids, to: target });
    // `ids` is read through its key: a new array with the same devices must not ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, idsKey, runPreview]);

  // A line that already holds every one of the devices is no place to move them to.
  const choices = lines.filter(
    (line) =>
      line.id !== null && !(line.stations.length > 0 && ids.every((id) => line.stations.some((s) => s.id === id)))
  );
  const known = lines.find((line) => line.id === target);
  const targetLine = known ?? (target && toLabel ? { label: toLabel } : undefined);

  const submitMove = async () => {
    if (!target || !targetLine) return;
    setFailure(null);
    try {
      await move.mutateAsync({ compartmentId: target, nodeIds: ids });
      notify(
        ids.length === 1
          ? t('toast.moved', { line: targetLine.label })
          : t('toast.movedMany', { count: ids.length, line: targetLine.label }),
        { tone: 'success' }
      );
      onClose({ ids, to: target });
    } catch (error) {
      setFailure(errorText(t, error));
    }
  };

  if (!target || !targetLine) {
    return (
      <Dialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t('move.pickTitle')}
        description={t('move.pickDescription')}
        size="sm"
        footer={<Button onClick={() => onClose()}>{t('cancel')}</Button>}
      >
        <ul aria-label={t('move.pickList')} className="space-y-1">
          {choices.map((line) => (
            <li key={line.key}>
              <button
                type="button"
                onClick={() => setTarget(line.id ?? undefined)}
                className={cn(
                  'flex min-h-9 w-full items-center gap-2 rounded-control border border-border-strong px-3 text-left',
                  'text-body text-ink hover:bg-surface-hover focus-visible:outline-focus'
                )}
              >
                <ColourDot colour={line.colour} />
                <span className="min-w-0 flex-1 truncate">{line.label}</span>
                <span className="text-caption text-ink-muted">
                  {t('line.devices', { count: line.stations.length })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Dialog>
    );
  }

  const ready = preview.isSuccess && !preview.isPending;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('move.title', { line: targetLine.label })}
      description={t('move.description')}
      footer={
        <>
          {!initialTo && (
            <Button
              onClick={() => {
                resetPreview();
                setTarget(undefined);
              }}
            >
              {t('move.back')}
            </Button>
          )}
          <Button onClick={() => onClose()}>{t('cancel')}</Button>
          <Button variant="primary" disabled={!ready} loading={move.isPending} onClick={() => void submitMove()}>
            {t('move.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {preview.isPending && (
          <p role="status" className="text-body text-ink-muted">
            {t('move.loading')}
          </p>
        )}
        {preview.isError && (
          <div role="alert" className="space-y-2">
            <p className="text-body text-ink">{t('move.error', { message: errorText(t, preview.error) })}</p>
            <Button size="sm" onClick={() => runPreview({ nodeIds: ids, to: target })}>
              {t('move.retry')}
            </Button>
          </div>
        )}
        {preview.data && <PreviewList preview={preview.data} />}
        {failure && (
          <p role="alert" className="border-l-2 border-danger pl-3 text-body text-ink">
            {failure}
          </p>
        )}
      </div>
    </Dialog>
  );
}
