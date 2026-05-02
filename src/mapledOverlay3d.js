// 3D mapled overlay — projects each LED group's mapled image/video onto its
// 3D LED panel face.
//
// Per LED, we build a textured plane whose UV crop region matches that LED's
// 2D map2d rect normalized to the mapled's natural pixel dimensions. The plane
// is positioned slightly offset (1mm) along the LED's smallest-axis so it
// floats just in front of the panel without z-fighting.
//
// Texture sources:
//   - HTMLImageElement → THREE.CanvasTexture (one-shot upload)
//   - HTMLVideoElement → THREE.VideoTexture (auto re-uploads each frame)
//
// The class subscribes to:
//   - editor 'mapled-changed'  → refresh()
//   - editor 'group-changed'   → setActiveGroup()
//   - ledManager 'change'      → refresh() (LED moved → plane moves)

import * as THREE from 'three';

const Z_OFFSET = 0.001; // 1 mm

export class MapledOverlay3D {
  constructor(scene, ledManager, editor) {
    this.scene = scene;
    this.ledManager = ledManager;
    this.editor = editor;

    this.group = new THREE.Group();
    this.group.name = 'MapledOverlay3D';
    this.group.renderOrder = 999;
    this.scene.add(this.group);

    this._meshes = new Map();        // ledId → Mesh
    this._textures = new Map();      // groupName → THREE.Texture
    this._sources = new Map();       // groupName → image|video reference (for invalidation)

    this._visible = true;
    this._enabled = editor.getOverlay3dEnabled?.() ?? true;

    // Subscriptions
    this._onMapledChanged = () => this.refresh();
    this._onGroupChanged = () => this.refresh();
    this._onLedChanged = () => this.refresh();
    this._onOverlayToggled = (e) => {
      this._enabled = !!e.detail;
      this.group.visible = this._enabled && this._visible;
      this.refresh();
    };

    editor.addEventListener('mapled-changed', this._onMapledChanged);
    editor.addEventListener('group-changed', this._onGroupChanged);
    editor.addEventListener('overlay-3d-toggled', this._onOverlayToggled);
    ledManager.addEventListener('change', this._onLedChanged);
  }

  setVisible(on) {
    this._visible = !!on;
    this.group.visible = this._enabled && this._visible;
  }

