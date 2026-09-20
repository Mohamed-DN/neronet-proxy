/**
 * A short identifier for one failure.
 *
 * It exists so an operator can quote something when reporting a broken page and
 * an engineer can find the matching `console.error` in the browser log. It is
 * not a correlation id the server knows about, and it carries nothing from the
 * error itself.
 */
export function newErrorId(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(16).slice(2);
  return random.slice(0, 8).toUpperCase();
}

/**
 * Puts the failure where an engineer can read it and nowhere else.
 *
 * The screen gets the identifier and nothing more. A stack trace on a console
 * used by a bank names internal paths and module layout, and an error thrown
 * from the request layer can carry a URL with a token in it.
 */
export function reportError(id: string, error: unknown): void {
  console.error(`console error ${id}`, error);
}
