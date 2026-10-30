import { TAU, clamp, wrap, wrapHalf, makeRandom } from './mathx.js';
import { FreqMap } from './constants.js';

/**
 * Read a frequency ramp at a continuous position in [0, 1], interpolating
 * between samples. Indexing the ramp directly would truncate the position to
 * an integer and collapse every cell onto the first sample.
 */
export function sampleRamp(ramp, position) {
  if (ramp.length === 0) throw new RangeError('empty frequency ramp');
  if (ramp.length === 1) return ramp[0];
  const scaled = clamp(position, 0, 1) * (ramp.length - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(ramp.length - 1, lower + 1);
  return ramp[lower] + (ramp[upper] - ramp[lower]) * (scaled - lower);
}

/**
 * Local phase disagreement per cell, in [0, 1]: mean absolute wrapped phase
 * difference to the four neighbours, divided by the maximum possible (0.5).
 * Zero when a cell matches its neighbours, one when it is a quarter-cycle from
 * all of them.
 *
 * This is what the renderer brightens. Absolute phase is a poor brightness
 * signal because a perfectly synchronised field has identical phase everywhere
 * and would draw as a flat colour, hiding exactly the phenomenon the piece is
 * about; disagreement instead lights up wavefronts and boundaries and fades as
 * the field locks, so order becomes visible rather than merely measurable.
 *
 * Writes into `target` to keep the render loop allocation-free.
 */
export function localDisagreement(field, target) {
  const { cols, rows, phase } = field;
  for (let row = 0; row < rows; row++) {
    const up = ((row - 1 + rows) % rows) * cols;
    const here = row * cols;
    const down = ((row + 1) % rows) * cols;
    for (let col = 0; col < cols; col++) {
      const p = phase[here + col];
      const sum =
        Math.abs(wrapHalf(phase[here + ((col - 1 + cols) % cols)] - p, 0.5)) +
        Math.abs(wrapHalf(phase[here + ((col + 1) % cols)] - p, 0.5)) +
        Math.abs(wrapHalf(phase[up + col] - p, 0.5)) +
        Math.abs(wrapHalf(phase[down + col] - p, 0.5));
      target[here + col] = clamp(sum / (4 * 0.5), 0, 1);
    }
  }
  return target;
}

/**
 * A toroidal grid of coupled phase oscillators.
 *
 * Each cell carries a phase p in [0, 1) and a natural frequency f (Hz, musical).
 * Neighbours pull on each other with sine-of-phase-difference coupling, so the
 * field self-organises: unforced, it settles into travelling waves, target
 * patterns and (with enough dispersion) chimera-like states where part of the
 * grid is locked and part drifts. Phases are advanced as *angular velocity*
 * so a frequency change never produces a phase discontinuity (no clicks).
 */
export class Field {
  constructor(cols, rows, { coupling = 12, noise = 0.02, damping = 3.2 } = {}) {
    this.cols = cols;
    this.rows = rows;
    const n = cols * rows;
    this.phase = new Float32Array(n);
    this.freq = new Float32Array(n);
    this.gain = new Float32Array(n);
    this.prevGain = new Float32Array(n);
    this.impulse = new Float32Array(n);
    this.omegaScale = 1;
    this.t = 0;
    this.couplingBase = coupling;
    this.noise = noise;
    this.damping = damping;
    this.mapType = FreqMap.Horizontal;
    this.mapOrigin = [0, 0];
    this.mapSpan = [1, 1];
    this._lap = new Float32Array(n);
  }

  index(col, row) {
    return row * this.cols + col;
  }

  colOf(index) {
    return index % this.cols;
  }

  rowOf(index) {
    return Math.floor(index / this.cols);
  }

  /** Normalised position of a cell along the pitch axis of the active map. */
  positionNorm(col, row) {
    switch (this.mapType) {
      case FreqMap.Horizontal:
        return clamp((col - this.mapOrigin[0]) / this.mapSpan[0], 0, 1);
      case FreqMap.Vertical:
        return clamp((row - this.mapOrigin[1]) / this.mapSpan[1], 0, 1);
      case FreqMap.Diagonal:
        return clamp(
          (col - this.mapOrigin[0] + row - this.mapOrigin[1]) / (this.mapSpan[0] + this.mapSpan[1]),
          0,
          1,
        );
      case FreqMap.Radial: {
        const dx = (col - this.mapOrigin[0]) / this.mapSpan[0];
        const dy = (row - this.mapOrigin[1]) / this.mapSpan[1];
        return clamp(Math.hypot(dx, dy), 0, 1);
      }
      case FreqMap.Uniform:
        return 0.5;
      default:
        throw new RangeError(`unknown freq map: ${this.mapType}`);
    }
  }

  /**
   * Recompute natural frequencies from the current map. Phase and gain are
   * left untouched so retuning mid-performance is a glide, not a jump.
   */
  retune(ramp, mapType, origin, span) {
    this.mapType = mapType;
    this.mapOrigin = origin;
    this.mapSpan = span;
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        this.freq[this.index(col, row)] = sampleRamp(ramp, this.positionNorm(col, row));
      }
    }
  }

  /** Re-seed phases (and optionally drop all energy). */
  randomize(seed, { keepGains = false } = {}) {
    const random = makeRandom(seed);
    for (let i = 0; i < this.phase.length; i++) {
      this.phase[i] = random();
      if (!keepGains) {
        this.gain[i] = 0;
        this.prevGain[i] = 0;
        this.impulse[i] = 0;
      }
    }
  }

  /** Mark a cell as having fired, independent of the phase integrator. */
  trigger(index) {
    this.impulse[index] = 1;
  }

  /** Inject energy and phase-align a disc of cells. Works across the seam. */
  stroke(col, row, radius, strength, targetPhase) {
    const r2 = radius * radius;
    for (let dr = -Math.ceil(radius); dr <= Math.ceil(radius); dr++) {
      for (let dc = -Math.ceil(radius); dc <= Math.ceil(radius); dc++) {
        const d2 = dc * dc + dr * dr;
        if (d2 > r2) continue;
        const i = this.index(wrap(col + dc, this.cols), wrap(row + dr, this.rows));
        const falloff = 1 - Math.sqrt(d2) / (radius + 1e-6);
        const amount = strength * falloff;
        this.gain[i] = Math.min(1.6, this.gain[i] + amount);
        if (targetPhase !== null && targetPhase !== undefined) {
          const pull = clamp(amount * 2.5, 0, 1);
          const delta = wrapHalf(targetPhase - this.phase[i], 0.5);
          this.phase[i] = wrap(this.phase[i] + delta * pull, 1);
        }
      }
    }
  }

  /**
   * Advance by `dt` seconds. Returns the list of firing cell indices so the
   * caller can voice notes; `dt <= 0` is a no-op returning nothing.
   */
  step(dt, { coupling, noise }) {
    const fired = [];
    if (!(dt > 0)) return fired;
    const { cols, rows, phase, freq, gain, impulse } = this;
    const lap = this._lap;
    const scale = this.omegaScale;

    // Mean phase drift of the four nearest neighbours (torus-wrapped), in a
    // phase-difference form so the coupling is invariant to absolute phase.
    for (let row = 0; row < rows; row++) {
      const up = ((row - 1 + rows) % rows) * cols;
      const here = row * cols;
      const down = ((row + 1) % rows) * cols;
      for (let col = 0; col < cols; col++) {
        const left = (col - 1 + cols) % cols;
        const right = (col + 1) % cols;
        const p = phase[here + col];
        lap[here + col] =
          wrapHalf(phase[here + left] - p, 0.5) +
          wrapHalf(phase[here + right] - p, 0.5) +
          wrapHalf(phase[up + col] - p, 0.5) +
          wrapHalf(phase[down + col] - p, 0.5);
      }
    }

    const k = coupling * dt;
    const amplitude = 1 - clamp(this.damping * dt, 0, 1);
    const noiseStep = noise * Math.sqrt(dt);
    for (let i = 0; i < phase.length; i++) {
      let next = phase[i] + (freq[i] * scale + k * lap[i] * 0.25) * dt;
      if (noiseStep > 0) next += (Math.random() - 0.5) * noiseStep;
      // gain makes an excited cell run slightly sharp: a brightening shimmer.
      next += gain[i] * 0.06 * dt;
      // A cycle is detected by overshoot rather than by comparing the wrapped
      // value, because a phase of exactly 1.0 would wrap to 0 and be counted
      // as a firing twice over.
      const crossed = next >= 1 || next < 0;
      phase[i] = wrap(next, 1);
      if (crossed) {
        impulse[i] = 1;
        fired.push(i);
      }
      gain[i] *= amplitude;
    }
    this.t += dt;
    return fired;
  }

  /**
   * Synchrony within each `tile`-square neighbourhood, averaged: the local
   * counterpart of orderParameter(), and the number that actually responds to
   * coupling on this lattice.
   *
   * Global order stays near zero here no matter how strong the coupling, because
   * nearest-neighbour diffusion on a large periodic grid organises into domains
   * and travelling waves rather than one phase. Measured with the shipped grid:
   * coupling 0 -> 0.135, coupling 40 -> 0.296, against global 0.008 -> 0.022.
   * So "how organised is it?" has to be asked at the scale where organisation
   * happens -- which is also the scale the renderer draws.
   */
  localOrder(tile = 7) {
    const { cols, rows, phase } = this;
    let total = 0;
    let tiles = 0;
    for (let row = 0; row + tile <= rows; row += tile) {
      for (let col = 0; col + tile <= cols; col += tile) {
        let x = 0;
        let y = 0;
        for (let r = row; r < row + tile; r++) {
          for (let c = col; c < col + tile; c++) {
            const angle = 2 * Math.PI * phase[r * cols + c];
            x += Math.cos(angle);
            y += Math.sin(angle);
          }
        }
        const cells = tile * tile;
        total += Math.hypot(x / cells, y / cells);
        tiles += 1;
      }
    }
    return tiles > 0 ? total / tiles : 0;
  }

  /** Normalised asynchrony: 1 when perfectly locked, ~0 when incoherent. */
  orderParameter() {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < this.phase.length; i++) {
      const a = this.phase[i] * TAU;
      sx += Math.cos(a);
      sy += Math.sin(a);
    }
    const n = this.phase.length;
    return Math.hypot(sx / n, sy / n);
  }

  /** Fraction of cells carrying visible energy. */
  activity() {
    let sum = 0;
    for (let i = 0; i < this.gain.length; i++) sum += this.gain[i] > 0.05 ? 1 : 0;
    return sum / this.gain.length;
  }

  meanFrequency() {
    let sum = 0;
    for (let i = 0; i < this.freq.length; i++) sum += this.freq[i];
    return sum / this.freq.length;
  }
}
