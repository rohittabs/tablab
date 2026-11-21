// Render SVG files to PNG with the pre-installed Chromium (used for icons and previews).
// Usage: node tools/render-svg.mjs <in.svg> <out.png> <width> <height> [background] [color]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
import { readFileSync } from 'node:fs';
const [input, output, w, h, bg = 'transparent', color = '#1c1d29'] = process.argv.slice(2);
const svg = readFileSync(input, 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
await page.setContent(`<!doctype html><html><body style="margin:0;background:${bg};color:${color}">
<div style="width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center">${svg.replace('<svg ', `<svg style="width:${w}px;height:${h}px" `)}</div></body></html>`);
await page.screenshot({ path: output, omitBackground: bg === 'transparent' });
await browser.close();
