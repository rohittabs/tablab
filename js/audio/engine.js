// Playback engine: Web Audio graph, string voices, metronome, count-in, practice speed,
// and the backing track (an <audio> element routed through Web Audio).
//
// Timing model
//   "time" is seconds on the song timeline. Without a backing track, time 0 is the start of
//   bar 1. With a backing track, time is the position in the audio file (see SyncMap).
//   The transport maps AudioContext time R to song time:  time = A0 + (R - R0) * rate.
//   Notes and clicks are scheduled ahead on the AudioContext clock (lookahead scheduler).
//   When a backing track plays, the transport is re-anchored to the audio element whenever
//   they drift apart, so the recording stays the master clock.

import { renderClick, renderDeadNote, renderPluck } from './pluck.js';
import { computePeaks, detectTempoAndOffset, mixToMono } from './analysis.js';
import { buildEvents, measureAtTick, soundingPitch } from '../core/timing.js';

const LOOKAHEAD = 0.14; // seconds scheduled ahead
const INTERVAL_MS = 25;
const STRUM_STEP = 0.014; // seconds between strings in a strum

// While Chromium slows down or speeds up a recording (keeping its pitch), the sound comes out a
// little ahead of (slower) or behind (faster) the position that media.currentTime reports.
// Seconds by playback rate, measured by timing the clicks of a click track against the song
// clock (see tests/e2e/sync.test.mjs). Other browsers are not adjusted.
const CHROMIUM_STRETCH = [
  [0.25, -0.039], [0.3, -0.037], [0.35, -0.034], [0.4, -0.033], [0.45, -0.033], [0.5, -0.025],
  [0.55, -0.025], [0.6, -0.023], [0.65, -0.021], [0.7, -0.028], [0.75, -0.021], [0.8, -0.02],
  [0.85, -0.007], [0.9, -0.009], [0.95, -0.009], [1, 0], [1.05, 0.008], [1.1, 0.005],
  [1.15, 0.005], [1.2, 0.006], [1.25, 0.005], [1.3, 0.005], [1.35, 0.005], [1.4, 0.01],
  [1.45, 0.01], [1.5, 0.013],
];

const IS_CHROMIUM = (() => {
  try {
    const nav = globalThis.navigator;
    if (!nav) return false;
    if (nav.userAgentData && nav.userAgentData.brands) return nav.userAgentData.brands.some((b) => /Chromium/.test(b.brand));
    return /\bChrome\/\d+/.test(nav.userAgent) && !/\b(CriOS|FxiOS|EdgiOS)\b/.test(nav.userAgent);
  } catch (e) {
    return false;
  }
})();

/** Extra media offset at a playback rate, for the browser running this page. */
export function stretchOffset(rate, chromium = IS_CHROMIUM) {
  if (!chromium || rate === 1) return 0;
  const t = CHROMIUM_STRETCH;
  if (rate <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (rate <= t[i][0]) {
      const [r0, v0] = t[i - 1];
      const [r1, v1] = t[i];
      return v0 + ((v1 - v0) * (rate - r0)) / (r1 - r0);
    }
  }
  return t[t.length - 1][1];
}

