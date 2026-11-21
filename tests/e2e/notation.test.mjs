// Browser tests for the notation view, key signatures, capo and custom tunings.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { newSong, setup, song } from './helpers.mjs';

let env;
before(async () => {
  env = await setup();
});
after(async () => {
  await env.close();
});

/** Save the song dialog and wait until the song has the change. */
async function save(page, check, arg) {
  await page.click('#song-ok');
  await page.waitForFunction(check, arg);
}

const staffCount = (page) => page.evaluate(() => document.querySelectorAll('#systems .tl-staff').length);

describe('notation view', () => {
  it('starts with the tab alone, and the button shows notation above it', async () => {
    const page = await env.open();
    assert.equal(await staffCount(page), 0);
    assert.equal(await page.getAttribute('#btn-view', 'aria-pressed'), 'false');
    const before = await page.evaluate(() => document.querySelector('#systems svg').getBoundingClientRect().height);
    await page.click('#btn-view');
    assert.equal(await page.getAttribute('#btn-view', 'aria-pressed'), 'true');
    // Five lines a staff, one staff for each line of music.
    const systems = await page.evaluate(() => document.querySelectorAll('#systems svg').length);
    assert.equal(await staffCount(page), 5 * systems);
    const after = await page.evaluate(() => document.querySelector('#systems svg').getBoundingClientRect().height);
    assert.ok(after > before + 40, `the line of music grows to make room (${before} to ${after})`);
    // Notes drawn with the music font: noteheads, the clef and the time signature.
    assert.ok((await page.evaluate(() => document.querySelectorAll('#systems path.tl-ink').length)) > 20);
    assert.deepEqual(page.errors, []);
  });

  it('Shift+N switches the view, and the choice is remembered', async () => {
    const page = await env.open();
    await page.focus('#score');
    await page.keyboard.press('Shift+N');
    assert.ok((await staffCount(page)) > 0);
    // N on its own still makes a harmonic.
    await page.keyboard.press('0');
    await page.keyboard.press('n');
    assert.equal((await song(page)).measures[0].beats[0].notes.find((n) => n.string === 0).harmonic, true);
    await page.reload();
    await page.evaluate(() => window.tablab.ready);
    assert.equal(await page.evaluate(() => window.tablab.prefs.notation), true, 'the choice is saved');
    // The score is drawn on the next animation frame.
    await page.waitForFunction(() => document.querySelectorAll('#systems .tl-staff').length > 0);
    assert.equal(await page.getAttribute('#btn-view', 'aria-pressed'), 'true');
    await page.focus('#score');
    await page.keyboard.press('Shift+N');
    assert.equal(await staffCount(page), 0);
    assert.deepEqual(page.errors, []);
  });

  it('clicking on the notation keeps the string, clicking the tab picks one', async () => {
    const page = await env.open();
    await page.click('#btn-view');
    const svg = page.locator('#systems svg').first();
    const sys = await page.evaluate(() => {
      const s = window.tablab.layout.systems[0];
      const m = s.measures[0];
      return { notaTop: s.notaTop, staffTop: s.staffTop, x: m.beatsX[1].x };
    });
    await svg.click({ position: { x: sys.x, y: sys.staffTop + 13 * 2 } });
    let c = await page.evaluate(() => ({ ...window.tablab.editor.cursor }));
    assert.equal(c.b, 1);
    assert.equal(c.s, 2);
    await svg.click({ position: { x: sys.x, y: sys.notaTop + 10 } });
    c = await page.evaluate(() => ({ ...window.tablab.editor.cursor }));
    assert.equal(c.s, 2, 'the string stays the same');
    assert.deepEqual(page.errors, []);
  });

  it('the playhead covers the notation and the tab while playing', async () => {
    const page = await env.open();
    await page.click('#btn-view');
    await page.click('#btn-play');
    await page.waitForSelector('#systems .tl-playhead', { state: 'attached' });
    const r = await page.evaluate(() => {
      const el = document.querySelector('#systems .tl-playhead');
      const s = window.tablab.layout.systems[0];
      return { y1: Number(el.getAttribute('y1')), notaTop: s.notaTop };
    });
    assert.ok(r.y1 < r.notaTop);
    await page.click('#btn-play');
    assert.deepEqual(page.errors, []);
  });

  it('fits a phone screen', async () => {
    const page = await env.open({ viewport: { width: 360, height: 740 }, context: { hasTouch: true, isMobile: true } });
    await page.click('#btn-view');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 360);
    const wide = await page.evaluate(() => [...document.querySelectorAll('#systems svg')].filter((s) => s.getBoundingClientRect().right > innerWidth).length);
    assert.equal(wide, 0);
    assert.deepEqual(page.errors, []);
  });
});

