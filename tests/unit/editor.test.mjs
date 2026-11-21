import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSong } from '../../js/core/model.js';
import { Editor } from '../../js/ui/editor.js';
import { buildTimeline } from '../../js/core/timing.js';
import { layoutScore, renderSystem, hitTest, findBeat } from '../../js/ui/render.js';

function ed(opts) {
  return new Editor(createSong(opts));
}

test('typing frets, two digit frets and audition pitch', () => {
  const e = ed();
  e.cursor.s = 0;
  assert.equal(e.typeDigit(3, 1000), 67);
  assert.deepEqual(e.beat().notes, [{ string: 0, fret: 3 }]);
  e.typeDigit(1, 5000);
  e.typeDigit(2, 5300);
  assert.equal(e.beat().notes[0].fret, 12, '1 then 2 quickly is 12');
  e.typeDigit(5, 9000);
  e.typeDigit(5, 9100);
  assert.equal(e.beat().notes[0].fret, 5, '55 is above the top fret, so it stays 5');
  e.typeDigit(2, 20000);
  e.typeDigit(4, 25000);
  assert.equal(e.beat().notes[0].fret, 4, 'slow typing replaces');
  // 0 never starts a two digit number
  e.typeDigit(0, 30000);
  e.typeDigit(7, 30100);
  assert.equal(e.beat().notes[0].fret, 7);
  // one undo step per fret entry, and the combined digit is part of the same step
  const before = e.undoStack.length;
  e.typeDigit(1, 40000);
  e.typeDigit(9, 40100);
  assert.equal(e.undoStack.length, before + 1);
  e.undo();
  assert.equal(e.beat().notes[0].fret, 7);
});

test('moving right fills a bar with beats, then moves to a new bar', () => {
  const e = ed();
  for (let i = 0; i < 4; i++) {
    e.typeDigit(i, i * 2000);
    e.right();
  }
  assert.equal(e.song.measures[0].beats.length, 4);
  assert.equal(e.cursor.m, 1, 'after a full bar the cursor is in bar 2');
  assert.equal(e.song.measures.length, 2);
  assert.equal(e.cursor.b, 0);
  // the new bar uses the previous beat's duration
  assert.equal(e.beat().duration, 4);
});

test('a new beat fits the remaining space', () => {
  const e = ed();
  e.setDuration(2); // half
  e.right(); // second beat is a half too
  assert.equal(e.song.measures[0].beats.length, 2);
  e.left();
  e.setDuration(4);
  e.setDuration(4);
  // now bar has quarter + half = 3 beats; moving right from the half adds a quarter to fill
  e.right();
  e.right();
  assert.equal(e.song.measures[0].beats.length, 3);
  assert.equal(e.song.measures[0].beats[2].duration, 4);
});

test('shorter, longer, dotted and triplet', () => {
  const e = ed();
  e.shorter();
  assert.equal(e.beat().duration, 8);
  e.longer();
  e.longer();
  assert.equal(e.beat().duration, 2);
  e.toggleDotted();
  assert.equal(e.beat().dotted, true);
  e.toggleTriplet();
  assert.equal(e.beat().triplet, true);
  for (let i = 0; i < 10; i++) e.longer();
  assert.equal(e.beat().duration, 1);
  for (let i = 0; i < 10; i++) e.shorter();
  assert.equal(e.beat().duration, 32);
});

test('delete and backspace rules', () => {
  const e = ed();
  e.typeDigit(5, 0);
  e.right();
  e.typeDigit(7, 5000);
  assert.equal(e.measure().beats.length, 2);
  e.deleteAtCursor(); // removes the note
  assert.equal(e.beat().notes.length, 0);
  e.deleteAtCursor({ backspace: true }); // removes the empty beat, moves left
  assert.equal(e.measure().beats.length, 1);
  assert.equal(e.cursor.b, 0);
  assert.equal(e.beat().notes[0].fret, 5);
  // empty bar removal with backspace
  e.insertMeasure();
  assert.equal(e.song.measures.length, 2);
  assert.equal(e.cursor.m, 1);
  e.deleteAtCursor({ backspace: true });
  assert.equal(e.song.measures.length, 1);
  assert.equal(e.cursor.m, 0);
  // a beat with notes on other strings is left alone
  e.cursor.s = 3;
  assert.equal(e.deleteAtCursor(), false);
});

test('techniques need a note and respect exclusivity', () => {
  const e = ed();
  assert.match(e.toggleNoteFlag('hammer'), /fret number first/);
  e.typeDigit(5, 0);
  assert.equal(e.toggleNoteFlag('hammer'), null);
  assert.equal(e.beat().notes[0].hammer, true);
  e.toggleNoteFlag('slide');
  assert.equal(e.beat().notes[0].slide, true);
  assert.equal(e.beat().notes[0].hammer, undefined, 'slide replaces hammer-on');
  e.cycleBend();
  assert.equal(e.beat().notes[0].bend, 2);
  e.cycleBend();
  assert.equal(e.beat().notes[0].bend, 1);
  e.cycleBend();
  e.cycleBend();
  assert.equal(e.beat().notes[0].bend, undefined);
  e.togglePalmMute();
  assert.equal(e.beat().palmMute, true);
  e.toggleStrum('down');
  assert.equal(e.beat().strum, 'down');
  e.toggleStrum('down');
  assert.equal(e.beat().strum, undefined);
  e.setText('Am');
  assert.equal(e.beat().text, 'Am');
  e.setText('  ');
  assert.equal(e.beat().text, undefined);
});

