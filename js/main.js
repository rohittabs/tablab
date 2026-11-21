// TabLab app: wires the editor, renderer, audio engine and backing track panel to the page.

import { INSTRUMENTS, KEYS, MAX_SPEED, MAX_TEMPO, MIN_SPEED, MIN_TEMPO, TS_DENOMINATORS, TS_NUMERATORS, TUNING_RANGE, keyName, matchTuning, noteName, noteNameOctave, stringLabels } from './core/constants.js';
import { createSong, effectiveTimeSignature, measureCapacity, measureContentTicks, normalizeSong, noteAt, uid } from './core/model.js';
import { SyncMap, buildTimeline, comparePos, locateTick } from './core/timing.js';
import { describeDuration, songToText } from './core/textTab.js';
import { Editor } from './ui/editor.js';
import { LS, findBeat, hitTest, layoutScore, renderSystem } from './ui/render.js';
import { AudioEngine } from './audio/engine.js';
import { SyncPanel } from './ui/syncPanel.js';
import { ICONS } from './ui/icons.js';
import * as store from './ui/storage.js';
import { SHORTCUTS } from './ui/shortcuts.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const EXAMPLES = [
  { file: 'examples/first-steps.tablab', title: 'First Steps', meta: 'Guitar · easy melody with hammer-ons, slides and a bend' },
  { file: 'examples/campfire-strum.tablab', title: 'Campfire Strum', meta: 'Ukulele · C Am F G strumming pattern' },
  { file: 'examples/power-chord-riff.tablab', title: 'Power Chord Riff', meta: 'Guitar · palm muting and dead notes' },
];

const prefs = store.loadPrefs({
  theme: null,
  speed: 1,
  metronome: false,
  countIn: 1,
  volumes: { synth: 0.8, click: 0.7, track: 0.9 },
  synthOn: true,
  preview: true,
  keypad: null,
  syncOpen: false,
  notation: false, // show standard notation above the tab
});

const engine = new AudioEngine();
const editor = new Editor(createSong());
let timeline = buildTimeline(editor.song);
let map = new SyncMap(editor.song, timeline);
let layout = null;
let loopOn = false;
let renderQueued = false;
let saveTimer = 0;
let rafId = 0;
let playhead = null; // { el, sys }
let lastPlayBeat = null;
let syncPanel = null;
let panelTime = null; // playhead in the waveform while stopped
let storageWarned = false;
let pendingDragCommit = false;
let activeLoop = null; // the beats being looped while playing
let playStart = null; // the beat where playback started
const tap = { times: [], committed: false };
let printing = false; // true while the browser lays the page out for printing

// Apple keyboards use Cmd where others use Ctrl; both work, the labels follow the platform.
const APPLE = /mac|iphone|ipad|ipod/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '');
const MOD = APPLE ? 'Cmd' : 'Ctrl';
const TOUCH = window.matchMedia('(pointer: coarse)').matches;
const PRINT_WIDTH = 700; // CSS pixels across a portrait A4 or Letter page with 12 mm margins

// ------------------------------------------------------------------ helpers

function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function savePrefs() {
  store.savePrefs(prefs);
}

function fillIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.innerHTML = ICONS[el.dataset.icon] || '';
}

function setIcon(el, name) {
  el.dataset.icon = name;
  el.innerHTML = ICONS[name] || '';
}

function fmtTime(s) {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function focusScore() {
  $('#score').focus({ preventScroll: true });
}

// ------------------------------------------------------------------ song lifecycle

function setSong(song, { message } = {}) {
  if (saveTimer) saveNow(); // keep the last edits of the song being closed
  stopPlayback();
  engine.unloadTrack();
  editor.setSong(song);
  editor.cursor = { m: 0, b: 0, s: Math.min(editor.cursor.s, song.tuning.length - 1) };
  engine.setVoice(song.instrument);
  songChanged({ save: true });
  updateSyncUI();
  if (song.backingTrack) restoreTrack(song);
  if (message) toast(message);
}

/**
 * Call after every change to the song. `render: false` skips redrawing the tab, for changes
 * that only move it in time (tempo, bar 1 position, pinned bars).
 */
function songChanged({ save = true, retime = true, render = true } = {}) {
  timeline = buildTimeline(editor.song);
  map = new SyncMap(editor.song, timeline);
  engine.setVoice(editor.song.instrument);
  if (render) queueRender();
  else updateOverlay();
  updateHeader();
  updateToolbar();
  if (save) queueSave();
  if (retime && engine.isPlaying()) {
    const pos = engine.position();
    const keepTime = !!(editor.song.backingTrack && engine.track);
    const res = engine.retime(editor.song, timeline, map, { keepTime, loop: activeLoop ? rangeTicks(activeLoop) : null });
    if (res !== 'ok') {
      // Start again from the cursor; repeat the count-in if it was still counting.
      stopPlayback();
      startPlayback(cursorTick(), { countIn: pos && pos.inCountIn ? prefs.countIn : 0 });
    }
  }
  updateSyncUI();
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const ok = store.saveSong(editor.song);
  if (!ok && !storageWarned) {
    storageWarned = true;
    toast('This browser has no room left to keep your song. Use Save to download it as a file.', 6000);
  }
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 350);
}

editor.onChange = (kind) => {
  if (kind === 'cursor') {
    updateOverlay();
    updateToolbar();
    scrollToCursor();
    return;
  }
  songChanged();
};

async function restoreTrack(song) {
  try {
    const rec = await store.loadTrack(song.id);
    if (!rec || !rec.blob || editor.song.id !== song.id) {
      updateSyncUI();
      return;
    }
    await engine.loadTrack(rec.blob, rec.name || song.backingTrack.fileName);
    if (editor.song.id !== song.id) return;
    engine.setVolume('track', song.backingTrack.volume ?? prefs.volumes.track);
    updateSyncUI();
    if (syncPanel) syncPanel.fit();
  } catch (e) {
    updateSyncUI();
  }
}

// ------------------------------------------------------------------ rendering

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderScore();
  });
}

function renderScore() {
  const container = $('#systems');
  const width = printing ? PRINT_WIDTH : container.clientWidth || 800;
  layout = layoutScore(editor.song, timeline, width, { notation: prefs.notation });
  container.innerHTML = layout.systems.map((sys) => renderSystem(editor.song, timeline, layout, sys)).join('');
  playhead = null;
  updateOverlay();
  $('#print-title').textContent = editor.song.title;
  $('#print-sub').textContent = songSummary(true);
}

function systemSvg(index) {
  return $('#systems').children[index] || null;
}

function rect(x, y, w, h, cls, extra = '') {
  return `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${h.toFixed(1)}" ${extra}/>`;
}

function beatBand(loc, cls) {
  const { sys, pos } = loc;
  // In the notation view the band covers the notation staff too.
  const top = sys.notaTop !== null && sys.notaTop !== undefined ? sys.notaTop - 6 : sys.staffTop - 9;
  return rect(pos.left, top, pos.right - pos.left, sys.staffBottom + 9 - top, cls, 'rx="4"');
}

/** Cursor, selection and loop range, drawn on top of the tab. */
function updateOverlay() {
  if (!layout) return;
  const parts = new Map();
  const add = (sysIndex, s) => parts.set(sysIndex, (parts.get(sysIndex) || '') + s);
  const each = (start, end, fn) => {
    for (let m = start.m; m <= end.m; m++) {
      const beats = editor.song.measures[m].beats;
      const b0 = m === start.m ? start.b : 0;
      const b1 = m === end.m ? end.b : beats.length - 1;
      for (let b = b0; b <= b1; b++) {
        const loc = findBeat(layout, m, b);
        if (loc) fn(loc);
      }
    }
  };
  if (loopOn) {
    const lr = clampRange(loopBeats());
    each(lr.start, lr.end, (loc) => add(loc.sys.index, beatBand(loc, 'tl-loop')));
  }
  if (editor.hasSelection()) {
    const sel = editor.selection();
    each(sel.start, sel.end, (loc) => add(loc.sys.index, beatBand(loc, 'tl-sel')));
  }
  const c = editor.cursor;
  const loc = findBeat(layout, c.m, c.b);
  if (loc) {
    add(loc.sys.index, beatBand(loc, 'tl-cursor-beat'));
    const y = loc.sys.staffTop + c.s * LS;
    const note = noteAt(editor.beat(), c.s);
    const w = note ? Math.max(20, String(note.fret).length * 7 + 12) : 20;
    const pending = editor.pending && editor.pending.m === c.m && editor.pending.b === c.b && editor.pending.s === c.s;
    add(loc.sys.index, rect(loc.pos.x - w / 2, y - 8.5, w, 17, 'tl-cursor-note' + (pending ? ' pending' : ''), 'rx="5"'));
  }
  layout.systems.forEach((sys) => {
    const svg = systemSvg(sys.index);
    if (!svg) return;
    const over = svg.querySelector('.tl-over');
    const html = parts.get(sys.index) || '';
    if (over.innerHTML !== html) over.innerHTML = html;
  });
  if (playhead && playhead.el && !playhead.el.isConnected) playhead = null;
}