  refresh() {
    // Hide all and re-build only the active group's planes.
    if (!this._enabled) {
      this.group.visible = false;
      return;
    }
    this.group.visible = this._visible;

    const activeKey = this.editor._activeKey ? this.editor._activeKey() : '';
    const showAll = this.editor.activeGroup === '__all__';

    // We rebuild meshes lazily — keep per-LED meshes that still apply, dispose stale ones.
    const seenIds = new Set();
    const leds = this.ledManager.list().filter(l => {
      if (!l._mesh) return false;
      if (showAll) return true;
      return (l.group || '') === activeKey;
    });

    for (const led of leds) {
      if (led.hidden) continue;
      const groupName = led.group || '';
      const cur = this.editor._groups?.get(groupName);
      if (!cur || !cur.image) continue;

      const tex = this._ensureTexture(groupName, cur.image);
      if (!tex) continue;

      // Update UV crop based on map2d normalized to mapled size
      const sz = this._mapledSize(cur.image);
      if (!sz.w || !sz.h) continue;

      // The mapled rect on the 2D canvas spans:
      //   [cur.x .. cur.x + sz.w*cur.scale]  ×  [cur.y .. cur.y + sz.h*cur.scale]
      // The LED's map2d.{x,y,w,h} (axis-aligned) tells us which slice of the
      // mapled corresponds to that LED's surface. Normalize to [0..1].
      const mapledW = sz.w * cur.scale;
      const mapledH = sz.h * cur.scale;
      const m = led.map2d;
      const u0 = (m.x - cur.x) / mapledW;
      const v0 = (m.y - cur.y) / mapledH;
      const uw = m.w / mapledW;
      const vh = m.h / mapledH;

      const mesh = this._ensureMesh(led, tex);
      const material = mesh.material;

      // Clone texture for per-LED UV transform (so different LEDs share the
      // underlying image bitmap but have independent offset/repeat/center).
      let perLedTex = mesh.userData._perLedTex;
      if (!perLedTex || perLedTex._sourceTex !== tex) {
        // Dispose stale per-LED texture
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
      // Three.js V coords are bottom-up; canvas/image are top-down → flip.
      perLedTex.offset.set(u0, 1 - (v0 + vh));
      perLedTex.repeat.set(uw, vh);

      // Apply LED rotation in UV space (around the centre of the cropped region).
      perLedTex.center.set(u0 + uw / 2, 1 - (v0 + vh / 2));
      perLedTex.rotation = -(m.rotation || 0);

      // Keep plane sized to LED face, positioned at LED centre, oriented as LED.
      this._positionPlaneAtLed(mesh, led);

      seenIds.add(led.id);
    }

    // Remove stale meshes.
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
      });
      mesh = new THREE.Mesh(geom, mat);
      mesh.name = `MapledOverlay_${led.id}`;
      mesh.renderOrder = 1000;
      this.group.add(mesh);
      this._meshes.set(led.id, mesh);
    }
    return mesh;
  }

  _positionPlaneAtLed(mesh, led) {
    const ledMesh = led._mesh;
    if (!ledMesh) return;
    ledMesh.updateWorldMatrix(true, false);

    // World-aligned bbox is plenty for placing the plane in front of the panel.
    const box = new THREE.Box3().setFromObject(ledMesh);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // Pick the smallest axis as the "thickness" direction. Move plane
    // along that axis by half-thickness + Z_OFFSET to sit on the front face.
    const axes = [
      { ax: 'x', val: size.x },
      { ax: 'y', val: size.y },
      { ax: 'z', val: size.z },
    ].sort((a, b) => a.val - b.val);
    const thinAxis = axes[0].ax;
    const half = axes[0].val / 2;

    // Resize plane to LED face dimensions (the two largest axes).
    const faceW = axes[2].val;
    const faceH = axes[1].val;
    mesh.scale.set(faceW, faceH, 1);

    // Reset orientation so the plane is XY-aligned by default, then face the
    // thin axis in world space.
    mesh.rotation.set(0, 0, 0);
    mesh.position.copy(center);
    if (thinAxis === 'z') {
      // already correct (plane normal is +Z by default)
      mesh.position.z += half + Z_OFFSET;
    } else if (thinAxis === 'x') {
      mesh.rotation.y = Math.PI / 2;
      mesh.position.x += half + Z_OFFSET;
    } else {
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y += half + Z_OFFSET;
    }
  }

  _ensureTexture(groupName, src) {
    const cached = this._textures.get(groupName);
    if (cached && this._sources.get(groupName) === src) {
      // For VideoTexture, mark dirty each refresh — Three uploads each frame.
      if (cached.isVideoTexture) cached.needsUpdate = true;
      return cached;
    }
    // Stale — dispose
    if (cached) cached.dispose();

    let tex = null;
    if (src instanceof HTMLVideoElement) {
      tex = new THREE.VideoTexture(src);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.format = THREE.RGBAFormat;
    } else if (src instanceof HTMLImageElement) {
      // Use CanvasTexture so we control flipping & srgb explicitly.
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
    this.group.remove(mesh);
    if (mesh.userData._perLedTex) mesh.userData._perLedTex.dispose();
    mesh.geometry?.dispose?.();
    mesh.material?.dispose?.();
  }

  dispose() {
    this.editor.removeEventListener('mapled-changed', this._onMapledChanged);
    this.editor.removeEventListener('group-changed', this._onGroupChanged);
    this.editor.removeEventListener('overlay-3d-toggled', this._onOverlayToggled);
    this.ledManager.removeEventListener('change', this._onLedChanged);

    for (const mesh of this._meshes.values()) this._disposeMesh(mesh);
    this._meshes.clear();
    for (const tex of this._textures.values()) tex.dispose();
    this._textures.clear();
    this._sources.clear();
    this.scene.remove(this.group);
  }
}
