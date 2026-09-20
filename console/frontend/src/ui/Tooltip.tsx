import * as RadixTooltip from '@radix-ui/react-tooltip';

import { cn } from './cn';

export interface TooltipProps {
  /**
   * Extra detail about the trigger. Never the only place a fact appears: a
   * tooltip is unreachable on a touch screen and easy to miss anywhere else.
   */
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}

/** Wraps the console once so every tooltip shares one delay and one provider. */
export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={200} skipDelayDuration={300}>
      {children}
    </RadixTooltip.Provider>
  );
}

export function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-popover max-w-xs rounded-control bg-surface-inverse px-2 py-1',
            'text-caption text-content-inverse shadow-popover',
            className
          )}
        >
          {content}
          <RadixTooltip.Arrow className="fill-surface-inverse" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
