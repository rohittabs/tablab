import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderPluck, renderClick, renderDeadNote, midiToFreq } from '../../js/audio/pluck.js';

/** Estimate the fundamental with normalised autocorrelation and parabolic interpolation. */
function estimatePitch(data, sampleRate, expected) {
  const start = Math.round(sampleRate * 0.12);
  const len = Math.round(sampleRate * 0.25);
  const x = data.subarray(start, start + len + Math.round(sampleRate / 40));
  const period = sampleRate / expected;
  const lo = Math.floor(period * 0.8);
  const hi = Math.ceil(period * 1.25);
  const ac = (lag) => {
    let s = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i < len; i++) {
      s += x[i] * x[i + lag];
      e1 += x[i] * x[i];
      e2 += x[i + lag] * x[i + lag];
    }
    return s / Math.sqrt(e1 * e2 + 1e-12);
  };
  let best = lo;
  let bestV = -Infinity;
  const vals = {};
  for (let lag = lo - 1; lag <= hi + 1; lag++) vals[lag] = ac(lag);
  for (let lag = lo; lag <= hi; lag++) {
    if (vals[lag] > bestV) {
      bestV = vals[lag];
      best = lag;
    }
  }
  const a = vals[best - 1];
  const b = vals[best];
  const c = vals[best + 1];
  const shift = (0.5 * (a - c)) / (a - 2 * b + c);
  return sampleRate / (best + shift);
}

function rms(data, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += data[i] * data[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

test('plucked strings are in tune across the guitar and ukulele range', () => {
  for (const sr of [44100, 48000]) {
    for (const midi of [38, 40, 45, 52, 57, 64, 69, 76, 81, 88]) {
      const { data, freq } = renderPluck(sr, midi, { voice: midi > 60 ? 'ukulele' : 'guitar', seconds: 0.6 });
      const target = midiToFreq(midi);
      assert.ok(Math.abs(1200 * Math.log2(freq / target)) < 0.01, `reported pitch for ${midi}`);
      const est = estimatePitch(data, sr, target);
      const cents = 1200 * Math.log2(est / target);
      assert.ok(Math.abs(cents) < 3, `midi ${midi} at ${sr} Hz is ${cents.toFixed(2)} cents off`);
    }
  }
});

test('plucked note is clean: finite, bounded, decaying, no clicks at the edges', () => {
  const sr = 48000;
  for (const voice of ['guitar', 'ukulele']) {
    const { data } = renderPluck(sr, 55, { voice });
    let max = 0;
    for (const v of data) {
      assert.ok(Number.isFinite(v));
      max = Math.max(max, Math.abs(v));
    }
    assert.ok(max <= 0.5 + 1e-6 && max > 0.3, `peak ${max}`);
    const early = rms(data, 0, Math.round(sr * 0.2));
    const late = rms(data, data.length - Math.round(sr * 0.3), data.length - Math.round(sr * 0.1));
    assert.ok(late < early * 0.3, `${voice} decays (${early.toFixed(3)} -> ${late.toFixed(3)})`);
    assert.ok(Math.abs(data[0]) < 1e-3 && Math.abs(data[data.length - 1]) < 1e-3, 'fades at both ends');
  }
});

test('ukulele notes are shorter than guitar notes', () => {
  const g = renderPluck(48000, 64, { voice: 'guitar' }).data.length;
  const u = renderPluck(48000, 64, { voice: 'ukulele' }).data.length;
  assert.ok(u < g);
});

test('renders are deterministic', () => {
  const a = renderPluck(44100, 60, { seconds: 0.2 }).data;
  const b = renderPluck(44100, 60, { seconds: 0.2 }).data;
  assert.deepEqual(a, b);
});

test('clicks and dead notes are short and bounded', () => {
  for (const accent of [0, 1, 2]) {
    const c = renderClick(48000, accent);
    assert.ok(c.length < 48000 * 0.06);
    assert.ok(Math.max(...c.map(Math.abs)) <= 0.9 + 1e-6);
  }
  const accentPeak = Math.max(...renderClick(48000, 2).map(Math.abs));
  const normalPeak = Math.max(...renderClick(48000, 0).map(Math.abs));
  assert.ok(accentPeak > normalPeak, 'accent is louder');
  const d = renderDeadNote(48000);
  assert.ok(d.length < 48000 * 0.1 && d.every(Number.isFinite));
});

test('rendering is fast enough to do on demand', () => {
  const t0 = performance.now();
  for (let m = 40; m < 70; m++) renderPluck(48000, m);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `30 notes took ${ms.toFixed(0)} ms`);
});
