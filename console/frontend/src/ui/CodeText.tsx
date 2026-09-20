import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';
import { IconButton } from './IconButton';

export interface CodeTextProps {
  /** The exact string: an overlay address, a public key, a node identifier. */
  children: string;
  /** Adds a copy button. The value copied is the string, never the truncated form. */
  copyable?: boolean;
  /** Shortens the middle, keeping both ends, for keys that do not fit a column. */
  truncate?: boolean;
  className?: string;
}

function shorten(value: string, head = 10, tail = 6): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Machine-readable text. Mono, so that 0 and O and l and 1 are distinguishable,
 * and selectable as one unit.
 */
export function CodeText({ children, copyable = false, truncate = false, className }: CodeTextProps) {
  const { t } = useTranslation('ui');
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the text stays selectable by hand.
      setCopied(false);
    }
  }, [children]);

  return (
    <span className={cn('inline-flex max-w-full items-center gap-1.5', className)}>
      <code
        title={truncate ? children : undefined}
        className="min-w-0 truncate rounded-sm bg-surface-sunken px-1.5 py-0.5 font-mono text-caption text-content"
      >
        {truncate ? shorten(children) : children}
      </code>
      {copyable && (
        <>
          <IconButton
            icon={copied ? Check : Copy}
            label={t('code.copy')}
            size="sm"
            onClick={copy}
            className={cn(copied && 'text-success')}
          />
          {/* Announced on copy: the icon change alone is invisible to a reader. */}
          <span role="status" aria-live="polite" className="sr-only">
            {copied ? t('code.copied') : ''}
          </span>
        </>
      )}
    </span>
  );
}
