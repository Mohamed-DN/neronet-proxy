import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * The few pieces of state that belong to the shell rather than to a page.
 *
 * The enrolment dialog is opened from the header and from the node matrix, and
 * the armed self-destruct has to be visible in the sidebar on every page, which
 * is why both outlive any one route. Everything else a page needs, it fetches.
 */

const NUKE_ARMED_KEY = 'nukeArmed';
const NUKE_SCHEDULED_KEY = 'nukeScheduledAt';

export interface ShellValue {
  enrollOpen: boolean;
  openEnroll: () => void;
  closeEnroll: () => void;
  nukeArmed: boolean;
  nukeScheduledAt: string | null;
  armNuke: (scheduledAt?: string | null) => void;
  disarmNuke: () => void;
}

const ShellContext = createContext<ShellValue | null>(null);

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function ShellProvider({ children }: { children: React.ReactNode }) {
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [nukeArmed, setNukeArmed] = useState(() => readStored(NUKE_ARMED_KEY) === 'true');
  const [nukeScheduledAt, setNukeScheduledAt] = useState<string | null>(() => readStored(NUKE_SCHEDULED_KEY));

  useEffect(() => {
    try {
      window.localStorage.setItem(NUKE_ARMED_KEY, String(nukeArmed));
      if (nukeScheduledAt) window.localStorage.setItem(NUKE_SCHEDULED_KEY, nukeScheduledAt);
      else window.localStorage.removeItem(NUKE_SCHEDULED_KEY);
    } catch {
      // The armed state still applies to this tab. It is a reminder in the
      // sidebar, not the switch itself: the control plane holds that.
    }
  }, [nukeArmed, nukeScheduledAt]);

  const armNuke = useCallback((scheduledAt: string | null = null) => {
    setNukeArmed(true);
    setNukeScheduledAt(scheduledAt);
  }, []);

  const disarmNuke = useCallback(() => {
    setNukeArmed(false);
    setNukeScheduledAt(null);
  }, []);

  const value = useMemo<ShellValue>(
    () => ({
      enrollOpen,
      openEnroll: () => setEnrollOpen(true),
      closeEnroll: () => setEnrollOpen(false),
      nukeArmed,
      nukeScheduledAt,
      armNuke,
      disarmNuke
    }),
    [enrollOpen, nukeArmed, nukeScheduledAt, armNuke, disarmNuke]
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellValue {
  const ctx = useContext(ShellContext);
  if (!ctx) {
    throw new Error('useShell must be used within a ShellProvider');
  }
  return ctx;
}
