// Plain text (ASCII) tab export, the format students paste into forums and chats.

import { DURATION_NAMES, INSTRUMENTS, keyName, matchTuning, stringLabels } from './constants.js';
import { effectiveTimeSignature } from './model.js';
import { connectedNote } from './timing.js';

const PAD = { 1: 8, 2: 5, 4: 3, 8: 2, 16: 1, 32: 1 };

/** Text for one note, for example "7", "x", "(5)", "<12>", "7b9", "5h", "7/". */
export function noteText(song, m, b, note) {
  let core;
  if (note.dead) core = 'x';
  else if (note.harmonic) core = `<${note.fret}>`;
  else if (note.ghost) core = `(${note.fret})`;
  else core = String(note.fret);
  let suffix = '';
  if (note.bend && !note.dead) suffix += 'b' + (note.fret + note.bend);
  if (note.vibrato) suffix += '~';
  const next = connectedNote(song, m, b, note.string);
  if (note.hammer && next) suffix += next.note.fret >= note.fret ? 'h' : 'p';
  if (note.slide) suffix += next ? (next.note.fret >= note.fret ? '/' : '\\') : '\\';
  return core + suffix;
}

function measureSegment(song, mi) {
  const measure = song.measures[mi];
  const strings = song.tuning.length;
  const lines = Array.from({ length: strings }, () => '-');
  const marks = [];
  let pos = 1;
  measure.beats.forEach((beat, bi) => {
    const texts = new Array(strings).fill('');
    for (const n of beat.notes) texts[n.string] = noteText(song, mi, bi, n);
    const widest = Math.max(1, ...texts.map((t) => t.length));
    const width = widest + (PAD[beat.duration] || 2) + (beat.dotted ? 1 : 0);
    for (let s = 0; s < strings; s++) lines[s] += texts[s].padEnd(width, '-');
    const prevPm = bi > 0 && measure.beats[bi - 1].palmMute;
    marks.push({ pos, width, text: beat.text || '', pm: !!beat.palmMute, pmStart: !!beat.palmMute && !prevPm, strum: beat.strum || '' });
    pos += width;
  });
  return { width: pos + 1, lines: lines.map((l) => l + '|'), marks, section: measure.section || '' };
}

function overlayLine(block, lead, pick) {
  const chars = [];
  const put = (at, s) => {
    for (let i = 0; i < s.length; i++) {
      while (chars.length <= at + i) chars.push(' ');
      chars[at + i] = s[i];
    }
  };
  let offset = lead;
  let any = false;
  for (const seg of block) {
    for (const mk of seg.marks) {
      const s = pick(mk, seg);
      if (s) {
        any = true;
        put(offset + mk.pos, s);
      }
    }
    offset += seg.width;
  }
  return any ? chars.join('').trimEnd() : null;
}

/** Render the song (or a range of measures) as plain text tab. */
export function songToText(song, { from = 0, to = song.measures.length - 1, lineWidth = 78, header = true } = {}) {
  const out = [];
  const labels = stringLabels(song.instrument, song.tuning);
  const labelWidth = Math.max(...labels.map((l) => l.length));
  const lead = labelWidth + 1;
  if (header) {
    out.push(song.artist ? `${song.title} - ${song.artist}` : song.title);
    const inst = INSTRUMENTS[song.instrument] ? INSTRUMENTS[song.instrument].name : 'Guitar';
    const preset = matchTuning(song.instrument, song.tuning);
    const tuning = preset ? preset.name : labels.slice().reverse().join(' ');
    const ts = song.timeSignature;
    const parts = [inst, `Tuning: ${tuning}`];
    if (song.capo) parts.push(`Capo ${song.capo}`);
    if (song.key) parts.push(`Key: ${keyName(song.key, { long: false })}`);
    parts.push(`${Math.round(song.tempo)} BPM`, `${ts[0]}/${ts[1]}`);
    out.push(parts.join(', '));
    out.push('');
  }
  let block = [];
  let blockWidth = 0;
  const flush = () => {
    if (!block.length) return;
    let sectionLine = null;
    if (block.some((s) => s.section)) {
      let line = ' '.repeat(lead);
      for (const seg of block) line += (seg.section ? `[${seg.section}]` : '').padEnd(seg.width, ' ');
      sectionLine = line.trimEnd();
    }
    const rows = [
      sectionLine,
      overlayLine(block, lead, (mk) => mk.text),
      overlayLine(block, lead, (mk) => (mk.pm ? (mk.pmStart ? 'PM' : '-').padEnd(mk.width, '-') : '')),
      overlayLine(block, lead, (mk) => (mk.strum === 'down' ? 'D' : mk.strum === 'up' ? 'U' : '')),
    ];
    for (const r of rows) if (r) out.push(r);
    for (let s = 0; s < song.tuning.length; s++) {
      out.push(labels[s].padEnd(labelWidth, ' ') + '|' + block.map((seg) => seg.lines[s]).join(''));
    }
    out.push('');
    block = [];
    blockWidth = 0;
  };
  let lastTs = null;
  for (let mi = from; mi <= to && mi < song.measures.length; mi++) {
    const ts = effectiveTimeSignature(song, mi);
    if (lastTs && (ts[0] !== lastTs[0] || ts[1] !== lastTs[1])) {
      flush();
      out.push(`(time signature changes to ${ts[0]}/${ts[1]})`);
    }
    lastTs = ts;
    const seg = measureSegment(song, mi);
    if (block.length && blockWidth + seg.width > lineWidth - lead) flush();
    block.push(seg);
    blockWidth += seg.width;
  }
  flush();
  return out.join('\n').replace(/\n+$/, '\n');
}

/** Short human description of a duration, for tooltips and status text. */
export function describeDuration(beat) {
  let s = DURATION_NAMES[beat.duration] || '';
  if (beat.dotted) s = 'Dotted ' + s.toLowerCase();
  if (beat.triplet) s += ' triplet';
  return s;
}
