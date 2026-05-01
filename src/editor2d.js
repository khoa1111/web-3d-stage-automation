// 2D LED mapping editor.
//
// Core features:
//   * Drag / 8-handle resize / rotate of LED rectangles
//   * Marquee (rectangle) selection on empty canvas
//   * Pan tool & view zoom
//   * Mapled overlay supports both Image and Video sources
//   * Preview render mode (video clipped to LED rectangles, optional dark mask)
//   * Emits 'transaction-start' on pointerdown that starts a mutating gesture
//     (consumed by main.js to push an undo snapshot)

import { clamp } from './utils.js';

const HANDLE = 8; // px – size of resize handles
const ROT_HANDLE_OFFSET = 22;

export class Editor2D extends EventTarget {
  constructor(canvas, ledManager) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ledManager = ledManager;
    this.container = canvas.parentElement;

    // View transform.
    this.viewScale = 1;
    this.viewTx = 0;
    this.viewTy = 0;

    // Background reference ("mapled") — Image or Video element.
    /** @type {HTMLImageElement|HTMLVideoElement|null} */
    this.mapledImage = null;
    this.mapledOpacity = 0.6;
    this.mapled = { x: 60, y: 60, scale: 1 };
    this._video = null;
    this._rafHandle = 0;

    // Tools / render modes.
    this._tool = 'select';            // 'select' | 'pan'
    this._renderMode = 'setup';       // 'setup' | 'preview'
    this._maskOutside = false;

    // Editor state.
    this.gridSize = 50;
    this.snapToGrid = true;
    this._mode = null; // 'drag'|'resize-NE'..|'rotate'|'pan'|'marquee'
    this._dragOrigin = null;
    this._dragLed = null;
    this._dragStart = null;
    this._lastPointer = null;
    this._marquee = null; // { x0, y0, x1, y1, additive }

    this._bind();
    ledManager.on('change', () => this.render());
    ledManager.on('selection', () => this.render());

