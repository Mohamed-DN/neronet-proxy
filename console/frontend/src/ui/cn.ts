import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Joins class names and lets a later one win over an earlier one for the same
 * Tailwind property, so a caller can pass `className="px-6"` to a component
 * whose default is `px-3` without the two fighting in the stylesheet.
 */
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}
