// Editing logic: cursor, selection, undo/redo, clipboard and every edit command.
// No DOM here; the app calls these methods from keyboard shortcuts and toolbar buttons.

import { DURATIONS, MAX_FRET } from '../core/constants.js';
import {
  beatTicks, clone, createBeat, createMeasure, effectiveTimeSignature, fitDuration,
  isMeasureEmpty, isRest, measureCapacity, measureContentTicks, noteAt, pitchOf,
} from '../core/model.js';
import { comparePos, soundingPitch } from '../core/timing.js';

const UNDO_LIMIT = 200;
const TWO_DIGIT_MS = 800;
const NOTE_FLAGS = ['hammer', 'slide', 'vibrato', 'dead', 'ghost', 'harmonic'];
const EXCLUSIVE = { hammer: ['slide'], slide: ['hammer'], dead: ['harmonic'], harmonic: ['dead'] };

export class Editor {
  constructor(song) {
    this.song = song;
    this.cursor = { m: 0, b: 0, s: 0 };
    this.anchor = null; // selection anchor {m, b}; selection is anchor..cursor
    this.undoStack = [];
    this.redoStack = [];
    this.clipboard = null;
    this.pending = null;
    this.dur = { duration: 4, dotted: false, triplet: false };
    this.onChange = () => {};
  }

  // ---------------------------------------------------------------- basics

