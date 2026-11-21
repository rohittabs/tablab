// Browser tests for the About page and the two minute tour (about.html, slides.html).

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

const PAGES = ['slides.html', 'about.html'];

/** Open a page in a fresh browser profile. Motion is reduced unless asked for, so slides move at once. */
async function openPage(path, { viewport = { width: 1280, height: 800 }, prefs = null, motion = false, context = {}, init = null, wait = true } = {}) {
  const ctx = await env.browser.newContext({ viewport, reducedMotion: motion ? 'no-preference' : 'reduce', ...context });
  if (prefs) {
    // Saved settings, as the app leaves them (only before the first page load, so reloads keep changes).
    await ctx.addInitScript((p) => {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('tablab.prefs', JSON.stringify(p));
        sessionStorage.setItem('seeded', '1');
      }
    }, prefs);
  }
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') page.errors.push('console: ' + m.text());
  });
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  await page.goto(env.base + path);
  if (wait) await page.waitForSelector('html[data-ready]');
  return page;
}

const slideAtTop = (page) =>
  page.evaluate(() => {
    const feed = document.querySelector('#feed');
    return [...feed.querySelectorAll('.slide')].findIndex((s) => Math.abs(s.offsetTop - feed.scrollTop) < 2);
  });

async function waitForSlide(page, i) {
  await page.waitForFunction((i) => {
    const feed = document.querySelector('#feed');
    return Math.abs(feed.querySelectorAll('.slide')[i].offsetTop - feed.scrollTop) < 2;
  }, i);
}

describe('pages', () => {
  it('load without errors and draw their tabs and waveforms with the app renderer', async () => {
    for (const path of PAGES) {
      const page = await openPage(path);
      const tabs = await page.$$eval('[data-tab]', (els) =>
        els.map((el) => ({ name: el.dataset.tab, systems: el.querySelectorAll('svg.tl-system').length, strings: el.querySelector('svg.tl-system') ? el.querySelector('svg.tl-system').querySelectorAll('.tl-string').length : 0, notes: el.querySelectorAll('.tl-fret').length })),
      );
      assert.ok(tabs.length >= 4, path);
      for (const t of tabs) {
        assert.ok(t.systems >= 1 && t.notes >= 4, `${path}: the ${t.name} example is drawn`);
        assert.equal(t.strings, t.name === 'ukulele' ? 4 : 6, `${path}: strings in the ${t.name} example`);
      }
      const waves = await page.$$eval('[data-wave]', (els) => els.map((el) => !!el.querySelector('svg polygon.wv-wave')));
      assert.ok(waves.length >= 2 && waves.every(Boolean), `${path}: waveforms drawn`);
      if (path === 'slides.html') {
        assert.equal(await page.$$eval('.lengths svg', (s) => s.length), 6, 'note length icons');
        assert.equal(await page.title(), 'TabLab in 2 minutes');
      } else {
        assert.equal(await page.title(), 'About TabLab: everything it does');
      }
      // The examples show what each slide is about: a cursor, a loop and a moving playhead.
      if (path === 'slides.html') {
        assert.equal(await page.locator('[data-tab="write"] .tl-cursor-note').count(), 1);
        assert.ok((await page.locator('[data-tab="loop"] .tl-loop').count()) >= 2);
        assert.equal(await page.locator('[data-tab="hero"] .tl-playhead').count(), 1);
      }
      assert.deepEqual(page.errors, []);
      await page.context().close();
    }
  });

  // Slides that need scrolling inside, slides that had to leave something out to fit, and text wider than its box.
  const measure = (page) =>
    page.evaluate(() => {
      const slides = [...document.querySelectorAll('.slide')];
      return {
        over: slides.filter((x) => x.scrollHeight > x.clientHeight + 1).map((x) => `${x.id} by ${x.scrollHeight - x.clientHeight}px`),
        squeezed: slides.filter((x) => x.classList.contains('snugger') || x.querySelector('[data-trim]')).map((x) => x.id),
        clipped: [...document.querySelectorAll('.slide :is(h1, h2, p, dd, li)')].filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => `${el.closest('.slide').id} ${el.tagName}`),
        wide: document.documentElement.scrollWidth,
      };
    });
  const phone = { hasTouch: true, isMobile: true };

  it('fit every slide on phones and laptops without scrolling inside it or leaving anything out', async () => {
    const sizes = [
      [390, 844],
      [360, 740],
      [360, 800],
      [412, 915],
      [1280, 800],
      [1366, 768],
    ];
    for (const path of PAGES) {
      for (const [width, height] of sizes) {
        const page = await openPage(path, { viewport: { width, height }, context: width < 500 ? phone : {} });
        const m = await measure(page);
        const size = `${path} at ${width}x${height}`;
        assert.equal(m.wide, width, `${size} is not wider than the screen`);
        assert.deepEqual(m.over, [], size);
        assert.deepEqual(m.squeezed, [], `${size} shows all of every slide`);
        assert.deepEqual(m.clipped, [], `${size}: no text sticks out of its box`);
        await page.context().close();
      }
    }
  });

  it('tighten a slide that is too tall for a small phone, and loosen it again on a bigger screen', async () => {
    // An iPhone SE in Safari, with its toolbars showing.
    for (const path of PAGES) {
      const page = await openPage(path, { viewport: { width: 375, height: 553 }, context: phone });
      const m = await measure(page);
      assert.deepEqual(m.over, [], `${path} on a small phone`);
      assert.deepEqual(m.clipped, [], path);
      // The techniques example is the tallest: it keeps its first line only.
      assert.ok(m.squeezed.includes('techniques'), `${path}: ${m.squeezed}`);
      assert.equal(await page.locator('#techniques [data-tab] svg.tl-system').count(), 1);
      // On a bigger screen everything comes back.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => !document.querySelector('.snug, .snugger, [data-trim]'));
      assert.equal(await page.locator('#techniques [data-tab] svg.tl-system').count(), 2);
      assert.deepEqual((await measure(page)).over, [], `${path} after growing`);
      assert.deepEqual(page.errors, []);
      await page.context().close();
    }
    // The smallest phones may scroll inside a long slide, but nothing sticks out sideways.
    const page = await openPage('about.html', { viewport: { width: 320, height: 568 }, context: phone });
    assert.equal((await measure(page)).wide, 320);
    await page.context().close();
  });

  it('reveal each slide as it comes into view, and show everything if the script cannot run', async () => {
    let page = await openPage('slides.html', { motion: true });
    assert.ok(await page.evaluate(() => document.querySelectorAll('.slide')[0].classList.contains('inview')));
    assert.ok(!(await page.evaluate(() => document.querySelectorAll('.slide')[2].classList.contains('inview'))));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.querySelectorAll('.slide')[2].classList.contains('inview'));
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#h-rhythm')).opacity === '1');
    assert.deepEqual(page.errors, []);
    await page.context().close();

    page = await openPage('about.html', { context: { javaScriptEnabled: false }, wait: false });
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#h-backing')).opacity), '1');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[data-tab]')).display), 'none', 'empty example boxes are left out');
    await page.context().close();
  });
});

