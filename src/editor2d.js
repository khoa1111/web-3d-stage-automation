// 2D LED mapping editor.
//
// Core features:
//   * Drag / 8-handle resize / rotate of LED rectangles
//   * Pan tool & view zoom
//   * Mapled tool: drag and uniform-scale the mapled overlay; auto-fit to active group
//   * Per-group mapled state (each LED group has its own image/video/position)
//   * Lock-aware hit-testing (locked LEDs cannot be selected or moved)
//   * Preview render mode (video clipped to LED rectangles, optional dark mask)
//   * Emits 'transaction-start' on pointerdown that starts a mutating gesture
//     (consumed by main.js to push an undo snapshot)
//   * Emits 'mapled-changed' / 'group-changed' for the 3D overlay to consume

import { clamp } from './utils.js';

const HANDLE = 8; // px – size of resize handles
const ROT_HANDLE_OFFSET = 22;

// "All" sentinel — when active, every LED is shown but no per-group mapled is
// drawn. Internally tracked as a special activeGroup value.
export const GROUP_ALL = '__all__';

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

    // Per-group mapled state. Key is the group name ('' for ungrouped).
    /** @type {Map<string, { image: any, x:number, y:number, scale:number, opacity:number }>} */
    this._groups = new Map();
    this.activeGroup = '';

    this._video = null;
    this._rafHandle = 0;

    // Tools / render modes.
    this._tool = 'select';            // 'select' | 'pan' | 'mapled'
    this._renderMode = 'setup';       // 'setup' | 'preview'
    this._maskOutside = false;
    this._overlay3dEnabled = true;

    // Editor state.
    this.gridSize = 50;
    this.snapToGrid = true;
    this._mode = null;
    this._dragOrigin = null;
    this._dragLed = null;
    this._dragStart = null;
    this._lastPointer = null;

    this._mapledEmitTimer = 0;

    this._bind();
    ledManager.on('change', () => this.render());
    ledManager.on('selection', () => this.render());

    this.resize();
    this.render();
  }

  // ============ Per-group mapled accessors ============
  _ensureGroup(name) {
    if (!this._groups.has(name)) {
      this._groups.set(name, { image: null, x: 60, y: 60, scale: 1, opacity: 0.6, overlayHidden: false });
    }
    return this._groups.get(name);
  }

  // Iterate (groupName, state) pairs for every group that has any state.
  groupsWithState() { return [...this._groups.entries()]; }

  // Drop a group's mapled state (used when un-grouping or removing the group).
  forgetGroup(name) {
    const g = this._groups.get(name);
    if (!g) return;
    if (g.image instanceof HTMLVideoElement) {
      try { g.image.pause(); } catch {}
    }
    this._groups.delete(name);
    this.dispatchEvent(new CustomEvent('mapled-changed', { detail: { group: name } }));
  }

  // Per-group overlay visibility for the 3D mapled overlay.
  setGroupOverlayHidden(name, hidden) {
    const g = this._ensureGroup(name);
    g.overlayHidden = !!hidden;
    this.dispatchEvent(new CustomEvent('group-overlay-toggled', { detail: { group: name, hidden: g.overlayHidden } }));
  }
  getGroupOverlayHidden(name) {
    return !!this._groups.get(name)?.overlayHidden;
  }
  _currentMapled() {
    if (this.activeGroup === GROUP_ALL) return null;
    return this._groups.get(this.activeGroup) || null;
  }
  _activeKey() { return this.activeGroup === GROUP_ALL ? '' : this.activeGroup; }

  // Backwards-compatible properties (auto-save / undo read these directly).
  get mapledImage() { return this._currentMapled()?.image || null; }
  get mapled() {
    const g = this._currentMapled();
    return g ? { x: g.x, y: g.y, scale: g.scale } : { x: 60, y: 60, scale: 1 };
  }
  set mapled(v) {
    if (!v) return;
    const g = this._ensureGroup(this._activeKey());
    if (typeof v.x === 'number') g.x = v.x;
    if (typeof v.y === 'number') g.y = v.y;
    if (typeof v.scale === 'number') g.scale = v.scale;
    this.render();
  }
  get mapledOpacity() {
    const g = this._currentMapled();
    return g ? g.opacity : 0.6;
  }
  set mapledOpacity(v) {
    const g = this._ensureGroup(this._activeKey());
    g.opacity = clamp(+v, 0, 1);
    this.render();
  }

  setActiveGroup(name) {
    const v = (name == null) ? '' : String(name);
    if (v === this.activeGroup) return;

    const prev = this._currentMapled();
    if (prev?.image instanceof HTMLVideoElement && !prev.image.paused) {
      try { prev.image.pause(); } catch {}
    }
    this._stopVideoLoop();

    this.activeGroup = v;

    const cur = this._currentMapled();
    this._video = (cur?.image instanceof HTMLVideoElement) ? cur.image : null;
    if (this._video && !this._video.paused) this._startVideoLoop();

    this.render();
    this.dispatchEvent(new CustomEvent('group-changed', { detail: v }));
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
    const key = this._activeKey();
    const g = this._ensureGroup(key);

    this._stopVideoLoop();
    if (g.image instanceof HTMLVideoElement && g.image !== src) {
      try { g.image.pause(); } catch {}
    }
    if (this._video && this._video !== src) {
      try { this._video.pause(); } catch {}
      this._video = null;
    }

    g.image = src;
    if (src) {
      g.x = 60; g.y = 60; g.scale = 1;
    }
    if (src instanceof HTMLVideoElement) {
      this._video = src;
      src.addEventListener('play', () => this._startVideoLoop());
      src.addEventListener('pause', () => { this._stopVideoLoop(); this.render(); });
      src.addEventListener('ended', () => { this._stopVideoLoop(); this.render(); });
      if (!src.paused) this._startVideoLoop();
    }
    this.render();
    this._emitMapledChanged();
  }

  getVideo() {
    const cur = this._currentMapled();
    return (cur?.image instanceof HTMLVideoElement) ? cur.image : null;
  }
  getVideoFor(groupName) {
    const g = this._groups.get(groupName == null ? '' : String(groupName));
    return (g?.image instanceof HTMLVideoElement) ? g.image : null;
  }

  setMapledOpacity(v) {
    this.mapledOpacity = v;
    this._emitMapledChanged();
  }
  setGridSize(v) { this.gridSize = Math.max(1, +v || 50); this.render(); }
  setSnap(on) { this.snapToGrid = !!on; }

  setTool(tool) {
    if (tool === 'pan') this._tool = 'pan';
    else if (tool === 'mapled') this._tool = 'mapled';
    else this._tool = 'select';
    this.container.classList.toggle('tool-pan', this._tool === 'pan');
    this.container.classList.toggle('tool-select', this._tool === 'select');
    this.container.classList.toggle('tool-mapled', this._tool === 'mapled');
    this.dispatchEvent(new CustomEvent('tool-changed', { detail: this._tool }));
    this.render();
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

  setOverlay3dEnabled(on) {
    this._overlay3dEnabled = !!on;
    this.dispatchEvent(new CustomEvent('overlay-3d-toggled', { detail: this._overlay3dEnabled }));
  }
  getOverlay3dEnabled() { return this._overlay3dEnabled; }

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

  // ============ Auto-fit mapled to active group ============
  autoFitMapled() {
    const cur = this._currentMapled();
    if (!cur || !cur.image) return false;
    const leds = this._activeGroupLeds().filter(l => !l.hidden);
    if (!leds.length) return false;

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const led of leds) {
      const cs = this._ledCorners(led);
      for (const c of cs) {
        if (c.x < x0) x0 = c.x;
        if (c.y < y0) y0 = c.y;
        if (c.x > x1) x1 = c.x;
        if (c.y > y1) y1 = c.y;
      }
    }
    const aw = x1 - x0, ah = y1 - y0;
    if (aw <= 0 || ah <= 0) return false;

    const sz = this._mapledNaturalSize(cur.image);
    if (!sz.w || !sz.h) return false;

    const sX = aw / sz.w;
    const sY = ah / sz.h;
    const s = Math.max(sX, sY);
    const finalW = sz.w * s;
    const finalH = sz.h * s;

    this.dispatchEvent(new CustomEvent('transaction-start', { detail: { kind: 'mapled-fit' } }));
    cur.scale = s;
    cur.x = x0 + (aw - finalW) / 2;
    cur.y = y0 + (ah - finalH) / 2;
    this.render();
    this._emitMapledChanged();
    return true;
  }

  _activeGroupLeds() {
    if (this.activeGroup === GROUP_ALL) return this.ledManager.list();
    return this.ledManager.list().filter(l => (l.group || '') === this.activeGroup);
  }

  // ============ Hit-testing ============
  _hitTest(wx, wy) {
    if (this._tool === 'mapled') return this._hitTestMapled(wx, wy);

    const list = this.ledManager.list();
    for (let i = list.length - 1; i >= 0; i--) {
      const led = list[i];
      // Locked LEDs and LEDs outside the active group are not interactive.
      if (led.locked) continue;
      if (this.activeGroup !== GROUP_ALL && (led.group || '') !== this.activeGroup) continue;

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

  _hitTestMapled(wx, wy) {
    const cur = this._currentMapled();
    if (!cur || !cur.image) return null;
    const sz = this._mapledNaturalSize(cur.image);
    const w = sz.w * cur.scale, h = sz.h * cur.scale;
    const x = cur.x, y = cur.y;
    const slop = (HANDLE + 4) / this.viewScale;

    const corners = [
      { id: 'NW', x: x,         y: y },
      { id: 'NE', x: x + w,     y: y },
      { id: 'SE', x: x + w,     y: y + h },
      { id: 'SW', x: x,         y: y + h },
      { id: 'N',  x: x + w / 2, y: y },
      { id: 'E',  x: x + w,     y: y + h / 2 },
      { id: 'S',  x: x + w / 2, y: y + h },
      { id: 'W',  x: x,         y: y + h / 2 },
    ];
    for (const c of corners) {
      if (Math.abs(wx - c.x) <= slop && Math.abs(wy - c.y) <= slop) {
        return { kind: `mapled-resize-${c.id}` };
      }
    }
    if (wx >= x && wx <= x + w && wy >= y && wy <= y + h) {
      return { kind: 'mapled-drag' };
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

    const panMod = (e.button === 1) || (e.button === 2) || (e.shiftKey && e.altKey) || (this._tool === 'pan');
    if (panMod) {
      this._mode = 'pan';
      this._dragStart = { px, py, tx: this.viewTx, ty: this.viewTy };
      this.container.classList.add('panning');
      return;
    }

    const hit = this._hitTest(w.x, w.y);

    // Mapled tool: drag/resize the mapled overlay.
    if (this._tool === 'mapled') {
      if (!hit) return;
      const cur = this._ensureGroup(this._activeKey());
      this.dispatchEvent(new CustomEvent('transaction-start', { detail: { kind: 'mapled-move' } }));
      this._mode = hit.kind;
      const sz = this._mapledNaturalSize(cur.image);
      this._dragOrigin = {
        x: cur.x, y: cur.y, scale: cur.scale,
        natW: sz.w, natH: sz.h,
        worldDown: w,
      };
      return;
    }

    // Empty canvas just clears selection.
    if (!hit) {
      if (!e.shiftKey) this.ledManager.clearSelection();
      return;
    }

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

    const w = this._toWorld(px, py);

    if (this._mode === 'mapled-drag' || this._mode.startsWith('mapled-resize-')) {
      this._applyMapledTransform(w);
      this.render();
      this._emitMapledChanged();
      return;
    }

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

  _applyMapledTransform(world) {
    const cur = this._ensureGroup(this._activeKey());
    const o = this._dragOrigin;
    if (!o) return;

    if (this._mode === 'mapled-drag') {
      cur.x = o.x + (world.x - o.worldDown.x);
      cur.y = o.y + (world.y - o.worldDown.y);
      return;
    }

    const handle = this._mode.slice('mapled-resize-'.length);
    const w0 = o.natW * o.scale;
    const h0 = o.natH * o.scale;
    // Anchor = the opposite corner / edge-midpoint that should stay put.
    const anchors = {
      NW: { ax: o.x + w0,     ay: o.y + h0 },
      NE: { ax: o.x,          ay: o.y + h0 },
      SE: { ax: o.x,          ay: o.y },
      SW: { ax: o.x + w0,     ay: o.y },
      N:  { ax: o.x + w0 / 2, ay: o.y + h0 },
      S:  { ax: o.x + w0 / 2, ay: o.y },
      E:  { ax: o.x,          ay: o.y + h0 / 2 },
      W:  { ax: o.x + w0,     ay: o.y + h0 / 2 },
    };
    const anc = anchors[handle];
    if (!anc) return;

    const origCornerX = handle.includes('W') ? o.x : (handle.includes('E') ? o.x + w0 : anc.ax);
    const origCornerY = handle.includes('N') ? o.y : (handle.includes('S') ? o.y + h0 : anc.ay);
    const origDX = origCornerX - anc.ax;
    const origDY = origCornerY - anc.ay;
    const newDX = world.x - anc.ax;
    const newDY = world.y - anc.ay;

    let factor;
    if (handle === 'N' || handle === 'S') factor = Math.abs(origDY) > 1e-3 ? newDY / origDY : 1;
    else if (handle === 'E' || handle === 'W') factor = Math.abs(origDX) > 1e-3 ? newDX / origDX : 1;
    else {
      const fx = Math.abs(origDX) > 1e-3 ? newDX / origDX : 1;
      const fy = Math.abs(origDY) > 1e-3 ? newDY / origDY : 1;
      factor = (Math.abs(fx) > Math.abs(fy)) ? fx : fy;
    }
    factor = Math.max(0.05, factor);

    cur.scale = o.scale * factor;
    cur.x = anc.ax - (anc.ax - o.x) * factor;
    cur.y = anc.ay - (anc.ay - o.y) * factor;
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
    this._mode = null;
    this._dragLed = null;
    this._dragOrigin = null;
    this._dragStart = null;
    this.container.classList.remove('panning');
    this._updateCursor(this._lastPointer?.px ?? 0, this._lastPointer?.py ?? 0);
    this.render();
  }

  _onWheel(e) {
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
        if (!led || led.locked) continue;
        led.map2d.rotation = (led.map2d.rotation || 0) + Math.PI / 2;
      }
      this.ledManager._emit('change');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const ids = [...this.ledManager.selection].filter(id => {
        const led = this.ledManager.get(id);
        return led && !led.locked;
      });
      if (!ids.length) return;
      this.dispatchEvent(new CustomEvent('transaction-start', { detail: { kind: 'delete' } }));
      for (const id of ids) this.ledManager.remove(id);
    } else if (e.key === 'Escape') {
      this.ledManager.clearSelection();
    }
  }

  _updateCursor(px, py) {
    const w = this._toWorld(px, py);
    if (this._tool === 'pan') return;
    const hit = this._hitTest(w.x, w.y);
    if (!hit) {
      this.canvas.style.cursor = (this._tool === 'mapled') ? 'crosshair' : 'crosshair';
      return;
    }
    if (hit.kind === 'rotate') this.canvas.style.cursor = 'crosshair';
    else if (hit.kind === 'drag' || hit.kind === 'mapled-drag') this.canvas.style.cursor = 'move';
    else if (hit.kind.startsWith('resize-') || hit.kind.startsWith('mapled-resize-')) {
      const id = hit.kind.replace(/^.*-/, '');
      const map = { N: 'ns-resize', S: 'ns-resize', E: 'ew-resize', W: 'ew-resize',
                    NE: 'nesw-resize', SW: 'nesw-resize', NW: 'nwse-resize', SE: 'nwse-resize' };
      this.canvas.style.cursor = map[id] || 'default';
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
      this._emitMapledChanged();
      this._rafHandle = requestAnimationFrame(tick);
    };
    this._rafHandle = requestAnimationFrame(tick);
  }
  _stopVideoLoop() {
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    this._rafHandle = 0;
  }

  _emitMapledChanged() {
    if (this._mapledEmitTimer) return;
    this._mapledEmitTimer = setTimeout(() => {
      this._mapledEmitTimer = 0;
      this.dispatchEvent(new CustomEvent('mapled-changed', { detail: { group: this._activeKey() } }));
    }, 0);
  }

  // ============ Rendering ============
  _mapledNaturalSize(srcArg) {
    const src = srcArg !== undefined ? srcArg : (this._currentMapled()?.image || null);
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

    if (this._tool === 'mapled') this._drawMapledHandles();
    ctx.restore();
  }

  _renderSetupMode() {
    const ctx = this.ctx;
    const cur = this._currentMapled();
    if (cur && cur.image) {
      const sz = this._mapledNaturalSize(cur.image);
      ctx.globalAlpha = cur.opacity;
      try {
        ctx.drawImage(cur.image, cur.x, cur.y, sz.w * cur.scale, sz.h * cur.scale);
      } catch {}
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(129,172,255,0.4)';
      ctx.lineWidth = 1 / this.viewScale;
      ctx.strokeRect(cur.x, cur.y, sz.w * cur.scale, sz.h * cur.scale);
    }
    for (const led of this.ledManager.list()) this._drawLed(led, {});
  }

  _renderPreviewMode(W, H) {
    const ctx = this.ctx;
    const cur = this._currentMapled();
    if (cur && cur.image) {
      const sz = this._mapledNaturalSize(cur.image);
      try {
        ctx.drawImage(cur.image, cur.x, cur.y, sz.w * cur.scale, sz.h * cur.scale);
      } catch {}
    }

    if (this._maskOutside) {
      const path = new Path2D();
      const x0 = -this.viewTx / this.viewScale;
      const y0 = -this.viewTy / this.viewScale;
      const wW = W / this.viewScale, wH = H / this.viewScale;
      path.rect(x0, y0, wW, wH);
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

    for (const led of this.ledManager.list()) this._drawLed(led, { borderOnly: true });
  }

  _drawMapledHandles() {
    const cur = this._currentMapled();
    if (!cur || !cur.image) return;
    const sz = this._mapledNaturalSize(cur.image);
    const w = sz.w * cur.scale, h = sz.h * cur.scale;
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#ea5f28';
    ctx.lineWidth = 2 / this.viewScale;
    ctx.setLineDash([8 / this.viewScale, 4 / this.viewScale]);
    ctx.strokeRect(cur.x, cur.y, w, h);
    ctx.setLineDash([]);

    const pts = [
      { x: cur.x,         y: cur.y },
      { x: cur.x + w / 2, y: cur.y },
      { x: cur.x + w,     y: cur.y },
      { x: cur.x + w,     y: cur.y + h / 2 },
      { x: cur.x + w,     y: cur.y + h },
      { x: cur.x + w / 2, y: cur.y + h },
      { x: cur.x,         y: cur.y + h },
      { x: cur.x,         y: cur.y + h / 2 },
    ];
    const sz2 = HANDLE / this.viewScale;
    ctx.fillStyle = '#ea5f28';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 / this.viewScale;
    for (const p of pts) {
      ctx.fillRect(p.x - sz2 / 2, p.y - sz2 / 2, sz2, sz2);
      ctx.strokeRect(p.x - sz2 / 2, p.y - sz2 / 2, sz2, sz2);
    }
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

    const inActiveGroup = (this.activeGroup === GROUP_ALL) || ((led.group || '') === this.activeGroup);
    const dimmed = !inActiveGroup;

    ctx.save();
    if (dimmed) ctx.globalAlpha = 0.35;
    ctx.translate(cx, cy);
    ctx.rotate(m.rotation);
    ctx.translate(-m.w / 2, -m.h / 2);

    if (!opts.borderOnly) {
      const fill = led.locked
        ? 'rgba(120, 120, 130, 0.55)'
        : led.color.replace('hsl', 'hsla').replace(')', ', 0.85)');
      ctx.fillStyle = fill;
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

    ctx.strokeStyle = selected
      ? '#ffffff'
      : (opts.borderOnly ? led.color : 'rgba(255,255,255,0.5)');
    ctx.lineWidth = (selected ? 2 : (opts.borderOnly ? 1.5 : 1)) / this.viewScale;
    ctx.strokeRect(0, 0, m.w, m.h);

    const fontSize = Math.max(10, Math.min(16, m.h / 6)) / this.viewScale;
    ctx.fillStyle = opts.borderOnly ? '#ffffff' : 'rgba(255,255,255,0.95)';
    ctx.font = `600 ${fontSize}px "Halyard Text", Inter, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const pad = 6 / this.viewScale;
    if (!opts.borderOnly || m.h > 40 / this.viewScale) {
      ctx.fillText(led.name, pad, pad);
      if (!opts.borderOnly) {
        ctx.font = `500 ${fontSize * 0.85}px "Halyard Text", Inter, sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        const info = led.group
          ? `${led.realW}×${led.realH}mm · ${led.group}`
          : `${led.realW}×${led.realH}mm · ${led.pixelW}×${led.pixelH}px`;
        ctx.fillText(info, pad, pad + fontSize + 2 / this.viewScale);
      }
    }

    if (selected && !led.locked) {
      const handles = this._handlePositions(m);
      ctx.fillStyle = '#ea5f28';
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

    if (led.locked) {
      const s = Math.max(10, Math.min(18, m.w / 8)) / this.viewScale;
      const x = m.w - s - 4 / this.viewScale;
      const y = 4 / this.viewScale;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x, y, s, s);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, 1 / this.viewScale);
      ctx.strokeRect(x + s * 0.20, y + s * 0.42, s * 0.60, s * 0.42);
      ctx.beginPath();
      ctx.arc(x + s * 0.50, y + s * 0.42, s * 0.22, Math.PI, 0, false);
      ctx.stroke();
    }

    ctx.restore();
  }
}
