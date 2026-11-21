// Standard notation drawn above the tab: note spelling in the song's key, accidentals, stems,
// beams, rests and the clef. No DOM access, so it can be unit tested in Node.
//
// Positions on the staff are counted in diatonic steps: C4 (middle C) is 28, E4 (the bottom
// line of the treble staff) is 30 and F5 (the top line) is 38. Guitar music is written an
// octave above how it sounds, as usual, with a small 8 under the clef.

import { WHOLE } from '../core/constants.js';
import { soundingPitch } from '../core/timing.js';
import { GLYPHS } from './glyphs.js';

export const NS = 8; // staff space in pixels
const S = NS / 250; // glyph units to pixels
const BOTTOM_STEP = 30; // E4
const MIDDLE_STEP = 34; // B4
const STEM = 3.5 * NS;
const HEAD_W = (GLYPHS.headBlack.box[2] - GLYPHS.headBlack.box[0]) * S;
const HEAD_MID_Y = 134; // the font draws noteheads and accidentals half a space above their origin
const ACC_W = { 1: 8.2, '-1': 7.4, 0: 6.8 };

const NATURAL_PC = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
// Where the key signature goes on the treble staff, in the usual order.
const SHARP_STEPS = [38, 35, 39, 36, 33, 37, 34];
const FLAT_STEPS = [34, 37, 33, 36, 32, 35, 31];

/** The sharp (+1), flat (-1) or nothing (0) that the key gives a letter (0 = C .. 6 = B). */
export function keyAlter(letter, key) {
  if (key > 0 && SHARP_ORDER.slice(0, key).includes(letter)) return 1;
  if (key < 0 && FLAT_ORDER.slice(0, -key).includes(letter)) return -1;
  return 0;
}

/**
 * How a MIDI note is written in a key: { letter, alter, octave, step }.
 * Notes of the key use its spelling. A plain letter the key would change keeps its letter (and
 * gets a natural sign). Other notes are spelt with sharps in sharp keys and with flats in flat
 * keys; C major uses sharps, except B flat.
 */
export function spell(midi, key = 0) {
  const pc = ((midi % 12) + 12) % 12;
  let letter = -1;
  let alter = 0;
  for (let l = 0; l < 7; l++) {
    const a = keyAlter(l, key);
    if ((NATURAL_PC[l] + a + 12) % 12 === pc) {
      letter = l;
      alter = a;
      break;
    }
  }
  // A letter the key raises or lowers, played plain: write it with a natural (E natural in E flat).
  if (letter < 0) letter = NATURAL_PC.indexOf(pc);
  if (letter < 0) {
    const useFlat = key < 0 || (key === 0 && pc === 10);
    const target = (pc + (useFlat ? 1 : 11)) % 12;
    for (let l = 0; l < 7; l++) {
      const a = keyAlter(l, key);
      if ((NATURAL_PC[l] + a + 12) % 12 === target) {
        letter = l;
        alter = a + (useFlat ? -1 : 1);
        break;
      }
    }
  }
  const octave = Math.round((midi - alter - NATURAL_PC[letter]) / 12) - 1;
  return { letter, alter, octave, step: octave * 7 + letter };
}

/** How many semitones above the sounding pitch the music is written. */
export function writtenOffset(song) {
  if (song.instrument === 'guitar') return 12;
  const lowest = Math.min(...song.tuning) + (song.capo || 0);
  return lowest < 55 ? 12 : 0; // a baritone ukulele reads like a guitar
}

/** Notes that can be beamed together in a bar: groups of beat indexes. */
export function beamGroups(measure, mt) {
  const [num, den] = mt.ts;
  let unit = WHOLE / 4;
  if (den === 8 && num % 3 === 0) unit = (WHOLE / 8) * 3;
  else if (den === 2) unit = WHOLE / 2;
  const groups = [];
  let group = null;
  measure.beats.forEach((beat, bi) => {
    const rel = mt.beats[bi].start - mt.start;
    const g = Math.floor(rel / unit + 1e-9);
    const beamable = beat.duration >= 8 && beat.notes.length > 0;
    if (beamable && group && group.g === g) group.items.push(bi);
    else {
      if (group) groups.push(group);
      group = beamable ? { g, items: [bi] } : null;
    }
  });
  if (group) groups.push(group);
  return groups;
}

