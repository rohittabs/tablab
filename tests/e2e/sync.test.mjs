// Measures how well a backing track and the song clock line up, at several practice speeds.
// A click track goes through the real audio path; a tap in the audio graph timestamps every
// click it hears, and each timestamp is compared with where the song clock says it should be.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setup, wav } from './helpers.mjs';

const SR = 44100;
const FIRST = 1.0; // first click, and bar 1, in the recording
const STEP = 0.5; // one click per beat at 120 BPM
// The audio graph's sample rate. Sound cards differ (44100 and 48000 are both common), so
// run this file with TEST_SAMPLE_RATE=48000 too. 0 keeps the browser's own choice.
const GRAPH_RATE = Number(process.env.TEST_SAMPLE_RATE || 0);

function pulses(seconds = 12) {
  const out = new Float32Array(seconds * SR);
  for (let t = FIRST; t < seconds - 0.2; t += STEP) {
    const s0 = Math.round(t * SR);
    for (let j = 0; j < 0.03 * SR; j++) out[s0 + j] = 0.9 * Math.exp(-j / (0.004 * SR)) * (j < 30 ? 1 : Math.sign(Math.sin(j * 0.7)));
  }
  return wav(out, SR);
}

let env;
before(async () => {
  env = await setup();
});
after(async () => {
  await env.close();
});

