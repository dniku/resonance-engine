import { Palette } from './constants.js';

/**
 * Colour ramps for the field. Each stop is [t, r, g, b] in 0..255; the ramp is
 * sampled by a cell's brightness, so a palette change is a pure look change
 * with no effect on the physics or the music.
 */
const RAMPS = {
  [Palette.Ember]: [
    [0, 8, 6, 18],
    [0.32, 74, 20, 64],
    [0.58, 176, 46, 60],
    [0.8, 246, 138, 42],
    [1, 255, 240, 196],
  ],
  [Palette.Abyss]: [
    [0, 3, 5, 16],
    [0.3, 12, 44, 96],
    [0.55, 26, 122, 168],
    [0.78, 82, 214, 214],
    [1, 240, 255, 255],
  ],
  [Palette.Verdant]: [
    [0, 6, 12, 10],
    [0.36, 22, 82, 58],
    [0.62, 96, 164, 60],
    [0.84, 214, 226, 96],
    [1, 252, 255, 232],
  ],
  [Palette.Mono]: [
    [0, 4, 4, 6],
    [0.45, 44, 46, 54],
    [0.78, 150, 154, 162],
    [1, 255, 255, 255],
  ],
};

export const PALETTE_NAMES = Object.keys(RAMPS);

/** Build a 256-entry lookup table (Uint8ClampedArray rgb triples). */
export function buildLut(name) {
  const stops = RAMPS[name] ?? RAMPS[Palette.Abyss];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let upper = stops.length - 1;
    while (upper > 1 && stops[upper][0] > t) upper--;
    const [t0, r0, g0, b0] = stops[upper];
    const [t1, r1, g1, b1] = stops[Math.min(stops.length - 1, upper + 1)];
    const span = t1 - t0 || 1;
    const f = Math.min(1, Math.max(0, (t - t0) / span));
    lut[i * 3] = r0 + (r1 - r0) * f;
    lut[i * 3 + 1] = g0 + (g1 - g0) * f;
    lut[i * 3 + 2] = b0 + (b1 - b0) * f;
  }
  return lut;
}
