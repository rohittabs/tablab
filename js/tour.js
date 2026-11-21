// The About page and the two minute tour (about.html, slides.html): slides that snap into
// place, the same light or dark mode as the app, and tab examples drawn by TabLab's own
// tab renderer, so they always look exactly like the app.

import { normalizeSong } from './core/model.js';
import { buildTimeline } from './core/timing.js';
import { ICONS } from './ui/icons.js';
import { LS, findBeat, layoutScore, renderSystem } from './ui/render.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const PREFS_KEY = 'tablab.prefs';

// ------------------------------------------------------------------ example tabs

const note = (string, fret, fx = {}) => ({ string, fret, ...fx });
const beat = (duration, notes, extra = {}) => ({ duration, dotted: false, triplet: false, notes, ...extra });
const chord = (frets, fx) => frets.map((f, s) => (f === null ? null : note(s, f, fx))).filter(Boolean);

const GUITAR = [64, 59, 55, 50, 45, 40];
const UKULELE = [69, 64, 60, 67];

// From the "First Steps" example song.
const MELODY_1 = { section: 'Melody', beats: [beat(4, [note(1, 1)], { text: 'C' }), beat(4, [note(1, 3)]), beat(4, [note(0, 0)]), beat(4, [note(0, 3)])] };
const MELODY_2 = { beats: [beat(2, [note(0, 5)], { text: 'Am' }), beat(4, [note(0, 3)]), beat(4, [note(0, 0)])] };
const VARIATION_1 = {
  section: 'Variation',
  beats: [beat(8, [note(1, 1, { hammer: true })], { text: 'C' }), beat(8, [note(1, 3)]), beat(4, [note(0, 0)]), beat(4, [note(0, 3, { slide: true })]), beat(4, [note(0, 5)])],
};
const VARIATION_2 = { beats: [beat(2, [note(1, 8, { bend: 2 })], { text: 'Em' }), beat(4, [note(0, 0)]), beat(4, [note(1, 3)])] };

// Every technique, one or two of each.
const TECHNIQUES_1 = {
  beats: [
    beat(8, [note(2, 5, { hammer: true })]),
    beat(8, [note(2, 7)]),
    beat(8, [note(2, 7, { slide: true })]),
    beat(8, [note(2, 9)]),
    beat(4, [note(0, 7, { vibrato: true })]),
    beat(4, [note(1, 8, { bend: 2 })]),
  ],
};
const TECHNIQUES_2 = {
  beats: [
    beat(8, [note(5, 0)], { palmMute: true }),
    beat(8, [note(5, 0)], { palmMute: true }),
    beat(8, [note(4, 0, { dead: true }), note(5, 0, { dead: true })]),
    beat(8, [note(3, 5, { ghost: true })]),
    beat(4, chord([12, 12, 12, null, null, null], { harmonic: true })),
    beat(4, chord([0, 0, 0, 2, 2, 0]), { strum: 'down', text: 'Em' }),
  ],
};

// From the "Campfire Strum" ukulele example: down, down up, up down up.
const strumBar = (name, frets, section) => ({
  ...(section ? { section } : {}),
  beats: [
    beat(4, chord(frets), { strum: 'down', text: name }),
    beat(8, chord(frets), { strum: 'down' }),
    beat(4, chord(frets), { strum: 'up' }),
    beat(8, chord(frets), { strum: 'up' }),
    beat(8, chord(frets), { strum: 'down' }),
    beat(8, chord(frets), { strum: 'up' }),
  ],
});
const STRUM_C = strumBar('C', [3, 0, 0, 0], 'Strum along');
const STRUM_AM = strumBar('Am', [0, 0, 0, 2]);

// From the "Power Chord Riff" example.
const E5 = [null, null, null, null, 2, 0];
const RIFF = {
  section: 'Riff',
  beats: [
    beat(8, [note(5, 0)], { palmMute: true }),
    beat(8, [note(5, 0)], { palmMute: true }),
    beat(8, [note(5, 0)], { palmMute: true }),
    beat(8, [note(5, 0)], { palmMute: true }),
    beat(8, chord(E5), { text: 'E5' }),
    beat(8, chord(E5, { dead: true })),
    beat(4, [note(4, 5), note(5, 3)], { text: 'G5' }),
  ],
};

