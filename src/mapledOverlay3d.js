// 3D mapled overlay — Option 2.
//
// Per LED group, build ONE textured plane in 3D containing the FULL mapled
// image (or video). The plane is positioned and oriented so that the 2D
// canvas layout maps correctly onto the 3D wall:
//
//   - Pick a reference LED in the group; use its local geometry bbox to find
//     the panel's "wide", "tall" and "thin" local axes.
//   - The reference LED's mesh world quaternion gives us the wall's basis
//     vectors (worldU = canvas-X direction, worldV = canvas-Y-up direction,
//     worldN = panel normal).
//   - Convert "world units per canvas pixel" from realW/canvasW (and realH/H).
//   - The mapled image's centre in canvas → in world via that mapping anchored
//     at the reference LED's world centre.
//
// When a group's overlay is visible, the LED meshes in that group are HIDDEN
// (they'd otherwise just block the image). Toggling the overlay off restores
// them.
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

    this._planes = new Map();         // groupName → THREE.Mesh (one big plane per group)
    this._textures = new Map();       // groupName → THREE.Texture
    this._sources = new Map();        // groupName → image|video reference
    this._hiddenMeshes = new Set();   // LED meshes we've turned invisible

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

  setVisible(on) { this._enabled = !!on; this.refresh(); }

  refresh() {
    // Restore LEDs we previously hid; we'll re-hide as needed below.
    this._restoreLedVisibility();

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

      const tex = this._ensureTexture(groupName, cur.image);
      if (!tex) continue;

      const sz = this._mapledSize(cur.image);
      if (!sz.w || !sz.h) continue;

      const placement = this._computeGroupPlacement(leds, cur, sz);
      if (!placement) continue;

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
    }

    for (const [name, mesh] of this._planes) {
      if (!activeGroups.has(name)) mesh.visible = false;
    }
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
    const lsize = lbox.getSize(new THREE.Vector3());
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
    // the largest |Y| component as "tall" (vertical-on-wall). This disambiguates
    // square panels and matches the natural "up on the wall" intuition.
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

    // World-units per canvas-pixel along each axis. We allow non-uniform mapping
    // so that LEDs whose 2D aspect doesn't match their physical aspect still
    // produce a sensible image scale.
    const wppX = ledFaceW_world / cw;
    const wppY = ledFaceH_world / ch;

    // World basis vectors derived from the LED's local axes.
    const worldU = wide.vec.clone().applyQuaternion(wq).normalize();
    const worldV = tall.vec.clone().applyQuaternion(wq).normalize();
    const worldN = thin.vec.clone().applyQuaternion(wq).normalize();

    // Reference LED's centre in world.
    const refWorldCenter = lcenter.clone().applyMatrix4(refMesh.matrixWorld);

    // Where the mapled image's centre sits in canvas-px.
    const mapledCxC = cur.x + sz.w * cur.scale / 2;
    const mapledCyC = cur.y + sz.h * cur.scale / 2;
    const refCxC = refLed.map2d.x + cw / 2;
    const refCyC = refLed.map2d.y + ch / 2;

    const dxC = mapledCxC - refCxC;
    const dyC = mapledCyC - refCyC;

    // Canvas X grows right (= +worldU). Canvas Y grows down (= -worldV).
    const offset = worldU.clone().multiplyScalar(dxC * wppX)
      .add(worldV.clone().multiplyScalar(-dyC * wppY));

    const planePos = refWorldCenter.clone().add(offset);
    // Pull slightly forward along the normal so we don't z-fight other geometry.
    planePos.add(worldN.clone().multiplyScalar(0.002));

    // Plane orientation: +X→worldU, +Y→worldV, +Z→worldN.
    const m = new THREE.Matrix4().makeBasis(worldU, worldV, worldN);
    const planeQuat = new THREE.Quaternion().setFromRotationMatrix(m);

    return {
      width:  sz.w * cur.scale * wppX,
      height: sz.h * cur.scale * wppY,
      position: planePos,
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

  _disposePlane(mesh) {
    if (mesh.parent) mesh.parent.remove(mesh);
    mesh.geometry?.dispose?.();
    mesh.material?.dispose?.();
  }

  dispose() {
    this.editor.removeEventListener('mapled-changed', this._onMapledChanged);
    this.editor.removeEventListener('group-changed', this._onGroupChanged);
    this.editor.removeEventListener('overlay-3d-toggled', this._onOverlayToggled);
    this.editor.removeEventListener('group-overlay-toggled', this._onGroupOverlayToggled);
    this.ledManager.removeEventListener('change', this._onLedChanged);

    this._restoreLedVisibility();
    for (const mesh of this._planes.values()) this._disposePlane(mesh);
    this._planes.clear();
    for (const tex of this._textures.values()) tex.dispose();
    this._textures.clear();
    this._sources.clear();
    this.scene.remove(this.group);
  }
}
