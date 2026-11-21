// Timing: where every measure and beat sits in ticks, how ticks map to seconds
// (including backing track sync points), and the event list used for playback.

import { TPQ, WHOLE } from './constants.js';
import { beatTicks, effectiveTimeSignature, pitchOf, tsTicks } from './model.js';

/**
 * Build the tick layout of a song.
 * A measure lasts at least its time signature length. If it holds more beats than fit,
 * it lasts as long as its content (it is shown as overfull in the editor).
 */
export function buildTimeline(song) {
  const measures = [];
  let tick = 0;
  for (let mi = 0; mi < song.measures.length; mi++) {
    const m = song.measures[mi];
    const ts = effectiveTimeSignature(song, mi);
    const capacity = tsTicks(ts);
    const beats = [];
    let t = tick;
    for (let bi = 0; bi < m.beats.length; bi++) {
      const len = beatTicks(m.beats[bi]);
      beats.push({ start: t, length: len });
      t += len;
    }
    const content = t - tick;
    const length = Math.max(capacity, content);
    measures.push({ index: mi, start: tick, length, capacity, content, ts, beats });
    tick += length;
  }
  return { measures, totalTicks: tick };
}

/** Index of the measure containing `tick` (clamped to the song). */
export function measureAtTick(timeline, tick) {
  const ms = timeline.measures;
  let lo = 0;
  let hi = ms.length - 1;
  if (tick <= 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ms[mid].start <= tick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Locate the beat that is sounding at `tick`.
 * Returns { m, b, frac } where frac is the position inside the beat (0..1),
 * or inside the silent tail of an underfull measure (then b is the last beat and frac > 1 is clamped).
 */
export function locateTick(timeline, tick) {
  const m = measureAtTick(timeline, tick);
  const mt = timeline.measures[m];
  const beats = mt.beats;
  let b = 0;
  for (let i = beats.length - 1; i >= 0; i--) {
    if (beats[i].start <= tick) {
      b = i;
      break;
    }
  }
  const bt = beats[b];
  const frac = bt.length > 0 ? (tick - bt.start) / bt.length : 0;
  return { m, b, frac: Math.max(0, frac) };
}

/** Next beat position after (m, b) in song order, or null at the end. */
export function nextBeatPos(song, m, b) {
  if (b + 1 < song.measures[m].beats.length) return { m, b: b + 1 };
  if (m + 1 < song.measures.length) return { m: m + 1, b: 0 };
  return null;
}

export function prevBeatPos(song, m, b) {
  if (b > 0) return { m, b: b - 1 };
  if (m > 0) return { m: m - 1, b: song.measures[m - 1].beats.length - 1 };
  return null;
}

/** Compare two beat positions in song order. */
export function comparePos(a, b) {
  return a.m - b.m || a.b - b.b;
}

/**
 * The note that a hammer-on or slide on (m, b, string) connects to:
 * the note on the same string in the very next beat, if there is one.
 */
export function connectedNote(song, m, b, string) {
  const next = nextBeatPos(song, m, b);
  if (!next) return null;
  const beat = song.measures[next.m].beats[next.b];
  const note = beat.notes.find((n) => n.string === string);
  return note ? { m: next.m, b: next.b, note } : null;
}

/** The note on the same string in the previous beat, if there is one. */
export function previousNote(song, m, b, string) {
  const prev = prevBeatPos(song, m, b);
  if (!prev) return null;
  const beat = song.measures[prev.m].beats[prev.b];
  const note = beat.notes.find((n) => n.string === string);
  return note ? { m: prev.m, b: prev.b, note } : null;
}

/**
 * Maps ticks to seconds and back.
 * Without a backing track, time 0 is the start of measure 1 and the song tempo applies throughout.
 * With a backing track, time is the position in the audio file: measure 1 starts at `offset`,
 * and each sync point pins the start of a measure to a time in the audio. Between pins the
 * tempo is constant (linear interpolation). After the last pin the last segment's tempo continues.
 */
export class SyncMap {
  constructor(song, timeline) {
    this.spt = 60 / (song.tempo * TPQ);
    const bt = song.backingTrack;
    const anchors = [{ tick: 0, time: bt ? bt.offset : 0, measure: 0 }];
    if (bt) {
      for (const sp of bt.syncPoints) {
        const mt = timeline.measures[sp.measure];
        if (!mt) continue;
        const prev = anchors[anchors.length - 1];
        if (mt.start > prev.tick && sp.time > prev.time + 0.02) anchors.push({ tick: mt.start, time: sp.time, measure: sp.measure });
      }
    }
    this.anchors = anchors;
    this.slopes = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      this.slopes.push((anchors[i + 1].time - anchors[i].time) / (anchors[i + 1].tick - anchors[i].tick));
    }
    this.headSlope = this.slopes.length ? this.slopes[0] : this.spt;
    this.tailSlope = this.slopes.length ? this.slopes[this.slopes.length - 1] : this.spt;
  }

  _segmentForTick(tick) {
    const a = this.anchors;
    let lo = 0;
    let hi = a.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  _segmentForTime(time) {
    const a = this.anchors;
    let lo = 0;
    let hi = a.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (a[mid].time <= time) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Seconds per tick in force at `tick`. */
  slopeAt(tick) {
    const a = this.anchors;
    if (tick < a[0].tick) return this.headSlope;
    const i = this._segmentForTick(tick);
    return i < this.slopes.length ? this.slopes[i] : this.tailSlope;
  }

  tickToTime(tick) {
    const a = this.anchors;
    if (tick <= a[0].tick) return a[0].time + (tick - a[0].tick) * this.headSlope;
    const i = this._segmentForTick(tick);
    const slope = i < this.slopes.length ? this.slopes[i] : this.tailSlope;
    return a[i].time + (tick - a[i].tick) * slope;
  }

  timeToTick(time) {
    const a = this.anchors;
    if (time <= a[0].time) return a[0].tick + (time - a[0].time) / this.headSlope;
    const i = this._segmentForTime(time);
    const slope = i < this.slopes.length ? this.slopes[i] : this.tailSlope;
    return a[i].tick + (time - a[i].time) / slope;
  }

  /** Quarter notes per minute in force at `tick`. */
  bpmAt(tick) {
    return 60 / (this.slopeAt(tick) * TPQ);
  }
}

const HARMONIC_OFFSETS = { 12: 12, 24: 24, 7: 19, 19: 19, 5: 24, 4: 28, 9: 28, 16: 28, 3: 31 };

/** Pitch that a note sounds, including harmonics and capo. */
export function soundingPitch(song, note) {
  if (note.harmonic) {
    const off = HARMONIC_OFFSETS[note.fret];
    if (off !== undefined) return song.tuning[note.string] + (song.capo || 0) + off;
  }
  return pitchOf(song, note.string, note.fret);
}

/**
 * Playback events between fromTick (inclusive) and toTick (exclusive), sorted by tick.
 * kinds: 'click' { accent: 2 bar start | 1 group start | 0 }, 'beat' { m, b, notes: [...] }
 */
export function buildEvents(song, timeline, fromTick = 0, toTick = Infinity) {
  const events = [];
  for (const mt of timeline.measures) {
    const mEnd = mt.start + mt.length;
    if (mEnd <= fromTick || mt.start >= toTick) continue;
    const [num, den] = mt.ts;
    const unit = WHOLE / den;
    const compound = den === 8 && num % 3 === 0 && num > 3;
    const clicks = Math.ceil(mt.length / unit - 1e-9);
    for (let k = 0; k < clicks; k++) {
      const tick = Math.round(mt.start + k * unit);
      if (tick < fromTick || tick >= toTick) continue;
      const accent = k % num === 0 ? 2 : compound && k % 3 === 0 ? 1 : 0;
      events.push({ tick, kind: 'click', accent });
    }
    const measure = song.measures[mt.index];
    for (let bi = 0; bi < measure.beats.length; bi++) {
      const pos = mt.beats[bi];
      if (pos.start < fromTick || pos.start >= toTick) continue;
      const beat = measure.beats[bi];
      const notes = [];
      const order = beat.notes.slice().sort((a, b) => (beat.strum === 'up' ? a.string - b.string : b.string - a.string));
      order.forEach((note, idx) => {
        const prev = previousNote(song, mt.index, bi, note.string);
        const next = connectedNote(song, mt.index, bi, note.string);
        const ev = {
          string: note.string,
          midi: soundingPitch(song, note),
          ticks: pos.length,
          velocity: note.ghost ? 0.38 : 0.82,
          legato: !!(prev && (prev.note.hammer || prev.note.slide)),
          strumIndex: beat.strum ? idx : 0,
        };
        if (beat.palmMute) ev.muted = true;
        if (note.dead) ev.dead = true;
        if (note.vibrato) ev.vibrato = true;
        if (note.harmonic) ev.harmonic = true;
        if (note.bend) ev.bend = note.bend;
        if (note.slide) {
          if (next) ev.glideTo = soundingPitch(song, next.note);
          else ev.glideTo = ev.midi - 5; // slide out downwards
        }
        notes.push(ev);
      });
      events.push({ tick: pos.start, kind: 'beat', m: mt.index, b: bi, ticks: pos.length, notes, strum: beat.strum || null });
    }
  }
  events.sort((a, b) => a.tick - b.tick || (a.kind === b.kind ? 0 : a.kind === 'click' ? -1 : 1));
  return events;
}

/** Ticks of one metronome click in the time signature of measure `mi`. */
export function clickTicks(timeline, mi) {
  const mt = timeline.measures[Math.max(0, Math.min(mi, timeline.measures.length - 1))];
  return WHOLE / mt.ts[1];
}
