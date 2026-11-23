import { Engine, INSTRUMENTS } from './audio.js';
import { GENRES, GENRE_ORDER, RANGE, BARS } from './genres.js';
import { startHand } from './hand.js';
import { analyse, profileFromAnalysis, NOTE_NAMES } from './track.js';

const $ = id => document.getElementById(id);
const canvas = $('stage'), g = canvas.getContext('2d');
const engine = new Engine();

const state = {
  strokes: [],            // { id, pts:[{x,y}] }   coords normalised 0..1, y=0 is top (high pitch)
  current: null,          // stroke being drawn
  nextId: 1,
  genreKey: 'lofi',
  pen: { x: 0.5, y: 0.5, visible: false, down: false, source: 'mouse' },
  mouseDown: false,
  erasing: false,
  lastT: 0,
  rec: null,
  hand: null,
  ink: -1,                // >0: beats a stroke lives after the playhead played it; <0: beats it lives after being drawn; Infinity = hold
};

// ---------- ink lifetime (measured in beats, so it follows the tempo) ----------
const LOOP_BEATS = BARS * 4;
let loops = 0, clock = 0;     // clock = beats since start (loops * 16 + position)
/** when (in beats) the playhead will first reach this point: that is when it sounds, and when it starts to fade */
function stamp(p) {
  const ph = clock % LOOP_BEATS;
  p.tc = clock + (((p.x * LOOP_BEATS - ph) % LOOP_BEATS) + LOOP_BEATS) % LOOP_BEATS;
  p.born = clock;
  return p;
}
const alive = p => state.ink === Infinity || (state.ink < 0 ? clock < p.born - state.ink : clock < p.tc + state.ink);
const particles = [];
window.__scribble = { state, engine };   // handy for debugging / tests

// ---------- genre chips ----------
const chips = $('genres');
for (const k of GENRE_ORDER) {
  const b = document.createElement('button');
  b.className = 'chip'; b.textContent = GENRES[k].name; b.dataset.k = k;
  b.onclick = () => setGenre(k);
  chips.appendChild(b);
}
function setGenre(k) {
  if (k !== 'track' && T.active) clearSong();
  state.genreKey = k;
  engine.setGenre(GENRES[k]);
  $('bpm').value = engine.bpm; $('bpmOut').textContent = engine.bpm;
  for (const c of chips.children) c.classList.toggle('on', c.dataset.k === k);
  save();
}

// ---------- pen (shared by mouse, touch and hand) ----------
function penDown(x, y) {
  state.lastT = performance.now();
  state.current = { id: state.nextId++, pts: [stamp({ x, y, w: 0.7 })] };
  state.strokes.push(state.current);
  $('hint').classList.add('hide');
}
function penMove(x, y) {
  const s = state.current; if (!s) return;
  const last = s.pts[s.pts.length - 1];
  const d = Math.hypot(x - last.x, y - last.y);
  if (d <= 0.002) return;
  // dynamics: draw slowly = thick + loud, draw fast = thin + quiet
  const now = performance.now(), speed = d / Math.max(0.008, (now - state.lastT) / 1000);
  state.lastT = now;
  const w = Math.min(1, Math.max(0.2, 1.15 - speed * 0.6));
  s.pts.push(stamp({ x, y, w: last.w * 0.6 + w * 0.4 }));
}
/** remove stroke parts within r px of (x,y) (normalised coords); strokes are split where erased */
function eraseAt(x, y, r = 36) {
  const cx = x * W, cy = y * H, out = [];
  let changed = false;
  for (const s of state.strokes) {
    if (s === state.current) { out.push(s); continue; }
    let piece = [], pieces = [];
    for (const p of s.pts) {
      if (Math.hypot(p.x * W - cx, p.y * H - cy) < r) { changed = true; if (piece.length) pieces.push(piece); piece = []; }
      else piece.push(p);
    }
    if (piece.length) pieces.push(piece);
    if (pieces.length === 1 && pieces[0].length === s.pts.length) { out.push(s); continue; }
    for (const pts of pieces) if (pts.length >= 3) out.push({ id: state.nextId++, pts });
  }
  if (changed) { state.strokes = out; engine.releaseExcept(new Set()); save(); }
}
function penUp() {
  const s = state.current; state.current = null;
  if (s && s.pts.length < 3) state.strokes.splice(state.strokes.indexOf(s), 1);   // ignore taps
  save();
}
function setPen(x, y, down, source, erase = false) {
  const p = state.pen;
  p.x = x; p.y = y; p.source = source; p.visible = true;
  state.erasing = erase;
  if (erase) { if (p.down) { p.down = false; penUp(); } eraseAt(x, y, source === 'hand' ? 48 : 30); return; }
  if (down && !p.down) penDown(x, y);
  else if (down && p.down) penMove(x, y);
  else if (!down && p.down) penUp();
  p.down = down;
}

