// Shared constants for TabLab: rhythm units, instruments and tunings.

/** Ticks per quarter note. 960 divides cleanly by 2, 3, 4, 5, 6, 8, 16 and 32. */
export const TPQ = 960;

/** Ticks in a whole note. */
export const WHOLE = TPQ * 4;

/** Supported note values, as the denominator (1 = whole, 4 = quarter, 32 = thirty-second). */
export const DURATIONS = [1, 2, 4, 8, 16, 32];

export const DURATION_NAMES = {
  1: 'Whole',
  2: 'Half',
  4: 'Quarter',
  8: 'Eighth',
  16: 'Sixteenth',
  32: 'Thirty-second',
};

export const MAX_FRET = 24;
export const MIN_TEMPO = 20;
export const MAX_TEMPO = 320;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 1.5;

/** Time signature numerators and denominators offered in the UI. */
export const TS_NUMERATORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15];
export const TS_DENOMINATORS = [2, 4, 8, 16];

/**
 * Instruments and tuning presets. Notes are MIDI numbers listed from string 1
 * (the highest sounding, drawn at the top of the tab) to the lowest string.
 */
export const INSTRUMENTS = {
  guitar: {
    id: 'guitar',
    name: 'Guitar',
    strings: 6,
    tunings: [
      { id: 'standard', name: 'Standard (E A D G B E)', notes: [64, 59, 55, 50, 45, 40], labels: ['e', 'B', 'G', 'D', 'A', 'E'] },
      { id: 'drop-d', name: 'Drop D (D A D G B E)', notes: [64, 59, 55, 50, 45, 38], labels: ['e', 'B', 'G', 'D', 'A', 'D'] },
      { id: 'half-down', name: 'Half step down (Eb Ab Db Gb Bb Eb)', notes: [63, 58, 54, 49, 44, 39], labels: ['eb', 'Bb', 'Gb', 'Db', 'Ab', 'Eb'] },
      { id: 'full-down', name: 'Full step down (D G C F A D)', notes: [62, 57, 53, 48, 43, 38], labels: ['d', 'A', 'F', 'C', 'G', 'D'] },
      { id: 'open-g', name: 'Open G (D G D G B D)', notes: [62, 59, 55, 50, 43, 38], labels: ['d', 'B', 'G', 'D', 'G', 'D'] },
      { id: 'open-d', name: 'Open D (D A D F# A D)', notes: [62, 57, 54, 50, 45, 38], labels: ['d', 'A', 'F#', 'D', 'A', 'D'] },
      { id: 'dadgad', name: 'DADGAD', notes: [62, 57, 55, 50, 45, 38], labels: ['d', 'A', 'G', 'D', 'A', 'D'] },
    ],
  },
  ukulele: {
    id: 'ukulele',
    name: 'Ukulele',
    strings: 4,
    tunings: [
      { id: 'standard', name: 'Standard, high G (G C E A)', notes: [69, 64, 60, 67], labels: ['A', 'E', 'C', 'G'] },
      { id: 'low-g', name: 'Low G (G C E A)', notes: [69, 64, 60, 55], labels: ['A', 'E', 'C', 'G'] },
      { id: 'd-tuning', name: 'D tuning (A D F# B)', notes: [71, 66, 62, 69], labels: ['B', 'F#', 'D', 'A'] },
      { id: 'baritone', name: 'Baritone (D G B E)', notes: [64, 59, 55, 50], labels: ['E', 'B', 'G', 'D'] },
    ],
  },
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Note name without octave, for example 64 -> "E". */
export function noteName(midi) {
  return NOTE_NAMES[((midi % 12) + 12) % 12];
}

/** Note name with octave, for example 64 -> "E4". */
export function noteNameOctave(midi) {
  return noteName(midi) + (Math.floor(midi / 12) - 1);
}

/** Find a tuning preset by instrument and id. Returns undefined when unknown. */
export function findTuning(instrumentId, tuningId) {
  const inst = INSTRUMENTS[instrumentId];
  return inst ? inst.tunings.find((t) => t.id === tuningId) : undefined;
}

/** Find the preset whose notes match exactly, if any. */
export function matchTuning(instrumentId, notes) {
  const inst = INSTRUMENTS[instrumentId];
  if (!inst) return undefined;
  return inst.tunings.find((t) => t.notes.length === notes.length && t.notes.every((n, i) => n === notes[i]));
}

/**
 * String labels for a tuning (uses the preset labels when the notes match a preset).
 * The highest string is lower case on a guitar, as usual, and on a ukulele only when
 * another string has the same name.
 */
export function stringLabels(instrumentId, notes) {
  const preset = matchTuning(instrumentId, notes);
  if (preset) return preset.labels.slice();
  const names = notes.map(noteName);
  const lower = instrumentId === 'guitar' || names.indexOf(names[0], 1) > 0;
  return names.map((n, i) => (i === 0 && lower ? n.toLowerCase() : n));
}

/**
 * Key signatures, by the number of sharps (above 0) or flats (below 0), as song.key stores them.
 * Each has the major key and its relative minor, which share the signature.
 */
export const KEYS = [
  { key: -7, major: 'C♭', minor: 'A♭' },
  { key: -6, major: 'G♭', minor: 'E♭' },
  { key: -5, major: 'D♭', minor: 'B♭' },
  { key: -4, major: 'A♭', minor: 'F' },
  { key: -3, major: 'E♭', minor: 'C' },
  { key: -2, major: 'B♭', minor: 'G' },
  { key: -1, major: 'F', minor: 'D' },
  { key: 0, major: 'C', minor: 'A' },
  { key: 1, major: 'G', minor: 'E' },
  { key: 2, major: 'D', minor: 'B' },
  { key: 3, major: 'A', minor: 'F♯' },
  { key: 4, major: 'E', minor: 'C♯' },
  { key: 5, major: 'B', minor: 'G♯' },
  { key: 6, major: 'F♯', minor: 'D♯' },
  { key: 7, major: 'C♯', minor: 'A♯' },
];

/** "G major / E minor (1 sharp)" for a key signature. */
export function keyName(key, { long = true } = {}) {
  const k = KEYS.find((x) => x.key === key) || KEYS[7];
  const base = `${k.major} major / ${k.minor} minor`;
  if (!long) return base;
  const n = Math.abs(key);
  return n ? `${base} (${n} ${key > 0 ? 'sharp' : 'flat'}${n > 1 ? 's' : ''})` : `${base} (no sharps or flats)`;
}

/** Notes a custom tuning can use for each instrument (MIDI numbers, lowest to highest). */
export const TUNING_RANGE = { guitar: [24, 76], ukulele: [43, 81] };
