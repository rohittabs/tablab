import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TPQ, INSTRUMENTS, stringLabels, noteNameOctave } from '../../js/core/constants.js';
import {
  beatTicks, createSong, createBeat, createMeasure, fitDuration, measureCapacity,
  normalizeSong, pitchOf, effectiveTimeSignature, tsTicks,
} from '../../js/core/model.js';
import { buildTimeline, buildEvents, SyncMap, locateTick, connectedNote, soundingPitch } from '../../js/core/timing.js';
import { songToText } from '../../js/core/textTab.js';

test('durations in ticks', () => {
  assert.equal(beatTicks(createBeat(4)), TPQ);
  assert.equal(beatTicks(createBeat(1)), TPQ * 4);
  assert.equal(beatTicks(createBeat(8)), TPQ / 2);
  assert.equal(beatTicks(createBeat(32)), TPQ / 8);
  assert.equal(beatTicks(createBeat(4, true)), TPQ * 1.5);
  assert.equal(beatTicks(createBeat(8, false, true)), TPQ / 3);
  assert.equal(beatTicks(createBeat(16, true, true)), 240); // dotted sixteenth triplet = 360 * 2/3
  // three eighth triplets fill one quarter exactly
  assert.equal(3 * beatTicks(createBeat(8, false, true)), TPQ);
});

test('tuning presets are correct MIDI pitches', () => {
  const g = INSTRUMENTS.guitar.tunings.find((t) => t.id === 'standard');
  assert.deepEqual(g.notes.map(noteNameOctave), ['E4', 'B3', 'G3', 'D3', 'A2', 'E2']);
  const u = INSTRUMENTS.ukulele.tunings.find((t) => t.id === 'standard');
  assert.deepEqual(u.notes.map(noteNameOctave), ['A4', 'E4', 'C4', 'G4']);
  const lowG = INSTRUMENTS.ukulele.tunings.find((t) => t.id === 'low-g');
  assert.deepEqual(lowG.notes.map(noteNameOctave), ['A4', 'E4', 'C4', 'G3']);
  const dropD = INSTRUMENTS.guitar.tunings.find((t) => t.id === 'drop-d');
  assert.equal(noteNameOctave(dropD.notes[5]), 'D2');
  for (const inst of Object.values(INSTRUMENTS)) {
    for (const t of inst.tunings) {
      assert.equal(t.notes.length, inst.strings, `${inst.id} ${t.id} string count`);
      assert.equal(t.labels.length, inst.strings, `${inst.id} ${t.id} label count`);
    }
  }
  assert.deepEqual(stringLabels('guitar', [64, 59, 55, 50, 45, 40]), ['e', 'B', 'G', 'D', 'A', 'E']);
  assert.deepEqual(stringLabels('guitar', [65, 60, 55, 50, 45, 40]), ['f', 'C', 'G', 'D', 'A', 'E']);
});

test('capo shifts pitch', () => {
  const s = createSong();
  assert.equal(pitchOf(s, 0, 0), 64);
  s.capo = 2;
  assert.equal(pitchOf(s, 0, 3), 69);
  assert.equal(soundingPitch(s, { string: 0, fret: 12, harmonic: true }), 64 + 2 + 12);
  assert.equal(soundingPitch(s, { string: 5, fret: 7, harmonic: true }), 40 + 2 + 19);
});

test('time signatures carry forward and set capacity', () => {
  const s = createSong({ measures: 4 });
  s.measures[2].timeSignature = [3, 4];
  assert.deepEqual(effectiveTimeSignature(s, 0), [4, 4]);
  assert.deepEqual(effectiveTimeSignature(s, 1), [4, 4]);
  assert.deepEqual(effectiveTimeSignature(s, 2), [3, 4]);
  assert.deepEqual(effectiveTimeSignature(s, 3), [3, 4]);
  assert.equal(measureCapacity(s, 3), 3 * TPQ);
  assert.equal(tsTicks([6, 8]), 3 * TPQ);
});