const norm = e => {
  const r = canvas.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
};
canvas.addEventListener('pointerdown', e => {
  if (!engine.ctx) return;
  canvas.setPointerCapture(e.pointerId);
  state.mouseDown = true;
  const [x, y] = norm(e);
  state.mouseErase = e.button === 2 || e.shiftKey;
  setPen(x, y, !state.mouseErase, 'mouse', state.mouseErase);
});
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointermove', e => {
  if (state.hand && state.pen.source === 'hand' && state.pen.visible) return;
  const [x, y] = norm(e);
  setPen(x, y, state.mouseDown && !state.mouseErase, 'mouse', state.mouseDown && state.mouseErase);
});
const up = e => { if (!state.mouseDown) return; state.mouseDown = false; state.mouseErase = false; const [x, y] = norm(e); setPen(x, y, false, 'mouse'); };
canvas.addEventListener('pointerup', up);
canvas.addEventListener('pointercancel', up);
canvas.addEventListener('pointerleave', () => { if (!state.mouseDown) state.pen.visible = state.pen.source === 'hand'; });

// ---------- hand tracking ----------
$('cam-btn').onclick = async () => {
  const btn = $('cam-btn'), pip = $('pip');
  if (state.hand) {
    state.hand.stop(); state.hand = null; pip.hidden = true;
    btn.textContent = 'Use hand'; btn.classList.remove('live');
    if (state.pen.down) setPen(state.pen.x, state.pen.y, false, 'mouse');
    return;
  }
  pip.hidden = false; btn.disabled = true;
  try {
    state.hand = await startHand({
      video: $('cam'), overlay: $('pipOverlay'),
      onStatus: t => { $('pipStatus').textContent = t; },
      onPen: p => {
        if (!p.present) { if (state.pen.down) setPen(state.pen.x, state.pen.y, false, 'hand'); state.pen.visible = false; state.erasing = false; return; }
        setPen(p.x, p.y, p.down, 'hand', !!p.erase);
      },
    });
    btn.textContent = 'Stop hand'; btn.classList.add('live');
  } catch (err) {
    console.error(err);
    $('pipStatus').textContent = 'Camera/hand model unavailable: ' + (err.message || err);
    setTimeout(() => { if (!state.hand) pip.hidden = true; }, 4000);
  } finally { btn.disabled = false; }
};

// ---------- controls ----------
$('play').onclick = togglePlay;
function togglePlay() {
  if (engine.playing) { engine.pause(); $('play').textContent = 'Play'; }
  else { engine.play(); $('play').textContent = 'Pause'; }
}
for (const [k, v] of Object.entries(INSTRUMENTS)) { const o = document.createElement('option'); o.value = k; o.textContent = v.name; $('inst').appendChild(o); }
$('inst').value = engine.inst; $('harm').value = engine.harmony; $('ink').value = state.ink === Infinity ? 'hold' : String(state.ink);
$('inst').onchange = e => { engine.setInstrument(e.target.value); save(); };
$('harm').onchange = e => { engine.setHarmony(e.target.value); save(); };
$('ink').onchange = e => { state.ink = e.target.value === 'hold' ? Infinity : +e.target.value; save(); };
// struck instruments (piano, guitar) get their notes from here, once per 16th step
engine.provider = pos => {
  const out = [];
  for (const s of state.strokes) {
    if (s === state.current) continue;
    const y = yAt(s, pos); if (y == null) continue;
    out.push({ id: s.id, midi: engine.yToMidi(y), vel: 0.35 + 0.65 * (yAt.w || 1) });
  }
  if (state.pen.down) out.push({ id: 'pen', midi: engine.yToMidi(state.pen.y), vel: 0.8 });
  return out;
};
$('quant').onchange = e => { engine.quantize = e.target.checked; save(); };
$('bpm').oninput = e => { engine.setBpm(+e.target.value); $('bpmOut').textContent = e.target.value; save(); };
$('undo').onclick = undo;
$('clear').onclick = () => { state.strokes.length = 0; state.current = null; engine.releaseAll(); save(); };
function undo() { const s = state.strokes.pop(); if (s === state.current) state.current = null; engine.releaseAll(); save(); }
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'z') undo();
  else if (e.key === 'c') $('clear').click();
});

