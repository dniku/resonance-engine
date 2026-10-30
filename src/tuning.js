import { SCALES } from './constants.js';
import { clamp } from './mathx.js';
import { degreeToMidi, midiToFreq, freqToMidi } from './music.js';

/**
 * Turn musical parameters into one frequency per grid position along the pitch
 * axis: cell `i` maps to position i/(cells-1) of the scale, so `octaves` is
 * literally "how many octaves does the canvas cover?".
 */
export function buildFrequencyRamp({ cells, octaves, scaleName, rootOffset }) {
  const ramp = new Float64Array(cells);
  const spread = degreesForOctaves(octaves, scaleName);
  for (let i = 0; i < cells; i++) {
    const position = cells > 1 ? i / (cells - 1) : 0;
    ramp[i] = midiToFreq(degreeToMidi(position * spread, scaleName, rootOffset));
  }
  return ramp;
}

/** Number of scale degrees spanned by `octaves` over `cells` positions. */
export function degreesForOctaves(octaves, scaleName) {
  return octaves * SCALES[scaleName].length;
}

/**
 * Simulation firing rate (cycles per second of engine time) for a normalized
 * position: low positions crawl and are heard as drones, high ones race as
 * ticks. Three decades plus an octave per `octaves` keeps every setting both
 * step-able and audible.
 */
export function rateForPosition(position, octaves) {
  const decades = 3 + Math.log2(Math.max(1, octaves));
  return Math.pow(2, -decades / 2 + clamp(position, 0, 1) * decades);
}

export { freqToMidi };
