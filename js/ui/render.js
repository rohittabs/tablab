// Tab renderer: lays the song out in systems (lines) and draws each system as an SVG string.
// No DOM access here, so layout and drawing can be unit tested in Node.

import { WHOLE } from '../core/constants.js';
import { stringLabels } from '../core/constants.js';
import { connectedNote } from '../core/timing.js';
import { NS, analyzeMeasure, drawNotation, headerWidth } from './notation.js';

export const LS = 13; // distance between strings
const BASE = { 1: 66, 2: 46, 4: 33, 8: 25, 16: 20, 32: 17 };
const CLEF_W = 30;
const TS_W = 22;
const PAD_L = 11;
const PAD_R = 7;
export const MARGIN = 14;
const NOTE_OFFSET = 10; // fret number centre, from the start of the beat's space
const ROW_TOP = 17;
const ROW_TEXT = 15;
const ROW_FX = 17;
const BELOW = 34;
const SYSTEM_GAP = 14;

export function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function fretLabel(note) {
  if (note.dead) return 'x';
  if (note.ghost) return `(${note.fret})`;
  if (note.harmonic) return `<${note.fret}>`;
  return String(note.fret);
}

function textWidth(s, size = 11) {
  return s.length * size * 0.58;
}

function beatNaturalWidth(beat, nextBeat, nb) {
  let w = BASE[beat.duration] * (beat.dotted ? 1.22 : 1) * (beat.triplet ? 0.92 : 1);
  // In the notation view, room for accidentals before the notes and side heads after them.
  if (nb && !nb.rest) w += nb.offset + nb.extraRight;
  let need = 0;
  for (const n of beat.notes) {
    let e = fretLabel(n).length * 7 + 10;
    if (n.bend) e += 14;
    if (n.hammer || n.slide) e += 6;
    need = Math.max(need, e);
  }
  if (beat.text && nextBeat && nextBeat.text) need = Math.max(need, textWidth(beat.text) + 8);
  return Math.max(w, need + (nb && !nb.rest ? nb.offset : 0), 18);
}

function tsChanged(song, timeline, mi) {
  if (mi === 0) return true;
  const a = timeline.measures[mi].ts;
  const b = timeline.measures[mi - 1].ts;
  return a[0] !== b[0] || a[1] !== b[1];
}

/**
 * Lay the song out for a given container width.
 * Returns { systems: [ { index, top, height, width, staffTop, rows, measures: [...] } ], height }.
 * Each measure: { mi, x, w, beatsX: [{ x (note centre), left, right }] , showTs, first }.
 * Every line but the last is stretched to the full width. justify: stretch the last line too
 * (its notes up to 2.5 times further apart), as the short examples on the About page do.
 * notation: draw standard notation above the tab (layout.nota has how each bar is written,
 * and each system gets notaTop, the y of the top line of the notation staff).
 */