// ---------- making sure the browser actually lets us make sound ----------
let unlockEl = null;
function silentWavUrl() {
  const n = 800, b = new DataView(new ArrayBuffer(44 + n)), s = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); b.setUint32(4, 36 + n, true); s(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, 8000, true); b.setUint32(28, 8000, true); b.setUint16(32, 1, true); b.setUint16(34, 8, true); s(36, 'data'); b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([b.buffer], { type: 'audio/wav' }));
}
function unlockAudio() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  try {   // iOS: the ringer/silent switch mutes Web Audio unless a media element is playing
    if (!unlockEl) { unlockEl = new Audio(silentWavUrl()); unlockEl.loop = true; unlockEl.setAttribute('playsinline', ''); }
    unlockEl.play().catch(() => {});
  } catch {}
  if (engine.ctx && engine.ctx.state !== 'running') engine.ctx.resume().catch(() => {});
}
function syncBanner() { $('soundBanner').hidden = !engine.ctx || engine.ctx.state === 'running'; }
$('soundBanner').onclick = () => { unlockAudio(); engine.blip(); setTimeout(syncBanner, 300); };
for (const ev of ['pointerdown', 'keydown', 'touchend']) addEventListener(ev, () => { if (engine.ctx && engine.ctx.state !== 'running') { unlockAudio(); setTimeout(syncBanner, 300); } }, true);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { unlockAudio(); syncBanner(); } });
$('test').onclick = () => { unlockAudio(); engine.blip(); setTimeout(syncBanner, 300); };

$('go').onclick = () => {
  unlockAudio();
  engine.init(); engine.onState = syncBanner; engine.blip(); setGenre(state.genreKey); if (saved && saved.bpm) { engine.setBpm(saved.bpm); $('bpm').value = saved.bpm; $('bpmOut').textContent = saved.bpm; }
  engine.play();
  $('start').classList.add('gone');
};

// ---------- play along with a song ----------
const T = { open: false, active: false };
const tpanel = $('trackPanel');
$('track-btn').onclick = () => { unlockAudio(); tpanel.classList.remove('gone'); };
$('tclose').onclick = () => tpanel.classList.add('gone');
tpanel.addEventListener('pointerdown', e => { if (e.target === tpanel) tpanel.classList.add('gone'); });
$('tvol').oninput = e => engine.setTrackVolume(+e.target.value);
const tstatus = (t, err = false) => { const el = $('tstatus'); el.hidden = !t; el.textContent = t || ''; el.classList.toggle('err', err); };

const STREAMING = /(soundcloud\.com|snd\.sc|youtube\.com|youtu\.be|spotify\.com|music\.apple\.com|deezer\.com|tidal\.com|bandcamp\.com|audiomack\.com)$/i;
const decode = ab => new Promise((res, rej) => engine.ctx.decodeAudioData(ab, res, rej));

