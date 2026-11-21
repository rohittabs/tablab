// Song data model: creation, validation and small helpers.
// The model is plain JSON so it can be saved, diffed and loaded safely.
//
// Song
//   { format: 'tablab', version: 1, id, title, artist, instrument, tuning: [midi...],
//     capo, key (-7 flats .. 7 sharps), tempo, timeSignature: [num, den], measures: [Measure], backingTrack, created, updated }
// Measure
//   { beats: [Beat], timeSignature?: [num, den] (a change that starts here), section?: string }
// Beat
//   { duration: 1|2|4|8|16|32, dotted: bool, triplet: bool, notes: [Note],
//     strum?: 'down'|'up', text?: string, palmMute?: true }
// Note
//   { string: 0 (highest) .. n-1, fret: 0..24, hammer?, slide?, bend?: 1|2|3 (semitones),
//     vibrato?, dead?, ghost?, harmonic? }

import { DURATIONS, INSTRUMENTS, MAX_FRET, MAX_TEMPO, MIN_TEMPO, TS_DENOMINATORS, WHOLE } from './constants.js';

export const FORMAT = 'tablab';
export const VERSION = 1;

export const NOTE_FLAGS = ['hammer', 'slide', 'vibrato', 'dead', 'ghost', 'harmonic'];

export function uid() {
  const a = new Uint8Array(8);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(a);
  else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function createBeat(duration = 4, dotted = false, triplet = false) {
  return { duration, dotted: !!dotted, triplet: !!triplet, notes: [] };
}

export function createMeasure(duration = 4, dotted = false, triplet = false) {
  return { beats: [createBeat(duration, dotted, triplet)] };
}

export function createSong({ instrument = 'guitar', tuningId = 'standard', title = 'Untitled', tempo = 100, timeSignature = [4, 4], measures = 1 } = {}) {
  const inst = INSTRUMENTS[instrument] || INSTRUMENTS.guitar;
  const tuning = (inst.tunings.find((t) => t.id === tuningId) || inst.tunings[0]).notes.slice();
  const now = new Date().toISOString();
  const song = {
    format: FORMAT,
    version: VERSION,
    id: uid(),
    title,
    artist: '',
    instrument: inst.id,
    tuning,
    capo: 0,
    key: 0,
    tempo,
    timeSignature: timeSignature.slice(),
    measures: [],
    backingTrack: null,
    created: now,
    updated: now,
  };
  for (let i = 0; i < Math.max(1, measures); i++) song.measures.push(createMeasure());
  return song;
}

/** Length of a beat in ticks. */
export function beatTicks(beat) {
  let t = WHOLE / beat.duration;
  if (beat.dotted) t *= 1.5;
  if (beat.triplet) t = (t * 2) / 3;
  return Math.round(t);
}

/** Ticks in one bar of the given time signature. */
export function tsTicks(ts) {
  return Math.round((ts[0] * WHOLE) / ts[1]);
}

/** Time signature in force at measure index mi (changes carry forward). */
export function effectiveTimeSignature(song, mi) {
  for (let i = Math.min(mi, song.measures.length - 1); i >= 0; i--) {
    const ts = song.measures[i].timeSignature;
    if (ts) return ts;
  }
  return song.timeSignature;
}

export function measureCapacity(song, mi) {
  return tsTicks(effectiveTimeSignature(song, mi));
}

export function measureContentTicks(measure) {
  let t = 0;
  for (const b of measure.beats) t += beatTicks(b);
  return t;
}

export function noteAt(beat, string) {
  return beat.notes.find((n) => n.string === string);
}

export function isRest(beat) {
  return beat.notes.length === 0;
}

export function isMeasureEmpty(measure) {
  return measure.beats.every(isRest);
}

/** Sounding MIDI pitch for a fret on a string, including capo. */
export function pitchOf(song, string, fret) {
  return song.tuning[string] + (song.capo || 0) + fret;
}

export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Pick the longest standard duration (plain or dotted) that fits in `remaining` ticks.
 * Prefers `preferred` ({duration, dotted, triplet}) when it fits. Returns null if nothing fits.
 */
export function fitDuration(remaining, preferred) {
  if (preferred && beatTicks(preferred) <= remaining) {
    return { duration: preferred.duration, dotted: !!preferred.dotted, triplet: !!preferred.triplet };
  }
  const options = [];
  for (const d of DURATIONS) {
    options.push({ duration: d, dotted: true, triplet: false });
    options.push({ duration: d, dotted: false, triplet: false });
  }
  options.sort((a, b) => beatTicks(b) - beatTicks(a));
  for (const o of options) if (beatTicks(o) <= remaining) return o;
  return null;
}

// ---------------------------------------------------------------------------
// Validation. Anything loaded from a file or storage goes through normalizeSong
// so the rest of the app can trust the shape of the data.

function int(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function num(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(v, maxLen, fallback = '') {
  if (typeof v !== 'string') return fallback;
  return v.replace(/[\u0000-\u001f]/g, ' ').slice(0, maxLen);
}

function validTs(ts) {
  return Array.isArray(ts) && ts.length === 2 && Number.isInteger(ts[0]) && ts[0] >= 1 && ts[0] <= 32 && TS_DENOMINATORS.concat([1, 32]).includes(ts[1]);
}

function normalizeNote(raw, stringCount) {
  if (!raw || typeof raw !== 'object') return null;
  const string = Number(raw.string);
  const fret = Number(raw.fret);
  if (!Number.isInteger(string) || string < 0 || string >= stringCount) return null;
  if (!Number.isInteger(fret) || fret < 0 || fret > MAX_FRET) return null;
  const n = { string, fret };
  for (const f of NOTE_FLAGS) if (raw[f] === true) n[f] = true;
  if ([1, 2, 3].includes(raw.bend)) n.bend = raw.bend;
  return n;
}

function normalizeBeat(raw, stringCount) {
  if (!raw || typeof raw !== 'object') return createBeat();
  const b = createBeat(DURATIONS.includes(raw.duration) ? raw.duration : 4, raw.dotted === true, raw.triplet === true);
  const seen = new Set();
  if (Array.isArray(raw.notes)) {
    for (const rn of raw.notes) {
      const n = normalizeNote(rn, stringCount);
      if (n && !seen.has(n.string)) {
        seen.add(n.string);
        b.notes.push(n);
      }
    }
  }
  b.notes.sort((x, y) => x.string - y.string);
  if (raw.strum === 'down' || raw.strum === 'up') b.strum = raw.strum;
  const text = str(raw.text, 40).trim();
  if (text) b.text = text;
  if (raw.palmMute === true) b.palmMute = true;
  return b;
}

function normalizeMeasure(raw, stringCount) {
  const m = { beats: [] };
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.beats)) for (const rb of raw.beats.slice(0, 256)) m.beats.push(normalizeBeat(rb, stringCount));
    if (validTs(raw.timeSignature)) m.timeSignature = raw.timeSignature.slice();
    const section = str(raw.section, 40).trim();
    if (section) m.section = section;
  }
  if (m.beats.length === 0) m.beats.push(createBeat());
  return m;
}

