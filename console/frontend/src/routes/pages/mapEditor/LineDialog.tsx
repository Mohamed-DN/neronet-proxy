import { useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../ui/Button';
import { ConfirmDialog } from '../../../ui/ConfirmDialog';
import { Dialog } from '../../../ui/Dialog';
import { FormField } from '../../../ui/FormField';
import { Input } from '../../../ui/Input';
import { useToast } from '../../../ui/Toast';
import {
  useCompartmentPeerings,
  useDeleteCompartment,
  useMergeCompartment,
  useUpdateCompartment
} from '../../../services/queries';
import type { CompartmentPeering, LineColour } from '../../../services/types';
import { ColourSwatches } from './ColourSwatches';
import type { EditorLine } from './editorModel';
import { listPeers } from './editorModel';
import { errorText, isNameInUse } from './errors';

export interface LineDialogProps {
  line: EditorLine;
  /** Every line in the order the map draws them, for the position and for the merge choices. */
  lines: EditorLine[];
  /** Owner and admin: merge and delete. */
  canMergeOrDelete: boolean;
  /** Put the line one place up (-1) or down (1). Resolves when the order was saved. */
  onMove: (key: string, step: -1 | 1) => Promise<void> | void;
  onClose: () => void;
}

/** The peerings a merge or a delete would drop: every one that names the line, with the other line's name. */
export function peeringsOfLine(
  line: EditorLine,
  peerings: CompartmentPeering[],
  lines: EditorLine[]
): { count: number; peers: string[] } {
  const names = new Map(lines.map((candidate) => [candidate.id, candidate.label]));
  const peers: string[] = [];
  let count = 0;
  for (const peering of peerings) {
    if (peering.src_compartment_id !== line.id && peering.dst_compartment_id !== line.id) continue;
    count += 1;
    const ours = peering.src_compartment_id === line.id;
    const otherId = ours ? peering.dst_compartment_id : peering.src_compartment_id;
    const name = names.get(otherId) ?? (ours ? peering.dst_name : peering.src_name) ?? otherId;
    if (!peers.includes(name)) peers.push(name);
  }
  return { count, peers };
}

/**
 * One line's menu, opened from its name on the map: rename, colour, position, merge and delete.
 * Each change is one button and says what it did in a toast in the same words. A taken name is
 * the server's 409 and is shown at the field.
 */
export function LineDialog({ line, lines, canMergeOrDelete, onMove, onClose }: LineDialogProps) {
  const { t } = useTranslation('mapEditor');
  const { notify } = useToast();
  const update = useUpdateCompartment();
  const merge = useMergeCompartment();
  const remove = useDeleteCompartment();
  const peeringsQuery = useCompartmentPeerings();

  const [name, setName] = useState(line.label);
  const [nameError, setNameError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [mergeInto, setMergeInto] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'merge' | 'delete' | null>(null);

  const editable = lines.filter((candidate) => candidate.id !== null);
  const position = editable.findIndex((candidate) => candidate.key === line.key);
  const others = editable.filter((candidate) => candidate.key !== line.key);
  const target = others.find((candidate) => candidate.id === mergeInto) ?? null;
  const dropped = peeringsOfLine(line, peeringsQuery.data ?? [], lines);

  const run = async (action: () => Promise<unknown>, onError?: (error: unknown) => void) => {
    setFailure(null);
    try {
      await action();
      return true;
    } catch (error) {
      if (onError) onError(error);
      else setFailure(errorText(t, error));
      return false;
    }
  };

  const rename = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t('lineMenu.nameRequired'));
      return;
    }
    if (trimmed === line.label) return;
    setNameError(null);
    const done = await run(
      () => update.mutateAsync({ id: line.id!, name: trimmed }),
      (error) => (isNameInUse(error) ? setNameError(errorText(t, error)) : setFailure(errorText(t, error)))
    );
    if (done) {
      notify(t('toast.renamed'), { tone: 'success' });
      onClose();
    }
  };

  const recolour = async (colour: LineColour | null) => {
    if (colour === (line.colourChosen ? line.colour : null)) return;
    const done = await run(() => update.mutateAsync({ id: line.id!, line_colour: colour }));
    if (done) {
      notify(t('toast.recoloured'), { tone: 'success' });
      onClose();
    }
  };

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => !open && onClose()}
        title={t('lineMenu.title', { name: line.label })}
        description={t('lineMenu.description')}
        footer={<Button onClick={onClose}>{t('lineMenu.close')}</Button>}
      >
        <div className="space-y-6">
          {!line.isDefault && (
            <form
              className="flex items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void rename();
              }}
            >
              <FormField label={t('lineMenu.name')} error={nameError} className="min-w-0 flex-1">
                <Input
                  value={name}
                  maxLength={64}
                  autoComplete="off"
                  onChange={(event) => {
                    setName(event.target.value);
                    setNameError(null);
                  }}
                />
              </FormField>
              <Button type="submit" loading={update.isPending}>
                {t('lineMenu.rename')}
              </Button>
            </form>
          )}

          <div className="space-y-1.5">
            <p className="text-body font-medium text-ink">{t('lineMenu.colour')}</p>
            <p className="text-caption text-ink-muted">{t('lineMenu.colourHint')}</p>
            <ColourSwatches
              value={line.colourChosen ? line.colour : null}
              onChange={(colour) => void recolour(colour)}
              label={t('lineMenu.colour')}
              allowAutomatic
              automaticColour={line.colour}
              disabled={update.isPending}
              selectOnArrow={false}
            />
          </div>

          <div className="space-y-1.5">
            <p className="text-body font-medium text-ink">{t('lineMenu.order')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                icon={ArrowUp}
                disabled={position <= 0}
                onClick={() => void onMove(line.key, -1)}
                aria-label={t('lineMenu.up')}
              >
                {t('lineMenu.up')}
              </Button>
              <Button
                icon={ArrowDown}
                disabled={position < 0 || position >= editable.length - 1}
                onClick={() => void onMove(line.key, 1)}
                aria-label={t('lineMenu.down')}
              >
                {t('lineMenu.down')}
              </Button>
              <p role="status" className="text-caption text-ink-muted">
                {t('lineMenu.position', { position: position + 1, total: editable.length })}
              </p>
            </div>
          </div>

          {canMergeOrDelete && (
            <div className="space-y-2 border-t border-rule pt-4">
              {line.isDefault ? (
                <p className="text-caption text-ink-muted">{t('lineMenu.deleteDefault')}</p>
              ) : (
                <>
                  <fieldset className="space-y-1.5">
                    <legend className="text-body font-medium text-ink">{t('lineMenu.merge')}</legend>
                    {others.length === 0 ? (
                      <p className="text-caption text-ink-muted">{t('lineMenu.mergeNone')}</p>
                    ) : (
                      <>
                        <div role="radiogroup" aria-label={t('lineMenu.mergeInto')} className="space-y-1">
                          {others.map((other) => (
                            <label key={other.key} className="flex min-h-8 items-center gap-2 text-body text-ink">
                              <input
                                type="radio"
                                name={`merge-into-${line.key}`}
                                checked={mergeInto === other.id}
                                onChange={() => setMergeInto(other.id)}
                              />
                              {other.label}
                            </label>
                          ))}
                        </div>
                        <Button disabled={!target} onClick={() => setConfirming('merge')}>
                          {t('lineMenu.mergeAction')}
                        </Button>
                      </>
                    )}
                  </fieldset>
                  <div>
                    <Button variant="danger" onClick={() => setConfirming('delete')}>
                      {t('lineMenu.deleteAction')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {failure && (
            <p role="alert" className="border-l-2 border-danger pl-3 text-body text-ink">
              {failure}
            </p>
          )}
        </div>
      </Dialog>

      {confirming === 'merge' && target && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(null)}
          title={t('merge.title', { from: line.label, into: target.label })}
          description={t('merge.description', { from: line.label, into: target.label })}
          confirmLabel={t('merge.confirm')}
          tone="danger"
          busy={merge.isPending}
          onConfirm={async () => {
            const ok = await run(async () => {
              const result = await merge.mutateAsync({ id: line.id!, into: target.id! });
              const count = result.dropped_peerings.count;
              notify(
                count > 0
                  ? t('toast.mergedDropped', { count, into: target.label })
                  : t('toast.merged', { into: target.label }),
                { tone: 'success' }
              );
            });
            setConfirming(null);
            if (ok) onClose();
          }}
        >
          <div className="space-y-2 text-body text-ink" data-testid="merge-consequences">
            <p>{t('merge.devices', { count: line.stations.length, into: target.label })}</p>
            <p>
              {dropped.count === 0
                ? t('merge.droppedNone')
                : t('merge.dropped', { count: dropped.count, peers: listPeers(dropped.peers) })}
            </p>
          </div>
        </ConfirmDialog>
      )}

      {confirming === 'delete' && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(null)}
          title={t('delete.title', { name: line.label })}
          description={t('delete.description')}
          confirmLabel={t('delete.confirm')}
          tone="danger"
          busy={remove.isPending}
          onConfirm={async () => {
            const ok = await run(() => remove.mutateAsync(line.id!));
            setConfirming(null);
            if (ok) {
              notify(t('toast.deleted'), { tone: 'success' });
              onClose();
            }
          }}
        >
          <div className="space-y-2 text-body text-ink" data-testid="delete-consequences">
            <p>{t('delete.devices', { count: line.stations.length })}</p>
            <p>
              {dropped.count === 0
                ? t('merge.droppedNone')
                : t('merge.dropped', { count: dropped.count, peers: listPeers(dropped.peers) })}
            </p>
          </div>
        </ConfirmDialog>
      )}
    </>
  );
}
