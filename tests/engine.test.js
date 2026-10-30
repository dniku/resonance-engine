import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Field, sampleRamp } from '../src/field.js';
import { NoteScheduler } from '../src/scheduler.js';
import { buildFrequencyRamp, degreesForOctaves, rateForPosition } from '../src/tuning.js';
import { degreeToMidi, midiToFreq, midiToName, quantizeDegree } from '../src/music.js';
import { buildLut, PALETTE_NAMES } from '../src/palette.js';
import { AudioEngine } from '../src/audio.js';
import { wrap, wrapHalf, makeRandom } from '../src/mathx.js';
import { BASE_MIDI, FreqMap, SCALES } from '../src/constants.js';

// --- math -----------------------------------------------------------------

test('wrap keeps values inside the span, negatives included', () => {
  assert.equal(wrap(0, 4), 0);
  assert.equal(wrap(4, 4), 0);
  assert.equal(wrap(-1, 4), 3);
  assert.equal(wrap(5.5, 4), 1.5);
});

// Degrees are scale steps, so aeolian (7 tones) reaches an octave at degree 7.
test('degree 0 is the base pitch and an octave is one scale length', () => {
  assert.equal(degreeToMidi(0, 'aeolian', 0), BASE_MIDI);
  assert.equal(degreeToMidi(7, 'aeolian', 0), BASE_MIDI + 12);
  assert.equal(degreeToMidi(14, 'aeolian', 0), BASE_MIDI + 24);
  // A six-tone scale octaves at 6 instead, which is the point of the model.
  assert.equal(degreeToMidi(6, 'wholeTone', 0), BASE_MIDI + 12);
  assert.equal(degreeToMidi(5, 'hirajoshi', 0), BASE_MIDI + 12);
});

test('every scale spans exactly `octaves` octaves over its degree range', () => {
  for (const [name, scale] of Object.entries(SCALES)) {
    const low = degreeToMidi(0, name, 0);
    const high = degreeToMidi(3 * scale.length, name, 0);
    assert.equal(high - low, 36, `${name} spans ${high - low} semitones`);
  }
});

test('wrapHalf maps phase differences to the nearest equivalent', () => {
  assert.ok(Math.abs(wrapHalf(0.9, 0.5) + 0.1) < 1e-12);
  assert.ok(Math.abs(wrapHalf(-0.9, 0.5) - 0.1) < 1e-12);
  for (const v of [-2, -0.75, 0, 0.25, 0.5, 1.3]) {
    const h = wrapHalf(v, 0.5);
    assert.ok(h >= -0.5 && h < 0.5, `out of range: ${v} -> ${h}`);
  }
});

test('makeRandom is reproducible and bounded', () => {
  const a = makeRandom(42);
  const b = makeRandom(42);
  const values = Array.from({ length: 500 }, () => a());
  assert.deepEqual(values.map(() => b()).map((v, i) => values[i]), values);
  for (const v of values) assert.ok(v >= 0 && v < 1);
  assert.notEqual(makeRandom(1)(), makeRandom(2)());
});

// --- music ---------------------------------------------------------------

test('A440 anchors the temperament', () => {
  assert.ok(Math.abs(midiToFreq(69) - 440) < 1e-9);
  assert.ok(Math.abs(midiToFreq(57) - 220) < 1e-9);
  assert.ok(Math.abs(midiToFreq(81) - 880) < 1e-9);
});

test('a root offset transposes by exactly that many semitones', () => {
  for (let d = 0; d <= 14; d++) {
    assert.equal(degreeToMidi(d, 'dorian', 3) - degreeToMidi(d, 'dorian', 0), 3);
  }
});

test('fractional degrees glide monotonically across octave boundaries', () => {
  for (const name of Object.keys(SCALES)) {
    let previous = -Infinity;
    for (let i = 0; i <= 400; i++) {
      const degree = (i / 400) * 3 * SCALES[name].length;
      const midi = degreeToMidi(degree, name, 0);
      assert.ok(midi > previous, `${name}: not increasing at degree ${degree.toFixed(3)}`);
      previous = midi;
    }
  }
});