test('selection, copy and paste bars', () => {
  const e = ed();
  e.typeDigit(1, 0);
  e.nextMeasure();
  e.typeDigit(2, 5000);
  e.nextMeasure(); // bar 3, empty
  e.setCursor(0, 0);
  e.right({ extend: true }); // extends into bar 2
  assert.ok(e.hasSelection());
  assert.ok(e.selectionIsMeasures());
  assert.equal(e.copy(), 2);
  e.setCursor(2, 0);
  e.paste();
  assert.equal(e.song.measures.length, 4, 'empty bar 3 replaced by two copies');
  assert.equal(e.song.measures[2].beats[0].notes[0].fret, 1);
  assert.equal(e.song.measures[3].beats[0].notes[0].fret, 2);
  // copy a single beat and paste after a note
  e.setCursor(0, 0);
  e.copy();
  e.paste();
  assert.equal(e.song.measures[0].beats.length, 2);
  assert.equal(e.cursor.b, 1);
  // undo restores
  e.undo();
  assert.equal(e.song.measures[0].beats.length, 1);
  e.redo();
  assert.equal(e.song.measures[0].beats.length, 2);
});

test('all beats of an unfinished bar copy as beats, a full bar copies as a bar', () => {
  const e = ed();
  e.typeDigit(1, 0);
  e.right();
  e.typeDigit(2, 5000);
  e.home();
  e.right({ extend: true }); // both beats of a half-full bar
  assert.equal(e.selectionIsMeasures(), false);
  e.copy();
  assert.equal(e.clipboard.measures, null);
  assert.equal(e.clipboard.beats.length, 2);
  e.end();
  e.right(); // a new empty beat in the same bar
  e.paste();
  assert.deepEqual(e.song.measures[0].beats.map((b) => b.notes.map((n) => n.fret)), [[1], [2], [1], [2]]);
  // Now the bar is full: selecting all of it means the bar.
  e.home();
  e.end({ extend: true });
  assert.equal(e.selectionIsMeasures(), true);
});

test('delete selected bars keeps sync points and meters consistent', () => {
  const e = ed({ measures: 6 });
  e.song.backingTrack = { fileName: 'a.mp3', offset: 0, volume: 1, syncPoints: [{ measure: 2, time: 4 }, { measure: 5, time: 10 }] };
  e.song.measures[3].timeSignature = [3, 4];
  e.setCursor(1, 0);
  e.setCursor(2, 0, undefined, { extend: true });
  e.deleteMeasures();
  assert.equal(e.song.measures.length, 4);
  assert.deepEqual(e.song.backingTrack.syncPoints, [{ measure: 3, time: 10 }]);
  assert.deepEqual(e.song.measures[1].timeSignature, [3, 4]);
  e.setCursor(0, 0);
  e.insertMeasure();
  assert.deepEqual(e.song.backingTrack.syncPoints, [{ measure: 4, time: 10 }]);
});

test('time signature changes carry forward and redundant ones are dropped', () => {
  const e = ed({ measures: 4 });
  e.setCursor(2, 0);
  e.setTimeSignature(3, 4);
  assert.deepEqual(e.song.measures[2].timeSignature, [3, 4]);
  e.setCursor(3, 0);
  e.setTimeSignature(3, 4);
  assert.equal(e.song.measures[3].timeSignature, undefined);
  e.setCursor(0, 0);
  e.setTimeSignature(3, 4);
  assert.deepEqual(e.song.timeSignature, [3, 4]);
  assert.equal(e.song.measures[2].timeSignature, undefined, 'now redundant');
});

test('changing to ukulele drops notes on missing strings', () => {
  const e = ed();
  e.cursor.s = 5;
  e.typeDigit(3, 0);
  e.cursor.s = 0;
  e.typeDigit(1, 5000);
  e.setTuning('ukulele', [69, 64, 60, 67]);
  assert.deepEqual(e.beat().notes, [{ string: 0, fret: 1 }]);
  assert.equal(e.cursor.s, 0);
});

test('renderer: layout, hit testing and SVG output', () => {
  const e = ed({ measures: 12 });
  for (const m of e.song.measures) {
    m.beats = Array.from({ length: 8 }, (_, i) => ({ duration: 8, dotted: false, triplet: false, notes: [{ string: i % 6, fret: i + 3 }] }));
  }
  e.song.measures[0].beats[0].notes[0].hammer = true;
  e.song.measures[0].beats[1].notes[0].string = 0;
  e.song.measures[0].section = 'Intro & <Verse>';
  e.song.measures[1].beats[0].palmMute = true;
  e.song.measures[1].beats[1].palmMute = true;
  e.song.measures[2].beats[0] = { duration: 4, dotted: false, triplet: false, notes: [] };
  const tl = buildTimeline(e.song);
  const layout = layoutScore(e.song, tl, 900);
  assert.ok(layout.systems.length >= 2, 'wraps into several systems');
  let count = 0;
  for (const sys of layout.systems) {
    count += sys.measures.length;
    const last = sys.measures[sys.measures.length - 1];
    assert.ok(last.x + last.w <= 900 - 14 + 0.5 || sys.measures.length === 1, 'fits the width');
  }
  assert.equal(count, 12);
  const svg = renderSystem(e.song, tl, layout, layout.systems[0]);
  assert.match(svg, /^<svg class="tl-system"/);
  assert.ok(svg.includes('Intro &amp; &lt;Verse&gt;'), 'section text is escaped');
  assert.ok(svg.includes('P.M.'));
  assert.ok(svg.includes('>h<'), 'hammer-on label');
  // hit test the first beat of bar 2 on string 3
  const loc = findBeat(layout, 1, 0);
  const hit = hitTest(layout, loc.sys.index, loc.pos.x, loc.sys.staffTop + 2 * 13 + 2);
  assert.deepEqual(hit, { m: 1, b: 0, s: 2 });
  // narrow screens still lay out
  const narrow = layoutScore(e.song, tl, 320);
  assert.ok(narrow.systems.length >= 6);
});
