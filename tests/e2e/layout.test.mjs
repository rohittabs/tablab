// Browser tests for the screen layout: phones, the number pad, messages, printing and key labels.

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

const phone = (width, height) => ({ viewport: { width, height }, context: { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } });
const box = (page, sel) =>
  page.evaluate((s) => {
    const b = document.querySelector(s).getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height, width: b.width };
  }, sel);

async function loadTrack(page) {
  await page.click('#btn-track');
  await page.setInputFiles('#file-audio', { name: 'drums.wav', mimeType: 'audio/wav', buffer: clickTrack({ bpm: 88, offset: 0.8, seconds: 12 }) });
  await page.waitForFunction(() => window.tablab.engine.track && window.tablab.engine.track.peaks);
}

describe('phones', () => {
  for (const [w, h] of [
    [320, 640],
    [390, 844],
  ]) {
    it(`fits a ${w} px wide phone with nothing sticking out or overlapping`, async () => {
      const page = await env.open({ ...phone(w, h), clear: false });
      await page.waitForTimeout(300); // let the welcome message slide into place
      // Nothing makes the page wider than the screen (which would zoom the whole app out).
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), w);
      // The top bar items sit side by side.
      const overlaps = await page.evaluate(() => {
        const items = [...document.querySelectorAll('.brand, #song-title, #btn-song-mini, .top-actions > *')]
          .map((e) => e.getBoundingClientRect())
          .filter((b) => b.width)
          .sort((a, b) => a.left - b.left);
        return items.filter((b, i) => i > 0 && b.left < items[i - 1].right - 0.5).length;
      });
      assert.equal(overlaps, 0);
      assert.ok((await box(page, '#btn-song-mini')).width > 0, 'song settings button shown');
      // The number pad is on by default for touch screens and sits above the player.
      const pad = await box(page, '#keypad');
      const player = await box(page, '.player');
      assert.ok(pad.height > 0, 'number pad shown');
      assert.ok(pad.bottom <= player.top - 4, `pad bottom ${pad.bottom}, player top ${player.top}`);
      assert.ok(pad.top >= (await box(page, '.toolbar')).bottom, 'pad stays below the toolbar');
      // The welcome message talks about tapping, and does not cover the pad.
      const text = await page.textContent('#toast');
      assert.match(text, /Tap play/);
      const msg = await box(page, '#toast');
      assert.ok(msg.bottom <= pad.top || msg.right <= pad.left, 'message clear of the number pad');
      assert.deepEqual(page.errors, []);
      await page.context().close();
    });
  }

  it('keeps the tab in view when the backing track panel is open on a phone', async () => {
    const page = await env.open(phone(390, 844));
    await loadTrack(page);
    await page.waitForTimeout(200);
    const score = await box(page, '#score');
    const panel = await box(page, '#sync-panel');
    assert.ok(score.height >= 180, 'tab area height ' + score.height);
    assert.ok(panel.height <= 844 * 0.45, 'panel height ' + panel.height);
    // The panel scrolls instead, and the number pad steps aside while it is open.
    assert.ok(await page.evaluate(() => document.querySelector('#sync-panel').scrollHeight > document.querySelector('#sync-panel').clientHeight));
    assert.equal((await box(page, '#keypad')).height, 0);
    await page.click('#btn-track');
    assert.ok((await box(page, '#keypad')).height > 0, 'number pad back when the panel closes');
    // Song settings are one tap away on a phone too.
    await page.click('#btn-song-mini');
    await page.waitForSelector('#dlg-song[open]');
    const dlg = await box(page, '#dlg-song');
    assert.ok(dlg.left >= 0 && dlg.right <= 390, 'dialog fits the screen');
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
});