function scrollToCursor() {
  if (!layout) return;
  const loc = findBeat(layout, editor.cursor.m, editor.cursor.b);
  if (loc) scrollSystemIntoView(loc.sys.index);
}

function scrollSystemIntoView(index) {
  const svg = systemSvg(index);
  if (!svg) return;
  const score = $('#score');
  const box = score.getBoundingClientRect();
  const top = svg.getBoundingClientRect().top - box.top + score.scrollTop;
  const h = svg.getBoundingClientRect().height;
  // The on-screen number pad floats over the bottom of the score, so count only the part above it.
  const pad = $('#keypad').getBoundingClientRect();
  const covered = pad.height ? Math.max(0, box.bottom - pad.top) : 0;
  const viewH = Math.max(120, score.clientHeight - covered);
  if (top < score.scrollTop + 8) score.scrollTop = Math.max(0, top - 40);
  else if (top + h > score.scrollTop + viewH - 8) score.scrollTop = Math.min(top - 8, top + h - viewH + 40);
}

function songSummary(long = false) {
  const s = editor.song;
  const inst = INSTRUMENTS[s.instrument].name;
  const preset = matchTuning(s.instrument, s.tuning);
  const custom = s.tuning.map(noteName).reverse().join(' ');
  const tuning = preset ? (long ? preset.name : preset.name.replace(/\s*\(.*\)$/, '')) : long ? `Custom tuning (${custom})` : custom;
  const ts = s.timeSignature;
  const parts = [inst, tuning];
  if (s.capo) parts.push(`Capo ${s.capo}`);
  if (s.key) {
    const k = KEYS.find((x) => x.key === s.key);
    parts.push(long ? `Key of ${keyName(s.key, { long: false })}` : `Key ${k.major}/${k.minor}m`);
  }
  parts.push(`${ts[0]}/${ts[1]}`, `${Math.round(s.tempo)} BPM`);
  if (long && s.artist) parts.unshift(s.artist);
  return parts.join(' · ');
}

function updateHeader() {
  const s = editor.song;
  const title = $('#song-title');
  if (document.activeElement !== title) title.value = s.title;
  $('#btn-song').textContent = songSummary();
  document.title = `${s.title} · TabLab`;
  const tempo = $('#in-tempo');
  if (document.activeElement !== tempo) tempo.value = Math.round(s.tempo * 100) / 100;
  updateSpeedLabel();
}

function updateToolbar() {
  const beat = editor.beat();
  const note = noteAt(beat, editor.cursor.s);
  for (const btn of $$('.tool.dur')) btn.classList.toggle('active', Number(btn.dataset.dur) === beat.duration);
  const pressed = {
    dotted: beat.dotted,
    triplet: beat.triplet,
    rest: beat.notes.length === 0,
    hammer: !!(note && note.hammer),
    slide: !!(note && note.slide),
    bend: !!(note && note.bend),
    vibrato: !!(note && note.vibrato),
    dead: !!(note && note.dead),
    ghost: !!(note && note.ghost),
    harmonic: !!(note && note.harmonic),
    palmMute: !!beat.palmMute,
    strumDown: beat.strum === 'down',
    strumUp: beat.strum === 'up',
    text: !!beat.text,
    section: !!editor.measure().section,
    keypad: !$('#keypad').hidden,
  };
  for (const btn of $$('.tool[data-cmd]')) {
    const k = btn.dataset.cmd;
    if (k in pressed) btn.classList.toggle('active', pressed[k]);
  }
  const bendBtn = $('.tool[data-cmd="bend"]');
  bendBtn.textContent = note && note.bend ? { 1: 'b½', 2: 'b1', 3: 'b1½' }[note.bend] : 'b';
  $('.tool[data-cmd="undo"]').disabled = !editor.canUndo();
  $('.tool[data-cmd="redo"]').disabled = !editor.canRedo();
  const ts = effectiveTimeSignature(editor.song, editor.cursor.m);
  $('.ts-btn').textContent = `${ts[0]}/${ts[1]}`;
  // Status line
  const labels = stringLabels(editor.song.instrument, editor.song.tuning);
  const c = editor.cursor;
  const room = measureCapacity(editor.song, c.m) - measureContentTicks(editor.measure());
  let fill = '';
  if (room > 0) fill = ' · bar not full yet';
  else if (room < 0) fill = ' · bar too long';
  $('#status').textContent = `Bar ${c.m + 1} · beat ${c.b + 1} · string ${c.s + 1} (${labels[c.s]}) · ${describeDuration(beat)}${fill}`;
  if (!engine.isPlaying()) $('#position').textContent = `Bar ${c.m + 1} / ${editor.song.measures.length} · Beat ${c.b + 1}`;
}

// ------------------------------------------------------------------ playback

/** The beats the loop covers: the selection, or the current bar. Fixed while playing. */
function loopBeats() {
  if (activeLoop && engine.isPlaying()) return activeLoop;
  if (editor.hasSelection()) {
    const sel = editor.selection();
    const bars = sel.start.b === 0 && sel.end.b === editor.song.measures[sel.end.m].beats.length - 1;
    return { ...sel, bars };
  }
  const m = editor.cursor.m;
  return { start: { m, b: 0 }, end: { m, b: editor.song.measures[m].beats.length - 1 }, bars: true };
}

/** Tick range of a beat range in the song as it is now. Whole bars loop for their full length. */
function rangeTicks(r) {
  const ms = editor.song.measures;
  const clampPos = (p) => {
    const m = Math.max(0, Math.min(p.m, ms.length - 1));
    return { m, b: Math.max(0, Math.min(p.b, ms[m].beats.length - 1)) };
  };
  let s = clampPos(r.start);
  let e = clampPos(r.end);
  if (comparePos(s, e) > 0) [s, e] = [e, s];
  const ms0 = timeline.measures[s.m];
  const mt = timeline.measures[e.m];
  if (r.bars) return { startTick: ms0.start, endTick: mt.start + mt.length };
  const bt = mt.beats[e.b];
  const endTick = e.b === mt.beats.length - 1 ? mt.start + mt.length : bt.start + bt.length;
  return { startTick: ms0.beats[s.b].start, endTick };
}

/** Beats of the loop range that exist in the song now (for drawing). */
function clampRange(r) {
  const ms = editor.song.measures;
  const clampPos = (p) => {
    const m = Math.max(0, Math.min(p.m, ms.length - 1));
    return { m, b: Math.max(0, Math.min(p.b, ms[m].beats.length - 1)) };
  };
  let s = clampPos(r.start);
  let e = clampPos(r.end);
  if (comparePos(s, e) > 0) [s, e] = [e, s];
  if (r.bars) {
    s.b = 0;
    e.b = ms[e.m].beats.length - 1;
  }
  return { start: s, end: e };
}