function normalizeBacking(raw, measureCount) {
  if (!raw || typeof raw !== 'object') return null;
  const bt = {
    fileName: str(raw.fileName, 200, 'backing track'),
    offset: num(raw.offset, -600, 36000, 0),
    volume: num(raw.volume, 0, 1.5, 0.9),
    syncPoints: [],
  };
  if (Array.isArray(raw.syncPoints)) {
    const seen = new Set();
    for (const p of raw.syncPoints) {
      if (!p || typeof p !== 'object') continue;
      const m = Number(p.measure);
      const t = Number(p.time);
      if (!Number.isInteger(m) || m < 1 || m >= Math.max(1, measureCount) || !Number.isFinite(t) || seen.has(m)) continue;
      seen.add(m);
      bt.syncPoints.push({ measure: m, time: t });
    }
    bt.syncPoints.sort((a, b) => a.measure - b.measure);
  }
  return bt;
}

/** Validate and repair a song loaded from JSON. Throws on input that is not a TabLab song. */
export function normalizeSong(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== FORMAT) throw new Error('This file is not a TabLab song.');
  if (Number(raw.version) > VERSION) throw new Error('This song was saved by a newer version of TabLab.');
  const instrument = INSTRUMENTS[raw.instrument] ? raw.instrument : 'guitar';
  let tuning = raw.tuning;
  const tuningOk = Array.isArray(tuning) && tuning.length >= 3 && tuning.length <= 8 && tuning.every((n) => Number.isInteger(n) && n >= 12 && n <= 108);
  if (!tuningOk) tuning = INSTRUMENTS[instrument].tunings[0].notes.slice();
  else tuning = tuning.slice();
  const song = {
    format: FORMAT,
    version: VERSION,
    id: typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{4,40}$/.test(raw.id) ? raw.id : uid(),
    title: str(raw.title, 120, 'Untitled').trim() || 'Untitled',
    artist: str(raw.artist, 120).trim(),
    instrument,
    tuning,
    capo: int(raw.capo, 0, 12, 0),
    key: int(raw.key, -7, 7, 0),
    tempo: num(raw.tempo, MIN_TEMPO, MAX_TEMPO, 100),
    timeSignature: validTs(raw.timeSignature) ? raw.timeSignature.slice() : [4, 4],
    measures: [],
    backingTrack: null,
    created: str(raw.created, 40) || new Date().toISOString(),
    updated: str(raw.updated, 40) || new Date().toISOString(),
  };
  song.tempo = Math.round(song.tempo * 100) / 100;
  if (Array.isArray(raw.measures)) {
    for (const rm of raw.measures.slice(0, 4000)) song.measures.push(normalizeMeasure(rm, tuning.length));
  }
  if (song.measures.length === 0) song.measures.push(createMeasure());
  // Measure 1 never stores its own change; the song-level signature covers it.
  if (song.measures[0].timeSignature) {
    song.timeSignature = song.measures[0].timeSignature;
    delete song.measures[0].timeSignature;
  }
  song.backingTrack = normalizeBacking(raw.backingTrack, song.measures.length);
  return song;
}
