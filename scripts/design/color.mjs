/*
 * Colour maths for the design token checks. No dependencies.
 *
 * Two things are computed here:
 *  - WCAG 2.1 relative luminance and contrast ratio, for the text and
 *    user-interface targets;
 *  - CIE L*a*b* distance under normal vision and under simulated dichromacy,
 *    for the categorical chart palette. A contrast ratio says nothing about
 *    whether two series can be told apart, and two colours that differ only in
 *    hue can collapse onto the same colour for a dichromat.
 *
 * The dichromacy simulation is Vienot, Brettel and Mollon (1999): project the
 * colour onto the plane of the remaining two cone responses in LMS space.
 */

const SRGB_TO_LMS = [
  [17.8824, 43.5161, 4.11935],
  [3.45565, 27.1554, 3.86714],
  [0.0299566, 0.184309, 1.46709]
];

const LMS_TO_SRGB = [
  [0.080944448, -0.130504409, 0.116721066],
  [-0.010248534, 0.054019327, -0.113614708],
  [-0.000365297, -0.004121615, 0.693511405]
];

const DICHROMACY = {
  protanopia: [
    [0, 2.02344, -2.52581],
    [0, 1, 0],
    [0, 0, 1]
  ],
  deuteranopia: [
    [1, 0, 0],
    [0.494207, 0, 1.24827],
    [0, 0, 1]
  ],
  tritanopia: [
    [1, 0, 0],
    [0, 1, 0],
    [-0.395913, 0.801109, 0]
  ]
};

function apply(matrix, [a, b, c]) {
  return matrix.map((row) => row[0] * a + row[1] * b + row[2] * c);
}

function toLinear(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function toGamma(linear) {
  const c = Math.min(1, Math.max(0, linear));
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

export function relativeLuminance([r, g, b]) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function simulate(rgb, kind) {
  const matrix = DICHROMACY[kind];
  if (!matrix) throw new Error(`unknown colour vision deficiency: ${kind}`);
  const linear = rgb.map(toLinear);
  const lms = apply(SRGB_TO_LMS, linear);
  const projected = apply(matrix, lms);
  return apply(LMS_TO_SRGB, projected).map(toGamma);
}

/* sRGB (D65) to CIE L*a*b*. */
export function toLab(rgb) {
  const [r, g, b] = rgb.map(toLinear);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/* CIE76 distance. Coarser than CIEDE2000 but the threshold used here is far
 * above the region where the two disagree, and it has no tuning constants. */
export function deltaE(a, b) {
  const la = toLab(a);
  const lb = toLab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

export const VISION = ['normal', 'protanopia', 'deuteranopia', 'tritanopia'];

export function asSeen(rgb, vision) {
  return vision === 'normal' ? rgb : simulate(rgb, vision);
}

export function hex([r, g, b]) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
