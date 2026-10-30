import { Field, localDisagreement } from './field.js';
import { AudioEngine } from './audio.js';
import { NoteScheduler } from './scheduler.js';
import { buildFrequencyRamp, degreesForOctaves, rateForPosition } from './tuning.js';
import { buildLut, PALETTE_NAMES } from './palette.js';
import { degreeToMidi, midiToName, midiToChromaticStep, noteNameToOffset } from './music.js';
import {
  FreqMap,
  NOTE_NAMES,
  Palette,
  PlayMode,
  SCALE_NAMES,
  STEPS_PER_OCTAVE,
} from './constants.js';
import { TAU, clamp, wrap } from './mathx.js';

/** How far ahead of the audio clock notes are queued. */
const LOOKAHEAD = 0.12;

const COLS = 84;
const ROWS = 56;
const SEED = 0x5eed;

/**
 * Range controls and the state key each one writes. `bindRange`, the label
 * sync and the reset path all derive from this list, so adding a slider is one
 * line here plus the markup.
 */
const RANGE_KEYS = [
  ['c-tempo', 'tempo'],
  ['c-speed', 'speed'],
  ['c-coupling', 'coupling'],
  ['c-noise', 'noise'],
  ['c-octaves', 'octaves'],
  ['c-volume', 'volume'],
  ['c-space', 'space'],
];

/**
 * Select controls, the state key each one writes, and how to parse its value.
 * A DOM `option.value` is always a string, so each control declares how to read
 * it; keeping the parse beside the binding is what stops a value type and its
 * option list from drifting apart again.
 */
const SELECT_KEYS = [
  ['c-scale', 'scale', String],
  ['c-root', 'root', (value) => value.toUpperCase()],
  ['c-map', 'map', String],
  ['c-play', 'playMode', String],
  ['c-palette', 'palette', String],
];

/** Checkboxes and the state key each one writes. */
const TOGGLE_KEYS = [
  ['c-auto', 'autoSound'],
  ['c-pointer', 'pointerSound'],
  ['c-selfhear', 'selfHear'],
  ['c-trails', 'motionTrails'],
  ['c-waveform', 'showWaveform'],
];

/** Everything the simulation and the music read. Single source of truth. */
const state = {
  running: true,
  tempo: 100,
  speed: 1,
  coupling: 12,
  noise: 0.05,
  octaves: 3,
  scale: 'aeolian',
  root: 'C',
  map: FreqMap.Diagonal,
  playMode: PlayMode.Both,
  palette: Palette.Abyss,
  volume: 0.75,
  space: 0.34,
  autoSound: true,
  pointerSound: true,
  motionTrails: true,
  selfHear: true,
  showWaveform: true,
  seed: SEED,
};

const field = new Field(COLS, ROWS, { coupling: state.coupling });
const audio = new AudioEngine();
const scheduler = new NoteScheduler({ maxVoices: 5 });
const canvas = document.getElementById('field');
const context = canvas.getContext('2d', { alpha: false });
const buffer = context.createImageData(COLS, ROWS);
const overlay = document.createElement('canvas');
const overlayCtx = overlay.getContext('2d');

let lut = buildLut(state.palette);
/** Scratch buffers for the render loop; sized with the grid, never reallocated. */
const disagreement = new Float32Array(COLS * ROWS);
let flash = new Float32Array(COLS * ROWS);
let clock = 0;
let lastFrame = performance.now();
let fps = 60;
let tickCount = 0;
/** Most recent voiced note and the commands run, for the browser test seam. */
let lastPlayed = null;
const commandLog = [];

/** Seconds per beat at the current tempo. */
function beatSeconds() {
  return 60 / state.tempo;
}

/** Cycles per real second for a cell, given the engine's current tempo bias. */
function ratePerSecond(rate) {
  return rate / beatSeconds();
}

/**
 * The rate table is the single bridge between music and physics: it fixes the
 * field's firing rates and the tempo that converts them to Hz. Deriving every
 * consumer from it keeps a cell's pitch and its firing rate in agreement.
 */
function rateTable(cells, octaves) {
  const rates = new Float64Array(cells);
  for (let i = 0; i < cells; i++) {
    rates[i] = rateForPosition(cells > 1 ? i / (cells - 1) : 0, octaves);
  }
  return rates;
}

/**
 * Fastest rate the field can hold, used to bound the integration step so no
 * oscillator skips a whole cycle in one step.
 */
function fastestRate(rates) {
  let fastest = 0;
  for (const rate of rates) fastest = Math.max(fastest, rate);
  return Math.max(1, fastest);
}

/** Engine firing rates (cycles per engine-second) for each pitch position. */
let rates = rateTable(COLS, state.octaves);

