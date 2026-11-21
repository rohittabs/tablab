import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computePeaks, detectTempoAndOffset, mixToMono } from '../../js/audio/analysis.js';
import { renderPluck } from '../../js/audio/pluck.js';

const SR = 44100;

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 * 2 - 1;
  };
}

function addAt(out, at, src, gain = 1) {
  const start = Math.round(at * SR);
  for (let i = 0; i < src.length && start + i < out.length; i++) if (start + i >= 0) out[start + i] += src[i] * gain;
}

function kick() {
  const n = Math.round(SR * 0.25);
  const a = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 50 + 90 * Math.exp(-t / 0.03);
    ph += (2 * Math.PI * f) / SR;
    a[i] = Math.sin(ph) * Math.exp(-t / 0.12);
  }
  return a;
}

function noiseHit(len, decay, seed, lowpass = 0) {
  const r = rng(seed);
  const n = Math.round(SR * len);
  const a = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const v = r();
    lp = lowpass * lp + (1 - lowpass) * v;
    a[i] = (lowpass ? lp : v - lp * 0) * Math.exp(-i / SR / decay);
  }
  return a;
}

/** A drum groove with kick on 1 and 3, snare on 2 and 4, hats on eighths, quiet noise floor. */
function groove(bpm, offset, seconds) {
  const out = new Float32Array(Math.round(SR * seconds));
  const r = rng(7);
  for (let i = 0; i < out.length; i++) out[i] = r() * 0.002;
  const beat = 60 / bpm;
  const k = kick();
  const sn = noiseHit(0.18, 0.05, 3, 0.4);
  const hh = noiseHit(0.05, 0.01, 5);
  for (let t = offset, i = 0; t < seconds; t += beat / 2, i++) {
    addAt(out, t, hh, 0.15);
    if (i % 2 === 0) {
      const b = (i / 2) % 4;
      if (b === 0 || b === 2) addAt(out, t, k, 0.8);
      else addAt(out, t, sn, 0.5);
    }
  }
  return out;
}

/** Strummed chords made with the TabLab string synth, a chord every beat. */
function strums(bpm, offset, seconds) {
  const out = new Float32Array(Math.round(SR * seconds));
  const beat = 60 / bpm;
  const chords = [[48, 52, 55, 60, 64], [45, 52, 57, 60, 64], [41, 48, 53, 57, 60], [43, 47, 50, 55, 59]];
  const cache = new Map();
  const note = (m) => {
    if (!cache.has(m)) cache.set(m, renderPluck(SR, m, { seconds: 1.2 }).data);
    return cache.get(m);
  };
  let i = 0;
  for (let t = offset; t < seconds - 1; t += beat, i++) {
    const ch = chords[Math.floor(i / 4) % 4];
    ch.forEach((m, j) => addAt(out, t + j * 0.008, note(m), i % 4 === 0 ? 0.5 : 0.32));
  }
  return out;
}

test('waveform peaks', () => {
  const x = new Float32Array(SR);
  x[100] = 0.8;
  x[SR / 2] = -0.6;
  const p = computePeaks(x, SR, 100);
  assert.equal(p.min.length, 100);
  assert.ok(Math.abs(p.max[0] - 0.8) < 1e-6);
  assert.ok(Math.abs(p.min[50] + 0.6) < 1e-6);
  const stereo = mixToMono([new Float32Array([1, 1]), new Float32Array([0, -1])]);
  assert.deepEqual(Array.from(stereo), [0.5, 0]);
});

for (const [bpm, offset] of [[120, 0.8], [97, 1.37], [143, 0.25], [76, 2.1]]) {
  test(`detects a ${bpm} BPM groove starting at ${offset}s`, () => {
    const res = detectTempoAndOffset(groove(bpm, offset, 40), SR);
    assert.ok(res, 'got a result');
    assert.ok(Math.abs(res.bpm - bpm) < 0.15, `bpm ${res.bpm} vs ${bpm}`);
    assert.ok(Math.abs(res.offset - offset) < 0.02, `offset ${res.offset} vs ${offset}`);
  });
}

test('detects tempo of strummed chords', () => {
  const res = detectTempoAndOffset(strums(104, 0.6, 30), SR);
  assert.ok(res);
  assert.ok(Math.abs(res.bpm - 104) < 0.3, `bpm ${res.bpm}`);
  assert.ok(Math.abs(res.offset - 0.6) < 0.03, `offset ${res.offset}`);
});

test('silence gives no result', () => {
  assert.equal(detectTempoAndOffset(new Float32Array(SR * 10), SR), null);
});
