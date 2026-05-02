// 3D mapled overlay — projects each LED group's mapled image/video onto its
// 3D LED panel face.
//
// For each visible LED, we build a Plane mesh, parent it to the LED mesh
// (so it inherits world position / rotation / scale automatically) and use
// the LED's *local* geometry bounding box to figure out:
//   - face dimensions (the two largest local-axis sizes)
//   - thin axis (the smallest local-axis = panel normal direction)
//   - offset along thin axis = half-thickness + Z_OFFSET
//
// UV crop comes from the LED's `map2d` rect normalized by the mapled's natural
// pixel dimensions. Texture rotation handles per-LED 2D rotation.
//
// Each per-LED plane uses its own cloned texture so offset/repeat/center/rot
// are independent across LEDs that share the same group's mapled bitmap.
//
// Subscriptions:
//   - editor 'mapled-changed'        → refresh()
//   - editor 'group-changed'         → refresh()
//   - editor 'overlay-3d-toggled'    → enable/disable, refresh()
//   - editor 'group-overlay-toggled' → refresh() (per-group visibility)
//   - ledManager 'change'            → refresh() (LED moved → plane moves)

import * as THREE from 'three';

const Z_OFFSET = 0.0015; // ≈ 1.5 mm in scene units (meters)
const _v = new THREE.Vector3();

export class MapledOverlay3D {
  constructor(scene, ledManager, editor) {
    this.scene = scene;
    this.ledManager = ledManager;
    this.editor = editor;

    // We still keep a holder group for stale planes that haven't been parented
    // to an LED yet; parented planes live under their LED mesh.
    this.group = new THREE.Group();
    this.group.name = 'MapledOverlay3D';
    this.scene.add(this.group);

    this._meshes = new Map();        // ledId → Mesh
    this._textures = new Map();      // groupName → THREE.Texture
    this._sources = new Map();       // groupName → image|video reference

    this._visible = true;
    this._enabled = editor.getOverlay3dEnabled?.() ?? true;

    this._onMapledChanged = () => this.refresh();
    this._onGroupChanged = () => this.refresh();
    this._onLedChanged = () => this.refresh();
    this._onGroupOverlayToggled = () => this.refresh();
    this._onOverlayToggled = (e) => {
      this._enabled = !!e.detail;
      this.refresh();
    };

    editor.addEventListener('mapled-changed', this._onMapledChanged);
    editor.addEventListener('group-changed', this._onGroupChanged);
    editor.addEventListener('overlay-3d-toggled', this._onOverlayToggled);
    editor.addEventListener('group-overlay-toggled', this._onGroupOverlayToggled);
    ledManager.addEventListener('change', this._onLedChanged);
  }

  setVisible(on) {
    this._visible = !!on;
    this.refresh();
  }

  refresh() {
    if (!this._enabled || !this._visible) {
      // Hide all planes without disposing them.
      for (const mesh of this._meshes.values()) mesh.visible = false;
      return;
    }

    // Show overlays for every group that has a mapled — independent of which
    // group is currently active in the 2D editor. (Active group is just for
    // editing; the 3D view shows the full assembled stage.)
    const seenIds = new Set();

    for (const led of this.ledManager.list()) {
      if (!led._mesh || led.hidden) continue;
      const groupName = led.group || '';
      const cur = this.editor._groups?.get(groupName);
      if (!cur || !cur.image || cur.overlayHidden) continue;

      const tex = this._ensureTexture(groupName, cur.image);
      if (!tex) continue;

      const sz = this._mapledSize(cur.image);
      if (!sz.w || !sz.h) continue;

      const mapledW = sz.w * cur.scale;
      const mapledH = sz.h * cur.scale;
      const m = led.map2d;
      const u0 = (m.x - cur.x) / mapledW;
      const v0 = (m.y - cur.y) / mapledH;
      const uw = m.w / mapledW;
      const vh = m.h / mapledH;

      const mesh = this._ensureMesh(led, tex);
      mesh.visible = true;
      const material = mesh.material;

      let perLedTex = mesh.userData._perLedTex;
      if (!perLedTex || perLedTex._sourceTex !== tex) {
        if (perLedTex) perLedTex.dispose();
        perLedTex = tex.clone();
        perLedTex._sourceTex = tex;
        perLedTex.needsUpdate = true;
        material.map = perLedTex;
        material.needsUpdate = true;
        mesh.userData._perLedTex = perLedTex;
      }
      perLedTex.wrapS = THREE.ClampToEdgeWrapping;
      perLedTex.wrapT = THREE.ClampToEdgeWrapping;
      // Three.js V grows up; canvas/image V grows down → flip.
      perLedTex.offset.set(u0, 1 - (v0 + vh));
      perLedTex.repeat.set(uw, vh);
      perLedTex.center.set(u0 + uw / 2, 1 - (v0 + vh / 2));
      perLedTex.rotation = -(m.rotation || 0);

      this._positionPlaneAtLed(mesh, led);

      seenIds.add(led.id);
    }

    // Hide / dispose planes whose LEDs no longer qualify.
    for (const [id, mesh] of this._meshes) {
      if (!seenIds.has(id)) {
        this._disposeMesh(mesh);
        this._meshes.delete(id);
      }
    }
  }