async function startPlayback(startTick, { countIn = prefs.countIn } = {}) {
  try {
    engine.ensureContext();
  } catch (e) {
    toast(e.message);
    return;
  }
  engine.metronome = prefs.metronome;
  activeLoop = loopOn ? loopBeats() : null;
  const loop = activeLoop ? rangeTicks(activeLoop) : null;
  if (startTick >= timeline.totalTicks) startTick = 0;
  const here = locateTick(timeline, startTick);
  playStart = { m: here.m, b: here.b };
  setPlayingUI(true);
  lastPlayBeat = null;
  await engine.play({ song: editor.song, timeline, map, startTick, loop, countInBars: countIn, speed: prefs.speed });
  if (!engine.isPlaying()) {
    setPlayingUI(false);
    return;
  }
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(frame);
}

function cursorTick() {
  const c = editor.cursor;
  if (editor.hasSelection()) {
    const sel = editor.selection();
    return timeline.measures[sel.start.m].beats[sel.start.b].start;
  }
  return timeline.measures[c.m].beats[c.b].start;
}

function togglePlay() {
  if (engine.isPlaying()) stopPlayback();
  else startPlayback(cursorTick());
}

function stopPlayback() {
  if (engine.isPlaying()) engine.stop();
  setPlayingUI(false);
}

function restartFromCursor() {
  const was = engine.isPlaying();
  stopPlayback();
  if (was) startPlayback(cursorTick(), { countIn: 0 });
}

function setPlayingUI(on) {
  const btn = $('#btn-play');
  setIcon(btn.querySelector('.ic'), on ? 'pause' : 'play');
  btn.setAttribute('aria-label', on ? 'Pause' : 'Play');
  document.body.classList.toggle('playing', on);
  if (!on) {
    activeLoop = null;
    cancelAnimationFrame(rafId);
    $('#countin').classList.remove('show');
    if (playhead && playhead.el) playhead.el.remove();
    playhead = null;
    updateOverlay();
    updateToolbar();
  }
}

function drawPlayhead(sys, x) {
  if (!playhead || playhead.sys !== sys.index || !playhead.el.isConnected) {
    if (playhead && playhead.el) playhead.el.remove();
    const svg = systemSvg(sys.index);
    if (!svg) return;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    el.setAttribute('class', 'tl-playhead');
    el.setAttribute('y1', String(sys.contentTop));
    el.setAttribute('y2', String(sys.staffBottom + 14));
    svg.querySelector('.tl-over').after(el);
    playhead = { el, sys: sys.index };
  }
  playhead.el.setAttribute('x1', x.toFixed(1));
  playhead.el.setAttribute('x2', x.toFixed(1));
}

function frame() {
  const pos = engine.position();
  if (!pos || !layout) {
    if (!engine.isPlaying()) setPlayingUI(false);
    else rafId = requestAnimationFrame(frame);
    return;
  }
  const ci = $('#countin');
  if (pos.inCountIn) {
    ci.textContent = pos.countIn ? String(pos.countIn) : '';
    ci.classList.toggle('show', !!pos.countIn);
  } else if (ci.classList.contains('show')) ci.classList.remove('show');
  if (!pos.inCountIn) {
    const loc = locateTick(timeline, Math.max(0, Math.min(pos.tick, timeline.totalTicks - 1)));
    const here = findBeat(layout, loc.m, loc.b);
    if (here) {
      const mt = timeline.measures[loc.m];
      const bt = mt.beats[loc.b];
      const frac = Math.max(0, Math.min(1, (pos.tick - bt.start) / bt.length));
      let nextX = here.meas.x + here.meas.w - 4;
      if (loc.b + 1 < mt.beats.length) nextX = here.meas.beatsX[loc.b + 1].x;
      else if (pos.tick > bt.start + bt.length) {
        // inside the unfinished tail of a bar
        const tailFrac = (pos.tick - bt.start - bt.length) / Math.max(1, mt.start + mt.length - bt.start - bt.length);
        nextX = here.pos.right + (here.meas.x + here.meas.w - here.pos.right) * Math.min(1, tailFrac);
      }
      const x = pos.tick > bt.start + bt.length ? nextX : here.pos.x + (nextX - here.pos.x) * frac;
      drawPlayhead(here.sys, x);
      if (!lastPlayBeat || lastPlayBeat.m !== loc.m || lastPlayBeat.b !== loc.b) {
        lastPlayBeat = { m: loc.m, b: loc.b };
        if (!editor.anchor) {
          // The cursor follows the music, so editing or stopping carries on from here.
          editor.cursor.m = loc.m;
          editor.cursor.b = loc.b;
          editor.pending = null;
          updateToolbar();
        }
        updateOverlay();
        scrollSystemIntoView(here.sys.index);
        $('#position').textContent = `Bar ${loc.m + 1} / ${editor.song.measures.length} · Beat ${loc.b + 1}`;
      }
    }
  }
  if (syncPanel && !$('#sync-panel').hidden && engine.track) {
    panelTime = pos.time;
    syncPanel.follow(pos.time);
    syncPanel.draw();
  }
  rafId = requestAnimationFrame(frame);
}

engine.addEventListener('stop', () => setPlayingUI(false));
engine.addEventListener('ended', () => {
  setPlayingUI(false);
  if (playStart && !editor.anchor && playStart.m < editor.song.measures.length) editor.setCursor(playStart.m, Math.min(playStart.b, editor.song.measures[playStart.m].beats.length - 1));
});
engine.addEventListener('error', (e) => toast(e.detail));

function setSpeed(v) {
  v = Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, v)) * 100) / 100;
  prefs.speed = v;
  engine.setSpeed(v);
  $('#in-speed').value = String(v);
  updateSpeedLabel();
  savePrefs();
}

function updateSpeedLabel() {
  const v = prefs.speed;
  $('#out-speed').textContent = `${Math.round(v * 100)}% · ${Math.round(editor.song.tempo * v)}`;
  $('#out-speed').title = `${Math.round(v * 100)}% speed, ${Math.round(editor.song.tempo * v)} BPM`;
}

function setCountIn(n) {
  prefs.countIn = n;
  $('#countin-label').textContent = n === 0 ? 'Off' : n === 1 ? '1 bar' : '2 bars';
  $('#btn-countin').setAttribute('aria-pressed', String(n > 0));
  savePrefs();
}

function setMetronome(on) {
  prefs.metronome = on;
  engine.metronome = on;
  $('#btn-metronome').setAttribute('aria-pressed', String(on));
  savePrefs();
}

function setLoop(on) {
  loopOn = on;
  $('#btn-loop').setAttribute('aria-pressed', String(on));
  updateOverlay();
  if (engine.isPlaying()) {
    const pos = engine.position();
    stopPlayback();
    let tick = pos && !pos.inCountIn ? pos.tick : cursorTick();
    if (on) {
      const lt = rangeTicks(loopBeats());
      if (tick < lt.startTick || tick >= lt.endTick) tick = lt.startTick;
    }
    startPlayback(tick, { countIn: 0 });
  }
}

function applyTempo(v, { commit = true } = {}) {
  if (!Number.isFinite(v)) return;
  v = Math.round(Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, v)) * 100) / 100;
  if (v === editor.song.tempo) return;
  if (commit) editor.commit();
  editor.song.tempo = v;
  songChanged({ render: false });
}

// ------------------------------------------------------------------ commands

function audition(midi) {
  if (prefs.preview && midi !== undefined && !engine.isPlaying()) {
    try {
      engine.preview(midi);
    } catch (e) {
      /* audio not available */
    }
  }
}

async function askText(title, label, value) {
  const dlg = $('#dlg-ask');
  $('#ask-title').textContent = title;
  $('#ask-text').textContent = label;
  const input = $('#ask-input');
  input.value = value || '';
  dlg.returnValue = '';
  dlg.showModal();
  input.focus();
  input.select();
  return new Promise((resolve) => {
    dlg.addEventListener(
      'close',
      () => {
        focusScore();
        resolve(dlg.returnValue === 'ok' ? input.value : null);
      },
      { once: true },
    );
  });
}

async function askTimeSignature() {
  const dlg = $('#dlg-ts');
  const form = $('#form-ts');
  const ts = effectiveTimeSignature(editor.song, editor.cursor.m);
  form.num.value = String(ts[0]);
  form.den.value = String(ts[1]);
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener(
    'close',
    () => {
      focusScore();
      if (dlg.returnValue === 'ok') editor.setTimeSignature(Number(form.num.value), Number(form.den.value));
    },
    { once: true },
  );
}

