import { Engine } from './audio.js';
import { GENRES, GENRE_ORDER, RANGE, BARS } from './genres.js';
import { startHand } from './hand.js';

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
};
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
  state.genreKey = k;
  engine.setGenre(GENRES[k]);
  $('bpm').value = engine.bpm; $('bpmOut').textContent = engine.bpm;
  for (const c of chips.children) c.classList.toggle('on', c.dataset.k === k);
  save();
}

// ---------- pen (shared by mouse, touch and hand) ----------
function penDown(x, y) {
  state.lastT = performance.now();
  state.current = { id: state.nextId++, pts: [{ x, y, w: 0.7 }] };
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
  s.pts.push({ x, y, w: last.w * 0.6 + w * 0.4 });
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

$('go').onclick = () => {
  engine.init(); setGenre(state.genreKey); if (saved && saved.bpm) { engine.setBpm(saved.bpm); $('bpm').value = saved.bpm; $('bpmOut').textContent = saved.bpm; }
  engine.play();
  $('start').classList.add('gone');
};

// ---------- sound from strokes ----------
/** y of the stroke where the playhead crosses it, or null if the playhead isn't over it. */
function yAt(stroke, pos) {
  const p = stroke.pts; let sum = 0, n = 0, wsum = 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
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

function drawStroke(s, active) {
  const p = s.pts; if (p.length < 2) return;
  g.lineCap = g.lineJoin = 'round';
  g.shadowBlur = active ? 22 : 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    g.lineWidth = (1.8 + 4.2 * ((a.w ?? 0.7) + (b.w ?? 0.7)) / 2) * (active ? 1.35 : 1);
    const col = `hsl(${hueOf((a.y + b.y) / 2)},90%,${active ? 72 : 62}%)`;
    g.strokeStyle = g.shadowColor = col;
    g.globalAlpha = active ? 1 : 0.78;
    g.beginPath(); g.moveTo(a.x * W, a.y * H); g.lineTo(b.x * W, b.y * H); g.stroke();
  }
  g.globalAlpha = 1; g.shadowBlur = 0;
}

// ---------- save / load (localStorage) ----------
const KEY = 'scribble-synth-v1';
function save() {
  try {
    const strokes = state.strokes.filter(s => s !== state.current).map(s => ({ id: s.id, pts: s.pts.map(p => [+p.x.toFixed(4), +p.y.toFixed(4), +(p.w ?? 0.7).toFixed(2)]) }));
    localStorage.setItem(KEY, JSON.stringify({ genre: state.genreKey, bpm: engine.bpm, quant: engine.quantize, strokes }));
  } catch {}
}
let saved = null;
try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
if (saved) {
  if (GENRES[saved.genre]) state.genreKey = saved.genre;
  engine.quantize = saved.quant !== false; $('quant').checked = engine.quantize;
  state.strokes = (saved.strokes || []).map(s => ({ id: state.nextId++, pts: s.pts.map(([x, y, w]) => ({ x, y, w })) }));
  if (state.strokes.length) $('hint').classList.add('hide');
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

let prevPos = 0;
function frame() {
  requestAnimationFrame(frame);
  const genre = GENRES[state.genreKey];
  const pos = engine.ctx ? engine.position() : 0;
  if (pos < prevPos - 0.5) recOnWrap();
  prevPos = pos;

  // --- audio: set a voice for every stroke the playhead is currently over
  if (engine.ctx && engine.playing) {
    const keep = new Set();
    for (const s of state.strokes) {
      if (s === state.current) continue;               // the live stroke is heard through the pen voice
      const y = yAt(s, pos);
      s.active = y != null;
      if (y != null) { engine.setVoice(s.id, engine.yToMidi(y), 0.35 + 0.65 * (yAt.w || 1)); keep.add(s.id); }
    }
    if (state.pen.down) { engine.setVoice('pen', engine.yToMidi(state.pen.y), 0.8); keep.add('pen'); }
    engine.releaseExcept(keep);
  } else if (engine.ctx) {
    if (state.pen.down) engine.setVoice('pen', engine.yToMidi(state.pen.y)); else engine.setVoice('pen', null);
  }

  // --- visuals
  g.clearRect(0, 0, W, H);
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, `hsl(${genre.hue},35%,9%)`); bg.addColorStop(1, '#090b0f');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  drawGrid(genre);
  for (const s of state.strokes) drawStroke(s, s.active && engine.playing);

  // playhead
  const px = pos * W;
  const grad = g.createLinearGradient(px - 60, 0, px, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(1, 'rgba(255,255,255,.10)');
  g.fillStyle = grad; g.fillRect(px - 60, 0, 60, H);
  g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke();

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
