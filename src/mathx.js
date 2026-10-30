/** Deterministic 32-bit PRNG (mulberry32). Same seed, same sequence. */
export function makeRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TAU = Math.PI * 2;

export function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

/** Wrap into [0, span). Used for toroidal grid indices and phase angles. */
export function wrap(value, span) {
  const r = value % span;
  return r < 0 ? r + span : r;
}

/**
 * Fold a phase difference into [-half, half) so coupling takes the short way
 * round and never spins backwards. The interval is half-open on the upper end,
 * which is what `wrap` already guarantees; a difference of exactly `half` is
 * equidistant either way and resolves to `-half` by convention.
 */
export function wrapHalf(value, half) {
  const span = half * 2;
  return wrap(value + half, span) - half;
}

export const lerp = (a, b, t) => a + (b - a) * t;
