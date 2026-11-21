// Browser tests for the backing track: loading, auto sync, dragging bar lines, playing in sync.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clickTrack, setup } from './helpers.mjs';

let env;
before(async () => {
  env = await setup();
});
after(async () => {
  await env.close();
});

function songData({ tempo = 80, bars = 8, backing = null } = {}) {
  const measures = [];
  for (let m = 0; m < bars; m++) measures.push({ beats: [0, 1, 2, 3].map((b) => ({ duration: 4, dotted: false, triplet: false, notes: [{ string: 2, fret: (m + b) % 5 }] })) });
  return { format: 'tablab', version: 1, id: 'backing-' + Math.random().toString(16).slice(2, 10), title: 'Play along', instrument: 'guitar', tuning: [64, 59, 55, 50, 45, 40], capo: 0, tempo, timeSignature: [4, 4], measures, backingTrack: backing };
}

async function withTrack({ song = songData(), track = { bpm: 100, offset: 0.5, seconds: 12 }, countIn = 0 } = {}) {
  const page = await env.open();
  await page.evaluate(
    ({ s, countIn }) => {
      window.tablab.openSong(s);
      window.tablab.prefs.countIn = countIn;
    },
    { s: song, countIn },
  );
  await page.click('#btn-track');
  assert.equal(await page.isVisible('#sync-panel'), true);
  await page.setInputFiles('#file-audio', { name: 'clicks.wav', mimeType: 'audio/wav', buffer: clickTrack(track) });
  await page.waitForFunction(() => window.tablab.engine.track && window.tablab.engine.track.peaks, null, { timeout: 10000 });
  await page.focus('#score');
  return page;
}

const bt = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.tablab.editor.song.backingTrack)));
const tempo = (page) => page.evaluate(() => window.tablab.editor.song.tempo);

/** Drag in the waveform from song time t by dx pixels. */
async function dragWave(page, t, dx) {
  const box = await page.locator('#wave').boundingBox();
  const x = await page.evaluate((tt) => window.tablab.syncPanel._x(tt), t);
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + x, y);
  await page.mouse.down();
  await page.mouse.move(box.x + x + dx / 2, y, { steps: 3 });
  await page.mouse.move(box.x + x + dx, y, { steps: 3 });
  await page.mouse.up();
  return page.evaluate(() => window.tablab.syncPanel.view.pps);
}