describe('moving around', () => {
  it('goes one slide at a time with the arrow keys, Page Down, Space, Home and End', async () => {
    const page = await openPage('slides.html');
    const count = await page.locator('.slide').count();
    const steps = [
      ['ArrowDown', 1],
      ['PageDown', 2],
      ['ArrowUp', 1],
      [' ', 2],
      ['Shift+ ', 1],
      ['ArrowRight', 2],
      ['ArrowLeft', 1],
      ['End', count - 1],
      ['Home', 0],
    ];
    for (const [key, slide] of steps) {
      await page.keyboard.press(key === ' ' ? 'Space' : key === 'Shift+ ' ? 'Shift+Space' : key);
      await waitForSlide(page, slide);
    }
    await page.keyboard.press('End');
    await waitForSlide(page, count - 1);
    await page.waitForFunction(() => document.querySelector('#progress').style.width === '100%');
    // Space on a button presses the button instead of moving on.
    await page.focus('#btn-copy');
    await page.keyboard.press('Space');
    await page.waitForSelector('#copied.on');
    assert.equal(await slideAtTop(page), count - 1);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  it('jumps to a slide from the list at the top of the About page', async () => {
    const page = await openPage('about.html');
    await page.click('.chips a[href="#backing"]');
    const target = await page.$$eval('.slide', (s) => s.findIndex((x) => x.id === 'backing'));
    await waitForSlide(page, target);
    assert.match(page.url(), /about\.html#backing$/);
    // A link straight to a slide opens there.
    await page.goto(env.base + 'about.html#pins');
    await page.waitForSelector('html[data-ready]');
    await waitForSlide(page, await page.$$eval('.slide', (s) => s.findIndex((x) => x.id === 'pins')));
    await page.context().close();
  });

  it('links from the app to both pages, and back', async () => {
    const app = await env.open();
    await app.click('#btn-help');
    await app.waitForSelector('#dlg-help[open]');
    await app.click('#dlg-help a[href="slides.html"]');
    await app.waitForSelector('html[data-ready]');
    assert.match(app.url(), /\/slides\.html$/);
    await app.click('.slide#go a[href="about.html"]', { force: true });
    await app.waitForSelector('html[data-ready]');
    assert.match(app.url(), /\/about\.html$/);
    await app.click('.chrome .home');
    await app.waitForFunction(() => window.tablab && window.tablab.editor);
    assert.equal(new URL(app.url()).pathname, '/');
    await app.goBack();
    await app.waitForSelector('html[data-ready]');
    await app.click('.slide#go a.cta[href="./"]', { force: true });
    await app.waitForFunction(() => window.tablab && window.tablab.editor);
    assert.deepEqual(app.errors, []);
    await app.context().close();
  });
});

describe('light and dark', () => {
  it('follows the mode chosen in the app, and the switch saves it without touching other settings', async () => {
    const page = await openPage('about.html', { prefs: { theme: 'dark', speed: 0.8, metronome: true } });
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    assert.equal(await page.getAttribute('#btn-theme', 'aria-label'), 'Switch to light mode');
    assert.equal(await page.getAttribute('meta[name="theme-color"]', 'content'), '#0e0f15');
    await page.click('#btn-theme');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
    assert.equal(await page.getAttribute('meta[name="theme-color"]', 'content'), '#f4f4f9');
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('tablab.prefs'))), { theme: 'light', speed: 0.8, metronome: true });
    await page.reload();
    await page.waitForSelector('html[data-ready]');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
    // The app opens in the mode picked here.
    await page.goto(env.base + '?nosw');
    await page.evaluate(() => window.tablab.ready);
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
    await page.context().close();
  });

  it('uses the system setting until a choice is saved', async () => {
    for (const scheme of ['dark', 'light']) {
      const page = await openPage('slides.html', { context: { colorScheme: scheme } });
      assert.equal(await page.getAttribute('html', 'data-theme'), scheme);
      await page.context().close();
    }
  });
});