/**
 * The examples the pages can show, by name (data-tab="..."). fit: drop bars from the end until
 * the rest fits on one line. wide: lay out at this width and scale down a little to fit the box,
 * when that is no more than 15% smaller. cursor: where the editing cursor sits. loop: loop the
 * last bar. play: move a playhead along the whole line ('all') or the looped bar ('loop').
 */
const EXAMPLES = {
  hero: { tuning: GUITAR, tempo: 88, measures: [VARIATION_1, VARIATION_2], fit: true, play: 'all' },
  write: { tuning: GUITAR, tempo: 88, measures: [MELODY_1, MELODY_2], fit: true, cursor: { m: 0, b: 1, s: 1 } },
  techniques: { tuning: GUITAR, tempo: 90, measures: [TECHNIQUES_1, TECHNIQUES_2], wide: 470 },
  ukulele: { instrument: 'ukulele', tuning: UKULELE, tempo: 92, measures: [STRUM_C, STRUM_AM], fit: true, wide: 460 },
  riff: { tuning: GUITAR, tempo: 112, measures: [RIFF], play: 'all' },
  loop: { tuning: GUITAR, tempo: 88, measures: [MELODY_1, MELODY_2], fit: true, loop: true, play: 'loop' },
};

function exampleSong(spec, bars) {
  return normalizeSong({
    format: 'tablab',
    version: 1,
    title: 'Example',
    instrument: spec.instrument || 'guitar',
    tuning: spec.tuning,
    tempo: spec.tempo,
    timeSignature: [4, 4],
    measures: spec.measures.slice(0, bars),
  });
}

const rect = (x, y, w, h, cls) => `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0, w).toFixed(1)}" height="${h.toFixed(1)}" rx="4"/>`;
const band = ({ sys, pos }, cls) => rect(pos.left, sys.staffTop - 9, pos.right - pos.left, sys.staffBottom - sys.staffTop + 18, cls);

/** Draw the example named by el.dataset.tab to fit the box. data-trim="1" keeps it to one line, like fit. */
function drawTab(el, force = false) {
  const spec = EXAMPLES[el.dataset.tab];
  const width = Math.floor(el.clientWidth);
  if (!spec || !width || (!force && el.dataset.width === String(width))) return;
  el.dataset.width = String(width);
  const layoutWidth = spec.wide && width >= spec.wide * 0.85 ? Math.max(width, spec.wide) : width;
  const fit = spec.fit || el.dataset.trim === '1';
  let bars = spec.measures.length;
  let song;
  let timeline;
  let layout;
  for (;;) {
    song = exampleSong(spec, bars);
    timeline = buildTimeline(song);
    layout = layoutScore(song, timeline, layoutWidth, { justify: true });
    if (!fit || layout.systems.length === 1 || bars === 1) break;
    bars--;
  }
  el.innerHTML = layout.systems.map((sys) => renderSystem(song, timeline, layout, sys, { warnings: false })).join('');

  const last = song.measures.length - 1;
  const over = (sys) => $(`svg[data-sys="${sys.index}"] .tl-over`, el);
  if (spec.loop) {
    const beats = song.measures[last].beats.map((_, i) => findBeat(layout, last, i));
    over(beats[0].sys).innerHTML += beats.map((loc) => band(loc, 'tl-loop')).join('');
  }
  if (spec.cursor) {
    const { m, b, s } = spec.cursor;
    const loc = findBeat(layout, m, b);
    const y = loc.sys.staffTop + s * LS;
    const n = song.measures[m].beats[b].notes.find((x) => x.string === s);
    const w = n ? Math.max(20, String(n.fret).length * 7 + 12) : 20;
    over(loc.sys).innerHTML += band(loc, 'tl-cursor-beat') + rect(loc.pos.x - w / 2, y - 8.5, w, 17, 'tl-cursor-note');
  }
  if (spec.play) {
    const from = findBeat(layout, spec.play === 'loop' ? last : 0, 0);
    const end = findBeat(layout, last, 0);
    const sys = from.sys;
    const x0 = from.pos.left;
    const x1 = end.meas.x + end.meas.w - 3;
    const g = over(sys);
    g.insertAdjacentHTML('beforeend', `<line class="tl-playhead" x1="0" y1="${sys.staffTop - 10}" x2="0" y2="${sys.staffBottom + 10}"/>`);
    const line = g.lastElementChild;
    // Four beats a bar at the song tempo, so the playhead moves at the speed of the music.
    const seconds = ((spec.play === 'loop' ? 1 : song.measures.length) * 4 * 60) / song.tempo;
    sweep(line, x0, x1, seconds * 1000);
  }
}

