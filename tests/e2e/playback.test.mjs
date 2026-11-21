// Browser tests for playback: timing, count-in, metronome, practice speed, tempo, loops.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

let env;
before(async () => {
  env = await setup();
});
after(async () => {
  await env.close();
});

/** A song with a quarter note on every beat: frets 0, 1, 2, ... on string 2. */
function quarters({ tempo = 120, bars = 2, ts = [4, 4] } = {}) {
  let fret = 0;
  const measures = [];
  for (let m = 0; m < bars; m++) {
    const beats = [];
    for (let b = 0; b < ts[0]; b++) beats.push({ duration: ts[1], dotted: false, triplet: false, notes: [{ string: 1, fret: fret++ % 13 }] });
    measures.push({ beats });
  }
  return { format: 'tablab', version: 1, id: 'test-' + tempo + '-' + bars, title: 'Quarters', artist: '', instrument: 'guitar', tuning: [64, 59, 55, 50, 45, 40], capo: 0, tempo, timeSignature: ts, measures, backingTrack: null };
}

async function openWith(songData, { countIn = 0 } = {}) {
  const page = await env.open();
  await page.evaluate(
    ({ s, countIn }) => {
      window.tablab.openSong(s);
      window.tablab.prefs.countIn = countIn;
      const e = window.tablab.engine;
      e.debug.keep = true;
      e.debug.scheduled = [];
      window.__events = [];
      for (const type of ['play', 'stop', 'ended', 'loop']) e.addEventListener(type, () => window.__events.push(type));
    },
    { s: songData, countIn },
  );
  await page.focus('#score');
  return page;
}

const scheduled = (page) => page.evaluate(() => window.tablab.engine.debug.scheduled.map((x) => ({ ...x })));
const notesOf = (list) => list.filter((x) => x.midi !== undefined && x.string !== 'preview');
const clicksOf = (list) => list.filter((x) => x.click !== undefined);
const gaps = (list) => list.slice(1).map((x, i) => x.when - list[i].when);

function assertSteps(list, step, tol = 0.002, label = 'gap') {
  for (const g of gaps(list)) assert.ok(Math.abs(g - step) < tol, `${label} ${g.toFixed(4)} s, expected ${step} s`);
}

