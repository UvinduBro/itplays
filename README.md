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
- **Ink:** by default a stroke *vanishes one beat after you draw it* (the beat follows the tempo). Other modes: fade 1 beat / 1 bar / 4 bars after the playhead has played it, or *holds* so your drawing loops.
- **Sound:** Synth (per genre), Piano, Guitar (Karplus-Strong plucked string), Strings, Flute. **Harmony** adds a scale-correct third, chord or octave. Drums are humanised (timing/velocity jitter, ghost notes, metallic hats, claps).
- **Dynamics:** draw slowly = thick + loud, quickly = thin + quiet.
- **Record loop** downloads one loop of audio; **PNG** saves the drawing. Your drawing, genre and tempo autosave in the browser.
- Genres: Lo-fi, Jazz, House, Techno, Trap, Ambient, Chiptune, Synthwave (each changes instrument, scale, tempo, drums, bass, FX).
- *Snap to scale* quantises pitch to the genre scale; turn off for theremin-style glides.
- Keys: `space` play/pause, `z` undo, `c` clear.

- **Track:** drop in an audio file (or a direct audio link). It finds the tempo, beat grid, key and rough timbre, plays the song, and locks your drawing to its BPM and scale. Streaming-site links (SoundCloud, YouTube, Spotify…) can't be analysed because those sites don't expose their audio to other websites.
- **Listen to a browser tab (desktop Chrome/Edge):** play a song on YouTube/SoundCloud/etc. in another tab, press *Listen to a browser tab*, pick that tab and tick *Also share tab audio*. It listens ~20 s, finds tempo + key, and locks the loop to the song's bars. No API keys involved; audio is analysed in your browser and never stored or uploaded.
- **No sound?** The meter at the bottom right shows output level. If it moves but you hear nothing, check device volume / the iPhone silent switch; if a banner says sound is off, tap it. *Test sound* plays a chime.

## Deploy
Static site, no build step. Vercel serves it as-is (see `vercel.json`).

## Stack
Vanilla JS, Web Audio API (all sounds synthesised, no samples), MediaPipe Hand Landmarker for tracking.
Hand tracking lives in `js/hand.js` and only has to emit `{present, down, x, y}`, so it can be swapped for another
tracker (e.g. a Roboflow RF-DETR keypoint model).