const COMMANDS = {
  dotted: () => editor.toggleDotted(),
  triplet: () => editor.toggleTriplet(),
  rest: () => editor.makeRest(),
  hammer: () => flag('hammer'),
  slide: () => flag('slide'),
  vibrato: () => flag('vibrato'),
  dead: () => flag('dead'),
  ghost: () => flag('ghost'),
  harmonic: () => flag('harmonic'),
  bend: () => {
    const err = editor.cycleBend();
    if (err) toast(err);
  },
  palmMute: () => editor.togglePalmMute(),
  strumDown: () => editor.toggleStrum('down'),
  strumUp: () => editor.toggleStrum('up'),
  text: async () => {
    const t = await askText('Chord or text', 'Shown above this beat, for example Am or G7. Leave empty to remove.', editor.beat().text);
    if (t !== null) editor.setText(t);
  },
  section: async () => {
    const t = await askText('Section label', 'Shown at the start of this bar, for example Intro, Verse or Chorus. Leave empty to remove.', editor.measure().section);
    if (t !== null) editor.setSection(t);
  },
  addBar: () => editor.insertMeasure(),
  deleteBar: () => editor.deleteMeasures(),
  timeSig: () => askTimeSignature(),
  undo: () => editor.undo() || toast('Nothing to undo'),
  redo: () => editor.redo() || toast('Nothing to redo'),
  keypad: () => toggleKeypad(),
};

function flag(name) {
  const err = editor.toggleNoteFlag(name);
  if (err) toast(err);
}

function toggleKeypad(force) {
  const kp = $('#keypad');
  const show = force === undefined ? kp.hidden : force;
  kp.hidden = !show;
  document.body.classList.toggle('kp-open', show);
  prefs.keypad = show;
  savePrefs();
  updateToolbar();
}

// ------------------------------------------------------------------ keyboard

function handleKey(e) {
  const k = e.key;
  const lower = k.length === 1 ? k.toLowerCase() : k;
  const mod = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  if (e.altKey) return false;
  if (mod) {
    switch (lower) {
      case 'z':
        shift ? editor.redo() : editor.undo();
        return true;
      case 'y':
        editor.redo();
        return true;
      case 'c': {
        const n = editor.copy();
        toast(editor.clipboard.measures ? `Copied ${n} bar${n > 1 ? 's' : ''}` : `Copied ${n} beat${n > 1 ? 's' : ''}`, 1500);
        return true;
      }
      case 'x':
        editor.cut();
        return true;
      case 'v':
        if (!editor.paste()) toast(`Copy something first (${MOD}+C)`);
        return true;
      case 'a':
        editor.selectAll();
        return true;
      case 's':
        saveFile();
        return true;
      case 'o':
        openLibrary();
        return true;
      case 'ArrowLeft':
        editor.prevMeasure({ extend: shift });
        return true;
      case 'ArrowRight':
        editor.nextMeasure({ extend: shift });
        return true;
      case 'Home':
        editor.songStart({ extend: shift });
        return true;
      case 'End':
        editor.songEnd({ extend: shift });
        return true;
      case 'Backspace':
      case 'Delete':
        if (shift) editor.deleteMeasures();
        else editor.deleteBeat();
        return true;
      default:
        return false;
    }
  }
  if (/^[0-9]$/.test(k)) {
    audition(editor.typeDigit(Number(k)));
    return true;
  }
  switch (lower) {
    case 'ArrowLeft':
      editor.left({ extend: shift });
      return true;
    case 'ArrowRight':
      editor.right({ extend: shift });
      return true;
    case 'ArrowUp':
      editor.up();
      if (!shift) audition(editor.cursorPitch());
      return true;
    case 'ArrowDown':
      editor.down();
      if (!shift) audition(editor.cursorPitch());
      return true;
    case 'Home':
      editor.home({ extend: shift });
      return true;
    case 'End':
      editor.end({ extend: shift });
      return true;
    case 'Backspace':
      editor.deleteAtCursor({ backspace: true });
      return true;
    case 'Delete':
      editor.deleteAtCursor();
      return true;
    case 'Insert':
    case 'i':
      editor.insertBeat();
      return true;
    case 'Enter':
      editor.insertMeasure({ before: shift });
      return true;
    case ' ':
      togglePlay();
      return true;
    case 'Escape':
      if (engine.isPlaying()) stopPlayback();
      else editor.clearSelection();
      return true;
    case '-':
    case '_':
      editor.shorter();
      return true;
    case '=':
    case '+':
      editor.longer();
      return true;
    case '.':
      editor.toggleDotted();
      return true;
    case 't':
      shift ? COMMANDS.text() : editor.toggleTriplet();
      return true;
    case 'r':
      editor.makeRest();
      return true;
    case 'h':
      flag('hammer');
      return true;
    case 's':
      flag('slide');
      return true;
    case 'b':
      COMMANDS.bend();
      return true;
    case 'v':
      flag('vibrato');
      return true;
    case 'x':
      flag('dead');
      return true;
    case 'g':
      flag('ghost');
      return true;
    case 'n':
      if (shift) setNotation(!prefs.notation);
      else flag('harmonic');
      return true;
    case 'p':
      editor.togglePalmMute();
      return true;
    case 'd':
      editor.toggleStrum('down');
      return true;
    case 'u':
      editor.toggleStrum('up');
      return true;
    case 'm':
      if (shift) COMMANDS.section();
      else {
        setMetronome(!prefs.metronome);
        toast(prefs.metronome ? 'Metronome on' : 'Metronome off', 1200);
      }
      return true;
    case 'c':
      setCountIn((prefs.countIn + 1) % 3);
      toast(prefs.countIn ? `Count-in: ${prefs.countIn} bar${prefs.countIn > 1 ? 's' : ''}` : 'Count-in off', 1200);
      return true;
    case 'l':
      setLoop(!loopOn);
      toast(loopOn ? (editor.hasSelection() ? 'Looping the selection' : 'Looping this bar') : 'Loop off', 1200);
      return true;
    case '[':
      setSpeed(prefs.speed - 0.05);
      return true;
    case ']':
      setSpeed(prefs.speed + 0.05);
      return true;
    case '?':
      openHelp();
      return true;
    default:
      return false;
  }
}

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  const t = e.target;
  if (isTypingTarget(t)) {
    if (e.key === 'Escape') t.blur();
    return;
  }
  // Let focused buttons and links work with Enter and Space.
  if ((e.key === 'Enter' || e.key === ' ') && t && (t.tagName === 'BUTTON' || t.tagName === 'A') && t !== $('#score')) return;
  // Keys inside an open menu belong to the menu.
  const menu = t && t.closest && t.closest('.menu');
  if (menu && !menu.hidden) return;
  if (handleKey(e)) e.preventDefault();
});

// ------------------------------------------------------------------ mouse and touch on the tab

let dragSel = null;

$('#systems').addEventListener('pointerdown', (e) => {
  const svg = e.target.closest('svg.tl-system');
  if (!svg || !layout || e.button > 0) return;
  const r = svg.getBoundingClientRect();
  const hit = hitTest(layout, Number(svg.dataset.sys), e.clientX - r.left, e.clientY - r.top);
  if (!hit) return;
  e.preventDefault();
  focusScore();
  if (engine.isPlaying()) {
    editor.setCursor(hit.m, hit.b, hit.s);
    restartFromCursor();
    return;
  }
  editor.setCursor(hit.m, hit.b, hit.s, { extend: e.shiftKey });
  dragSel = { id: e.pointerId, m: hit.m, b: hit.b, moved: false };
  audition(noteAt(editor.beat(), hit.s) ? editor.cursorPitch() : undefined);
});

window.addEventListener('pointermove', (e) => {
  if (!dragSel || e.pointerId !== dragSel.id || !layout) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const svg = el && el.closest && el.closest('svg.tl-system');
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  const hit = hitTest(layout, Number(svg.dataset.sys), e.clientX - r.left, e.clientY - r.top);
  if (!hit) return;
  if (hit.m !== editor.cursor.m || hit.b !== editor.cursor.b) {
    dragSel.moved = true;
    editor.setCursor(hit.m, hit.b, undefined, { extend: true });
  }
});