  _ensureMesh(led, tex) {
    let mesh = this._meshes.get(led.id);
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
      mesh.name = `MapledOverlay_${led.id}`;
      mesh.renderOrder = 1000;
      this._meshes.set(led.id, mesh);
    }
    // Re-parent under the LED mesh so it inherits world transforms.
    if (mesh.parent !== led._mesh) {
      if (mesh.parent) mesh.parent.remove(mesh);
      led._mesh.add(mesh);
    }
    return mesh;
  }

  // Position the overlay plane in the LED mesh's *local* space, so any rotation
  // / translation / scale on the LED mesh is inherited automatically.
  _positionPlaneAtLed(mesh, led) {
    const ledMesh = led._mesh;
    if (!ledMesh) return;

    if (!ledMesh.geometry?.boundingBox) ledMesh.geometry?.computeBoundingBox?.();
    const lbox = ledMesh.geometry?.boundingBox;
    if (!lbox) return;
    const lsize = lbox.getSize(new THREE.Vector3());
    const lcenter = lbox.getCenter(new THREE.Vector3());

    const axes = [
      { ax: 'x', val: lsize.x },
      { ax: 'y', val: lsize.y },
      { ax: 'z', val: lsize.z },
    ].sort((a, b) => a.val - b.val);
    const thin = axes[0];
    const faceW = axes[2].val;
    const faceH = axes[1].val;

    mesh.scale.set(faceW, faceH, 1);
    mesh.rotation.set(0, 0, 0);
    mesh.position.copy(lcenter);

    const offset = thin.val / 2 + Z_OFFSET;
    if (thin.ax === 'z') {
      mesh.position.z += offset;
    } else if (thin.ax === 'x') {
      mesh.rotation.y = Math.PI / 2;
      mesh.position.x += offset;
    } else {
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y += offset;
    }
  }

  _ensureTexture(groupName, src) {
    const cached = this._textures.get(groupName);
    if (cached && this._sources.get(groupName) === src) {
      if (cached.isVideoTexture) cached.needsUpdate = true;
      return cached;
    }
    if (cached) cached.dispose();

    let tex = null;
    if (src instanceof HTMLVideoElement) {
      tex = new THREE.VideoTexture(src);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.format = THREE.RGBAFormat;
    } else if (src instanceof HTMLImageElement) {
      const canvas = document.createElement('canvas');
      canvas.width = src.naturalWidth || src.width || 1;
      canvas.height = src.naturalHeight || src.height || 1;
      const ctx = canvas.getContext('2d');
      try { ctx.drawImage(src, 0, 0); } catch {}
      tex = new THREE.CanvasTexture(canvas);
    }
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      this._textures.set(groupName, tex);
      this._sources.set(groupName, src);
    }
    return tex;
  }

  _mapledSize(src) {
    if (!src) return { w: 0, h: 0 };
    if (src instanceof HTMLVideoElement) return { w: src.videoWidth || 1, h: src.videoHeight || 1 };
    return { w: src.naturalWidth || src.width || 1, h: src.naturalHeight || src.height || 1 };
  }

  _disposeMesh(mesh) {
    if (mesh.parent) mesh.parent.remove(mesh);
    if (mesh.userData._perLedTex) mesh.userData._perLedTex.dispose();
    mesh.geometry?.dispose?.();
    mesh.material?.dispose?.();
  }

  dispose() {
    this.editor.removeEventListener('mapled-changed', this._onMapledChanged);
    this.editor.removeEventListener('group-changed', this._onGroupChanged);
    this.editor.removeEventListener('overlay-3d-toggled', this._onOverlayToggled);
    this.editor.removeEventListener('group-overlay-toggled', this._onGroupOverlayToggled);
    this.ledManager.removeEventListener('change', this._onLedChanged);

    for (const mesh of this._meshes.values()) this._disposeMesh(mesh);
    this._meshes.clear();
    for (const tex of this._textures.values()) tex.dispose();
    this._textures.clear();
    this._sources.clear();
    this.scene.remove(this.group);
  }
}