async function loadSong(arrayBuffer, title) {
  try {
    tstatus('decoding audio…');
    const buf = await decode(arrayBuffer);
    const a = await analyse(buf, tstatus);
    const prof = profileFromAnalysis(a, title);
    GENRES.track = prof;
    if (!chips.querySelector('[data-k=track]')) {
      const b = document.createElement('button'); b.className = 'chip'; b.dataset.k = 'track'; b.textContent = 'Song';
      b.onclick = () => setGenre('track'); chips.prepend(b);
    }
    state.songTitle = title;
    setGenre('track');
    engine.setBpm(prof.bpm);
    $('bpm').value = Math.round(prof.bpm); $('bpmOut').textContent = prof.bpm.toFixed(1); $('bpm').disabled = true;
    engine.setTrack(buf, a.offset);
    if (!engine.playing) { engine.play(); $('play').textContent = 'Pause'; }
    T.active = true;
    const r = $('tresult'); r.hidden = false;
    r.innerHTML = `<div><b>${prof.bpm.toFixed(1)}</b><span>BPM</span></div><div><b>${prof.info.key}</b><span>key${a.keyConf < 0.45 ? ' (unsure)' : ''}</span></div><div><b>${prof.info.feel}</b><span>${prof.info.timbre} sound</span></div>`;
    $('tremove').hidden = false;
    tstatus('Playing. Your drawing is now locked to the song\'s tempo and notes. The loop restarts every 4 bars.');
  } catch (err) {
    console.error(err);
    tstatus("Couldn't read that audio. Try an mp3, wav, m4a or ogg file.", true);
  }
}
function clearSong() {
  stopCapture(); engine.setTrack(null); T.active = false; $('bpm').disabled = false;
  const c = chips.querySelector('[data-k=track]'); if (c) c.remove();
  $('tresult').hidden = true; $('tremove').hidden = true; tstatus('');
}
$('tremove').onclick = () => { clearSong(); setGenre('lofi'); };

async function fromFile(file) {
  if (!file) return;
  if (!engine.ctx) engine.init();
  tstatus('reading file…');
  loadSong(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''));
}
$('file').onchange = e => fromFile(e.target.files[0]);
const drop = $('drop');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', e => fromFile(e.dataTransfer.files[0]));

$('load').onclick = async () => {
  const raw = $('url').value.trim(); if (!raw) return;
  let u; try { u = new URL(raw); } catch { tstatus('That does not look like a link.', true); return; }
  if (STREAMING.test(u.hostname)) {
    tstatus(`${u.hostname.replace(/^www\./, '')} doesn't give other websites its audio (and no API key changes that). Play it in another tab and use "Listen to a browser tab" below.`, true);
    return;
  }
  try {
    tstatus('downloading…');
    const res = await fetch(u.href); if (!res.ok) throw new Error('HTTP ' + res.status);
    loadSong(await res.arrayBuffer(), decodeURIComponent(u.pathname.split('/').pop() || 'Song').replace(/\.[^.]+$/, ''));
  } catch (err) {
    tstatus("Couldn't fetch that link from the browser (the server probably blocks other sites). Download the file and drop it above instead.", true);
  }
};

// ---------- listen to a browser tab (YouTube / SoundCloud / anything playing in another tab) ----------
const CAP_SECONDS = 20;
let cap = null;   // { stream, src, sp, chunks, sr, timer }
const canCapture = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
if (!canCapture) { $('capture').disabled = true; $('capnote').textContent = 'Tab listening needs desktop Chrome or Edge (it is not available on phones). On a phone, use a song file.'; }

function stopCapture() {
  if (!cap) return;
  try { cap.sp.disconnect(); cap.src.disconnect(); } catch {}
  cap.stream.getTracks().forEach(t => t.stop());
  clearInterval(cap.timer); cap = null;
  $('capstop').hidden = true; $('resync').hidden = true; $('capture').disabled = !canCapture;
}
$('capstop').onclick = () => { stopCapture(); tstatus('Stopped listening. The drawing keeps the last tempo and key.'); };

