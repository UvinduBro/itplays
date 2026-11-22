// Each genre = instrument voice + scale + tempo + a small backing band.
// Drum/bass patterns are 16-step strings (one bar of 16th notes): x = hit, . = rest.

export const GENRES = {
  lofi: {
    name: 'Lo-fi', bpm: 78, swing: 0.18,
    lo: 57,                       // lowest lead note (A3)
    scale: [0, 3, 5, 7, 10],      // minor pentatonic
    wave: 'triangle', detune: 7, cutoff: 1900, q: 0.8, attack: 0.02, release: 0.18, leadGain: 0.30, vibrato: 8,
    reverb: 0.45, delay: 0.28,
    prog: [0, -4, -2, -5], chord: [0, 3, 7, 10], padWave: 'sine', padGain: 0.07,
    bassWave: 'sine', bassGain: 0.34, bass: 'x.....x...x.....',
    kit: 'soft', kick: 'x.....x.x.x.....', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.xx',
    hue: 255,
  },
  techno: {
    name: 'Techno', bpm: 128, swing: 0,
    lo: 57,
    scale: [0, 2, 3, 5, 7, 8, 10],   // natural minor
    wave: 'sawtooth', detune: 10, cutoff: 2600, q: 6, attack: 0.005, release: 0.08, leadGain: 0.16, vibrato: 0,
    reverb: 0.18, delay: 0.32,
    prog: [0, 0, -2, 0], chord: [0, 7], padWave: 'sawtooth', padGain: 0.025,
    bassWave: 'sawtooth', bassGain: 0.22, bass: '.x.x.x.x.x.x.x.x',
    kit: 'hard', kick: 'x...x...x...x...', snare: '....x.......x...', hat: '..x...x...x...x.',
    hue: 320,
  },
  ambient: {
    name: 'Ambient', bpm: 62, swing: 0,
    lo: 48,
    scale: [0, 2, 4, 6, 7, 9, 11],   // lydian
    wave: 'sine', detune: 9, cutoff: 4000, q: 0.5, attack: 0.5, release: 1.4, leadGain: 0.26, vibrato: 14,
    reverb: 0.95, delay: 0.5,
    prog: [0, 5, 7, 2], chord: [0, 4, 7, 11], padWave: 'sine', padGain: 0.09,
    bassWave: 'sine', bassGain: 0.26, bass: 'x...............',
    kit: 'none', kick: '................', snare: '................', hat: '................',
    hue: 190,
  },
  chip: {
    name: 'Chiptune', bpm: 140, swing: 0,
    lo: 60,
    scale: [0, 2, 4, 7, 9],          // major pentatonic
    wave: 'square', detune: 0, cutoff: 9000, q: 0.1, attack: 0.003, release: 0.04, leadGain: 0.14, vibrato: 0,
    reverb: 0.05, delay: 0.15,
    prog: [0, 5, 7, 5], chord: [0, 4, 7], padWave: 'square', padGain: 0.0,
    bassWave: 'triangle', bassGain: 0.34, bass: 'x.xxx.xxx.xxx.xx',
    kit: 'chip', kick: 'x..x..x.x..x..x.', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.',
    hue: 140,
  },
  synthwave: {
    name: 'Synthwave', bpm: 100, swing: 0,
    lo: 55,
    scale: [0, 2, 3, 5, 7, 8, 10],
    wave: 'sawtooth', detune: 14, cutoff: 3200, q: 2, attack: 0.02, release: 0.3, leadGain: 0.15, vibrato: 12,
    reverb: 0.6, delay: 0.38,
    prog: [0, -4, -7, -2], chord: [0, 3, 7, 12], padWave: 'sawtooth', padGain: 0.035,
    bassWave: 'sawtooth', bassGain: 0.2, bass: 'xxxxxxxxxxxxxxxx',
    kit: 'hard', kick: 'x...x...x...x...', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.',
    hue: 290,
  },
};

export const GENRE_ORDER = ['lofi', 'techno', 'ambient', 'chip', 'synthwave'];
export const RANGE = 36;   // semitones covered by the canvas height (3 octaves)
export const BARS = 4;     // loop length
