// Checks that the files the app and the offline cache need are all there, and that
// the example songs are valid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSong } from '../../js/core/model.js';
import { buildTimeline } from '../../js/core/timing.js';
import { ICONS } from '../../js/ui/icons.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('every file in the offline cache list exists', () => {
  const sw = read('sw.js');
  const list = JSON.parse(sw.slice(sw.indexOf('[', sw.indexOf('const CORE')), sw.indexOf('];', sw.indexOf('const CORE')) + 1).replace(/'/g, '"').replace(/,\s*\]/, ']'));
  assert.ok(list.length > 10);
  for (const p of list) {
    if (p === './') continue;
    assert.ok(existsSync(join(ROOT, p)), `sw.js lists ${p}, which does not exist`);
  }
  // And every JavaScript module is in the list, so the app works offline.
  const modules = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = dir + '/' + name;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (name.endsWith('.js')) modules.push(rel);
    }
  };
  walk('js');
  for (const m of modules) assert.ok(list.includes(m), `${m} is missing from the offline cache list in sw.js`);
});

const PAGES = readdirSync(ROOT).filter((f) => f.endsWith('.html'));

test('every local file the pages and the manifest point to exists', () => {
  assert.deepEqual(PAGES.sort(), ['about.html', 'index.html', 'slides.html']);
  for (const page of PAGES) {
    const html = read(page);
    const refs = [...html.matchAll(/(?:src|href|content)="([^"#:]+\.(?:js|css|svg|png|webmanifest|html))"/g)].map((m) => m[1]);
    assert.ok(refs.length >= 5, page);
    for (const r of refs) assert.ok(existsSync(join(ROOT, r)), `${page} points to ${r}, which does not exist`);
    // Link previews need full addresses; they must still point at files in this repository.
    for (const [, url] of html.matchAll(/content="https:\/\/rohittabs\.github\.io\/tablab\/([^"]*)"/g)) {
      assert.ok(url === '' || existsSync(join(ROOT, url)), `${page} points to ${url}, which does not exist`);
    }
  }
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const icon of manifest.icons) assert.ok(existsSync(join(ROOT, icon.src)), `manifest icon ${icon.src} is missing`);
});

test('every page works offline and is published', () => {
  const sw = read('sw.js');
  const deploy = read('.github/workflows/pages.yml');
  const copy = deploy.split('\n').find((l) => l.includes('cp -r ') && l.includes('_site/'));
  for (const page of PAGES) {
    assert.ok(sw.includes(`'${page}'`), `${page} is missing from the offline cache list in sw.js`);
    assert.ok(copy.split(/\s+/).includes(page), `${page} is not copied to the website in pages.yml`);
  }
  // The pages' own styles are cached too.
  for (const css of readdirSync(join(ROOT, 'css'))) assert.ok(sw.includes(`'css/${css}'`), `css/${css} is missing from sw.js`);
});

test('the About page and the tour only ask for examples, drawings and icons that exist', () => {
  const tour = read('js/tour.js');
  const block = tour.slice(tour.indexOf('const EXAMPLES = {'), tour.indexOf('};', tour.indexOf('const EXAMPLES = {')));
  const examples = [...block.matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]);
  assert.ok(examples.length >= 5);
  for (const page of ['about.html', 'slides.html']) {
    const html = read(page);
    const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(tabs.length >= 4, page);
    for (const t of tabs) assert.ok(examples.includes(t), `${page} asks for the example "${t}", which js/tour.js does not have`);
    for (const [, w] of html.matchAll(/data-wave="([^"]+)"/g)) assert.ok(['steady', 'drift'].includes(w), `${page}: unknown waveform "${w}"`);
    for (const [, i] of html.matchAll(/data-icon="([^"]+)"/g)) assert.ok(ICONS[i], `${page}: unknown icon "${i}"`);
    // Every slide has a heading that names it, and ids are unique.
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, `${page} has a repeated id`);
    for (const [, label] of html.matchAll(/<section class="slide[^"]*" id="[^"]+" aria-labelledby="([^"]+)"/g)) {
      assert.ok(ids.includes(label), `${page}: a slide is labelled by "${label}", which is missing`);
    }
    // Links inside the page lead to slides that exist.
    for (const [, hash] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(hash), `${page} links to #${hash}, which is missing`);
  }
});

test('the example songs are valid and every bar is full', () => {
  const files = readdirSync(join(ROOT, 'examples')).filter((f) => f.endsWith('.tablab'));
  assert.equal(files.length, 3);
  for (const f of files) {
    const raw = JSON.parse(read('examples/' + f));
    const song = normalizeSong(raw);
    assert.deepEqual(song, raw, `${f} changes when it is checked, so it is not clean`);
    const tl = buildTimeline(song);
    tl.measures.forEach((m, i) => assert.equal(m.content, m.capacity, `${f}: bar ${i + 1} is not exactly full`));
  }
  // main.js lists the same files.
  const main = read('js/main.js');
  for (const f of files) assert.ok(main.includes(`examples/${f}`), `main.js does not offer examples/${f}`);
});

test('no long dashes in anything a person reads', () => {
  const dash = new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]");
  const files = [...PAGES, 'README.md', 'manifest.webmanifest', 'sw.js', ...readdirSync(join(ROOT, 'css')).map((f) => 'css/' + f)];
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = dir + '/' + name;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(js|mjs|tablab)$/.test(name)) files.push(rel);
    }
  };
  walk('js');
  walk('examples');
  walk('tests');
  walk('tools');
  for (const f of files) {
    const lines = read(f).split('\n');
    lines.forEach((line, i) => assert.ok(!dash.test(line), `${f}:${i + 1} has a long dash: ${line.trim()}`));
  }
});