async function startCapture(stream) {
  if (!engine.ctx) engine.init();
  const ctx = engine.ctx;
  const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  const sp = ctx.createScriptProcessor(4096, 2, 1), mute = ctx.createGain(); mute.gain.value = 0;
  const c = cap = { stream, src, sp, chunks: [], sr: ctx.sampleRate, firstT: null };
  sp.onaudioprocess = e => {
    const a = e.inputBuffer.getChannelData(0), b = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : a, m = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) m[i] = (a[i] + b[i]) / 2;
    c.chunks.push({ t: e.playbackTime - 2 * a.length / c.sr, data: m });   // ctx time the chunk started: ScriptProcessor output lags input by one buffer
    while (c.chunks.length * 4096 / c.sr > CAP_SECONDS + 2) c.chunks.shift();
  };
  src.connect(sp); sp.connect(mute).connect(ctx.destination);
  stream.getAudioTracks()[0].addEventListener('ended', () => { if (cap === c) { stopCapture(); tstatus('The tab share ended.'); } });
  $('capture').disabled = true; $('capstop').hidden = false;
  let left = CAP_SECONDS; tstatus(`Listening… ${left}s (keep the song playing)`);
  await new Promise(res => { c.timer = setInterval(() => { left--; if (left <= 0) { clearInterval(c.timer); res(); } else tstatus(`Listening… ${left}s (keep the song playing)`); }, 1000); });
  if (cap !== c) return;
  await lockToCapture();
  $('resync').hidden = false;
}

async function lockToCapture() {
  const c = cap; if (!c || !c.chunks.length) return;
  const chunks = c.chunks.slice(), len = chunks.reduce((s, k) => s + k.data.length, 0);
  const buf = engine.ctx.createBuffer(1, len, c.sr), ch = buf.getChannelData(0);
  let o = 0; for (const k of chunks) { ch.set(k.data, o); o += k.data.length; }
  let peak = 0; for (let i = 0; i < len; i += 64) peak = Math.max(peak, Math.abs(ch[i]));
  if (peak < 0.005) { tstatus("I heard silence. Make sure the song is playing and you ticked \"Also share tab audio\".", true); return; }
  const a = await analyse(buf, tstatus);
  const prof = profileFromAnalysis(a, 'Tab audio');
  GENRES.track = prof;
  if (!chips.querySelector('[data-k=track]')) {
    const b = document.createElement('button'); b.className = 'chip'; b.dataset.k = 'track'; b.textContent = 'Song';
    b.onclick = () => setGenre('track'); chips.prepend(b);
  }
  T.active = true; $('tremove').hidden = false;      // song mode (the song itself plays in its own tab)
  setGenre('track'); engine.setBpm(prof.bpm);
  $('bpm').value = Math.round(prof.bpm); $('bpmOut').textContent = prof.bpm.toFixed(1); $('bpm').disabled = true;
  if (!engine.playing) { engine.play(); $('play').textContent = 'Pause'; }
  // put the loop's first step on the song's next bar line
  const bar = 4 * 60 / prof.bpm, t0 = chunks[0].t + a.offset, now = engine.ctx.currentTime + 0.4;
  engine.alignLoopAt(t0 + Math.ceil((now - t0) / bar) * bar);
  const r = $('tresult'); r.hidden = false;
  r.innerHTML = `<div><b>${prof.bpm.toFixed(1)}</b><span>BPM</span></div><div><b>${prof.info.key}</b><span>key${a.keyConf < 0.45 ? ' (unsure)' : ''}</span></div><div><b>${prof.info.feel}</b><span>${prof.info.timbre} sound</span></div>`;
  tstatus('Locked on. Draw: notes are in the song\'s key and the loop follows its bars. If it drifts, press Re-sync.');
}
$('resync').onclick = async () => { tstatus('re-syncing…'); await lockToCapture(); };

$('capture').onclick = async () => {
  unlockAudio();
  let stream;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
  catch { tstatus('No tab was shared.', true); return; }
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach(t => t.stop());
    tstatus('No audio came with the share. Pick the tab with the song and tick "Also share tab audio".', true); return;
  }
  stopCapture();
  try { await startCapture(stream); } catch (err) { console.error(err); stopCapture(); tstatus("Couldn't listen to that tab.", true); }
};
window.__scribble.startCapture = startCapture;   // for tests