function timerWorker() {
  try {
    const src = 'let id=null;onmessage=e=>{if(e.data==="start"){if(id===null)id=setInterval(()=>postMessage(0),' + INTERVAL_MS + ')}else{clearInterval(id);id=null}}';
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    return w;
  } catch (e) {
    return null;
  }
}

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.voice = 'guitar';
    this.buffers = new Map();
    this.volumes = { synth: 0.8, click: 0.7, track: 0.9 };
    this.synthOn = true;
    this.trackOn = true;
    this.metronome = false;
    this.state = 'stopped'; // stopped | starting | playing
    this.rate = 1;
    this.anchors = [];
    this.voices = new Map(); // string -> { src, gain, end }
    this.active = new Set();
    this.media = null;
    this.mediaNode = null;
    this.track = null; // { name, duration, peaks, mono22k }
    this.mediaLatency = 0; // media.currentTime minus the position heard at the same moment (extra, by hand)
    this.driftSamples = [];
    this._worker = null;
    this._interval = null;
    this._driftTimer = null;
    this._mediaStartTimer = null;
    this.debug = { scheduled: [], keep: false };
  }

  // ------------------------------------------------------------------ setup

  ensureContext() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) throw new Error('This browser does not support Web Audio.');
      const ctx = new AC({ latencyHint: 'interactive' });
      this.ctx = ctx;
      try {
        // Lets iOS play sound even when the ringer switch is on silent.
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch (e) {
        /* not supported */
      }
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.synthBus = ctx.createGain();
      const body = ctx.createBiquadFilter();
      body.type = 'peaking';
      body.frequency.value = 180;
      body.Q.value = 0.9;
      body.gain.value = 3;
      const air = ctx.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = 7500;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 3;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
      this.synthBus.connect(body);
      body.connect(air);
      air.connect(comp);
      comp.connect(this.master);
      this.clickBus = ctx.createGain();
      this.clickBus.connect(this.master);
      this.trackBus = ctx.createGain();
      this.trackBus.connect(this.master);
      this.clickBuffers = [0, 1, 2].map((a) => this._makeBuffer(renderClick(ctx.sampleRate, a)));
      this.deadBuffer = this._makeBuffer(renderDeadNote(ctx.sampleRate));
      this._applyVolumes();
      if (this.media && !this.mediaNode) this._routeMedia();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  _makeBuffer(data) {
    const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
    if (buf.copyToChannel) buf.copyToChannel(data, 0);
    else buf.getChannelData(0).set(data);
    return buf;
  }

  _applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.synthBus.gain.setTargetAtTime(this.synthOn ? this.volumes.synth : 0, t, 0.02);
    this.clickBus.gain.setTargetAtTime(this.volumes.click, t, 0.02);
    const tv = this.track && this.trackOn ? this.volumes.track : 0;
    if (this.mediaNode) this.trackBus.gain.setTargetAtTime(tv, t, 0.02);
    else if (this.media) this.media.volume = Math.min(1, tv);
  }

  setVolume(which, value) {
    this.volumes[which] = Math.max(0, Math.min(1.5, value));
    this._applyVolumes();
  }

  setSynthOn(on) {
    this.synthOn = !!on;
    this._applyVolumes();
  }

  setTrackOn(on) {
    this.trackOn = !!on;
    this._applyVolumes();
  }

  setVoice(instrument) {
    const v = instrument === 'ukulele' ? 'ukulele' : 'guitar';
    if (v !== this.voice) {
      this.voice = v;
      this.buffers.clear();
    }
  }

  _buffer(midi) {
    const key = midi;
    let b = this.buffers.get(key);
    if (!b) {
      const { data } = renderPluck(this.ctx.sampleRate, midi, { voice: this.voice });
      b = this._makeBuffer(data);
      this.buffers.set(key, b);
    }
    return b;
  }

  /** Render every pitch the song needs, so playback never waits on synthesis. */
  prepare(song) {
    this.ensureContext();
    this.setVoice(song.instrument);
    const pitches = new Set();
    for (const m of song.measures) for (const b of m.beats) for (const n of b.notes) if (!n.dead) pitches.add(soundingPitch(song, n));
    for (const p of pitches) this._buffer(p);
  }

  // ------------------------------------------------------------------ sounds

  _track(src) {
    this.active.add(src);
    src.onended = () => this.active.delete(src);
  }

  playClick(accent, when) {
    if (this.debug.keep) this.debug.scheduled.push({ when, click: accent });
    const src = this.ctx.createBufferSource();
    src.buffer = this.clickBuffers[accent] || this.clickBuffers[0];
    src.connect(this.clickBus);
    src.start(when);
    this._track(src);
  }

  /** Play one note event (from buildEvents) at AudioContext time `when` lasting `dur` seconds. */
  playNote(ev, when, dur) {
    const ctx = this.ctx;
    const prev = this.voices.get(ev.string);
    if (prev && prev.end + 0.2 > when) {
      try {
        prev.gain.gain.cancelScheduledValues(when);
        prev.gain.gain.setTargetAtTime(0, when, 0.01);
        prev.src.stop(when + 0.12);
      } catch (e) {
        /* already stopped */
      }
    }
    if (this.debug.keep) this.debug.scheduled.push({ when, midi: ev.midi, string: ev.string, dur });
    const g = ctx.createGain();
    g.connect(this.synthBus);
    if (ev.dead) {
      const src = ctx.createBufferSource();
      src.buffer = this.deadBuffer;
      src.playbackRate.value = 0.7 + (ev.midi % 24) / 40;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 0.8;
      src.connect(bp);
      bp.connect(g);
      g.gain.value = ev.velocity * 0.9;
      src.start(when);
      this._track(src);
      this.voices.set(ev.string, { src, gain: g, end: when + 0.09 });
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = this._buffer(ev.midi);
    let vel = ev.velocity * (ev.legato ? 0.55 : 1);
    if (ev.harmonic) vel *= 0.8;
    const attack = ev.legato ? 0.01 : 0.002;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vel, when + attack);
    let input = g;
    if (ev.muted || ev.harmonic) {
      const f = ctx.createBiquadFilter();
      if (ev.muted) {
        f.type = 'lowpass';
        f.frequency.value = 1100;
        f.Q.value = 0.6;
        g.gain.setTargetAtTime(0, when + 0.03, 0.06);
      } else {
        f.type = 'highpass';
        f.frequency.value = 700;
      }
      f.connect(g);
      input = f;
    }
    src.connect(input);
    const end = when + dur;
    if (!ev.muted) g.gain.setTargetAtTime(0, Math.max(when + attack, end - 0.01), 0.03);
    const rate = src.playbackRate;
    if (ev.bend) {
      const r = Math.pow(2, ev.bend / 12);
      const t = Math.min(0.3, dur * 0.45);
      rate.setValueAtTime(1, when + 0.02);
      rate.linearRampToValueAtTime(r, when + 0.02 + t);
    }
    if (ev.glideTo !== undefined) {
      const r = Math.pow(2, (ev.glideTo - ev.midi) / 12);
      const t0 = when + dur * 0.5;
      rate.setValueAtTime(ev.bend ? Math.pow(2, ev.bend / 12) : 1, t0);
      rate.linearRampToValueAtTime(r, when + dur * 0.96);
    }
    if (ev.vibrato) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.6;
      const depth = ctx.createGain();
      depth.gain.value = 0.011;
      lfo.connect(depth);
      depth.connect(rate);
      lfo.start(when + 0.06);
      lfo.stop(end + 0.3);
      this._track(lfo);
    }
    src.start(when);
    src.stop(end + 0.35);
    this._track(src);
    this.voices.set(ev.string, { src, gain: g, end });
  }

  /** Audition a single pitch right away (used while typing frets). */
  preview(midi, { velocity = 0.7, dur = 0.7 } = {}) {
    this.ensureContext();
    if (!this.synthOn && this.state !== 'stopped') return;
    const t = this.ctx.currentTime + 0.01;
    this.playNote({ string: 'preview', midi, velocity, legato: false }, t, dur);
  }

  _silenceAll(fade = 0.03) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const v of this.voices.values()) {
      try {
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setTargetAtTime(0, t, fade / 3);
      } catch (e) {
        /* ignore */
      }
    }
    for (const src of this.active) {
      try {
        src.stop(t + fade + 0.02);
      } catch (e) {
        /* ignore */
      }
    }
    this.active.clear();
    this.voices.clear();
  }

  // ------------------------------------------------------------------ transport

  _anchor() {
    return this.anchors[this.anchors.length - 1];
  }

  /** The anchor in force at AudioContext time R. */
  _anchorAt(R) {
    let a = this.anchors[0];
    for (const an of this.anchors) if (an.fromR <= R) a = an;
    return a;
  }

  /** Song time at AudioContext time R, using the anchor in force at R. */
  timeAt(R) {
    const a = this._anchorAt(R);
    if (!a) return 0;
    return a.A0 + (R - a.R0) * a.rate;
  }

  _ctxAt(t) {
    const a = this._anchor();
    return a.R0 + (t - a.A0) / a.rate;
  }

  _pushAnchor(R0, A0, rate, fromR = R0) {
    // Each anchor remembers the sync map in use when it was made, so the playhead for sound
    // that was scheduled before an edit still matches what is heard.
    this.anchors.push({ R0, A0, rate, fromR, map: this.map });
    if (this.anchors.length > 32) this.anchors.splice(0, this.anchors.length - 32);
  }

  /** AudioContext time of the sound reaching the speakers right now. */
  audibleTime() {
    const ctx = this.ctx;
    if (!ctx) return 0;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
        return ts.contextTime + Math.max(0, performance.now() - ts.performanceTime) / 1000;
      }
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  /**
   * Start playback.
   * opts: { song, timeline, map, startTick, loop: {startTick, endTick} | null, countInBars, speed }
   */
  async play(opts) {
    this.stop(true);
    const token = (this._token = (this._token || 0) + 1);
    this.state = 'starting';
    this.anchors = [];
    const { song, timeline, map } = opts;
    this.prepare(song);
    const ctx = this.ctx;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch (e) {
        /* ignore */
      }
    }
    if (token !== this._token) return;
    this.song = song;
    this.timeline = timeline;
    this.map = map;
    this.rate = opts.speed || this.rate;
    this.loop = opts.loop && opts.loop.endTick > opts.loop.startTick ? { ...opts.loop } : null;
    let startTick = opts.startTick || 0;
    if (this.loop && (startTick < this.loop.startTick || startTick >= this.loop.endTick)) startTick = this.loop.startTick;
    this.startTick = startTick;
    this.pastStart = false; // true once the count-in is over or the loop has wrapped
    this.scheduledTime = undefined;
    this._buildSchedule(this.loop ? this.loop.startTick : startTick);
    this.evIdx = 0;
    while (this.evIdx < this.events.length && this.events[this.evIdx].tick < startTick) this.evIdx++;
    this.startTime = map.tickToTime(startTick);

    // Count-in clicks before the start, at the local tempo, in the start bar's meter.
    this.countIn = [];
    const bars = opts.countInBars || 0;
    if (bars > 0) {
      const mt = timeline.measures[Math.min(timeline.measures.length - 1, this._measureIndex(startTick))];
      const unitTicks = (960 * 4) / mt.ts[1];
      const step = unitTicks * map.slopeAt(startTick);
      const n = bars * mt.ts[0];
      for (let k = n; k >= 1; k--) {
        const beatInBar = (n - k) % mt.ts[0];
        // Same accents as the metronome: bar start, and each group of three in 6/8, 9/8, 12/8.
        const compound = mt.ts[1] === 8 && mt.ts[0] % 3 === 0 && mt.ts[0] > 3;
        const accent = beatInBar === 0 ? 2 : compound && beatInBar % 3 === 0 ? 1 : 0;
        this.countIn.push({ time: this.startTime - k * step, accent, number: beatInBar + 1 });
      }
    }
    this.ciIdx = 0;
    const firstTime = this.countIn.length ? this.countIn[0].time : this.startTime;
    this.driftSamples = [];

    const useMedia = this.media && this.track && this.trackOn !== null && song.backingTrack;
    if (useMedia && firstTime >= 0 && firstTime < this.track.duration - 0.05) {
      const ok = await this._startMediaAt(firstTime, token);
      if (token !== this._token) return;
      if (ok) {
        const R = ctx.currentTime;
        this._pushAnchor(R, this.media.currentTime - this._latency(), this.rate);
      }
    }
    if (token !== this._token) return;
    let startMediaLater = false;
    if (!this.anchors.length) {
      this._pushAnchor(ctx.currentTime + 0.06, firstTime, this.rate);
      startMediaLater = useMedia && firstTime < 0;
    }
    this.state = 'playing';
    this._startTimers();
    if (startMediaLater) this._scheduleMediaStart(token);
    this._tick();
    this.dispatchEvent(new Event('play'));
  }

  _measureIndex(tick) {
    return measureAtTick(this.timeline, tick);
  }

  /** Events from `fromTick` to the end of the song (or of the loop), and the times they span. */
  _buildSchedule(fromTick) {
    this.endTick = this.loop ? this.loop.endTick : this.timeline.totalTicks;
    this.events = buildEvents(this.song, this.timeline, fromTick, this.endTick);
    this.endTime = this.map.tickToTime(this.endTick);
    this.loopStartTime = this.loop ? this.map.tickToTime(this.loop.startTick) : null;
  }

  /**
   * The song changed while it plays (a note, a tempo change, a moved bar line).
   * Rebuilds the notes still to come so playback carries on without stopping.
   * With a backing track the position in the recording is kept, because the recording is
   * the clock. Without one the musical position (bar and beat) is kept.
   * opts.loop is the loop range in the new ticks, or null.
   * Returns 'ok', or 'restart' when the caller should start again from the cursor.
   */
  retime(song, timeline, map, { keepTime = false, loop = null } = {}) {
    if (this.state === 'stopped') return 'ok';
    if (this.state !== 'playing' || this.scheduledTime === undefined) return 'restart';
    const done = this.scheduledTime; // events up to this song time have been sent to the speakers
    if (!this.pastStart && done < this.startTime) return 'restart'; // still counting in
    const newLoop = loop && loop.endTick > loop.startTick ? { ...loop } : null;
    if (!!newLoop !== !!this.loop) return 'restart';
    let doneNew = done;
    if (!keepTime) {
      // Same bar and offset in the new timeline.
      const oldTick = Math.max(0, Math.min(this.map.timeToTick(done), this.timeline.totalTicks));
      const m = measureAtTick(this.timeline, oldTick);
      if (m >= timeline.measures.length) return 'restart';
      const off = oldTick - this.timeline.measures[m].start;
      const tick = timeline.measures[m].start + Math.min(off, timeline.measures[m].length);
      doneNew = map.tickToTime(tick);
    }
    this.song = song;
    this.timeline = timeline;
    this.map = map;
    this.loop = newLoop;
    this.prepare(song);
    const fromTick = newLoop ? newLoop.startTick : Math.max(0, Math.floor(map.timeToTick(doneNew)) - 1);
    this._buildSchedule(fromTick);
    if (newLoop && (doneNew >= this.endTime || doneNew < this.loopStartTime - 0.001)) return 'restart';
    this.evIdx = 0;
    while (this.evIdx < this.events.length && map.tickToTime(this.events[this.evIdx].tick) <= doneNew + 1e-6) this.evIdx++;
    this.pastStart = true;
    this.countIn = [];
    this.ciIdx = 0;
    if (!keepTime) {
      // From the moment already scheduled, song time continues in the new timeline.
      this._pushAnchor(this.scheduledR, doneNew, this._anchor().rate, this.scheduledR);
      this.scheduledTime = doneNew;
    }
    return 'ok';
  }

  async _startMediaAt(time, token) {
    const media = this.media;
    try {
      media.playbackRate = this.rate;
      if (Math.abs(media.currentTime - time) > 0.002) {
        await new Promise((resolve) => {
          const done = () => {
            media.removeEventListener('seeked', done);
            resolve();
          };
          media.addEventListener('seeked', done);
          media.currentTime = time;
          setTimeout(done, 1500);
        });
      }
      if (token !== this._token) return false;
      await media.play();
      // Wait until the playback position actually moves.
      const t0 = media.currentTime;
      const deadline = performance.now() + 1500;
      while (media.currentTime <= t0 + 0.0005 && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4));
        if (token !== this._token) return false;
      }
      return true;
    } catch (e) {
      this.dispatchEvent(new CustomEvent('error', { detail: 'The backing track could not start: ' + e.message }));
      return false;
    }
  }

  /** When playback starts before the audio file does, start the file when time reaches 0. */
  _scheduleMediaStart(token) {
    const ctx = this.ctx;
    const R = this._ctxAt(0);
    const wait = Math.max(0, (R - ctx.currentTime) * 1000 - 30);
    clearTimeout(this._mediaStartTimer);
    this._mediaStartTimer = setTimeout(async () => {
      if (token !== this._token || this.state !== 'playing') return;
      const media = this.media;
      try {
        media.playbackRate = this.rate;
        media.currentTime = 0;
        await media.play();
        // Wait until the recording really moves, then lock the song clock to it.
        const t0 = media.currentTime;
        const deadline = performance.now() + 1500;
        while (media.currentTime <= t0 + 0.0005 && performance.now() < deadline) {
          await new Promise((r) => setTimeout(r, 4));
          if (token !== this._token) return;
        }
        if (token !== this._token || this.state !== 'playing') return;
        const now = this.ctx.currentTime;
        const heard = media.currentTime - this._latency();
        if (Math.abs(heard - this.timeAt(now)) > 0.008) {
          this._pushAnchor(now, heard, this.rate, now);
          this.driftSamples = [];
        }
      } catch (e) {
        /* the drift check handles a late start */
      }
    }, wait);
  }

  _startTimers() {
    this._stopTimers();
    if (!this._worker) this._worker = timerWorker();
    if (this._worker) {
      this._worker.onmessage = () => this._tick();
      this._worker.postMessage('start');
    } else {
      this._interval = setInterval(() => this._tick(), INTERVAL_MS);
    }
    this._driftTimer = setInterval(() => this._checkDrift(), 200);
  }

  _stopTimers() {
    if (this._worker) this._worker.postMessage('stop');
    clearInterval(this._interval);
    clearInterval(this._driftTimer);
    clearTimeout(this._mediaStartTimer);
    this._interval = null;
    this._driftTimer = null;
  }

  _tick() {
    if (this.state !== 'playing') return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const horizon = now + LOOKAHEAD;
    const a = this._anchor();
    const horizonTime = a.A0 + (horizon - a.R0) * a.rate;
    while (this.ciIdx < this.countIn.length && this.countIn[this.ciIdx].time <= horizonTime) {
      const c = this.countIn[this.ciIdx++];
      const when = this._ctxAt(c.time);
      if (when >= now - 0.02) this.playClick(c.accent, Math.max(now, when));
    }
    while (this.evIdx < this.events.length) {
      const ev = this.events[this.evIdx];
      const t = this.map.tickToTime(ev.tick);
      if (t > horizonTime) break;
      this.evIdx++;
      const when = this._ctxAt(t);
      if (when < now - 0.05) continue; // too late, skip rather than flam
      const at = Math.max(now, when);
      if (ev.kind === 'click') {
        if (this.metronome) this.playClick(ev.accent, at);
      } else if (this.synthOn) {
        const endT = this.map.tickToTime(ev.tick + ev.ticks);
        const dur = Math.max(0.05, (endT - t) / a.rate);
        for (const n of ev.notes) this.playNote(n, at + n.strumIndex * STRUM_STEP, Math.max(0.05, dur - n.strumIndex * STRUM_STEP));
      }
    }
    this.scheduledTime = horizonTime;
    this.scheduledR = horizon;
    if (this.evIdx >= this.events.length && horizonTime >= this.endTime) {
      if (this.loop) this._wrapLoop();
      else if (this.timeAt(this.audibleTime()) >= this.endTime + 0.1) {
        this.stop();
        this.dispatchEvent(new Event('ended'));
      }
    }
  }

  _wrapLoop() {
    // The loop end leads straight into the loop start: re-anchor so it follows seamlessly.
    const Rwrap = this._ctxAt(this.endTime);
    this._pushAnchor(Rwrap, this.loopStartTime, this.rate, Rwrap);
    this.evIdx = 0;
    this.countIn = [];
    this.ciIdx = 0;
    this.pastStart = true;
    this.scheduledTime = this.loopStartTime - 1e-6;
    this.scheduledR = Rwrap;
    this.driftSamples = [];
    if (this.media && this.track && this.song.backingTrack) {
      const token = this._token;
      const wait = Math.max(0, (Rwrap - this.ctx.currentTime) * 1000);
      clearTimeout(this._mediaStartTimer);
      this._mediaStartTimer = setTimeout(() => {
        if (token !== this._token || this.state !== 'playing') return;
        const target = this.loopStartTime;
        if (target >= 0 && target < this.track.duration) {
          this.media.currentTime = target + this._latency();
          if (this.media.paused) this.media.play().catch(() => {});
        }
      }, wait);
    }
    this.dispatchEvent(new Event('loop'));
  }

  /** Keep the transport locked to the backing track when it is playing. */
  _checkDrift() {
    const media = this.media;
    if (this.state !== 'playing' || !media || media.paused || media.seeking || !this.song || !this.song.backingTrack) return;
    const R = this.ctx.currentTime;
    const a = this._anchor();
    if (R < a.fromR + 0.15) return; // just re-anchored or wrapped
    const expected = a.A0 + (R - a.R0) * a.rate;
    if (expected < 0) return;
    const drift = media.currentTime - this._latency() - expected;
    this.driftSamples.push(drift);
    if (this.driftSamples.length > 5) this.driftSamples.shift();
    if (this.driftSamples.length < 3) return;
    const sorted = this.driftSamples.slice().sort((x, y) => x - y);
    const med = sorted[Math.floor(sorted.length / 2)];
    if (Math.abs(med) > 0.025) {
      // Move the transport, not the audio: the recording keeps playing smoothly.
      this._pushAnchor(R, expected + med, a.rate, R);
      this.driftSamples = [];
      this.dispatchEvent(new CustomEvent('resync', { detail: med }));
    }
  }

  setSpeed(rate) {
    const before = this._latency();
    this.rate = rate;
    if (this.media) this.media.playbackRate = rate;
    if (this.state !== 'playing') return;
    const R = this.ctx.currentTime + LOOKAHEAD;
    let t = this.timeAt(R);
    // With the recording playing, follow the small shift in what is heard at the new speed.
    if (this.media && !this.media.paused && this.song && this.song.backingTrack) t -= this._latency() - before;
    this._pushAnchor(R, t, rate, R);
    this.driftSamples = [];
  }

  /** media.currentTime minus the position in the recording that is heard right now. */
  _latency() {
    return this.mediaLatency + stretchOffset(this.rate);
  }

  stop(silent = false) {
    this._token = (this._token || 0) + 1;
    const wasPlaying = this.state !== 'stopped';
    let pos = null;
    if (wasPlaying && this.ctx && this.anchors.length) pos = this.position();
    this.state = 'stopped';
    this._stopTimers();
    this._silenceAll();
    if (this.media && !this.media.paused) this.media.pause();
    if (wasPlaying && !silent) this.dispatchEvent(new CustomEvent('stop', { detail: pos }));
    return pos;
  }

  /** Where the listener is right now: { time, tick, countIn: beat number or 0, inCountIn }. */
  position() {
    if (this.state === 'stopped' || !this.anchors.length || !this.map) return null;
    const R = this.audibleTime();
    const a = this._anchorAt(R);
    const time = a.A0 + (R - a.R0) * a.rate;
    const inCountIn = !this.pastStart && time < this.startTime;
    let countIn = 0;
    if (inCountIn && this.countIn.length) {
      for (const c of this.countIn) if (c.time <= time + 0.001) countIn = c.number;
      if (time < this.countIn[0].time) countIn = 0;
    }
    let tick = (a.map || this.map).timeToTick(time);
    if (inCountIn) tick = this.startTick;
    if (tick > this.endTick) tick = this.endTick;
    if (tick < 0) tick = 0;
    return { time, tick, countIn, inCountIn };
  }

  isPlaying() {
    return this.state !== 'stopped';
  }

  // ------------------------------------------------------------------ backing track

  _routeMedia() {
    if (!this.ctx || !this.media || this.mediaNode) return;
    try {
      this.mediaNode = this.ctx.createMediaElementSource(this.media);
      this.mediaNode.connect(this.trackBus);
    } catch (e) {
      this.mediaNode = null; // falls back to the element's own output
    }
    this._applyVolumes();
  }

  /** Load an audio file (File or Blob). Resolves to { name, duration, peaks }. */
  async loadTrack(blob, name) {
    this.ensureContext();
    this.unloadTrack();
    const url = URL.createObjectURL(blob);
    const media = new Audio();
    media.preload = 'auto';
    media.crossOrigin = 'anonymous';
    if ('preservesPitch' in media) media.preservesPitch = true;
    if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = true;
    if ('mozPreservesPitch' in media) media.mozPreservesPitch = true;
    media.src = url;
    await new Promise((resolve, reject) => {
      const ok = () => {
        cleanup();
        resolve();
      };
      const bad = () => {
        cleanup();
        reject(new Error('This audio file cannot be played by your browser. Try MP3, M4A, WAV or OGG.'));
      };
      const cleanup = () => {
        media.removeEventListener('loadedmetadata', ok);
        media.removeEventListener('error', bad);
      };
      media.addEventListener('loadedmetadata', ok);
      media.addEventListener('error', bad);
    });
    this.media = media;
    this.mediaUrl = url;
    this._routeMedia();
    media.playbackRate = this.rate;
    let peaks = null;
    let mono22k = null;
    let duration = media.duration;
    try {
      const data = await blob.arrayBuffer();
      const audio = await new Promise((resolve, reject) => {
        const p = this.ctx.decodeAudioData(data, resolve, reject);
        if (p && p.then) p.then(resolve, reject);
      });
      const channels = [];
      for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
      const mono = mixToMono(channels);
      peaks = computePeaks(mono, audio.sampleRate, 200);
      // Keep a 22 kHz copy for tempo detection.
      const factor = Math.max(1, Math.round(audio.sampleRate / 22050));
      mono22k = new Float32Array(Math.floor(mono.length / factor));
      for (let i = 0; i < mono22k.length; i++) {
        let s = 0;
        for (let k = 0; k < factor; k++) s += mono[i * factor + k];
        mono22k[i] = s / factor;
      }
      this.track = { name, duration: Number.isFinite(duration) ? duration : audio.duration, peaks, mono: mono22k, monoRate: audio.sampleRate / factor };
    } catch (e) {
      this.track = { name, duration, peaks: null, mono: null, monoRate: 0 };
    }
    this._applyVolumes();
    return this.track;
  }

  unloadTrack() {
    if (this.state !== 'stopped') this.stop();
    if (this.mediaNode) {
      try {
        this.mediaNode.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    if (this.media) {
      this.media.pause();
      this.media.removeAttribute('src');
      this.media.load();
    }
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
    this.media = null;
    this.mediaNode = null;
    this.mediaUrl = null;
    this.track = null;
  }

  /** Suggest tempo and bar 1 position for the loaded track. */
  detectSync() {
    if (!this.track || !this.track.mono) return null;
    return detectTempoAndOffset(this.track.mono, this.track.monoRate);
  }

  /** Play just the backing track from a time (for checking sync in the waveform panel). */
  trackTime() {
    return this.media ? this.media.currentTime : 0;
  }
}
