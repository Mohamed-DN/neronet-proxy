import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Read out with the title. */
  description?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * A sheet that rises from the bottom edge: the phone's menu for a group of
 * pages and for the secondary actions of a page. Radix Dialog underneath, so
 * focus is trapped while it is open, Escape and a tap on the scrim close it and
 * focus returns to what opened it. Its content clears the home indicator.
 */
export function BottomSheet({ open, onOpenChange, title, description, children, className }: BottomSheetProps) {
  const { t } = useTranslation('ui');

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-overlay bg-scrim/60" />
        <RadixDialog.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-overlay flex max-h-[85dvh] flex-col rounded-t-plate border border-b-0 border-border',
            'bg-plate shadow-overlay',
            className
          )}
        >
          <div className="flex items-center justify-between gap-4 border-b border-border-subtle py-2 pl-4 pr-2">
            <div className="min-w-0">
              <RadixDialog.Title className="text-lead font-semibold text-ink">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="text-caption text-ink-muted">{description}</RadixDialog.Description>
              ) : (
                <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close
              aria-label={t('dialog.close')}
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:outline-focus"
            >
              <X aria-hidden="true" className="h-5 w-5" />
            </RadixDialog.Close>
          </div>
          <div className="overflow-y-auto p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
