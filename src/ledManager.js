// Central state for all LED panels detected/marked from the 3D model.
//
// Each LED record contains both 3D-space metadata (size from the bounding box,
// world position/rotation) and 2D-mapping metadata (xy on the canvas, scale,
// rotation, pixel resolution, pixel pitch). The 2D fields are derived once
// when the LED is first added; the user can then freely tweak them in the
// 2D editor.

import * as THREE from 'three';
import { uid, ledColor, hslToHex } from './utils.js';

const _bbox = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();

const DEFAULT_PIXEL_PITCH = 3.9; // mm – common indoor pitch.

export class LedManager extends EventTarget {
  constructor() {
    super();
    /** @type {Map<string, LedRecord>} keyed by uuid */
    this.leds = new Map();
    /** @type {Set<string>} */
    this.selection = new Set();
    /** @type {THREE.Object3D|null} */
    this._modelRoot = null;
    /** Layout origin for new LEDs in 2D canvas (px). */
    this._next2dCursor = { x: 60, y: 60, rowHeight: 0 };
    this.pixelPitch = DEFAULT_PIXEL_PITCH;
  }

  setModelRoot(root) {
    this._modelRoot = root;
    this.clear();
  }

  clear() {
    for (const led of this.leds.values()) led.restoreOriginalMaterial?.();
    this.leds.clear();
    this.selection.clear();
    this._next2dCursor = { x: 60, y: 60, rowHeight: 0 };
    this._emit('change');
    this._emit('selection');
  }

  list() { return [...this.leds.values()]; }
  get(id) { return this.leds.get(id); }
  has(meshUuid) {
    for (const led of this.leds.values()) if (led.meshUuid === meshUuid) return true;
    return false;
  }
  findByMesh(uuid) {
    for (const led of this.leds.values()) if (led.meshUuid === uuid) return led;
    return null;
  }

  add(mesh) {
    if (!mesh || !mesh.isMesh) return null;
    if (this.has(mesh.uuid)) return this.findByMesh(mesh.uuid);

    // Compute world-aligned bounding box for size hints.
    mesh.updateWorldMatrix(true, false);
    _bbox.setFromObject(mesh);
    _bbox.getSize(_size);
    _bbox.getCenter(_center);
    mesh.matrixWorld.decompose(new THREE.Vector3(), _quat, _scale);
    const euler = new THREE.Euler().setFromQuaternion(_quat, 'YXZ');

    // Real-world size (meters → millimeters). We assume the imported model uses
    // meters by default, which is the SketchUp Collada default.
    const widthMm = Math.max(_size.x, _size.y, _size.z, 0.05) * 1000;
    const heightMm = Math.max(Math.min(_size.y, Math.max(_size.x, _size.z)), 0.05) * 1000;
    // Heuristic: pick the two largest dims as the panel face.
    const dims = [
      { axis: 'x', val: _size.x },
      { axis: 'y', val: _size.y },
      { axis: 'z', val: _size.z },
    ].sort((a, b) => b.val - a.val);
    const realW = dims[0].val * 1000;
    const realH = dims[1].val * 1000;

    const id = uid('led');
    const color = ledColor(id);
    const pitch = this.pixelPitch;

    const record = /** @type {LedRecord} */ ({
      id,
      meshUuid: mesh.uuid,
      name: mesh.name || `LED_${this.leds.size + 1}`,
      color,
      // Real-world dimensions (mm).
      realW: Math.round(realW),
      realH: Math.round(realH),
      // Pixel resolution derived from pitch (rounded to multiple of 64 → typical panel).
      pixelW: Math.max(64, Math.round((realW / pitch) / 32) * 32),
      pixelH: Math.max(64, Math.round((realH / pitch) / 32) * 32),
      pixelPitch: pitch,
      // 3D info.
      world: {
        cx: _center.x, cy: _center.y, cz: _center.z,
        rx: euler.x, ry: euler.y, rz: euler.z,
        sx: _size.x, sy: _size.y, sz: _size.z,
      },
      // 2D mapping (px on canvas).
      map2d: this._allocate2dSlot(realW, realH),
      // Visual flags.
      hidden: false,
    });

    // Tint the original mesh so the user sees what's been marked.
    record._origMaterial = mesh.material;
    const ledMat = new THREE.MeshStandardMaterial({
      color: hslToHex(color),
      emissive: hslToHex(color),
      emissiveIntensity: 0.55,
      transparent: true,
      opacity: 0.92,
    });
    ledMat.name = `LED_Mark_${id}`;
    mesh.material = ledMat;
    record.restoreOriginalMaterial = () => {
      if (record._origMaterial) mesh.material = record._origMaterial;
    };
    record._mesh = mesh;

    this.leds.set(id, record);
    this._emit('change');
    return record;
  }