/** Move a playhead from x0 to x1 over and over (or leave it part way along when motion is reduced). */
function sweep(line, x0, x1, ms) {
  if (reducedMotion.matches || !line.animate) {
    line.style.transform = `translateX(${(x0 + (x1 - x0) * 0.4).toFixed(1)}px)`;
    return;
  }
  const anim = line.animate([{ transform: `translateX(${x0}px)` }, { transform: `translateX(${x1}px)` }], { duration: ms, iterations: Infinity });
  const slide = line.closest('.slide');
  if (slide && slide.dataset.visible !== '1') anim.pause();
}

// ------------------------------------------------------------------ backing track waveform

/** A small repeatable random sequence, so the waveform looks the same on every visit. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draw a drum and strum recording with its bar lines. data-wave="steady": bar lines on the beat
 * and a playhead. data-wave="drift": the band plays a little faster than the song tempo, and
 * bar 3 is dragged onto its beat (pinned), which pulls bar 2 into place too.
 */
function drawWave(el) {
  const w = Math.floor(el.clientWidth);
  const h = Math.floor(el.clientHeight) || 132;
  if (!w || el.dataset.size === `${w}x${h}`) return;
  el.dataset.size = `${w}x${h}`;
  const drift = el.dataset.wave === 'drift';
  const top = 20;
  const mid = top + (h - top - 6) / 2;
  const amp = (h - top - 8) / 2;
  const x0 = 22;
  const beats = 11;
  const grid = (w - x0 - 8) / (beats - 0.3); // beat spacing at the song tempo
  const real = drift ? grid * 0.93 : grid; // beat spacing in the recording
  const beatX = (j, step) => x0 + j * step;

  // Waveform: a kick or snare on every beat, softer strums and hats between.
  const rnd = random(7);
  const hits = [];
  for (let j = 0; j < beats + 2; j++) {
    hits.push({ x: beatX(j, real), a: j % 2 ? 0.78 : 1 });
    hits.push({ x: beatX(j + 0.5, real), a: 0.3 });
  }
  const top0 = [];
  const bot0 = [];
  for (let x = 0; x <= w; x += 2) {
    let e = 0.05;
    for (const hit of hits) if (x >= hit.x - 1) e += hit.a * Math.exp(-(x - hit.x) / 9);
    e = Math.min(1, e) * (0.75 + 0.25 * rnd());
    top0.push(`${x},${(mid - e * amp).toFixed(1)}`);
    bot0.push(`${x},${(mid + e * amp * 0.92).toFixed(1)}`);
  }
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" aria-hidden="true">`;
  svg += `<polygon class="wv-wave" points="${top0.join(' ')} ${bot0.reverse().join(' ')}"/>`;

  // Beat ticks along the bottom, and the bar lines with their numbers.
  let ticks = '';
  for (let j = 1; j < beats + 1; j++) if (j % 4) ticks += `M${(beatX(j, real) + 0.5).toFixed(1)} ${h - 10}V${h - 2}`;
  svg += `<path class="wv-tick" d="${ticks}"/>`;
  const barLine = (k, x, pinned) => {
    const xr = Math.round(x) + 0.5;
    if (!pinned) return `<line class="wv-bar" x1="${xr}" y1="${top - 2}" x2="${xr}" y2="${h}"/><text class="wv-num" x="${xr + 3}" y="13">${k}</text>`;
    const cw = String(k).length * 6 + 10;
    return `<line class="wv-pin" x1="${xr}" y1="${top - 2}" x2="${xr}" y2="${h}"/><rect class="wv-chip" x="${xr - 1}" y="2" width="${cw}" height="15" rx="4"/><text class="wv-chipnum" x="${xr + 4}" y="13">${k}</text>`;
  };
  for (let k = 1; k <= 3; k++) {
    const real_ = beatX((k - 1) * 4, real);
    const off = beatX((k - 1) * 4, grid) - real_;
    if (!drift || k === 1) svg += barLine(k, real_, false);
    else {
      // Starts where the song tempo puts it, then moves onto the beat in the recording.
      svg += `<g class="wv-move" style="transform: translateX(${off.toFixed(1)}px)">`;
      svg += k === 3 ? `<g class="wv-before">${barLine(k, real_, false)}</g><g class="wv-after">${barLine(k, real_, true)}</g>` : barLine(k, real_, false);
      svg += '</g>';
    }
  }
  if (!drift) svg += `<line class="wv-head" x1="0" y1="0" x2="0" y2="${h}"/>`;
  svg += '</svg>';
  el.innerHTML = svg;

  const head = $('.wv-head', el);
  if (head) sweep(head, x0, beatX(beats - 1, real), (beats - 1) * 650);
}