function reTune() {
  rates = rateTable(COLS, state.octaves);
  field.retune(rates, state.map, [COLS / 2, ROWS / 2], [COLS, ROWS]);
}

function rebuildOverlays() {
  overlay.width = COLS;
  overlay.height = ROWS;
  flash = new Float32Array(COLS * ROWS);
}

// --- rendering ------------------------------------------------------------

/**
 * Map a cell to a palette index. `disagreement` (0..1) is the structural
 * signal, so wavefronts glow and a locked field settles to a cool dark rather
 * than to flat mid-blue; `phase` contributes a low-amplitude shimmer so an
 * at-rest grid still reads as alive; `gain` is the hot highlight from playing.
 * Coefficients are tuned against the golden screenshots rather than derived.
 */
/**
 * Gamma below 1 expands the dark end where most resting cells sit, so the
 * difference between a quiet neighbourhood and a wavefront is visible rather
 * than compressed into one muddy band. Tuned against the golden screenshots.
 */
/*
 * Brightness -> colour: what the user is actually looking at.
 *
 * This mapping was wrong twice over, and the measurements that showed it are
 * worth keeping because the failure was invisible from inside the code.
 *
 * Brightness is dominated by `gain` -- the record that this cell was recently
 * conducted -- not by phase disagreement. The original version led with
 * disagreement, which meant a drag made the field *dimmer*: forcing neighbours
 * into step reduces disagreement, so the thing a visitor creates was the one
 * thing the renderer could not show. Measured on a conducted disc against its
 * own field, wave-vs-background contrast was 1.01:1 -- literally indistinguishable.
 * Tuning contrast cannot fix a signal that is inverted; the weights had to move.
 *
 * Disagreement is retained at lower weight because it is what makes the
 * autonomous field interesting (wavefronts and spirals glow unbidden), but it
 * now reads as texture under the user's strokes rather than instead of them.
 */
const STRUCTURE_WEIGHT = 0.34;
const GAIN_WEIGHT = 1.15;

/**
 * Gamma below 1 lifts the quiet end so the autonomous field still has visible
 * texture at low brightness, without blowing out a stroke to pure white.
 */
const CONTRAST = 0.85;

function brightnessOf(disagreement, phase, gain) {
  const shimmer = 0.5 + 0.5 * Math.cos(phase * TAU);
  const structure = clamp(
    disagreement * STRUCTURE_WEIGHT + shimmer * 0.05 + Math.min(gain, 1) * GAIN_WEIGHT,
    0,
    1,
  );
  return clamp(Math.pow(structure, CONTRAST), 0, 1);
}

function drawField() {
  localDisagreement(field, disagreement);
  const data = buffer.data;
  for (let i = 0; i < COLS * ROWS; i++) {
    const brightness = brightnessOf(disagreement[i], field.phase[i], field.gain[i]);
    const o = Math.min(255, Math.round(brightness * 255)) * 3;
    const pixel = i * 4;
    data[pixel] = lut[o];
    data[pixel + 1] = lut[o + 1];
    data[pixel + 2] = lut[o + 2];
    data[pixel + 3] = 255;
  }
  context.putImageData(buffer, 0, 0);
}

function drawGlow() {
  context.globalCompositeOperation = 'lighter';
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const i = row * COLS + col;
      const glow = field.gain[i];
      if (glow < 0.06) continue;
      context.fillStyle = `rgba(${lut[765 - 3]}, ${lut[766 - 3]}, ${lut[767 - 3]}, ${Math.min(0.5, glow * 0.4)})`;
      context.beginPath();
      context.arc(col + 0.5, row + 0.5, Math.max(0.5, glow * 2.6), 0, TAU);
      context.fill();
    }
  }
  context.globalCompositeOperation = 'source-over';
}

// --- input ---------------------------------------------------------------

/**
 * Pointer state. `active` means a gesture is in progress. It is set on pointer
 * down, not inside the move handler: `event.buttons` is 0 for a finger as often
 * as for an unheld mouse, so a move handler that infers "not dragging" from it
 * treats the first touch move as a hover and the stroke loses its start.
 */
let pointer = {
  active: false,
  col: 0,
  row: 0,
  lastCol: 0,
  lastRow: 0,
  velocity: 0,
  /** 'mouse' | 'touch' | 'pen'; decides whether a move without a press is a hover. */
  type: 'mouse',
};

function cellFromEvent(event) {
  const rect = canvas.getBoundingClientRect();
  const col = Math.floor(((event.clientX - rect.left) / rect.width) * COLS);
  const row = Math.floor(((event.clientY - rect.top) / rect.height) * ROWS);
  return { col: wrap(col, COLS), row: wrap(row, ROWS) };
}