export function layoutScore(song, timeline, width, { compact = false, justify = false, notation = false } = {}) {
  const avail = Math.max(240, width - 2 * MARGIN);
  const strings = song.tuning.length;
  const nota = notation ? song.measures.map((_, mi) => analyzeMeasure(song, timeline, mi)) : null;
  const clefW = notation ? Math.max(CLEF_W, headerWidth(song)) : CLEF_W;
  const natural = song.measures.map((m, mi) => {
    const beats = m.beats.map((b, bi) => beatNaturalWidth(b, m.beats[bi + 1], nota && nota[mi].beats[bi]));
    const showTs = tsChanged(song, timeline, mi);
    const flex = beats.reduce((a, b) => a + b, 0);
    // Underfull measures keep some space for their missing time, so the bar does not look complete.
    const mt = timeline.measures[mi];
    const missing = mt.capacity > mt.content ? Math.min(60, ((mt.capacity - mt.content) / WHOLE) * 4 * 12) : 0;
    return { mi, beats, showTs, flex: flex + missing, missing, fixed: PAD_L + PAD_R + (showTs ? TS_W : 0) };
  });

  // Greedy line breaking.
  const lines = [];
  let cur = [];
  let curW = clefW;
  for (const nm of natural) {
    const w = nm.fixed + nm.flex;
    if (cur.length && curW + w > avail) {
      lines.push(cur);
      cur = [];
      curW = clefW;
    }
    cur.push(nm);
    curW += w;
  }
  if (cur.length) lines.push(cur);

  const systems = [];
  let top = 0;
  lines.forEach((line, li) => {
    const fixed = clefW + line.reduce((a, m) => a + m.fixed, 0);
    const flex = line.reduce((a, m) => a + m.flex, 0);
    const isLast = li === lines.length - 1;
    let scale = 1;
    if (!isLast || justify || fixed + flex > avail) scale = Math.max(0.55, (avail - fixed) / flex);
    if (isLast && justify) scale = Math.min(scale, 2.5);
    if (isLast && fixed + flex * scale < avail * 0.55 && scale > 1) scale = 1;
    let x = MARGIN + clefW;
    const measures = line.map((nm, k) => {
      const mx = x;
      let bx = mx + PAD_L + (nm.showTs ? TS_W : 0);
      const beatsX = nm.beats.map((bw, bi) => {
        const w = bw * scale;
        const nb = nota && nota[nm.mi].beats[bi];
        const off = NOTE_OFFSET + (nb && !nb.rest ? nb.offset : 0);
        const pos = { left: bx, right: bx + w, x: bx + Math.min(off, w / 2) };
        bx += w;
        return pos;
      });
      const w = nm.fixed + nm.flex * scale;
      x += w;
      return { mi: nm.mi, x: mx, w, beatsX, showTs: nm.showTs, first: k === 0, missing: nm.missing * scale };
    });
    // Which optional rows does this system need?
    let hasText = false;
    let hasFx = false;
    for (const m of measures) {
      for (const b of song.measures[m.mi].beats) {
        if (b.text) hasText = true;
        if (b.strum || b.palmMute || b.notes.some((n) => n.bend || n.vibrato)) hasFx = true;
      }
    }
    const rows = { top: ROW_TOP, text: hasText ? ROW_TEXT : 0, nota: 0, fx: hasFx ? ROW_FX : 0 };
    let notaTop = null;
    if (nota) {
      // Room above and below the notation staff for this line's highest and lowest notes and stems.
      let hi = Infinity;
      let lo = -Infinity;
      for (const m of measures) {
        hi = Math.min(hi, nota[m.mi].top);
        lo = Math.max(lo, nota[m.mi].bottom);
      }
      rows.nota = lo - hi + 6;
      notaTop = rows.top + rows.text + 2 + (-4 * NS - hi);
    }
    const staffTop = rows.top + rows.text + rows.nota + rows.fx + 4;
    const staffH = (strings - 1) * LS;
    // The notation shows the rhythm, so the tab needs no stems below it.
    const height = staffTop + staffH + (compact || nota ? 14 : BELOW);
    const sysWidth = Math.max(width, x + MARGIN);
    const contentTop = notaTop !== null ? notaTop - 8 : staffTop - 14;
    systems.push({ index: li, top, height, width: sysWidth, staffTop, staffBottom: staffTop + staffH, notaTop, contentTop, rows, measures, right: x });
    top += height + SYSTEM_GAP;
  });
  return { systems, height: top, strings, nota, notation: !!nota };
}

/** Find where a measure and beat are drawn. */
export function findBeat(layout, m, b) {
  for (const sys of layout.systems) {
    const first = sys.measures[0].mi;
    const last = sys.measures[sys.measures.length - 1].mi;
    if (m < first || m > last) continue;
    const meas = sys.measures[m - first];
    const pos = meas.beatsX[Math.min(b, meas.beatsX.length - 1)];
    return { sys, meas, pos };
  }
  return null;
}

/** Map a point inside system `sysIndex` (SVG coordinates) to a beat and string. */
export function hitTest(layout, sysIndex, x, y) {
  const sys = layout.systems[sysIndex];
  if (!sys) return null;
  let meas = sys.measures[0];
  for (const m of sys.measures) if (x >= m.x) meas = m;
  let b = 0;
  for (let i = 0; i < meas.beatsX.length; i++) if (x >= meas.beatsX[i].left - 2) b = i;
  // Above the tab (on the notation staff), keep the string the cursor is on.
  if (sys.notaTop !== null && sys.notaTop !== undefined && y < sys.staffTop - LS) return { m: meas.mi, b, s: undefined };
  const s = Math.round((y - sys.staffTop) / LS);
  return { m: meas.mi, b, s: Math.max(0, Math.min(layout.strings - 1, s)) };
}

