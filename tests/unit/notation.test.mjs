// Standard notation: spelling in a key, accidentals, stems and the notation layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KEYS, TUNING_RANGE, keyName, INSTRUMENTS, stringLabels } from '../../js/core/constants.js';
import { createBeat, createSong, normalizeSong } from '../../js/core/model.js';
import { buildTimeline } from '../../js/core/timing.js';
import { songToText } from '../../js/core/textTab.js';
import { keyAlter, spell, writtenOffset, analyzeMeasure, NS } from '../../js/ui/notation.js';
import { GLYPHS } from '../../js/ui/glyphs.js';
import { layoutScore, renderSystem } from '../../js/ui/render.js';

const LETTERS = 'CDEFGAB';
const name = (midi, key) => {
  const s = spell(midi, key);
  return LETTERS[s.letter] + (s.alter > 0 ? '#' : s.alter < 0 ? 'b' : '') + s.octave;
};
const octave = (key) => Array.from({ length: 12 }, (_, i) => name(60 + i, key)).join(' ');

test('key signatures give the right sharps and flats', () => {
  // G major: F sharp. D major: F and C sharp. F major: B flat. E flat major: B, E, A flat.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((l) => keyAlter(l, 1)), [0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((l) => keyAlter(l, 2)), [1, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((l) => keyAlter(l, -1)), [0, 0, 0, 0, 0, 0, -1]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((l) => keyAlter(l, -3)), [0, 0, -1, 0, 0, -1, -1]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((l) => keyAlter(l, 7)), [1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((l) => keyAlter(l, -7)), [-1, -1, -1, -1, -1, -1, -1]);
});

test('notes are spelt for the key', () => {
  assert.equal(octave(0), 'C4 C#4 D4 D#4 E4 F4 F#4 G4 G#4 A4 Bb4 B4');
  assert.equal(octave(-3), 'C4 Db4 D4 Eb4 E4 F4 Gb4 G4 Ab4 A4 Bb4 B4');
  assert.equal(octave(2), 'C4 C#4 D4 D#4 E4 F4 F#4 G4 G#4 A4 A#4 B4');
  // Notes of the key keep the key's spelling, across the octave line too.
  assert.equal(name(60, 7), 'B#3');
  assert.equal(name(71, -7), 'Cb5');
  assert.equal(name(64, -7), 'Fb4');
  // Every spelling sounds the right pitch, in every key.
  const NAT = [0, 2, 4, 5, 7, 9, 11];
  for (const { key } of KEYS) {
    for (let m = 24; m <= 100; m++) {
      const s = spell(m, key);
      assert.equal((s.octave + 1) * 12 + NAT[s.letter] + s.alter, m, `MIDI ${m} in key ${key}`);
      assert.ok(Math.abs(s.alter) <= 1);
      assert.equal(s.step, s.octave * 7 + s.letter);
    }
  }
});

test('key names', () => {
  assert.equal(KEYS.length, 15);
  assert.equal(keyName(0), 'C major / A minor (no sharps or flats)');
  assert.equal(keyName(1), 'G major / E minor (1 sharp)');
  assert.equal(keyName(-3), 'E♭ major / C minor (3 flats)');
  assert.equal(keyName(2, { long: false }), 'D major / B minor');
});

test('songs keep a key signature, and bad ones are cleaned up', () => {
  assert.equal(createSong().key, 0);
  const base = createSong();
  assert.equal(normalizeSong({ ...base, key: 3 }).key, 3);
  assert.equal(normalizeSong({ ...base, key: -7 }).key, -7);
  assert.equal(normalizeSong({ ...base, key: 9 }).key, 7);
  assert.equal(normalizeSong({ ...base, key: 'G' }).key, 0);
  const { key, ...old } = base; // files saved before keys existed
  assert.equal(key, 0);
  assert.equal(normalizeSong(old).key, 0);
  assert.match(songToText({ ...base, key: 1 }), /Key: G major \/ E minor/);
  assert.doesNotMatch(songToText(base), /Key:/);
});

test('custom tunings: every preset sits inside the range the note pickers offer', () => {
  for (const inst of Object.values(INSTRUMENTS)) {
    const [lo, hi] = TUNING_RANGE[inst.id];
    for (const t of inst.tunings) for (const n of t.notes) assert.ok(n >= lo && n <= hi, `${inst.id} ${t.id}`);
  }
  // String names: lower case for the guitar's top string; on a ukulele only to tell two apart.
  assert.deepEqual(stringLabels('ukulele', [70, 64, 60, 67]), ['A#', 'E', 'C', 'G']);
  assert.deepEqual(stringLabels('ukulele', [69, 64, 60, 57]), ['a', 'E', 'C', 'A']);
  assert.deepEqual(stringLabels('guitar', [64, 60, 55, 48, 43, 36]), ['e', 'C', 'G', 'C', 'G', 'C']);
  const s = normalizeSong({ ...createSong(), tuning: [64, 59, 55, 50, 43, 36] });
  assert.deepEqual(s.tuning, [64, 59, 55, 50, 43, 36]);
});