/** Position along the pitch axis, honouring the Play Mode control. */
function pitchPosition(col, row) {
  switch (state.playMode) {
    case PlayMode.Horizontal:
      return col / (COLS - 1);
    case PlayMode.Vertical:
      return row / (ROWS - 1);
    case PlayMode.Both:
      return ((col / (COLS - 1)) * 0.6 + (1 - row / (ROWS - 1)) * 0.4);
    default:
      throw new RangeError(`unknown play mode: ${state.playMode}`);
  }
}

function degreeAt(col, row) {
  const spread = degreesForOctaves(state.octaves, state.scale);
  return pitchPosition(col, row) * spread;
}

function conduct(event) {
  const { col, row } = cellFromEvent(event);
  const dx = col - pointer.lastCol;
  const dy = row - pointer.lastRow;
  pointer.velocity = clamp(Math.hypot(dx, dy) / 6, 0, 1);
  const speed = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(speed / 2));
  for (let s = 0; s < steps; s++) {
    const t = s / steps;
    const c = Math.round(pointer.lastCol + dx * t);
    const r = Math.round(pointer.lastRow + dy * t);
    field.stroke(c, r, 3.2, 0.075 + pointer.velocity * 0.1, null);
  }
  if (event.buttons === 1 || event.type === 'pointerdown') {
    playAt(col, row, 0.55 + pointer.velocity * 0.45);
  }
  pointer.lastCol = pointer.col = col;
  pointer.lastRow = pointer.row = row;
  pointer.active = true;
}

function playAt(col, row, velocity) {
  const degree = degreeAt(col, row);
  const midi = midiFromDegree(degree);
  lastPlayed = { midi, degree, col, row };
  const pan = panForCol(col);
  field.stroke(col, row, 6.5, 0.85 + velocity * 0.5, null);
  if (state.pointerSound) {
    scheduler.enqueueManual({
      degree,
      velocity,
      pan,
      time: audio.now + 0.01,
      duration: null,
    });
  }
  // Self-hearing: the note you played seeds the field so its neighbours drift
  // toward it, making the instrument partially tune itself.
  if (state.selfHear) nudgeToward(midi);
  flashCell(col, row);
  updateReadout(degree, midi, 'play');
}

/** Stereo position for a column, in the -1..1 range StereoPanner expects. */
function panForCol(col) {
  return ((col + 0.5) / COLS) * 2 - 1;
}

/** MIDI of a grid degree under the current scale and root. */
function midiFromDegree(degree) {
  return degreeToMidi(degree, state.scale, noteNameToOffset(state.root));
}

/**
 * Self-hearing: a played note biases the field's global tempo toward itself,
 * so the instrument partially tunes itself. Half the interval because the
 * nudge compounds across a phrase.
 */
function nudgeToward(midi) {
  const shift = Math.pow(2, (midi - 60) / 24) - 1;
  field.omegaScale = clamp(field.omegaScale + shift * 0.5, 0.55, 1.9);
}

function flashCell(col, row) {
  flash[row * COLS + col] = 1;
}

// --- main loop -----------------------------------------------------------

/** Longest engine step that keeps the fastest oscillator stable and accurate. */
const MAX_STABLE_STEP = 0.05;

function simulate(dt) {
  const stepSeconds = Math.min(MAX_STABLE_STEP, 1 / (24 * fastestRate(rates)));
  let remaining = dt;
  let iterations = 0;
  const simTime = clock;
  while (remaining > 0 && iterations < 8) {
    const step = Math.min(stepSeconds, remaining);
    const fired = field.step(step, { coupling: state.coupling, noise: state.noise });
    if (state.autoSound && fired.length) {
      scheduler.collectAuto(simTime, fired, (index) => {
        const col = field.colOf(index);
        const row = field.rowOf(index);
        return { degree: degreeAt(col, row), gain: field.gain[index], col, row, pan: panForCol(col) };
      });
    }
    remaining -= step;
    iterations += 1;
  }
}

/**
 * Voice the notes that are due. `playNote` declines when the voice budget is
 * full, and a declined note is dropped rather than requeued: holding it would
 * pile up a backlog that plays as a burst the moment voices free up.
 */
function flushNotes() {
  const due = scheduler.takeDue(audio.now + LOOKAHEAD);
  for (const event of due) {
    const midi = midiFromDegree(event.degree);
    const played = audio.playNote({
      midi,
      velocity: event.velocity,
      pan: event.pan,
      duration: event.duration,
      at: event.time,
    });
    if (!played) continue;
    if (event.source === 'auto') flashCell(event.col, event.row);
    if (state.showWaveform) drawPulse(midiToChromaticStep(midi), event.velocity);
  }
}