const yOf = (step) => -(step - BOTTOM_STEP) * (NS / 2); // relative to the bottom line

/**
 * Work out how every beat of a bar is written: noteheads and their accidentals, the stem
 * direction and length, beams. Accidentals last until the end of the bar, as usual.
 * Returns { beats: [{ heads, up, stemEnd, accCols, offset, beamed }], groups, top, bottom },
 * with y values relative to the bottom staff line (negative is higher).
 */
export function analyzeMeasure(song, timeline, mi) {
  const measure = song.measures[mi];
  const mt = timeline.measures[mi];
  const key = song.key || 0;
  const shift = writtenOffset(song);
  const state = new Map(); // step -> alter in force
  const beats = measure.beats.map((beat) => {
    if (!beat.notes.length) return { rest: true, heads: [], accCols: 0, offset: 0 };
    const heads = beat.notes
      .map((n) => {
        const sp = spell(soundingPitch(song, n) + shift, key);
        return { ...sp, note: n, y: yOf(sp.step), acc: null, dx: 0 };
      })
      .sort((a, b) => a.step - b.step);
    // Two notes on the same step (two strings, same note): draw one head.
    const uniq = [];
    for (const h of heads) if (!uniq.some((u) => u.step === h.step && u.alter === h.alter)) uniq.push(h);
    for (const h of uniq) {
      const inForce = state.has(h.step) ? state.get(h.step) : keyAlter(h.letter, key);
      if (h.alter !== inForce && !h.note.dead) {
        h.acc = h.alter;
        state.set(h.step, h.alter);
      }
    }
    const avg = uniq.reduce((a, h) => a + h.step, 0) / uniq.length;
    return { rest: false, heads: uniq, up: avg < MIDDLE_STEP, beat };
  });
  // Stems: beamed groups share a direction and a straight beam.
  const groups = beamGroups(measure, mt).filter((g) => g.items.length > 1);
  const inGroup = new Map();
  for (const g of groups) {
    const steps = g.items.flatMap((bi) => beats[bi].heads.map((h) => h.step));
    const avg = steps.reduce((a, s) => a + s, 0) / steps.length;
    g.up = avg < MIDDLE_STEP;
    const extra = (Math.max(...g.items.map((bi) => levels(measure.beats[bi].duration))) - 1) * 0.75 * NS;
    let end = g.up ? Infinity : -Infinity;
    for (const bi of g.items) {
      const b = beats[bi];
      b.up = g.up;
      const top = b.heads[b.heads.length - 1].y;
      const bottom = b.heads[0].y;
      end = g.up ? Math.min(end, top - STEM - extra) : Math.max(end, bottom + STEM + extra);
    }
    // Keep beams from floating far from the staff.
    if (g.up) end = Math.min(end, yOf(MIDDLE_STEP));
    else end = Math.max(end, yOf(MIDDLE_STEP));
    g.end = end;
    for (const bi of g.items) {
      beats[bi].stemEnd = end;
      beats[bi].beamed = true;
      inGroup.set(bi, g);
    }
  }
  let top = yOf(38) - 11; // the clef reaches above the staff
  let bottom = shift ? 25 : 13; // room for the 8 under the clef
  beats.forEach((b, bi) => {
    if (b.rest) return;
    const dur = measure.beats[bi].duration;
    const hi = b.heads[b.heads.length - 1].y;
    const lo = b.heads[0].y;
    if (!b.beamed) {
      // Single notes: stems reach the middle line at least, as engravers do.
      if (b.up) b.stemEnd = Math.min(hi - STEM - Math.max(0, levels(dur) - 2) * 0.75 * NS, yOf(MIDDLE_STEP));
      else b.stemEnd = Math.max(lo + STEM + Math.max(0, levels(dur) - 2) * 0.75 * NS, yOf(MIDDLE_STEP));
    }
    // Seconds in a chord: the upper (stem up) or lower (stem down) head moves beside the stem.
    const order = b.up ? b.heads : b.heads.slice().reverse();
    let prev = null;
    for (const h of order) {
      if (prev && Math.abs(h.step - prev.step) === 1 && prev.dx === 0) h.dx = b.up ? HEAD_W - 1 : -(HEAD_W - 1);
      prev = h;
    }
    // Accidentals in columns, from the top, so close ones do not collide.
    const cols = [];
    for (const h of b.heads.slice().reverse()) {
      if (h.acc === null) continue;
      let c = 0;
      while (cols[c] && cols[c].some((s) => Math.abs(s - h.step) < 6)) c++;
      (cols[c] ||= []).push(h.step);
      h.col = c;
    }
    b.accCols = cols.length;
    b.offset = (b.heads.some((h) => h.dx < 0) ? HEAD_W : 0) + cols.length * 8.5 + (cols.length ? 3 : 0);
    b.extraRight = b.heads.some((h) => h.dx > 0) ? HEAD_W : 0;
    if (dur === 1) b.stemEnd = undefined;
    top = Math.min(top, hi - NS, b.stemEnd ?? Infinity);
    bottom = Math.max(bottom, lo + NS, b.stemEnd ?? -Infinity);
    if (measure.beats[bi].triplet) {
      if (b.up) top = Math.min(top, (b.stemEnd ?? hi) - 12);
      else bottom = Math.max(bottom, (b.stemEnd ?? lo) + 12);
    }
  });
  return { beats, groups, inGroup, top, bottom };
}