test('fitDuration picks the longest value that fits', () => {
  assert.deepEqual(fitDuration(TPQ * 4, { duration: 4 }), { duration: 4, dotted: false, triplet: false });
  assert.deepEqual(fitDuration(TPQ / 2, { duration: 4 }), { duration: 8, dotted: false, triplet: false });
  assert.deepEqual(fitDuration(TPQ * 0.75, { duration: 4 }), { duration: 8, dotted: true, triplet: false });
  assert.deepEqual(fitDuration(TPQ * 3, { duration: 1 }), { duration: 2, dotted: true, triplet: false });
  assert.equal(fitDuration(10, { duration: 4 }), null);
});

test('timeline handles underfull and overfull measures', () => {
  const s = createSong({ measures: 3 });
  // measure 0: 4 quarters (full), measure 1: one quarter (underfull), measure 2: 5 quarters (overfull)
  s.measures[0].beats = [createBeat(), createBeat(), createBeat(), createBeat()];
  s.measures[2].beats = [1, 2, 3, 4, 5].map(() => createBeat());
  const tl = buildTimeline(s);
  assert.equal(tl.measures[0].start, 0);
  assert.equal(tl.measures[1].start, 4 * TPQ);
  assert.equal(tl.measures[1].length, 4 * TPQ, 'underfull keeps bar length');
  assert.equal(tl.measures[2].start, 8 * TPQ);
  assert.equal(tl.measures[2].length, 5 * TPQ, 'overfull grows');
  assert.equal(tl.totalTicks, 13 * TPQ);
  assert.deepEqual(locateTick(tl, 4 * TPQ + 10), { m: 1, b: 0, frac: 10 / TPQ });
  const loc = locateTick(tl, 6 * TPQ);
  assert.equal(loc.m, 1);
  assert.equal(loc.b, 0);
});

test('sync map: offset, tempo and sync points', () => {
  const s = createSong({ measures: 8, tempo: 120 });
  const tl = buildTimeline(s);
  let map = new SyncMap(s, tl);
  assert.equal(map.tickToTime(0), 0);
  assert.equal(map.tickToTime(TPQ), 0.5);
  assert.equal(map.tickToTime(4 * TPQ), 2);
  assert.equal(map.timeToTick(2), 4 * TPQ);
  s.backingTrack = { fileName: 'x.mp3', offset: 1.25, volume: 1, syncPoints: [] };
  map = new SyncMap(s, tl);
  assert.equal(map.tickToTime(0), 1.25);
  assert.equal(map.tickToTime(-TPQ), 0.75, 'count-in region before bar 1 uses song tempo');
  assert.ok(Math.abs(map.timeToTick(3.25) - 4 * TPQ) < 1e-9);
  // Pin bar 5 (index 4) late: bars 1-4 become slower
  s.backingTrack.syncPoints = [{ measure: 4, time: 1.25 + 8.8 }];
  map = new SyncMap(s, tl);
  assert.ok(Math.abs(map.tickToTime(16 * TPQ) - 10.05) < 1e-9);
  assert.ok(Math.abs(map.bpmAt(0) - (16 * 60) / 8.8) < 1e-9);
  // After the last pin, the last segment's tempo continues
  assert.ok(Math.abs(map.tickToTime(20 * TPQ) - (10.05 + 8.8 / 4)) < 1e-9);
  // Round trip
  for (const t of [0, 100, 5000, 16 * TPQ, 25000]) {
    assert.ok(Math.abs(map.timeToTick(map.tickToTime(t)) - t) < 1e-6);
  }
  // A sync point earlier than the previous anchor is ignored (keeps time monotonic)
  s.backingTrack.syncPoints = [{ measure: 4, time: 0.5 }];
  map = new SyncMap(s, tl);
  assert.equal(map.anchors.length, 1);
});