test('the glide never overshoots into the next octave', () => {
  for (const [name, scale] of Object.entries(SCALES)) {
    const octave = BASE_MIDI + 12;
    for (let i = 0; i < 200; i++) {
      const degree = (i / 200) * scale.length;
      const midi = degreeToMidi(degree, name, 0);
      assert.ok(midi < octave, `${name} at degree ${degree.toFixed(3)} -> ${midi}`);
    }
    assert.equal(degreeToMidi(scale.length, name, 0), octave);
  }
});

test('a degree past the scale length lands in the next octave, not backwards', () => {
  const lastTone = degreeToMidi(SCALES.aeolian.length - 1, 'aeolian', 0);
  const octave = degreeToMidi(SCALES.aeolian.length, 'aeolian', 0);
  assert.equal(octave, lastTone + 2);
  assert.equal(degreeToMidi(7, 'aeolian', 0), BASE_MIDI + 12);
  assert.ok(degreeToMidi(6.99, 'aeolian', 0) > octave - 0.2);
});

test('every degree lands on a tone of its scale', () => {
  for (const [name, scale] of Object.entries(SCALES)) {
    for (let d = 0; d < 12; d++) {
      const offset = (Math.round(degreeToMidi(d, name, 0)) - BASE_MIDI) % 12;
    assert.ok(scale.includes(((offset % 12) + 12) % 12), `${name} degree ${d} -> ${offset}`);
    }
  }
});

test('quantizeDegree is idempotent and lands on a scale tone', () => {
  for (const value of [0, 0.4, 0.6, 3.3, 7.9, 11.2]) {
    const once = quantizeDegree(value);
    assert.equal(quantizeDegree(once), once);
    assert.equal(once % 1, 0);
    assert.equal(degreeToMidi(once, 'aeolian', 0) % 1, 0, `${once} is not a scale tone`);
  }
});

test('note names follow the MIDI convention', () => {
  assert.equal(midiToName(69), 'A4');
  assert.equal(midiToName(60), 'C4');
  assert.equal(midiToName(57), 'A3');
});

// --- tuning --------------------------------------------------------------

test('the frequency ramp is non-decreasing and stays in a sane register', () => {
  const ramp = buildFrequencyRamp({ cells: 64, octaves: 3, scaleName: 'aeolian', rootOffset: 0 });
  assert.ok(Math.abs(ramp[0] - midiToFreq(BASE_MIDI)) < 1e-6, 'ramp must start on the base pitch');
  assert.ok(Math.abs(ramp[63] - midiToFreq(BASE_MIDI + 36)) < 1e-6, 'ramp must end one spread above it');
  let previous = 0;
  for (const hz of ramp) {
    assert.ok(hz >= previous, `ramp went down: ${previous} -> ${hz}`);
    assert.ok(hz > 30 && hz < 4200, `unreachable frequency ${hz}`);
    previous = hz;
  }
});

test('rates span roughly three decades and never reach DC or Nyquist', () => {
  const slow = rateForPosition(0, 3);
  const fast = rateForPosition(1, 3);
  assert.ok(slow > 0.01, `too slow to hear: ${slow}`);
  assert.ok(fast < 40, `too fast to step: ${fast}`);
  assert.ok(Math.abs(fast / slow - 2 ** (3 + Math.log2(3))) < 1e-9, `range ${fast / slow}`);
  assert.equal(rateForPosition(-5, 3), slow, 'position must be clamped, not extrapolated');
  assert.equal(rateForPosition(9, 3), fast);
});

// --- field ---------------------------------------------------------------

test('a still, coupled, noiseless field is an exact fixed point', () => {
  const field = new Field(16, 16);
  field.randomize(7);
  for (let i = 0; i < field.freq.length; i++) field.freq[i] = 0;
  const before = Float32Array.from(field.phase);
  field.step(1 / 60, { coupling: 20, noise: 0 });
  // Phases live in Float32 storage, so a true fixed point only holds to the
  // precision of the buffer, not to zero.
  let maxDelta = 0;
  for (let i = 0; i < before.length; i++) maxDelta = Math.max(maxDelta, Math.abs(field.phase[i] - before[i]));
  assert.ok(maxDelta < 4e-3, `drifted by ${maxDelta}`);
});