function levels(dur) {
  return dur >= 32 ? 3 : dur >= 16 ? 2 : dur >= 8 ? 1 : 0;
}

/** Width of the clef and key signature at the start of every line. */
export function headerWidth(song) {
  return 8 + 24 + Math.abs(song.key || 0) * 8.2 + 8;
}

// ---------------------------------------------------------------------------
// Drawing

const f = (v) => v.toFixed(1);

function glyph(name, x, y, cls = 'tl-ink', flip = false) {
  return `<path class="${cls}" transform="translate(${f(x)} ${f(y)}) scale(${S.toFixed(4)} ${(flip ? -S : S).toFixed(4)})" d="${GLYPHS[name].d}"/>`;
}

function accidental(alter, x, y) {
  const name = alter > 0 ? 'sharp' : alter < 0 ? 'flat' : 'natural';
  return glyph(name, x - 50 * S, y + HEAD_MID_Y * S);
}

const REST = { 1: 'rest1', 2: 'rest2', 4: 'rest4', 8: 'rest8', 16: 'rest16', 32: 'rest32' };

/**
 * The notation staff of one system. `top` is the y of the top staff line in the system SVG,
 * `left` and `right` its ends, `connect` the y of the tab's bottom line for the bar lines
 * that join the two staves at the start of the line.
 */
