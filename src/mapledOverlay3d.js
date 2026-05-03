// 3D mapled overlay — GPU-shaded masking.
//
// Per LED group, build ONE textured plane in 3D containing the FULL mapled
// image (or video). A custom ShaderMaterial multiplies the source alpha by a
// pre-baked mask texture so only pixels inside the LED rectangles from 2D
// mapping show up; everything between panels is fully transparent.
//
// The big win over the previous CPU path:
//   * Source: THREE.VideoTexture (hardware decode + GPU upload) for video,
//     THREE.CanvasTexture/Texture for image. No per-frame CPU drawImage.
//   * Mask: a single low-res canvas texture, redrawn only when the LED
//     layout / mapled position changes. Sampled by the fragment shader on
//     every fragment — practically free.
//   * No per-group rAF: VideoTexture handles "needsUpdate" automatically when
//     the renderer touches it.
//
// Subscriptions:
//   - editor 'mapled-changed'        → mask redraw + placement refresh
//   - editor 'group-changed'         → mask redraw + placement refresh
//   - editor 'overlay-3d-toggled'    → enable / disable globally
//   - editor 'group-overlay-toggled' → per-group visibility
//   - ledManager 'change'            → mask redraw + placement refresh

import * as THREE from 'three';

// Resolution of the mask canvas. Lower = smaller texture upload, less RAM,
// negligible visible difference because the mask is binary (1 = visible,
// 0 = transparent) and the rects are large relative to the canvas. We don't
// follow the source image resolution — that just wastes memory.
const MASK_W = 1024;
const MASK_H = 1024;

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D uSrc;
  uniform sampler2D uMask;
  varying vec2 vUv;
  void main() {
    vec4 c = texture2D(uSrc, vUv);
    float a = texture2D(uMask, vUv).a;
    if (a < 0.01) discard;
    gl_FragColor = vec4(c.rgb, c.a * a);
  }