function drawPulse(chromaticStep, velocity) {
  const el = document.getElementById('pulses');
  if (!el) return;
  const dot = document.createElement('span');
  dot.className = 'pulse';
  dot.style.left = `${(chromaticStep / 12) * 100}%`;
  dot.style.setProperty('--size', `${6 + velocity * 16}px`);
  el.appendChild(dot);
  dot.addEventListener('animationend', () => dot.remove());
  while (el.childElementCount > 40) el.firstElementChild?.remove();
}

function render() {
  drawField();
  if (state.motionTrails) drawGlow();
  drawFlashOverlay();
}

function drawFlashOverlay() {
  let any = false;
  for (let i = 0; i < flash.length; i++) {
    if (flash[i] > 0.01) {
      any = true;
      break;
    }
  }
  if (!any) return;
  context.save();
  context.globalCompositeOperation = 'lighter';
  for (let i = 0; i < flash.length; i++) {
    if (flash[i] <= 0.01) continue;
    flash[i] *= 0.9;
    const alpha = Math.min(0.9, flash[i]);
    context.fillStyle = `rgba(255,255,255,${alpha})`;
    context.fillRect(i % COLS, Math.floor(i / COLS), 1, 1);
  }
  context.restore();
}

function frame(now) {
  tickCount += 1;
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  fps = fps * 0.9 + (1 / Math.max(0.0001, dt)) * 0.1;
  if (state.running) {
    clock += dt;
    simulate(dt);
    flushNotes();
    decayOmega(dt);
  }
  render();
  updateStatus();
  requestAnimationFrame(frame);
}

/** The self-tuning nudge should relax back to neutral, or playing drifts away. */
function decayOmega(dt) {
  field.omegaScale += (1 - field.omegaScale) * clamp(dt * 0.35, 0, 1);
}

// --- status --------------------------------------------------------------

const readout = {
  fps: document.getElementById('v-fps'),
  order: document.getElementById('v-order'),
  local: document.getElementById('v-local'),
  activity: document.getElementById('v-activity'),
  voices: document.getElementById('v-voices'),
  note: document.getElementById('v-note'),
  scale: document.getElementById('v-scale'),
  root: document.getElementById('v-root'),
  spread: document.getElementById('v-spread'),
};

/** Session flag for the orientation overlay; see dismissIntro(). */
const INTRO_KEY = 'resonance-intro-seen';

/** Live regions need seconds, not frames: one announcement per ~2s. */
const ANNOUNCE_EVERY_FRAMES = 120;

let statusTick = 0;
function updateStatus() {
  const tick = statusTick++;
  if (tick % ANNOUNCE_EVERY_FRAMES === 0) announceState();
  if (tick % 12 !== 0) return;
  readout.fps.textContent = fps.toFixed(0);
  readout.order.textContent = field.orderParameter().toFixed(3);
  readout.local.textContent = field.localOrder().toFixed(3);
  readout.activity.textContent = `${(field.activity() * 100).toFixed(0)}%`;
  readout.voices.textContent = String(audio._voices.length);
}

function updateReadout(degree, midi, kind) {
  readout.note.textContent = `${midiToName(midi)} · ${midi.toFixed(1)}`;
  readout.note.dataset.kind = kind;
}

function updateTuningReadout() {
  readout.scale.textContent = state.scale;
  readout.root.textContent = state.root;
  readout.spread.textContent = `${state.octaves.toFixed(1)} oct`;
}

// --- controls ------------------------------------------------------------

/** Range outputs are labelled `v-<control id>`; this keeps that in one place. */
function syncRangeLabel(id, key, value) {
  const label = document.getElementById(`v-${id}`);
  if (label) label.textContent = formatValue(key, value);
}

function bindRange(id, key, transform, after) {
  const el = document.getElementById(id);
  el.value = String(state[key]);
  el.dataset.stateKey = key;
  const apply = () => {
    const value = transform ? transform(el.valueAsNumber) : el.valueAsNumber;
    state[key] = value;
    syncRangeLabel(id, key, value);
    if (after) after();
  };
  apply();
  el.addEventListener('input', apply);
}

/** Repaint every range label from `state`, after a programmatic change. */
function syncRangeLabels() {
  for (const [id, key] of RANGE_KEYS) syncRangeLabel(id, key, state[key]);
}

function formatValue(key, value) {
  if (key === 'octaves') return `${value.toFixed(1)}`;
  if (key === 'volume' || key === 'space') return `${Math.round(value * 100)}%`;
  if (key === 'coupling') return value.toFixed(0);
  if (key === 'noise') return value.toFixed(3);
  if (key === 'speed') return `${value.toFixed(2)}×`;
  return String(value);
}