describe('the last slide', () => {
  it('copies the address of the app', async () => {
    const page = await openPage('slides.html', { context: { permissions: ['clipboard-read', 'clipboard-write'] } });
    await page.keyboard.press('End');
    await page.click('#btn-copy');
    await page.waitForSelector('#copied.on');
    assert.equal(await page.textContent('#copied'), 'Copied');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), env.base);
    assert.equal(await page.textContent('[data-app-url]'), env.base.replace(/^http:\/\//, '').replace(/\/$/, ''));
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
});

describe('key labels', () => {
  it('say Cmd on a Mac, like the app', async () => {
    const pc = await openPage('about.html');
    const pcKeys = await pc.$$eval('kbd', (k) => k.map((e) => e.textContent));
    assert.ok(pcKeys.includes('Ctrl') && !pcKeys.includes('Cmd'));
    await pc.context().close();
    const mac = await openPage('about.html', {
      init: () => {
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
        Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => undefined });
      },
    });
    const macKeys = await mac.$$eval('kbd', (k) => k.map((e) => e.textContent));
    assert.ok(macKeys.includes('Cmd') && !macKeys.includes('Ctrl'));
    await mac.context().close();
  });
});

describe('printing', () => {
  it('prints every slide one after another, in black on white', async () => {
    const page = await openPage('about.html', { prefs: { theme: 'dark' } });
    await page.emulateMedia({ media: 'print' });
    const look = await page.evaluate(() => {
      const css = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
      const slides = [...document.querySelectorAll('.slide')];
      return {
        feed: css('#feed', 'overflowY'),
        chrome: css('.chrome', 'display'),
        heading: css('#h-top', 'color'),
        body: css('body', 'backgroundColor'),
        tallest: Math.max(...slides.map((s) => s.getBoundingClientRect().height)),
        hidden: slides.filter((s) => getComputedStyle(s.querySelector('.rise')).opacity !== '1').length,
      };
    });
    assert.equal(look.feed, 'visible');
    assert.equal(look.chrome, 'none');
    assert.equal(look.heading, 'rgb(0, 0, 0)', 'the gradient heading prints as plain black');
    assert.equal(look.body, 'rgb(255, 255, 255)');
    assert.ok(look.tallest < 800, 'slides are as tall as their content: ' + look.tallest);
    assert.equal(look.hidden, 0);
    const pdf = await page.pdf({ format: 'A4' });
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    assert.ok(pages >= 4, 'pages: ' + pages);
    await page.context().close();
  });
});

describe('offline', () => {
  it('opens both pages without a connection once TabLab has been visited', async () => {
    const app = await env.open({ query: '' });
    await app.evaluate(() => navigator.serviceWorker.ready);
    await app.waitForFunction(async () => !!(await caches.match('about.html')) && !!(await caches.match('js/tour.js')) && !!(await caches.match('css/tour.css')));
    await app.context().setOffline(true);
    for (const path of PAGES) {
      await app.goto(env.base + path);
      await app.waitForSelector('html[data-ready]');
      assert.ok((await app.locator('[data-tab] svg.tl-system').count()) >= 4, `${path} works offline`);
    }
    await app.context().setOffline(false);
    await app.context().close();
  });
});