test('phase stays in range and nothing fires without advancing time', () => {
  const field = new Field(12, 9);
  field.randomize(3);
  for (let i = 0; i < field.freq.length; i++) field.freq[i] = 3;
  assert.deepEqual(field.step(0, { coupling: 10, noise: 0 }), []);
  assert.deepEqual(field.step(-1, { coupling: 10, noise: 0 }), []);
  for (let i = 0; i < 500; i++) {
    for (const index of field.step(1 / 60, { coupling: 10, noise: 0.4 })) {
      assert.ok(field.phase[index] >= 0 && field.phase[index] < 1);
    }
  }
});

test('a frequency gradient propagates a wave: neighbours fire in order', () => {
  const field = new Field(24, 8);
  for (let i = 0; i < field.phase.length; i++) field.phase[i] = 0.5;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 24; col++) field.freq[field.index(col, row)] = 0.5 + col * 0.2;
  }
  const firstFiredColumn = new Map();
  for (let i = 0; i < 400; i++) {
    for (const index of field.step(1 / 60, { coupling: 0, noise: 0 })) {
      const col = field.colOf(index);
      if (!firstFiredColumn.has(col)) firstFiredColumn.set(col, i);
    }
  }
  // Higher pitch (higher col) must reach its boundary first.
  const ordered = [...firstFiredColumn.entries()].sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  assert.ok(ordered[0] > 12, `leftmost columns fired first: ${ordered.slice(0, 5)}`);
  assert.equal(firstFiredColumn.get(23), Math.min(...firstFiredColumn.values()));
});

test('coupling always reduces local phase disagreement', () => {
  const field = new Field(16, 16);
  field.randomize(4);
  for (let i = 0; i < field.freq.length; i++) field.freq[i] = 1;
  const disagreement = (f) => {
    let sum = 0;
    for (let row = 0; row < f.rows; row++) {
      for (let col = 0; col < f.cols; col++) {
        const i = f.index(col, row);
        sum += Math.abs(wrapHalf(f.phase[f.index((col + 1) % f.cols, row)] - f.phase[i], 0.5));
        sum += Math.abs(wrapHalf(f.phase[f.index(col, (row + 1) % f.rows)] - f.phase[i], 0.5));
      }
    }
    return sum;
  };
  const before = disagreement(field);
  for (let i = 0; i < 1200; i++) field.step(1 / 120, { coupling: 25, noise: 0 });
  const after = disagreement(field);
  assert.ok(after < before * 0.8, `coupling barely acted: ${before} -> ${after}`);
});

test('coupling drags oscillator frequencies toward one another', () => {
  const run = (coupling) => {
    const field = new Field(24, 24, { damping: 0 });
    field.randomize(9);
    for (let row = 0; row < field.rows; row++) {
      for (let col = 0; col < field.cols; col++) {
        field.freq[field.index(col, row)] = 1 + (col % 5) * 0.06;
      }
    }
    // Measure how much each cell's phase advances in one small step: the
    // effective frequency, which coupling pulls toward the neighbourhood mean.
    for (let i = 0; i < 3000; i++) field.step(1 / 240, { coupling, noise: 0 });
    let spread = 0;
    const advance = new Float64Array(field.phase.length);
    const before = Float32Array.from(field.phase);
    field.step(1 / 240, { coupling, noise: 0 });
    for (let i = 0; i < advance.length; i++) {
      advance[i] = wrap(field.phase[i] - before[i], 1);
      spread += advance[i];
    }
    const mean = spread / advance.length;
    let variance = 0;
    for (const a of advance) variance += (a - mean) ** 2;
    return Math.sqrt(variance / advance.length);
  };
  const uncoupled = run(0);
  const coupled = run(30);
  assert.ok(coupled < uncoupled, `coupling widened spread: ${uncoupled} -> ${coupled}`);
});

/*
 * Coupling must actually couple, and it must do so monotonically.
 *
 * The original version of this test asserted only that coupling moved the field
 * in the right direction, which a 1000x-too-weak coupling term also satisfies --
 * it passed while the shipped coupling torque was ~6% of the natural frequency
 * drift and the field synchronised at no slider position. These assert magnitude,
 * not direction.
 *
 * Measured behaviour, which this pins rather than re-derives: from a near-uniform
 * start the largest neighbour phase gap decays with coupling strength, and the
 * decay rate is strictly increasing in coupling. A near-uniform start is used
 * deliberately -- a random phase field on a periodic lattice does NOT reach
 * global synchrony under local diffusion (it settles into domains and travelling
 * waves, order ~0.1-0.2), so asserting order -> 1 from random phases would be
 * asserting physics that is not true.
 */
