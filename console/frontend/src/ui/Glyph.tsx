/** The wordmark's glyph: a line with a station at each end, the far one "you are here". */
export function Glyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" className="shrink-0">
      <path
        d="M5 20h6l6-12h6"
        fill="none"
        stroke="rgb(var(--color-ink))"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="5" cy="20" r="3" fill="rgb(var(--color-plate))" stroke="rgb(var(--color-ink))" strokeWidth="2" />
      <circle cx="23" cy="8" r="3.25" fill="rgb(var(--color-signal))" stroke="rgb(var(--color-ink))" strokeWidth="2" />
    </svg>
  );
}
