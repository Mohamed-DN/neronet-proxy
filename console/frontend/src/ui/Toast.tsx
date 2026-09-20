import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from './cn';
import { IconButton } from './IconButton';

export type ToastTone = 'info' | 'success' | 'danger';

export interface Toast {
  id: string;
  message: string;
  tone: ToastTone;
  /** Milliseconds before it disappears. `null` keeps it until dismissed. */
  timeout: number | null;
}

interface ToastContextValue {
  toasts: Toast[];
  notify: (message: string, options?: { tone?: ToastTone; timeout?: number | null }) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  danger: AlertCircle
};

const TONES: Record<ToastTone, string> = {
  info: 'border-info/40 text-info',
  success: 'border-success/40 text-success',
  danger: 'border-danger/40 text-danger'
};

/**
 * Transient messages and the live region that announces them.
 *
 * Failures are assertive and never time out on their own: an operator who
 * missed "the revocation failed" has to be told, and has to be able to read it
 * again. Confirmations are polite and fade.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback<ToastContextValue['notify']>(
    (message, options) => {
      const tone = options?.tone ?? 'info';
      const timeout = options?.timeout === undefined ? (tone === 'danger' ? null : 5000) : options.timeout;
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((current) => [...current, { id, message, tone, timeout }]);
      if (timeout !== null) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), timeout)
        );
      }
      return id;
    },
    [dismiss]
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  const value = useMemo(() => ({ toasts, notify, dismiss }), [toasts, notify, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastRegion toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside a ToastProvider');
  return value;
}

function ToastRegion({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  const { t } = useTranslation('ui');
  const polite = toasts.filter((toast) => toast.tone !== 'danger');
  const assertive = toasts.filter((toast) => toast.tone === 'danger');

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-toast flex w-full max-w-sm flex-col gap-2">
      <ToastList toasts={assertive} live="assertive" onDismiss={onDismiss} closeLabel={t('dialog.close')} />
      <ToastList toasts={polite} live="polite" onDismiss={onDismiss} closeLabel={t('dialog.close')} />
    </div>
  );
}

function ToastList({
  toasts,
  live,
  onDismiss,
  closeLabel
}: {
  toasts: Toast[];
  live: 'polite' | 'assertive';
  onDismiss: (id: string) => void;
  closeLabel: string;
}) {
  return (
    <div aria-live={live} aria-atomic="false" className="flex flex-col gap-2">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.tone];
        return (
          <div
            key={toast.id}
            role={toast.tone === 'danger' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-card border bg-surface-raised p-3 shadow-overlay',
              TONES[toast.tone]
            )}
          >
            <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="min-w-0 flex-1 break-words text-body text-content">{toast.message}</p>
            <IconButton icon={X} label={closeLabel} size="sm" onClick={() => onDismiss(toast.id)} />
          </div>
        );
      })}
    </div>
  );
}