// ---------- sound from strokes ----------
/** y of the stroke where the playhead crosses it, or null if the playhead isn't over it. */
function yAt(stroke, pos) {
  const p = stroke.pts; let sum = 0, n = 0, wsum = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    if (!alive(a) || !alive(b)) continue;
    const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
    if (pos < lo - 0.002 || pos > hi + 0.002) continue;
    const dx = b.x - a.x;
    sum += Math.abs(dx) < 1e-5 ? (a.y + b.y) / 2 : a.y + (b.y - a.y) * Math.min(1, Math.max(0, (pos - a.x) / dx));
    wsum += ((a.w ?? 0.7) + (b.w ?? 0.7)) / 2;
    n++;
  }
  yAt.w = n ? wsum / n : 1;   // width (loudness) at the crossing, read by the caller
  return n ? sum / n : null;
}

// ---------- drawing ----------
let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  W = innerWidth; H = innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener('resize', resize); resize();

const NOTE = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const hueOf = y => 190 + (1 - y) * 150;   // low = teal/blue, high = pink

function drawGrid(genre) {
  const topPad = 0, left = 0;
  // vertical beat / bar lines
  const beats = BARS * 4;
  for (let i = 0; i <= beats; i++) {
    const x = (i / beats) * W, bar = i % 4 === 0;
    g.strokeStyle = bar ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.04)';
    g.lineWidth = 1; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  // horizontal lines at scale notes
  g.font = '10px system-ui'; g.textBaseline = 'bottom';
  for (let o = 0; o <= RANGE / 12 + 1; o++) {
    for (const s of genre.scale) {
      const m = genre.lo + o * 12 + s, y = (1 - (m - genre.lo) / RANGE) * H;
      if (y < 0 || y > H) continue;
      const isRoot = s === 0;
      g.strokeStyle = isRoot ? `hsla(${genre.hue},70%,70%,.28)` : 'rgba(255,255,255,.06)';
      g.lineWidth = isRoot ? 1.2 : 1;
      g.beginPath(); g.moveTo(left, y); g.lineTo(W, y); g.stroke();
      if (isRoot) { g.fillStyle = `hsla(${genre.hue},70%,80%,.55)`; g.fillText(NOTE[m % 12] + (Math.floor(m / 12) - 1), 8, y - 2); }
    }
  }
}

/** ink: glows while waiting, flashes when the playhead hits it, then cools and fades over `state.ink` beats */
function drawStroke(s, live) {
  const p = s.pts; if (p.length < 2) return;
  g.lineCap = g.lineJoin = 'round';
  const life = Math.abs(state.ink), afterDraw = state.ink < 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    if (!alive(a) && !alive(b)) continue;
    const t = afterDraw ? clock - Math.max(a.born, b.born) : clock - Math.max(a.tc, b.tc);   // beats since drawn / since the playhead passed (negative = still waiting)
    let alpha = 0.82, light = 62, flash = 0;
    if ((afterDraw || !live) && t >= 0 && engine.playing) {
      flash = Math.exp(-t * 5);
      light = 62 + 28 * flash;
      alpha = life === Infinity ? 0.82 : Math.max(0, 1 - t / life) * (0.35 + 0.65 * Math.max(flash, 1 - t / life));
    }
    if (alpha <= 0.01) continue;
    const w = 1.8 + 4.2 * ((a.w ?? 0.7) + (b.w ?? 0.7)) / 2, hue = hueOf((a.y + b.y) / 2);
    g.globalAlpha = alpha * (0.14 + 0.2 * flash);                    // soft halo (wet ink bleeding)
    g.strokeStyle = `hsl(${hue},95%,${light}%)`; g.lineWidth = w * 3.2;
    g.beginPath(); g.moveTo(a.x * W, a.y * H); g.lineTo(b.x * W, b.y * H); g.stroke();
    g.globalAlpha = alpha;                                            // core line
    g.strokeStyle = `hsl(${hue},${90 - 30 * (1 - alpha)}%,${light}%)`; g.lineWidth = w * (1 + 0.35 * flash);
    g.beginPath(); g.moveTo(a.x * W, a.y * H); g.lineTo(b.x * W, b.y * H); g.stroke();
  }
  g.globalAlpha = 1;
}

