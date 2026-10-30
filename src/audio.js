import { midiToFreq } from './music.js';

const LOOKAHEAD_SECONDS = 0.12;
const MASTER_BUSS = 'master';

/**
 * Web Audio backend: a plucked/carved synthesis chain (modulated sine +
 * sub + filtered noise transient) into a feedback-delay ambuss, so the room
 * itself is stereo. Everything time-critical is scheduled on the audio clock;
 * the animation loop only pushes events slightly into the future.
 *
 */
export class AudioEngine {
  constructor({ maxVoices = 12 } = {}) {
    this.ctx = null;
    this.ready = false;
    this.maxVoices = maxVoices;
    this._voices = [];
  }

  async init() {
    if (this.ctx) return this.ready;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio is not available in this browser');
    const ctx = new Ctor({ latencyHint: 'interactive' });
    const master = ctx.createGain();
    master.gain.value = 0.7;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.18;

    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const delayL = ctx.createDelay(2);
    delayL.delayTime.value = 0.19;
    const delayR = ctx.createDelay(2);
    delayR.delayTime.value = 0.271;
    const crossLR = ctx.createGain();
    const crossRL = ctx.createGain();
    const dampL = ctx.createBiquadFilter();
    const dampR = ctx.createBiquadFilter();
    dampL.type = dampR.type = 'lowpass';
    dampL.frequency.value = dampR.frequency.value = 2600;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.42;
    const send = ctx.createGain();
    send.gain.value = 0.3;
    const returnL = ctx.createGain();
    const returnR = ctx.createGain();
    returnL.gain.value = returnR.gain.value = 0.85;

    master.connect(limiter);
    limiter.connect(ctx.destination);

    send.connect(splitter);
    splitter.connect(crossLR, 0);
    splitter.connect(crossRL, 1);
    crossLR.gain.value = 0.45;
    crossRL.gain.value = 0.45;
    crossLR.connect(delayL);
    crossRL.connect(delayR);
    delayL.connect(dampL);
    delayR.connect(dampR);
    dampL.connect(feedback);
    dampR.connect(feedback);
    feedback.connect(crossLR);
    feedback.connect(crossRL);
    dampL.connect(returnL);
    dampR.connect(returnR);
    returnL.connect(merger, 0, 0);
    returnR.connect(merger, 0, 1);
    merger.connect(master);

    const convolver = ctx.createConvolver();
    convolver.buffer = this._impulseResponse(ctx, 2.6, 3.2);
    const reverbReturn = ctx.createGain();
    reverbReturn.gain.value = 0.5;
    send.connect(convolver);
    convolver.connect(reverbReturn);
    reverbReturn.connect(master);

    this.ctx = ctx;
    this.nodes = { master, send, feedback, reverbReturn };
    this.ready = true;
    return true;
  }

  _impulseResponse(ctx, seconds, decay) {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
    }
    return buffer;
  }

  /**
   * Start or resume the context. Browsers with no usable output device leave
   * the context `suspended` and may never settle `resume()`, so the wait is
   * bounded: the caller learns whether sound is actually available instead of
   * awaiting a promise that never resolves.
   */
  async resume(timeoutMs = 1500) {
    if (!this.ctx) await this.init();
    if (this.ctx.state === 'suspended') {
      await Promise.race([
        this.ctx.resume().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }
    return this.ctx.state === 'running';
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  setMasterVolume(value) {
    if (this.nodes) this.nodes.master.gain.value = value;
  }

  setSpace(value) {
    if (!this.nodes) return;
    this.nodes.send.gain.value = value;
    this.nodes.feedback.gain.value = 0.55 * value;
  }

  /**
   * @param {{midi:number, velocity:number, pan:number, duration:number|null}} note
   * @returns {{when:number, duration:number, stopAt:number}|null} null when the
   *   voice budget is full, so the caller can drop the note rather than queue
   *   a backlog that would arrive late as a cluster.
   */
  playNote(note) {
    if (!this.ready) return null;
    if (this._voices.length >= this.maxVoices) return null;
    const ctx = this.ctx;
    const when = Math.max(ctx.currentTime + 0.002, note.at ?? ctx.currentTime + LOOKAHEAD_SECONDS);
    const freq = midiToFreq(note.midi);
    const velocity = Math.max(0.02, Math.min(1, note.velocity));
    const duration = note.duration ?? this._durationForMidi(note.midi);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, when);
    const peak = 0.26 * velocity;
    amp.gain.linearRampToValueAtTime(peak, when + 0.006);
    amp.gain.exponentialRampToValueAtTime(peak * 0.28, when + duration * 0.35);
    amp.gain.exponentialRampToValueAtTime(0.0001, when + duration);

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, note.pan ?? 0));
    amp.connect(panner);
    panner.connect(this.nodes.master);
    panner.connect(this.nodes.send);

    const carriers = [
      { ratio: 1, gain: 1, type: 'sine' },
      { ratio: 2.01, gain: 0.32, type: 'sine' },
      { ratio: 0.5, gain: 0.4, type: 'triangle' },
    ];
    const sources = [];
    for (const carrier of carriers) {
      const osc = ctx.createOscillator();
      osc.type = carrier.type;
      osc.frequency.setValueAtTime(freq * carrier.ratio, when);
      const gain = ctx.createGain();
      gain.gain.value = carrier.gain;
      osc.connect(gain);
      gain.connect(amp);
      sources.push(osc);
    }

    // Slow detune sweep gives the tail movement without going sharp.
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 4.2 + (note.midi % 7);
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = freq * 0.004;
    wobble.connect(wobbleDepth);
    wobbleDepth.connect(sources[0].frequency);
    sources.push(wobble);

    const transient = this._noiseBurst(ctx, when, freq);
    if (transient) {
      const transientGain = ctx.createGain();
      transientGain.gain.setValueAtTime(0.16 * velocity, when);
      transientGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
      transient.connect(transientGain);
      transientGain.connect(amp);
    }

    const stopAt = when + duration + 0.05;
    for (const source of sources) {
      source.start(when);
      source.stop(stopAt);
    }
    this._reap(stopAt, amp);
    return { when, duration, stopAt };
  }

  _noiseBurst(ctx, when, freq) {
    const length = Math.floor(ctx.sampleRate * 0.08);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = Math.min(12000, freq * 6);
    band.Q.value = 1.4;
    src.connect(band);
    src.start(when);
    src.stop(when + 0.09);
    return band;
  }

  /** Long notes down low, short ticks up high: keeps the texture legible. */
  _durationForMidi(midi) {
    const clamped = Math.max(24, Math.min(108, midi));
    return Math.max(0.18, 3.4 * Math.pow(2, (54 - clamped) / 14));
  }

  _reap(at, node) {
    const timeout = (at - this.ctx.currentTime + 0.25) * 1000;
    const id = setTimeout(() => {
      node.disconnect();
      this._voices = this._voices.filter((entry) => entry !== id);
    }, Math.max(0, timeout));
    this._voices.push(id);
  }

  /** Voices currently scheduled and not yet reaped. */
  activeVoices() {
    return this._voices.length;
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') return this.ctx.suspend();
    return Promise.resolve();
  }
}
