<p align="center">
  <img src="assets/logo.svg" alt="TabLab" width="360">
</p>

<p align="center"><strong>A simple, free tab editor for guitar and ukulele students.</strong><br>
Write tabs with keyboard shortcuts, sync a backing track, change tempo, and practice with a metronome. Runs in your browser.</p>

<p align="center"><a href="https://rohittabs.github.io/tablab/"><strong>Open TabLab</strong></a> · <a href="https://rohittabs.github.io/tablab/slides.html">Two minute tour</a> · <a href="https://rohittabs.github.io/tablab/about.html">Everything it does</a></p>

---

TabLab runs in the browser. There is nothing to install and no account to make. Your songs are saved in your own browser, and nothing is sent to a server.

## What it can do

- **Guitar and ukulele tabs.** Six string guitar (standard, drop D, open tunings and more) and four string ukulele (high G, low G, D tuning, baritone). Capo support.
- **Fast keyboard entry.** Type fret numbers, move with the arrow keys, change note lengths with `-` and `=`. Every command has a shortcut (press `?` in the app to see them all).
- **Techniques.** Hammer-ons and pull-offs, slides, bends, vibrato, dead notes, ghost notes, harmonics, palm muting, strum directions, chord names and section labels.
- **Playback.** Hear the tab with a plucked string sound, with a moving playhead that follows the music.
- **Tempo, practice speed and metronome.** Set the song tempo, slow everything down (or speed it up) from 25% to 150% without changing the pitch, switch the metronome on, and use a count-in of one or two bars.
- **Loops.** Loop the current bar or any selection to practice a tricky part.
- **Backing tracks that stay in sync.** Load an MP3, M4A, WAV or OGG file. TabLab can find the tempo and the first beat for you (Auto sync), or you can tap the tempo and drag bar lines onto the beats in the waveform. If a recording speeds up or slows down, pin more bars to the music and TabLab stretches the tab between them.
- **Light and dark mode.** Follows your system setting until you pick one.
- **Export.** Download a plain text tab, copy it, print it or save it as a PDF, or save the song as a `.tablab` file to share with your teacher or friends.
- **Works offline.** After the first visit, TabLab opens without an internet connection. It can also be installed as an app from the browser menu.

## Getting started

1. Open TabLab. It starts with an example song: press **Space** to hear it.
2. Click **New** to start your own song and choose guitar or ukulele.
3. Click a string (or use the arrow keys), type a fret number, then press **→** for the next beat.
4. Pick note lengths with the buttons in the toolbar, or with `-` (shorter) and `=` (longer).
5. Press **Space** to play from the cursor, **L** to loop, **M** for the metronome, **C** for the count-in.

### Keyboard shortcuts

| Keys | What they do |
| --- | --- |
| `0` to `9` | Fret number on the current string (type two digits quickly for 10 to 24) |
| `↑` `↓` | Choose the string |
| `←` `→` | Previous or next beat (at the end of a bar, `→` adds a beat) |
| `Ctrl` + `←` `→` | Previous or next bar |
| `-` `=` | Shorter or longer note |
| `.` | Dotted note |
| `T` | Triplet |
| `R` | Rest |
| `Delete` / `Backspace` | Remove a note (on an empty beat, remove the beat) |
| `I` | Insert a beat |
| `Enter` | New bar |
| `H` `S` `B` `V` | Hammer-on or pull-off, slide, bend, vibrato |
| `X` `G` `N` `P` | Dead note, ghost note, harmonic, palm mute |
| `D` `U` | Down or up strum |
| `Shift` + `T` | Chord name or text above the beat |
| `Shift` + `M` | Section label (Verse, Chorus, ...) |
| `Space` | Play or pause |
| `L` `M` `C` | Loop, metronome, count-in |
| `[` `]` | Practice speed slower or faster |
| `Ctrl` + `Z` / `Ctrl` + `Y` | Undo and redo |
| `Ctrl` + `C` `X` `V` | Copy, cut and paste |
| `Ctrl` + `S` | Download the song file |
| `?` | All shortcuts |

On a Mac, use `Cmd` instead of `Ctrl` (the app shows `Cmd` there). On phones and tablets, an on-screen number pad appears, and the gear button next to the song title opens the song settings.

### Playing along with a backing track

1. Click **Backing track** in the player bar, then **Load audio file** (or drop an audio file onto the page).
2. Press **Auto sync**. TabLab listens for the beat and sets the tempo and the start of bar 1.
3. Press **Space** to check. If it sounds twice too fast or too slow, use **÷2** or **×2**.
4. To adjust by hand: set the tempo (or use **Tap tempo**), then drag the **1** line in the waveform onto the first beat of the song. You can also press **Bar 1 starts now** while the track plays.
5. If the band speeds up or slows down later, drag that bar's line onto its beat. It becomes a pinned bar, and the bars in between follow. Double click a pinned bar to unpin it.

The practice speed slider slows down the tab and the backing track together, and the recording keeps its pitch. In the browser tests (Chrome), the recording and the tab stay within about 3 ms of each other at normal speed, and within about 15 ms when slowed down or sped up. The audio file stays in your browser and is never uploaded.

## Run it on your own computer

TabLab is plain HTML, CSS and JavaScript with no build step. It needs to be served over `http://` (opening `index.html` straight from the disk does not work, because browsers block JavaScript modules from files).

With [Node.js](https://nodejs.org/) 18 or newer:

```sh
npm start
```

Then open <http://localhost:8080>. Any other static web server works too, for example `python3 -m http.server 8080`.

## Publish it on GitHub Pages

The repository includes a workflow that publishes the app every time `main` changes.

1. Push this project to a GitHub repository.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **GitHub Actions**.
4. Push a commit (or run the **Deploy to GitHub Pages** workflow from the **Actions** tab). The site appears at `https://<your-user-name>.github.io/<repository-name>/`.

## Tests

```sh
npm test            # unit tests (Node.js only)
npm run test:e2e    # browser tests in Chromium (run `npx playwright install chromium` once first)
```

The browser tests check keyboard entry, every toolbar command, playback timing (count-in, metronome, practice speed, loops, tempo changes while playing), backing track loading, auto sync, dragging bar lines, that the recording and the tab play together, the layout on phones, and printing.

## Browser support

Recent versions of Chrome, Edge, Firefox and Safari (desktop and mobile). Keeping the pitch while slowing down a backing track needs Chrome 86, Firefox 101 or Safari 17.2 or newer. On iPhone, TabLab asks iOS to play sound even when the silent switch is on (iOS 16.4 or newer).

## The .tablab file format

A `.tablab` file is JSON: the song settings (instrument, tuning, capo, tempo, time signature), a list of bars, each with a list of beats, each with its notes (string and fret, plus techniques), and the backing track sync settings (the audio itself is not included). See `js/core/model.js` for the full description.

## Project layout

```
index.html            the app page
about.html            everything TabLab does, as a page of slides
slides.html           the two minute tour
css/theme.css         colours for light and dark mode, and how tabs are drawn
css/styles.css        the app's layout, and printing
css/tour.css          the About page and the tour
js/main.js            connects the editor, the player and the page
js/tour.js            the About page and the tour: slides, and examples drawn by the tab renderer
js/core/              song data, timing and sync maths, text tab export
js/ui/                editor commands, tab drawing, saving, waveform panel
js/audio/             sound engine, plucked string synthesis, beat detection
examples/             example songs
assets/               logo and app icons
tests/                unit tests and browser tests
tools/                local server, example and image generators
```

## License

[MIT](LICENSE). The example songs are original pieces written for TabLab and may be used freely.