// ------------------------------------------------------------------ light and dark

function savedTheme() {
  try {
    const t = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}').theme;
    return t === 'dark' || t === 'light' ? t : null;
  } catch (e) {
    return null;
  }
}

function systemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('#btn-theme');
  if (btn) {
    btn.innerHTML = ICONS[theme === 'dark' ? 'sun' : 'moon'];
    btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  }
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || (theme === 'dark' ? '#0e0f15' : '#f4f4f9'));
}

/** Save the choice where the app keeps it, without touching the app's other settings. */
function saveTheme(theme) {
  try {
    let prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) prefs = {};
    prefs.theme = theme;
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    /* private mode or storage full: the switch still works for this visit */
  }
}

// ------------------------------------------------------------------ slides

function setupSlides() {
  const feed = $('#feed');
  const slides = $$('.slide', feed);
  const bar = $('#progress');
  if (!feed || !slides.length) return;

  const setPlaying = (slide, on) => {
    if (!slide.getAnimations) return;
    for (const a of slide.getAnimations({ subtree: true })) {
      if (a.effect && a.effect.getTiming().iterations === Infinity) {
        if (on) a.play();
        else a.pause();
      }
    }
  };
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) e.target.classList.add('inview');
        e.target.dataset.visible = e.isIntersecting ? '1' : '0';
        setPlaying(e.target, e.isIntersecting);
      }
    },
    { root: feed, threshold: 0.55 },
  );
  slides.forEach((s) => io.observe(s));

  const onScroll = () => {
    const max = feed.scrollHeight - feed.clientHeight;
    if (bar) bar.style.width = `${max > 0 ? (feed.scrollTop / max) * 100 : 0}%`;
    if (feed.scrollTop > 40) feed.classList.add('scrolled');
  };
  feed.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Keys: down, Page Down, right or Space for the next slide; up, Page Up or left to go back.
  let target = null;
  let targetAt = 0;
  const current = () => {
    if (target !== null && performance.now() - targetAt < 700) return target;
    return Math.max(0, Math.min(slides.length - 1, Math.round(feed.scrollTop / feed.clientHeight)));
  };
  const go = (i) => {
    target = Math.max(0, Math.min(slides.length - 1, i));
    targetAt = performance.now();
    feed.scrollTo({ top: slides[target].offsetTop, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  };
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    const onControl = t && t.closest('a, button');
    let step = 0;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
      case 'PageDown':
        step = 1;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
      case 'PageUp':
        step = -1;
        break;
      case ' ':
        if (onControl) return;
        step = e.shiftKey ? -1 : 1;
        break;
      case 'Home':
        e.preventDefault();
        go(0);
        return;
      case 'End':
        e.preventDefault();
        go(slides.length - 1);
        return;
      default:
        return;
    }
    e.preventDefault();
    // On a small screen a slide can be taller than the screen: scroll through it first.
    const slide = slides[current()];
    const room = slide.scrollHeight - slide.clientHeight;
    if (room > 2 && (step > 0 ? slide.scrollTop < room - 2 : slide.scrollTop > 2)) {
      slide.scrollBy({ top: step * slide.clientHeight * 0.8, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
      return;
    }
    go(current() + step);
  });
}

