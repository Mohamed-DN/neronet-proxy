import type { LineColour } from '../services/types';

/*
 * The tint of the live-flow pulse on each line. The pulse is drawn over the line at 0.85
 * opacity, and the pair has to hold 3:1 in both themes. Signal yellow over a dark line
 * (blue, violet, green) reads as muddy olive and over orange or sky it vanishes, so the
 * pulse is a light tint where the line is dark and a dark tint where the line is light.
 *
 * The table is checked against tokens.css by pulseTone.test.ts and the same pairs are gated
 * in scripts/design/contrast.mjs; change all three together.
 */
export type PulseTone = 'light' | 'dark';

export const PULSE_TONE: Readonly<Record<LineColour, PulseTone>> = {
  red: 'light',
  green: 'light',
  blue: 'light',
  orange: 'dark',
  violet: 'light',
  sky: 'dark'
};

/** The pulse's opacity where it travels (the peak of the animation). */
export const PULSE_OPACITY = 0.85;

export function pulseTone(colour: LineColour): PulseTone {
  return PULSE_TONE[colour];
}
