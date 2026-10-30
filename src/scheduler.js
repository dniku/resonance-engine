import { quantizeDegree } from './music.js';

/**
 * Converts grid activity into note events. Two sources:
 *  - `enqueueManual`: the note you play with pointer or keyboard.
 *  - `collectAuto`: cells whose phase wrapped, throttled by a shared voice
 *    budget so a cascade of firings becomes a phrase rather than a wall.
 *
 * The shared budget is what makes the piece interesting: your playing competes
 * with the field for polyphony, so the more you play, the more the autonomous
 * part thins out.
 *
 * `humanize` must stay well below the caller's poll interval: a note pushed
 * later than the next `takeDue` simply arrives a frame late, which reads as
 * jitter rather than feel.
 */
export class NoteScheduler {
  constructor({ maxVoices = 5, autoBudget = 0.35, humanize = 0.012, velocityGate = 0.09 } = {}) {
    this.queue = [];
    this.maxVoices = maxVoices;
    this.autoBudget = autoBudget;
    this.humanize = humanize;
    this.velocityGate = velocityGate;
    this._autoCredit = 0;
    this._last = new Map();
  }

  enqueueManual(event) {
    this.queue.push({ ...event, source: 'manual' });
  }

  /**
   * @param {number} now seconds, monotonic
   * @param {Iterable<number>} firingIndices cells that crossed their boundary
   * @param {(index:number) => {degree:number, gain:number, pan:number, col:number, row:number}} lookup
   */
  collectAuto(now, firingIndices, lookup) {
    this._autoCredit += this.autoBudget;
    for (const index of firingIndices) {
      if (this._autoCredit < 1) break;
      const cell = lookup(index);
      if (!cell || cell.gain < this.velocityGate) continue;
      const previous = this._last.get(index);
      if (previous !== undefined && now - previous < 0.08) continue;
      this._last.set(index, now);
      this._autoCredit -= 1;
      this.queue.push({
        degree: quantizeDegree(cell.degree),
        velocity: Math.min(1, cell.gain),
        pan: cell.pan,
        col: cell.col,
        row: cell.row,
        time: now + (Math.random() - 0.5) * this.humanize,
        duration: null,
        source: 'auto',
      });
    }
  }

  /** Drain notes whose time has arrived, oldest first. */
  takeDue(now) {
    const due = [];
    const kept = [];
    for (const event of this.queue) {
      if (event.time <= now) due.push(event);
      else kept.push(event);
    }
    this.queue = kept;
    due.sort((a, b) => a.time - b.time);
    return due;
  }

  clear() {
    this.queue.length = 0;
    this._last.clear();
    this._autoCredit = 0;
  }
}
