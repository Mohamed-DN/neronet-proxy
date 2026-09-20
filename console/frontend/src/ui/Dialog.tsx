import { useRef } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Read out with the title. Say what the dialog is for, not how to close it. */
  description?: string;
  /** Footer actions, end-aligned. The primary action goes last. */
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  children?: React.ReactNode;
  className?: string;
}

const SIZES = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl'
} as const;

/**
 * Built on Radix Dialog: focus moves into the dialog when it opens, stays
 * inside it while it is open, Escape closes it, and focus returns to whatever
 * opened it. The console's own modals did none of that, which left a keyboard
 * operator tabbing through the page behind an open overlay.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  size = 'md',
  children,
  className
}: DialogProps) {
  const { t } = useTranslation('ui');

  /*
   * Where focus came from, so it can be put back.
   *
   * Read during the render in which `open` turns true, because by the time an
   * effect of this component runs the dialog's own content has already mounted
   * and taken focus. Radix's automatic restore does not fire reliably here, and
   * an operator who opened a dialog from the keyboard must not be dropped back
   * onto the document body when it closes.
   */
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(open);
  if (open && !wasOpen.current) {
    openerRef.current = document.activeElement as HTMLElement | null;
  }
  wasOpen.current = open;

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-overlay bg-scrim/60" />
        <RadixDialog.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            openerRef.current?.focus();
          }}
          className={cn(
            'fixed left-1/2 top-1/2 z-overlay w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2',
            'rounded-card border border-border bg-surface-raised shadow-overlay',
            'max-h-[calc(100vh-4rem)] overflow-y-auto',
            SIZES[size],
            className
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border-subtle p-4">
            <div className="min-w-0">
              <RadixDialog.Title className="text-heading font-semibold text-content">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-caption text-subtle">
                  {description}
                </RadixDialog.Description>
              ) : (
                <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close
              aria-label={t('dialog.close')}
              className="rounded-control p-1 text-muted transition-colors hover:bg-surface-hover hover:text-content focus-visible:outline-focus"
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </RadixDialog.Close>
          </div>

          {children && <div className="p-4">{children}</div>}

          {footer && <div className="flex justify-end gap-2 border-t border-border-subtle p-4">{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