export function drawNotation(song, timeline, layout, sys, { top, left, right }) {
  const base = top + 4 * NS; // bottom line
  const Y = (rel) => base + rel;
  let lines = '';
  let marks = '';
  for (let i = 0; i < 5; i++) lines += `<line class="tl-staff" x1="${left}" y1="${top + i * NS}" x2="${f(right)}" y2="${top + i * NS}"/>`;
  lines += `<line class="tl-bar" x1="${left}" y1="${top}" x2="${left}" y2="${base}"/>`;
  // Clef (with an 8 below for music written an octave up) and key signature.
  marks += glyph('gClef', left + 6 - 50 * S, base);
  if (writtenOffset(song)) marks += `<text class="tl-clef8" x="${f(left + 6 + 10)}" y="${f(base + 23)}">8</text>`;
  const key = song.key || 0;
  const steps = key > 0 ? SHARP_STEPS : FLAT_STEPS;
  for (let i = 0; i < Math.abs(key); i++) marks += accidental(key > 0 ? 1 : -1, left + 38 + i * 8.2, Y(yOf(steps[i])));

  for (const meas of sys.measures) {
    const mi = meas.mi;
    const measure = song.measures[mi];
    const mt = timeline.measures[mi];
    const an = layout.nota[mi];
    const xEnd = meas.x + meas.w;
    lines += `<line class="tl-bar" x1="${f(xEnd)}" y1="${top}" x2="${f(xEnd)}" y2="${base}"/>`;
    if (meas.showTs) {
      const tx = meas.x + 11 + 8;
      marks += `<text class="tl-ts tl-ts-nota" x="${f(tx)}" y="${f(top + NS + 7.5)}">${mt.ts[0]}</text>`;
      marks += `<text class="tl-ts tl-ts-nota" x="${f(tx)}" y="${f(top + 3 * NS + 7.5)}">${mt.ts[1]}</text>`;
    }
    measure.beats.forEach((beat, bi) => {
      const x = meas.beatsX[bi].x;
      const b = an.beats[bi];
      if (b.rest) {
        const name = REST[beat.duration];
        const g = GLYPHS[name];
        const lift = beat.duration <= 2 ? -250 : 0; // whole rests hang from the fourth line, half rests sit on the middle one
        const gx = x - ((g.box[0] + g.box[2]) / 2) * S;
        marks += glyph(name, gx, base + lift * S);
        if (beat.dotted) marks += `<circle class="tl-ink" cx="${f(x + 7)}" cy="${f(top + 1.5 * NS)}" r="1.4"/>`;
        return;
      }
      const dur = beat.duration;
      const headName = dur === 1 ? 'headWhole' : dur === 2 ? 'headVoid' : 'headBlack';
      const hb = GLYPHS[headName].box;
      const hw = (hb[2] - hb[0]) * S;
      const stemX = b.up ? x + HEAD_W / 2 - 0.5 : x - HEAD_W / 2 + 0.5;
      for (const h of b.heads) {
        const hx = x + h.dx;
        const hy = Y(h.y);
        // Ledger lines
        for (let s = 40; s <= h.step; s += 2) marks += `<line class="tl-ledger" x1="${f(hx - hw / 2 - 3)}" y1="${f(Y(yOf(s)))}" x2="${f(hx + hw / 2 + 3)}" y2="${f(Y(yOf(s)))}"/>`;
        for (let s = 28; s >= h.step; s -= 2) marks += `<line class="tl-ledger" x1="${f(hx - hw / 2 - 3)}" y1="${f(Y(yOf(s)))}" x2="${f(hx + hw / 2 + 3)}" y2="${f(Y(yOf(s)))}"/>`;
        const n = h.note;
        if (n.dead) {
          const r = NS * 0.42;
          marks += `<path class="tl-xhead" d="M${f(hx - r)} ${f(hy - r)} L${f(hx + r)} ${f(hy + r)} M${f(hx - r)} ${f(hy + r)} L${f(hx + r)} ${f(hy - r)}"/>`;
        } else if (n.harmonic) {
          const r = NS * 0.55;
          marks += `<path class="${dur >= 4 ? 'tl-ink' : 'tl-diamond'}" d="M${f(hx - r)} ${f(hy)} L${f(hx)} ${f(hy - r)} L${f(hx + r)} ${f(hy)} L${f(hx)} ${f(hy + r)} Z"/>`;
        } else {
          marks += glyph(headName, hx - ((hb[0] + hb[2]) / 2) * S, hy + HEAD_MID_Y * S);
        }
        if (n.ghost) {
          marks += `<text class="tl-paren" x="${f(hx - hw / 2 - 3)}" y="${f(hy + 3.5)}">(</text><text class="tl-paren" x="${f(hx + hw / 2 + 3)}" y="${f(hy + 3.5)}">)</text>`;
        }
        if (h.acc !== null) {
          const ax = x - HEAD_W / 2 - 2.5 - (b.heads.some((k) => k.dx < 0) ? HEAD_W : 0) - (h.col + 1) * 8.5;
          marks += accidental(h.acc, ax, hy);
        }
        if (beat.dotted) {
          const onLine = h.step % 2 === 0;
          marks += `<circle class="tl-ink" cx="${f(x + HEAD_W / 2 + 4 + (b.extraRight || 0))}" cy="${f(hy - (onLine ? NS / 2 : 0))}" r="1.4"/>`;
        }
      }
      if (b.stemEnd !== undefined) {
        const from = b.up ? Y(b.heads[0].y) : Y(b.heads[b.heads.length - 1].y);
        marks += `<line class="tl-nstem" x1="${f(stemX)}" y1="${f(from)}" x2="${f(stemX)}" y2="${f(Y(b.stemEnd))}"/>`;
        if (!b.beamed && dur >= 8) {
          const name = `flag${levels(dur)}`;
          const fy = Y(b.stemEnd);
          marks += b.up ? glyph(name, stemX - 0.4, fy + 1009 * S) : glyph(name, stemX - 0.4, fy - 1009 * S, 'tl-ink', true);
        }
      }
    });
    // Beams
    for (const g of an.groups) {
      const xs = g.items.map((bi) => {
        const x = meas.beatsX[bi].x;
        return an.beats[bi].up ? x + HEAD_W / 2 - 0.5 : x - HEAD_W / 2 + 0.5;
      });
      const thick = 0.5 * NS;
      const dirY = g.up ? 1 : -1; // secondary beams move toward the notes
      const y0 = Y(g.end) + (g.up ? 0 : -thick);
      marks += `<rect class="tl-ink" x="${f(xs[0] - 0.4)}" y="${f(y0)}" width="${f(xs[xs.length - 1] - xs[0] + 0.8)}" height="${thick}"/>`;
      for (let level = 2; level <= 3; level++) {
        const y = y0 + dirY * (level - 1) * 0.75 * NS;
        g.items.forEach((bi, k) => {
          const lv = levels(measure.beats[bi].duration);
          if (lv < level) return;
          const next = g.items[k + 1];
          const prev = g.items[k - 1];
          if (next !== undefined && levels(measure.beats[next].duration) >= level) {
            marks += `<rect class="tl-ink" x="${f(xs[k] - 0.4)}" y="${f(y)}" width="${f(xs[k + 1] - xs[k] + 0.8)}" height="${thick}"/>`;
          } else if (prev === undefined || levels(measure.beats[prev].duration) < level) {
            const len = next !== undefined ? 7 : -7;
            marks += `<rect class="tl-ink" x="${f(Math.min(xs[k], xs[k] + len))}" y="${f(y)}" width="7" height="${thick}"/>`;
          }
        });
      }
    }
    // Triplets: a 3 on the stem side of every three triplet beats.
    let run = [];
    const flush = () => {
      for (let i = 0; i + 2 < run.length; i += 3) {
        const a = an.beats[run[i]];
        const c = an.beats[run[i + 2]];
        if (a.rest && c.rest) continue;
        const ref = [a, an.beats[run[i + 1]], c].find((k) => !k.rest);
        const xm = (meas.beatsX[run[i]].x + meas.beatsX[run[i + 2]].x) / 2;
        const yEnd = ref.stemEnd ?? (ref.up ? ref.heads[ref.heads.length - 1].y - NS : ref.heads[0].y + NS);
        const ty = ref.up ? Y(yEnd) - 4 : Y(yEnd) + 11;
        marks += `<text class="tl-tuplet" x="${f(xm)}" y="${f(ty)}">3</text>`;
      }
      run = [];
    };
    measure.beats.forEach((beat, bi) => {
      if (beat.triplet) run.push(bi);
      else flush();
    });
    flush();
  }
  const lastMeas = sys.measures[sys.measures.length - 1];
  if (lastMeas.mi === song.measures.length - 1) {
    const xe = lastMeas.x + lastMeas.w;
    lines += `<line class="tl-bar" x1="${f(xe - 4)}" y1="${top}" x2="${f(xe - 4)}" y2="${base}"/>`;
    lines += `<rect class="tl-ink" x="${f(xe - 1.5)}" y="${top}" width="3" height="${4 * NS}"/>`;
  }
  return { lines, marks };
}