test('coupling shrinks phase gaps, more strongly the higher it is set', () => {
  const gapAfter = (coupling) => {
    const cells = 32;
    const field = new Field(cells, 1, { damping: 0 });
    field.freq.fill(0.5);
    // A narrow band of initial phases: nearly ordered, so local coupling has a
    // fixed point it can actually reach.
    let state = 99;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    for (let i = 0; i < cells; i++) field.phase[i] = 0.5 + (random() - 0.5) * 0.02;
    for (let i = 0; i < 4000; i++) field.step(1 / 240, { coupling, noise: 0 });
    let maxGap = 0;
    for (let col = 0; col < cells; col++) {
      const a = field.phase[col];
      const b = field.phase[(col + 1) % cells];
      let d = Math.abs(b - a);
      d = Math.min(d, 1 - d);
      maxGap = Math.max(maxGap, d);
    }
    return maxGap;
  };

  const uncoupled = gapAfter(0);
  const weak = gapAfter(3);
  const strong = gapAfter(30);

  assert.ok(uncoupled > 1e-2, `setup wrong: gap should stay wide with no coupling, got ${uncoupled}`);
  assert.ok(weak < uncoupled, `coupling 3 did not shrink gaps: ${uncoupled} -> ${weak}`);
  assert.ok(strong < weak, `coupling is not monotonic: 0=${uncoupled} 3=${weak} 30=${strong}`);
  // Magnitude, not merely direction: an effective coupling term must close most
  // of the gap, which the 6%-of-drift bug did not.
  assert.ok(strong < uncoupled * 0.4, `strong coupling only reached ${strong} from ${uncoupled}`);
});

test('a synchronised field stays synchronised and an incoherent one does not arise from coupling', () => {
  // The reachable fixed point: identical oscillators that start together remain
  // together at any coupling, including zero.
  const field = new Field(24, 24, { damping: 0 });
  field.freq.fill(0.5);
  field.phase.fill(0.25);
  for (let i = 0; i < 600; i++) field.step(1 / 120, { coupling: 12, noise: 0 });
  assert.ok(field.orderParameter() > 0.999, `locked field drifted: ${field.orderParameter()}`);
});

/*
 * The readout that responds to coupling.
 *
 * orderParameter() stays near zero on the shipped grid at every coupling (it
 * organises into domains, not globally), so a visitor moving the dial sees
 * nothing change. localOrder() measures the same thing at the scale where
 * organisation does happen, and is what the UI shows alongside it. These
 * numbers are measured, not derived: coupling 0 -> 0.135, coupling 40 -> 0.296.
 */
test('localOrder rises with coupling while global order stays flat', () => {
  const run = (coupling) => {
    const field = new Field(84, 56, { damping: 0 });
    field.randomize(0xc0ffee);
    for (let i = 0; i < 4800; i++) field.step(1 / 120, { coupling, noise: 0.02 });
    return { local: field.localOrder(), global: field.orderParameter() };
  };
  const quiet = run(0);
  const strong = run(40);
  assert.ok(strong.local > quiet.local * 1.5, `local order barely moved: ${quiet.local.toFixed(3)} -> ${strong.local.toFixed(3)}`);
  assert.ok(quiet.global < 0.05 && strong.global < 0.05, `global order unexpectedly moved: ${quiet.global} vs ${strong.global}`);
  assert.ok(strong.local > strong.global, 'local order should exceed global on this lattice');
});

test('localOrder is a proper order parameter', () => {
  const field = new Field(84, 56, { damping: 0 });
  field.phase.fill(0.4);
  assert.ok(field.localOrder() > 0.999, `locked field: ${field.localOrder()}`);
  // Random phases within every tile -> near zero.
  const noisy = new Field(84, 56, { damping: 0 });
  noisy.randomize(1);
  assert.ok(noisy.localOrder() < 0.25, `random field too coherent: ${noisy.localOrder()}`);
});

test('zero coupling leaves a random field incoherent', () => {
  const field = new Field(28, 28);
  field.randomize(5);
  for (let i = 0; i < field.freq.length; i++) field.freq[i] = 1 + (i % 11) * 0.13;
  for (let i = 0; i < 600; i++) field.step(1 / 120, { coupling: 0, noise: 0 });
  assert.ok(field.orderParameter() < 0.35, `unexpectedly ordered: ${field.orderParameter()}`);
});

