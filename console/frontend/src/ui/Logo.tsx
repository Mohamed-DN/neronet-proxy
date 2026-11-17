import { cn } from './cn';

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
}

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

/**
 * The mark with an optional wordmark. Its accessible name is "NeroNet"; ink
 * follows the theme through the tokens, so it is right on sheet, plate and night.
 */
export function Logo({ size = 'md', wordmark = false, ground = 'sheet', decorative = false, className }: LogoProps) {
  const px = logoPixels(size);

  if (!wordmark) {
    return (
      <span className={cn('inline-flex shrink-0', className)} {...(decorative ? { 'aria-hidden': true } : {})}>
        <LogoMark px={px} ground={ground} title={decorative ? undefined : 'NeroNet'} />
      </span>
    );
  }

  return (
    <span
      className={cn('inline-flex items-center text-ink', className)}
      style={{ gap: `${px * WORD_EM_PER_MARK * 0.35}px` }}
      {...(decorative ? { 'aria-hidden': true } : {})}
    >
      <LogoMark px={px} ground={ground} />
      <span
        className="font-extrabold leading-none"
        style={{ fontSize: `${px * WORD_EM_PER_MARK}px`, letterSpacing: '-0.01em', fontWeight: 800 }}
      >
        {'NeroNet'}
      </span>
    </span>
  );
}
