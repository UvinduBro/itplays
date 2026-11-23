// Analyse a decoded song: tempo (BPM), beat grid / downbeat, musical key + mode, rough timbre.
// Pure JS, no libraries. Works on the first ~90 s of the track (after the intro).

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const tick = () => new Promise(r => setTimeout(r, 0));

/** mono, decimated to ~11 kHz (box filter = cheap low-pass), for the segment [start, start+len) seconds */
function monoSegment(buf, start, len) {
  const sr = buf.sampleRate, f = Math.max(1, Math.round(sr / 11025)), sr2 = sr / f;
  const i0 = Math.floor(start * sr), n = Math.floor(Math.min(len * sr, buf.length - i0) / f);
  const out = new Float32Array(n), chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < f; k++) { const j = i0 + i * f + k; for (let c = 0; c < chans.length; c++) s += chans[c][j]; }
    out[i] = s / (f * chans.length);
  }
  return { x: out, sr: sr2 };
}

function onsetEnvelope(x, sr) {
  const hop = Math.round(sr * 0.01), hopSec = hop / sr, n = Math.floor(x.length / hop);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < hop; k++) { const v = x[i * hop + k]; s += v * v; } e[i] = Math.sqrt(s / hop); }
  const d = new Float32Array(n);
  for (let i = 1; i < n; i++) d[i] = Math.max(0, e[i] - e[i - 1]);
  // remove slow trend (moving average ~0.5 s) so only real attacks remain
  const w = 25, out = new Float32Array(n); let acc = 0;
  for (let i = 0; i < n; i++) { acc += d[i]; if (i >= 2 * w + 1) acc -= d[i - 2 * w - 1]; const m = acc / Math.min(i + 1, 2 * w + 1); out[i] = Math.max(0, d[i] - m); }
  return { env: out, hopSec };
}

const lerpAt = (a, t) => { const i = Math.floor(t); if (i < 0 || i + 1 >= a.length) return 0; const f = t - i; return a[i] * (1 - f) + a[i + 1] * f; };

function acfScore(env, lag) {
  let s = 0; const n = env.length - Math.ceil(lag) - 2;
  for (let i = 0; i < n; i++) s += env[i] * lerpAt(env, i + lag);
  return s / Math.max(1, n);
}

/** comb score: sum of onset strength on a beat grid with period P frames and phase ph frames */
function comb(env, P, ph) { let s = 0, c = 0; for (let t = ph; t < env.length - 1; t += P) { s += lerpAt(env, t); c++; } return s / Math.max(1, c); }

function findTempo(env, hopSec) {
  const fpm = 60 / hopSec;                       // frames per minute
  let best = { bpm: 120, sc: -1 };
  for (let bpm = 70; bpm <= 180; bpm += 0.5) {
    const L = fpm / bpm;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.75, 2));
    const sc = (acfScore(env, L) + 0.5 * acfScore(env, 2 * L) + 0.25 * acfScore(env, 4 * L)) * (0.5 + prior);
    if (sc > best.sc) best = { bpm, sc };
  }
  // refine: scan phase too, fine tempo steps -> a long comb is very sensitive to tiny tempo error
  let fine = { bpm: best.bpm, ph: 0, sc: -1 };
  for (let bpm = best.bpm - 0.7; bpm <= best.bpm + 0.7; bpm += 0.02) {
    const P = fpm / bpm;
    for (let ph = 0; ph < P; ph += 1) { const sc = comb(env, P, ph); if (sc > fine.sc) fine = { bpm, ph, sc }; }
  }
  return fine;
}

function findDownbeat(env, P, ph) {
  const sums = [0, 0, 0, 0];
  let k = 0;
  for (let t = ph; t < env.length - 1; t += P, k++) sums[k % 4] += lerpAt(env, t);
  let m = 0; for (let i = 1; i < 4; i++) if (sums[i] > sums[m]) m = i;
  return m;
}

function goertzelPower(x, start, N, k) {
  const w = 2 * Math.PI * k / N, coeff = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) { const win = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); const s = x[start + i] * win + coeff * s1 - s2; s2 = s1; s1 = s; }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