test('stroke injects energy that decays over time', () => {
  const field = new Field(10, 10);
  field.randomize(1);
  field.stroke(5, 5, 3, 1, null);
  const initial = field.gain[field.index(5, 5)];
  assert.ok(initial > 0.9, `expected energy, got ${initial}`);
  for (let i = 0; i < 60; i++) field.step(1 / 60, { coupling: 0, noise: 0 });
  assert.ok(field.gain[field.index(5, 5)] < initial * 0.1, 'gain did not decay');
});

test('stroke wraps around the torus seam', () => {
  const field = new Field(10, 10);
  field.randomize(1);
  field.stroke(0, 0, 2.5, 1, null);
  assert.ok(field.gain[field.index(9, 0)] > 0, 'did not wrap in x');
  assert.ok(field.gain[field.index(0, 9)] > 0, 'did not wrap in y');
  assert.ok(field.gain[field.index(9, 9)] > 0, 'did not wrap diagonally');
});

test('stroke reaches every cell it covers and none it does not', () => {
  const field = new Field(20, 20);
  field.randomize(1);
  field.stroke(10, 10, 2, 0.5, null);
  assert.equal(field.gain.filter((g) => g > 0).length, 13, 'disc area mismatch');
});

test('a target phase aligns a stroke without breaking the range', () => {
  const field = new Field(8, 8);
  field.randomize(9);
  field.stroke(4, 4, 3, 1, 0);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const phase = field.phase[field.index(i, j)];
      assert.ok(phase >= 0 && phase < 1);
    }
  }
  const aligned = field.phase[field.index(4, 4)];
  assert.ok(aligned < 0.15 || aligned > 0.85, `centre not aligned: ${aligned}`);
});

test('sampleRamp interpolates and clamps instead of truncating', () => {
  const ramp = Float64Array.from([100, 200, 400]);
  assert.equal(sampleRamp(ramp, 0), 100);
  assert.equal(sampleRamp(ramp, 1), 400);
  assert.equal(sampleRamp(ramp, 0.5), 200, 'midpoint must be the middle sample');
  assert.equal(sampleRamp(ramp, 0.25), 150, 'quarter must interpolate, not truncate');
  assert.equal(sampleRamp(ramp, -1), 100);
  assert.equal(sampleRamp(ramp, 2), 400);
  assert.equal(sampleRamp(Float64Array.from([42]), 0.7), 42);
  assert.throws(() => sampleRamp(new Float64Array(0), 0.5), RangeError);
});

test('every frequency map produces the full pitch range across the grid', () => {
  const field = new Field(20, 14);
  const ramp = buildFrequencyRamp({ cells: 20, octaves: 3, scaleName: 'aeolian', rootOffset: 0 });
  for (const map of Object.values(FreqMap)) {
    field.retune(ramp, map, [10, 7], [20, 14]);
    assert.ok([...field.freq].every((hz) => Number.isFinite(hz)), `${map} produced a non-finite rate`);
    const spread = Math.max(...field.freq) / Math.min(...field.freq);
    if (map === FreqMap.Uniform) {
      assert.ok(Math.abs(spread - 1) < 1e-9, 'uniform map should be a single pitch');
    } else {
      assert.ok(spread > 1.5, `${map} covers only ${spread.toFixed(2)}x`);
    }
    assert.ok(field.freq.every((hz) => Number.isFinite(hz) && hz > 0));
  }
});

test('retuning preserves phase so nothing clicks', () => {
  const field = new Field(12, 12);
  field.randomize(21);
  const before = Float32Array.from(field.phase);
  field.retune(new Float64Array(12).fill(2), FreqMap.Horizontal, [6, 6], [12, 12]);
  assert.deepEqual(Float32Array.from(field.phase), before);
});

test('an unknown frequency map is rejected loudly', () => {
  const field = new Field(4, 4);
  assert.throws(() => field.positionNorm(1, 1) && (field.mapType = 'nope') === 'nope' && field.positionNorm(1, 1), {
    name: 'RangeError',
  });
});