function drawParticles() {
  g.globalCompositeOperation = 'lighter';
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.x += q.vx / 60; q.y += q.vy / 60; q.vy += 0.6; q.life -= 0.045;
    if (q.life <= 0) { particles.splice(i, 1); continue; }
    g.globalAlpha = q.life * 0.8; g.fillStyle = `hsl(${q.hue},100%,70%)`;
    g.beginPath(); g.arc(q.x, q.y, 1.2 + 2.2 * q.life, 0, 6.3); g.fill();
  }
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
}

// ---------- save / load (localStorage) ----------
const KEY = 'scribble-synth-v1';
function save() {
  try {
    const strokes = state.strokes.filter(s => s !== state.current).map(s => ({ id: s.id, pts: s.pts.map(p => [+p.x.toFixed(4), +p.y.toFixed(4), +(p.w ?? 0.7).toFixed(2)]) }));
    localStorage.setItem(KEY, JSON.stringify({ genre: state.genreKey, bpm: engine.bpm, quant: engine.quantize, ink: state.ink === Infinity ? 'hold' : state.ink, inst: engine.inst, harmony: engine.harmony, strokes }));
  } catch {}
}
let saved = null;
try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
if (saved) {
  if (GENRES[saved.genre]) state.genreKey = saved.genre;
  engine.quantize = saved.quant !== false; $('quant').checked = engine.quantize;
  state.strokes = (saved.strokes || []).map(s => ({ id: state.nextId++, pts: s.pts.map(([x, y, w]) => stamp({ x, y, w })) }));
  if (saved.ink != null) state.ink = saved.ink === 'hold' ? Infinity : saved.ink;
  if (saved.inst && INSTRUMENTS[saved.inst]) engine.inst = saved.inst;
  if (saved.harmony) engine.harmony = saved.harmony;
  if (state.strokes.length) $('hint').classList.add('hide');
  $('inst').value = engine.inst; $('harm').value = engine.harmony; $('ink').value = state.ink === Infinity ? 'hold' : String(state.ink);
}

$('png').onclick = () => {
  canvas.toBlob(b => download(b, 'scribble.png'));
};
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// Record exactly one loop: arm -> starts at the next loop start -> stops at the one after -> downloads.
$('rec').onclick = () => {
  if (!engine.ctx || !engine.playing || typeof MediaRecorder === 'undefined') return;
  if (state.rec) { cancelRec(); return; }
  state.rec = { phase: 'armed' };
  $('rec').textContent = 'Armed…'; $('rec').classList.add('live');
};
function cancelRec() {
  const r = state.rec; state.rec = null;
  if (r && r.mr && r.mr.state !== 'inactive') { r.mr.onstop = null; r.mr.stop(); }
  $('rec').textContent = 'Record loop'; $('rec').classList.remove('live');
}
function recOnWrap() {
  const r = state.rec; if (!r) return;
  if (r.phase === 'armed') {
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t));
    const chunks = [];
    r.mr = new MediaRecorder(engine.recDest.stream, mime ? { mimeType: mime } : undefined);
    r.mr.ondataavailable = e => e.data.size && chunks.push(e.data);
    r.mr.onstop = () => {
      const type = r.mr.mimeType || 'audio/webm';
      download(new Blob(chunks, { type }), 'scribble-loop.' + (type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm'));
      state.rec = null; $('rec').textContent = 'Record loop'; $('rec').classList.remove('live');
    };
    r.mr.start(); r.phase = 'rec';
    $('rec').textContent = '● Recording…';
  } else if (r.phase === 'rec') {
    setTimeout(() => r.mr.stop(), 250);   // let the reverb tail land
    r.phase = 'stopping'; $('rec').textContent = 'Saving…';
  }
}