    this.resize();
    this.render();
  }

  // ============ View transform helpers ============
  _toWorld(px, py) {
    return {
      x: (px - this.viewTx) / this.viewScale,
      y: (py - this.viewTy) / this.viewScale,
    };
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  setMapledImage(src) {
    // Stop previous video loop, if any.
    this._stopVideoLoop();
    if (this._video && this._video !== src) {
      try { this._video.pause(); } catch {}
      this._video = null;
    }

    this.mapledImage = src;
    if (src) {
      this.mapled.x = 60;
      this.mapled.y = 60;
      this.mapled.scale = 1;
    }
    if (src instanceof HTMLVideoElement) {
      this._video = src;
      // Drive render loop while playing.
      src.addEventListener('play', () => this._startVideoLoop());
      src.addEventListener('pause', () => { this._stopVideoLoop(); this.render(); });
      src.addEventListener('ended', () => { this._stopVideoLoop(); this.render(); });
      // If already playing when assigned:
      if (!src.paused) this._startVideoLoop();
    }
    this.render();
  }
  getVideo() { return this._video; }

  setMapledOpacity(v) { this.mapledOpacity = clamp(v, 0, 1); this.render(); }
  setGridSize(v) { this.gridSize = Math.max(1, +v || 50); this.render(); }
  setSnap(on) { this.snapToGrid = !!on; }

  setTool(tool) {
    this._tool = (tool === 'pan') ? 'pan' : 'select';
    this.container.classList.toggle('tool-pan', this._tool === 'pan');
    this.container.classList.toggle('tool-select', this._tool === 'select');
    this.dispatchEvent(new CustomEvent('tool-changed', { detail: this._tool }));
  }
  getTool() { return this._tool; }

  setRenderMode(mode) {
    this._renderMode = (mode === 'preview') ? 'preview' : 'setup';
    this.render();
  }
  getRenderMode() { return this._renderMode; }

  setMaskOutside(on) {
    this._maskOutside = !!on;
    this.render();
  }

  setViewScale(s) {
    const old = this.viewScale;
    this.viewScale = clamp(+s || 1, 0.1, 10);
    const cx = this.canvas.clientWidth / 2;
    const cy = this.canvas.clientHeight / 2;
    this.viewTx = cx - ((cx - this.viewTx) * this.viewScale / old);
    this.viewTy = cy - ((cy - this.viewTy) * this.viewScale / old);
    this.render();
  }

  resetView() {
    this.viewScale = 1; this.viewTx = 0; this.viewTy = 0;
    this.render();
  }

  // ============ Hit-testing ============
  _hitTest(wx, wy) {
    const list = this.ledManager.list();
    for (let i = list.length - 1; i >= 0; i--) {
      const led = list[i];
      const m = led.map2d;
      const local = this._toLocal(led, wx, wy);

      const rotHandleY = -ROT_HANDLE_OFFSET;
      if (
        local.x > m.w / 2 - HANDLE && local.x < m.w / 2 + HANDLE &&
        local.y > rotHandleY - HANDLE && local.y < rotHandleY + HANDLE &&
        this.ledManager.isSelected(led.id)
      ) {
        return { led, kind: 'rotate' };
      }

      const handles = this._handlePositions(m);
      for (const h of handles) {
        if (Math.abs(local.x - h.x) <= HANDLE && Math.abs(local.y - h.y) <= HANDLE) {
          if (this.ledManager.isSelected(led.id)) return { led, kind: `resize-${h.id}` };
        }
      }

      if (local.x >= 0 && local.x <= m.w && local.y >= 0 && local.y <= m.h) {
        return { led, kind: 'drag' };
      }
    }
    return null;
  }

  _handlePositions(m) {
    return [
      { id: 'NW', x: 0,        y: 0 },
      { id: 'N',  x: m.w / 2,  y: 0 },
      { id: 'NE', x: m.w,      y: 0 },
      { id: 'E',  x: m.w,      y: m.h / 2 },
      { id: 'SE', x: m.w,      y: m.h },
      { id: 'S',  x: m.w / 2,  y: m.h },
      { id: 'SW', x: 0,        y: m.h },
      { id: 'W',  x: 0,        y: m.h / 2 },
    ];
  }

  _toLocal(led, wx, wy) {
    const m = led.map2d;
    const cx = m.x + m.w / 2;
    const cy = m.y + m.h / 2;
    const dx = wx - cx, dy = wy - cy;
    const cos = Math.cos(-m.rotation), sin = Math.sin(-m.rotation);
    const lx = dx * cos - dy * sin + m.w / 2;
    const ly = dx * sin + dy * cos + m.h / 2;
    return { x: lx, y: ly };
  }

  _ledCorners(led) {
    const m = led.map2d;
    const cx = m.x + m.w / 2, cy = m.y + m.h / 2;
    const cos = Math.cos(m.rotation), sin = Math.sin(m.rotation);
    return [[0, 0], [m.w, 0], [m.w, m.h], [0, m.h]].map(([lx, ly]) => {
      const dx = lx - m.w / 2, dy = ly - m.h / 2;
      return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
    });
  }

  _ledAABB(led) {
    const cs = this._ledCorners(led);
    const xs = cs.map(c => c.x), ys = cs.map(c => c.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }

  _snap(v) {
    if (!this.snapToGrid) return v;
    return Math.round(v / this.gridSize) * this.gridSize;
  }

  // ============ Event handling ============
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._onDown(e));
    c.addEventListener('pointermove', (e) => this._onMove(e));
    c.addEventListener('pointerup', (e) => this._onUp(e));
    c.addEventListener('pointercancel', (e) => this._onUp(e));
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this._onKey(e));
    window.addEventListener('resize', () => this.resize());
    new ResizeObserver(() => this.resize()).observe(this.container);
  }

  _onDown(e) {
    this.canvas.setPointerCapture(e.pointerId);
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const w = this._toWorld(px, py);
    this._lastPointer = { px, py };

    // Pan: middle/right mouse, shift+alt, or active pan tool.
    const panMod = (e.button === 1) || (e.button === 2) || (e.shiftKey && e.altKey) || (this._tool === 'pan');
    if (panMod) {
      this._mode = 'pan';
      this._dragStart = { px, py, tx: this.viewTx, ty: this.viewTy };
      this.container.classList.add('panning');
      return;
    }

    const hit = this._hitTest(w.x, w.y);
    if (!hit) {
      // Empty space + select tool → marquee selection.
      if (!e.shiftKey) this.ledManager.clearSelection();
      this._mode = 'marquee';
      this._marquee = { x0: w.x, y0: w.y, x1: w.x, y1: w.y, additive: e.shiftKey };
      this.container.classList.add('marquee-active');
      return;
    }

    // Hit on a LED — start a mutating gesture.
    this.dispatchEvent(new CustomEvent('transaction-start', { detail: { kind: hit.kind } }));

    if (e.shiftKey) this.ledManager.toggleSelection(hit.led.id);
    else if (!this.ledManager.isSelected(hit.led.id)) this.ledManager.select(hit.led.id, false);

    this._mode = hit.kind;
    this._dragLed = hit.led;
    const m = hit.led.map2d;
    this._dragOrigin = {
      x: m.x, y: m.y, w: m.w, h: m.h, rotation: m.rotation,
      worldDown: w,
    };
  }

  _onMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    this._lastPointer = { px, py };
    if (!this._mode) {
      this._updateCursor(px, py);
      return;
    }

    if (this._mode === 'pan') {
      this.viewTx = this._dragStart.tx + (px - this._dragStart.px);
      this.viewTy = this._dragStart.ty + (py - this._dragStart.py);
      this.render();
      return;
    }

    if (this._mode === 'marquee') {
      const w = this._toWorld(px, py);
      this._marquee.x1 = w.x;
      this._marquee.y1 = w.y;
      this.render();
      return;
    }

    const w = this._toWorld(px, py);
    const led = this._dragLed;
    if (!led) return;
    const m = led.map2d;

    if (this._mode === 'drag') {
      const dx = w.x - this._dragOrigin.worldDown.x;
      const dy = w.y - this._dragOrigin.worldDown.y;
      m.x = this._snap(this._dragOrigin.x + dx);
      m.y = this._snap(this._dragOrigin.y + dy);
    } else if (this._mode === 'rotate') {
      const cx = this._dragOrigin.x + this._dragOrigin.w / 2;
      const cy = this._dragOrigin.y + this._dragOrigin.h / 2;
      let ang = Math.atan2(w.y - cy, w.x - cx) - Math.atan2(this._dragOrigin.worldDown.y - cy, this._dragOrigin.worldDown.x - cx);
      let rot = this._dragOrigin.rotation + ang;
      if (e.shiftKey) {
        const step = Math.PI / 12;
        rot = Math.round(rot / step) * step;
      }
      m.rotation = rot;
    } else if (this._mode.startsWith('resize-')) {
      this._applyResize(led, this._mode.slice('resize-'.length), w, e.shiftKey);
    }

    this.ledManager._emit('change');
    this.dispatchEvent(new CustomEvent('led-edited', { detail: led }));
  }

  _applyResize(led, handle, world, keepAspect) {
    const m = led.map2d;
    const o = this._dragOrigin;
    const cos = Math.cos(o.rotation), sin = Math.sin(o.rotation);
    const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
    const dx = world.x - cx, dy = world.y - cy;
    const lx = dx * cos + dy * sin + o.w / 2;
    const ly = -dx * sin + dy * cos + o.h / 2;

    let nx = o.x, ny = o.y, nw = o.w, nh = o.h;
    const right = o.x + o.w, bottom = o.y + o.h;

    const newRight = (h) => h.includes('E') ? this._snap(o.x + lx) : right;
    const newBottom = (h) => h.includes('S') ? this._snap(o.y + ly) : bottom;
    const newLeft = (h) => h.includes('W') ? this._snap(o.x + lx) : o.x;
    const newTop = (h) => h.includes('N') ? this._snap(o.y + ly) : o.y;

    const r = newRight(handle), b = newBottom(handle);
    const l = newLeft(handle), t = newTop(handle);

    nx = Math.min(l, r); ny = Math.min(t, b);
    nw = Math.max(8, Math.abs(r - l));
    nh = Math.max(8, Math.abs(b - t));

    if (handle === 'N' || handle === 'S') { nx = o.x; nw = o.w; }
    if (handle === 'E' || handle === 'W') { ny = o.y; nh = o.h; }

    if (keepAspect && o.w > 0 && o.h > 0) {
      const aspect = o.w / o.h;
      if (nw / nh > aspect) nw = nh * aspect;
      else nh = nw / aspect;
    }

    m.x = nx; m.y = ny; m.w = nw; m.h = nh;
    led.realW = Math.round(nw * 10);
    led.realH = Math.round(nh * 10);
    led.pixelW = Math.max(8, Math.round(led.realW / led.pixelPitch));
    led.pixelH = Math.max(8, Math.round(led.realH / led.pixelPitch));
  }

  _onUp(e) {
    try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
    if (this._mode === 'marquee') this._finalizeMarquee();
    this._mode = null;
    this._dragLed = null;
    this._dragOrigin = null;
    this._dragStart = null;
    this._marquee = null;
    this.container.classList.remove('panning');
    this.container.classList.remove('marquee-active');
    this._updateCursor(this._lastPointer?.px ?? 0, this._lastPointer?.py ?? 0);
    this.render();
  }

  _finalizeMarquee() {
    const m = this._marquee;
    if (!m) return;
    const dragDist = Math.hypot(m.x1 - m.x0, m.y1 - m.y0);
    if (dragDist < 3) return; // treat as click, not marquee
    const mx0 = Math.min(m.x0, m.x1), my0 = Math.min(m.y0, m.y1);
    const mx1 = Math.max(m.x0, m.x1), my1 = Math.max(m.y0, m.y1);
    for (const led of this.ledManager.list()) {
      const b = this._ledAABB(led);
      const intersects = mx0 < b.x1 && b.x0 < mx1 && my0 < b.y1 && b.y0 < my1;
      if (!intersects) continue;
      if (m.additive) this.ledManager.toggleSelection(led.id);
      else this.ledManager.select(led.id, true);
    }
  }

  _onWheel(e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const before = this._toWorld(px, py);
    this.viewScale = clamp(this.viewScale * factor, 0.1, 10);
    const after = this._toWorld(px, py);
    this.viewTx += (after.x - before.x) * this.viewScale;
    this.viewTy += (after.y - before.y) * this.viewScale;
    this.render();
  }

  _onKey(e) {
    const view2d = document.getElementById('view-2d');
    if (!view2d?.classList.contains('view-active')) return;
    const tag = (e.target?.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) return;

    if (e.key.toLowerCase() === 'r') {
      this.dispatchEvent(new CustomEvent('transaction-start', { detail: { kind: 'rotate-90' } }));
      for (const id of this.ledManager.selection) {
        const led = this.ledManager.get(id);
        if (!led) continue;
        led.map2d.rotation = (led.map2d.rotation || 0) + Math.PI / 2;
      }
      this.ledManager._emit('change');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const ids = [...this.ledManager.selection];
      if (!ids.length) return;
      this.dispatchEvent(new CustomEvent('transaction-start', { detail: { kind: 'delete' } }));
      for (const id of ids) this.ledManager.remove(id);
    } else if (e.key === 'Escape') {
      this.ledManager.clearSelection();
    }
  }

  _updateCursor(px, py) {
    const w = this._toWorld(px, py);
    if (this._tool === 'pan') return; // CSS handles cursor
    const hit = this._hitTest(w.x, w.y);
    if (!hit) { this.canvas.style.cursor = 'crosshair'; return; }
    if (hit.kind === 'rotate') this.canvas.style.cursor = 'crosshair';
    else if (hit.kind === 'drag') this.canvas.style.cursor = 'move';
    else if (hit.kind.startsWith('resize-')) {
      const map = { N: 'ns-resize', S: 'ns-resize', E: 'ew-resize', W: 'ew-resize',
                    NE: 'nesw-resize', SW: 'nesw-resize', NW: 'nwse-resize', SE: 'nwse-resize' };
      this.canvas.style.cursor = map[hit.kind.slice(7)] || 'default';
    }
  }

  // ============ Video loop ============
  _startVideoLoop() {
    if (this._rafHandle) return;
    const tick = () => {
      if (!this._video || this._video.paused || this._video.ended) {
        this._rafHandle = 0;
        return;
      }
      this.render();
      this._rafHandle = requestAnimationFrame(tick);
    };
    this._rafHandle = requestAnimationFrame(tick);
  }
  _stopVideoLoop() {
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    this._rafHandle = 0;
  }

  // ============ Rendering ============
  _mapledNaturalSize() {
    const src = this.mapledImage;
    if (!src) return { w: 0, h: 0 };
    if (src instanceof HTMLVideoElement) return { w: src.videoWidth || 1, h: src.videoHeight || 1 };
    return { w: src.naturalWidth || src.width || 1, h: src.naturalHeight || src.height || 1 };
  }

  render() {
    const ctx = this.ctx;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    ctx.save();
    ctx.clearRect(0, 0, W, H);

    ctx.translate(this.viewTx, this.viewTy);
    ctx.scale(this.viewScale, this.viewScale);

    this._drawGrid(W, H);

    if (this._renderMode === 'preview') {
      this._renderPreviewMode(W, H);
    } else {
      this._renderSetupMode();
    }

    this._drawMarquee();
    ctx.restore();
  }

  _renderSetupMode() {
    const ctx = this.ctx;
    if (this.mapledImage) {
      const sz = this._mapledNaturalSize();
      ctx.globalAlpha = this.mapledOpacity;
      try {
        ctx.drawImage(this.mapledImage,
          this.mapled.x, this.mapled.y,
          sz.w * this.mapled.scale, sz.h * this.mapled.scale);
      } catch {}
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(56,189,248,0.4)';
      ctx.lineWidth = 1 / this.viewScale;
      ctx.strokeRect(this.mapled.x, this.mapled.y,
        sz.w * this.mapled.scale, sz.h * this.mapled.scale);
    }
    for (const led of this.ledManager.list()) this._drawLed(led, {});
  }

  _renderPreviewMode(W, H) {
    const ctx = this.ctx;
    if (this.mapledImage) {
      const sz = this._mapledNaturalSize();
      try {
        ctx.drawImage(this.mapledImage,
          this.mapled.x, this.mapled.y,
          sz.w * this.mapled.scale, sz.h * this.mapled.scale);
      } catch {}
    }

    // Optionally mask outside LED rectangles to dark.
    if (this._maskOutside) {
      const path = new Path2D();
      // Outer cover rect — use the world-visible bounds.
      const x0 = -this.viewTx / this.viewScale;
      const y0 = -this.viewTy / this.viewScale;
      const wW = W / this.viewScale, wH = H / this.viewScale;
      path.rect(x0, y0, wW, wH);
      // Punch out each LED's rotated rect.
      for (const led of this.ledManager.list()) {
        const cs = this._ledCorners(led);
        path.moveTo(cs[0].x, cs[0].y);
        path.lineTo(cs[1].x, cs[1].y);
        path.lineTo(cs[2].x, cs[2].y);
        path.lineTo(cs[3].x, cs[3].y);
        path.closePath();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fill(path, 'evenodd');
    }

    // Draw LEDs as borders only.
    for (const led of this.ledManager.list()) this._drawLed(led, { borderOnly: true });
  }

  _drawMarquee() {
    if (!this._marquee) return;
    const ctx = this.ctx;
    const m = this._marquee;
    const x = Math.min(m.x0, m.x1), y = Math.min(m.y0, m.y1);
    const w = Math.abs(m.x1 - m.x0), h = Math.abs(m.y1 - m.y0);
    ctx.save();
    ctx.fillStyle = 'rgba(14,165,233,0.10)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(14,165,233,0.9)';
    ctx.lineWidth = 1 / this.viewScale;
    ctx.setLineDash([6 / this.viewScale, 4 / this.viewScale]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.restore();
  }

  _drawGrid(W, H) {
    const ctx = this.ctx;
    const g = this.gridSize;
    const x0 = -this.viewTx / this.viewScale;
    const y0 = -this.viewTy / this.viewScale;
    const x1 = x0 + W / this.viewScale;
    const y1 = y0 + H / this.viewScale;
    ctx.lineWidth = 1 / this.viewScale;

    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath();
    for (let x = Math.floor(x0 / g) * g; x < x1; x += g) {
      ctx.moveTo(x, y0); ctx.lineTo(x, y1);
    }
    for (let y = Math.floor(y0 / g) * g; y < y1; y += g) {
      ctx.moveTo(x0, y); ctx.lineTo(x1, y);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.beginPath();
    const G = g * 5;
    for (let x = Math.floor(x0 / G) * G; x < x1; x += G) {
      ctx.moveTo(x, y0); ctx.lineTo(x, y1);
    }
    for (let y = Math.floor(y0 / G) * G; y < y1; y += G) {
      ctx.moveTo(x0, y); ctx.lineTo(x1, y);
    }
    ctx.stroke();

    if (x0 < 0 && x1 > 0) {
      ctx.strokeStyle = 'rgba(244,63,94,0.5)';
      ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(0, y1); ctx.stroke();
    }
    if (y0 < 0 && y1 > 0) {
      ctx.strokeStyle = 'rgba(34,197,94,0.5)';
      ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x1, 0); ctx.stroke();
    }
  }

  _drawLed(led, opts = {}) {
    const ctx = this.ctx;
    const m = led.map2d;
    const selected = this.ledManager.isSelected(led.id);
    const cx = m.x + m.w / 2;
    const cy = m.y + m.h / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(m.rotation);
    ctx.translate(-m.w / 2, -m.h / 2);

    if (!opts.borderOnly) {
      // Filled body + pixel grid (Setup mode).
      ctx.fillStyle = led.color.replace('hsl', 'hsla').replace(')', ', 0.85)');
      ctx.fillRect(0, 0, m.w, m.h);

      const cellsX = Math.max(2, Math.min(40, Math.round(m.w / 12)));
      const cellsY = Math.max(2, Math.min(40, Math.round(m.h / 12)));
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 0.5 / this.viewScale;
      ctx.beginPath();
      for (let i = 1; i < cellsX; i++) {
        const x = (m.w * i) / cellsX;
        ctx.moveTo(x, 0); ctx.lineTo(x, m.h);
      }
      for (let i = 1; i < cellsY; i++) {
        const y = (m.h * i) / cellsY;
        ctx.moveTo(0, y); ctx.lineTo(m.w, y);
      }
      ctx.stroke();
    }

    // Border (always).
    ctx.strokeStyle = selected
      ? '#ffffff'
      : (opts.borderOnly ? led.color : 'rgba(255,255,255,0.5)');
    ctx.lineWidth = (selected ? 2 : (opts.borderOnly ? 1.5 : 1)) / this.viewScale;
    ctx.strokeRect(0, 0, m.w, m.h);

    // Label.
    const fontSize = Math.max(10, Math.min(16, m.h / 6)) / this.viewScale;
    ctx.fillStyle = opts.borderOnly ? '#ffffff' : 'rgba(255,255,255,0.95)';
    ctx.font = `600 ${fontSize}px Inter, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const pad = 6 / this.viewScale;
    if (!opts.borderOnly || m.h > 40 / this.viewScale) {
      ctx.fillText(led.name, pad, pad);
      if (!opts.borderOnly) {
        ctx.font = `500 ${fontSize * 0.85}px Inter, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        const info = `${led.realW}×${led.realH}mm · ${led.pixelW}×${led.pixelH}px`;
        ctx.fillText(info, pad, pad + fontSize + 2 / this.viewScale);
      }
    }

    if (selected) {
      const handles = this._handlePositions(m);
      ctx.fillStyle = '#0ea5e9';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5 / this.viewScale;
      for (const h of handles) {
        ctx.fillRect(h.x - HANDLE / 2, h.y - HANDLE / 2, HANDLE, HANDLE);
        ctx.strokeRect(h.x - HANDLE / 2, h.y - HANDLE / 2, HANDLE, HANDLE);
      }
      ctx.beginPath();
      ctx.moveTo(m.w / 2, 0);
      ctx.lineTo(m.w / 2, -ROT_HANDLE_OFFSET);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(m.w / 2, -ROT_HANDLE_OFFSET, HANDLE / 1.4, 0, Math.PI * 2);
      ctx.fillStyle = '#22c55e';
      ctx.fill(); ctx.stroke();
    }

    ctx.restore();
  }
}