test('events: clicks, notes, legato and slides', () => {
  const s = createSong({ measures: 2, tempo: 100 });
  s.measures[0].beats = [createBeat(4), createBeat(4), createBeat(4), createBeat(4)];
  s.measures[0].beats[0].notes = [{ string: 2, fret: 5, hammer: true }];
  s.measures[0].beats[1].notes = [{ string: 2, fret: 7, slide: true }];
  s.measures[0].beats[2].notes = [{ string: 2, fret: 9 }];
  s.measures[0].beats[3].notes = [{ string: 0, fret: 0 }, { string: 5, fret: 0 }];
  s.measures[0].beats[3].strum = 'down';
  const tl = buildTimeline(s);
  const ev = buildEvents(s, tl);
  const clicks = ev.filter((e) => e.kind === 'click');
  assert.equal(clicks.length, 8);
  assert.equal(clicks[0].accent, 2);
  assert.equal(clicks[1].accent, 0);
  assert.equal(clicks[4].accent, 2);
  const beats = ev.filter((e) => e.kind === 'beat');
  assert.equal(beats.length, 5);
  assert.equal(beats[0].notes[0].midi, 55 + 5);
  assert.equal(beats[1].notes[0].legato, true, 'hammer-on target is legato');
  assert.equal(beats[1].notes[0].glideTo, 55 + 9, 'slide glides to the next note');
  assert.equal(beats[2].notes[0].legato, true, 'slide target is legato');
  assert.deepEqual(beats[3].notes.map((n) => n.string), [5, 0], 'down strum starts on the low string');
  assert.deepEqual(beats[3].notes.map((n) => n.strumIndex), [0, 1]);
  // 6/8 accents: beat 1 strong, beat 4 medium
  s.measures[1].timeSignature = [6, 8];
  const ev2 = buildEvents(s, buildTimeline(s)).filter((e) => e.kind === 'click' && e.tick >= 4 * TPQ);
  assert.deepEqual(ev2.map((e) => e.accent), [2, 0, 0, 1, 0, 0]);
  // Range filter
  const part = buildEvents(s, tl, TPQ, 2 * TPQ);
  assert.ok(part.every((e) => e.tick >= TPQ && e.tick < 2 * TPQ));
});

test('connectedNote looks across bar lines', () => {
  const s = createSong({ measures: 2 });
  s.measures[0].beats[0].notes = [{ string: 1, fret: 3, hammer: true }];
  s.measures[1].beats[0].notes = [{ string: 1, fret: 5 }];
  const c = connectedNote(s, 0, 0, 1);
  assert.equal(c.m, 1);
  assert.equal(c.note.fret, 5);
  assert.equal(connectedNote(s, 0, 0, 2), null);
});

test('normalizeSong repairs bad input and rejects foreign files', () => {
  assert.throws(() => normalizeSong({ hello: 1 }), /not a TabLab song/);
  assert.throws(() => normalizeSong(null));
  assert.throws(() => normalizeSong({ format: 'tablab', version: 99 }), /newer version/);
  const s = normalizeSong({
    format: 'tablab',
    version: 1,
    title: 'T\u0007est',
    instrument: 'banjo',
    tuning: 'nope',
    tempo: 9999,
    capo: -3,
    timeSignature: [4, 3],
    measures: [
      { beats: [{ duration: 7, notes: [{ string: 9, fret: 1 }, { string: 1, fret: 99 }, { string: 1, fret: 3, hammer: true, bend: 5, evil: 'x' }, { string: 1, fret: 4 }] }], timeSignature: [3, 4] },
      { beats: [] },
      'junk',
    ],
    backingTrack: { fileName: 5, offset: 'abc', volume: 3, syncPoints: [{ measure: 0, time: 1 }, { measure: 2, time: 5 }, { measure: 2, time: 6 }, { measure: 9, time: 1 }] },
  });
  assert.equal(s.title, 'T est');
  assert.equal(s.instrument, 'guitar');
  assert.equal(s.tuning.length, 6);
  assert.equal(s.tempo, 320);
  assert.equal(s.capo, 0);
  assert.deepEqual(s.timeSignature, [3, 4], 'measure 1 signature moves to the song');
  assert.equal(s.measures.length, 3);
  assert.equal(s.measures[0].beats[0].duration, 4);
  assert.deepEqual(s.measures[0].beats[0].notes, [{ string: 1, fret: 3, hammer: true }]);
  assert.equal(s.measures[1].beats.length, 1);
  assert.equal(s.backingTrack.fileName, 'backing track');
  assert.equal(s.backingTrack.offset, 0);
  assert.equal(s.backingTrack.volume, 1.5, "volume is capped at 150%");
  assert.deepEqual(s.backingTrack.syncPoints, [{ measure: 2, time: 5 }]);
});