  remove(id) {
    const led = this.leds.get(id);
    if (!led) return;
    led.restoreOriginalMaterial?.();
    this.leds.delete(id);
    this.selection.delete(id);
    this._emit('change');
    this._emit('selection');
  }

  toggleByMesh(mesh) {
    const existing = this.findByMesh(mesh.uuid);
    if (existing) {
      this.remove(existing.id);
      return null;
    }
    return this.add(mesh);
  }

  setPixelPitch(pitch) {
    this.pixelPitch = pitch;
    for (const led of this.leds.values()) {
      led.pixelPitch = pitch;
      led.pixelW = Math.max(32, Math.round((led.realW / pitch) / 32) * 32);
      led.pixelH = Math.max(32, Math.round((led.realH / pitch) / 32) * 32);
    }
    this._emit('change');
  }

  // ============ Selection ============
  select(id, additive = false) {
    if (!additive) this.selection.clear();
    if (id) this.selection.add(id);
    this._emit('selection');
  }
  toggleSelection(id) {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this._emit('selection');
  }
  clearSelection() {
    this.selection.clear();
    this._emit('selection');
  }
  isSelected(id) { return this.selection.has(id); }

  // ============ Updates ============
  update(id, patch) {
    const led = this.leds.get(id);
    if (!led) return;
    Object.assign(led, patch);
    if (patch.realW != null || patch.realH != null || patch.pixelPitch != null) {
      const p = led.pixelPitch || this.pixelPitch;
      led.pixelW = Math.max(8, Math.round(led.realW / p));
      led.pixelH = Math.max(8, Math.round(led.realH / p));
    }
    this._emit('change');
  }

  updateMap2d(id, patch) {
    const led = this.leds.get(id);
    if (!led) return;
    Object.assign(led.map2d, patch);
    this._emit('change');
  }

  rename(id, name) {
    const led = this.leds.get(id);
    if (!led) return;
    led.name = name;
    this._emit('change');
  }

  // ============ Auto-arrange ============
  // Project the world centre of each LED onto the XY plane and use that as a
  // starting layout. Useful when the user wants the 2D arrangement to roughly
  // mirror how the LEDs are positioned on the back wall of the stage.
  autoArrangeFromWorld(scale = 100, originX = 60, originY = 60) {
    const list = this.list();
    if (!list.length) return;
    let minX = Infinity, minY = Infinity;
    for (const led of list) {
      minX = Math.min(minX, led.world.cx - led.world.sx / 2);
      minY = Math.min(minY, led.world.cy - led.world.sy / 2);
    }
    for (const led of list) {
      const wMm = led.realW;
      const hMm = led.realH;
      const wPx = wMm * scale / 1000;
      const hPx = hMm * scale / 1000;
      // Flip Y because canvas Y grows downward and we want the top of the
      // wall to render at the top of the canvas.
      const x = originX + (led.world.cx - led.world.sx / 2 - minX) * scale;
      const y = originY + (-(led.world.cy + led.world.sy / 2) + (minY)) * scale + 600;
      led.map2d.x = x;
      led.map2d.y = y;
      led.map2d.w = wPx;
      led.map2d.h = hPx;
      led.map2d.rotation = 0;
    }
    this._emit('change');
  }

