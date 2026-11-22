// Hand tracking -> a "pen": position (0..1) + pinch state.
// Uses MediaPipe Hand Landmarker (runs fully in the browser, no API key).
// Anything that can produce {present, x, y, pinch} per frame can replace this file
// (e.g. a Roboflow RF-DETR keypoint model).

const VER = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VER}`;
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
               [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export async function startHand({ video, overlay, onStatus, onPen }) {
  onStatus('loading hand model…');
  const { FilesetResolver, HandLandmarker } = await import(`${CDN}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  const make = delegate => HandLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode: 'VIDEO', numHands: 1,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let landmarker;
  try { landmarker = await make('GPU'); } catch { landmarker = await make('CPU'); }

  onStatus('starting camera…');
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
  });
  video.srcObject = stream;
  await video.play();

  const octx = overlay.getContext('2d');
  let raf = 0, lastT = -1, pinching = false, sx = 0.5, sy = 0.5, hadHand = false, stopped = false;

  const loop = () => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    if (video.readyState < 2 || video.currentTime === lastT) return;
    lastT = video.currentTime;

    const res = landmarker.detectForVideo(video, performance.now());
    overlay.width = video.videoWidth; overlay.height = video.videoHeight;
    octx.clearRect(0, 0, overlay.width, overlay.height);

    const lm = res.landmarks && res.landmarks[0];
    if (!lm) {
      if (hadHand) onStatus('show your hand');
      hadHand = false; pinching = false;
      onPen({ present: false, down: false });
      return;
    }
    hadHand = true;

    // pinch = thumb tip close to index tip, relative to hand size (wrist -> middle knuckle)
    const size = dist(lm[0], lm[9]) || 1;
    const ratio = dist(lm[4], lm[8]) / size;
    pinching = pinching ? ratio < 0.42 : ratio < 0.28;

    // pen position: midpoint of thumb + index tips, mapped with a margin so edges are reachable
    const rx = (lm[4].x + lm[8].x) / 2, ry = (lm[4].y + lm[8].y) / 2;
    const m = 0.12, tx = Math.min(1, Math.max(0, (rx - m) / (1 - 2 * m))), ty = Math.min(1, Math.max(0, (ry - m) / (1 - 2 * m)));
    const k = pinching ? 0.55 : 0.4;                 // light smoothing
    sx += (tx - sx) * k; sy += (ty - sy) * k;

    // skeleton preview
    const W = overlay.width, H = overlay.height;
    octx.lineWidth = 2; octx.strokeStyle = 'rgba(124,244,200,.8)';
    for (const [a, b] of BONES) { octx.beginPath(); octx.moveTo(lm[a].x * W, lm[a].y * H); octx.lineTo(lm[b].x * W, lm[b].y * H); octx.stroke(); }
    octx.fillStyle = pinching ? '#ff5c8a' : '#fff';
    octx.beginPath(); octx.arc(rx * W, ry * H, 7, 0, 6.3); octx.fill();

    onStatus(pinching ? 'drawing' : 'pinch to draw');
    // x is mirrored so moving your hand right moves the pen right
    onPen({ present: true, down: pinching, x: 1 - sx, y: sy });
  };
  loop();

  return {
    stop() {
      stopped = true; cancelAnimationFrame(raf);
      stream.getTracks().forEach(t => t.stop());
      video.srcObject = null; landmarker.close();
      onPen({ present: false, down: false });
    },
  };
}