function bindSelect(id, key, parse, after) {
  const el = document.getElementById(id);
  el.value = String(state[key]);
  const apply = () => {
    state[key] = parse(el.value);
    if (after) after();
  };
  el.addEventListener('change', apply);
  apply();
}

function bindToggle(id, key, after) {
  const el = document.getElementById(id);
  el.checked = state[key];
  const apply = () => {
    state[key] = el.checked;
    if (after) after();
  };
  el.addEventListener('change', apply);
  apply();
}

function fillSelect(id, values, labels) {
  const el = document.getElementById(id);
  el.textContent = '';
  values.forEach((value, i) => {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = labels ? labels[i] : String(value);
    el.appendChild(option);
  });
}

function setupControls() {
  fillSelect('c-scale', SCALE_NAMES);
  fillSelect('c-root', NOTE_NAMES);
  fillSelect('c-map', Object.values(FreqMap));
  fillSelect('c-play', Object.values(PlayMode));
  fillSelect('c-palette', PALETTE_NAMES);

  bindRange('c-tempo', 'tempo');
  bindRange('c-speed', 'speed');
  bindRange('c-coupling', 'coupling', undefined, () => {
    field.couplingBase = state.coupling;
  });
  bindRange('c-noise', 'noise');
  bindRange('c-octaves', 'octaves', undefined, reTune);
  bindRange('c-volume', 'volume', undefined, () => audio.setMasterVolume(state.volume));
  bindRange('c-space', 'space', undefined, () => audio.setSpace(state.space));

  bindSelect('c-scale', 'scale', String, () => {
    reTune();
    updateTuningReadout();
  });
  bindSelect('c-root', 'root', (value) => value.toUpperCase(), () => {
    reTune();
    updateTuningReadout();
  });
  bindSelect('c-map', 'map', String, reTune);
  bindSelect('c-play', 'playMode', String);
  bindSelect('c-palette', 'palette', String, () => {
    lut = buildLut(state.palette);
  });

  for (const [id, key] of TOGGLE_KEYS) bindToggle(id, key);

  document.getElementById('b-play').addEventListener('click', toggleRun);
  document.getElementById('b-seed').addEventListener('click', () => reseed(null));
  document.getElementById('b-clear').addEventListener('click', clearField);
  document.getElementById('b-burst').addEventListener('click', burst);
  document.getElementById('b-mutate').addEventListener('click', mutate);
  document.getElementById('b-reset').addEventListener('click', resetAll);
  document.getElementById('b-audio').addEventListener('click', enableAudio);
  document.getElementById('b-panel').addEventListener('click', togglePanel);
  document.getElementById('b-intro').addEventListener('click', dismissIntro);
}

/**
 * Show the orientation overlay only to someone who has not seen it.
 *
 * Also bound to Escape, and dismissed by the first drag: someone who already
 * knows what to do should never be trapped behind a panel they have to click.
 * Without that, the overlay would swallow the one gesture it exists to teach.
 */
function setupIntro() {
  const intro = document.getElementById('intro');
  let seen = false;
  try {
    seen = window.sessionStorage.getItem(INTRO_KEY) === 'seen';
  } catch {
    seen = false;
  }
  if (seen) {
    intro.hidden = true;
    return;
  }
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !intro.hidden) dismissIntro();
  });
  /*
   * The overlay covers the canvas, so it cannot listen on the canvas: a pointer
   * down lands on the overlay and the canvas never hears about it. Listening on
   * the overlay itself -- and then re-dispatching to the canvas -- means the very
   * first drag both dismisses the panel and paints, rather than being swallowed.
   * Without this the app looks broken until the visitor finds the button.
   */
  intro.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    dismissIntro();
    canvas.dispatchEvent(new PointerEvent(event.type, {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      bubbles: true,
      cancelable: true,
      clientX: event.clientX,
      clientY: event.clientY,
      buttons: event.buttons,
      button: event.button,
    }));
  }, { capture: true });
}

/**
 * Hide the orientation overlay for good.
 *
 * Remembered in sessionStorage rather than localStorage: a first-time visitor
 * should see this, and a returning one should not, but a fresh tab is a
 * reasonable place to want it again. Nothing is stored when storage is
 * unavailable -- a sandboxed frame denies it -- and the overlay simply shows
 * every load, which is the same as the previous behaviour.
 */
function dismissIntro() {
  document.getElementById('intro').hidden = true;
  try {
    window.sessionStorage.setItem(INTRO_KEY, 'seen');
  } catch {
    // Storage denied (opaque origin, private mode). Not worth a user-visible error.
  }
}

