/**
 * Class lists for Radix menus (the top bar's task groups and the account menu).
 * A menu is a plate that floats, so it carries the one overlay shadow, and the
 * entry that has focus draws the two-tone ring from `.option-ring` in index.css:
 * the hover tint on its own is 1.1:1 against the plate.
 */
export const MENU_CONTENT =
  'min-w-56 rounded-plate border border-border bg-plate p-1 text-body text-ink shadow-overlay';

export const MENU_ITEM =
  'option-ring flex min-h-11 cursor-default xl:min-h-0 select-none items-center gap-2 rounded-control px-3 py-2 text-body text-ink outline-none hover:bg-surface-hover focus-visible:bg-surface-hover';