  _allocate2dSlot(realWmm, realHmm) {
    const wPx = Math.max(60, realWmm * 100 / 1000);
    const hPx = Math.max(40, realHmm * 100 / 1000);
    const cur = this._next2dCursor;
    if (cur.x + wPx > 1200) {
      cur.x = 60;
      cur.y += cur.rowHeight + 20;
      cur.rowHeight = 0;
    }
    const slot = { x: cur.x, y: cur.y, w: wPx, h: hPx, rotation: 0 };
    cur.x += wPx + 20;
    cur.rowHeight = Math.max(cur.rowHeight, hPx);
    return slot;
  }

  // ============ Persistence ============
  exportConfig(extra = {}) {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      pixelPitch: this.pixelPitch,
      ...extra,
      totals: this.computeTotals(),
      leds: this.list().map((l) => ({
        id: l.id,
        name: l.name,
        color: l.color,
        realW: l.realW,
        realH: l.realH,
        pixelW: l.pixelW,
        pixelH: l.pixelH,
        pixelPitch: l.pixelPitch,
        world: l.world,
        map2d: l.map2d,
      })),
    };
  }

  importConfig(cfg, modelRoot) {
    if (!cfg || !Array.isArray(cfg.leds)) {
      throw new Error('Cấu hình không hợp lệ.');
    }
    this.clear();
    this.pixelPitch = cfg.pixelPitch ?? DEFAULT_PIXEL_PITCH;

    // Build a map name → mesh from the current model so we can re-link.
    const byName = new Map();
    if (modelRoot) {
      modelRoot.traverse((o) => {
        if (o.isMesh && o.name && !byName.has(o.name)) byName.set(o.name, o);
      });
    }

    for (const item of cfg.leds) {
      const mesh = byName.get(item.name);
      if (mesh) {
        const rec = this.add(mesh);
        if (rec) {
          this.update(rec.id, {
            realW: item.realW, realH: item.realH,
            pixelW: item.pixelW, pixelH: item.pixelH,
            pixelPitch: item.pixelPitch,
          });
          this.updateMap2d(rec.id, item.map2d || {});
          this.rename(rec.id, item.name);
        }
      } else {
        // No matching mesh – import as orphan (still drawable in 2D).
        const id = item.id || uid('led');
        this.leds.set(id, {
          id,
          meshUuid: null,
          name: item.name,
          color: item.color || ledColor(id),
          realW: item.realW, realH: item.realH,
          pixelW: item.pixelW, pixelH: item.pixelH,
          pixelPitch: item.pixelPitch || this.pixelPitch,
          world: item.world || { cx: 0, cy: 0, cz: 0, rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0 },
          map2d: item.map2d || { x: 50, y: 50, w: 200, h: 100, rotation: 0 },
          hidden: false,
          restoreOriginalMaterial: () => {},
        });
      }
    }
    this._emit('change');
  }

  computeTotals() {
    const list = this.list();
    let totalPixW = 0, totalPixH = 0, areaMm2 = 0;
    for (const l of list) {
      totalPixW += l.pixelW;
      totalPixH = Math.max(totalPixH, l.pixelH);
      areaMm2 += l.realW * l.realH;
    }
    return {
      count: list.length,
      pixelWidthSum: totalPixW,
      pixelHeightMax: totalPixH,
      areaM2: +(areaMm2 / 1e6).toFixed(3),
    };
  }

  _emit(type) { this.dispatchEvent(new CustomEvent(type)); }
  on(type, handler) { this.addEventListener(type, handler); return () => this.removeEventListener(type, handler); }
}

/**
 * @typedef {Object} LedRecord
 * @property {string} id
 * @property {string|null} meshUuid
 * @property {string} name
 * @property {string} color
 * @property {number} realW
 * @property {number} realH
 * @property {number} pixelW
 * @property {number} pixelH
 * @property {number} pixelPitch
 * @property {{cx:number,cy:number,cz:number,rx:number,ry:number,rz:number,sx:number,sy:number,sz:number}} world
 * @property {{x:number,y:number,w:number,h:number,rotation:number}} map2d
 * @property {boolean} hidden
 */
