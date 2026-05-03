// 3D mapled overlay — Option 2 with LED masking.
//
// Per LED group, build ONE textured plane in 3D containing the FULL mapled
// image (or video). The texture is rendered to an offscreen canvas and masked
// with the union of LED rectangles from 2D mapping, so only the pixels that
// "belong" to an LED panel are visible; everything between panels is transparent.
//
// Masking technique (Canvas 2D):
//   1. drawImage(src) with source-over
//   2. destination-in + fillRect(ledRect) for every LED in the group
//      → keeps image pixels only inside the LED rects, clears the rest
//
// For video sources the mask is redrawn every animation frame so the video
// plays through correctly. For static images it is drawn once (on refresh).
//
// Subscriptions:
//   - editor 'mapled-changed'        → refresh()
//   - editor 'group-changed'         → refresh()
//   - editor 'overlay-3d-toggled'    → enable / disable globally
//   - editor 'group-overlay-toggled' → per-group visibility
//   - ledManager 'change'            → LEDs added / moved / locked → refresh()

import * as THREE from 'three';

export class MapledOverlay3D {
  constructor(scene, ledManager, editor) {
    this.scene = scene;
    this.ledManager = ledManager;
    this.editor = editor;

    this.group = new THREE.Group();
    this.group.name = 'MapledOverlay3D';
    this.scene.add(this.group);

    this._planes      = new Map();  // groupName → THREE.Mesh
    this._textures    = new Map();  // groupName → THREE.CanvasTexture
    this._maskCanvas  = new Map();  // groupName → { canvas, ctx, w, h }
    this._videoLoops  = new Map();  // groupName → rafId
    this._hiddenMeshes = new Set();

    this._enabled = editor.getOverlay3dEnabled?.() ?? true;

    this._onMapledChanged      = () => this.refresh();
    this._onGroupChanged       = () => this.refresh();
    this._onLedChanged         = () => this.refresh();
    this._onGroupOverlayToggled = () => this.refresh();
    this._onOverlayToggled     = (e) => { this._enabled = !!e.detail; this.refresh(); };

    editor.addEventListener('mapled-changed',        this._onMapledChanged);
    editor.addEventListener('group-changed',         this._onGroupChanged);
    editor.addEventListener('overlay-3d-toggled',    this._onOverlayToggled);
    editor.addEventListener('group-overlay-toggled', this._onGroupOverlayToggled);
    ledManager.addEventListener('change',            this._onLedChanged);
  }

  setVisible(on) { this._enabled = !!on; this.refresh(); }

  refresh() {
    this._restoreLedVisibility();
    this._stopAllVideoLoops();

    if (!this._enabled) {
      for (const m of this._planes.values()) m.visible = false;
      return;
    }

    // Bucket LEDs by group.
    const buckets = new Map();
    for (const led of this.ledManager.list()) {
      if (!led._mesh) continue;
      const g = led.group || '';
      if (!buckets.has(g)) buckets.set(g, []);
      buckets.get(g).push(led);
    }

    const activeGroups = new Set();

    for (const [groupName, leds] of buckets) {
      const cur = this.editor._groups?.get(groupName);
      if (!cur || !cur.image || cur.overlayHidden) continue;

      const sz = this._mapledSize(cur.image);
      if (!sz.w || !sz.h) continue;

      const placement = this._computeGroupPlacement(leds, cur, sz);
      if (!placement) continue;

      const tex = this._buildMaskedTexture(groupName, cur, sz, leds);
      if (!tex) continue;

      const mesh = this._ensurePlane(groupName, tex);
      mesh.visible = true;
      mesh.scale.set(placement.width, placement.height, 1);
      mesh.position.copy(placement.position);
      mesh.quaternion.copy(placement.quaternion);

      // Auto-hide every LED panel in this group while its overlay is showing.
      for (const led of leds) {
        if (led._mesh && led._mesh.visible) {
          led._mesh.visible = false;
          this._hiddenMeshes.add(led._mesh);
        }
      }
      activeGroups.add(groupName);

      // Keep video textures live.
      if (cur.image instanceof HTMLVideoElement) {
        this._startVideoLoop(groupName, cur.image, cur, sz, leds);
      }
    }

    for (const [name, mesh] of this._planes) {
      if (!activeGroups.has(name)) mesh.visible = false;
    }
  }

  // ---------- Masked texture ----------

