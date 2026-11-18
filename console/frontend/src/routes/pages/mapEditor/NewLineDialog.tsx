import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Checkbox';
import { Dialog } from '../../../ui/Dialog';
import { FormField } from '../../../ui/FormField';
import { Input } from '../../../ui/Input';
import { useToast } from '../../../ui/Toast';
import { useCreateCompartment } from '../../../services/queries';
import type { LineColour } from '../../../services/types';
import { ColourSwatches } from './ColourSwatches';
import type { EditorLine } from './editorModel';
import { errorText, isNameInUse } from './errors';

export interface NewLineDialogProps {
  lines: EditorLine[];
  /** Devices already chosen on the map: they start ticked. */
  preselected: string[];
  /** Closes the dialog. `created` carries the new line and the devices to move onto it (the move is previewed next). */
  onClose: (created?: { id: string; name: string; ids: string[] }) => void;
}

/** "Nuova linea": a name and a colour, and optionally devices to move onto it. */
export function NewLineDialog({ lines, preselected, onClose }: NewLineDialogProps) {
  const { t } = useTranslation('mapEditor');
  const { notify } = useToast();
  const create = useCreateCompartment();
  const [name, setName] = useState('');
  const [colour, setColour] = useState<LineColour | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(preselected));
  const [nameError, setNameError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = name.trim();
    setFailure(null);
    if (!trimmed) {
      setNameError(t('lineMenu.nameRequired'));
      return;
    }
    setNameError(null);
    try {
      const line = await create.mutateAsync({ name: trimmed, ...(colour ? { lineColour: colour } : {}) });
      notify(t('toast.created', { name: line.name }), { tone: 'success' });
      onClose({ id: line.id, name: line.name, ids: [...picked] });
    } catch (error) {
      if (isNameInUse(error)) setNameError(errorText(t, error));
      else setFailure(errorText(t, error));
    }
  };

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const withDevices = lines.filter((line) => line.stations.length > 0);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t('create.title')}
      description={t('create.description')}
      footer={
        <>
          <Button onClick={() => onClose()}>{t('cancel')}</Button>
          <Button variant="primary" loading={create.isPending} onClick={() => void submit()}>
            {t('create.confirm')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormField label={t('create.name')} error={nameError}>
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
          <p className="text-body font-medium text-ink">{t('create.colour')}</p>
          <ColourSwatches value={colour} onChange={setColour} label={t('create.colour')} allowAutomatic />
        </div>
        {withDevices.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-body font-medium text-ink">{t('create.devices')}</legend>
            <p className="text-caption text-ink-muted">{t('create.devicesHint')}</p>
            <div className="max-h-48 space-y-3 overflow-y-auto rounded-control border border-rule p-2">
              {withDevices.map((line) => (
                <div key={line.key}>
                  <p className="text-caption font-semibold text-ink">{line.label}</p>
                  <ul>
                    {line.stations.map((station) => (
                      <li key={station.id}>
                        <Checkbox
                          label={station.name}
                          checked={picked.has(station.id)}
                          onChange={() => toggle(station.id)}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </fieldset>
        )}
        {failure && (
          <p role="alert" className="border-l-2 border-danger pl-3 text-body text-ink">
            {failure}
          </p>
        )}
      </form>
    </Dialog>
  );
}
