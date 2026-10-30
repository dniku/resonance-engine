// Finite choices for the engine. Kept as enums so the UI cannot invent a
// string the simulation does not understand.

/** How a cell's natural frequency is derived from its position. */
export const FreqMap = {
  Horizontal: 'horizontal',
  Vertical: 'vertical',
  Diagonal: 'diagonal',
  Radial: 'radial',
  Uniform: 'uniform',
};

/** Which axis drives pitch when conducting with the pointer. */
export const PlayMode = {
  Horizontal: 'horizontal',
  Vertical: 'vertical',
  Both: 'both',
};

/** Preset colour moods for the field. */
export const Palette = {
  Ember: 'ember',
  Abyss: 'abyss',
  Verdant: 'verdant',
  Mono: 'mono',
};

export const STEPS_PER_OCTAVE = 12;

/**
 * The generative scales: subsets of the 12 chromatic semitone positions.
 * Degrees are semitone offsets so callers never re-derive intervals.
 */
export const SCALES = {
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  hirajoshi: [0, 2, 3, 7, 8],
  prometheus: [0, 2, 6, 9, 10],
};

export const SCALE_NAMES = Object.keys(SCALES);

/** Root note names, offered in cycle order by the ROOT control. */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI note number of degree 0 at the grid's lowest register. */
export const BASE_MIDI = 48;

/** One beat, in seconds, at the current tempo. */
export const BEAT_SECONDS_AT_100 = 0.6;