window.addEventListener('pointerup', () => {
  dragSel = null;
});

// ------------------------------------------------------------------ files and library

function saveFile() {
  const s = editor.song;
  store.download(store.safeFileName(s.title, '.tablab'), JSON.stringify(s, null, 1), 'application/json');
  toast('Song downloaded. TabLab also keeps your work in this browser automatically.');
}

async function exportAs(kind) {
  const s = editor.song;
  if (kind === 'txt') store.download(store.safeFileName(s.title, '.txt'), songToText(s), 'text/plain');
  else if (kind === 'copy') {
    try {
      await navigator.clipboard.writeText(songToText(s));
      toast('Text tab copied. Paste it anywhere.');
    } catch (e) {
      toast('Copy is blocked by the browser. Use the text file export instead.');
    }
  } else if (kind === 'print') {
    stopPlayback();
    setTimeout(() => window.print(), 50);
  } else if (kind === 'tablab') saveFile();
}

async function openLibrary() {
  stopPlayback();
  if (saveTimer) saveNow();
  const dlg = $('#dlg-library');
  const ex = $('#lib-examples');
  ex.innerHTML = '';
  for (const item of EXAMPLES) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="info"><span class="name"></span><span class="meta"></span></div><button class="btn" type="button">Open</button>`;
    li.querySelector('.name').textContent = item.title;
    li.querySelector('.meta').textContent = item.meta;
    li.querySelector('button').addEventListener('click', async () => {
      dlg.close();
      await loadExample(item);
    });
    ex.appendChild(li);
  }
  const list = $('#lib-songs');
  list.innerHTML = '';
  const songs = store.listSongs();
  if (!songs.length) list.innerHTML = '<li class="empty">Songs you write are saved here automatically.</li>';
  for (const s of songs) {
    const li = document.createElement('li');
    li.innerHTML = `<div class="info"><span class="name"></span><span class="meta"></span></div><button class="btn open" type="button">Open</button><button class="btn ghost icon-only del" type="button"><span class="ic" data-icon="trash"></span></button>`;
    li.querySelector('.name').textContent = s.title || 'Untitled';
    const when = s.updated ? new Date(s.updated).toLocaleString() : '';
    li.querySelector('.meta').textContent = `${INSTRUMENTS[s.instrument] ? INSTRUMENTS[s.instrument].name : ''}${s.artist ? ' · ' + s.artist : ''} · ${when}${s.id === editor.song.id ? ' · open now' : ''}`;
    const del = li.querySelector('.del');
    del.setAttribute('aria-label', `Delete ${s.title}`);
    del.title = 'Delete from this browser';
    li.querySelector('.open').addEventListener('click', () => {
      const song = store.loadSong(s.id);
      dlg.close();
      if (song) setSong(song);
      else toast('That song could not be read.');
    });
    del.addEventListener('click', () => {
      if (s.id === editor.song.id) {
        toast('That song is open. Open another song first, then delete it.');
        return;
      }
      if (!confirm(`Delete "${s.title}" from this browser? This cannot be undone.`)) return;
      store.deleteSong(s.id);
      li.remove();
    });
    list.appendChild(li);
  }
  fillIcons(dlg);
  dlg.showModal();
}

async function loadExample(item, message) {
  try {
    const res = await fetch(item.file);
    if (!res.ok) throw new Error('missing');
    const raw = await res.json();
    const song = normalizeSong(raw);
    song.id = uid(); // a fresh copy, so edits never change the example
    song.created = song.updated = new Date().toISOString();
    setSong(song, { message: message || `Opened "${song.title}". ${TOUCH ? 'Tap play' : 'Press Space'} to hear it.` });
    return true;
  } catch (e) {
    toast('The example could not be loaded.');
    return false;
  }
}

$('#file-song').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const song = await store.readSongFile(file);
    if (store.listSongs().some((s) => s.id === song.id) && song.id !== editor.song.id) {
      // Keep the copy in the browser and the opened file apart.
      song.id = uid();
    }
    setSong(song, { message: `Opened "${song.title}"` });
  } catch (err) {
    toast(err.message, 5000);
  }
});

// ------------------------------------------------------------------ song settings and new song

function fillSongForm(form, song, isNew) {
  $('#song-title-h').textContent = isNew ? 'New song' : 'Song settings';
  $('#song-ok').textContent = isNew ? 'Create' : 'Save';
  form.title.value = isNew ? 'Untitled' : song.title;
  form.artist.value = isNew ? '' : song.artist;
  form.instrument.value = song.instrument;
  fillTunings(form, song.instrument, song.tuning);
  form.capo.innerHTML = Array.from({ length: 13 }, (_, i) => `<option value="${i}">${i === 0 ? 'None' : 'Fret ' + i}</option>`).join('');
  form.capo.value = String(isNew ? 0 : song.capo);
  form.tempo.value = String(isNew ? 100 : Math.round(song.tempo * 100) / 100);
  form.tsNum.innerHTML = TS_NUMERATORS.map((n) => `<option>${n}</option>`).join('');
  form.tsDen.innerHTML = TS_DENOMINATORS.map((n) => `<option>${n}</option>`).join('');
  form.tsNum.value = String(isNew ? 4 : song.timeSignature[0]);
  form.tsDen.value = String(isNew ? 4 : song.timeSignature[1]);
  // C major first, then the sharp keys, then the flat keys.
  const keys = [...KEYS.filter((k) => k.key >= 0), ...KEYS.filter((k) => k.key < 0).reverse()];
  form.key.innerHTML = keys.map((k) => `<option value="${k.key}">${keyName(k.key)}</option>`).join('');
  form.key.value = String(isNew ? 0 : song.key || 0);
  updateSongWarn(form, song, isNew);
}

function fillTunings(form, instrument, current) {
  const inst = INSTRUMENTS[instrument];
  const preset = current ? matchTuning(instrument, current) : null;
  const isCustom = current && !preset && current.length === inst.strings;
  form.tuning.innerHTML = inst.tunings.map((t) => `<option value="${t.id}">${t.name}</option>`).join('') + '<option value="custom">Custom</option>';
  form.tuning.value = isCustom ? 'custom' : preset ? preset.id : inst.tunings[0].id;
  fillCustomStrings(form, instrument, isCustom ? current : (preset || inst.tunings[0]).notes);
}

/** One note picker per string, lowest string on the left, as tunings are usually written. */
function fillCustomStrings(form, instrument, notes) {
  const [lo, hi] = TUNING_RANGE[instrument];
  const box = $('#custom-strings');
  const n = notes.length;
  box.style.setProperty('--n', String(n));
  const options = [];
  for (let m = lo; m <= hi; m++) options.push(`<option value="${m}">${noteNameOctave(m)}</option>`);
  box.innerHTML = notes
    .map((_, i) => {
      const s = n - 1 - i; // string index, from the lowest string
      const label = s === n - 1 ? `String ${s + 1}, the lowest` : s === 0 ? 'String 1, the highest' : `String ${s + 1}`;
      return `<select data-string="${s}" aria-label="${label}">${options.join('')}</select>`;
    })
    .join('');
  for (const sel of box.querySelectorAll('select')) {
    const note = notes[Number(sel.dataset.string)];
    sel.value = String(Math.min(hi, Math.max(lo, note)));
  }
  $('#custom-tuning').hidden = form.tuning.value !== 'custom';
}

/** The tuning the dialog shows: string 1 (the highest) first, as songs store it. */
function formTuning(form, instrument) {
  if (form.tuning.value !== 'custom') {
    const inst = INSTRUMENTS[instrument];
    return (inst.tunings.find((t) => t.id === form.tuning.value) || inst.tunings[0]).notes.slice();
  }
  const notes = [];
  for (const sel of $('#custom-strings').querySelectorAll('select')) notes[Number(sel.dataset.string)] = Number(sel.value);
  return notes;
}

function updateSongWarn(form, song, isNew) {
  const warn = $('#song-warn');
  const inst = INSTRUMENTS[form.instrument.value];
  if (!isNew && inst.strings < song.tuning.length) {
    let lost = 0;
    for (const m of song.measures) for (const b of m.beats) for (const n of b.notes) if (n.string >= inst.strings) lost++;
    if (lost) {
      warn.textContent = `${lost} note${lost > 1 ? 's' : ''} on strings ${inst.strings + 1} to ${song.tuning.length} will be removed. You can undo this.`;
      warn.hidden = false;
      return;
    }
  }
  warn.hidden = true;
}

function openSongDialog(isNew = false) {
  stopPlayback();
  const dlg = $('#dlg-song');
  const form = $('#form-song');
  const song = editor.song;
  fillSongForm(form, isNew ? createSong() : song, isNew);
  form.onchange = (e) => {
    if (e.target.name === 'instrument') {
      fillTunings(form, form.instrument.value, form.instrument.value === song.instrument && !isNew ? song.tuning : null);
      updateSongWarn(form, song, isNew);
    } else if (e.target.name === 'tuning') {
      // Custom starts from the tuning chosen before, so one string is easy to change.
      const wasHidden = $('#custom-tuning').hidden;
      if (form.tuning.value === 'custom' && wasHidden) {
        const inst = INSTRUMENTS[form.instrument.value];
        const prev = form.tuning.dataset.prev;
        const base = inst.tunings.find((t) => t.id === prev);
        fillCustomStrings(form, form.instrument.value, base ? base.notes : formTuning(form, form.instrument.value));
      }
      $('#custom-tuning').hidden = form.tuning.value !== 'custom';
    }
    form.tuning.dataset.prev = form.tuning.value;
  };
  form.tuning.dataset.prev = form.tuning.value;
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener(
    'close',
    () => {
      focusScore();
      if (dlg.returnValue !== 'ok') return;
      const instrument = form.instrument.value;
      const tuningId = form.tuning.value;
      const tempo = Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, Number(form.tempo.value) || 100));
      const ts = [Number(form.tsNum.value), Number(form.tsDen.value)];
      const title = form.title.value.trim() || 'Untitled';
      const artist = form.artist.value.trim();
      const capo = Number(form.capo.value) || 0;
      const key = Number(form.key.value) || 0;
      const tuning = formTuning(form, instrument);
      if (isNew) {
        const s = createSong({ instrument, tuningId: tuningId === 'custom' ? undefined : tuningId, title, tempo, timeSignature: ts });
        s.artist = artist;
        s.capo = capo;
        s.key = key;
        s.tuning = tuning;
        setSong(s, { message: 'New song ready. Click a string and type a fret number.' });
        return;
      }
      editor.commit();
      song.title = title;
      song.artist = artist;
      song.capo = capo;
      song.key = key;
      song.tempo = Math.round(tempo * 100) / 100;
      song.timeSignature = ts;
      if (song.measures.length > 1) {
        // drop a change on bar 2 that now repeats the song meter
        for (let i = 1; i < song.measures.length; i++) {
          const mts = song.measures[i].timeSignature;
          if (!mts) continue;
          const prev = effectiveTimeSignature(song, i - 1);
          if (prev[0] === mts[0] && prev[1] === mts[1]) delete song.measures[i].timeSignature;
        }
      }
      song.instrument = instrument;
      song.tuning = tuning;
      for (const m of song.measures) for (const b of m.beats) b.notes = b.notes.filter((n) => n.string < song.tuning.length);
      editor.clampCursor();
      songChanged();
    },
    { once: true },
  );
}

// ------------------------------------------------------------------ backing track panel

function syncState() {
  return { track: engine.track, song: editor.song, timeline, map, playTime: panelTime };
}

function updateSyncUI() {
  const has = !!engine.track;
  const bt = editor.song.backingTrack;
  $('#track-name').textContent = has ? `${engine.track.name} (${fmtTime(engine.track.duration)})` : bt ? `${bt.fileName} (load it again to play it)` : 'No backing track yet';
  $('#btn-remove-audio').hidden = !(has || bt);
  $('#btn-detect').disabled = !(has && engine.track.mono);
  $('#btn-set-start').disabled = !has;
  const trackBtn = $('#btn-track');
  trackBtn.setAttribute('aria-pressed', String(!$('#sync-panel').hidden));
  trackBtn.classList.toggle('has-track', has);
  trackBtn.title = has ? `Backing track: ${engine.track.name}` : 'Backing track';
  updateSyncFields();
  if (syncPanel) syncPanel.draw();
}

function updateSyncFields() {
  const bt = editor.song.backingTrack;
  const off = $('#in-offset');
  if (document.activeElement !== off) off.value = bt ? bt.offset.toFixed(3) : '0.000';
  const tempo = $('#in-sync-tempo');
  if (document.activeElement !== tempo) tempo.value = String(Math.round(editor.song.tempo * 100) / 100);
  const n = bt ? bt.syncPoints.length : 0;
  const pins = $('#pins');
  if (pins.dataset.n !== String(n)) {
    pins.dataset.n = String(n);
    pins.innerHTML = n ? `${n} pinned bar${n > 1 ? 's' : ''} <button class="btn ghost" type="button" id="btn-clear-pins">Unpin all</button>` : '';
    const clear = $('#btn-clear-pins');
    if (clear)
      clear.addEventListener('click', () => {
        editor.commit();
        editor.song.backingTrack.syncPoints = [];
        songChanged({ render: false });
        toast('All bars unpinned. Only bar 1 and the tempo set the sync now.');
      });
  }
  for (const el of $$('#sync-panel [data-nudge], #in-offset, #in-sync-tempo, #btn-half, #btn-double')) el.disabled = !bt;
}

function ensureBacking() {
  if (!editor.song.backingTrack) editor.song.backingTrack = { fileName: engine.track ? engine.track.name : 'backing track', offset: 0, volume: prefs.volumes.track, syncPoints: [] };
  return editor.song.backingTrack;
}

async function loadAudioFile(file) {
  if (!file) return;
  stopPlayback();
  toast('Loading audio…', 10000);
  try {
    await engine.loadTrack(file, file.name);
    const s = editor.song;
    if (!s.backingTrack || s.backingTrack.fileName !== file.name) {
      editor.commit();
      s.backingTrack = { fileName: file.name, offset: 0, volume: prefs.volumes.track, syncPoints: [] };
    }
    engine.setVolume('track', s.backingTrack.volume);
    $('#vol-track').value = String(s.backingTrack.volume);
    $('#vol-track2').value = String(s.backingTrack.volume);
    store.saveTrack(s.id, file, file.name).catch(() => toast('The audio is too large to keep in this browser. You will need to load it again next time.', 5000));
    songChanged();
    updateSyncUI();
    syncPanel.fit();
    toast(`Loaded ${file.name}. Press Auto sync, or set the tempo and drag bar 1 onto the first beat.`, 5000);
  } catch (err) {
    toast(err.message, 6000);
    updateSyncUI();
  }
}

function setOffset(t, { commit = true } = {}) {
  const bt = ensureBacking();
  if (commit) editor.commit();
  const first = bt.syncPoints.length ? Math.min(...bt.syncPoints.map((p) => p.time)) - 0.05 : Infinity;
  bt.offset = Math.round(Math.min(first, t) * 1000) / 1000;
  songChanged({ render: false });
}

function initSyncPanel() {
  syncPanel = new SyncPanel($('#wave'), {
    state: syncState,
    onDragStart: () => {
      pendingDragCommit = true;
    },
    onOffset: (t, final) => {
      if (pendingDragCommit) {
        editor.commit();
        pendingDragCommit = false;
      }
      ensureBacking().offset = t;
      songChanged({ save: final, render: false });
    },
    onPin: (m, t, final) => {
      if (pendingDragCommit) {
        editor.commit();
        pendingDragCommit = false;
      }
      const bt = ensureBacking();
      const pts = bt.syncPoints.filter((p) => p.measure !== m);
      pts.push({ measure: m, time: t });
      pts.sort((a, b) => a.measure - b.measure);
      bt.syncPoints = pts;
      songChanged({ save: final, render: false });
      if (final) toast(`Bar ${m + 1} is pinned to ${t.toFixed(2)} s. Double click its line to unpin it.`, 3500);
    },
    onUnpin: (m) => {
      editor.commit();
      const bt = ensureBacking();
      bt.syncPoints = bt.syncPoints.filter((p) => p.measure !== m);
      songChanged({ render: false });
    },
    onSeek: (t) => {
      panelTime = t;
      const tick = Math.max(0, Math.min(timeline.totalTicks - 1, map.timeToTick(t)));
      const loc = locateTick(timeline, tick);
      editor.setCursor(loc.m, loc.b);
      if (engine.isPlaying()) restartFromCursor();
      syncPanel.draw();
    },
  });
  $('#btn-zoom-in').addEventListener('click', () => syncPanel.zoom(1.5));
  $('#btn-zoom-out').addEventListener('click', () => syncPanel.zoom(1 / 1.5));
  $('#btn-zoom-fit').addEventListener('click', () => syncPanel.fit());
  $('#btn-load-audio').addEventListener('click', () => $('#file-audio').click());
  $('#file-audio').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    loadAudioFile(f);
  });
  $('#btn-remove-audio').addEventListener('click', () => {
    stopPlayback();
    editor.commit();
    const id = editor.song.id;
    editor.song.backingTrack = null;
    engine.unloadTrack();
    store.deleteTrack(id).catch(() => {});
    panelTime = null;
    songChanged();
    updateSyncUI();
    toast('Backing track removed. Undo brings back its sync settings.');
  });
  $('#btn-detect').addEventListener('click', () => {
    toast('Listening for the beat…', 10000);
    setTimeout(() => {
      const res = engine.detectSync();
      if (!res) {
        toast('No steady beat found. Use Tap tempo, then drag the bar 1 line onto the first beat.', 6000);
        return;
      }
      editor.commit();
      const bt = ensureBacking();
      bt.offset = res.offset;
      bt.syncPoints = [];
      editor.song.tempo = Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, res.bpm));
      songChanged({ render: false });
      syncPanel.show(res.offset);
      toast(`Tempo ${res.bpm} BPM, bar 1 at ${res.offset.toFixed(2)} s. Press play to check. If it feels twice too fast or slow, use ÷2 or ×2.`, 7000);
    }, 30);
  });
  $('#btn-tap').addEventListener('click', () => {
    const now = performance.now();
    if (tap.times.length && now - tap.times[tap.times.length - 1] > 2000) {
      tap.times = [];
      tap.committed = false;
    }
    tap.times.push(now);
    if (tap.times.length > 9) tap.times.shift();
    if (tap.times.length < 4) {
      toast(`Keep tapping… (${tap.times.length})`, 1200);
      return;
    }
    const iv = [];
    for (let i = 1; i < tap.times.length; i++) iv.push(tap.times[i] - tap.times[i - 1]);
    iv.sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)];
    const bpm = Math.round((60000 / med) * 10) / 10;
    applyTempo(bpm, { commit: !tap.committed });
    tap.committed = true;
    toast(`Tempo ${bpm} BPM`, 1200);
  });
  $('#btn-set-start').addEventListener('click', () => {
    const pos = engine.isPlaying() ? engine.position() : null;
    if (!pos || !engine.track || !editor.song.backingTrack || !engine.media || engine.media.paused) {
      toast('Play first, then press this right on the first beat of bar 1.', 4000);
      return;
    }
    // The position heard right now (output delay included), in the recording.
    setOffset(pos.time);
    toast(`Bar 1 now starts at ${editor.song.backingTrack.offset.toFixed(2)} s`);
  });
  $('#in-offset').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v)) setOffset(v);
  });
  for (const b of $$('#sync-panel [data-nudge]')) {
    b.addEventListener('click', () => setOffset((editor.song.backingTrack ? editor.song.backingTrack.offset : 0) + Number(b.dataset.nudge)));
  }
  $('#in-sync-tempo').addEventListener('change', (e) => applyTempo(Number(e.target.value)));
  $('#btn-half').addEventListener('click', () => applyTempo(editor.song.tempo / 2));
  $('#btn-double').addEventListener('click', () => applyTempo(editor.song.tempo * 2));
  $('#chk-tab-sound').addEventListener('change', (e) => {
    prefs.synthOn = e.target.checked;
    engine.setSynthOn(prefs.synthOn);
    savePrefs();
  });
  const trackVol = (v) => {
    prefs.volumes.track = v;
    engine.setVolume('track', v);
    if (editor.song.backingTrack) {
      editor.song.backingTrack.volume = v;
      queueSave();
    }
    $('#vol-track').value = String(v);
    $('#vol-track2').value = String(v);
    savePrefs();
  };
  $('#vol-track').addEventListener('input', (e) => trackVol(Number(e.target.value)));
  $('#vol-track2').addEventListener('input', (e) => trackVol(Number(e.target.value)));
}

function toggleSyncPanel(force) {
  const panel = $('#sync-panel');
  const show = force === undefined ? panel.hidden : force;
  panel.hidden = !show;
  document.body.classList.toggle('sync-open', show);
  prefs.syncOpen = show;
  savePrefs();
  updateSyncUI();
  if (show) {
    syncPanel.refreshColors();
    if (engine.track && syncPanel.view.pps === 60 && syncPanel.view.start === 0) syncPanel.fit();
  }
  queueRender();
}

// ------------------------------------------------------------------ help

function openHelp() {
  const body = $('#help-body');
  if (!body.dataset.filled) {
    let html = '<p class="help-intro">Click a string in the tab (or use the arrow keys), type a fret number, then press → for the next beat. The note length buttons set how long the beat lasts. TabLab saves your work in this browser as you go.</p>';
    for (const sec of SHORTCUTS) {
      html += `<section><h4>${sec.title}</h4><dl>`;
      for (const [keys, what] of sec.items) html += `<dt>${keys.map((k) => `<kbd>${k === 'Ctrl' ? MOD : k}</kbd>`).join(' ')}</dt><dd>${what.replace(/\bCtrl\b/g, MOD)}</dd>`;
      html += '</dl></section>';
    }
    body.innerHTML = html;
    body.dataset.filled = '1';
  }
  const dlg = $('#dlg-help');
  dlg.showModal();
  dlg.addEventListener('close', focusScore, { once: true });
}

// ------------------------------------------------------------------ view

/** Show standard notation above the tab, or the tab alone. */
function setNotation(on, persist = true) {
  prefs.notation = !!on;
  const btn = $('#btn-view');
  btn.setAttribute('aria-pressed', String(prefs.notation));
  btn.title = prefs.notation ? 'Show the tab only (Shift+N)' : 'Show standard notation above the tab (Shift+N)';
  if (persist) {
    savePrefs();
    renderScore();
    scrollToCursor();
  }
}

// ------------------------------------------------------------------ theme

function applyTheme(theme, persist = true) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('#btn-theme');
  setIcon(btn.querySelector('.ic'), theme === 'dark' ? 'sun' : 'moon');
  btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  if (persist) {
    prefs.theme = theme;
    savePrefs();
  }
  if (syncPanel) syncPanel.refreshColors();
}

// ------------------------------------------------------------------ wiring

function wire() {
  fillIcons();
  $('#btn-theme').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!prefs.theme) applyTheme(e.matches ? 'dark' : 'light', false);
  });
  $('#btn-help').addEventListener('click', openHelp);
  $('#btn-view').addEventListener('click', () => setNotation(!prefs.notation));
  $('#btn-new').addEventListener('click', () => openSongDialog(true));
  $('#btn-song').addEventListener('click', () => openSongDialog(false));
  $('#btn-song-mini').addEventListener('click', () => openSongDialog(false));
  $('#btn-library').addEventListener('click', openLibrary);
  $('#btn-open-file').addEventListener('click', () => {
    $('#dlg-library').close();
    $('#file-song').click();
  });
  $('#btn-save').addEventListener('click', saveFile);
  const exportBtn = $('#btn-export');
  const exportMenu = $('#menu-export');
  const closeMenus = () => {
    exportMenu.hidden = true;
    exportBtn.setAttribute('aria-expanded', 'false');
    $('#mixer').hidden = true;
    $('#btn-mixer').setAttribute('aria-expanded', 'false');
  };
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = exportMenu.hidden;
    closeMenus();
    exportMenu.hidden = !open;
    exportBtn.setAttribute('aria-expanded', String(open));
    if (open) exportMenu.querySelector('button').focus();
  });
  exportMenu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-export]');
    if (!b) return;
    closeMenus();
    focusScore();
    exportAs(b.dataset.export);
  });
  $('#btn-mixer').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('#mixer');
    const open = m.hidden;
    closeMenus();
    m.hidden = !open;
    $('#btn-mixer').setAttribute('aria-expanded', String(open));
  });
  $('#mixer').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', closeMenus);
  document.addEventListener('mousedown', (e) => {
    const btn = e.target.closest && e.target.closest('button');
    if (!btn || btn.closest('dialog') || btn.closest('.menu')) return;
    e.preventDefault();
    if (isTypingTarget(document.activeElement)) {
      document.activeElement.blur(); // finish typing in a field first (its change event fires)
      focusScore();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenus();
  });

  const title = $('#song-title');
  title.addEventListener('input', () => {
    editor.song.title = title.value.trim() || 'Untitled';
    document.title = `${editor.song.title} · TabLab`;
    $('#print-title').textContent = editor.song.title;
    queueSave();
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      focusScore();
    }
  });

  $('#toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.dur) editor.setDuration(Number(btn.dataset.dur));
    else if (btn.dataset.cmd && COMMANDS[btn.dataset.cmd]) COMMANDS[btn.dataset.cmd]();
    if (!['text', 'section', 'timeSig'].includes(btn.dataset.cmd)) focusScore();
  });

  $('#btn-play').addEventListener('click', () => {
    togglePlay();
    focusScore();
  });
  $('#btn-rewind').addEventListener('click', () => {
    const was = engine.isPlaying();
    stopPlayback();
    editor.songStart();
    if (was) startPlayback(0);
    focusScore();
  });
  $('#btn-loop').addEventListener('click', () => {
    setLoop(!loopOn);
    focusScore();
  });
  $('#btn-countin').addEventListener('click', () => {
    setCountIn((prefs.countIn + 1) % 3);
    focusScore();
  });
  $('#btn-metronome').addEventListener('click', () => {
    setMetronome(!prefs.metronome);
    focusScore();
  });
  $('#in-tempo').addEventListener('change', (e) => applyTempo(Number(e.target.value)));
  $('#in-tempo').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      applyTempo(Number(e.target.value));
      focusScore();
    }
  });
  $('#in-speed').addEventListener('input', (e) => setSpeed(Number(e.target.value)));
  $('#btn-track').addEventListener('click', () => toggleSyncPanel());
  $('#vol-synth').addEventListener('input', (e) => {
    prefs.volumes.synth = Number(e.target.value);
    engine.setVolume('synth', prefs.volumes.synth);
    savePrefs();
  });
  $('#vol-click').addEventListener('input', (e) => {
    prefs.volumes.click = Number(e.target.value);
    engine.setVolume('click', prefs.volumes.click);
    savePrefs();
  });
  $('#chk-preview').addEventListener('change', (e) => {
    prefs.preview = e.target.checked;
    savePrefs();
  });

  // On-screen keypad sends the same keys as a keyboard.
  $('#keypad').addEventListener('pointerdown', (e) => {
    const b = e.target.closest('button[data-key]');
    if (!b) return;
    e.preventDefault();
    handleKey({ key: b.dataset.key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
  });

  // Enter in a dialog's text or number field presses its OK button.
  for (const dlg of $$('dialog')) {
    const form = dlg.querySelector('form');
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.isComposing) return;
      const ok = form.querySelector('button[value="ok"]');
      if (!ok) return;
      e.preventDefault();
      ok.click();
    });
  }

  // Time signature picker options
  const tsForm = $('#form-ts');
  tsForm.num.innerHTML = TS_NUMERATORS.map((n) => `<option>${n}</option>`).join('');
  tsForm.den.innerHTML = TS_DENOMINATORS.map((n) => `<option>${n}</option>`).join('');

  let resizeT = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeT);
    resizeT = setTimeout(queueRender, 60);
  }).observe($('#systems'));

  // Messages and the number pad float just above whatever is docked under the score
  // (the player, and the backing track panel when it is open).
  const updateDock = () => {
    const root = document.documentElement;
    const dock = Math.max(0, Math.round(root.clientHeight - $('#score').getBoundingClientRect().bottom));
    root.style.setProperty('--dock', dock + 'px');
  };
  new ResizeObserver(updateDock).observe($('#score'));
  window.addEventListener('resize', updateDock);
  updateDock();

  // Printing lays the tab out again at page width, then back at screen width.
  const setPrinting = (on) => {
    if (printing === on) return;
    printing = on;
    renderScore();
  };
  window.addEventListener('beforeprint', () => setPrinting(true));
  window.addEventListener('afterprint', () => setPrinting(false));
  const printQuery = window.matchMedia('print');
  if (printQuery.addEventListener) printQuery.addEventListener('change', (e) => setPrinting(e.matches));

  // Drag and drop: audio files become the backing track, .tablab files open.
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', async (e) => {
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    if (/\.(tablab|json)$/i.test(file.name)) {
      try {
        setSong(await store.readSongFile(file), { message: `Opened "${file.name}"` });
      } catch (err) {
        toast(err.message, 5000);
      }
    } else if (file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm)$/i.test(file.name)) {
      toggleSyncPanel(true);
      loadAudioFile(file);
    }
  });

  // Save when the page closes or goes to the background (phones often skip beforeunload).
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveTimer) saveNow();
  });
}

// ------------------------------------------------------------------ start

async function start() {
  wire();
  initSyncPanel();
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light', false);
  $('#in-speed').value = String(prefs.speed);
  engine.rate = prefs.speed;
  setCountIn(prefs.countIn);
  setMetronome(prefs.metronome);
  setNotation(prefs.notation, false);
  engine.volumes = { ...engine.volumes, ...prefs.volumes };
  engine.synthOn = prefs.synthOn;
  $('#chk-tab-sound').checked = prefs.synthOn;
  $('#chk-preview').checked = prefs.preview;
  $('#vol-synth').value = String(prefs.volumes.synth);
  $('#vol-click').value = String(prefs.volumes.click);
  $('#vol-track').value = String(prefs.volumes.track);
  $('#vol-track2').value = String(prefs.volumes.track);
  $('#keypad').hidden = !(prefs.keypad === null ? TOUCH : prefs.keypad);
  document.body.classList.toggle('kp-open', !$('#keypad').hidden);
  if (APPLE) for (const el of document.querySelectorAll('[title*="Ctrl+"]')) el.title = el.title.replace(/Ctrl\+/g, 'Cmd+');
  $('#sync-panel').hidden = !prefs.syncOpen;
  document.body.classList.toggle('sync-open', prefs.syncOpen);

  const id = store.currentSongId();
  const saved = id ? store.loadSong(id) : null;
  if (saved) {
    setSong(saved);
  } else {
    const welcome = TOUCH
      ? 'Welcome to TabLab! Tap play to hear this example. To write, tap a string and use the number pad.'
      : 'Welcome to TabLab! Press Space to hear this example. To write, click a string and type a fret number. Press ? for all shortcuts.';
    if (!(await loadExample(EXAMPLES[0], welcome))) setSong(createSong());
  }
  focusScore();

  if ('serviceWorker' in navigator && window.isSecureContext && !/[?&]nosw\b/.test(location.search)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// Exposed for tests and for curious students poking around in the console.
window.tablab = {
  editor,
  engine,
  get layout() {
    return layout;
  },
  get timeline() {
    return timeline;
  },
  get map() {
    return map;
  },
  prefs,
  /** Open a song object (it is checked first, like a file). */
  openSong: (raw) => setSong(normalizeSong(raw)),
  songChanged,
  startPlayback,
  stopPlayback,
  setLoop,
  setSpeed,
  loadAudioFile,
  toggleSyncPanel,
  get syncPanel() {
    return syncPanel;
  },
  ready: null,
};
window.tablab.ready = start();
