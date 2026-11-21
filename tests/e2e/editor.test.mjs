// Browser tests for writing tabs: keyboard entry, note lengths, techniques, undo, dialogs.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cursor, newSong, setup, song } from './helpers.mjs';

let env;
before(async () => {
  env = await setup();
});
after(async () => {
  await env.close();
});

describe('starting up', () => {
  it('opens the first example with no errors and remembers the theme', async () => {
    const page = await env.open();
    const s = await song(page);
    assert.equal(s.title, 'First Steps');
    assert.equal(await page.locator('#systems svg.tl-system').count() > 0, true);
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
    await page.click('#btn-theme');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    await page.reload();
    await page.evaluate(() => window.tablab.ready);
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    // The same song comes back after a reload.
    assert.equal((await song(page)).id, s.id);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  it('follows the system dark mode until the user picks a theme', async () => {
    const page = await env.open({ theme: 'dark' });
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    await page.context().close();
  });
});

describe('keyboard entry', () => {
  it('types frets, two-digit frets and moves with the arrows', async () => {
    const page = await env.open();
    await newSong(page);
    await page.keyboard.press('ArrowDown'); // string 2
    await page.keyboard.press('3');
    let s = await song(page);
    assert.deepEqual(s.measures[0].beats[0].notes, [{ string: 1, fret: 3 }]);
    await page.keyboard.press('ArrowRight'); // adds a beat
    await page.keyboard.press('1');
    await page.keyboard.press('2'); // quickly: fret 12
    s = await song(page);
    assert.equal(s.measures[0].beats.length, 2);
    assert.deepEqual(s.measures[0].beats[1].notes, [{ string: 1, fret: 12 }]);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('5');
    s = await song(page);
    assert.deepEqual(s.measures[0].beats[1].notes.map((n) => [n.string, n.fret]), [[1, 12], [2, 5]]);
    // Fill the bar with quarters: the next arrow goes on into a new bar.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    s = await song(page);
    assert.equal(s.measures.length, 2);
    assert.deepEqual(await cursor(page), { m: 1, b: 0, s: 2 });
    const status = await page.textContent('#status');
    assert.match(status, /Bar 2 · beat 1 · string 3 \(G\)/);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  it('changes note lengths, dots, triplets and rests', async () => {
    const page = await env.open();
    await newSong(page);
    await page.keyboard.press('0');
    await page.keyboard.press('-'); // eighth
    let b = (await song(page)).measures[0].beats[0];
    assert.equal(b.duration, 8);
    await page.keyboard.press('=');
    await page.keyboard.press('=');
    b = (await song(page)).measures[0].beats[0];
    assert.equal(b.duration, 2);
    await page.keyboard.press('.');
    b = (await song(page)).measures[0].beats[0];
    assert.equal(b.dotted, true);
    await page.keyboard.press('t');
    b = (await song(page)).measures[0].beats[0];
    assert.equal(b.triplet, true);
    await page.keyboard.press('r');
    b = (await song(page)).measures[0].beats[0];
    assert.deepEqual(b.notes, []);
    // Toolbar buttons do the same.
    await page.click('.tool.dur[data-dur="16"]');
    b = (await song(page)).measures[0].beats[0];
    assert.equal(b.duration, 16);
    assert.equal(await page.locator('.tool.dur[data-dur="16"]').getAttribute('class').then((c) => c.includes('active')), true);
    await page.context().close();
  });

  it('adds techniques and labels', async () => {
    const page = await env.open();
    await newSong(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('5');
    for (const k of ['h', 'v', 'g', 'p', 'd']) await page.keyboard.press(k);
    let b = (await song(page)).measures[0].beats[0];
    assert.deepEqual(b.notes[0], { string: 1, fret: 5, hammer: true, vibrato: true, ghost: true });
    assert.equal(b.palmMute, true);
    assert.equal(b.strum, 'down');
    await page.keyboard.press('s'); // slide replaces hammer-on
    b = (await song(page)).measures[0].beats[0];
    assert.equal(b.notes[0].slide, true);
    assert.equal(b.notes[0].hammer, undefined);
    await page.keyboard.press('b');
    assert.equal((await song(page)).measures[0].beats[0].notes[0].bend, 2);
    await page.keyboard.press('b');
    assert.equal((await song(page)).measures[0].beats[0].notes[0].bend, 1);
    // Chord name with Shift+T and Enter.
    await page.keyboard.press('Shift+T');
    await page.waitForSelector('#dlg-ask[open]');
    await page.fill('#ask-input', 'Am7');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#dlg-ask', { state: 'hidden' });
    await page.waitForFunction(() => window.tablab.editor.song.measures[0].beats[0].text === 'Am7');
    // Section label with Shift+M.
    await page.keyboard.press('Shift+M');
    await page.fill('#ask-input', 'Chorus');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.tablab.editor.song.measures[0].section === 'Chorus');
    // Escape cancels the dialog without a change, and the keys work on the tab again.
    await page.keyboard.press('Shift+M');
    await page.fill('#ask-input', 'Nope');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#dlg-ask', { state: 'hidden' });
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'score');
    assert.equal((await song(page)).measures[0].section, 'Chorus');
    // A technique on an empty string explains what to do.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('h');
    assert.match(await page.textContent('#toast'), /Type a fret number first/);
    // The tab shows the chord, the section and the technique marks.
    const svg = await page.innerHTML('#systems');
    assert.match(svg, /Am7/);
    assert.match(svg, /Chorus/);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  it('undoes and redoes with the keyboard and the toolbar', async () => {
    const page = await env.open();
    await newSong(page);
    await page.keyboard.press('7');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('8');
    assert.equal((await song(page)).measures[0].beats.length, 2);
    await page.keyboard.press('Control+z'); // removes the 8
    assert.deepEqual((await song(page)).measures[0].beats[1].notes, []);
    await page.keyboard.press('Control+z'); // removes the added beat
    assert.equal((await song(page)).measures[0].beats.length, 1);
    await page.keyboard.press('Control+y');
    assert.equal((await song(page)).measures[0].beats.length, 2);
    await page.click('.tool[data-cmd="undo"]');
    assert.equal((await song(page)).measures[0].beats.length, 1);
    await page.click('.tool[data-cmd="redo"]');
    assert.equal((await song(page)).measures[0].beats.length, 2);
    await page.context().close();
  });

  it('selects, copies, pastes and deletes', async () => {
    const page = await env.open();
    await newSong(page);
    await page.keyboard.press('1');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('2');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Control+c');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowRight'); // new empty beat
    await page.keyboard.press('Control+v');
    let beats = (await song(page)).measures[0].beats;
    assert.deepEqual(beats.map((b) => b.notes.map((n) => n.fret)), [[1], [2], [1], [2]]);
    // Select all and delete everything.
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    const s = await song(page);
    assert.equal(s.measures.length, 1);
    assert.deepEqual(s.measures[0].beats[0].notes, []);
    await page.context().close();
  });

  it('inserts and deletes bars, and changes the time signature', async () => {
    const page = await env.open();
    await newSong(page);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    assert.equal((await song(page)).measures.length, 3);
    await page.keyboard.press('Control+Shift+Delete');
    assert.equal((await song(page)).measures.length, 2);
    await page.click('.ts-btn');
    await page.selectOption('#form-ts select[name=num]', '3');
    await page.click('#form-ts button[value=ok]');
    await page.waitForFunction(() => document.querySelector('.ts-btn').textContent === '3/4');
    const s = await song(page);
    const c = await cursor(page);
    const ts = c.m === 0 ? s.timeSignature : s.measures[c.m].timeSignature;
    assert.deepEqual(ts, [3, 4]);
    await page.context().close();
  });
});

describe('ukulele and song settings', () => {
  it('writes ukulele tab on four strings', async () => {
    const page = await env.open();
    await newSong(page, { instrument: 'ukulele', title: 'Uke' });
    let s = await song(page);
    assert.equal(s.instrument, 'ukulele');
    assert.deepEqual(s.tuning, [69, 64, 60, 67]);
    // Four string lines are drawn.
    const lines = await page.locator('#systems svg.tl-system').first().locator('.tl-string').count();
    assert.equal(lines, 4);
    // The cursor stops at string 4.
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
    assert.equal((await cursor(page)).s, 3);
    await page.keyboard.press('2');
    s = await song(page);
    assert.deepEqual(s.measures[0].beats[0].notes, [{ string: 3, fret: 2 }]);
    assert.match(await page.textContent('#btn-song'), /Ukulele/);
    await page.context().close();
  });

  it('switches a guitar song to ukulele and warns about lost notes', async () => {
    const page = await env.open();
    await newSong(page);
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('3'); // low E string
    await page.click('#btn-song');
    await page.check('#form-song input[name=instrument][value=ukulele]');
    assert.equal(await page.isVisible('#song-warn'), true);
    assert.match(await page.textContent('#song-warn'), /1 note/);
    await page.selectOption('#form-song select[name=capo]', '2');
    await page.click('#song-ok');
    await page.waitForFunction(() => window.tablab.editor.song.instrument === 'ukulele');
    const s = await song(page);
    assert.equal(s.instrument, 'ukulele');
    assert.equal(s.capo, 2);
    assert.deepEqual(s.measures[0].beats[0].notes, []);
    // Undo brings the guitar back.
    await page.keyboard.press('Control+z');
    assert.equal((await song(page)).instrument, 'guitar');
    await page.context().close();
  });
});

describe('help, files and the library', () => {
  it('shows all shortcuts with ?', async () => {
    const page = await env.open();
    await page.focus('#score');
    await page.keyboard.press('?');
    await page.waitForSelector('#dlg-help[open]');
    const text = await page.textContent('#help-body');
    for (const word of ['Hammer-on', 'Count-in', 'Practice speed', 'Undo', 'Triplet']) assert.match(text, new RegExp(word));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#dlg-help', { state: 'hidden' });
    await page.context().close();
  });

  it('exports a text tab and a .tablab file, and opens it again', async () => {
    const page = await env.open();
    await page.click('#btn-export');
    const [txt] = await Promise.all([page.waitForEvent('download'), page.click('[data-export="txt"]')]);
    assert.equal(txt.suggestedFilename(), 'First-Steps.txt');
    const text = await (await txt.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
    assert.match(text, /^First Steps/);
    assert.match(text, /e\|-/);
    const [file] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
    assert.equal(file.suggestedFilename(), 'First-Steps.tablab');
    const path = await file.path();
    // Start something else, then open the saved file.
    await newSong(page, { title: 'Other' });
    await page.setInputFiles('#file-song', path);
    await page.waitForFunction(() => window.tablab.editor.song.title === 'First Steps');
    assert.equal((await song(page)).measures.length, 8);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  it('refuses a file that is not a song', async () => {
    const page = await env.open();
    await page.setInputFiles('#file-song', { name: 'notes.tablab', mimeType: 'application/json', buffer: Buffer.from('{"hello": 1}') });
    await page.waitForFunction(() => /not a TabLab song/.test(document.querySelector('#toast').textContent));
    assert.equal((await song(page)).title, 'First Steps');
    await page.context().close();
  });

  it('lists examples and saved songs in the library', async () => {
    const page = await env.open();
    await newSong(page, { title: 'My riff' });
    await page.click('#btn-library');
    await page.waitForSelector('#dlg-library[open]');
    assert.equal(await page.locator('#lib-examples li').count(), 3);
    const saved = await page.locator('#lib-songs li .name').allTextContents();
    assert.ok(saved.includes('My riff'));
    assert.ok(saved.includes('First Steps'));
    await page.locator('#lib-examples li', { hasText: 'Campfire Strum' }).locator('button').click();
    await page.waitForFunction(() => window.tablab.editor.song.title === 'Campfire Strum');
    assert.equal((await song(page)).instrument, 'ukulele');
    // Reopen a saved song.
    await page.click('#btn-library');
    await page.locator('#lib-songs li', { hasText: 'My riff' }).locator('button.open').click();
    await page.waitForFunction(() => window.tablab.editor.song.title === 'My riff');
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });

  it('edits with the mouse: click a string to move the cursor', async () => {
    const page = await env.open();
    const box = await page.locator('#systems svg.tl-system').first().boundingBox();
    const layout = await page.evaluate(() => {
      const l = window.tablab.layout;
      const sys = l.systems[0];
      const meas = sys.measures[1];
      return { x: meas.beatsX[1].x, y: sys.staffTop + 2 * 13 };
    });
    await page.mouse.click(box.x + layout.x, box.y + layout.y);
    assert.deepEqual(await cursor(page), { m: 1, b: 1, s: 2 });
    await page.context().close();
  });
});

describe('small screens', () => {
  it('shows a number pad on touch screens that enters frets', async () => {
    const page = await env.open({ viewport: { width: 390, height: 844 }, context: { hasTouch: true, isMobile: true } });
    assert.equal(await page.isVisible('#keypad'), true);
    await newSong(page);
    await page.tap('#keypad button[data-key="ArrowDown"]');
    await page.tap('#keypad button[data-key="7"]');
    assert.deepEqual((await song(page)).measures[0].beats[0].notes, [{ string: 1, fret: 7 }]);
    // Nothing on the page is wider than the screen.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, 'page scrolls sideways by ' + overflow + 'px');
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
});
