import { GENRES, RANGE, BARS } from './genres.js';

const STEPS = BARS * 16;
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

export class Engine {
  constructor() {
    this.ctx = null;
    this.genre = GENRES.lofi;
    this.bpm = this.genre.bpm;
    this.quantize = true;
    this.playing = false;
    this.voices = new Map();
    this.stepLog = [];
    this.nextStep = 0;
    this.nextTime = 0;
    this.lastPos = 0;
  }

  init() {
    if (this.ctx) return;
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    this.master = ctx.createGain(); this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.recDest = ctx.createMediaStreamDestination();   // tap for recording
    comp.connect(this.recDest);

    // FX sends
    this.leadBus = ctx.createGain();
    this.dry = ctx.createGain();
    this.leadBus.connect(this.dry).connect(this.master);

    this.delay = ctx.createDelay(2);
    this.delayFb = ctx.createGain(); this.delayFb.gain.value = 0.38;
    this.delaySend = ctx.createGain();
    this.leadBus.connect(this.delaySend).connect(this.delay);
    this.delay.connect(this.delayFb).connect(this.delay);
    const dLP = ctx.createBiquadFilter(); dLP.type = 'lowpass'; dLP.frequency.value = 3200;
    this.delay.connect(dLP).connect(this.master);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.6);
    this.reverbSend = ctx.createGain();
    this.reverbOut = ctx.createGain(); this.reverbOut.gain.value = 0.8;
    this.leadBus.connect(this.reverbSend).connect(this.reverb).connect(this.reverbOut).connect(this.master);

    this.bandBus = ctx.createGain(); this.bandBus.gain.value = 0.8;
    this.bandBus.connect(this.master);
    this.bandBus.connect(this.reverbSend);   // a touch of room on the band too

    // shared vibrato LFO
    this.vib = ctx.createGain();
    const lfo = ctx.createOscillator(); lfo.frequency.value = 5.2;
    lfo.connect(this.vib); lfo.start();

