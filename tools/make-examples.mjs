// Writes the example songs in examples/. All three are original pieces written for TabLab.
// Run: node tools/make-examples.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSong, normalizeSong } from '../js/core/model.js';
import { buildTimeline } from '../js/core/timing.js';

const OUT = fileURLToPath(new URL('../examples/', import.meta.url));

// A note is "string:fret" plus optional technique letters, strings counted from 1 (the top line).
//   h hammer-on/pull-off, s slide, b bend (b1 half, b2 full, b3 one and a half), v vibrato,
//   x dead note, g ghost note, n natural harmonic
function note(spec) {
  const m = /^(\d):(\d+|x)([a-z0-9]*)$/.exec(spec);
  if (!m) throw new Error('bad note ' + spec);
  const n = { string: Number(m[1]) - 1, fret: m[2] === 'x' ? 0 : Number(m[2]) };
  if (m[2] === 'x') n.dead = true;
  const flags = m[3];
  for (let i = 0; i < flags.length; i++) {
    const c = flags[i];
    if (c === 'h') n.hammer = true;
    else if (c === 's') n.slide = true;
    else if (c === 'v') n.vibrato = true;
    else if (c === 'x') n.dead = true;
    else if (c === 'g') n.ghost = true;
    else if (c === 'n') n.harmonic = true;
    else if (c === 'b') {
      const d = Number(flags[i + 1]);
      if (d >= 1 && d <= 3) {
        n.bend = d;
        i++;
      } else n.bend = 2;
    }
  }
  return n;
}

// A beat: "4 2:1 1:0" is a quarter note with two notes. Duration may end with "." (dotted)
// or "t" (triplet). Extra words: D or U (strum), PM (palm mute), "text" (chord name).
function beat(spec) {
  const parts = spec.match(/"[^"]*"|\S+/g);
  const d = /^(\d+)(\.?)(t?)$/.exec(parts[0]);
  if (!d) throw new Error('bad duration ' + spec);
  const b = { duration: Number(d[1]), dotted: d[2] === '.', triplet: d[3] === 't', notes: [] };
  for (const p of parts.slice(1)) {
    if (p === 'D') b.strum = 'down';
    else if (p === 'U') b.strum = 'up';
    else if (p === 'PM') b.palmMute = true;
    else if (p.startsWith('"')) b.text = p.slice(1, -1);
    else b.notes.push(note(p));
  }
  return b;
}

function bar(beats, extra = {}) {
  return { beats: beats.map(beat), ...extra };
}

function song({ id, title, artist, instrument, tempo, measures }) {
  const s = createSong({ instrument, title, tempo });
  s.id = id;
  s.artist = artist;
  s.created = s.updated = '2026-11-21T12:00:00.000Z';
  s.measures = measures;
  const checked = normalizeSong(JSON.parse(JSON.stringify(s)));
  // Every bar must be exactly full.
  const tl = buildTimeline(checked);
  tl.measures.forEach((m, i) => {
    if (m.content !== m.capacity) throw new Error(`${title}: bar ${i + 1} is ${m.content} ticks, not ${m.capacity}`);
  });
  return checked;
}

// ---------------------------------------------------------------- First Steps (guitar)

const firstSteps = song({
  id: 'example-first-steps',
  title: 'First Steps',
  artist: 'TabLab example',
  instrument: 'guitar',
  tempo: 88,
  measures: [
    bar(['4 2:1 "C"', '4 2:3', '4 1:0', '4 1:3'], { section: 'Melody' }),
    bar(['2 1:5 "Am"', '4 1:3', '4 1:0']),
    bar(['4 1:1 "F"', '4 1:0', '4 2:3', '4 2:1']),
    bar(['2 2:3v "G"', '4', '4 3:0']),
    bar(['8 2:1h "C"', '8 2:3', '4 1:0', '4 1:3s', '4 1:5'], { section: 'Variation' }),
    bar(['2 2:8b "Em"', '4 1:0', '4 2:3']),
    bar(['4 2:1 "F"', '4 1:0', '4 2:3 "G"', '4 2:0']),
    bar(['1 2:1v 3:0 "C"']),
  ],
});

// ---------------------------------------------------------------- Campfire Strum (ukulele)
// Standard tuning, strings from the top line: A E C G.

const CHORDS = { C: ['1:3', '2:0', '3:0', '4:0'], Am: ['1:0', '2:0', '3:0', '4:2'], F: ['1:0', '2:1', '3:0', '4:2'], G: ['1:2', '2:3', '3:2', '4:0'] };
const strumBar = (name, extra) => {
  const c = CHORDS[name].join(' ');
  // Down, down-up, up-down-up: the classic pattern.
  return bar([`4 ${c} D "${name}"`, `8 ${c} D`, `4 ${c} U`, `8 ${c} U`, `8 ${c} D`, `8 ${c} U`], extra);
};

const campfire = song({
  id: 'example-campfire-strum',
  title: 'Campfire Strum',
  artist: 'TabLab example',
  instrument: 'ukulele',
  tempo: 92,
  measures: [
    strumBar('C', { section: 'Strum along' }),
    strumBar('Am'),
    strumBar('F'),
    strumBar('G'),
    strumBar('C', { section: 'Again' }),
    strumBar('Am'),
    strumBar('F'),
    strumBar('G'),
    bar([`1 ${CHORDS.C.join(' ')} D "C"`], { section: 'End' }),
  ],
});

// ---------------------------------------------------------------- Power Chord Riff (guitar)
// Low strings: 6 is low E, 5 is A, 4 is D.

const E5 = '6:0 5:2';
const G5 = '6:3 5:5';
const A5 = '5:0 4:2';
const B5 = '5:2 4:4';
const pm = '8 6:0 PM';
const riffA = (extra) => bar([pm, pm, pm, pm, `8 ${E5} "E5"`, '8 6:x 5:x', `4 ${G5} "G5"`], extra);
const riffB = () => bar([pm, pm, pm, pm, `8 ${A5} "A5"`, '8 5:x 4:x', `8 ${G5} "G5"`, `8 ${E5} "E5"`]);

const riff = song({
  id: 'example-power-chord-riff',
  title: 'Power Chord Riff',
  artist: 'TabLab example',
  instrument: 'guitar',
  tempo: 112,
  measures: [
    riffA({ section: 'Riff' }),
    riffB(),
    riffA(),
    bar([pm, pm, `4 ${G5} "G5"`, `4 ${A5} "A5"`, `4 ${B5.replace('4:4', '4:4v')} "B5"`]),
    riffA({ section: 'Riff again' }),
    riffB(),
    riffA(),
    bar([`1 6:0v 5:2v "E5"`], { section: 'End' }),
  ],
});

mkdirSync(OUT, { recursive: true });
for (const [file, s] of [
  ['first-steps.tablab', firstSteps],
  ['campfire-strum.tablab', campfire],
  ['power-chord-riff.tablab', riff],
]) {
  writeFileSync(OUT + file, JSON.stringify(s, null, 1) + '\n');
  console.log('wrote examples/' + file, `(${s.measures.length} bars)`);
}