  _buildMaskedTexture(groupName, cur, sz, leds) {
    // Get or (re)create offscreen canvas when image size changes.
    let entry = this._maskCanvas.get(groupName);
    if (!entry || entry.w !== sz.w || entry.h !== sz.h) {
      const canvas = document.createElement('canvas');
      canvas.width  = sz.w;
      canvas.height = sz.h;
      entry = { canvas, ctx: canvas.getContext('2d'), w: sz.w, h: sz.h };
      this._maskCanvas.set(groupName, entry);
      // Old texture (wrong size) must be disposed.
      const old = this._textures.get(groupName);
      if (old) { old.dispose(); this._textures.delete(groupName); }
    }

    this._drawMasked(entry.ctx, sz, cur.image, cur, leds);

    let tex = this._textures.get(groupName);
    if (!tex) {
      tex = new THREE.CanvasTexture(entry.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      this._textures.set(groupName, tex);
    }
    tex.needsUpdate = true;
    return tex;
  }

  // Draw src (image or video) onto ctx, masked to the union of LED rects.
  // Order matters: build the rect union first (default source-over accumulates
  // each fillRect into one shape), then stamp the image once with source-in.
  // Doing it the other way — destination-in inside the loop — would intersect
  // surviving pixels with each rect in turn, and non-overlapping LEDs would
  // collapse to an empty canvas (the "disappear" bug).
  _drawMasked(ctx, sz, src, cur, leds) {
    ctx.clearRect(0, 0, sz.w, sz.h);

    // 1. Build the LED-rect mask as opaque white.
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    let any = false;
    for (const led of leds) {
      if (!led.map2d || led.map2d.w <= 0 || led.map2d.h <= 0) continue;
      // Convert canvas coordinates → image pixel coordinates.
      const x = (led.map2d.x - cur.x) / cur.scale;
      const y = (led.map2d.y - cur.y) / cur.scale;
      const w =  led.map2d.w        / cur.scale;
      const h =  led.map2d.h        / cur.scale;
      ctx.fillRect(x, y, w, h);
      any = true;
    }
    if (!any) return;

    // 2. Stamp the image only where the mask is opaque.
    ctx.globalCompositeOperation = 'source-in';
    try { ctx.drawImage(src, 0, 0, sz.w, sz.h); } catch {}

    ctx.globalCompositeOperation = 'source-over';
  }

  // rAF loop that redraws the masked canvas every frame for video sources.
  _startVideoLoop(groupName, video, cur, sz, leds) {
    const entry = this._maskCanvas.get(groupName);
    const tex   = this._textures.get(groupName);
    if (!entry || !tex) return;

    const { ctx } = entry;
    const loop = () => {
      this._drawMasked(ctx, sz, video, cur, leds);
      tex.needsUpdate = true;
      this._videoLoops.set(groupName, requestAnimationFrame(loop));
    };
    this._videoLoops.set(groupName, requestAnimationFrame(loop));
  }

  _stopVideoLoop(groupName) {
    const id = this._videoLoops.get(groupName);
    if (id != null) cancelAnimationFrame(id);
    this._videoLoops.delete(groupName);
  }

  _stopAllVideoLoops() {
    for (const name of [...this._videoLoops.keys()]) this._stopVideoLoop(name);
  }

  // ---------- Internal ----------

  _restoreLedVisibility() {
    for (const mesh of this._hiddenMeshes) mesh.visible = true;
    this._hiddenMeshes.clear();
  }

  // Decide where the group's full-image plane sits in world space.
  _computeGroupPlacement(leds, cur, sz) {
    const refLed = leds.find(l => l._mesh && l.map2d.w > 0 && l.map2d.h > 0);
    if (!refLed) return null;
    const refMesh = refLed._mesh;
    refMesh.updateWorldMatrix(true, false);

    if (!refMesh.geometry?.boundingBox) refMesh.geometry?.computeBoundingBox?.();
    const lbox = refMesh.geometry?.boundingBox;
    if (!lbox) return null;
    const lsize  = lbox.getSize(new THREE.Vector3());
    const lcenter = lbox.getCenter(new THREE.Vector3());

    // World transform of the reference LED.
    const wq = new THREE.Quaternion();
    const wp = new THREE.Vector3();
    const ws = new THREE.Vector3();
    refMesh.matrixWorld.decompose(wp, wq, ws);

    // Sort local axes by size; smallest = panel normal (thin).
    const axes = [
      { ax: 'x', val: lsize.x, vec: new THREE.Vector3(1, 0, 0) },
      { ax: 'y', val: lsize.y, vec: new THREE.Vector3(0, 1, 0) },
      { ax: 'z', val: lsize.z, vec: new THREE.Vector3(0, 0, 1) },
    ].sort((a, b) => a.val - b.val);
    const thin = axes[0];
    // Of the remaining two in-plane axes, pick the one whose world direction has
    // the largest |Y| component as "tall" (vertical-on-wall).
    const inPlane = [axes[1], axes[2]].map(a => ({
      ...a,
      worldY: Math.abs(a.vec.clone().applyQuaternion(wq).y),
    }));
    inPlane.sort((a, b) => b.worldY - a.worldY);
    const tall = inPlane[0];
    const wide = inPlane[1];

    // World-units across the LED's panel face.
    const wsArr = [ws.x, ws.y, ws.z];
    const idx = (a) => a === 'x' ? 0 : (a === 'y' ? 1 : 2);
    const ledFaceW_world = wide.val * Math.abs(wsArr[idx(wide.ax)]);
    const ledFaceH_world = tall.val * Math.abs(wsArr[idx(tall.ax)]);

    // Canvas-pixel size of the reference LED's 2D rect.
    const cw = refLed.map2d.w;
    const ch = refLed.map2d.h;
    if (cw <= 0 || ch <= 0) return null;

    // World-units per canvas-pixel.
    const wppX = ledFaceW_world / cw;
    const wppY = ledFaceH_world / ch;

    // World basis vectors.
    const worldU = wide.vec.clone().applyQuaternion(wq).normalize();
    const worldV = tall.vec.clone().applyQuaternion(wq).normalize();
    const worldN = thin.vec.clone().applyQuaternion(wq).normalize();

    // Reference LED centre in world.
    const refWorldCenter = lcenter.clone().applyMatrix4(refMesh.matrixWorld);

    // Mapled image centre in canvas-px.
    const mapledCxC = cur.x + sz.w * cur.scale / 2;
    const mapledCyC = cur.y + sz.h * cur.scale / 2;
    const refCxC    = refLed.map2d.x + cw / 2;
    const refCyC    = refLed.map2d.y + ch / 2;

    const dxC = mapledCxC - refCxC;
    const dyC = mapledCyC - refCyC;

    // Canvas X grows right (= +worldU). Canvas Y grows down (= -worldV).
    const offset = worldU.clone().multiplyScalar(dxC * wppX)
      .add(worldV.clone().multiplyScalar(-dyC * wppY));

    const planePos = refWorldCenter.clone().add(offset);
    planePos.add(worldN.clone().multiplyScalar(0.002));

    const m = new THREE.Matrix4().makeBasis(worldU, worldV, worldN);
    const planeQuat = new THREE.Quaternion().setFromRotationMatrix(m);

    return {
      width:     sz.w * cur.scale * wppX,
      height:    sz.h * cur.scale * wppY,
      position:  planePos,
      quaternion: planeQuat,
    };
  }

  _ensurePlane(groupName, tex) {
    let mesh = this._planes.get(groupName);
    if (!mesh) {
      const geom = new THREE.PlaneGeometry(1, 1);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      mesh = new THREE.Mesh(geom, mat);
      mesh.name = `MapledOverlay_${groupName || 'ungrouped'}`;
      mesh.renderOrder = 1000;
      this.group.add(mesh);
      this._planes.set(groupName, mesh);
    } else if (mesh.material.map !== tex) {
      mesh.material.map = tex;
      mesh.material.needsUpdate = true;
    }
    return mesh;
  }

  _mapledSize(src) {
    if (!src) return { w: 0, h: 0 };
    if (src instanceof HTMLVideoElement) return { w: src.videoWidth || 1, h: src.videoHeight || 1 };
    return { w: src.naturalWidth || src.width || 1, h: src.naturalHeight || src.height || 1 };
  }

  _disposePlane(mesh) {
    if (mesh.parent) mesh.parent.remove(mesh);
    mesh.geometry?.dispose?.();
    mesh.material?.dispose?.();
  }

  dispose() {
    this.editor.removeEventListener('mapled-changed',        this._onMapledChanged);
    this.editor.removeEventListener('group-changed',         this._onGroupChanged);
    this.editor.removeEventListener('overlay-3d-toggled',    this._onOverlayToggled);
    this.editor.removeEventListener('group-overlay-toggled', this._onGroupOverlayToggled);
    this.ledManager.removeEventListener('change',            this._onLedChanged);

    this._stopAllVideoLoops();
    this._restoreLedVisibility();
    for (const mesh of this._planes.values()) this._disposePlane(mesh);
    this._planes.clear();
    for (const tex of this._textures.values()) tex.dispose();
    this._textures.clear();
    this._maskCanvas.clear();
    this.scene.remove(this.group);
  }
}