describe('backing track', () => {
  it('loads an audio file, finds the tempo and bar 1, and plays in sync', async () => {
    const page = await withTrack();
    assert.match(await page.textContent('#track-name'), /clicks\.wav \(0:12\)/);
    assert.equal(await page.isDisabled('#btn-detect'), false);
    assert.deepEqual(await bt(page), { fileName: 'clicks.wav', offset: 0, volume: 0.9, syncPoints: [] });
    await page.click('#btn-detect');
    await page.waitForFunction(() => window.tablab.editor.song.tempo !== 80, null, { timeout: 10000 });
    assert.ok(Math.abs((await tempo(page)) - 100) < 0.5, 'tempo ' + (await tempo(page)));
    assert.ok(Math.abs((await bt(page)).offset - 0.5) < 0.02, 'offset ' + (await bt(page)).offset);
    await page.focus('#score');
    await page.keyboard.press('Space');
    await page.waitForTimeout(1500);
    const st = await page.evaluate(() => {
      const e = window.tablab.engine;
      const p = e.position();
      return { paused: e.media.paused, media: e.media.currentTime, time: p.time, rate: e.media.playbackRate };
    });
    assert.equal(st.paused, false, 'the track plays');
    assert.ok(Math.abs(st.time - st.media) < 0.1, `tab ${st.time} and track ${st.media} play together`);
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.tablab.engine.media.paused), true, 'the track stops too');
    assert.deepEqual(page.errors, []);

    // The audio is kept in the browser, so it is back after a reload.
    await page.waitForTimeout(400);
    await page.reload();
    await page.evaluate(() => window.tablab.ready);
    await page.waitForFunction(() => window.tablab.engine.track, null, { timeout: 10000 });
    assert.match(await page.textContent('#track-name'), /clicks\.wav/);
    assert.ok(Math.abs((await bt(page)).offset - 0.5) < 0.02);
    assert.equal(await page.isVisible('#sync-panel'), true, 'the panel stays open');
    await page.context().close();
  });

  it('starts the recording mid-way when bar 1 is late in the file, through the count-in', async () => {
    const page = await withTrack({ song: songData({ tempo: 100 }), track: { bpm: 100, offset: 3.0, seconds: 14 }, countIn: 1 });
    await page.fill('#in-offset', '3');
    await page.press('#in-offset', 'Enter');
    await page.waitForFunction(() => window.tablab.editor.song.backingTrack.offset === 3);
    await page.focus('#score');
    await page.keyboard.press('Space');
    await page.waitForTimeout(700);
    const during = await page.evaluate(() => {
      const e = window.tablab.engine;
      const p = e.position();
      return { inCountIn: p.inCountIn, time: p.time, media: e.media.currentTime, paused: e.media.paused };
    });
    assert.equal(during.inCountIn, true);
    assert.equal(during.paused, false, 'the intro plays under the count-in');
    assert.ok(Math.abs(during.time - during.media) < 0.06, JSON.stringify(during));
    await page.waitForTimeout(2500);
    const later = await page.evaluate(() => {
      const e = window.tablab.engine;
      return { time: e.position().time, media: e.media.currentTime, cursor: { ...window.tablab.editor.cursor } };
    });
    assert.ok(Math.abs(later.time - later.media) < 0.06, JSON.stringify(later));
    assert.ok(later.cursor.m >= 0 && later.time > 3.0);
    await page.keyboard.press('Space');
    await page.context().close();
  });

  it('waits for the recording when the count-in starts before it', async () => {
    const page = await withTrack({ song: songData({ tempo: 100 }), track: { bpm: 100, offset: 0.5, seconds: 12 }, countIn: 1 });
    await page.fill('#in-offset', '0.5');
    await page.press('#in-offset', 'Enter');
    await page.focus('#score');
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.tablab.engine.media.paused), true, 'not yet: the count-in is still before 0:00');
    await page.waitForTimeout(3000);
    const st = await page.evaluate(() => {
      const e = window.tablab.engine;
      return { time: e.position().time, media: e.media.currentTime, paused: e.media.paused };
    });
    assert.equal(st.paused, false);
    assert.ok(Math.abs(st.time - st.media) < 0.06, JSON.stringify(st));
    await page.keyboard.press('Space');
    await page.context().close();
  });

  it('drags bar 1 and pins later bars in the waveform', async () => {
    const page = await withTrack();
    await page.fill('#in-offset', '0.5');
    await page.press('#in-offset', 'Enter');
    await page.waitForFunction(() => window.tablab.editor.song.backingTrack.offset === 0.5);
    let pps = await dragWave(page, 0.5, 30);
    let b = await bt(page);
    assert.ok(Math.abs(b.offset - (0.5 + 30 / pps)) < 0.01, `offset ${b.offset}, expected ${0.5 + 30 / pps}`);
    // Pin bar 3.
    const bar3 = await page.evaluate(() => window.tablab.map.tickToTime(window.tablab.timeline.measures[2].start));
    pps = await dragWave(page, bar3, -20);
    b = await bt(page);
    assert.equal(b.syncPoints.length, 1);
    assert.equal(b.syncPoints[0].measure, 2);
    assert.ok(Math.abs(b.syncPoints[0].time - (bar3 - 20 / pps)) < 0.01);
    assert.match(await page.textContent('#pins'), /1 pinned bar/);
    // The bars between are stretched: bar 2 sits halfway between bar 1 and bar 3.
    const bar2 = await page.evaluate(() => window.tablab.map.tickToTime(window.tablab.timeline.measures[1].start));
    assert.ok(Math.abs(bar2 - (b.offset + b.syncPoints[0].time) / 2) < 0.001);
    // Double click unpins, undo pins again.
    const box = await page.locator('#wave').boundingBox();
    const x3 = await page.evaluate((t) => window.tablab.syncPanel._x(t), b.syncPoints[0].time);
    await page.mouse.dblclick(box.x + x3, box.y + box.height / 2);
    assert.equal((await bt(page)).syncPoints.length, 0);
    await page.focus('#score');
    await page.keyboard.press('Control+z');
    assert.equal((await bt(page)).syncPoints.length, 1);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  it('sets the tempo by tapping, halves and doubles it, and nudges bar 1', async () => {
    const page = await withTrack();
    await page.evaluate(async () => {
      const btn = document.querySelector('#btn-tap');
      for (let i = 0; i < 6; i++) {
        btn.click();
        await new Promise((r) => setTimeout(r, 500));
      }
    });
    assert.ok(Math.abs((await tempo(page)) - 120) < 1.5, 'tapped tempo ' + (await tempo(page)));
    const t = await tempo(page);
    await page.click('#btn-double');
    assert.ok(Math.abs((await tempo(page)) - 2 * t) < 0.02);
    await page.click('#btn-half');
    assert.ok(Math.abs((await tempo(page)) - t) < 0.02);
    await page.click('[data-nudge="0.01"]');
    await page.click('[data-nudge="0.01"]');
    await page.click('[data-nudge="-0.01"]');
    assert.equal((await bt(page)).offset, 0.01);
    // One undo step per tap session, not one per tap.
    await page.focus('#score');
    const undoDepth = await page.evaluate(() => window.tablab.editor.undoStack.length);
    assert.ok(undoDepth <= 8, 'undo steps: ' + undoDepth);
    await page.context().close();
  });

  it('sets bar 1 while the track plays', async () => {
    const page = await withTrack();
    await page.keyboard.press('Space');
    await page.waitForTimeout(1200);
    const before = await page.evaluate(() => window.tablab.engine.position().time);
    await page.click('#btn-set-start');
    const off = (await bt(page)).offset;
    assert.ok(off > before - 0.05 && off < before + 0.3, `offset ${off}, position ${before}`);
    await page.keyboard.press('Space');
    await page.context().close();
  });

  it('removes the track, and undo brings back its sync settings', async () => {
    const page = await withTrack();
    await page.fill('#in-offset', '0.75');
    await page.press('#in-offset', 'Enter');
    await page.click('#btn-remove-audio');
    assert.equal(await page.evaluate(() => window.tablab.engine.track), null);
    assert.equal(await bt(page), null);
    await page.focus('#score');
    await page.keyboard.press('Control+z');
    assert.equal((await bt(page)).offset, 0.75);
    assert.match(await page.textContent('#track-name'), /load it again/);
    await page.context().close();
  });

  it('accepts an audio file dropped on the page', async () => {
    const page = await env.open();
    const b64 = clickTrack({ seconds: 4 }).toString('base64');
    await page.evaluate((data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'dropped.wav', { type: 'audio/wav' }));
      document.querySelector('#score').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, b64);
    await page.waitForFunction(() => window.tablab.engine.track, null, { timeout: 10000 });
    assert.equal(await page.isVisible('#sync-panel'), true);
    assert.match(await page.textContent('#track-name'), /dropped\.wav/);
    await page.context().close();
  });

  it('explains when a file cannot be played', async () => {
    const page = await env.open();
    await page.click('#btn-track');
    await page.setInputFiles('#file-audio', { name: 'broken.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('this is not audio at all') });
    await page.waitForFunction(() => /cannot be played/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 });
    assert.equal(await page.evaluate(() => window.tablab.engine.track), null);
    await page.context().close();
  });
});
