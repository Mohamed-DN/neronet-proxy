import { useEffect, useRef } from 'react';
import { ArrowLeft, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';
import { Dialog, type DialogProps } from './Dialog';
import { IconButton } from './IconButton';
import { StickyActionBar } from './StickyActionBar';
import { useLayoutSize } from './useLayoutSize';

export interface ResponsiveDetailProps {
  /** Whether an item is selected. The page owns this, normally from the address. */
  open: boolean;
  /** Called by the dialog's close, the panel's close and the phone's back button. */
  onClose: () => void;
  /** The selected item's name. */
  title: string;
  description?: string;
  /** The list or table. It stays on screen on a desktop and a tablet. */
  list: React.ReactNode;
  /** Above the list (counts, filters): hidden on a phone while a detail is open. */
  lead?: React.ReactNode;
  /** Actions of the detail. A bar above the tab bar on a phone, the dialog footer on a desktop. */
  footer?: React.ReactNode;
  /** Shown in the tablet's detail column while nothing is selected. */
  placeholder?: React.ReactNode;
  dialogSize?: DialogProps['size'];
  /** The detail itself. */
  children: React.ReactNode;
}

/**
 * One list, three ways to open an item from it (docs/design/DIRECTION-2026-11.md).
 *
 *  - desktop: the list, and the item in a dialog over it, as before.
 *  - tablet: master-detail. The list on the left (about 40%), the item on the
 *    right in the same view, no modal.
 *  - phone: the list; choosing a row replaces it with the item full-screen and a
 *    back button.
 *
 * It does not own the selection. The page decides what is open (a route such as
 * /nodes/:id, so the address stays the source of truth and the browser's back
 * button works) and passes `open` and `onClose`.
 */
export function ResponsiveDetail({
  open,
  onClose,
  title,
  description,
  list,
  lead,
  footer,
  placeholder,
  dialogSize = 'lg',
  children
}: ResponsiveDetailProps) {
  const { t } = useTranslation('ui');
  const size = useLayoutSize();
  const heading = useRef<HTMLHeadingElement>(null);

  // When an item opens beside or over the list, a reader and a keyboard follow
  // it: focus goes to its heading. Not on a desktop, where the dialog does that.
  useEffect(() => {
    if (!open || size === 'desktop') return;
    // After the page's own focus move (PageFrame runs after this effect, on a route change).
    const frame = requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open, size]);

  if (size === 'desktop') {
    return (
      <>
        {lead}
        {list}
        <Dialog
          open={open}
          onOpenChange={(next) => {
            if (!next) onClose();
          }}
          title={title}
          description={description}
          size={dialogSize}
          footer={footer}
        >
          {children}
        </Dialog>
      </>
    );
  }

  const header = (
    <>
      <h2
        ref={heading}
        tabIndex={-1}
        className="min-w-0 flex-1 truncate text-title font-semibold text-ink outline-none focus-visible:shadow-none"
      >
        {title}
      </h2>
      {description && <span className="sr-only">{description}</span>}
    </>
  );

  if (size === 'tablet') {
    return (
      <>
        {lead}
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-4">
          <div className="min-w-0">{list}</div>
          <aside
            data-detail-pane=""
            aria-label={open ? title : undefined}
            className="sticky top-[calc(var(--top-bar-height,5rem)+1rem)] max-h-[calc(100dvh-var(--top-bar-height,5rem)-2rem)] min-w-0 overflow-y-auto rounded-card border border-border bg-plate"
          >
            {open ? (
              <>
                <div className="sticky top-0 z-sticky flex items-center gap-2 border-b border-border-subtle bg-plate py-2 pl-4 pr-2">
                  {header}
                  <IconButton icon={X} label={t('dialog.close')} onClick={onClose} />
                </div>
                <div className="p-4">{children}</div>
                {footer && <div className="flex justify-end gap-2 border-t border-border-subtle p-4">{footer}</div>}
              </>
            ) : (
              <div className="p-6 text-center text-body text-ink-muted">{placeholder}</div>
            )}
          </aside>
        </div>
      </>
    );
  }

  // Phone.
  if (!open) {
    return (
      <>
        {lead}
        {list}
      </>
    );
  }

  return (
    <section aria-label={title} data-detail-screen="">
      <div
        className={cn(
          'sticky top-[var(--top-bar-height,0px)] z-sticky -mx-4 mb-4 flex items-center gap-1 border-b border-rule bg-sheet px-2 py-1'
        )}
      >
        <IconButton icon={ArrowLeft} label={t('detail.back')} onClick={onClose} />
        {header}
      </div>
      {children}
      {footer && <StickyActionBar>{footer}</StickyActionBar>}
    </section>
  );
}