// ------------------------------------------------------------------ the last slide

function setupLinks() {
  const app = new URL('./', location.href).href;
  for (const el of $$('[data-app-url]')) el.textContent = app.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const btn = $('#btn-copy');
  const msg = $('#copied');
  if (!btn || !msg) return;
  let timer = 0;
  const say = (text) => {
    msg.textContent = text;
    msg.classList.add('on');
    clearTimeout(timer);
    timer = setTimeout(() => msg.classList.remove('on'), 2200);
  };
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = app;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    ta.remove();
    return ok;
  };
  btn.addEventListener('click', async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(app);
      ok = true;
    } catch (e) {
      ok = fallback();
    }
    say(ok ? 'Copied' : app);
  });
}

// ------------------------------------------------------------------ fitting

// A slide that is too tall for the screen (a small phone, a wide font, larger text) tightens up
// before it needs scrolling inside: first less space around and between its parts, then the
// small print marked "extra" makes way, and last a long example keeps only its first line.
// Measured from the layout, so the reveal animation, which moves things down a little, does not count.
const TIGHTER = ['snug', 'snugger'];

function overflow(slide) {
  const style = getComputedStyle(slide);
  const inner = $('.inner', slide);
  return parseFloat(style.paddingTop) + (inner ? inner.offsetHeight : 0) + parseFloat(style.paddingBottom) - slide.clientHeight;
}

function setTrim(el, on) {
  if ((el.dataset.trim === '1') === on) return;
  if (on) el.dataset.trim = '1';
  else delete el.dataset.trim;
  drawTab(el, true);
}

function fitSlides() {
  for (const slide of $$('.slide')) {
    const tabs = $$('[data-tab]', slide);
    slide.classList.remove(...TIGHTER);
    for (const el of tabs) setTrim(el, false);
    for (const name of TIGHTER) {
      if (overflow(slide) <= 1) break;
      slide.classList.add(name);
    }
    if (overflow(slide) > 1) for (const el of tabs) setTrim(el, true);
  }
}

// ------------------------------------------------------------------ start

function start() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
  const btn = $('#btn-theme');
  if (btn) {
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      saveTheme(next);
    });
  }
  // Follow the system setting until a choice is saved, and follow the app open in another tab.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!savedTheme()) applyTheme(systemTheme());
  });
  window.addEventListener('storage', (e) => {
    if (e.key === PREFS_KEY) applyTheme(savedTheme() || systemTheme());
  });

  for (const el of $$('[data-icon]')) el.innerHTML = ICONS[el.dataset.icon] || '';
  // The app says Cmd on a Mac, iPhone or iPad, so these pages do too.
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
  if (/mac|iphone|ipad|ipod/i.test(platform)) for (const k of $$('kbd')) if (k.textContent === 'Ctrl') k.textContent = 'Cmd';

  const drawAll = () => {
    for (const el of $$('[data-tab]')) drawTab(el);
    for (const el of $$('[data-wave]')) drawWave(el);
    fitSlides();
  };
  drawAll();
  // Text can change size once the fonts are ready.
  if (document.fonts) document.fonts.ready.then(fitSlides);
  let queued = false;
  new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      drawAll();
    });
  }).observe($('#feed') || document.body);

  setupSlides();
  setupLinks();
  document.documentElement.setAttribute('data-ready', '');
}

start();
