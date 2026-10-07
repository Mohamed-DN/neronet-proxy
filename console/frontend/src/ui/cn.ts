import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Keep the semantic sizes from tailwind.config.js separate from text colours.
// Without this, text-caption removes text-accent-contrast from primary buttons.
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'caption', 'label', 'body', 'heading', 'title', 'display', 'metric'] }]
    }
  }
});

/**
 * Joins class names and lets a later one win over an earlier one for the same
 * Tailwind property, so a caller can pass `className="px-6"` to a component
 * whose default is `px-3` without the two fighting in the stylesheet.
 */
export function cn(...values: ClassValue[]): string {
  return merge(clsx(values));
}