    // shared noise for drums
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this.setGenre(this.genre);
  }

  _impulse(sec) {
    const ctx = this.ctx, n = Math.floor(ctx.sampleRate * sec);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.5);
    }
    return b;
  }

  setGenre(g, keepBpm = false) {
    this.genre = g;
    if (!keepBpm) this.bpm = g.bpm;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.reverbSend.gain.setTargetAtTime(g.reverb, t, 0.05);
    this.delaySend.gain.setTargetAtTime(g.delay, t, 0.05);
    this.vib.gain.setTargetAtTime(g.vibrato, t, 0.05);
    this._syncDelayTime();
    for (const id of [...this.voices.keys()]) this._stopVoice(id, true); // restart with new timbre
  }

  setBpm(b) { this.bpm = b; this._syncDelayTime(); }
  _syncDelayTime() {
    if (this.ctx) this.delay.delayTime.setTargetAtTime(60 / this.bpm * 0.75, this.ctx.currentTime, 0.05);
  }

  // ---------- transport ----------
  play() {
    if (!this.ctx || this.playing) return;
    this.ctx.resume();
    this.playing = true;
    this.nextTime = this.ctx.currentTime + 0.05;
    this.nextStep = Math.floor(this.lastPos * STEPS) % STEPS;
    this.timer = setInterval(() => this._schedule(), 25);
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    this.stepLog.length = 0;
    this.releaseAll();
  }

  _schedule() {
    const ctx = this.ctx;
    while (this.nextTime < ctx.currentTime + 0.12) {
      const dur = 60 / this.bpm / 4;
      this.stepLog.push({ t: this.nextTime, idx: this.nextStep, dur });
      this._playStep(this.nextStep, this.nextTime + (this.nextStep % 2 ? this.genre.swing * dur : 0), dur);
      this.nextTime += dur;
      this.nextStep = (this.nextStep + 1) % STEPS;
    }
    while (this.stepLog.length > 64) this.stepLog.shift();
  }

  /** Playhead position 0..1 across the loop. */
  position() {
    if (!this.playing) return this.lastPos;
    const now = this.ctx.currentTime;
    let e = null;
    for (const s of this.stepLog) if (s.t <= now) e = s; else break;
    if (!e) return this.lastPos;
    const frac = Math.min(1, (now - e.t) / e.dur);
    return (this.lastPos = (e.idx + frac) / STEPS);
  }

  // ---------- pitch mapping ----------
  /** y (0 top .. 1 bottom) -> midi note (optionally snapped to the genre scale). */
  yToMidi(y) {
    const raw = this.genre.lo + (1 - y) * RANGE;
    if (!this.quantize) return raw;
    const sc = this.genre.scale;
    let best = raw, bd = 1e9;
    for (let o = -1; o <= Math.ceil(RANGE / 12) + 1; o++) {
      for (const s of sc) {
        const m = this.genre.lo + o * 12 + s;
        const d = Math.abs(m - raw);
        if (d < bd) { bd = d; best = m; }
      }
    }
    return best;
  }

  // ---------- lead voices (one per stroke + one for the live pen) ----------
  setVoice(id, midi, vol = 1) {
    if (!this.ctx) return;
    if (midi == null) { this._stopVoice(id); return; }
    let v = this.voices.get(id), fresh = false;
    if (!v) { v = this._startVoice(id, midi); fresh = true; }
    const t = this.ctx.currentTime, f = mtof(midi), gn = this.genre;
    v.a.gain.setTargetAtTime(gn.leadGain * vol, t, fresh ? Math.max(0.004, gn.attack / 3) : 0.04);
    v.o1.frequency.setTargetAtTime(f, t, this.quantize ? 0.012 : 0.03);
    v.o2.frequency.setTargetAtTime(f, t, this.quantize ? 0.012 : 0.03);
  }

  _startVoice(id, midi) {
    const ctx = this.ctx, g = this.genre, t = ctx.currentTime;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = o2.type = g.wave;
    o2.detune.value = g.detune;
    o1.frequency.value = o2.frequency.value = mtof(midi);
    this.vib.connect(o1.detune); this.vib.connect(o2.detune);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = g.cutoff; f.Q.value = g.q;
    const a = ctx.createGain(); a.gain.value = 0;
    o1.connect(f); o2.connect(f); f.connect(a).connect(this.leadBus);
    o1.start(); o2.start();
    const v = { o1, o2, a, f };
    this.voices.set(id, v);
    return v;
  }

  _stopVoice(id, fast = false) {
    const v = this.voices.get(id); if (!v) return;
    this.voices.delete(id);
    const t = this.ctx.currentTime, r = fast ? 0.03 : this.genre.release / 3;
    v.a.gain.cancelScheduledValues(t);
    v.a.gain.setTargetAtTime(0, t, r);
    const end = t + r * 8 + 0.05;
    v.o1.stop(end); v.o2.stop(end);
    setTimeout(() => { try { this.vib.disconnect(v.o1.detune); this.vib.disconnect(v.o2.detune); } catch {} }, (end - t) * 1000 + 50);
  }

  releaseAll() { for (const id of [...this.voices.keys()]) this._stopVoice(id); }
  releaseExcept(keep) { for (const id of [...this.voices.keys()]) if (!keep.has(id)) this._stopVoice(id); }

  // ---------- backing band ----------
  _playStep(step, t, dur) {
    const g = this.genre, s = step % 16, bar = Math.floor(step / 16) % g.prog.length;
    const root = g.lo - 24 + g.prog[bar];
    if (g.kick[s] === 'x') this._kick(t);
    if (g.snare[s] === 'x') this._snare(t);
    if (g.hat[s] === 'x') this._hat(t, s % 4 === 2 && g.kit !== 'chip');
    if (g.bass[s] === 'x') this._bass(t, root + (s % 8 === 6 && g.kit === 'chip' ? 12 : 0), dur * (g.kit === 'chip' ? 0.9 : (g.bassLen || 1.6)));
    if (s === 0 && g.padGain > 0) this._pad(t, g.lo - 12 + g.prog[bar], dur * 16);
  }

  _env(node, t, peak, decay, attack = 0.002) {
    node.gain.setValueAtTime(0, t);
    node.gain.linearRampToValueAtTime(peak, t + attack);
    node.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  _kick(t) {
    const kit = this.genre.kit, ctx = this.ctx;
    const o = ctx.createOscillator(), a = ctx.createGain();
    o.type = kit === 'chip' ? 'triangle' : 'sine';
    const top = kit === 'hard' ? 170 : kit === 'chip' ? 220 : 120;
    o.frequency.setValueAtTime(top, t);
    o.frequency.exponentialRampToValueAtTime(42, t + (kit === 'chip' ? 0.09 : 0.14));
    this._env(a, t, kit === 'soft' ? 0.7 : 0.95, kit === 'hard' ? 0.32 : 0.22);
    o.connect(a).connect(this.bandBus); o.start(t); o.stop(t + 0.5);
  }

  _snare(t) {
    const kit = this.genre.kit, ctx = this.ctx;
    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const bp = ctx.createBiquadFilter(); bp.type = kit === 'chip' ? 'highpass' : 'bandpass';
    bp.frequency.value = kit === 'soft' ? 1800 : 2800; bp.Q.value = 0.8;
    const a = ctx.createGain(); this._env(a, t, kit === 'soft' ? 0.28 : 0.45, kit === 'chip' ? 0.09 : 0.18);
    n.connect(bp).connect(a).connect(this.bandBus); n.start(t, Math.random() * 0.5, 0.4);
    if (kit !== 'chip') {
      const o = ctx.createOscillator(), oa = ctx.createGain();
      o.type = 'triangle'; o.frequency.setValueAtTime(200, t); o.frequency.exponentialRampToValueAtTime(130, t + 0.08);
      this._env(oa, t, 0.25, 0.1); o.connect(oa).connect(this.bandBus); o.start(t); o.stop(t + 0.2);
    }
  }

  _hat(t, open) {
    const kit = this.genre.kit, ctx = this.ctx;
    const n = ctx.createBufferSource(); n.buffer = this.noise;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = kit === 'chip' ? 5000 : 7500;
    const a = ctx.createGain();
    this._env(a, t, kit === 'soft' ? 0.1 : 0.16, open ? 0.2 : 0.045);
    n.connect(hp).connect(a).connect(this.bandBus); n.start(t, Math.random() * 0.5, 0.3);
  }

  _bass(t, midi, len) {
    const g = this.genre, ctx = this.ctx;
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), a = ctx.createGain();
    o.type = g.bassWave; o.frequency.value = mtof(midi);
    f.type = 'lowpass'; f.frequency.setValueAtTime(900, t); f.frequency.exponentialRampToValueAtTime(200, t + len); f.Q.value = 3;
    this._env(a, t, g.bassGain, len, 0.005);
    o.connect(f).connect(a).connect(this.bandBus); o.start(t); o.stop(t + len + 0.1);
  }

  _pad(t, root, len) {
    const g = this.genre, ctx = this.ctx;
    const a = ctx.createGain(), f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 1400;
    a.gain.setValueAtTime(0, t);
    a.gain.linearRampToValueAtTime(g.padGain, t + Math.min(0.6, len / 3));
    a.gain.setTargetAtTime(0, t + len * 0.85, 0.15);
    for (const iv of g.chord) {
      for (const dt of [-6, 6]) {
        const o = ctx.createOscillator(); o.type = g.padWave;
        o.frequency.value = mtof(root + 12 + iv); o.detune.value = dt;
        o.connect(f); o.start(t); o.stop(t + len + 0.8);
      }
    }
    f.connect(a).connect(this.bandBus);
  }
}