describe('song settings button', () => {
  it('is the song summary on wide screens and a small gear on narrow ones', async () => {
    for (const [width, chip, gear] of [
      [1280, true, false],
      [900, false, true],
    ]) {
      const page = await env.open({ viewport: { width, height: 700 } });
      assert.equal((await box(page, '#btn-song')).width > 0, chip, `summary at ${width}`);
      assert.equal((await box(page, '#btn-song-mini')).width > 0, gear, `gear at ${width}`);
      await page.click(chip ? '#btn-song' : '#btn-song-mini');
      await page.waitForSelector('#dlg-song[open]');
      await page.context().close();
    }
  });
});

describe('messages', () => {
  it('appear above the player, and above the backing track panel when it is open', async () => {
    const page = await env.open();
    await page.focus('#score');
    await page.keyboard.press('Control+v'); // nothing copied yet, so a message shows
    await page.waitForSelector('#toast.show');
    await page.waitForTimeout(300);
    let msg = await box(page, '#toast');
    assert.ok(msg.bottom <= (await box(page, '.player')).top, 'above the player');
    await loadTrack(page);
    await page.focus('#score');
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(300);
    msg = await box(page, '#toast');
    assert.ok(msg.bottom <= (await box(page, '#sync-panel')).top, 'above the backing track panel');
    await page.context().close();
  });
});

describe('printing', () => {
  it('lays the tab out at page width for printing, then back at screen width', async () => {
    const page = await env.open({ viewport: { width: 1280, height: 800 } });
    await page.waitForSelector('#systems svg.tl-system');
    const widest = () => page.evaluate(() => Math.max(...[...document.querySelectorAll('#systems svg.tl-system')].map((s) => Number(s.getAttribute('width')))));
    const screen = await widest();
    assert.ok(screen > 1000, 'screen layout width ' + screen);
    await page.emulateMedia({ media: 'print' });
    await page.waitForFunction(() => Math.max(...[...document.querySelectorAll('#systems svg.tl-system')].map((s) => Number(s.getAttribute('width')))) <= 700);
    // More lines on paper than on screen, and nothing from the app around the tab.
    const lines = await page.locator('#systems svg.tl-system').count();
    assert.ok(lines >= 2, 'lines on paper: ' + lines);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.player')).display), 'none');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.paper')).boxShadow), 'none');
    const pdf = await page.pdf({ format: 'A4' });
    assert.ok(pdf.length > 5000);
    await page.emulateMedia({ media: 'screen' });
    await page.waitForFunction((w) => Math.max(...[...document.querySelectorAll('#systems svg.tl-system')].map((s) => Number(s.getAttribute('width')))) === w, screen);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
});

describe('key labels', () => {
  it('say Cmd on a Mac and Ctrl elsewhere', async () => {
    const labels = async (page) => {
      await page.click('#btn-help');
      await page.waitForSelector('#dlg-help[open]');
      const keys = await page.$$eval('#help-body kbd', (k) => k.map((e) => e.textContent));
      const title = await page.getAttribute('#btn-library', 'title');
      return { keys, title };
    };
    const pc = await env.open();
    const a = await labels(pc);
    assert.ok(a.keys.includes('Ctrl') && !a.keys.includes('Cmd'));
    assert.match(a.title, /Ctrl\+O/);
    await pc.context().close();

    const context = await env.browser.newContext();
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
    });
    const mac = await context.newPage();
    await mac.goto(env.base + '?nosw');
    await mac.evaluate(() => window.tablab.ready);
    const b = await labels(mac);
    assert.ok(b.keys.includes('Cmd') && !b.keys.includes('Ctrl'));
    assert.match(b.title, /Cmd\+O/);
    // Cmd shortcuts work too.
    await mac.keyboard.press('Escape');
    await mac.focus('#score');
    const before = await mac.evaluate(() => window.tablab.editor.song.measures.length);
    await mac.keyboard.press('Enter');
    await mac.keyboard.press('Meta+z');
    assert.equal(await mac.evaluate(() => window.tablab.editor.song.measures.length), before);
    await context.close();
  });
});