let prevPos = 0, frameN = 0, frameC = 0, meter = 0;
function frame() {
  requestAnimationFrame(frame);
  const genre = GENRES[state.genreKey];
  const pos = engine.ctx ? engine.position() : 0;
  if (engine.ctx && engine.ctx.state !== 'running' && (frameN++ % 60 === 0)) { engine.ctx.resume().catch(() => {}); syncBanner(); }
  if (pos < prevPos - 0.5) { recOnWrap(); loops++; }
  prevPos = pos;
  clock = (loops + pos) * LOOP_BEATS;
  if (state.ink !== Infinity && ++frameC % 20 === 0) state.strokes = state.strokes.filter(s => s === state.current || s.pts.some(alive));

  // --- audio + sparks: whatever the playhead is over right now
  const ev = engine.instMode() === 'event', playing = engine.ctx && engine.playing, keep = new Set();
  for (const s of state.strokes) {
    s.active = false;
    if (s === state.current) continue;               // the live stroke is heard through the pen voice
    const y = yAt(s, pos);
    if (y == null) continue;
    s.active = true;
    if (!playing) continue;
    const vol = 0.35 + 0.65 * (yAt.w || 1), m = engine.yToMidi(y);
    if (particles.length < 500 && Math.random() < 0.9) {
      const hue = hueOf(y);
      for (let k = 0; k < 2; k++) particles.push({ x: pos * W, y: y * H, vx: (Math.random() - 0.3) * 60, vy: (Math.random() - 0.5) * 80, life: 1, hue });
    }
    if (!ev) {
      engine.setVoice(s.id, m, vol); keep.add(s.id);
      engine.harmonize(m).forEach((h, i) => { engine.setVoice(s.id + ':h' + i, h, vol * 0.6); keep.add(s.id + ':h' + i); });
    }
  }
  if (engine.ctx) {
    if (state.pen.down && !ev) {
      const m = engine.yToMidi(state.pen.y);
      engine.setVoice('pen', m, 0.8); keep.add('pen');
      engine.harmonize(m).forEach((h, i) => { engine.setVoice('pen:h' + i, h, 0.5); keep.add('pen:h' + i); });
    }
    if (playing || !state.pen.down) engine.releaseExcept(keep);
  }

  // --- visuals
  g.clearRect(0, 0, W, H);
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, `hsl(${genre.hue},35%,9%)`); bg.addColorStop(1, '#090b0f');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  drawGrid(genre);
  for (const s of state.strokes) drawStroke(s, s === state.current);
  drawParticles();

  // playhead
  const px = pos * W;
  const grad = g.createLinearGradient(px - 60, 0, px, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(1, 'rgba(255,255,255,.10)');
  g.fillStyle = grad; g.fillRect(px - 60, 0, 60, H);
  g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();

  // output meter (top right): if this moves but you hear nothing, the device/browser is muting audio
  if (engine.ctx) {
    meter = Math.max(engine.level(), meter * 0.9);
    const mx = W - 24, mh = 70, my = H - 150;
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(mx, my - mh, 6, mh);
    g.fillStyle = engine.ctx.state === 'running' ? (meter > 0.9 ? '#ff5c8a' : '#7cf4c8') : '#ffb020';
    g.fillRect(mx, my - Math.min(1, meter * 1.4) * mh, 6, Math.min(1, meter * 1.4) * mh);
    g.fillStyle = 'rgba(255,255,255,.4)'; g.font = '10px system-ui'; g.textBaseline = 'top'; g.fillText('out', mx - 2, my + 4);
  }

  // pen cursor
  const p = state.pen;
  if (p.visible) {
    const cx = p.x * W, cy = p.y * H;
    g.strokeStyle = state.erasing ? '#ffb020' : p.down ? '#ff5c8a' : 'rgba(255,255,255,.7)'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, state.erasing ? (p.source === 'hand' ? 48 : 30) : p.down ? 9 : 13, 0, 6.3); g.stroke();
    if (p.down) { g.fillStyle = '#ff5c8a'; g.beginPath(); g.arc(cx, cy, 4, 0, 6.3); g.fill(); }
    if (p.source === 'hand') {
      const m = engine.yToMidi(p.y);
      g.fillStyle = 'rgba(255,255,255,.8)'; g.font = '12px system-ui'; g.textBaseline = 'middle';
      g.fillText(NOTE[Math.round(m) % 12] + (Math.floor(Math.round(m) / 12) - 1), cx + 18, cy);
    }
  }
}
frame();
setGenre(state.genreKey);