describe('song settings', () => {
  it('sets a key signature, shown on the staff and in the song summary', async () => {
    const page = await env.open();
    await page.click('#btn-view');
    await page.click('#btn-song');
    assert.equal(await page.inputValue('#form-song select[name=key]'), '0');
    await page.selectOption('#form-song select[name=key]', '-3');
    await save(page, () => window.tablab.editor.song.key === -3);
    assert.equal((await song(page)).key, -3);
    assert.match(await page.textContent('#btn-song'), /Key E♭\/Cm/);
    assert.match(await page.textContent('#print-sub'), /Key of E♭ major \/ C minor/);
    // Undo takes it back.
    await page.focus('#score');
    await page.keyboard.press('Control+z');
    assert.equal((await song(page)).key, 0);
    assert.deepEqual(page.errors, []);
  });

  it('capo is offered from none to the 12th fret and changes the sound', async () => {
    const page = await env.open();
    await page.click('#btn-song');
    const options = await page.$$eval('#form-song select[name=capo] option', (o) => o.map((x) => x.textContent));
    assert.equal(options.length, 13);
    assert.equal(options[0], 'None');
    assert.equal(options[12], 'Fret 12');
    await page.selectOption('#form-song select[name=capo]', '3');
    await save(page, () => window.tablab.editor.song.capo === 3);
    assert.equal((await song(page)).capo, 3);
    assert.match(await page.textContent('#btn-song'), /Capo 3/);
    assert.deepEqual(page.errors, []);
  });

  for (const instrument of ['guitar', 'ukulele']) {
    it(`a custom ${instrument} tuning, one string at a time`, async () => {
      const page = await env.open();
      await newSong(page, { instrument, title: 'Custom ' + instrument });
      await page.click('#btn-song');
      assert.equal(await page.isHidden('#custom-tuning'), true);
      await page.selectOption('#form-song select[name=tuning]', 'custom');
      assert.equal(await page.isVisible('#custom-tuning'), true);
      const pickers = page.locator('#custom-strings select');
      const n = instrument === 'guitar' ? 6 : 4;
      assert.equal(await pickers.count(), n);
      // Starts from the standard tuning, lowest string on the left.
      const start = await pickers.evaluateAll((s) => s.map((x) => Number(x.value)));
      assert.deepEqual(start, instrument === 'guitar' ? [40, 45, 50, 55, 59, 64] : [67, 60, 64, 69]);
      // Lower the lowest-sounding string by a whole step... and the first picker too.
      const custom = instrument === 'guitar' ? [36, 43, 48, 55, 60, 64] : [67, 60, 64, 70];
      for (let i = 0; i < n; i++) await pickers.nth(i).selectOption(String(custom[i]));
      await save(page, (t) => window.tablab.editor.song.tuning.join() === t, custom.slice().reverse().join());
      const s = await song(page);
      assert.deepEqual(s.tuning, custom.slice().reverse(), 'stored from string 1 (the highest) down');
      assert.match(await page.textContent('#btn-song'), instrument === 'guitar' ? /C G C G C E/ : /G C E A#/);
      // The string names follow the tuning.
      const names = await page.$$eval('#systems svg:first-child .tl-strname', (t) => t.map((x) => x.textContent));
      assert.deepEqual(names, instrument === 'guitar' ? ['e', 'C', 'G', 'C', 'G', 'C'] : ['A#', 'E', 'C', 'G']);
      // A note on the lowest string sounds the new pitch.
      await page.focus('#score');
      for (let i = 0; i < n - 1; i++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('0');
      const pitch = await page.evaluate(() => window.tablab.editor.song.tuning[window.tablab.editor.cursor.s]);
      assert.equal(pitch, custom[0]);
      // Opening the dialog again shows the custom tuning.
      await page.click('#btn-song');
      assert.equal(await page.inputValue('#form-song select[name=tuning]'), 'custom');
      assert.deepEqual(await pickers.evaluateAll((x) => x.map((y) => Number(y.value))), custom);
      // Picking a preset again restores it.
      await page.selectOption('#form-song select[name=tuning]', 'standard');
      assert.equal(await page.isHidden('#custom-tuning'), true);
      await save(page, () => !window.tablab.editor.song.tuning.includes(36) && !window.tablab.editor.song.tuning.includes(70));
      assert.deepEqual((await song(page)).tuning, instrument === 'guitar' ? [64, 59, 55, 50, 45, 40] : [69, 64, 60, 67]);
      assert.deepEqual(page.errors, []);
    });
  }

  it('a new song can start in a custom tuning and a key', async () => {
    const page = await env.open();
    await page.click('#btn-new');
    await page.check('#form-song input[name=instrument][value=ukulele]');
    await page.selectOption('#form-song select[name=tuning]', 'low-g');
    await page.selectOption('#form-song select[name=tuning]', 'custom');
    // Starts from the tuning picked before Custom.
    const pickers = page.locator('#custom-strings select');
    assert.deepEqual(await pickers.evaluateAll((x) => x.map((y) => Number(y.value))), [55, 60, 64, 69]);
    await pickers.nth(0).selectOption('53');
    await page.selectOption('#form-song select[name=key]', '-1');
    await save(page, () => window.tablab.editor.song.instrument === 'ukulele');
    const s = await song(page);
    assert.equal(s.instrument, 'ukulele');
    assert.deepEqual(s.tuning, [69, 64, 60, 53]);
    assert.equal(s.key, -1);
    assert.deepEqual(page.errors, []);
  });

  it('switching instrument in the dialog offers that instrument’s tunings', async () => {
    const page = await env.open();
    await page.click('#btn-song');
    await page.selectOption('#form-song select[name=tuning]', 'custom');
    await page.check('#form-song input[name=instrument][value=ukulele]');
    assert.equal(await page.inputValue('#form-song select[name=tuning]'), 'standard');
    assert.equal(await page.isHidden('#custom-tuning'), true);
    await page.selectOption('#form-song select[name=tuning]', 'custom');
    assert.equal(await page.locator('#custom-strings select').count(), 4);
    const [lo, hi] = await page.$$eval('#custom-strings select:first-child option', (o) => [o[0].textContent, o[o.length - 1].textContent]);
    assert.equal(lo, 'G2');
    assert.equal(hi, 'A5');
    assert.deepEqual(page.errors, []);
  });
});
