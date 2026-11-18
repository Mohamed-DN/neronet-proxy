import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../ui/Button';
import { Dialog } from '../../../ui/Dialog';
import { FormField } from '../../../ui/FormField';
import { Input } from '../../../ui/Input';
import { useToast } from '../../../ui/Toast';
import { usePreviewSplit, useSplitCompartment } from '../../../services/queries';
import type { LineColour } from '../../../services/types';
import { ColourSwatches } from './ColourSwatches';
import type { EditorLine } from './editorModel';
import { listPeers } from './editorModel';
import { errorText, isNameInUse } from './errors';
import { PreviewList } from './PreviewList';

export interface SplitDialogProps {
  /** The line the devices are cut from. */
  source: EditorLine;
  /** The devices to cut, all on `source`. */
  ids: string[];
  /** Closes the dialog. `created` is set when the line was cut. */
  onClose: (created?: { id: string; name: string; ids: string[] }) => void;
}

/**
 * "Taglia in una nuova linea": a name and a colour, the server's what-if for the devices
 * (who they gain and lose, and the peerings the new line does not inherit), then the cut.
 */
export function SplitDialog({ source, ids, onClose }: SplitDialogProps) {
  const { t } = useTranslation('mapEditor');
  const { notify } = useToast();
  const [name, setName] = useState('');
  const [colour, setColour] = useState<LineColour | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const preview = usePreviewSplit();
  const split = useSplitCompartment();

  const { mutate: runPreview } = preview;
  const idsKey = ids.join('\u0000');
  useEffect(() => {
    if (source.id) runPreview({ id: source.id, nodeIds: ids });
    // `ids` is read through its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.id, idsKey, runPreview]);

  const submitSplit = async () => {
    const trimmed = name.trim();
    setFailure(null);
    if (!trimmed) {
      setNameError(t('lineMenu.nameRequired'));
      return;
    }
    if (!source.id) return;
    setNameError(null);
    try {
      const result = await split.mutateAsync({
        id: source.id,
        name: trimmed,
        nodeIds: ids,
        ...(colour ? { lineColour: colour } : {})
      });
      notify(t('toast.split', { name: result.compartment.name }), { tone: 'success' });
      onClose({ id: result.compartment.id, name: result.compartment.name, ids });
    } catch (error) {
      if (isNameInUse(error)) setNameError(errorText(t, error));
      else setFailure(errorText(t, error));
    }
  };

  const inherited = preview.data?.peerings_not_inherited;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('split.title')}
      description={t('split.description', { from: source.label })}
      footer={
        <>
          <Button onClick={() => onClose()}>{t('cancel')}</Button>
          <Button
            variant="primary"
            disabled={!preview.isSuccess}
            loading={split.isPending}
            onClick={() => void submitSplit()}
          >
            {t('split.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label={t('split.name')} error={nameError}>
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
        <div className="space-y-1.5">
          <p className="text-body font-medium text-ink">{t('split.colour')}</p>
          <ColourSwatches value={colour} onChange={setColour} label={t('split.colour')} allowAutomatic />
        </div>

        <div className="space-y-3 border-t border-rule pt-3">
          {preview.isPending && (
            <p role="status" className="text-body text-ink-muted">
              {t('move.loading')}
            </p>
          )}
          {preview.isError && (
            <div role="alert" className="space-y-2">
              <p className="text-body text-ink">{t('move.error', { message: errorText(t, preview.error) })}</p>
              <Button size="sm" onClick={() => source.id && runPreview({ id: source.id, nodeIds: ids })}>
                {t('move.retry')}
              </Button>
            </div>
          )}
          {preview.data && <PreviewList preview={preview.data} />}
          {inherited && (
            <p className="text-body text-ink" data-testid="peerings-not-inherited">
              {inherited.count === 0
                ? t('split.notInheritedNone', { from: source.label })
                : t('split.notInherited', {
                    count: inherited.count,
                    from: source.label,
                    peers: listPeers(inherited.peers)
                  })}
            </p>
          )}
        </div>
        {failure && (
          <p role="alert" className="border-l-2 border-danger pl-3 text-body text-ink">
            {failure}
          </p>
        )}
      </div>
    </Dialog>
  );
}
