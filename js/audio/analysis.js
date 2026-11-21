// Audio analysis for backing tracks: waveform peaks for drawing, and a simple
// tempo + start detector so syncing can be one click for steady recordings.
// Pure functions on Float32Array data (no Web Audio), so they run in tests too.

/** Mix channels to mono. */
export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

/** Min/max peaks at `rate` columns per second for drawing a waveform. */
export function computePeaks(mono, sampleRate, rate = 200) {
  const step = sampleRate / rate;
  const count = Math.max(1, Math.ceil(mono.length / step));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  for (let c = 0; c < count; c++) {
    const a = Math.floor(c * step);
    const b = Math.min(mono.length, Math.floor((c + 1) * step));
    let lo = 0;
    let hi = 0;
    for (let i = a; i < b; i++) {
      const v = mono[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[c] = lo;
    max[c] = hi;
  }
  return { min, max, rate };
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Onset strength envelope (log spectral flux) at about 86 frames per second.
 * Returns { env: Float32Array, rate }.
 */
export function onsetEnvelope(mono, sampleRate) {
  const factor = Math.max(1, Math.round(sampleRate / 11025));
  const sr = sampleRate / factor;
  const n = Math.floor(mono.length / factor);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += mono[i * factor + k];
    x[i] = s / factor;
  }
  const size = 512;
  const hop = 128;
  const frames = Math.max(0, Math.floor((n - size) / hop) + 1);
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  const bins = size / 2;
  let prevMag = new Float32Array(bins);
  let mag = new Float32Array(bins);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const flux = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < size; i++) {
      re[i] = x[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let sum = 0;
    for (let k = 1; k < bins; k++) {
      const m = Math.log1p(100 * Math.hypot(re[k], im[k]));
      mag[k] = m;
      const d = m - prevMag[k];
      if (d > 0) sum += d;
    }
    flux[f] = f === 0 ? 0 : sum;
    const t = prevMag;
    prevMag = mag;
    mag = t;
  }
  // Remove the slowly varying part and keep positive peaks.
  const rate = sr / hop;
  const w = Math.max(1, Math.round(rate * 0.25));
  const env = new Float32Array(frames);
  let acc = 0;
  const pre = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) {
    acc += flux[i];
    pre[i + 1] = acc;
  }
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(frames, i + w + 1);
    const mean = (pre[b] - pre[a]) / (b - a);
    env[i] = Math.max(0, flux[i] - mean);
  }
  // An attack shows up in the first frame whose window reaches it, about one hop before the
  // window end, so frame times are shifted by (size - hop) to line up with the audio.
  return { env, rate, latency: (size - hop) / sr };
}

/** Strength of a steady pulse at `bpm`: magnitude and phase of the envelope's Fourier coefficient. */
function pulse(env, rate, bpm) {
  const w = (2 * Math.PI * bpm) / 60 / rate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < env.length; i++) {
    re += env[i] * Math.cos(w * i);
    im -= env[i] * Math.sin(w * i);
  }
  return { mag: Math.hypot(re, im), phase: Math.atan2(im, re) };
}

/**
 * Estimate the tempo (quarter notes per minute) of a steady recording.
 * Coarse search by autocorrelation with a mild preference around 110 BPM, then
 * a fine search on the Fourier tempogram for precision.
 */
export function estimateTempo(env, rate, { minBpm = 55, maxBpm = 210 } = {}) {
  const n = env.length;
  if (n < rate * 4) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = env[i] - mean;
  const minLag = Math.floor((rate * 60) / maxBpm);
  const maxLag = Math.ceil((rate * 60) / minBpm);
  const ac = new Float64Array(maxLag * 2 + 2);
  for (let lag = 1; lag < ac.length && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += e[i] * e[i + lag];
    ac[lag] = s / (n - lag);
  }
  let best = null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (!(ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1])) continue;
    const a = ac[lag - 1];
    const b = ac[lag];
    const c = ac[lag + 1];
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const l = lag + shift;
    const bpm = (60 * rate) / l;
    const twice = 2 * lag < ac.length - 1 ? Math.max(0, ac[2 * lag]) : 0;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 1.0, 2));
    const score = (b + 0.5 * twice) * prior;
    if (!best || score > best.score) best = { bpm, score };
  }
  if (!best || best.score <= 0) return null;
  // Fine search.
  let fine = { bpm: best.bpm, mag: -1, phase: 0 };
  for (let d = -3; d <= 3; d += 0.02) {
    const bpm = best.bpm * (1 + d / 100);
    const p = pulse(env, rate, bpm);
    if (p.mag > fine.mag) fine = { bpm, mag: p.mag, phase: p.phase };
  }
  let total = 0;
  for (let i = 0; i < n; i++) total += env[i];
  return { bpm: fine.bpm, confidence: total > 0 ? Math.min(1, fine.mag / total) : 0 };
}

