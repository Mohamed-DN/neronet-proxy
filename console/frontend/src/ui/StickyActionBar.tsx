import { cn } from './cn';
import { useLayoutSize } from './useLayoutSize';

export interface StickyActionBarProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Where a page's primary action lives. On a desktop and a tablet it is an
 * ordinary row of buttons where it is placed. On a phone it is a bar fixed above
 * the tab bar, so the one thing the page is for stays under the thumb however far
 * the page is scrolled; each button shares the width.
 *
 * The shell sets `--bottom-nav-height` to the tab bar's height and leaves room
 * for this bar under the page; outside the shell it is 0 and the bar sits on the
 * bottom edge.
 */
export function StickyActionBar({ children, className }: StickyActionBarProps) {
  const size = useLayoutSize();

  if (size !== 'phone') {
    return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
  }

  return (
    <div
      data-sticky-actions=""
      style={{ bottom: 'var(--bottom-nav-height, 0px)' }}
      className={cn(
        'fixed inset-x-0 z-sticky flex items-center gap-2 border-t border-rule bg-plate px-4 py-3',
        '[&>*]:min-w-0 [&>*]:flex-1',
        className
      )}
    >
      {children}
    </div>
  );
}