describe('playback', () => {
  it('plays from the cursor at the song tempo, follows along and stops', async () => {
    const page = await openWith(quarters({ tempo: 120 }));
    await page.keyboard.press('Space');
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => window.tablab.engine.state), 'playing');
    assert.equal(await page.getAttribute('#btn-play', 'aria-label'), 'Pause');
    const notes = notesOf(await scheduled(page));
    assert.ok(notes.length >= 3, 'notes scheduled: ' + notes.length);
    assertSteps(notes, 0.5);
    assert.deepEqual(notes.slice(0, 3).map((n) => n.midi), [59, 60, 61]);
    const c = await page.evaluate(() => ({ ...window.tablab.editor.cursor }));
    assert.ok(c.b >= 1, 'the cursor follows the music');
    assert.equal(await page.locator('.tl-playhead').count(), 1);
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.tablab.engine.state), 'stopped');
    assert.equal(await page.locator('.tl-playhead').count(), 0);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  it('counts in one bar before the music, with the first beat accented', async () => {
    const page = await openWith(quarters({ tempo: 120 }), { countIn: 1 });
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('#countin').classList.contains('show'));
    const shown = new Set();
    for (let i = 0; i < 25; i++) {
      shown.add(await page.textContent('#countin'));
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(400);
    const list = await scheduled(page);
    const clicks = clicksOf(list);
    const notes = notesOf(list);
    assert.equal(clicks.length, 4, 'four count-in clicks in 4/4');
    assert.deepEqual(clicks.map((c) => c.click), [2, 0, 0, 0]);
    assertSteps(clicks, 0.5, 0.002, 'count-in gap');
    assert.ok(Math.abs(notes[0].when - clicks[0].when - 2.0) < 0.002, 'music starts one bar after the first click');
    for (const n of ['1', '2', '3']) assert.ok(shown.has(n), `count-in shows ${n} (saw ${[...shown]})`);
    await page.keyboard.press('Space');
    await page.context().close();
  });

  it('counts in by the time signature (3/4 and 6/8)', async () => {
    const page = await openWith(quarters({ tempo: 90, ts: [3, 4] }), { countIn: 2 });
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    let clicks = clicksOf(await scheduled(page));
    await page.keyboard.press('Space');
    assert.ok(clicks.length >= 1);
    assert.equal(clicks[0].click, 2);
    // Two bars of 3/4 at 90 BPM: 6 clicks, 2/3 s apart.
    await page.evaluate(() => {
      window.tablab.engine.debug.scheduled = [];
    });
    await page.keyboard.press('Space');
    await page.waitForTimeout(4300);
    clicks = clicksOf(await scheduled(page));
    await page.keyboard.press('Space');
    assert.equal(clicks.length, 6);
    assert.deepEqual(clicks.map((c) => c.click), [2, 0, 0, 2, 0, 0]);
    assertSteps(clicks, 60 / 90);
    await page.context().close();
    // 6/8 at 120: one bar is six eighth-note clicks, grouped in threes.
    const p68 = await openWith(quarters({ tempo: 120, ts: [6, 8] }), { countIn: 1 });
    await p68.keyboard.press('Space');
    await p68.waitForTimeout(1700);
    await p68.keyboard.press('Space');
    clicks = clicksOf(await scheduled(p68));
    assert.deepEqual(clicks.map((c) => c.click), [2, 0, 0, 1, 0, 0]);
    assertSteps(clicks, 0.25);
    await p68.context().close();
  });

  it('plays the metronome on every beat when it is on', async () => {
    const page = await openWith(quarters({ tempo: 150 }));
    await page.keyboard.press('m');
    assert.equal(await page.getAttribute('#btn-metronome', 'aria-pressed'), 'true');
    await page.keyboard.press('Space');
    await page.waitForTimeout(1300);
    await page.keyboard.press('Space');
    const list = await scheduled(page);
    const clicks = clicksOf(list);
    const notes = notesOf(list);
    assert.ok(clicks.length >= 3);
    assert.deepEqual(clicks.slice(0, 4).map((c) => c.click), [2, 0, 0, 0].slice(0, Math.min(4, clicks.length)));
    for (let i = 0; i < Math.min(clicks.length, notes.length); i++) assert.ok(Math.abs(clicks[i].when - notes[i].when) < 0.001, 'click and note together');
    await page.context().close();
  });

  it('slows down with the practice speed without changing the song tempo', async () => {
    const page = await openWith(quarters({ tempo: 120 }));
    for (let i = 0; i < 10; i++) await page.keyboard.press('['); // 100% to 50%
    assert.equal(await page.evaluate(() => window.tablab.prefs.speed), 0.5);
    assert.match(await page.textContent('#out-speed'), /50% · 60/);
    await page.keyboard.press('Space');
    await page.waitForTimeout(2300);
    await page.keyboard.press('Space');
    const notes = notesOf(await scheduled(page));
    assert.ok(notes.length >= 2);
    assertSteps(notes, 1.0);
    assert.equal(await page.evaluate(() => window.tablab.editor.song.tempo), 120);
    // Back to full speed with ].
    for (let i = 0; i < 10; i++) await page.keyboard.press(']');
    assert.equal(await page.evaluate(() => window.tablab.prefs.speed), 1);
    await page.context().close();
  });

  it('changes the tempo while playing without stopping', async () => {
    const page = await openWith(quarters({ tempo: 120, bars: 4 }));
    await page.keyboard.press('Space');
    await page.waitForTimeout(1100);
    await page.fill('#in-tempo', '60');
    await page.press('#in-tempo', 'Enter');
    const changedAt = await page.evaluate(() => window.tablab.engine.ctx.currentTime);
    await page.waitForTimeout(2600);
    assert.equal(await page.evaluate(() => window.tablab.engine.state), 'playing');
    await page.keyboard.press('Space');
    const notes = notesOf(await scheduled(page));
    const before = notes.filter((n) => n.when < changedAt);
    const later = notes.filter((n) => n.when > changedAt + 0.2);
    assertSteps(before, 0.5, 0.002, 'before');
    assert.ok(later.length >= 2, 'notes after the change: ' + later.length);
    assertSteps(later, 1.0, 0.002, 'after');
    // No restart, no second count-in, and the notes carry on in order.
    const events = await page.evaluate(() => window.__events);
    assert.deepEqual(events.filter((e) => e === 'play'), ['play']);
    const midis = notes.map((n) => n.midi);
    for (let i = 1; i < midis.length; i++) assert.equal(midis[i], midis[i - 1] + 1, 'no note skipped or repeated: ' + midis.join(','));
    assert.equal(await page.evaluate(() => window.tablab.editor.song.tempo), 60);
    await page.context().close();
  });

  it('loops the current bar seamlessly', async () => {
    const page = await openWith(quarters({ tempo: 240, bars: 3 }));
    // Loop bar 2.
    await page.evaluate(() => window.tablab.editor.setCursor(1, 0));
    await page.focus('#score');
    await page.keyboard.press('l');
    assert.equal(await page.getAttribute('#btn-loop', 'aria-pressed'), 'true');
    assert.ok((await page.locator('.tl-loop').count()) >= 4, 'loop range is shown');
    await page.keyboard.press('Space');
    await page.waitForTimeout(2600); // about two and a half times round
    const cur = await page.evaluate(() => ({ ...window.tablab.editor.cursor }));
    await page.keyboard.press('Space');
    const events = await page.evaluate(() => window.__events);
    assert.ok(events.filter((e) => e === 'loop').length >= 2, 'looped: ' + events.join(','));
    assert.equal(cur.m, 1, 'stays in bar 2');
    const notes = notesOf(await scheduled(page));
    assertSteps(notes, 0.25, 0.002, 'loop gap');
    assert.deepEqual(notes.slice(0, 6).map((n) => n.midi), [63, 64, 65, 66, 63, 64]);
    await page.context().close();
  });

  it('loops a selection that starts mid-bar', async () => {
    const page = await openWith(quarters({ tempo: 240, bars: 3 }));
    await page.evaluate(() => {
      const ed = window.tablab.editor;
      ed.setCursor(0, 2);
      ed.setCursor(1, 1, undefined, { extend: true });
    });
    await page.focus('#score');
    await page.keyboard.press('l');
    await page.keyboard.press('Space');
    await page.waitForTimeout(2200);
    await page.keyboard.press('Space');
    const notes = notesOf(await scheduled(page));
    // Beats 3 and 4 of bar 1, then beats 1 and 2 of bar 2, round and round.
    assert.deepEqual(notes.slice(0, 8).map((n) => n.midi), [61, 62, 63, 64, 61, 62, 63, 64]);
    assertSteps(notes, 0.25, 0.002, 'loop gap');
    // The selection is still there.
    assert.equal(await page.evaluate(() => window.tablab.editor.hasSelection()), true);
    await page.context().close();
  });

  it('stops at the end and puts the cursor back where it started', async () => {
    const page = await openWith(quarters({ tempo: 240, bars: 1 }));
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__events.includes('ended'), null, { timeout: 4000 });
    assert.equal(await page.getAttribute('#btn-play', 'aria-label'), 'Play');
    assert.deepEqual(await page.evaluate(() => ({ ...window.tablab.editor.cursor })), { m: 0, b: 0, s: 0 });
    await page.context().close();
  });

  it('keeps playing while notes are typed', async () => {
    const page = await openWith(quarters({ tempo: 100, bars: 4 }));
    await page.keyboard.press('Space');
    await page.waitForTimeout(800);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('7');
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => window.tablab.engine.state), 'playing');
    await page.keyboard.press('Space');
    const events = await page.evaluate(() => window.__events);
    assert.deepEqual(events.filter((e) => e === 'play'), ['play']);
    const s = await page.evaluate(() => window.tablab.editor.song);
    const added = s.measures.flatMap((m) => m.beats).flatMap((b) => b.notes).filter((n) => n.string === 2 && n.fret === 7);
    assert.equal(added.length, 1);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  it('plays every example without errors', async () => {
    const page = await env.open();
    for (const name of ['First Steps', 'Campfire Strum', 'Power Chord Riff']) {
      // The app starts with First Steps, so wait for the new copy (a new id), not just the title.
      // Otherwise Space can start the old copy, and the example arriving a moment later stops it.
      const before = await page.evaluate(() => window.tablab.editor.song.id);
      await page.click('#btn-library');
      await page.locator('#lib-examples li', { hasText: name }).locator('button').click();
      await page.waitForFunction(([t, id]) => window.tablab.editor.song.title === t && window.tablab.editor.song.id !== id, [name, before]);
      await page.focus('#score');
      await page.keyboard.press('Space');
      await page.waitForTimeout(1200);
      assert.equal(await page.evaluate(() => window.tablab.engine.state), 'playing', name);
      await page.keyboard.press('Space');
    }
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
});