/**
 * Sharp onsets near predicted beat times, found on a 0.5 ms grid in the time domain.
 * Returns [{ k, t, strength }] for beats k = 0..count-1 at t0 + k * period (seconds).
 */
function transientsNearBeats(mono, sampleRate, t0, period, count) {
  // Energy of the first difference (a high-pass that favours attacks), via a prefix sum.
  const n = mono.length;
  const pre = new Float64Array(n + 1);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const d = mono[i] - prev;
    prev = mono[i];
    pre[i + 1] = pre[i] + d * d;
  }
  const half = Math.round(sampleRate * 0.0015); // 3 ms window
  const lag = Math.round(sampleRate * 0.006);
  const amp = (i) => {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half);
    return b > a ? Math.sqrt((pre[b] - pre[a]) / (b - a)) : 0;
  };
  const step = Math.max(1, Math.round(sampleRate * 0.0005));
  const reach = Math.round(sampleRate * period * 0.12);
  const out = [];
  for (let k = 0; k < count; k++) {
    const c = Math.round((t0 + k * period) * sampleRate);
    let best = -1;
    let bestI = c;
    for (let i = c - reach; i <= c + reach; i += step) {
      if (i - lag < 0 || i >= n) continue;
      const rise = amp(i) - amp(i - lag);
      if (rise > best) {
        best = rise;
        bestI = i;
      }
    }
    if (best > 0) out.push({ k, t: (bestI - half) / sampleRate, strength: best });
  }
  return out;
}

/** Least squares line t = a + b k through the points, ignoring outliers. */
function robustBeatFit(points, a0, b0) {
  let b = b0;
  // Start from the median offset between the grid and the attacks, so a coarse grid that
  // is off by tens of milliseconds still locks on.
  const res = points.map((p) => p.t - (a0 + b0 * p.k)).sort((x, y) => x - y);
  let a = a0 + (res.length ? res[Math.floor(res.length / 2)] : 0);
  for (const tol of [0.04, 0.025, 0.015, 0.01]) {
    const keep = points.filter((p) => Math.abs(p.t - (a + b * p.k)) < tol);
    if (keep.length < 8) break;
    let sk = 0;
    let st = 0;
    let skk = 0;
    let skt = 0;
    for (const p of keep) {
      sk += p.k;
      st += p.t;
      skk += p.k * p.k;
      skt += p.k * p.t;
    }
    const m = keep.length;
    const den = m * skk - sk * sk;
    if (den === 0) break;
    b = (m * skt - sk * st) / den;
    a = (st - b * sk) / m;
  }
  return { a, b };
}

/**
 * Detect tempo and where bar 1 starts.
 * 1. Tempo and beat phase from the onset envelope of the whole recording.
 * 2. The beat grid is snapped to the actual attacks (sub-millisecond search near each beat),
 *    and a straight-line fit through them gives a precise tempo and start.
 * Bar 1 is placed on the first beat at or just before the music starts.
 */
export function detectTempoAndOffset(mono, sampleRate) {
  const { env, rate, latency } = onsetEnvelope(mono, sampleRate);
  const tempo = estimateTempo(env, rate);
  if (!tempo) return null;
  let bpm = tempo.bpm;
  const periodFrames = (60 / bpm) * rate;
  const { phase } = pulse(env, rate, bpm);
  const w = (2 * Math.PI) / periodFrames;
  let first = (-phase / w) % periodFrames;
  if (first < 0) first += periodFrames;
  let t0 = first / rate + latency;
  let period = 60 / bpm;
  // Refine against the attacks in the audio itself.
  const count = Math.floor((mono.length / sampleRate - t0) / period);
  if (count >= 8) {
    const pts = transientsNearBeats(mono, sampleRate, t0, period, count);
    if (pts.length >= 8) {
      const strengths = pts.map((p) => p.strength).sort((x, y) => x - y);
      const floor = strengths[Math.floor(strengths.length * 0.5)] * 0.3;
      const fit = robustBeatFit(pts.filter((p) => p.strength >= floor), t0, period);
      if (fit.b > period * 0.97 && fit.b < period * 1.03) {
        t0 = fit.a;
        period = fit.b;
        bpm = 60 / period;
      }
    }
  }
  // Where does the music start? First envelope frame above 25% of a robust maximum.
  const sorted = Array.from(env).sort((a, b) => a - b);
  const robustMax = sorted[Math.floor(sorted.length * 0.995)] || 0;
  let start = 0;
  for (let i = 0; i < env.length; i++) {
    if (env[i] > robustMax * 0.25) {
      start = i / rate + latency;
      break;
    }
  }
  let k = Math.ceil((start - t0 - 0.35 * period) / period);
  if (t0 + k * period < 0) k = Math.ceil(-t0 / period);
  const offset = t0 + k * period;
  return { bpm: Math.round(bpm * 100) / 100, offset: Math.max(0, Math.round(offset * 1000) / 1000), confidence: tempo.confidence };
}
