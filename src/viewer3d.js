// Three.js based 3D viewer with click-to-select for LED panels.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MapledOverlay3D } from './mapledOverlay3d.js';

export class Viewer3D extends EventTarget {
  constructor(container, ledManager) {
    super();
    this.container = container;
    this.ledManager = ledManager;
    /** @type {MapledOverlay3D|null} */
    this.mapledOverlay = null;

    // Scene & camera.
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0f1d);
    this.scene.fog = new THREE.Fog(0x0a0f1d, 60, 200);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(22, 18, 22);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 500;
    this.controls.target.set(0, 0, 0);

    this._setupLights();
    this._setupHelpers();

    // Picking infra.
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._dragStart = null;
    this._hoverMesh = null;
    this._hoverOriginalEmissive = null;

    /** @type {THREE.Object3D|null} */
    this.modelRoot = null;
    this._allMeshes = [];

    this._wireframe = false;

    this._bind();
    this._loop = this._loop.bind(this);
    this._lastFrame = performance.now();
    this._fpsAccum = 0; this._fpsCount = 0; this._fps = 0;
    requestAnimationFrame(this._loop);

    // React to selection changes coming from elsewhere (e.g., the LED list).
    ledManager.on('selection', () => this._refreshSelectionVisuals());
    ledManager.on('change', () => this._refreshSelectionVisuals());
  }

  // Bootstrap the 3D mapled overlay. Called once main.js has constructed
  // both Editor2D and Viewer3D so the overlay can subscribe to editor events.
  attachEditor(editor) {
    if (this.mapledOverlay) this.mapledOverlay.dispose();
    this.mapledOverlay = new MapledOverlay3D(this.scene, this.ledManager, editor);
  }

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0x9bbcff, 0x0a0f1d, 0.55);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(10, 18, 12);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -25; key.shadow.camera.right = 25;
    key.shadow.camera.top = 25; key.shadow.camera.bottom = -25;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-12, 6, -8);
    this.scene.add(fill);
  }

  _setupHelpers() {
    this.grid = new THREE.GridHelper(60, 60, 0x223355, 0x162033);
    this.grid.position.y = 0;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(2.5);
    this.axes.position.y = 0.01;
    this.scene.add(this.axes);

    // A subtle ground plane to receive shadows.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ opacity: 0.25 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
  }

  _bind() {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => {
      this._dragStart = { x: e.clientX, y: e.clientY };
    });
    dom.addEventListener('pointerup', (e) => {
      if (!this._dragStart) return;
      const dx = e.clientX - this._dragStart.x;
      const dy = e.clientY - this._dragStart.y;
      this._dragStart = null;
      // Treat as click only if pointer barely moved; lets OrbitControls own drags.
      if (Math.hypot(dx, dy) < 4 && e.button === 0) {
        this._handleClick(e);
      }
    });
    dom.addEventListener('pointermove', (e) => this._handleHover(e));
    dom.addEventListener('pointerleave', () => this._clearHover());

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  setModel(root) {
    if (this.modelRoot) {
      this.scene.remove(this.modelRoot);
      this.modelRoot.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
          else o.material?.dispose?.();
        }
      });
    }

    this.modelRoot = root;
    this.scene.add(root);

    // Catalog all meshes for picking / highlighting; ensure shadows.
    this._allMeshes = [];
    root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        this._allMeshes.push(o);
      }
    });

    this.fitToObject(root);
    this.dispatchEvent(new CustomEvent('model-loaded', { detail: { root } }));
  }

  // Frame the camera to fully encompass an object.
  fitToObject(obj, paddingFactor = 1.4) {
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = this.camera.fov * (Math.PI / 180);
    const distance = (maxDim / 2 / Math.tan(fov / 2)) * paddingFactor;

    const dir = new THREE.Vector3(1, 0.7, 1.1).normalize();
    this.camera.position.copy(center.clone().add(dir.multiplyScalar(distance)));
    this.controls.target.copy(center);
    this.camera.near = Math.max(0.05, distance / 200);
    this.camera.far = distance * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setCameraPreset(preset) {
    if (!this.modelRoot) return;
    const box = new THREE.Box3().setFromObject(this.modelRoot);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const dist = Math.max(size.x, size.y, size.z) * 1.6;
    const presets = {
      front: [0, 0, dist],
      top: [0, dist, 0.001],
      left: [-dist, 0, 0],
      right: [dist, 0, 0],
      iso: [dist * 0.7, dist * 0.7, dist * 0.7],
    };
    const p = presets[preset] || presets.iso;
    this.camera.position.set(center.x + p[0], center.y + p[1], center.z + p[2]);
    this.controls.target.copy(center);
    this.controls.update();
  }

  setGridVisible(v) { this.grid.visible = v; this.axes.visible = v; }
  setWireframe(on) {
    this._wireframe = on;
    for (const m of this._allMeshes) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach((mt) => { if (mt) mt.wireframe = on; });
    }
  }

  // ============ Picking ============
  _pointerToNDC(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  _pickMesh(e) {
    if (!this._allMeshes.length) return null;
    this._pointerToNDC(e);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this._allMeshes, false);
    return hits.length ? hits[0].object : null;
  }

  _handleClick(e) {
    const mesh = this._pickMesh(e);
    if (!mesh) {
      if (!e.shiftKey) this.ledManager.clearSelection();
      return;
    }
    const additive = e.shiftKey;
    const ledGroup = this._findLedGroup(mesh);

    if (e.ctrlKey || e.metaKey) {
      // Ctrl+click toggles the whole group (or single mesh).
      if (ledGroup) this.ledManager.toggleGroup(ledGroup);
      else this.ledManager.toggleByMesh(mesh);
    } else if (ledGroup) {
      // Regular click on a mesh inside a LED-named group → add & select whole group.
      this.ledManager.addGroup(ledGroup);
      if (!additive) this.ledManager.selection.clear();
      ledGroup.traverse((o) => {
        if (o.isMesh) {
          const led = this.ledManager.findByMesh(o.uuid);
          if (led) this.ledManager.selection.add(led.id);
        }
      });
      this.ledManager._emit('selection');
    } else {
      const led = this.ledManager.findByMesh(mesh.uuid) || this.ledManager.add(mesh);
      if (led) {
        if (additive) this.ledManager.toggleSelection(led.id);
        else this.ledManager.select(led.id, false);
      }
    }
  }

  // Walk up the ancestor chain from mesh to find the innermost Group whose
  // name contains a LED/screen keyword.
  _findLedGroup(mesh) {
    const LED_RE = /led|screen|display|panel/i;
    let cur = mesh.parent;
    while (cur && cur !== this.modelRoot && cur !== this.scene) {
      if (!cur.isMesh && cur.children.length > 0 && LED_RE.test(cur.name || '')) {
        return cur;
      }
      cur = cur.parent;
    }
    return null;
  }

  _handleHover(e) {
    if (this._dragStart) return; // skip while orbiting
    const mesh = this._pickMesh(e);
    if (mesh === this._hoverMesh) return;
    this._clearHover();
    if (!mesh) {
      this.renderer.domElement.style.cursor = 'default';
      return;
    }
    this._hoverMesh = mesh;
    this.renderer.domElement.style.cursor = 'pointer';
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    this._hoverOriginalEmissive = mats.map((m) => (m && 'emissive' in m) ? m.emissive.getHex() : null);
    mats.forEach((m) => {
      if (m && 'emissive' in m) m.emissive.setHex(0x222266);
    });
  }

  _clearHover() {
    if (!this._hoverMesh) return;
    const mats = Array.isArray(this._hoverMesh.material) ? this._hoverMesh.material : [this._hoverMesh.material];
    mats.forEach((m, i) => {
      if (m && 'emissive' in m && this._hoverOriginalEmissive?.[i] != null) {
        m.emissive.setHex(this._hoverOriginalEmissive[i]);
      }
    });
    this._hoverMesh = null;
    this._hoverOriginalEmissive = null;
  }

  _refreshSelectionVisuals() {
    // Add an outline-like effect by boosting emissiveIntensity for selected LED meshes.
    for (const led of this.ledManager.list()) {
      const mesh = led._mesh;
      if (!mesh) continue;
      const selected = this.ledManager.isSelected(led.id);
      if (mesh.material && 'emissiveIntensity' in mesh.material) {
        mesh.material.emissiveIntensity = selected ? 1.4 : 0.55;
      }
    }
  }

  // ============ Auto-detect ============
  // Returns the array of newly-flagged LED records.
  autoDetectLEDs(predicate) {
    const added = [];
    for (const m of this._allMeshes) {
      if (this.ledManager.has(m.uuid)) continue;
      if (predicate(m)) {
        const r = this.ledManager.add(m);
        if (r) added.push(r);
      }
    }
    return added;
  }

  focusOnLed(led) {
    if (led?._mesh) this.fitToObject(led._mesh, 2.4);
  }

  // ============ Render Loop ============
  _loop() {
    requestAnimationFrame(this._loop);
    this.controls.update();
    const now = performance.now();
    const dt = now - this._lastFrame;
    this._lastFrame = now;
    this._fpsAccum += dt; this._fpsCount++;
    if (this._fpsAccum >= 500) {
      this._fps = Math.round((this._fpsCount * 1000) / this._fpsAccum);
      this._fpsAccum = 0; this._fpsCount = 0;
      const el = document.getElementById('status-fps');
      if (el) el.textContent = `${this._fps} FPS`;
    }
    this.renderer.render(this.scene, this.camera);
  }
}