test('normalizeSong round-trips a valid song unchanged', () => {
  const s = createSong({ instrument: 'ukulele', tuningId: 'low-g', measures: 2 });
  s.measures[0].beats[0].notes = [{ string: 3, fret: 2, vibrato: true }];
  s.measures[0].beats[0].strum = 'up';
  s.measures[0].beats[0].text = 'C';
  s.measures[1].section = 'Chorus';
  s.backingTrack = { fileName: 'a.mp3', offset: 0.5, volume: 0.8, syncPoints: [{ measure: 1, time: 3 }] };
  const again = normalizeSong(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(again, s);
});

test('text tab export', () => {
  const s = createSong({ measures: 2, tempo: 90 });
  s.title = 'Demo';
  s.measures[0].beats = [createBeat(4), createBeat(4), createBeat(4), createBeat(4)];
  s.measures[0].beats[0].notes = [{ string: 0, fret: 0 }];
  s.measures[0].beats[1].notes = [{ string: 1, fret: 1, hammer: true }];
  s.measures[0].beats[2].notes = [{ string: 1, fret: 3 }];
  s.measures[0].beats[3].notes = [{ string: 2, fret: 12, vibrato: true }];
  s.measures[0].beats[0].text = 'Am';
  s.measures[0].section = 'Intro';
  s.measures[1].beats[0].notes = [{ string: 5, fret: 0, dead: true }];
  s.measures[1].beats[0].palmMute = true;
  const txt = songToText(s);
  const lines = txt.split('\n');
  assert.equal(lines[0], 'Demo');
  assert.match(lines[1], /Guitar, Tuning: Standard \(E A D G B E\), 90 BPM, 4\/4/);
  assert.ok(txt.includes('[Intro]'));
  assert.ok(txt.includes('Am'));
  const e = lines.find((l) => l.startsWith('e|'));
  const B = lines.find((l) => l.startsWith('B|'));
  const G = lines.find((l) => l.startsWith('G|'));
  const E = lines.find((l) => l.startsWith('E|'));
  assert.ok(e.startsWith('e|-0'), e);
  assert.ok(B.includes('1h') && B.includes('3'), B);
  assert.ok(G.includes('12~'), G);
  assert.ok(E.includes('x'), E);
  assert.ok(txt.includes('PM'));
  // all string lines in a block have the same length
  const tabLines = lines.filter((l) => /^[eBGDAE]\|/.test(l));
  assert.equal(new Set(tabLines.map((l) => l.length)).size, 1);
  // Chord label sits above the first beat
  const amLine = lines.find((l) => l.includes('Am'));
  assert.equal(amLine.indexOf('Am'), e.indexOf('0'));
});

test('text tab wraps long songs', () => {
  const s = createSong({ measures: 12 });
  for (const m of s.measures) m.beats = Array.from({ length: 8 }, () => ({ ...createBeat(8), notes: [{ string: 0, fret: 10 }] }));
  const txt = songToText(s, { header: false });
  const eLines = txt.split('\n').filter((l) => l.startsWith('e|'));
  assert.ok(eLines.length > 2);
  assert.ok(eLines.every((l) => l.length <= 80), 'lines fit in 80 columns');
});

test('ukulele example builds', () => {
  const s = createSong({ instrument: 'ukulele' });
  assert.equal(s.tuning.length, 4);
  s.measures[0] = createMeasure(8);
  const txt = songToText(s, { header: false });
  assert.deepEqual(txt.split('\n').filter(Boolean).map((l) => l[0]), ['A', 'E', 'C', 'G']);
});
