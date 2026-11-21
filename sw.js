// Service worker: lets TabLab open without an internet connection after the first visit.
// Network first, so a new version shows up straight away; the saved copy is used when offline.

const CACHE = 'tablab-v1';

// Everything the app needs to start. Keep in sync with the files in the repository
// (tests/unit/files.test.mjs checks that each one exists).
const CORE = [
  './',
  'index.html',
  'about.html',
  'slides.html',
  'css/theme.css',
  'css/styles.css',
  'css/tour.css',
  'manifest.webmanifest',
  'js/main.js',
  'js/core/constants.js',
  'js/core/model.js',
  'js/core/timing.js',
  'js/core/textTab.js',
  'js/ui/editor.js',
  'js/ui/render.js',
  'js/ui/storage.js',
  'js/ui/syncPanel.js',
  'js/ui/icons.js',
  'js/ui/shortcuts.js',
  'js/audio/engine.js',
  'js/audio/pluck.js',
  'js/audio/analysis.js',
  'js/tour.js',
  'assets/icons/icon.svg',
  'assets/icons/favicon.svg',
  'assets/icons/favicon-32.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'examples/first-steps.tablab',
  'examples/campfire-strum.tablab',
  'examples/power-chord-riff.tablab',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tablab-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error())),
      ),
  );
});
