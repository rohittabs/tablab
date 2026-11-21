// Sound generation without samples: an extended Karplus-Strong plucked string
// (noise burst into a tuned, filtered delay loop) plus metronome clicks.
// Pure functions that return Float32Array data, so they can be tested outside a browser.

/** Deterministic pseudo-random numbers so every render of a pitch sounds the same. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Sound settings per instrument. T60 is the time for a note to fade by 60 dB. */
export const VOICES = {
  guitar: { t60: (f) => clamp(4.2 * Math.pow(110 / f, 0.5), 0.9, 7), maxSeconds: 4, brightness: 0.62, pickPosition: 0.13, gain: 0.9 },
  ukulele: { t60: (f) => clamp(2.0 * Math.pow(262 / f, 0.55), 0.6, 3.2), maxSeconds: 2.6, brightness: 0.5, pickPosition: 0.2, gain: 0.95 },
};

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Render one plucked note.
 * Returns { data: Float32Array, freq } where freq is the exact pitch of the render.
 * The loop uses an integer delay, a two-point averaging filter (half a sample of delay)
 * and a first-order allpass for the fractional part, so the pitch is accurate at all frequencies.
 */
export function renderPluck(sampleRate, midi, { voice = 'guitar', seconds } = {}) {
  const v = VOICES[voice] || VOICES.guitar;
  const f0 = midiToFreq(midi);
  const t60 = v.t60(f0);
  const length = Math.round(sampleRate * (seconds || Math.min(v.maxSeconds, t60 * 1.1 + 0.25)));
  const out = new Float32Array(length);

  const loopDelay = sampleRate / f0; // total loop delay in samples
  const filterDelay = 0.5; // two-point average
  let n = Math.floor(loopDelay - filterDelay - 0.2);
  if (n < 2) n = 2;
  const frac = loopDelay - filterDelay - n; // 0.2 .. 1.2, delivered by the allpass
  const apC = (1 - frac) / (1 + frac);

  // Loss per trip round the loop so the fundamental decays by 60 dB in t60 seconds.
  const w = (2 * Math.PI * f0) / sampleRate;
  const filterGain = Math.abs(Math.cos(w / 2));
  const perPeriod = Math.pow(10, -3 / (t60 * f0));
  const rho = Math.min(0.99995, perPeriod / Math.max(filterGain, 1e-6));

  // Excitation: noise, shaped by a one-pole lowpass (pick hardness) and a comb (pick position).
  const rand = rng(1000 + midi * 7919);
  const exc = new Float32Array(n);
  const b = 1 - v.brightness; // lowpass memory
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp = (1 - b) * rand() + b * lp;
    exc[i] = lp;
  }
  const pickOffset = Math.max(1, Math.round(n * v.pickPosition));
  const shaped = new Float32Array(n);
  for (let i = 0; i < n; i++) shaped[i] = exc[i] - (i >= pickOffset ? exc[i - pickOffset] : 0);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += shaped[i];
  mean /= n;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    shaped[i] -= mean;
    peak = Math.max(peak, Math.abs(shaped[i]));
  }
  const scale = peak > 0 ? 1 / peak : 1;

  // Delay loop.
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = shaped[i] * scale;
  let idx = 0;
  let prev = 0; // previous delay output, for the averaging filter
  let apX = 0; // allpass state
  let apY = 0;
  for (let i = 0; i < length; i++) {
    const x = buf[idx];
    const avg = 0.5 * (x + prev);
    prev = x;
    const y = apC * avg + apX - apC * apY; // first-order allpass
    apX = avg;
    apY = y;
    buf[idx] = y * rho;
    out[i] = x;
    idx++;
    if (idx === n) idx = 0;
  }

  // DC blocker, then fades so the buffer never starts or ends with a click.
  let xm1 = 0;
  let ym1 = 0;
  const R = 0.995;
  for (let i = 0; i < length; i++) {
    const x = out[i];
    const y = x - xm1 + R * ym1;
    xm1 = x;
    ym1 = y;
    out[i] = y;
  }
  const attack = Math.min(length, Math.round(sampleRate * 0.0015));
  for (let i = 0; i < attack; i++) out[i] *= i / attack;
  const tail = Math.min(length, Math.round(sampleRate * 0.06));
  for (let i = 0; i < tail; i++) out[length - 1 - i] *= i / tail;

  let max = 0;
  for (let i = 0; i < length; i++) max = Math.max(max, Math.abs(out[i]));
  const norm = max > 0 ? (0.5 * v.gain) / max : 1;
  for (let i = 0; i < length; i++) out[i] *= norm;
  return { data: out, freq: sampleRate / (n + filterDelay + frac) };
}

/** A short, muted "chk" for dead notes. */
export function renderDeadNote(sampleRate) {
  const length = Math.round(sampleRate * 0.09);
  const out = new Float32Array(length);
  const rand = rng(4242);
  // Band-limited noise: difference of two one-pole lowpasses, with a fast decay.
  let a = 0;
  let c = 0;
  for (let i = 0; i < length; i++) {
    const r = rand();
    a = 0.55 * r + 0.45 * a;
    c = 0.08 * r + 0.92 * c;
    const env = Math.exp(-i / (sampleRate * 0.012));
    out[i] = (a - c) * env;
  }
  let max = 0;
  for (let i = 0; i < length; i++) max = Math.max(max, Math.abs(out[i]));
  for (let i = 0; i < length; i++) out[i] *= 0.45 / (max || 1);
  return out;
}

/** Metronome click. accent: 2 = first beat of the bar, 1 = group start, 0 = other beats. */
export function renderClick(sampleRate, accent = 0) {
  const freq = accent === 2 ? 1760 : accent === 1 ? 1320 : 1100;
  const length = Math.round(sampleRate * 0.05);
  const out = new Float32Array(length);
  const rand = rng(99 + accent);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-t / 0.009);
    const tone = Math.sin(2 * Math.PI * freq * t) + 0.35 * Math.sin(2 * Math.PI * freq * 2.01 * t);
    const noise = i < sampleRate * 0.002 ? rand() * 0.6 : 0;
    out[i] = (tone * 0.75 + noise) * env;
  }
  const attack = Math.round(sampleRate * 0.0005);
  for (let i = 0; i < attack; i++) out[i] *= i / attack;
  let max = 0;
  for (let i = 0; i < length; i++) max = Math.max(max, Math.abs(out[i]));
  const level = accent === 2 ? 0.9 : accent === 1 ? 0.7 : 0.6;
  for (let i = 0; i < length; i++) out[i] *= level / (max || 1);
  return out;
}
