import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from './Button';
import { Dialog } from './Dialog';
import { FormField } from './FormField';
import { Input } from './Input';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What will happen, in plain words, including what cannot be undone. */
  description: string;
  /**
   * When present, the confirm button stays disabled until the operator types
   * this exact string. Use it for anything that destroys data or keys.
   */
  confirmPhrase?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for destructive actions, which is what the phrase is for. */
  tone?: 'primary' | 'danger';
  onConfirm: () => void;
  busy?: boolean;
  children?: React.ReactNode;
}

/**
 * Confirmation for an action that cannot be taken back.
 *
 * A dialog with a Confirm button is a speed bump; typing the name of the thing
 * being destroyed is a decision. The phrase is compared exactly, and the button
 * carries no default focus, so Enter on an open dialog does not destroy
 * anything.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmPhrase,
  confirmLabel,
  cancelLabel,
  tone = 'primary',
  onConfirm,
  busy = false,
  children
}: ConfirmDialogProps) {
  const { t } = useTranslation('ui');
  const [typed, setTyped] = useState('');

  // A phrase typed for one node must not carry over to the next dialog.
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const satisfied = !confirmPhrase || typed === confirmPhrase;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{cancelLabel ?? t('dialog.cancel')}</Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            disabled={!satisfied}
            loading={busy}
            onClick={onConfirm}
          >
            {confirmLabel ?? t('dialog.confirm')}
          </Button>
        </>
      }
    >
      {children}
      {confirmPhrase && (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-caption text-content">
            <Trans
              i18nKey="confirm.prompt"
              ns="ui"
              values={{ phrase: confirmPhrase }}
              components={[<span key="0" />, <code key="1" className="font-mono text-danger" />]}
            />
          </p>
          <FormField label={t('confirm.label')} error={typed.length > 0 && !satisfied ? t('confirm.mismatch') : null}>
            <Input
              mono
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </FormField>
        </div>
      )}
    </Dialog>
  );
}