// ---------------------------------------------------------------------------
// Drawing

function restGlyph(dur, x, yc) {
  const X = (v) => (x + v).toFixed(1);
  const Y = (v) => (yc + v).toFixed(1);
  switch (dur) {
    case 1:
      return `<rect class="tl-ink" x="${X(-5)}" y="${Y(-4)}" width="10" height="4.5" rx="0.5"/>`;
    case 2:
      return `<rect class="tl-ink" x="${X(-5)}" y="${Y(-0.5)}" width="10" height="4.5" rx="0.5"/>`;
    case 4:
      return `<path class="tl-rest" d="M${X(-1.5)} ${Y(-10)} L${X(3)} ${Y(-4.5)} L${X(-1.5)} ${Y(0.5)} L${X(3)} ${Y(5)} C${X(-1)} ${Y(3.5)} ${X(-3.5)} ${Y(7)} ${X(0)} ${Y(10)}"/>`;
    default: {
      const flags = dur === 8 ? 1 : dur === 16 ? 2 : 3;
      let s = `<path class="tl-rest-thin" d="M${X(3.5)} ${Y(-7)} L${X(-1)} ${Y(8 + (flags - 1) * 3)}"/>`;
      for (let i = 0; i < flags; i++) {
        const oy = -7 + i * 5.5;
        const ox = -0.9 * i * 1.1;
        s += `<circle class="tl-ink" cx="${X(-1.5 + ox)}" cy="${Y(oy - 1)}" r="2"/>`;
        s += `<path class="tl-rest-thin" d="M${X(-1.5 + ox)} ${Y(oy + 0.5)} Q${X(1.5 + ox)} ${Y(oy + 1.5)} ${X(3.5 + ox)} ${Y(oy)}"/>`;
      }
      return s;
    }
  }
}

function beamUnit(ts) {
  const [num, den] = ts;
  if (den === 8 && num % 3 === 0) return (WHOLE / 8) * 3;
  if (den === 8) return WHOLE / 4;
  if (den === 2) return WHOLE / 2;
  return WHOLE / 4;
}

function levels(dur) {
  return dur >= 32 ? 3 : dur >= 16 ? 2 : dur >= 8 ? 1 : 0;
}

/** Rhythm marks (stems, beams, flags, dots, triplet numbers) for one measure. */
function drawRhythm(song, timeline, meas, sys) {
  const measure = song.measures[meas.mi];
  const mt = timeline.measures[meas.mi];
  const unit = beamUnit(mt.ts);
  const stemTop = sys.staffBottom + 8;
  const stemBot = stemTop + 17;
  let out = '';
  // Group beamable beats.
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
    if (!beamable) {
      if (group) groups.push(group);
      group = null;
    }
  });
  if (group) groups.push(group);
  const inBeam = new Set();
  for (const gr of groups) if (gr.items.length > 1) gr.items.forEach((i) => inBeam.add(i));

  measure.beats.forEach((beat, bi) => {
    const x = meas.beatsX[bi].x;
    if (beat.notes.length === 0) return; // rests are drawn on the staff
    if (beat.duration === 1) {
      // whole note: no stem
    } else if (beat.duration === 2) {
      out += `<line class="tl-stem" x1="${x}" y1="${stemTop + 8}" x2="${x}" y2="${stemBot}"/>`;
    } else {
      out += `<line class="tl-stem" x1="${x}" y1="${stemTop}" x2="${x}" y2="${stemBot}"/>`;
    }
    if (beat.duration >= 8 && !inBeam.has(bi)) {
      for (let l = 0; l < levels(beat.duration); l++) {
        const y = stemBot - l * 4.5;
        out += `<path class="tl-flag" d="M${x} ${y} q5 -1.5 6.5 -6.5"/>`;
      }
    }
    if (beat.dotted) out += `<circle class="tl-ink" cx="${x + 4.5}" cy="${stemBot - 2}" r="1.6"/>`;
  });
  // Beams
  for (const gr of groups) {
    if (gr.items.length < 2) continue;
    const xs = gr.items.map((bi) => meas.beatsX[bi].x);
    out += `<rect class="tl-ink" x="${xs[0]}" y="${stemBot - 2.6}" width="${(xs[xs.length - 1] - xs[0]).toFixed(1)}" height="2.6"/>`;
    for (let level = 2; level <= 3; level++) {
      const y = stemBot - 2.6 - (level - 1) * 4.5;
      gr.items.forEach((bi, k) => {
        const lv = levels(measure.beats[bi].duration);
        if (lv < level) return;
        const nextBi = gr.items[k + 1];
        const prevBi = gr.items[k - 1];
        if (nextBi !== undefined && levels(measure.beats[nextBi].duration) >= level) {
          out += `<rect class="tl-ink" x="${xs[k]}" y="${y}" width="${(xs[k + 1] - xs[k]).toFixed(1)}" height="2.4"/>`;
        } else if (prevBi === undefined || levels(measure.beats[prevBi].duration) < level) {
          // lone short note in a group: a short stub
          const dir = nextBi !== undefined ? 1 : -1;
          const len = 6 * dir;
          out += `<rect class="tl-ink" x="${Math.min(xs[k], xs[k] + len)}" y="${y}" width="6" height="2.4"/>`;
        }
      });
    }
  }
  // Triplet numbers: every three consecutive triplet beats
  let run = [];
  const flush = () => {
    for (let i = 0; i + 2 < run.length; i += 3) {
      const xa = meas.beatsX[run[i]].x;
      const xb = meas.beatsX[run[i + 2]].x;
      out += `<text class="tl-tuplet" x="${((xa + xb) / 2).toFixed(1)}" y="${stemBot + 10}">3</text>`;
    }
    run = [];
  };
  measure.beats.forEach((beat, bi) => {
    if (beat.triplet) run.push(bi);
    else flush();
  });
  flush();
  return out;
}

