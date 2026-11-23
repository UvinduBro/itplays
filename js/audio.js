import { GENRES, RANGE, BARS } from './genres.js';

const STEPS = BARS * 16;

// 'sustain' instruments hold a note and glide with your pen; 'event' instruments are struck (piano, guitar)
export const INSTRUMENTS = {
  synth:   { name: 'Synth (genre)', mode: 'sustain' },
  piano:   { name: 'Piano',   mode: 'event' },
  guitar:  { name: 'Guitar',  mode: 'event' },
  strings: { name: 'Strings', mode: 'sustain', wave: 'sawtooth', detune: 14, cutoff: 2300, q: 0.4, attack: 0.28, release: 0.6, gain: 0.17, vibrato: 6 },
  flute:   { name: 'Flute',   mode: 'sustain', wave: 'sine', detune: 3, cutoff: 5200, q: 0.3, attack: 0.07, release: 0.18, gain: 0.30, vibrato: 5, breath: true },
};
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
    this.inst = 'synth';
    this.harmony = 'off';        // off | third | chord | octave
    this.provider = null;        // pos(0..1) -> [{id, midi, vel}] of strokes under the playhead (for struck instruments)
    this.lastTrig = new Map();
    this.pluckCache = new Map();
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
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 1024;   // output level meter
    comp.connect(this.analyser);
    this._lvl = new Float32Array(1024);
    this._drive = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; this._drive[i] = Math.tanh(2.6 * x) / Math.tanh(2.6); }
    this.trackBus = ctx.createGain(); this.trackBus.gain.value = 0.9;     // a loaded song plays here
    this.trackBus.connect(this.master);
    ctx.onstatechange = () => this.onState && this.onState(ctx.state);

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
      const d = b.getChannelData(c), pre = Math.floor(ctx.sampleRate * 0.012);
      for (let i = pre; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.5);
      // early reflections: a few discrete bounces make it sound like a room, not just a wash
      for (const [ms, g] of [[17, 0.7], [29, 0.55], [43, 0.45], [61, 0.35], [83, 0.25]]) {
        const k = Math.floor(ctx.sampleRate * (ms + c * 3.1) / 1000); if (k < n) d[k] += g * (c ? -1 : 1);
      }
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
    this._applyVib();
    this._syncDelayTime();
    for (const id of [...this.voices.keys()]) this._stopVoice(id, true); // restart with new timbre
  }

  _P() {   // lead voice parameters: the genre's, or overridden by a sustained instrument
    const sp = INSTRUMENTS[this.inst], g = this.genre;
    return sp.mode === 'sustain' && sp.wave
      ? { ...g, wave: sp.wave, detune: sp.detune, cutoff: sp.cutoff, q: sp.q, attack: sp.attack, release: sp.release, leadGain: sp.gain, breath: sp.breath }
      : g;
  }
  _applyVib() { if (this.ctx) this.vib.gain.setTargetAtTime(INSTRUMENTS[this.inst].vibrato ?? this.genre.vibrato, this.ctx.currentTime, 0.05); }
  instMode() { return INSTRUMENTS[this.inst].mode; }
  setInstrument(k) { if (!INSTRUMENTS[k]) return; this.inst = k; this.lastTrig.clear(); if (this.ctx) { this.releaseAll(); this._applyVib(); } }
  setHarmony(h) { this.harmony = h; if (this.ctx) this.releaseAll(); }
  _scaleList() {
    const g = this.genre, out = [];
    for (let o = -3; o <= 6; o++) for (const s of g.scale) out.push(g.lo + o * 12 + s);
    return out.sort((x, y) => x - y);
  }
  /** extra notes to play with `m` (diatonic: stays in the scale) */
  harmonize(m) {
    if (this.harmony === 'off') return [];
    if (this.harmony === 'octave') return [m - 12];
    const L = this._scaleList(); let i = 0, bd = 1e9;
    for (let k = 0; k < L.length; k++) { const d = Math.abs(L[k] - m); if (d < bd) { bd = d; i = k; } }
    const out = [L[i + 2]]; if (this.harmony === 'chord') out.push(L[i + 4]);
    return out.filter(x => x != null);
  }

  setBpm(b) { this.bpm = b; this._syncDelayTime(); }
  _syncDelayTime() {
    if (this.ctx) this.delay.delayTime.setTargetAtTime(60 / this.bpm * 0.75, this.ctx.currentTime, 0.05);
  }

  // ---------- transport ----------
  /** output level 0..1 (peak of the last ~20 ms) */
  level() {
    if (!this.ctx) return 0;
    this.analyser.getFloatTimeDomainData(this._lvl);
    let m = 0; for (const v of this._lvl) { const a = Math.abs(v); if (a > m) m = a; }
    return m;
  }

  /** short confirmation arpeggio so you can hear that audio works */
  blip() {
    if (!this.ctx) return;
    const ctx = this.ctx, t0 = ctx.currentTime + 0.02;
    [0, 4, 7, 12].forEach((iv, i) => {
      const o = ctx.createOscillator(), a = ctx.createGain();
      o.type = 'triangle'; o.frequency.value = mtof(72 + iv);
      this._env(a, t0 + i * 0.09, 0.22, 0.3); o.connect(a).connect(this.master); o.start(t0 + i * 0.09); o.stop(t0 + i * 0.09 + 0.4);
    });
  }

  // ---------- a loaded song ----------
  setTrack(buffer, offset) {
    this.stopTrack(); this.track = buffer ? { buffer, offset } : null; this.trackPending = !!buffer;
    if (buffer && this.playing) {          // restart the loop now so the song starts on beat 1 straight away
      this.nextStep = 0; this.nextTime = this.ctx.currentTime + 0.08; this.stepLog.length = 0; this.lastPos = 0;
    }
  }
  /** restart the loop so step 0 lands at ctx time `t` (used to lock onto a song playing elsewhere) */
  alignLoopAt(t) {
    if (!this.ctx) return;
    this.nextStep = 0; this.nextTime = Math.max(t, this.ctx.currentTime + 0.05); this.stepLog.length = 0; this.lastPos = 0;
  }
  setTrackVolume(v) { if (this.ctx) this.trackBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03); }
  stopTrack() { if (this.trackSrc) { try { this.trackSrc.stop(); } catch {} this.trackSrc = null; } }
  _startTrackAt(t) {
    this.stopTrack();
    const s = this.ctx.createBufferSource();
    s.buffer = this.track.buffer; s.connect(this.trackBus);
    s.start(t, this.track.offset);
    this.trackSrc = s; this.trackPending = false;
  }

  play() {
    if (!this.ctx) return;
    this.ctx.resume();
    if (this.playing) return;
    if (this.track) this.trackPending = true;
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
    this.stopTrack();
    this.releaseAll();
  }

  _schedule() {
    const ctx = this.ctx;
    while (this.nextTime < ctx.currentTime + 0.12) {
      const dur = 60 / this.bpm / 4;
      if (this.nextStep === 0 && this.track && this.trackPending) this._startTrackAt(this.nextTime);   // song's bar line == loop start
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
    const t = this.ctx.currentTime, f = mtof(midi), gn = this._P();
    v.a.gain.setTargetAtTime(gn.leadGain * vol, t, fresh ? Math.max(0.004, gn.attack / 3) : 0.04);
    v.o1.frequency.setTargetAtTime(f, t, this.quantize ? 0.012 : 0.03);
    v.o2.frequency.setTargetAtTime(f, t, this.quantize ? 0.012 : 0.03);
  }

  _startVoice(id, midi) {
    const ctx = this.ctx, g = this._P(), t = ctx.currentTime;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
    o1.type = o2.type = g.wave;
    o2.detune.value = g.detune;
    o1.frequency.value = o2.frequency.value = mtof(midi);
    this.vib.connect(o1.detune); this.vib.connect(o2.detune);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = g.cutoff; f.Q.value = g.q;
    const a = ctx.createGain(); a.gain.value = 0;
    o1.connect(f); o2.connect(f); f.connect(a).connect(this.leadBus);
    o1.start(); o2.start();
    const v = { o1, o2, a, f, extra: [] };
    if (g.breath) {   // flute: a little breath noise around the pitch
      const n = ctx.createBufferSource(); n.buffer = this.noise; n.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = mtof(midi) * 2; bp.Q.value = 1.2;
      const ng = ctx.createGain(); ng.gain.value = 0.05;
      n.connect(bp).connect(ng).connect(a); n.start(); v.extra.push(n, bp);
    }
    this.voices.set(id, v);
    return v;
  }

  _stopVoice(id, fast = false) {
    const v = this.voices.get(id); if (!v) return;
    this.voices.delete(id);
    const t = this.ctx.currentTime, r = fast ? 0.03 : this._P().release / 3;
    v.a.gain.cancelScheduledValues(t);
    v.a.gain.setTargetAtTime(0, t, r);
    const end = t + r * 8 + 0.05;
    v.o1.stop(end); v.o2.stop(end);
    for (const n of v.extra) { try { if (n.stop) n.stop(end); } catch {} }
    setTimeout(() => { try { this.vib.disconnect(v.o1.detune); this.vib.disconnect(v.o2.detune); } catch {} }, (end - t) * 1000 + 50);
  }

  releaseAll() { for (const id of [...this.voices.keys()]) this._stopVoice(id); }
  releaseExcept(keep) { for (const id of [...this.voices.keys()]) if (!keep.has(id)) this._stopVoice(id); }

  // ---------- backing band ----------
  _playStep(step, t, dur) {
    const g = this.genre, s = step % 16, bar = Math.floor(step / 16) % g.prog.length;
    const root = g.lo - 24 + g.prog[bar];
    const hv = () => 0.88 + Math.random() * 0.24;                 // humanise: velocity
    const jt = ms => (Math.random() - 0.5) * ms / 1000;            // humanise: timing
    if (g.kick[s] === 'x') this._kick(t, hv());
    if (g.snare[s] === 'x') this._snare(t + jt(6), hv());
    else if (g.kit === 'soft' && (s === 7 || s === 15) && Math.random() < 0.28) this._snare(t + jt(6), 0.22);   // ghost note
    if (g.hat[s] === 'x') this._hat(t + jt(8), s % 4 === 2 && g.kit !== 'chip', (s % 4 === 0 ? 1 : 0.68) * hv());
    if (g.bass[s] === 'x') this._bass(t, root + (s % 8 === 6 && g.kit === 'chip' ? 12 : 0), dur * (g.kit === 'chip' ? 0.9 : (g.bassLen || 1.6)));
    if (s === 0 && g.padGain > 0) this._pad(t, g.lo - 12 + g.prog[bar], dur * 16);
    if (this.provider && this.instMode() === 'event') this._events(step, t);
  }

  // struck instruments: start a note when a stroke's pitch changes, or every 8th note while it is held
  _events(step, t) {
    const acts = this.provider(step / STEPS);
    for (const a of acts) {
      const m = Math.round(a.midi * 4) / 4, last = this.lastTrig.get(a.id);
      if (last && last.m === m && ((step - last.step + STEPS) % STEPS) < 2) continue;
      this.lastTrig.set(a.id, { m, step });
      this._struck(t, a.midi, a.vel);
      for (const h of this.harmonize(a.midi)) this._struck(t + 0.012, h, a.vel * 0.62);
    }
  }
  _struck(t, midi, vel) { if (this.inst === 'piano') this._piano(t, midi, vel); else this._pluck(t, midi, vel); }

  _piano(t, midi, vel) {
    const ctx = this.ctx, f = mtof(midi);
    const out = ctx.createGain(); out.gain.value = 0.26 * (0.35 + vel * 0.9);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(11000, 1500 + vel * 5200 + f * 2.2); lp.Q.value = 0.3;
    const dec = Math.max(0.7, 3.1 - Math.max(0, midi - 30) / 36 * 2.2);               // low notes ring longer
    const parts = [[1, 1], [2, 0.62], [3, 0.4], [4, 0.26], [5, 0.17], [6, 0.11], [7, 0.07]];
    for (const [n, amp] of parts) {
      const o = ctx.createOscillator(), g = ctx.createGain(), inh = Math.sqrt(1 + 0.00035 * n * n);
      o.type = 'sine'; o.frequency.value = f * n * inh;
      const d = dec / (1 + 0.7 * (n - 1));
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(amp, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(lp); o.start(t); o.stop(t + d + 0.05);
      if (n === 1) {   // second, slightly detuned string = the shimmer of a real piano
        const o2 = ctx.createOscillator(), g2 = ctx.createGain(); o2.type = 'sine'; o2.frequency.value = f * 1.0012;
        g2.gain.setValueAtTime(0, t); g2.gain.linearRampToValueAtTime(0.5, t + 0.003); g2.gain.exponentialRampToValueAtTime(0.0001, t + d * 0.9);
        o2.connect(g2).connect(lp); o2.start(t); o2.stop(t + d + 0.05);
      }
    }
    const n = ctx.createBufferSource(); n.buffer = this.noise;      // hammer thump
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = Math.min(5000, f * 3); bp.Q.value = 0.9;
    const ng = ctx.createGain(); this._env(ng, t, 0.22 * vel, 0.03, 0.001);
    n.connect(bp).connect(ng).connect(lp); n.start(t, Math.random() * 0.5, 0.05);
    lp.connect(out).connect(this.leadBus);
    setTimeout(() => { try { out.disconnect(); } catch {} }, (dec + 0.3) * 1000);
  }

  // Karplus-Strong plucked string, rendered to a buffer (the web audio feedback delay can't go above ~340 Hz)
  _pluckBuf(midi, vel) {
    const key = Math.round(midi * 4) + ':' + (vel > 0.75 ? 2 : vel > 0.5 ? 1 : 0);
    let b = this.pluckCache.get(key); if (b) return b;
    const sr = this.ctx.sampleRate, f = mtof(Math.round(midi * 4) / 4);
    const T = Math.max(0.6, Math.min(2.6, 3.2 - midi / 38)), n = Math.floor(sr * T);
    const P = sr / f, D = P - 0.5, Di = Math.floor(D), fr = D - Di;
    const y = new Float32Array(n), bright = 0.45 + 0.45 * Math.min(1, vel);
    let lp = 0;
    for (let i = 0; i <= Di + 2 && i < n; i++) { lp += bright * ((Math.random() * 2 - 1) - lp); y[i] = lp * 1.7; }   // the pick
    const gl = Math.pow(0.002, 1 / (f * T * 1.5));
    for (let i = Di + 3; i < n; i++) {
      const a = 0.5 * (y[i - Di] + y[i - Di - 1]), c = 0.5 * (y[i - Di - 1] + y[i - Di - 2]);
      y[i] = gl * ((1 - fr) * a + fr * c);
    }
    let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(y[i]));
    const fade = Math.floor(sr * 0.05);
    for (let i = 0; i < n; i++) y[i] = y[i] / (pk || 1) * (i > n - fade ? (n - i) / fade : 1);
    b = this.ctx.createBuffer(1, n, sr); b.copyToChannel(y, 0);
    if (this.pluckCache.size > 80) this.pluckCache.delete(this.pluckCache.keys().next().value);
    this.pluckCache.set(key, b);
    return b;
  }
  _pluck(t, midi, vel) {
    const ctx = this.ctx, s = ctx.createBufferSource(); s.buffer = this._pluckBuf(midi, vel);
    const g = ctx.createGain(); g.gain.value = 0.42 * (0.4 + vel * 0.8);
    const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 210; body.gain.value = 4; body.Q.value = 1;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
    s.connect(body).connect(lp).connect(g).connect(this.leadBus); s.start(t);
  }

  _env(node, t, peak, decay, attack = 0.002) {
    node.gain.setValueAtTime(0, t);
    node.gain.linearRampToValueAtTime(peak, t + attack);
    node.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  _noiseHit(t, type, freq, q, peak, decay, dest) {
    const ctx = this.ctx, n = ctx.createBufferSource(); n.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const a = ctx.createGain(); this._env(a, t, peak, decay, 0.001);
    n.connect(f).connect(a).connect(dest || this.bandBus); n.start(t, Math.random() * 0.5, decay + 0.05);
  }

  _kick(t, v = 1) {
    const kit = this.genre.kit, ctx = this.ctx;
    if (kit === 'none') return;
    const o = ctx.createOscillator(), a = ctx.createGain();
    o.type = kit === 'chip' ? 'triangle' : 'sine';
    o.frequency.setValueAtTime(kit === 'hard' ? 190 : kit === 'chip' ? 220 : 130, t);
    o.frequency.exponentialRampToValueAtTime(48, t + (kit === 'chip' ? 0.09 : 0.11));
    o.frequency.exponentialRampToValueAtTime(40, t + 0.4);
    this._env(a, t, (kit === 'soft' ? 0.7 : 0.95) * v, kit === 'hard' ? 0.34 : 0.24);
    o.connect(a);
    if (kit === 'hard') { const ws = ctx.createWaveShaper(); ws.curve = this._drive; a.connect(ws).connect(this.bandBus); } else a.connect(this.bandBus);
    o.start(t); o.stop(t + 0.5);
    if (kit !== 'chip') this._noiseHit(t, 'highpass', 1800, 0.7, 0.22 * v, 0.012);          // beater click
  }

  _snare(t, v = 1) {
    const kit = this.genre.kit, ctx = this.ctx;
    if (kit === 'none') return;
    if (kit === 'hard') {                                                                        // clap = a few quick noise bursts
      [0, 0.011, 0.023].forEach((d, i) => this._noiseHit(t + d, 'bandpass', 1500, 1.1, 0.34 * v, i === 2 ? 0.16 : 0.02));
      return;
    }
    if (kit === 'chip') { this._noiseHit(t, 'highpass', 2800, 0.7, 0.4 * v, 0.09); return; }
    this._noiseHit(t, 'bandpass', 2300, 0.8, (kit === 'soft' ? 0.26 : 0.4) * v, 0.17);       // snares
    [[185, 0.1], [330, 0.07]].forEach(([f, d]) => {                                               // shell
      const o = ctx.createOscillator(), a = ctx.createGain(); o.type = 'triangle';
      o.frequency.setValueAtTime(f * 1.25, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
      this._env(a, t, 0.2 * v, d); o.connect(a).connect(this.bandBus); o.start(t); o.stop(t + 0.2);
    });
  }

  _hat(t, open, v = 1) {
    const kit = this.genre.kit, ctx = this.ctx;
    if (kit === 'none') return;
    if (kit === 'chip') { this._noiseHit(t, 'highpass', 5000, 0.7, 0.14 * v, 0.045); return; }
    // metallic: six detuned square waves (the classic cymbal recipe) through high-pass + band-pass
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 10000; bp.Q.value = 0.6;
    const a = ctx.createGain(), dec = open ? 0.24 : 0.05;
    this._env(a, t, (kit === 'soft' ? 0.05 : 0.08) * v, dec, 0.001);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null; if (pan) pan.pan.value = 0.25;
    for (const r of [1, 1.4471, 1.617, 1.9265, 2.5028, 2.6637]) {
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 205.3 * r;
      o.connect(bp); o.start(t); o.stop(t + dec + 0.05);
    }
    bp.connect(hp).connect(a); if (pan) a.connect(pan).connect(this.bandBus); else a.connect(this.bandBus);
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
