import { SCALES, STEPS_PER_OCTAVE, BASE_MIDI, NOTE_NAMES } from './constants.js';

/** Equal-tempered frequency for a MIDI note number. */
export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function freqToMidi(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

/** Semitone offset (0..11) of `steps` above A440, for chromatic readouts. */
export function midiToChromaticStep(midi) {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/**
 * Semitone offset of a note name (0..11), the inverse of the name an offset
 * would be displayed as. Parsing is case-insensitive and `b`-style accidentals
 * are accepted, since this is the one place a name becomes a number.
 */
export function noteNameToOffset(name) {
  const normalised = String(name).trim().toUpperCase().replace(/B#/g, 'C');
  const index = NOTE_NAMES.indexOf(normalised);
  if (index < 0) throw new RangeError(`unknown note name: ${name}`);
  return index;
}

export function midiToName(midi) {
  const n = Math.round(midi);
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/**
 * Continuous scale degree -> MIDI. Degree is measured in scale steps, so an
 * octave is exactly `scale.length` degrees and every scale covers the same
 * `octaves` of range for a given degree span. Fractional degrees glide within
 * a step, so a sweeping gesture is a portamento through the scale rather than
 * a chromatic slide. `stepsPerOctave` only supplies the default scale length
 * for scales the table does not define.
 */
export function degreeToMidi(degree, scaleName, rootOffset, stepsPerOctave = STEPS_PER_OCTAVE) {
  const scale = SCALES[scaleName];
  if (!scale) throw new RangeError(`unknown scale: ${scaleName}`);
  const length = scale.length;
  const octave = Math.floor(degree / length);
  const wrapped = ((degree % length) + length) % length;
  const index = Math.floor(wrapped);
  const fraction = wrapped - index;
  // Above the last degree there is no next tone, so glide up to the octave.
  const next = index === length - 1 ? 12 : scale[index + 1];
  return BASE_MIDI + rootOffset + octave * 12 + scale[index] + (next - scale[index]) * fraction;
}

/**
 * Snap a degree to the nearest scale tone. Whole degrees are exactly the scale
 * tones under `degreeToMidi`, so rounding keeps the quantiser consistent with
 * the same map instead of inventing its own.
 */
export function quantizeDegree(degree) {
  return Math.round(degree);
}

