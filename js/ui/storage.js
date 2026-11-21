// Saving: songs in localStorage (with a small library index), preferences,
// backing track audio in IndexedDB, and file download/upload helpers.

import { normalizeSong } from '../core/model.js';

const PREFIX = 'tablab.';
const INDEX_KEY = PREFIX + 'songs';
const CURRENT_KEY = PREFIX + 'current';
const PREFS_KEY = PREFIX + 'prefs';

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

export function loadPrefs(defaults) {
  return { ...defaults, ...read(PREFS_KEY, {}) };
}

export function savePrefs(prefs) {
  write(PREFS_KEY, prefs);
}

export function listSongs() {
  const list = read(INDEX_KEY, []);
  return Array.isArray(list) ? list.filter((x) => x && typeof x.id === 'string') : [];
}

/** Save a song and update the library index. Returns false when storage is full. */
export function saveSong(song) {
  const ok = write(PREFIX + 'song.' + song.id, song);
  if (!ok) return false;
  const list = listSongs().filter((x) => x.id !== song.id);
  list.unshift({ id: song.id, title: song.title, artist: song.artist, instrument: song.instrument, updated: song.updated });
  write(INDEX_KEY, list.slice(0, 500));
  write(CURRENT_KEY, song.id);
  return true;
}

export function loadSong(id) {
  const raw = read(PREFIX + 'song.' + id, null);
  if (!raw) return null;
  try {
    return normalizeSong(raw);
  } catch (e) {
    return null;
  }
}

export function deleteSong(id) {
  try {
    localStorage.removeItem(PREFIX + 'song.' + id);
  } catch (e) {
    /* ignore */
  }
  write(INDEX_KEY, listSongs().filter((x) => x.id !== id));
  deleteTrack(id).catch(() => {});
}

export function currentSongId() {
  return read(CURRENT_KEY, null);
}

// ------------------------------------------------------------------ IndexedDB for audio

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error('IndexedDB is not available'));
        return;
      }
      const req = indexedDB.open('tablab', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('tracks');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction('tracks', mode);
        const store = t.objectStore('tracks');
        const req = fn(store);
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export function saveTrack(songId, blob, name) {
  return tx('readwrite', (s) => s.put({ blob, name, type: blob.type, saved: Date.now() }, songId));
}

export function loadTrack(songId) {
  return tx('readonly', (s) => s.get(songId));
}

export function deleteTrack(songId) {
  return tx('readwrite', (s) => s.delete(songId));
}

// ------------------------------------------------------------------ files

export function safeFileName(name, ext) {
  const base = String(name || 'song').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'song';
  return base + ext;
}

export function download(filename, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function readSongFile(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('That file is too large to be a TabLab song.');
  const text = await file.text();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error('That file is not a TabLab song (it is not valid JSON).');
  }
  return normalizeSong(raw);
}