`;

export class MapledOverlay3D {
  constructor(scene, ledManager, editor, viewer = null) {
    this.scene = scene;
    this.ledManager = ledManager;
    this.editor = editor;
    this.viewer = viewer;

    this.group = new THREE.Group();
    this.group.name = 'MapledOverlay3D';
    this.scene.add(this.group);

    /** @type {Map<string, {mesh:THREE.Mesh, material:THREE.ShaderMaterial, srcTex:THREE.Texture|null, maskCanvas:HTMLCanvasElement, maskCtx:CanvasRenderingContext2D, maskTex:THREE.CanvasTexture, srcKey:any}>} */
    this._entries = new Map();
    this._hiddenMeshes = new Set();

    this._enabled = editor.getOverlay3dEnabled?.() ?? true;

    this._onMapledChanged       = () => this.refresh();
    this._onGroupChanged        = () => this.refresh();
    this._onLedChanged          = () => this.refresh();
    this._onGroupOverlayToggled = () => this.refresh();
    this._onOverlayToggled      = (e) => { this._enabled = !!e.detail; this.refresh(); };

    editor.addEventListener('mapled-changed',        this._onMapledChanged);
    editor.addEventListener('group-changed',         this._onGroupChanged);
    editor.addEventListener('overlay-3d-toggled',    this._onOverlayToggled);
    editor.addEventListener('group-overlay-toggled', this._onGroupOverlayToggled);
    ledManager.addEventListener('change',            this._onLedChanged);
  }

  setVisible(on) { this._enabled = !!on; this.refresh(); }

  refresh() {
    this._restoreLedVisibility();

    if (!this._enabled) {
      for (const e of this._entries.values()) e.mesh.visible = false;
      return;
    }

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

      const entry = this._ensureEntry(groupName);
      this._updateSourceTexture(entry, cur.image);
      this._redrawMask(entry, cur, sz, leds);

      const m = entry.mesh;
      m.visible = true;
      m.scale.set(placement.width, placement.height, 1);
      m.position.copy(placement.position);
      m.quaternion.copy(placement.quaternion);

      // Hide LED meshes covered by this overlay.
      for (const led of leds) {
        if (led._mesh && led._mesh.visible) {
          led._mesh.visible = false;
          this._hiddenMeshes.add(led._mesh);
        }
      }
      activeGroups.add(groupName);
    }

    for (const [name, entry] of this._entries) {
      if (!activeGroups.has(name)) entry.mesh.visible = false;
    }
  }

  // ---------- Per-group resources ----------

  _ensureEntry(groupName) {
    let entry = this._entries.get(groupName);
    if (entry) return entry;

    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = MASK_W;
    maskCanvas.height = MASK_H;
    const maskCtx = maskCanvas.getContext('2d');

    const maskTex = new THREE.CanvasTexture(maskCanvas);
    maskTex.minFilter = THREE.LinearFilter;
    maskTex.magFilter = THREE.LinearFilter;
    maskTex.generateMipmaps = false;
    maskTex.colorSpace = THREE.NoColorSpace;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uSrc:  { value: null },
        uMask: { value: maskTex },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.name = `MapledOverlay_${groupName || 'ungrouped'}`;
    mesh.renderOrder = 1000;
    this.group.add(mesh);

    entry = { mesh, material, srcTex: null, maskCanvas, maskCtx, maskTex, srcKey: null };
    this._entries.set(groupName, entry);
    return entry;
  }

  _updateSourceTexture(entry, src) {
    if (entry.srcKey === src && entry.srcTex) {
      return;
    }

    if (entry.srcTex) {
      this.viewer?.untrackVideoTexture?.(entry.srcTex);
      entry.srcTex.dispose();
    }
    if (entry.srcWake) {
      const v = entry.srcKey;
      if (v instanceof HTMLVideoElement) {
        v.removeEventListener('play',  entry.srcWake);
        v.removeEventListener('seeked', entry.srcWake);
      }
      entry.srcWake = null;
    }

    let tex = null;
    if (src instanceof HTMLVideoElement) {
      tex = new THREE.VideoTexture(src);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.format = THREE.RGBAFormat;
      // Wake the render loop on play/seek so the first frame doesn't stall.
      const wake = () => this.viewer?.requestRender?.();
      src.addEventListener('play',   wake);
      src.addEventListener('seeked', wake);
      entry.srcWake = wake;
    } else if (src instanceof HTMLImageElement) {
      tex = new THREE.Texture(src);
      tex.needsUpdate = true;
    }
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
    }
    entry.srcTex = tex;
    entry.srcKey = src;
    entry.material.uniforms.uSrc.value = tex;
    if (tex && tex.isVideoTexture) this.viewer?.trackVideoTexture?.(tex);
  }

  // Bake the LED rect union into the mask canvas. This runs once per refresh
  // (group/LED/mapled change), NOT per frame.
  _redrawMask(entry, cur, sz, leds) {
    const ctx = entry.maskCtx;
    ctx.clearRect(0, 0, MASK_W, MASK_H);
    ctx.fillStyle = '#fff';

    const sx = MASK_W / sz.w;
    const sy = MASK_H / sz.h;

    let any = false;
    for (const led of leds) {
      if (!led.map2d || led.map2d.w <= 0 || led.map2d.h <= 0) continue;
      // Canvas coordinates → image pixel coordinates → mask texel coordinates.
      const ix = (led.map2d.x - cur.x) / cur.scale;
      const iy = (led.map2d.y - cur.y) / cur.scale;
      const iw =  led.map2d.w        / cur.scale;
      const ih =  led.map2d.h        / cur.scale;
      ctx.fillRect(ix * sx, iy * sy, iw * sx, ih * sy);
      any = true;
    }
    entry.maskTex.needsUpdate = true;
    entry.mesh.visible = any;  // nothing to mask through → just hide the plane
  }

  _restoreLedVisibility() {
    for (const mesh of this._hiddenMeshes) mesh.visible = true;
    this._hiddenMeshes.clear();
  }

  // ---------- Placement (unchanged math) ----------

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

    const wq = new THREE.Quaternion();
    const wp = new THREE.Vector3();
    const ws = new THREE.Vector3();
    refMesh.matrixWorld.decompose(wp, wq, ws);

    const axes = [
      { ax: 'x', val: lsize.x, vec: new THREE.Vector3(1, 0, 0) },
      { ax: 'y', val: lsize.y, vec: new THREE.Vector3(0, 1, 0) },
      { ax: 'z', val: lsize.z, vec: new THREE.Vector3(0, 0, 1) },
    ].sort((a, b) => a.val - b.val);
    const thin = axes[0];
    const inPlane = [axes[1], axes[2]].map(a => ({
      ...a,
      worldY: Math.abs(a.vec.clone().applyQuaternion(wq).y),
    }));
    inPlane.sort((a, b) => b.worldY - a.worldY);
    const tall = inPlane[0];
    const wide = inPlane[1];

    const wsArr = [ws.x, ws.y, ws.z];
    const idx = (a) => a === 'x' ? 0 : (a === 'y' ? 1 : 2);
    const ledFaceW_world = wide.val * Math.abs(wsArr[idx(wide.ax)]);
    const ledFaceH_world = tall.val * Math.abs(wsArr[idx(tall.ax)]);

    const cw = refLed.map2d.w;
    const ch = refLed.map2d.h;
    if (cw <= 0 || ch <= 0) return null;

    const wppX = ledFaceW_world / cw;
    const wppY = ledFaceH_world / ch;

    const worldU = wide.vec.clone().applyQuaternion(wq).normalize();
    const worldV = tall.vec.clone().applyQuaternion(wq).normalize();
    const worldN = thin.vec.clone().applyQuaternion(wq).normalize();

    const refWorldCenter = lcenter.clone().applyMatrix4(refMesh.matrixWorld);

    const mapledCxC = cur.x + sz.w * cur.scale / 2;
    const mapledCyC = cur.y + sz.h * cur.scale / 2;
    const refCxC    = refLed.map2d.x + cw / 2;
    const refCyC    = refLed.map2d.y + ch / 2;

    const dxC = mapledCxC - refCxC;
    const dyC = mapledCyC - refCyC;

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

  _mapledSize(src) {
    if (!src) return { w: 0, h: 0 };
    if (src instanceof HTMLVideoElement) return { w: src.videoWidth || 1, h: src.videoHeight || 1 };
    return { w: src.naturalWidth || src.width || 1, h: src.naturalHeight || src.height || 1 };
  }

  dispose() {
    this.editor.removeEventListener('mapled-changed',        this._onMapledChanged);
    this.editor.removeEventListener('group-changed',         this._onGroupChanged);
    this.editor.removeEventListener('overlay-3d-toggled',    this._onOverlayToggled);
    this.editor.removeEventListener('group-overlay-toggled', this._onGroupOverlayToggled);
    this.ledManager.removeEventListener('change',            this._onLedChanged);

    this._restoreLedVisibility();
    for (const e of this._entries.values()) {
      if (e.mesh.parent) e.mesh.parent.remove(e.mesh);
      e.mesh.geometry?.dispose?.();
      e.material?.dispose?.();
      if (e.srcTex) {
        this.viewer?.untrackVideoTexture?.(e.srcTex);
        e.srcTex.dispose();
      }
      e.maskTex?.dispose?.();
    }
    this._entries.clear();
    this.scene.remove(this.group);
  }
}
