// Shared setup for the browser tests: a local server, Chromium, and a page that records errors.

import { createRequire } from 'node:module';
import { startServer } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);

export async function setup() {
  const { chromium } = require('playwright');
  const server = await startServer(0);
  const port = server.address().port;
  const options = { args: (process.env.CHROMIUM_ARGS || '').split(' ').filter(Boolean) };
  if (process.env.CHROMIUM_PATH) options.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(options);
  const base = `http://127.0.0.1:${port}/`;
  return {
    base,
    browser,
    async close() {
      await browser.close();
      await new Promise((r) => server.close(r));
    },
    /** A fresh page (new storage) with TabLab loaded. Errors are collected in page.errors. */
    async open({ query = '?nosw', theme = 'light', viewport = { width: 1280, height: 800 }, context: ctxOpts = {}, clear = true, sampleRate = 0 } = {}) {
      const context = await browser.newContext({ viewport, colorScheme: theme, acceptDownloads: true, ...ctxOpts });
      if (sampleRate) {
        // Run the audio graph at a chosen rate, as on a sound card that prefers it.
        await context.addInitScript((rate) => {
          const Base = window.AudioContext;
          window.AudioContext = class extends Base {
            constructor(options = {}) {
              super({ ...options, sampleRate: rate });
            }
          };
        }, sampleRate);
      }
      const page = await context.newPage();
      page.errors = [];
      page.on('console', (m) => {
        if (m.type() === 'error') page.errors.push('console: ' + m.text());
      });
      page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
      await page.goto(base + query);
      await page.evaluate(() => window.tablab.ready);
      if (clear) await page.evaluate(() => document.querySelector('#toast').classList.remove('show'));
      page.context = () => context;
      return page;
    },
  };
}

/** Song data from the page. */
export function song(page) {
  return page.evaluate(() => JSON.parse(JSON.stringify(window.tablab.editor.song)));
}

export function cursor(page) {
  return page.evaluate(() => ({ ...window.tablab.editor.cursor }));
}

/** Start a new empty song through the New song dialog. */
export async function newSong(page, { instrument = 'guitar', title = 'Test song', tempo = 120 } = {}) {
  await page.click('#btn-new');
  await page.fill('#form-song input[name=title]', title);
  await page.check(`#form-song input[name=instrument][value=${instrument}]`);
  await page.fill('#form-song input[name=tempo]', String(tempo));
  await page.click('#song-ok');
  await page.waitForFunction((t) => window.tablab.editor.song.title === t, title);
  await page.focus('#score');
}

/** A WAV file (16-bit mono) as a Buffer. */
export function wav(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

/**
 * A simple drum-like backing track: a click on every beat (accented on beat 1) starting at `offset`
 * seconds, with a quiet hum underneath, so tempo detection has something real to find.
 */
export function clickTrack({ bpm = 100, offset = 0.5, seconds = 12, sampleRate = 22050 } = {}) {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = 0.02 * Math.sin((2 * Math.PI * 110 * i) / sampleRate);
  const beat = 60 / bpm;
  for (let k = 0; offset + k * beat < seconds - 0.1; k++) {
    const start = Math.round((offset + k * beat) * sampleRate);
    const amp = k % 4 === 0 ? 0.9 : 0.6;
    const f = k % 4 === 0 ? 1500 : 1000;
    for (let j = 0; j < 0.05 * sampleRate && start + j < out.length; j++) {
      out[start + j] += amp * Math.exp(-j / (0.008 * sampleRate)) * Math.sin((2 * Math.PI * f * j) / sampleRate);
    }
  }
  return wav(out, sampleRate);
}