const BEND_LABEL = { 1: '½', 2: 'full', 3: '1½' };

/** Draw one system as a standalone SVG string. */
export function renderSystem(song, timeline, layout, sys, { warnings = true } = {}) {
  const strings = layout.strings;
  const labels = stringLabels(song.instrument, song.tuning);
  const left = MARGIN;
  const right = sys.right;
  const st = sys.staffTop;
  const sb = sys.staffBottom;
  const yOf = (s) => st + s * LS;
  const rowTopY = 11;
  const rowTextY = sys.rows.top + 11;
  const rowFxY = sys.rows.top + sys.rows.text + sys.rows.nota + 10;
  let bg = '';
  let lines = '';
  let marks = '';
  let notes = '';
  let deco = '';

  // Strings and the opening bar line
  for (let s = 0; s < strings; s++) lines += `<line class="tl-string" x1="${left}" y1="${yOf(s)}" x2="${right}" y2="${yOf(s)}"/>`;
  lines += `<line class="tl-bar" x1="${left}" y1="${st}" x2="${left}" y2="${sb}"/>`;
  if (layout.notation) {
    const n = drawNotation(song, timeline, layout, sys, { top: sys.notaTop, left, right });
    lines += n.lines + `<line class="tl-bar" x1="${left}" y1="${sys.notaTop}" x2="${left}" y2="${sb}"/>`;
    marks += n.marks;
  }
  // TAB clef, sized to the staff
  const clefSize = strings >= 6 ? 13 : 10;
  const clefGap = (sb - st) / 3;
  ['T', 'A', 'B'].forEach((ch, i) => {
    marks += `<text class="tl-clef" x="${left + 14}" y="${st + clefGap * (i + 0.5) + clefSize * 0.36}" font-size="${clefSize}">${ch}</text>`;
  });
  // String names, left of the clef
  if (sys.index === 0) {
    labels.forEach((l, s) => {
      marks += `<text class="tl-strname" x="${left - 4}" y="${yOf(s) + 3.5}">${escapeXml(l)}</text>`;
    });
  }

  let pmRun = null; // { x0, x1 }
  const flushPm = () => {
    if (!pmRun) return;
    deco += `<text class="tl-fx" x="${pmRun.x0 - 6}" y="${rowFxY + 3}">P.M.</text>`;
    if (pmRun.x1 > pmRun.x0 + 22) {
      deco += `<line class="tl-dash" x1="${pmRun.x0 + 19}" y1="${rowFxY}" x2="${pmRun.x1}" y2="${rowFxY}"/>`;
      deco += `<line class="tl-fxline" x1="${pmRun.x1}" y1="${rowFxY - 3}" x2="${pmRun.x1}" y2="${rowFxY + 3}"/>`;
    }
    pmRun = null;
  };

  for (const meas of sys.measures) {
    const mi = meas.mi;
    const measure = song.measures[mi];
    const mt = timeline.measures[mi];
    const xEnd = meas.x + meas.w;
    lines += `<line class="tl-bar" x1="${xEnd.toFixed(1)}" y1="${st}" x2="${xEnd.toFixed(1)}" y2="${sb}"/>`;
    // Measure number, coloured when the bar holds too much or too little.
    let numClass = 'tl-num';
    let title = '';
    if (warnings && mt.content > mt.capacity) {
      numClass += ' tl-num-over';
      title = `<title>Bar ${mi + 1} is too long for ${mt.ts[0]}/${mt.ts[1]}</title>`;
    } else if (warnings && mt.content < mt.capacity) {
      numClass += ' tl-num-under';
      title = `<title>Bar ${mi + 1} is not full yet</title>`;
    }
    marks += `<text class="${numClass}" x="${(meas.x + 3).toFixed(1)}" y="${rowTopY}">${mi + 1}${title}</text>`;
    if (measure.section) {
      const sx = meas.x + 3 + String(mi + 1).length * 6 + 6;
      const w = textWidth(measure.section, 10.5) + 12;
      marks += `<rect class="tl-section-bg" x="${sx.toFixed(1)}" y="1.5" width="${w.toFixed(1)}" height="14" rx="7"/>`;
      marks += `<text class="tl-section" x="${(sx + 6).toFixed(1)}" y="${rowTopY + 0.5}">${escapeXml(measure.section)}</text>`;
    }
    if (meas.showTs) {
      const tx = meas.x + PAD_L + TS_W / 2 - 3;
      const mid = (st + sb) / 2;
      const size = strings >= 6 ? 17 : 13;
      const gap = strings >= 6 ? 1 : 0.5;
      marks += `<text class="tl-ts" x="${tx}" y="${mid - gap}" font-size="${size}">${mt.ts[0]}</text>`;
      marks += `<text class="tl-ts" x="${tx}" y="${mid + size * 0.78 + gap}" font-size="${size}">${mt.ts[1]}</text>`;
    }
    measure.beats.forEach((beat, bi) => {
      const pos = meas.beatsX[bi];
      const x = pos.x;
      if (beat.text) marks += `<text class="tl-text" x="${(x - 4).toFixed(1)}" y="${rowTextY}">${escapeXml(beat.text)}</text>`;
      if (beat.strum) {
        const y0 = rowFxY - 6;
        const y1 = rowFxY + 5;
        const ax = x + (beat.palmMute ? 10 : 0);
        if (beat.strum === 'down') deco += `<path class="tl-fxline" d="M${ax} ${y0} V${y1} M${ax - 3} ${y1 - 3.5} L${ax} ${y1} L${ax + 3} ${y1 - 3.5}"/>`;
        else deco += `<path class="tl-fxline" d="M${ax} ${y1} V${y0} M${ax - 3} ${y0 + 3.5} L${ax} ${y0} L${ax + 3} ${y0 + 3.5}"/>`;
      }
      if (beat.palmMute) {
        if (!pmRun) pmRun = { x0: x, x1: pos.right - 4 };
        else pmRun.x1 = pos.right - 4;
      } else flushPm();
      if (beat.notes.length === 0) {
        marks += restGlyph(beat.duration, x, (st + sb) / 2);
        if (beat.dotted) marks += `<circle class="tl-ink" cx="${x + 7}" cy="${(st + sb) / 2 - 3}" r="1.5"/>`;
        return;
      }
      for (const note of beat.notes) {
        const y = yOf(note.string);
        const label = fretLabel(note);
        const w = label.length * 7 + 3;
        bg += `<rect class="tl-knock" x="${(x - w / 2).toFixed(1)}" y="${y - 6.5}" width="${w}" height="13"/>`;
        const cls = note.ghost ? 'tl-fret tl-ghost' : 'tl-fret';
        notes += `<text class="${cls}" x="${x.toFixed(1)}" y="${y + 4.3}">${escapeXml(label)}</text>`;
        if (note.vibrato) {
          let d = `M${(x - 5).toFixed(1)} ${rowFxY}`;
          const len = Math.max(14, pos.right - pos.left - 4);
          for (let k = 0; k < len / 6; k++) d += ' q1.5 -3 3 0 t3 0';
          deco += `<path class="tl-vib" d="${d}"/>`;
        }
        if (note.bend) {
          const bx = x + w / 2 + 1;
          const tipX = bx + 9;
          const tipY = st - 5;
          deco += `<path class="tl-fxline" d="M${bx.toFixed(1)} ${y} Q${tipX.toFixed(1)} ${y} ${tipX.toFixed(1)} ${tipY + 4}"/>`;
          deco += `<path class="tl-arrow" d="M${(tipX - 3).toFixed(1)} ${tipY + 5} L${tipX.toFixed(1)} ${tipY} L${(tipX + 3).toFixed(1)} ${tipY + 5} Z"/>`;
          deco += `<text class="tl-fx" x="${(tipX + 3).toFixed(1)}" y="${tipY - 2}">${BEND_LABEL[note.bend]}</text>`;
        }
        if (note.hammer || note.slide) {
          const target = connectedNote(song, mi, bi, note.string);
          let x2;
          let targetFret = null;
          if (target) {
            const loc = findBeat(layout, target.m, target.b);
            if (loc && loc.sys === sys) x2 = loc.pos.x;
            else x2 = Math.min(right, pos.right + 12);
            targetFret = target.note.fret;
          } else x2 = pos.right;
          if (note.hammer && target) {
            const x1 = x + 4;
            const xe = x2 - 4;
            const lift = Math.min(10, Math.max(5, (xe - x1) * 0.25));
            deco += `<path class="tl-slur" d="M${x1.toFixed(1)} ${y - 7} Q${((x1 + xe) / 2).toFixed(1)} ${y - 7 - lift} ${xe.toFixed(1)} ${y - 7}"/>`;
            const hp = targetFret >= note.fret ? 'h' : 'p';
            deco += `<text class="tl-hp" x="${((x1 + xe) / 2).toFixed(1)}" y="${(y - 9 - lift * 0.55).toFixed(1)}">${hp}</text>`;
          }
          if (note.slide) {
            const up = targetFret === null ? false : targetFret >= note.fret;
            const x1 = x + w / 2 + 1;
            const xe = target ? x2 - 8 : x1 + 12;
            if (xe > x1 + 2) {
              const ya = up ? y + 3 : y - 3;
              const yb = up ? y - 3 : y + 3;
              deco += `<line class="tl-fxline" x1="${x1.toFixed(1)}" y1="${ya}" x2="${xe.toFixed(1)}" y2="${yb}"/>`;
            }
          }
        }
      }
    });
    if (meas.missing > 8 && warnings) {
      const mx = meas.x + meas.w - PAD_R - meas.missing / 2;
      marks += `<text class="tl-missing" x="${mx.toFixed(1)}" y="${((st + sb) / 2 + 3).toFixed(1)}">…</text>`;
    }
    if (!layout.notation) marks += drawRhythm(song, timeline, meas, sys);
    if (meas.mi === sys.measures[sys.measures.length - 1].mi) flushPm();
  }
  flushPm();
  // Final double bar at the very end of the song
  const lastMeas = sys.measures[sys.measures.length - 1];
  if (lastMeas.mi === song.measures.length - 1) {
    const xe = lastMeas.x + lastMeas.w;
    lines += `<line class="tl-bar" x1="${(xe - 4).toFixed(1)}" y1="${st}" x2="${(xe - 4).toFixed(1)}" y2="${sb}"/>`;
    lines += `<rect class="tl-ink" x="${(xe - 1.5).toFixed(1)}" y="${st}" width="3" height="${sb - st}"/>`;
  }
  return (
    `<svg class="tl-system" data-sys="${sys.index}" xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(sys.width)}" height="${Math.ceil(sys.height)}" viewBox="0 0 ${Math.ceil(sys.width)} ${Math.ceil(sys.height)}">` +
    `<g class="tl-under"></g>${lines}${bg}${notes}${marks}${deco}<g class="tl-over"></g></svg>`
  );
}