/**
 * Mirror the field's state into a live region. Throttled hard: at frame rate a
 * polite live region queues hundreds of announcements and the screen reader
 * becomes unusable, which is worse than silence.
 */
function announceState() {
  const region = document.getElementById('sr-state');
  region.textContent = [
    `Order ${field.orderParameter().toFixed(2)}`,
    `local order ${field.localOrder().toFixed(2)}`,
    `${audio._voices.length} voices`,
  ].join(', ');
}

/** Start or stop the simulation, keeping the button label in step. */
function setRunning(value) {
  state.running = value;
  document.getElementById('b-play').textContent = value ? 'Pause' : 'Run';
  if (value) void enableAudio();
  else void audio.suspend();
}

/**
 * Collapse the control sheet so the field owns the screen. Only reachable on
 * small viewports, where the media query shows the toggle and hides nothing
 * else; on a desktop the panel is permanent and the button is display:none.
 * `aria-expanded` is kept in step so a screen reader is not told the opposite
 * of what happened.
 */
function togglePanel() {
  const panel = document.getElementById('panel');
  const button = document.getElementById('b-panel');
  const collapsed = panel.dataset.collapsed !== 'true';
  panel.dataset.collapsed = collapsed ? 'true' : 'false';
  button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  button.textContent = collapsed ? 'Controls' : 'Hide';
}

function toggleRun() {
  setRunning(!state.running);
}

async function enableAudio() {
  const started = await audio.resume();
  audio.setMasterVolume(state.volume);
  audio.setSpace(state.space);
  const hint = document.getElementById('audio-hint');
  if (started) {
    document.getElementById('b-audio').hidden = true;
    hint.hidden = true;
  } else {
    // Keep the button visible so the gesture can be retried, and say what
    // happened instead of implying sound is on.
    hint.textContent = 'No audio device available. The simulation still runs, visuals only.';
  }
  return started;
}

/**
 * A phone has no keyboard, so the gesture is the only affordance. Show the hint
 * once for a touch user and retire it as soon as they conduct anything; a mouse
 * user has the help panel and does not need it.
 */
function setupHint() {
  const hint = document.getElementById('touch-hint');
  const isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  if (!isTouch) return;
  hint.hidden = false;
  const dismiss = () => {
    hint.hidden = true;
    canvas.removeEventListener('pointerdown', dismiss);
  };
  canvas.addEventListener('pointerdown', dismiss, { once: true });
}

function reseed(seed) {
  const value = seed ?? Math.floor(Math.random() * 0xffffffff);
  state.seed = value;
  field.randomize(value);
  document.getElementById('v-seed').textContent = `0x${value.toString(16).slice(0, 8)}`;
}

function clearField() {
  for (let i = 0; i < field.gain.length; i++) {
    field.gain[i] = 0;
    field.impulse[i] = 0;
  }
  flash.fill(0);
  scheduler.clear();
}

/**
 * Reset every cell to phase zero with a little energy, so the grid starts in
 * lockstep and then drifts apart under its own frequency spread. That makes
 * coupling audible: raise it and the grid stays together for longer.
 */
function burst() {
  field.phase.fill(0);
  for (let i = 0; i < field.gain.length; i++) field.gain[i] = Math.max(field.gain[i], 0.35);
}

/** Nudge the parameters themselves, so pressing it twice is a composition. */
function mutate() {
  const scales = SCALE_NAMES;
  state.scale = scales[Math.floor(Math.random() * scales.length)];
  state.root = NOTE_NAMES[Math.floor(Math.random() * NOTE_NAMES.length)];
  state.coupling = clamp(6 + Math.random() * 30, 0, 40);
  state.octaves = clamp(1.5 + Math.random() * 4, 1, 6);
  document.getElementById('c-scale').value = state.scale;
  document.getElementById('c-root').value = state.root;
  document.getElementById('c-coupling').value = String(state.coupling);
  document.getElementById('c-octaves').value = String(state.octaves);
  syncRangeLabels();
  field.couplingBase = state.coupling;
  reTune();
  updateTuningReadout();
}

function resetAll() {
  Object.assign(state, {
    running: true,
    tempo: 100,
    speed: 1,
    coupling: 12,
    noise: 0.05,
    octaves: 3,
    scale: 'aeolian',
    root: 'C',
    map: FreqMap.Diagonal,
    playMode: PlayMode.Both,
    palette: Palette.Abyss,
    volume: 0.75,
    space: 0.34,
    autoSound: true,
    pointerSound: true,
    motionTrails: true,
    selfHear: true,
    showWaveform: true,
  });
  for (const [id, key] of RANGE_KEYS) document.getElementById(id).value = String(state[key]);
  for (const [id, key] of SELECT_KEYS) document.getElementById(id).value = String(state[key]);
  for (const [id, key] of TOGGLE_KEYS) document.getElementById(id).checked = state[key];
  syncRangeLabels();
  field.couplingBase = state.coupling;
  field.omegaScale = 1;
  audio.setMasterVolume(state.volume);
  audio.setSpace(state.space);
  reTune();
  updateTuningReadout();
  reseed(SEED);
}

