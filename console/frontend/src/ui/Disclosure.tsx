import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { cn } from './cn';

export interface DisclosureProps {
  /** What the trigger button shows. */
  trigger: React.ReactNode;
  triggerClassName?: string;
  /** Names the trigger when its content is an icon or an avatar. */
  triggerLabel?: string;
  /** Set on the trigger when the page it opens is the current one. */
  triggerCurrent?: boolean;
  /**
   * `menu`: a list of links and actions, as in site navigation. The arrow keys
   * move through it and choosing an entry closes it.
   * `dialog`: a small panel that holds content, named by `panelLabel`; focus
   * moves into it when it opens.
   */
  kind?: 'menu' | 'dialog';
  panelLabel?: string;
  panelClassName?: string;
  align?: 'start' | 'end';
  children: React.ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled])';

/**
 * A button that shows and hides a panel: the WAI-ARIA disclosure pattern, which
 * is the one for a navigation menu of links (role="menu" is for application
 * menus). It is small on purpose: the Radix menu and popover it replaces cost
 * 27 KB gzip in the entry chunk for what is, here, a toggle, a list, Escape and
 * a click outside.
 *
 *  - Enter, Space or a click opens and closes it; focus stays on the trigger.
 *  - ArrowDown opens it and moves to the first entry; the arrow keys, Home and
 *    End move through the entries.
 *  - Escape closes it, wherever focus is, and returns focus to the trigger.
 *  - A click outside, or tabbing out of it, closes it without taking focus
 *    from where the person went.
 *  - Choosing an entry closes it and leaves focus to the page it leads to.
 *
 * The keyboard, focus-out and click handling are native listeners on the root
 * element, not JSX handlers: the root is a wrapper, not a control.
 */
export function Disclosure({
  trigger,
  triggerClassName,
  triggerLabel,
  triggerCurrent,
  kind = 'menu',
  panelLabel,
  panelClassName,
  align = 'start',
  children
}: DisclosureProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const enterOnOpen = useRef(false);

  const entries = useCallback(() => [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])], []);

  // A dialog takes focus when it opens. A menu keeps it on the trigger until an
  // arrow key moves it, and then the effect moves it to the first entry once the
  // panel is in the document.
  useEffect(() => {
    if (!open) return;
    if (kind === 'dialog') panel.current?.focus();
    else if (enterOnOpen.current) entries()[0]?.focus();
    enterOnOpen.current = false;
  }, [open, kind, entries]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;

    const moveTo = (index: number) => {
      const list = entries();
      if (list.length > 0) list[(index + list.length) % list.length]?.focus();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (kind !== 'menu') return;
      const list = entries();
      const at = list.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!open) {
          enterOnOpen.current = true;
          setOpen(true);
        } else moveTo(at === -1 ? 0 : at + 1);
      } else if (open && event.key === 'ArrowUp') {
        event.preventDefault();
        moveTo(at === -1 ? list.length - 1 : at - 1);
      } else if (open && at !== -1 && event.key === 'Home') {
        event.preventDefault();
        moveTo(0);
      } else if (open && at !== -1 && event.key === 'End') {
        event.preventDefault();
        moveTo(list.length - 1);
      }
    };

    // Tabbing out of the trigger and the panel closes it; a click inside it,
    // which also blurs, does not.
    const onFocusOut = (event: FocusEvent) => {
      if (open && !element.contains(event.relatedTarget as Node | null)) setOpen(false);
    };

    // Choosing a link or an action closes a menu. Focus is left alone: the page
    // the link leads to moves it to its own heading.
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element;
      if (kind === 'menu' && panel.current?.contains(target) && target.closest(FOCUSABLE)) setOpen(false);
    };

    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('focusout', onFocusOut);
    element.addEventListener('click', onClick);
    return () => {
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('focusout', onFocusOut);
      element.removeEventListener('click', onClick);
    };
  }, [open, kind, entries]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    // Escape works wherever focus is, not only inside the panel: Safari does not
    // focus a button on click, so a menu opened with the mouse has no focus in it.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const active = document.activeElement;
      setOpen(false);
      if (!active || active === document.body || root.current?.contains(active)) button.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={triggerLabel}
        aria-current={triggerCurrent ? 'true' : undefined}
        onClick={() => setOpen((value) => !value)}
        className={triggerClassName}
      >
        {trigger}
      </button>

      {open && (
        <div
          ref={panel}
          id={id}
          role={kind === 'dialog' ? 'dialog' : undefined}
          aria-label={kind === 'dialog' ? panelLabel : undefined}
          // Focusable so that a click on a gap in the panel keeps focus inside it.
          tabIndex={-1}
          className={cn(
            'absolute top-full z-popover mt-2 outline-none',
            align === 'end' ? 'right-0' : 'left-0',
            panelClassName
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}