test('guitar is written an octave up; ukulele at pitch unless it is low', () => {
  assert.equal(writtenOffset(createSong({ instrument: 'guitar' })), 12);
  assert.equal(writtenOffset(createSong({ instrument: 'ukulele' })), 0);
  assert.equal(writtenOffset(createSong({ instrument: 'ukulele', tuningId: 'low-g' })), 0);
  assert.equal(writtenOffset(createSong({ instrument: 'ukulele', tuningId: 'baritone' })), 12);
});

function songWith(beats, extra = {}) {
  const song = createSong();
  Object.assign(song, extra);
  song.measures[0].beats = beats.map(([dur, notes]) => {
    const b = createBeat(dur);
    b.notes = notes.map(([string, fret]) => ({ string, fret }));
    return b;
  });
  return song;
}

test('accidentals: shown once, then they last to the end of the bar', () => {
  // F, F sharp, F sharp, F on the high e string (written an octave up).
  const song = songWith([[4, [[0, 1]]], [4, [[0, 2]]], [4, [[0, 2]]], [4, [[0, 1]]]]);
  const an = analyzeMeasure(song, buildTimeline(song), 0);
  assert.deepEqual(an.beats.map((b) => b.heads[0].acc), [null, 1, null, 0]);
  // In G major the F sharp needs no sign, and the plain F needs a natural.
  song.key = 1;
  const an2 = analyzeMeasure(song, buildTimeline(song), 0);
  assert.deepEqual(an2.beats.map((b) => b.heads[0].acc), [0, 1, null, 0]);
});

test('stems point away from the middle line, and beamed notes share one direction', () => {
  // A high G (stem down) and a low E (stem up), as quarters; then two eighths, high and low.
  const song = songWith([[4, [[0, 3]]], [4, [[5, 0]]], [8, [[0, 3]]], [8, [[5, 0]]], [2, []]]);
  const an = analyzeMeasure(song, buildTimeline(song), 0);
  assert.equal(an.beats[0].up, false);
  assert.equal(an.beats[1].up, true);
  assert.equal(an.groups.length, 1);
  assert.equal(an.beats[2].up, an.beats[3].up);
  assert.equal(an.beats[2].stemEnd, an.beats[3].stemEnd);
  assert.ok(an.beats[4].rest);
  // A low note's stem reaches at least the middle line.
  assert.ok(an.beats[1].stemEnd <= -2 * NS);
});

test('two notes a step apart in a chord sit on both sides of the stem', () => {
  // G and A together (G string open, D string 7th fret).
  const song = songWith([[4, [[2, 0], [3, 7]]]]);
  const an = analyzeMeasure(song, buildTimeline(song), 0);
  const dx = an.beats[0].heads.map((h) => h.dx);
  assert.equal(dx.filter((d) => d !== 0).length, 1);
});

test('notation layout: a staff above the tab, and no rhythm stems under the tab', () => {
  const song = songWith([[8, [[0, 0]]], [8, [[0, 1]]], [4, [[1, 1]]], [2, [[5, 3]]]], { key: -2 });
  const tl = buildTimeline(song);
  const plain = layoutScore(song, tl, 800);
  const nota = layoutScore(song, tl, 800, { notation: true });
  assert.equal(plain.notation, false);
  assert.equal(nota.notation, true);
  const sys = nota.systems[0];
  assert.ok(sys.notaTop > 0 && sys.notaTop + 4 * NS < sys.staffTop, 'the notation staff is above the tab');
  assert.ok(sys.contentTop < sys.notaTop);
  assert.ok(sys.height > plain.systems[0].height);
  const svgPlain = renderSystem(song, tl, plain, plain.systems[0]);
  const svg = renderSystem(song, tl, nota, sys);
  assert.ok(svgPlain.includes('tl-stem'));
  assert.ok(!svg.includes('class="tl-stem"'), 'the tab has no rhythm stems in the notation view');
  assert.equal((svg.match(/class="tl-staff"/g) || []).length, 5);
  assert.ok(svg.includes(GLYPHS.gClef.d));
  assert.equal(svg.split(GLYPHS.flat.d).length - 1, 2, 'two flats in the key signature');
  assert.ok(!/NaN|undefined/.test(svg));
});

test('every example song draws as notation without errors', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../../examples/', import.meta.url);
  for (const f of readdirSync(dir)) {
    const song = normalizeSong(JSON.parse(readFileSync(new URL(f, dir), 'utf8')));
    const tl = buildTimeline(song);
    for (const width of [340, 900]) {
      const layout = layoutScore(song, tl, width, { notation: true });
      for (const sys of layout.systems) assert.ok(!/NaN|undefined/.test(renderSystem(song, tl, layout, sys)), `${f} at ${width}px`);
    }
  }
});

test('music symbols are present and sized for the staff', () => {
  for (const g of ['gClef', 'sharp', 'flat', 'natural', 'headBlack', 'headVoid', 'headWhole', 'rest1', 'rest2', 'rest4', 'rest8', 'rest16', 'rest32', 'flag1', 'flag2', 'flag3']) {
    assert.ok(GLYPHS[g] && GLYPHS[g].d.length > 20, g);
    assert.equal(GLYPHS[g].box.length, 4);
  }
  // A notehead is about one staff space tall (250 font units).
  const [, y1, , y2] = GLYPHS.headBlack.box;
  assert.ok(Math.abs(y2 - y1 - 250) < 30);
});
