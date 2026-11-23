# scribble.synth

Draw a squiggle → hear a melody. **y axis = pitch, x axis = time.**
A playhead loops over your drawing while a genre-specific band (drums, bass, pads) plays underneath.

## Run
```bash
npm start        # or: python3 -m http.server 8080
# open http://localhost:8080  (camera needs localhost or https)
```

## Controls
- **Mouse / touch:** click-drag on the canvas.
- **Hand tracking:** press *Use hand*, then **pinch** thumb + index to draw in the air; release to lift the pen.
- **Fist** (hand) or **right-click / shift + drag** (mouse) erases.
- **Dynamics:** draw slowly = thick + loud, quickly = thin + quiet.
- **Record loop** downloads one loop of audio; **PNG** saves the drawing. Your drawing, genre and tempo autosave in the browser.
- Genres: Lo-fi, Jazz, House, Techno, Trap, Ambient, Chiptune, Synthwave (each changes instrument, scale, tempo, drums, bass, FX).
- *Snap to scale* quantises pitch to the genre scale; turn off for theremin-style glides.
- Keys: `space` play/pause, `z` undo, `c` clear.

## Deploy
Static site, no build step. Vercel serves it as-is (see `vercel.json`).

## Stack
Vanilla JS, Web Audio API (all sounds synthesised, no samples), MediaPipe Hand Landmarker for tracking.
Hand tracking lives in `js/hand.js` and only has to emit `{present, down, x, y}`, so it can be swapped for another
tracker (e.g. a Roboflow RF-DETR keypoint model).