  setSong(song, { keepHistory = false } = {}) {
    this.song = song;
    if (!keepHistory) {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.anchor = null;
    this.pending = null;
    this.clampCursor();
  }

  beat(pos = this.cursor) {
    return this.song.measures[pos.m].beats[pos.b];
  }

  measure(m = this.cursor.m) {
    return this.song.measures[m];
  }

  clampCursor() {
    const s = this.song;
    const c = this.cursor;
    c.m = Math.max(0, Math.min(s.measures.length - 1, c.m));
    c.b = Math.max(0, Math.min(s.measures[c.m].beats.length - 1, c.b));
    c.s = Math.max(0, Math.min(s.tuning.length - 1, c.s));
    if (this.anchor) {
      this.anchor.m = Math.max(0, Math.min(s.measures.length - 1, this.anchor.m));
      this.anchor.b = Math.max(0, Math.min(s.measures[this.anchor.m].beats.length - 1, this.anchor.b));
    }
  }

  _snapshot() {
    return JSON.stringify({ song: this.song, cursor: this.cursor });
  }

  /** Save the current state for undo. Call before every change. */
  commit() {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.song.updated = new Date().toISOString();
  }

  _restore(snap) {
    const { song, cursor } = JSON.parse(snap);
    this.song = song;
    this.cursor = cursor;
    this.anchor = null;
    this.pending = null;
    this.clampCursor();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
    this.onChange('undo');
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
    this.onChange('redo');
    return true;
  }

  _changed(kind = 'edit') {
    this.onChange(kind);
  }

  // ---------------------------------------------------------------- selection

  hasSelection() {
    return !!this.anchor && comparePos(this.anchor, this.cursor) !== 0;
  }

  /** Ordered selection { start: {m,b}, end: {m,b} }, or null. */
  selection() {
    if (!this.anchor) return null;
    const a = { m: this.anchor.m, b: this.anchor.b };
    const c = { m: this.cursor.m, b: this.cursor.b };
    return comparePos(a, c) <= 0 ? { start: a, end: c } : { start: c, end: a };
  }

  /**
   * True when the selection is whole bars: several complete bars, or one complete bar that is full.
   * (All the beats of an unfinished bar are treated as beats, so they paste as beats.)
   */
  selectionIsMeasures() {
    const sel = this.selection();
    if (!sel) return false;
    if (sel.start.b !== 0 || sel.end.b !== this.song.measures[sel.end.m].beats.length - 1) return false;
    if (sel.end.m > sel.start.m) return true;
    return measureContentTicks(this.song.measures[sel.start.m]) >= measureCapacity(this.song, sel.start.m);
  }

  /** Visit every selected beat (or the cursor beat when nothing is selected). */
  _eachTargetBeat(fn) {
    const sel = this.selection();
    if (!sel) {
      fn(this.beat(), this.cursor.m, this.cursor.b);
      return;
    }
    for (let m = sel.start.m; m <= sel.end.m; m++) {
      const beats = this.song.measures[m].beats;
      const b0 = m === sel.start.m ? sel.start.b : 0;
      const b1 = m === sel.end.m ? sel.end.b : beats.length - 1;
      for (let b = b0; b <= b1; b++) fn(beats[b], m, b);
    }
  }

  clearSelection() {
    const had = !!this.anchor;
    this.anchor = null;
    if (had) this._changed('cursor');
    return had;
  }

  selectAll() {
    const last = this.song.measures.length - 1;
    this.anchor = { m: 0, b: 0 };
    this.cursor.m = last;
    this.cursor.b = this.song.measures[last].beats.length - 1;
    this._changed('cursor');
  }

  _beginMove(extend) {
    this.pending = null;
    if (extend) {
      if (!this.anchor) this.anchor = { m: this.cursor.m, b: this.cursor.b };
    } else this.anchor = null;
  }

  // ---------------------------------------------------------------- navigation

  setCursor(m, b, s, { extend = false } = {}) {
    this._beginMove(extend);
    this.cursor.m = m;
    this.cursor.b = b;
    if (s !== undefined) this.cursor.s = s;
    this.clampCursor();
    this._changed('cursor');
  }

  left({ extend = false } = {}) {
    this._beginMove(extend);
    const c = this.cursor;
    if (c.b > 0) c.b--;
    else if (c.m > 0) {
      c.m--;
      c.b = this.song.measures[c.m].beats.length - 1;
    }
    this._changed('cursor');
  }

  /**
   * Move right. On the last beat of a bar that still has room, a new rest beat is added
   * (that is how notes and rests are entered). On a full bar, the cursor moves to the next
   * bar, adding one at the end of the song.
   */
  right({ extend = false } = {}) {
    this._beginMove(extend);
    const c = this.cursor;
    const measure = this.measure();
    if (c.b < measure.beats.length - 1) {
      c.b++;
      this._changed('cursor');
      return;
    }
    if (extend) {
      if (c.m < this.song.measures.length - 1) {
        c.m++;
        c.b = 0;
        this._changed('cursor');
      }
      return;
    }
    const room = measureCapacity(this.song, c.m) - measureContentTicks(measure);
    const cur = this.beat();
    if (room > 0) {
      const fit = fitDuration(room, cur);
      if (fit) {
        this.commit();
        measure.beats.push(createBeat(fit.duration, fit.dotted, fit.triplet));
        c.b++;
        this._changed('edit');
        return;
      }
    }
    if (c.m < this.song.measures.length - 1) {
      c.m++;
      c.b = 0;
      this._changed('cursor');
      return;
    }
    this.commit();
    this.song.measures.push(createMeasure(cur.duration, cur.dotted, cur.triplet));
    c.m++;
    c.b = 0;
    this._changed('edit');
  }

  up() {
    this.pending = null;
    if (this.cursor.s > 0) this.cursor.s--;
    this._changed('cursor');
  }

  down() {
    this.pending = null;
    if (this.cursor.s < this.song.tuning.length - 1) this.cursor.s++;
    this._changed('cursor');
  }

  nextMeasure({ extend = false } = {}) {
    this._beginMove(extend);
    const c = this.cursor;
    if (c.m < this.song.measures.length - 1) {
      c.m++;
      c.b = extend ? this.song.measures[c.m].beats.length - 1 : 0;
      this._changed('cursor');
    } else if (!extend) {
      this.commit();
      const cur = this.beat();
      this.song.measures.push(createMeasure(cur.duration, cur.dotted, cur.triplet));
      c.m++;
      c.b = 0;
      this._changed('edit');
    } else {
      c.b = this.measure().beats.length - 1;
      this._changed('cursor');
    }
  }

  prevMeasure({ extend = false } = {}) {
    this._beginMove(extend);
    const c = this.cursor;
    if (c.b > 0 && !extend) c.b = 0;
    else if (c.m > 0) {
      c.m--;
      c.b = 0;
    } else c.b = 0;
    this._changed('cursor');
  }

  home({ extend = false } = {}) {
    this._beginMove(extend);
    this.cursor.b = 0;
    this._changed('cursor');
  }

  end({ extend = false } = {}) {
    this._beginMove(extend);
    this.cursor.b = this.measure().beats.length - 1;
    this._changed('cursor');
  }

  songStart({ extend = false } = {}) {
    this._beginMove(extend);
    this.cursor.m = 0;
    this.cursor.b = 0;
    this._changed('cursor');
  }

  songEnd({ extend = false } = {}) {
    this._beginMove(extend);
    this.cursor.m = this.song.measures.length - 1;
    this.cursor.b = this.measure().beats.length - 1;
    this._changed('cursor');
  }

  // ---------------------------------------------------------------- notes

  /**
   * Type a fret digit at the cursor. Two digits typed quickly make one number (1 then 2 is 12).
   * Returns the MIDI pitch to audition.
   */
  typeDigit(d, now = Date.now()) {
    const c = this.cursor;
    const p = this.pending;
    let fret = d;
    let combine = false;
    if (p && p.m === c.m && p.b === c.b && p.s === c.s && now - p.time < TWO_DIGIT_MS && p.value > 0) {
      const two = p.value * 10 + d;
      if (two <= MAX_FRET) {
        fret = two;
        combine = true;
      }
    }
    if (!combine) this.commit();
    this.anchor = null;
    const beat = this.beat();
    let note = noteAt(beat, c.s);
    if (note) {
      note.fret = fret;
      delete note.dead;
    } else {
      note = { string: c.s, fret };
      beat.notes.push(note);
      beat.notes.sort((a, b) => a.string - b.string);
    }
    this.pending = combine ? null : { m: c.m, b: c.b, s: c.s, value: d, time: now };
    this._changed('edit');
    return soundingPitch(this.song, note);
  }

  /** Delete or Backspace. Returns true when something changed. */
  deleteAtCursor({ backspace = false } = {}) {
    this.pending = null;
    if (this.hasSelection()) return this.deleteSelection();
    this.anchor = null;
    const c = this.cursor;
    const beat = this.beat();
    const note = noteAt(beat, c.s);
    if (note) {
      this.commit();
      beat.notes = beat.notes.filter((n) => n !== note);
      this._changed('edit');
      return true;
    }
    if (!isRest(beat)) return false;
    const measure = this.measure();
    if (measure.beats.length > 1) {
      this.commit();
      measure.beats.splice(c.b, 1);
      if (backspace && c.b > 0) c.b--;
      this.clampCursor();
      this._changed('edit');
      return true;
    }
    if (this.song.measures.length > 1 && isMeasureEmpty(measure)) {
      this.commit();
      this._removeMeasures(c.m, c.m);
      if (backspace && c.m > 0) {
        c.m--;
        c.b = this.measure().beats.length - 1;
      }
      this.clampCursor();
      this._changed('edit');
      return true;
    }
    return false;
  }

  /** Remove the whole beat under the cursor (or the selected beats). */
  deleteBeat() {
    if (this.hasSelection()) return this.deleteSelection();
    const measure = this.measure();
    this.commit();
    if (measure.beats.length > 1) measure.beats.splice(this.cursor.b, 1);
    else measure.beats[0] = createBeat(measure.beats[0].duration, measure.beats[0].dotted, measure.beats[0].triplet);
    this.clampCursor();
    this._changed('edit');
    return true;
  }

  deleteSelection() {
    const sel = this.selection();
    if (!sel) return false;
    this.commit();
    if (this.selectionIsMeasures()) {
      this._removeMeasures(sel.start.m, sel.end.m);
      this.cursor.m = Math.min(sel.start.m, this.song.measures.length - 1);
      this.cursor.b = 0;
    } else {
      for (let m = sel.end.m; m >= sel.start.m; m--) {
        const beats = this.song.measures[m].beats;
        const b0 = m === sel.start.m ? sel.start.b : 0;
        const b1 = m === sel.end.m ? sel.end.b : beats.length - 1;
        beats.splice(b0, b1 - b0 + 1);
        if (beats.length === 0) beats.push(createBeat(this.dur.duration, this.dur.dotted, this.dur.triplet));
      }
      this.cursor.m = sel.start.m;
      this.cursor.b = sel.start.b;
    }
    this.anchor = null;
    this.clampCursor();
    this._changed('edit');
    return true;
  }

  insertBeat() {
    this.commit();
    this.anchor = null;
    const cur = this.beat();
    this.measure().beats.splice(this.cursor.b, 0, createBeat(cur.duration, cur.dotted, cur.triplet));
    this._changed('edit');
  }

  /** Add an empty bar after (or before) the current one and move into it. */
  insertMeasure({ before = false } = {}) {
    this.commit();
    this.anchor = null;
    const at = before ? this.cursor.m : this.cursor.m + 1;
    const cur = this.beat();
    const m = createMeasure(cur.duration, cur.dotted, cur.triplet);
    this.song.measures.splice(at, 0, m);
    this._shiftSyncPoints(at, 1);
    this.cursor.m = at;
    this.cursor.b = 0;
    this._fixTimeSignatureAt(at);
    this._changed('edit');
  }

  deleteMeasures() {
    const sel = this.selection();
    const a = sel ? sel.start.m : this.cursor.m;
    const b = sel ? sel.end.m : this.cursor.m;
    this.commit();
    this._removeMeasures(a, b);
    this.anchor = null;
    this.cursor.m = Math.min(a, this.song.measures.length - 1);
    this.cursor.b = 0;
    this.clampCursor();
    this._changed('edit');
  }

  _removeMeasures(a, b) {
    const s = this.song;
    // Keep the time signature in force after the removed bars.
    const after = b + 1 < s.measures.length ? effectiveTimeSignature(s, b + 1) : null;
    s.measures.splice(a, b - a + 1);
    if (s.measures.length === 0) s.measures.push(createMeasure(this.dur.duration));
    if (after && a < s.measures.length) {
      if (a === 0) {
        s.timeSignature = after.slice();
        delete s.measures[0].timeSignature;
      } else if (!s.measures[a].timeSignature) {
        const prev = effectiveTimeSignature(s, a - 1);
        if (prev[0] !== after[0] || prev[1] !== after[1]) s.measures[a].timeSignature = after.slice();
      }
    }
    if (s.backingTrack) {
      const n = b - a + 1;
      s.backingTrack.syncPoints = s.backingTrack.syncPoints
        .filter((p) => p.measure < a || p.measure > b)
        .map((p) => (p.measure > b ? { ...p, measure: p.measure - n } : p))
        .filter((p) => p.measure >= 1 && p.measure < s.measures.length);
    }
  }

  _shiftSyncPoints(from, delta) {
    const bt = this.song.backingTrack;
    if (!bt) return;
    bt.syncPoints = bt.syncPoints.map((p) => (p.measure >= from ? { ...p, measure: p.measure + delta } : p));
  }

  _fixTimeSignatureAt(at) {
    // A bar inserted before a change keeps the meter of the bar before it.
    const s = this.song;
    const m = s.measures[at];
    if (m.timeSignature) delete m.timeSignature;
    const next = s.measures[at + 1];
    if (at === 0 && next && next.timeSignature) delete next.timeSignature;
  }

  // ---------------------------------------------------------------- rhythm

  setDuration(duration) {
    this.commit();
    this.dur.duration = duration;
    this._eachTargetBeat((beat) => {
      beat.duration = duration;
    });
    this._changed('edit');
  }

  shorter() {
    const i = DURATIONS.indexOf(this.beat().duration);
    if (i < DURATIONS.length - 1) this.setDuration(DURATIONS[i + 1]);
  }

  longer() {
    const i = DURATIONS.indexOf(this.beat().duration);
    if (i > 0) this.setDuration(DURATIONS[i - 1]);
  }

  toggleDotted() {
    const on = !this.beat().dotted;
    this.commit();
    this.dur.dotted = on;
    this._eachTargetBeat((beat) => {
      beat.dotted = on;
    });
    this._changed('edit');
  }

  toggleTriplet() {
    const on = !this.beat().triplet;
    this.commit();
    this.dur.triplet = on;
    this._eachTargetBeat((beat) => {
      beat.triplet = on;
    });
    this._changed('edit');
  }

  /** Clear every note of the beat(s): they become rests. */
  makeRest() {
    this.commit();
    this._eachTargetBeat((beat) => {
      beat.notes = [];
    });
    this._changed('edit');
  }

  // ---------------------------------------------------------------- techniques

  /**
   * Toggle a note technique. With a selection, applies to every note in it.
   * Returns an error message when there is no note to change.
   */
  toggleNoteFlag(flag) {
    if (!NOTE_FLAGS.includes(flag)) return 'Unknown technique';
    const targets = [];
    if (this.hasSelection()) this._eachTargetBeat((beat) => targets.push(...beat.notes));
    else {
      const n = noteAt(this.beat(), this.cursor.s);
      if (n) targets.push(n);
    }
    if (!targets.length) return 'Type a fret number first, then add the technique.';
    const on = !targets[0][flag];
    this.commit();
    for (const n of targets) {
      if (on) {
        n[flag] = true;
        for (const x of EXCLUSIVE[flag] || []) delete n[x];
      } else delete n[flag];
    }
    this._changed('edit');
    return null;
  }

  /** Bend cycles: none, full (2 semitones), half (1), one and a half (3). */
  cycleBend() {
    const targets = [];
    if (this.hasSelection()) this._eachTargetBeat((beat) => targets.push(...beat.notes));
    else {
      const n = noteAt(this.beat(), this.cursor.s);
      if (n) targets.push(n);
    }
    if (!targets.length) return 'Type a fret number first, then add the bend.';
    const order = [undefined, 2, 1, 3];
    const next = order[(order.indexOf(targets[0].bend) + 1) % order.length];
    this.commit();
    for (const n of targets) {
      if (next) n.bend = next;
      else delete n.bend;
    }
    this._changed('edit');
    return null;
  }

  togglePalmMute() {
    const on = !this.beat().palmMute;
    this.commit();
    this._eachTargetBeat((beat) => {
      if (on) beat.palmMute = true;
      else delete beat.palmMute;
    });
    this._changed('edit');
  }

  toggleStrum(dir) {
    const on = this.beat().strum !== dir;
    this.commit();
    this._eachTargetBeat((beat) => {
      if (on) beat.strum = dir;
      else delete beat.strum;
    });
    this._changed('edit');
  }

  setText(text) {
    this.commit();
    const t = String(text || '').trim().slice(0, 40);
    const beat = this.beat();
    if (t) beat.text = t;
    else delete beat.text;
    this._changed('edit');
  }

  setSection(text) {
    this.commit();
    const t = String(text || '').trim().slice(0, 40);
    const m = this.measure();
    if (t) m.section = t;
    else delete m.section;
    this._changed('edit');
  }

  /** Set the time signature from the current bar onwards (until the next change). */
  setTimeSignature(num, den) {
    this.commit();
    const s = this.song;
    const mi = this.cursor.m;
    if (mi === 0) s.timeSignature = [num, den];
    else s.measures[mi].timeSignature = [num, den];
    // Drop changes that repeat the meter already in force.
    for (let i = 1; i < s.measures.length; i++) {
      const ts = s.measures[i].timeSignature;
      if (!ts) continue;
      const prev = effectiveTimeSignature(s, i - 1);
      if (prev[0] === ts[0] && prev[1] === ts[1]) delete s.measures[i].timeSignature;
    }
    this._changed('edit');
  }

  // ---------------------------------------------------------------- clipboard

  copy() {
    const sel = this.selection();
    if (!sel) {
      this.clipboard = { measures: null, beats: [clone(this.beat())] };
      return 1;
    }
    if (this.selectionIsMeasures()) {
      this.clipboard = { measures: this.song.measures.slice(sel.start.m, sel.end.m + 1).map((m) => clone(m)), beats: null };
      return this.clipboard.measures.length;
    }
    const beats = [];
    this._eachTargetBeat((beat) => beats.push(clone(beat)));
    this.clipboard = { measures: null, beats };
    return beats.length;
  }

  cut() {
    this.copy();
    if (this.hasSelection()) this.deleteSelection();
    else this.deleteBeat();
  }

  /** Paste beats after the cursor (replacing an empty rest), or bars after the current bar. */
  paste() {
    const clip = this.clipboard;
    if (!clip) return false;
    this.commit();
    this.anchor = null;
    const c = this.cursor;
    const strings = this.song.tuning.length;
    const fitNotes = (beat) => {
      beat.notes = beat.notes.filter((n) => n.string < strings);
      return beat;
    };
    if (clip.measures) {
      const copies = clip.measures.map((m) => {
        const mm = clone(m);
        delete mm.timeSignature;
        mm.beats.forEach(fitNotes);
        return mm;
      });
      let at = c.m + 1;
      if (isMeasureEmpty(this.measure())) {
        at = c.m;
        this.song.measures.splice(at, 1);
        this._shiftSyncPoints(at + 1, -1);
      }
      this.song.measures.splice(at, 0, ...copies);
      this._shiftSyncPoints(at, copies.length);
      c.m = at;
      c.b = 0;
    } else {
      const copies = clip.beats.map((b) => fitNotes(clone(b)));
      const beats = this.measure().beats;
      if (isRest(this.beat()) && !this.beat().text) {
        beats.splice(c.b, 1, ...copies);
        c.b += copies.length - 1;
      } else {
        beats.splice(c.b + 1, 0, ...copies);
        c.b += copies.length;
      }
    }
    this.clampCursor();
    this._changed('edit');
    return true;
  }

  // ---------------------------------------------------------------- song settings

  setTempo(bpm) {
    this.commit();
    this.song.tempo = bpm;
    this._changed('edit');
  }

  /** Change tuning/instrument. Notes on strings that no longer exist are removed. */
  setTuning(instrument, notes) {
    this.commit();
    const s = this.song;
    s.instrument = instrument;
    s.tuning = notes.slice();
    for (const m of s.measures) for (const b of m.beats) b.notes = b.notes.filter((n) => n.string < notes.length);
    this.clampCursor();
    this._changed('edit');
  }

  /** Pitch of the note under the cursor, if any (for auditioning). */
  cursorPitch() {
    const n = noteAt(this.beat(), this.cursor.s);
    return n ? soundingPitch(this.song, n) : pitchOf(this.song, this.cursor.s, 0);
  }

  /** Remaining time in the current bar, in ticks (negative when overfull). */
  roomInBar() {
    return measureCapacity(this.song, this.cursor.m) - measureContentTicks(this.measure());
  }

  beatLength() {
    return beatTicks(this.beat());
  }
}
