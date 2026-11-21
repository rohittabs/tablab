// Checks that the files the app and the offline cache need are all there, and that
// the example songs are valid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSong } from '../../js/core/model.js';
import { buildTimeline } from '../../js/core/timing.js';

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

test('every local file the page and the manifest point to exists', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:src|href|content)="([^"#:]+\.(?:js|css|svg|png|webmanifest))"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5);
  for (const r of refs) assert.ok(existsSync(join(ROOT, r)), `index.html points to ${r}, which does not exist`);
  const manifest = JSON.parse(read('manifest.webmanifest'));
  for (const icon of manifest.icons) assert.ok(existsSync(join(ROOT, icon.src)), `manifest icon ${icon.src} is missing`);
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
  const files = ['index.html', 'README.md', 'manifest.webmanifest', 'css/styles.css', 'sw.js'];
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
