import * as RadixTabs from '@radix-ui/react-tabs';

import { cn } from './cn';

export interface TabItem {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
  content: React.ReactNode;
  /** Shown after the label: a count, a status. */
  badge?: React.ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  /** Names the tab list for a screen reader. */
  label: string;
  className?: string;
}

/**
 * Radix Tabs, for the roving tab index: one stop in the page's tab order, and
 * the arrow keys move between tabs. That is what the pattern requires and what
 * a row of buttons does not do.
 */
export function Tabs({ items, value, onValueChange, label, className }: TabsProps) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange} className={cn('flex flex-col gap-4', className)}>
      <RadixTabs.List aria-label={label} className="flex items-center gap-1 border-b border-border">
        {items.map((item) => (
          <RadixTabs.Trigger
            key={item.value}
            value={item.value}
            disabled={item.disabled}
            className={cn(
              '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-body font-medium',
              'transition-colors focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50',
              'border-transparent text-muted hover:text-content',
              'data-[state=active]:border-accent data-[state=active]:text-accent'
            )}
          >
            {item.label}
            {item.badge}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>

      {items.map((item) => (
        <RadixTabs.Content key={item.value} value={item.value} className="focus-visible:outline-focus">
          {item.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
