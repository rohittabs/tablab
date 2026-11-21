// Backing track waveform with bar lines. Drag bar 1 to set where the song starts in the
// recording; drag any other bar line to pin it to the recording (a sync point).

export class SyncPanel {
  constructor(canvas, handlers) {
    this.canvas = canvas;
    this.h = handlers; // { state(), onOffset(t, final), onPin(m, t, final), onUnpin(m), onSeek(t), onDragStart() }
    this.view = { start: 0, pps: 60 };
    this.drag = null;
    this.colors = null;
    this._raf = 0;
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e, true));
    canvas.addEventListener('dblclick', (e) => this._dbl(e));
    canvas.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    canvas.addEventListener('keydown', (e) => this._key(e));
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  refreshColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    this.colors = { wave: v('--wave'), bar: v('--tab-bar'), accent: v('--accent'), play: v('--play'), muted: v('--muted'), ink: v('--ink'), bg: v('--surface-2'), paper: v('--paper'), amber: v('--amber') };
    this.draw();
  }

  _x(t) {
    return (t - this.view.start) * this.view.pps;
  }

  _t(x) {
    return this.view.start + x / this.view.pps;
  }

  fit() {
    const st = this.h.state();
    if (!st.track) return;
    const w = this.canvas.clientWidth || 600;
    this.view.pps = Math.max(2, (w - 20) / Math.max(1, st.track.duration));
    this.view.start = -10 / this.view.pps;
    this.draw();
  }

  zoom(factor, aroundX) {
    const w = this.canvas.clientWidth || 600;
    const x = aroundX === undefined ? w / 2 : aroundX;
    const t = this._t(x);
    this.view.pps = Math.min(800, Math.max(2, this.view.pps * factor));
    this.view.start = t - x / this.view.pps;
    this._clamp();
    this.draw();
  }

  /** Make sure time t is visible (used to follow the playhead). */
  follow(t) {
    const w = this.canvas.clientWidth || 600;
    const x = this._x(t);
    if (x < 20 || x > w - 40) {
      this.view.start = t - 60 / this.view.pps;
      this._clamp();
    }
  }

  /** Centre the view on time t. */
  show(t) {
    const w = this.canvas.clientWidth || 600;
    this.view.start = t - w / 3 / this.view.pps;
    this._clamp();
    this.draw();
  }

  _clamp() {
    const st = this.h.state();
    const dur = st.track ? st.track.duration : 60;
    const w = this.canvas.clientWidth || 600;
    const maxStart = Math.max(0, dur - (w - 40) / this.view.pps);
    this.view.start = Math.max(-40 / this.view.pps, Math.min(maxStart, this.view.start));
  }

  /** Bar lines inside the view: [{ m, t, x, pinned }] */
  _bars() {
    const st = this.h.state();
    if (!st.map || !st.timeline) return [];
    const pinned = new Set((st.song.backingTrack ? st.song.backingTrack.syncPoints : []).map((p) => p.measure));
    const w = this.canvas.clientWidth || 600;
    const out = [];
    for (const mt of st.timeline.measures) {
      const t = st.map.tickToTime(mt.start);
      const x = this._x(t);
      if (x < -20 || x > w + 20) continue;
      out.push({ m: mt.index, t, x, pinned: mt.index === 0 || pinned.has(mt.index) });
    }
    return out;
  }

  draw() {
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(() => this._draw());
  }

  _draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    if (!this.colors) this.refreshColors();
    const col = this.colors;
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const st = this.h.state();
    const top = 20;
    const mid = top + (h - top - 6) / 2;
    const amp = (h - top - 8) / 2;
    if (!st.track) {
      g.fillStyle = col.muted;
      g.font = '13px system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText('No audio loaded', w / 2, h / 2 + 4);
      return;
    }
    // Waveform
    const peaks = st.track.peaks;
    if (peaks) {
      let norm = 0;
      for (let i = 0; i < peaks.max.length; i += 7) norm = Math.max(norm, peaks.max[i], -peaks.min[i]);
      norm = norm || 1;
      g.fillStyle = col.wave;
      for (let px = 0; px < w; px++) {
        const t0 = this._t(px);
        const t1 = this._t(px + 1);
        if (t1 < 0 || t0 > st.track.duration) continue;
        let a = Math.max(0, Math.floor(t0 * peaks.rate));
        const b = Math.min(peaks.max.length, Math.max(a + 1, Math.ceil(t1 * peaks.rate)));
        let lo = 0;
        let hi = 0;
        for (; a < b; a++) {
          if (peaks.min[a] < lo) lo = peaks.min[a];
          if (peaks.max[a] > hi) hi = peaks.max[a];
        }
        const y0 = mid - (hi / norm) * amp;
        const y1 = mid - (lo / norm) * amp;
        g.fillRect(px, y0, 1, Math.max(1, y1 - y0));
      }
    }
    // Track edges
    g.fillStyle = col.bg;
    const xStart = this._x(0);
    if (xStart > 0) {
      g.globalAlpha = 0.6;
      g.fillStyle = col.muted;
      g.fillRect(0, top, Math.min(w, xStart), h - top);
      g.globalAlpha = 1;
    }
    // Beat ticks
    if (st.map && st.timeline) {
      const beatSec = (60 / st.song.tempo);
      if (beatSec * this.view.pps > 14) {
        g.strokeStyle = col.bar;
        g.globalAlpha = 0.35;
        g.beginPath();
        for (const mt of st.timeline.measures) {
          const unit = (960 * 4) / mt.ts[1];
          for (let k = 1; k * unit < mt.length; k++) {
            const x = this._x(st.map.tickToTime(mt.start + k * unit));
            if (x < 0 || x > w) continue;
            g.moveTo(Math.round(x) + 0.5, h - 10);
            g.lineTo(Math.round(x) + 0.5, h - 2);
          }
        }
        g.stroke();
        g.globalAlpha = 1;
      }
      // End of the tab
      const xEnd = this._x(st.map.tickToTime(st.timeline.totalTicks));
      if (xEnd < w) {
        g.globalAlpha = 0.18;
        g.fillStyle = col.muted;
        g.fillRect(Math.max(0, xEnd), top, w - Math.max(0, xEnd), h - top);
        g.globalAlpha = 1;
      }
    }
    // Bar lines and numbers
    const bars = this._bars();
    let lastLabelX = -1e9;
    g.font = '600 10px system-ui, sans-serif';
    g.textAlign = 'left';
    for (const bar of bars) {
      const x = Math.round(bar.x) + 0.5;
      g.strokeStyle = bar.pinned ? col.accent : col.bar;
      g.lineWidth = bar.pinned ? 2 : 1;
      g.globalAlpha = bar.pinned ? 1 : 0.7;
      g.beginPath();
      g.moveTo(x, top - 2);
      g.lineTo(x, h);
      g.stroke();
      g.globalAlpha = 1;
      const label = String(bar.m + 1);
      if (bar.pinned) {
        const tw = g.measureText(label).width + 10;
        g.fillStyle = col.accent;
        roundRect(g, x - 1, 2, tw, 15, 4);
        g.fill();
        g.fillStyle = col.paper;
        g.fillText(label, x + 4, 13);
        lastLabelX = x + tw;
      } else if (x - lastLabelX > 22) {
        g.fillStyle = col.muted;
        g.fillText(label, x + 3, 13);
        lastLabelX = x + g.measureText(label).width + 3;
      }
    }
    g.lineWidth = 1;
    // Playhead
    if (st.playTime !== null && st.playTime !== undefined) {
      const x = Math.round(this._x(st.playTime)) + 0.5;
      if (x >= 0 && x <= w) {
        g.strokeStyle = col.play;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
        g.lineWidth = 1;
      }
    }
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _barAt(x) {
    let best = null;
    for (const bar of this._bars()) {
      const d = Math.abs(bar.x - x);
      const reach = bar.pinned ? 9 : 6;
      if (d <= reach && (!best || d < best.d || (bar.pinned && !best.bar.pinned && d < best.d + 3))) best = { bar, d };
    }
    return best ? best.bar : null;
  }

  _limits(m) {
    // A bar can move only between its pinned neighbours.
    const st = this.h.state();
    const pins = [{ measure: 0, time: st.song.backingTrack.offset }, ...st.song.backingTrack.syncPoints].sort((a, b) => a.measure - b.measure);
    let lo = -Infinity;
    let hi = Infinity;
    for (const p of pins) {
      if (p.measure < m) lo = Math.max(lo, p.time + 0.05);
      if (p.measure > m) hi = Math.min(hi, p.time - 0.05);
    }
    return { lo, hi };
  }

  _down(e) {
    const st = this.h.state();
    if (!st.track || !st.song.backingTrack) return;
    const { x } = this._pos(e);
    this.canvas.setPointerCapture(e.pointerId);
    const bar = this._barAt(x);
    if (bar) {
      this.drag = { kind: 'bar', m: bar.m, startX: x, moved: false, limits: this._limits(bar.m) };
      if (this.h.onDragStart) this.h.onDragStart();
    } else {
      this.drag = { kind: 'pan', startX: x, start: this.view.start, moved: false };
    }
    this.canvas.classList.add('dragging');
  }

  _move(e) {
    const { x } = this._pos(e);
    if (!this.drag) {
      this.canvas.style.cursor = this._barAt(x) ? 'ew-resize' : '';
      return;
    }
    if (Math.abs(x - this.drag.startX) > 3) this.drag.moved = true;
    if (!this.drag.moved) return;
    if (this.drag.kind === 'pan') {
      this.view.start = this.drag.start - (x - this.drag.startX) / this.view.pps;
      this._clamp();
      this.draw();
    } else {
      const { lo, hi } = this.drag.limits;
      const t = Math.min(hi, Math.max(lo, this._t(x)));
      if (this.drag.m === 0) this.h.onOffset(round3(t), false);
      else this.h.onPin(this.drag.m, round3(t), false);
    }
  }

  _up(e, cancelled = false) {
    const d = this.drag;
    this.drag = null;
    this.canvas.classList.remove('dragging');
    if (!d || cancelled) return;
    const { x } = this._pos(e);
    if (!d.moved) {
      this.h.onSeek(Math.max(0, this._t(x)));
      return;
    }
    if (d.kind === 'bar') {
      const t = Math.min(d.limits.hi, Math.max(d.limits.lo, this._t(x)));
      if (d.m === 0) this.h.onOffset(round3(t), true);
      else this.h.onPin(d.m, round3(t), true);
    }
  }

  _dbl(e) {
    const { x } = this._pos(e);
    const bar = this._barAt(x);
    if (bar && bar.m > 0 && bar.pinned) this.h.onUnpin(bar.m);
  }

  _wheel(e) {
    const st = this.h.state();
    if (!st.track) return;
    e.preventDefault();
    const { x } = this._pos(e);
    if (e.ctrlKey || e.metaKey) this.zoom(e.deltaY < 0 ? 1.25 : 0.8, x);
    else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.view.start += d / this.view.pps;
      this._clamp();
      this.draw();
    }
  }

  _key(e) {
    const step = 80 / this.view.pps;
    if (e.key === 'ArrowLeft') this.view.start -= step;
    else if (e.key === 'ArrowRight') this.view.start += step;
    else if (e.key === '+' || e.key === '=') return this.zoom(1.25), e.preventDefault(), e.stopPropagation();
    else if (e.key === '-') return this.zoom(0.8), e.preventDefault(), e.stopPropagation();
    else return;
    e.preventDefault();
    e.stopPropagation();
    this._clamp();
    this.draw();
  }
}

function round3(t) {
  return Math.round(t * 1000) / 1000;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