// --- keyboard ------------------------------------------------------------

/**
 * Keyboard layout: two rows of scale degrees, each row an octave above the
 * last. Keys are listed low to high; `event.key` is matched lowercased, so
 * only keys whose shifted form is a letter are usable (the letter rows, not
 * digits). Note names are avoided where they would shadow a command key.
 */
const KEYBOARD_ROWS = [
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

/** Command keys, checked before the note rows so a chord never triggers them. */
const COMMAND_KEYS = {
  ' ': 'toggle-run',
  b: 'burst',
  c: 'silence',
  m: 'mutate',
  n: 'reseed',
  r: 'reset',
};

/**
 * Scale degree for a key, or null. Degrees are scale steps, so one row spans
 * just under an octave and each row continues where the last ended.
 */
function degreeForKey(key) {
  for (const [rowIndex, row] of KEYBOARD_ROWS.entries()) {
    const index = row.indexOf(key);
    if (index >= 0) return rowIndex * row.length + index;
  }
  return null;
}

/** Place a degree on the grid: columns carry pitch, rows carry the octave. */
function cellForDegree(degree) {
  const span = degreesForOctaves(state.octaves, state.scale);
  const col = Math.round((degree / Math.max(1, span - 1)) * (COLS - 1));
  const row = Math.round((1 - degree / Math.max(1, span - 1)) * (ROWS - 1));
  return { col: clamp(col, 0, COLS - 1), row: clamp(row, 0, ROWS - 1) };
}

function setupKeyboard() {
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    const command = COMMAND_KEYS[key];
    if (command !== undefined) {
      event.preventDefault();
      commandLog.push(command);
      if (commandLog.length > 32) commandLog.shift();
      switch (command) {
        case 'toggle-run': toggleRun(); return;
        case 'burst': burst(); return;
        case 'silence': clearField(); return;
        case 'mutate': mutate(); return;
        case 'reseed': reseed(null); return;
        case 'reset': resetAll(); return;
        default: throw new RangeError(`unhandled command: ${command}`);
      }
    }
    const degree = degreeForKey(key);
    if (degree === null) return;
    event.preventDefault();
    const { col, row } = cellForDegree(degree);
    playAt(col, row, 0.8);
  });
}

// --- boot ----------------------------------------------------------------

/**
 * The canvas backing store is one pixel per cell and CSS scales it up, so the
 * simulation and the bitmap always agree on size. `image-rendering: pixelated`
 * in the stylesheet keeps cells crisp instead of blurry.
 */
function setupCanvasSize() {
  canvas.width = COLS;
  canvas.height = ROWS;
}

function boot() {
  setupCanvasSize();
  rebuildOverlays();
  setupControls();
  updateTuningReadout();
  reseed(SEED);
  reTune();

  canvas.addEventListener('pointerdown', (event) => {
    // Capture so a drag that leaves the canvas keeps steering the field, which
    // is what makes a long thumb sweep across a phone screen behave. It throws
    // if the pointer is already released by the time the handler runs (a very
    // fast flick), and losing capture is not worth an uncaught error.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Continue uncaptured: the gesture still works while inside the canvas.
    }
    pointer.active = true;
    pointer.type = event.pointerType || 'mouse';
    const cell = cellFromEvent(event);
    pointer.lastCol = cell.col;
    pointer.lastRow = cell.row;
    conduct(event);
  });
  canvas.addEventListener('pointermove', (event) => {
    const cell = cellFromEvent(event);
    // Only an unpressed mouse hovers. A touch or pen only ever reports a move
    // while it is down, and a released pointer's move must not paint.
    const hovering = pointer.type === 'mouse' && event.buttons === 0 && !pointer.active;
    if (hovering) {
      pointer.lastCol = cell.col;
      pointer.lastRow = cell.row;
      hoverReadout(cell.col, cell.row);
      return;
    }
    if (!pointer.active) return;
    conduct(event);
  });
  const endGesture = () => {
    pointer.active = false;
  };
  canvas.addEventListener('pointerup', endGesture);
  canvas.addEventListener('pointercancel', endGesture);

  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  setupKeyboard();
  setupHint();
  setupIntro();
  requestAnimationFrame(frame);
}

