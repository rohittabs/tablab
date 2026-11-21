// Inline SVG icons (drawn for TabLab). All use currentColor so they follow the theme.

const S = (body, { fill = false, vb = '0 0 20 20' } = {}) =>
  `<svg class="icon" viewBox="${vb}" aria-hidden="true" focusable="false" ${fill ? 'fill="currentColor" stroke="none"' : 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"'}>${body}</svg>`;

// Note values drawn as tiny note heads with stems and flags.
const head = (filled) => `<ellipse cx="8" cy="15" rx="3.6" ry="2.6" transform="rotate(-20 8 15)" ${filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.5"'}/>`;
const stem = '<line x1="11.2" y1="14" x2="11.2" y2="3" stroke="currentColor" stroke-width="1.5"/>';
const flag = (y) => `<path d="M11.2 ${y} q4 2 4.2 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`;

export const ICONS = {
  whole: `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true"><ellipse cx="10" cy="11" rx="5" ry="3.4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
  half: `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true">${head(false)}${stem}</svg>`,
  quarter: `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true">${head(true)}${stem}</svg>`,
  eighth: `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true">${head(true)}${stem}${flag(3)}</svg>`,
  sixteenth: `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true">${head(true)}${stem}${flag(3)}${flag(6.5)}</svg>`,
  thirtysecond: `<svg class="icon" viewBox="0 0 20 20" aria-hidden="true">${head(true)}${stem}${flag(2)}${flag(5)}${flag(8)}</svg>`,
  dot: S('<circle cx="10" cy="10" r="2.6"/>', { fill: true }),
  rest: S('<path d="M8 3.5l4 4.5-3.6 3.6 3.6 3.4c-2.6-1-4.6.8-2.4 3"/>'),
  play: S('<path d="M6.5 4.2v11.6a.8.8 0 0 0 1.2.7l9.2-5.8a.8.8 0 0 0 0-1.4L7.7 3.5a.8.8 0 0 0-1.2.7z"/>', { fill: true }),
  pause: S('<rect x="5" y="4" width="3.6" height="12" rx="1"/><rect x="11.4" y="4" width="3.6" height="12" rx="1"/>', { fill: true }),
  rewind: S('<path d="M5 4.5v11"/><path d="M15.5 5.2v9.6a.7.7 0 0 1-1.1.6L8 10.6a.7.7 0 0 1 0-1.2l6.4-4.8a.7.7 0 0 1 1.1.6z" fill="currentColor" stroke="none"/>'),
  loop: S('<path d="M4 9.5V8a3 3 0 0 1 3-3h8.5"/><path d="M13 2.5 15.5 5 13 7.5"/><path d="M16 10.5V12a3 3 0 0 1-3 3H4.5"/><path d="M7 17.5 4.5 15 7 12.5"/>'),
  metronome: S('<path d="M7.6 3h4.8l3.1 13.4a.8.8 0 0 1-.8 1H5.3a.8.8 0 0 1-.8-1z"/><path d="M5.4 13.5h9.2"/><path d="M10 13.5 14.6 5"/>'),
  countin: S('<text x="10" y="14.2" font-size="10.5" font-weight="700" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui, sans-serif">1-2</text>'),
  undo: S('<path d="M7.5 5 4 8.5 7.5 12"/><path d="M4.5 8.5h7.2a4.3 4.3 0 0 1 0 8.6H9"/>'),
  redo: S('<path d="M12.5 5 16 8.5 12.5 12"/><path d="M15.5 8.5H8.3a4.3 4.3 0 0 0 0 8.6H11"/>'),
  sun: S('<circle cx="10" cy="10" r="3.4"/><path d="M10 2.2v1.8M10 16v1.8M2.2 10H4M16 10h1.8M4.5 4.5l1.3 1.3M14.2 14.2l1.3 1.3M4.5 15.5l1.3-1.3M14.2 5.8l1.3-1.3"/>'),
  moon: S('<path d="M15.8 12.6A6.4 6.4 0 0 1 7.4 4.2a6.4 6.4 0 1 0 8.4 8.4z"/>'),
  help: S('<circle cx="10" cy="10" r="7.6"/><path d="M7.8 7.8a2.3 2.3 0 1 1 3.2 2.1c-.6.3-1 .8-1 1.5v.4"/><circle cx="10" cy="14.4" r=".6" fill="currentColor"/>'),
  keyboard: S('<rect x="2.5" y="5" width="15" height="10" rx="2"/><path d="M5.5 8h.01M8.5 8h.01M11.5 8h.01M14.5 8h.01M5.5 11h.01M14.5 11h.01M8 12h4"/>'),
  file: S('<path d="M11.5 2.8H6a1.5 1.5 0 0 0-1.5 1.5v11.4A1.5 1.5 0 0 0 6 17.2h8a1.5 1.5 0 0 0 1.5-1.5V6.8z"/><path d="M11.5 2.8v4h4"/><path d="M10 9.5v5M7.5 12h5"/>'),
  folder: S('<path d="M2.8 6.2A1.6 1.6 0 0 1 4.4 4.6h3.3l1.8 1.9h6.1a1.6 1.6 0 0 1 1.6 1.6v6.5a1.6 1.6 0 0 1-1.6 1.6H4.4a1.6 1.6 0 0 1-1.6-1.6z"/>'),
  save: S('<path d="M10 3v9"/><path d="M6.5 8.8 10 12.3l3.5-3.5"/><path d="M4 13.5v1.8A1.7 1.7 0 0 0 5.7 17h8.6a1.7 1.7 0 0 0 1.7-1.7v-1.8"/>'),
  share: S('<path d="M10 12.5V3.2"/><path d="M6.6 6.2 10 2.8l3.4 3.4"/><path d="M4.5 10v5.3A1.7 1.7 0 0 0 6.2 17h7.6a1.7 1.7 0 0 0 1.7-1.7V10"/>'),
  wave: S('<path d="M2.5 10h1.5M5.5 7v6M8 4.5v11M10.5 7.5v5M13 5.5v9M15.5 8v4M17.5 10h.01"/>'),
  close: S('<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>'),
  gear: S('<circle cx="10" cy="10" r="2.6"/><path d="M10 2.6v2M10 15.4v2M17.4 10h-2M4.6 10h-2M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4M15.2 15.2l-1.4-1.4M6.2 6.2 4.8 4.8"/>'),
  volume: S('<path d="M3.5 7.8h2.6L10 4.5v11l-3.9-3.3H3.5z"/><path d="M13 7.2a4 4 0 0 1 0 5.6M15.2 5a7 7 0 0 1 0 10"/>'),
  guitar: S('<path d="M14.2 2.8l3 3-1.6 1.6-.9-.2-3.3 3.3"/><path d="M11.4 10.5a3.4 3.4 0 0 1-1 3.9c-1.5 1.5-1.6 2.9-3.4 2.9A3.9 3.9 0 0 1 2.7 13c0-1.8 1.4-1.9 2.9-3.4a3.4 3.4 0 0 1 3.9-1"/><circle cx="7.3" cy="12.7" r="1.2"/>'),
  plusBar: S('<path d="M4 4v12M16 4v12"/><path d="M10 7v6M7 10h6"/>'),
  minusBar: S('<path d="M4 4v12M16 4v12"/><path d="M7 10h6"/>'),
  flag: S('<path d="M5 17.5V3"/><path d="M5 3.8h9.2l-2 3.2 2 3.2H5"/>'),
  text: S('<path d="M4.5 5h11M10 5v11"/>'),
  strumDown: S('<path d="M10 3v13"/><path d="M5.8 11.8 10 16l4.2-4.2"/>'),
  strumUp: S('<path d="M10 17V4"/><path d="M5.8 8.2 10 4l4.2 4.2"/>'),
  tap: S('<path d="M9 9.5V4.2a1.4 1.4 0 0 1 2.8 0v5"/><path d="M11.8 8.6a1.4 1.4 0 0 1 2.7.4v1.5"/><path d="M14.5 10a1.4 1.4 0 0 1 2.6.6v2.2a5.2 5.2 0 0 1-5.2 5.2h-.6A5.2 5.2 0 0 1 7 15.6l-2.4-3.7a1.3 1.3 0 0 1 2-1.6L9 12.5"/>'),
  sparkle: S('<path d="M10 2.8 11.6 8.4 17.2 10 11.6 11.6 10 17.2 8.4 11.6 2.8 10 8.4 8.4z"/>'),
  zoomIn: S('<circle cx="8.8" cy="8.8" r="5.3"/><path d="M12.8 12.8 17 17M6.6 8.8h4.4M8.8 6.6v4.4"/>'),
  zoomOut: S('<circle cx="8.8" cy="8.8" r="5.3"/><path d="M12.8 12.8 17 17M6.6 8.8h4.4"/>'),
  fit: S('<path d="M3 7V4.5A1.5 1.5 0 0 1 4.5 3H7M13 3h2.5A1.5 1.5 0 0 1 17 4.5V7M17 13v2.5a1.5 1.5 0 0 1-1.5 1.5H13M7 17H4.5A1.5 1.5 0 0 1 3 15.5V13"/>'),
  trash: S('<path d="M4 5.5h12M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5.5 5.5l.8 10.4a1.3 1.3 0 0 0 1.3 1.1h4.8a1.3 1.3 0 0 0 1.3-1.1l.8-10.4"/>'),
  music: S('<path d="M7.5 15.2V4.6l9-1.8v10.6"/><circle cx="5.6" cy="15.2" r="2"/><circle cx="14.6" cy="13.4" r="2"/>'),
};

export function icon(name) {
  return ICONS[name] || '';
}
