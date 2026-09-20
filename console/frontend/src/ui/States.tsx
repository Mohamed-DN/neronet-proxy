import { AlertCircle, CircleOff, Construction, Inbox, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';
import { Button } from './Button';

/*
 * The four surfaces a page shows when it has no data to show. Their copy and
 * their colour are fixed here so that "nothing yet", "it broke", "never
 * measured" and "not built" cannot blur into one another page by page.
 */

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Number of placeholder lines. */
  lines?: number;
}

/**
 * The shape of the content while it loads. Marked aria-hidden and paired with
 * a live region by the caller: a reader should hear "loading", not a count of
 * grey rectangles.
 */
export function Skeleton({ lines = 1, className, ...props }: SkeletonProps) {
  return (
    <div aria-hidden="true" className={cn('flex flex-col gap-2', className)} {...props}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-4 w-full animate-pulse-subtle rounded-sm bg-surface-sunken" />
      ))}
    </div>
  );
}

interface StateSurfaceProps {
  icon: LucideIcon;
  title: string;
  body?: React.ReactNode;
  tone: 'muted' | 'danger' | 'info';
  action?: React.ReactNode;
  className?: string;
  role?: React.AriaRole;
}

const TONE_ICON = {
  muted: 'text-muted',
  danger: 'text-danger',
  info: 'text-info'
} as const;

function StateSurface({ icon: Icon, title, body, tone, action, className, role }: StateSurfaceProps) {
  return (
    <div
      role={role}
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-border',
        'px-6 py-10 text-center',
        className
      )}
    >
      <Icon aria-hidden="true" className={cn('h-6 w-6', TONE_ICON[tone])} />
      <p className="text-body font-medium text-content">{title}</p>
      {body && <div className="max-w-prose text-caption text-subtle">{body}</div>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

export interface EmptyStateProps {
  title?: string;
  body?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

/** The query succeeded and there is nothing. Not an error, not a gap. */
export function EmptyState({ title, body, action, className }: EmptyStateProps) {
  const { t } = useTranslation('ui');
  return (
    <StateSurface
      icon={Inbox}
      tone="muted"
      title={title ?? t('empty.title')}
      body={body ?? t('empty.body')}
      action={action}
      className={className}
    />
  );
}

export interface ErrorStateProps {
  title?: string;
  body?: React.ReactNode;
  /** The failure itself. Shown verbatim: an operator needs the real message. */
  detail?: string | null;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({ title, body, detail, onRetry, className }: ErrorStateProps) {
  const { t } = useTranslation('ui');
  return (
    <StateSurface
      icon={AlertCircle}
      tone="danger"
      role="alert"
      title={title ?? t('error.title')}
      body={
        <>
          <p>{body ?? t('error.body')}</p>
          {detail && <p className="mt-2 break-words font-mono text-micro text-muted">{detail}</p>}
        </>
      }
      action={onRetry && <Button onClick={onRetry}>{t('error.retry')}</Button>}
      className={className}
    />
  );
}

export interface NotImplementedStateProps {
  title?: string;
  body?: React.ReactNode;
  /** Names the flag that would turn the feature on, when there is one. */
  flag?: string;
  className?: string;
}

/**
 * The feature is absent or its flag is off. Distinct from empty: there is no
 * data because nothing produces any, and no amount of waiting will change that.
 */
export function NotImplementedState({ title, body, flag, className }: NotImplementedStateProps) {
  const { t } = useTranslation('ui');
  return (
    <StateSurface
      icon={Construction}
      tone="muted"
      title={title ?? t('notImplemented.title')}
      body={
        <>
          <p>{body ?? t('notImplemented.body')}</p>
          {flag && <p className="mt-2 font-mono text-micro text-muted">{flag}</p>}
        </>
      }
      className={className}
    />
  );
}

export interface NotMeasuredProps {
  /** Inline variant for a table cell or a sentence. */
  inline?: boolean;
  className?: string;
}

/** The value exists in the system and has never been reported. */
export function NotMeasured({ inline = true, className }: NotMeasuredProps) {
  const { t } = useTranslation('ui');
  if (!inline) {
    return (
      <StateSurface
        icon={CircleOff}
        tone="info"
        title={t('state.notMeasured')}
        body={t('notMeasured.explain')}
        className={className}
      />
    );
  }
  return (
    <span
      data-state="not-measured"
      title={t('notMeasured.explain')}
      className={cn('inline-flex items-center gap-1 text-caption text-info', className)}
    >
      <CircleOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      {t('state.notMeasured')}
    </span>
  );
}