function hoverReadout(col, row) {
  const degree = degreeAt(col, row);
  updateReadout(degree, midiFromDegree(degree), 'hover');
}

/**
 * Test and debugging seam. The browser test drives the same functions the
 * buttons do, which keeps it honest (no test-only code paths) while making the
 * render loop, the field and the audio graph observable from outside.
 */
function publishDebugHandle() {
  window.__resonance = {
    state,
    field,
    audio,
    scheduler,
    tickCounter: () => tickCount,
    clockValue: () => clock,
    setRunning,
    setCoupling(value) {
      state.coupling = value;
      field.couplingBase = value;
      document.getElementById('c-coupling').value = String(value);
      syncRangeLabel('c-coupling', 'coupling', value);
    },
    setNoise(value) {
      state.noise = value;
      document.getElementById('c-noise').value = String(value);
      syncRangeLabel('c-noise', 'noise', value);
    },
    computeDisagreement: (target) => localDisagreement(field, target),
    /**
     * Put the field in a named, reproducible state for golden screenshots.
     * Each pose is seeded and deterministic, and callers pause the clock before
     * capturing; without a seed the phases come from wall time and no image
     * could ever match twice.
     */
    async settlePose(which) {
      // The readout is driven by played notes, so it otherwise keeps whatever
      // the last interaction showed; a pose is the whole visible state, and
      // without this each golden image enshrined a stale "C#4 · 60.6" on a
      // field nobody had touched.
      readout.note.textContent = '—';
      delete readout.note.dataset.kind;
      switch (which) {
        case 'idle': {
          // Disordered but calm: what a visitor sees first.
          state.seed = 0xc0ffee;
          field.randomize(state.seed);
          field.omegaScale = 1;
          // Let coupling and frequencies evolve a fixed number of steps so the
          // pose is a real state of the system, not a random grid.
          for (let i = 0; i < 400; i++) field.step(1 / 120, { coupling: state.coupling, noise: 0 });
          return 'idle';
        }
        case 'wavefront': {
          // A diagonal travelling wave, matched to the Diagonal frequency map
          // so it is a state the running field actually reaches. A
          // column-only gradient would make every row identical and every
          // neighbour agree, so it would draw as a flat stripe with no
          // structure for the renderer to show.
          state.seed = 0x51ee7;
          field.randomize(state.seed);
          for (let row = 0; row < ROWS; row++) {
            for (let col = 0; col < COLS; col++) {
              const i = field.index(col, row);
              field.phase[i] = wrap((col + row) / 26, 1);
              const crest = Math.abs(((col + row) % 26) - 3);
              field.gain[i] = crest < 2 ? 0.5 : 0;
            }
          }
          return 'wavefront';
        }
        case 'locked': {
          // Fully synchronised: the degenerate case that must still look
          // intentional rather than like a blank rectangle.
          state.seed = 0xa11ce;
          field.randomize(state.seed);
          field.phase.fill(0.25);
          field.gain.fill(0);
          return 'locked';
        }
        case 'chrome': {
          // Control panel only; guards the layout and the select rendering that
          // once displayed an empty Root field.
          return 'chrome';
        }
        default:
          throw new RangeError(`unknown pose: ${which}`);
      }
    },
    /** Pin the look-and-tuning settings a golden image depends on. */
    setVisuals({ palette, scale, root, map }) {
      if (palette !== undefined) {
        state.palette = palette;
        lut = buildLut(palette);
        document.getElementById('c-palette').value = palette;
      }
      if (scale !== undefined) state.scale = scale;
      if (root !== undefined) state.root = root;
      if (map !== undefined) state.map = map;
      document.getElementById('c-scale').value = state.scale;
      document.getElementById('c-root').value = state.root;
      document.getElementById('c-map').value = state.map;
      reTune();
    },
    burst,
    resetDefaults: resetAll,
    lastPlayedMidi: () => (lastPlayed ? lastPlayed.midi : null),
    probeCommands: () => {
      let gainSum = 0;
      for (const gain of field.gain) gainSum += gain;
      return { gainSum, order: field.orderParameter(), commandLog: [...commandLog] };
    },
    enableAudioForTest: enableAudio,
    audioReady: () => audio.ready,
    voiceCount: () => audio.activeVoices(),
    audioContextState: () => (audio.ctx ? audio.ctx.state : 'none'),
    attachAnalyserForTest() {
      if (audio._analyser) return audio._analyser;
      const analyser = audio.ctx.createAnalyser();
      analyser.fftSize = 2048;
      audio.nodes.master.connect(analyser);
      audio._analyser = analyser;
      return analyser;
    },
  };
}

boot();
publishDebugHandle();