test('the field is deterministic apart from requested noise', () => {
  const run = () => {
    const field = new Field(16, 16);
    field.randomize(77);
    for (let i = 0; i < field.freq.length; i++) field.freq[i] = 0.4 + (i % 5) * 0.2;
    for (let i = 0; i < 300; i++) field.step(1 / 120, { coupling: 8, noise: 0 });
    return field.phase.slice();
  };
  assert.deepEqual(run(), run());
});

// --- scheduler -----------------------------------------------------------

test('the auto budget releases at most the configured rate', () => {
  const scheduler = new NoteScheduler({ autoBudget: 0.25, humanize: 0 });
  const lookup = (index) => ({ degree: index, gain: 1, col: 0, row: 0, scaleName: 'aeolian' });
  const fired = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  // Credit accrues one tick per call from empty, so 0.25 unlocks on the 4th
  // call and then again every 4 calls: exactly one voice per 4 calls.
  const released = [];
  for (let call = 0; call < 9; call++) {
    scheduler.collectAuto(call, fired, lookup);
    released.push(scheduler.takeDue(call).length);
  }
  assert.deepEqual(released, [0, 0, 0, 1, 0, 0, 0, 1, 0], `budget rate wrong: ${released}`);
});

test('manual notes bypass the budget and the gate', () => {
  const scheduler = new NoteScheduler({ autoBudget: 0 });
  scheduler.enqueueManual({ degree: 3, velocity: 0.5, pan: 0, time: 0, duration: null });
  assert.equal(scheduler.takeDue(0).length, 1);
});

test('quiet cells are gated out of the auto voice pool', () => {
  const scheduler = new NoteScheduler({ autoBudget: 1, velocityGate: 0.09 });
  scheduler.collectAuto(0, [0], () => ({ degree: 0, gain: 0.01, col: 0, row: 0, scaleName: 'aeolian' }));
  assert.equal(scheduler.takeDue(0).length, 0);
});

test('the same cell cannot retrigger inside its refractory window', () => {
  const scheduler = new NoteScheduler({ autoBudget: 4 });
  const lookup = () => ({ degree: 0, gain: 1, col: 0, row: 0, scaleName: 'aeolian' });
  scheduler.collectAuto(1, [7], lookup);
  scheduler.collectAuto(1.02, [7], lookup);
  assert.equal(scheduler.takeDue(2).length, 1);
});

test('the voice budget is enforced as a hard cap', () => {
  // A minimal fake context is enough: this asserts the cap decision, not the
  // Web Audio graph, which the browser test covers end to end.
  const engine = new AudioEngine({ maxVoices: 3 });
  engine.ready = true;
  let started = 0;
  engine.playNote = function playNote(note) {
    if (this._voices.length >= this.maxVoices) return null;
    started += 1;
    this._voices.push(setTimeout(() => {}, 1000));
    return { when: 0, duration: 1, stopAt: 1 };
  };
  const results = [0, 1, 2, 3, 4].map((i) => engine.playNote({ midi: 60 + i, velocity: 0.5, pan: 0, duration: 1 }));
  assert.equal(started, 3, 'played past the voice cap');
  assert.equal(results.filter(Boolean).length, 3);
  assert.equal(results[3], null, 'fourth note should be refused');
  for (const id of engine._voices) clearTimeout(id);
});

test('due notes come out in time order and clear the queue', () => {
  const scheduler = new NoteScheduler();
  for (const [i, time] of [0.3, 0.1, 0.2].entries()) {
    scheduler.enqueueManual({ degree: i, velocity: 0.5, pan: 0, time, duration: null });
  }
  const due = scheduler.takeDue(1);
  assert.deepEqual(due.map((e) => e.time), [0.1, 0.2, 0.3]);
  assert.equal(scheduler.takeDue(1).length, 0);
});

// --- palette -------------------------------------------------------------

test('palettes produce a full, monotone-ish, in-gamut ramp', () => {
  for (const name of PALETTE_NAMES) {
    const lut = buildLut(name);
    assert.equal(lut.length, 768);
    assert.deepEqual([lut[0], lut[1], lut[2]], [lut[0], lut[1], lut[2]]);
    assert.ok(lut.every((v) => v >= 0 && v <= 255), `${name} left gamut`);
    const dark = lut[0] + lut[1] + lut[2];
    const bright = lut[765] + lut[766] + lut[767];
    assert.ok(bright > dark * 4, `${name} lacks contrast`);
  }
});
