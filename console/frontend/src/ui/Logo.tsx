import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useState } from 'react';

import './Allaccio.css';
import { cn } from './cn';
import { prefersReducedMotion } from './motion';

/*
 * The NeroNet mark: the N drawn as a transit line (up, a 45 degree diagonal, up
 * again) with a terminus at each end. The lower one is a ring, the upper one is
 * filled with the signal yellow: "you are here". Geometry and rules are in
 * docs/brand/BRAND.md; the static files in public/brand/ are the same drawing.
 */

export type LogoSize = 'sm' | 'md' | 'lg' | 'xl' | number;

/** The mark's box in px for each named size. */
const SIZES = { sm: 20, md: 28, lg: 40, xl: 72 } as const;

/** At this size or below the lower ring is dropped and the stroke thickened. */
export const SMALL_MARK_MAX_PX = 24;

/** The wordmark's em, as a share of the mark's box. The mark is 1.3 x the cap height. */
const WORD_EM_PER_MARK = 0.8;

export interface LogoProps {
  size?: LogoSize;
  /** Draws "NeroNet" beside the mark. */
  wordmark?: boolean;
  /** The surface the logo sits on, which fills the lower ring. */
  ground?: 'sheet' | 'plate';
  /** Hides the logo from assistive technology, for when a label beside it already says NeroNet. */
  decorative?: boolean;
  className?: string;
  /** `allaccio`: the mark switches on once when it mounts (the hook-up). The default is the still mark. */
  animate?: 'allaccio';
  /** Called when the animation has finished (at once under reduced motion). */
  onDone?: () => void;
  /** Time scale of the animation: 1 is about 1.9 s, 0.75 is faster. */
  speed?: number;
}

/** Plays the animation again, for the moment that earns it. */
export interface LogoHandle {
  replay: () => void;
}

/** The whole animation, to its last glow, at speed 1. */
export const ALLACCIO_MS = 2430;
/** When the lamp has finished lighting, at speed 1: the moment "done" means. */
export const ALLACCIO_LIT_MS = 1830;

export function logoPixels(size: LogoSize): number {
  return typeof size === 'number' ? size : SIZES[size];
}

/** The mark alone, at `px` pixels, switching to the small variant at or below 24. */
export function LogoMark({
  px,
  ground = 'sheet',
  title
}: {
  px: number;
  ground?: 'sheet' | 'plate';
  /** Set for a mark that stands alone; leave out when text beside it names the product. */
  title?: string;
}) {
  const small = px <= SMALL_MARK_MAX_PX;
  const ink = 'rgb(var(--color-ink))';
  return (
    <svg
      width={px}
      height={px}
      viewBox="0 0 48 48"
      className="shrink-0"
      data-logo-variant={small ? 'small' : 'full'}
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      <path
        d="M12 39V13l24 24V9"
        fill="none"
        stroke={ink}
        strokeWidth={small ? 7.5 : 5.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {!small && <circle cx="12" cy="39" r="4.6" fill={`rgb(var(--color-${ground}))`} stroke={ink} strokeWidth="2.6" />}
      <circle cx="36" cy="9" r={small ? 5.2 : 4.6} fill="rgb(var(--color-signal))" stroke={ink} strokeWidth="2.6" />
    </svg>
  );
}

/** The mark playing Allaccio. Same geometry as LogoMark; `runKey` restarts it. */
function AllaccioMark({
  px,
  ground,
  title,
  runKey,
  speed
}: {
  px: number;
  ground: 'sheet' | 'plate';
  title?: string;
  runKey: number;
  speed: number;
}) {
  const small = px <= SMALL_MARK_MAX_PX;
  const ink = 'rgb(var(--color-ink))';
  const signal = 'rgb(var(--color-signal))';
  const gradient = useId();
  const wire = 'M12 39V13l24 24V9';
  return (
    <svg
      key={runKey}
      width={px}
      height={px}
      viewBox="0 0 48 48"
      className="allaccio shrink-0"
      style={{ ['--allaccio-k' as string]: speed }}
      data-logo-variant={small ? 'small' : 'full'}
      data-allaccio="playing"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      <defs>
        <radialGradient id={gradient}>
          <stop offset="0" stopColor={signal} stopOpacity=".9" />
          <stop offset="1" stopColor={signal} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle className="al-glow" cx="36" cy="9" r="11" fill={`url(#${gradient})`} />
      <path
        className="al-wire"
        d={wire}
        fill="none"
        stroke={ink}
        strokeWidth={small ? 7.5 : 5.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="al-current"
        d={wire}
        fill="none"
        stroke={signal}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {!small && (
        <circle
          className="al-start"
          cx="12"
          cy="39"
          r="4.6"
          fill={`rgb(var(--color-${ground}))`}
          stroke={ink}
          strokeWidth="2.6"
        />
      )}
      <circle className="al-spark" cx="36" cy="9" r="5" fill="none" stroke={signal} strokeWidth="1.4" />
      <g stroke={signal} strokeWidth="1.6" strokeLinecap="round">
        <path className="al-ray" d="M36 1.5v-3" />
        <path className="al-ray" d="M43.5 9h3" />
        <path className="al-ray" d="M41.3 3.7l2.1-2.1" />
        <path className="al-ray" d="M30.7 3.7l-2.1-2.1" />
      </g>
      <circle className="al-lamp" cx="36" cy="9" r={small ? 5.2 : 4.6} stroke={ink} strokeWidth="2.6" />
    </svg>
  );
}

/**
 * The mark with an optional wordmark. Its accessible name is "NeroNet"; ink
 * follows the theme through the tokens, so it is right on sheet, plate and night.
 */
export const Logo = forwardRef<LogoHandle, LogoProps>(function Logo(
  { size = 'md', wordmark = false, ground = 'sheet', decorative = false, className, animate, onDone, speed = 1 },
  ref
) {
  const px = logoPixels(size);
  const [runKey, setRunKey] = useState(0);
  const playing = animate === 'allaccio';
  useImperativeHandle(ref, () => ({ replay: () => setRunKey((n) => n + 1) }), []);

  // "Done" is when the lamp is lit; under reduced motion the mark is already in its final state.
  const done = useCallback(() => onDone?.(), [onDone]);
  useEffect(() => {
    if (!playing) return;
    if (prefersReducedMotion()) {
      done();
      return;
    }
    const timer = window.setTimeout(done, ALLACCIO_LIT_MS * speed);
    return () => window.clearTimeout(timer);
  }, [playing, runKey, speed, done]);

  const mark = (title?: string) =>
    playing ? (
      <AllaccioMark px={px} ground={ground} title={title} runKey={runKey} speed={speed} />
    ) : (
      <LogoMark px={px} ground={ground} title={title} />
    );

  if (!wordmark) {
    return (
      <span className={cn('inline-flex shrink-0', className)} {...(decorative ? { 'aria-hidden': true } : {})}>
        {mark(decorative ? undefined : 'NeroNet')}
      </span>
    );
  }

  return (
    <span
      className={cn('inline-flex items-center text-ink', className)}
      style={{ gap: `${px * WORD_EM_PER_MARK * 0.35}px` }}
      {...(decorative ? { 'aria-hidden': true } : {})}
    >
      {mark()}
      <span
        className="font-extrabold leading-none"
        style={{ fontSize: `${px * WORD_EM_PER_MARK}px`, letterSpacing: '-0.01em', fontWeight: 800 }}
      >
        {'NeroNet'}
      </span>
    </span>
  );
});