function findKey(x, sr) {
  const N = 4096, frames = Math.min(70, Math.floor(x.length / N) - 1), chroma = new Float64Array(12);
  if (frames < 4) return { pc: 0, mode: 'major', conf: 0 };
  const step = Math.floor((x.length - N) / frames);
  for (let f = 0; f < frames; f++) {
    const st = f * step, local = new Float64Array(12); let tot = 0;
    for (let m = 48; m < 96; m++) {                              // C3 .. B6
      const hz = 440 * Math.pow(2, (m - 69) / 12);
      const p = Math.sqrt(Math.max(0, goertzelPower(x, st, N, hz * N / sr)));
      local[m % 12] += p; tot += p;
    }
    if (tot > 1e-6) for (let i = 0; i < 12; i++) chroma[i] += local[i] / tot;
  }
  let best = { pc: 0, mode: 'major', r: -2 }, second = -2;
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const cm = mean(chroma);
  for (const [mode, prof] of [['major', KS_MAJOR], ['minor', KS_MINOR]]) {
    const pm = mean(prof);
    for (let pc = 0; pc < 12; pc++) {
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < 12; i++) { const a = chroma[(pc + i) % 12] - cm, b = prof[i] - pm; num += a * b; da += a * a; db += b * b; }
      const r = num / Math.sqrt(da * db || 1);
      if (r > best.r) { second = best.r; best = { pc, mode, r }; } else if (r > second) second = r;
    }
  }
  return { pc: best.pc, mode: best.mode, conf: Math.max(0, Math.min(1, (best.r - second) * 6 + 0.3)) };
}

export async function analyse(buf, onProgress = () => {}) {
  const dur = buf.duration;
  const segLen = Math.min(90, dur), segStart = dur > 120 ? 25 : dur > 60 ? Math.min(10, dur - segLen) : 0;
  onProgress('listening…'); await tick();
  const { x, sr } = monoSegment(buf, segStart, segLen);
  const { env, hopSec } = onsetEnvelope(x, sr);
  onProgress('finding the tempo…'); await tick();
  const tp = findTempo(env, hopSec);
  const P = 60 / hopSec / tp.bpm;
  const bar = findDownbeat(env, P, tp.ph);
  const beatSec = 60 / tp.bpm, barSec = beatSec * 4;
  const downbeatAbs = segStart + (tp.ph + bar * P) * hopSec;
  const offset = ((downbeatAbs % barSec) + barSec) % barSec;       // a bar line near the start of the file
  onProgress('finding the key…'); await tick();
  const key = findKey(x, sr);
  let zc = 0; for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) zc++;
  const brightness = zc / x.length;                                 // zero-crossing rate: rough timbre
  return { bpm: tp.bpm, offset, pc: key.pc, mode: key.mode, keyConf: key.conf, brightness, duration: dur };
}

/** turn an analysis into an instrument/scale profile the engine understands (same shape as GENRES entries) */
export function profileFromAnalysis(a, title = 'Track') {
  const minor = a.mode === 'minor';
  const bright = a.brightness > 0.11 ? 2 : a.brightness > 0.06 ? 1 : 0;
  const wave = ['sine', 'triangle', 'sawtooth'][bright];
  const feel = a.bpm < 85 ? 'laid-back' : a.bpm < 115 ? 'mid-tempo' : a.bpm < 135 ? 'upbeat' : 'high-energy';
  const timbre = ['warm', 'balanced', 'bright'][bright];
  return {
    name: 'Track', title, bpm: a.bpm, swing: 0,
    lo: 48 + a.pc,
    scale: minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11],
    wave, detune: bright ? 9 : 5, cutoff: [2200, 3200, 5000][bright], q: 1, attack: a.bpm < 100 ? 0.03 : 0.012, release: a.bpm < 100 ? 0.25 : 0.12,
    leadGain: 0.26, vibrato: a.bpm < 100 ? 8 : 3, reverb: 0.3, delay: 0.25,
    prog: [0], chord: [0, minor ? 3 : 4, 7], padWave: 'sine', padGain: 0,
    bassWave: 'sine', bassGain: 0, bass: '................',
    kit: 'none', kick: '................', snare: '................', hat: '................',
    hue: (a.pc * 30 + 200) % 360,
    info: { key: NOTE_NAMES[a.pc] + ' ' + a.mode, feel, timbre },
  };
}