async function prepare(speed) {
  const page = await env.open({ sampleRate: GRAPH_RATE });
  await page.evaluate(
    ({ FIRST }) => {
      const measures = [];
      for (let m = 0; m < 8; m++) measures.push({ beats: [0, 1, 2, 3].map(() => ({ duration: 4, dotted: false, triplet: false, notes: [{ string: 0, fret: 0 }] })) });
      window.tablab.openSong({ format: 'tablab', version: 1, id: 'sync-test', title: 'Sync test', instrument: 'guitar', tuning: [64, 59, 55, 50, 45, 40], capo: 0, tempo: 120, timeSignature: [4, 4], measures, backingTrack: { fileName: 'pulses.wav', offset: FIRST, volume: 1, syncPoints: [] } });
      window.tablab.prefs.countIn = 0;
    },
    { FIRST },
  );
  await page.click('#btn-track');
  await page.setInputFiles('#file-audio', { name: 'pulses.wav', mimeType: 'audio/wav', buffer: pulses() });
  await page.waitForFunction(() => window.tablab.engine.track && window.tablab.engine.track.peaks, null, { timeout: 10000 });
  await page.evaluate(async (speed) => {
    const e = window.tablab.engine;
    const ctx = e.ctx;
    // A click starts where the signal first goes over 0.15 after at least 0.2 s below it.
    // Low noise between clicks (from resampling or time stretching) cannot hide a click.
    const code = `class Tap extends AudioWorkletProcessor {
      constructor() { super(); this.since = 1e9; this.gap = Math.round(0.2 * sampleRate); }
      process(inputs) {
        const ch = inputs[0] && inputs[0][0];
        if (ch) for (let i = 0; i < ch.length; i++) {
          if (Math.abs(ch[i]) > 0.15) {
            if (this.since > this.gap) this.port.postMessage((currentFrame + i) / sampleRate);
            this.since = 0;
          } else this.since++;
        }
        return true;
      }
    }
    registerProcessor('tap', Tap);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    const tap = new AudioWorkletNode(ctx, 'tap');
    const mute = ctx.createGain();
    mute.gain.value = 0;
    e.trackBus.connect(tap);
    tap.connect(mute);
    mute.connect(ctx.destination);
    window.__onsets = [];
    tap.port.onmessage = (m) => window.__onsets.push(m.data);
    window.tablab.setSpeed(speed);
  }, speed);
  await page.focus('#score');
  return page;
}

/** Song clock error at each click heard after `fromCtx` (seconds, + means the click came late). */
function errors(page, fromCtx = 0) {
  return page.evaluate(
    ({ FIRST, STEP, fromCtx }) => {
      const e = window.tablab.engine;
      return window.__onsets
        .filter((c) => c >= fromCtx)
        .map((c) => {
          const t = e.timeAt(c);
          const k = Math.round((t - FIRST) / STEP);
          return t - (FIRST + STEP * k);
        });
    },
    { FIRST, STEP, fromCtx },
  );
}

const ms = (x) => (x * 1000).toFixed(1);

describe('backing track sync accuracy', () => {
  for (const speed of [1, 0.75, 0.5, 1.25]) {
    it(`clicks line up with the song clock at ${speed * 100}% speed`, async () => {
      const page = await prepare(speed);
      const start = await page.evaluate(() => window.tablab.engine.ctx.currentTime);
      await page.keyboard.press('Space');
      // For the log: how far the recording's own clock is from the song clock, every 250 ms.
      const gaps = [];
      for (let i = 0; i < 22; i++) {
        await page.waitForTimeout(250);
        gaps.push(await page.evaluate(() => {
          const e = window.tablab.engine;
          return e.media && !e.media.paused ? e.media.currentTime - e._latency() - e.timeAt(e.ctx.currentTime) : NaN;
        }));
      }
      // The first quarter second is left out: the browser's time stretcher fades the sound in
      // there, which can move the very first click's attack by up to 20 ms. That fade is part
      // of the browser, not of TabLab's timing (the late start test below covers starting).
      const errs = await errors(page, start + 0.25);
      await page.keyboard.press('Space');
      assert.ok(errs.length >= 4, 'clicks heard: ' + errs.length);
      const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      const worst = Math.max(...errs.map(Math.abs));
      console.log(`  speed ${speed}: ${errs.length} clicks, mean ${ms(mean)} ms, worst ${ms(worst)} ms, all: ${errs.map(ms).join(' ')}`);
      const anchors = await page.evaluate((start) => window.tablab.engine.anchors.map((a) => `${(a.R0 - start).toFixed(3)}/${a.A0.toFixed(3)}`), start);
      console.log(`    clock anchors (ctx time after start / song time): ${anchors.join(' ')}; recording minus song clock: ${gaps.map(ms).join(' ')}`);
      assert.ok(Math.abs(mean) < 0.008, `average error ${ms(mean)} ms`);
      assert.ok(worst < 0.025, `worst error ${ms(worst)} ms`);
      assert.deepEqual(page.errors, []);
      await page.context().close();
    });
  }

  it('locks on when the count-in starts before the recording does', async () => {
    const page = await prepare(1);
    await page.evaluate(() => {
      window.tablab.prefs.countIn = 1; // 2 s of count-in, so it starts 1 s before the file
    });
    await page.keyboard.press('Space');
    await page.waitForTimeout(6000);
    const errs = await errors(page);
    await page.keyboard.press('Space');
    assert.ok(errs.length >= 4, 'clicks heard: ' + errs.length);
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const worst = Math.max(...errs.map(Math.abs));
    console.log(`  late start: ${errs.length} clicks, mean ${ms(mean)} ms, worst ${ms(worst)} ms`);
    assert.ok(worst < 0.012, `worst error ${ms(worst)} ms`);
    await page.context().close();
  });

  it('stays in sync when a loop jumps back in the recording', async () => {
    const page = await prepare(1);
    await page.evaluate(() => {
      window.tablab.editor.setCursor(1, 0); // loop bar 2: 3.0 s to 5.0 s in the file
    });
    await page.focus('#score');
    await page.keyboard.press('l');
    await page.keyboard.press('Space');
    await page.waitForTimeout(6800);
    const errs = await errors(page);
    const loops = await page.evaluate(() => window.tablab.engine.anchors.length);
    await page.keyboard.press('Space');
    assert.ok(errs.length >= 8, 'clicks heard: ' + errs.length);
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    const worst = Math.max(...errs.map(Math.abs));
    console.log(`  loop: ${errs.length} clicks, ${loops} clock anchors, mean ${ms(mean)} ms, worst ${ms(worst)} ms, all: ${errs.map(ms).join(' ')}`);
    assert.ok(worst < 0.02, `worst error ${ms(worst)} ms`);
    await page.context().close();
  });

  it('stays in sync when the speed changes while playing', async () => {
    const page = await prepare(1);
    await page.keyboard.press('Space');
    await page.waitForTimeout(2000);
    const changedAt = await page.evaluate(() => {
      window.tablab.setSpeed(0.6);
      return window.tablab.engine.ctx.currentTime;
    });
    await page.waitForTimeout(5000);
    const errs = await errors(page, changedAt + 1.0);
    await page.keyboard.press('Space');
    assert.ok(errs.length >= 3, 'clicks heard after the change: ' + errs.length);
    const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
    console.log(`  1 to 0.6: ${errs.length} clicks, mean ${ms(mean)} ms`);
    assert.ok(Math.abs(mean) < 0.012, `average error ${ms(mean)} ms`);
    await page.context().close();
  });
});
