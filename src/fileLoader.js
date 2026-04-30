// Loads a 3D scene from user-supplied files.
//
// SketchUp's native .skp format is closed and cannot be parsed in-browser
// without a heavy proprietary SDK. Standard practice (and what we instruct
// the user to do) is to export from SketchUp to one of the open formats below
// before importing here:
//   * .gltf / .glb  – preferred, smallest & fastest
//   * .dae          – Collada, SketchUp's default export
//   * .obj          – widely supported
//   * .fbx          – via FBXLoader

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { readFileAsArrayBuffer, readFileAsText, readFileAsDataURL } from './utils.js';

export async function loadModelFromFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  switch (ext) {
    case 'glb':
    case 'gltf':
      return loadGLTF(file);
    case 'obj':
      return loadOBJ(file);
    case 'dae':
      return loadDAE(file);
    case 'fbx':
      return loadFBX(file);
    case 'skp':
      throw new Error(
        'File .skp gốc của SketchUp không thể đọc trực tiếp. ' +
        'Hãy mở trong SketchUp và Export sang .dae / .gltf / .obj / .fbx, rồi import lại.'
      );
    default:
      throw new Error(`Định dạng "${ext}" không được hỗ trợ.`);
  }
}

async function loadGLTF(file) {
  const url = await readFileAsDataURL(file);
  const loader = new GLTFLoader();
  return new Promise((resolve, reject) => {
    loader.load(url, (gltf) => {
      const root = gltf.scene || gltf.scenes[0];
      resolve({ root, fileName: file.name });
    }, undefined, (e) => reject(e));
  });
}

async function loadOBJ(file) {
  const text = await readFileAsText(file);
  const loader = new OBJLoader();
  const root = loader.parse(text);
  return { root, fileName: file.name };
}

async function loadDAE(file) {
  const text = await readFileAsText(file);
  const loader = new ColladaLoader();
  const result = loader.parse(text);
  const root = result.scene;
  return { root, fileName: file.name };
}

async function loadFBX(file) {
  const buffer = await readFileAsArrayBuffer(file);
  const loader = new FBXLoader();
  // FBXLoader.parse takes ArrayBuffer + path for resolving textures.
  const root = loader.parse(buffer, '');
  return { root, fileName: file.name };
}

// Build a synthetic stage with a few placeholder LED panels so the user can
// experiment with the tool before having a real SketchUp model on hand.
export function buildDemoStage() {
  const root = new THREE.Group();
  root.name = 'DemoStage';

  // Floor (stage platform).
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(20, 0.4, 12),
    new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.85 })
  );
  floor.name = 'Stage_Floor';
  floor.position.y = 0.2;
  root.add(floor);

  // Truss-like back beam.
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(20, 0.3, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x3b3f47, metalness: 0.6, roughness: 0.4 })
  );
  beam.name = 'Truss_Back';
  beam.position.set(0, 7.5, -5.5);
  root.add(beam);

  // Helper to make an LED panel with a name hint.
  function ledPanel(name, w, h, x, y, z, ry = 0) {
    const geom = new THREE.BoxGeometry(w, h, 0.15);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: 0x080808, roughness: 0.5
    });
    mat.name = `LED_Material_${name}`;
    const mesh = new THREE.Mesh(geom, mat);
    mesh.name = name;
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    return mesh;
  }

  // Main back wall - one big LED.
  root.add(ledPanel('LED_Main_Back', 12, 6, 0, 4, -5));

  // Two side wings at angles.
  root.add(ledPanel('LED_Side_Left', 4, 5, -7.5, 3.5, -3.5, Math.PI / 6));
  root.add(ledPanel('LED_Side_Right', 4, 5, 7.5, 3.5, -3.5, -Math.PI / 6));

  // Bottom front strips.
  root.add(ledPanel('LED_Front_Strip_1', 4, 1.2, -4, 1.2, 5.5));
  root.add(ledPanel('LED_Front_Strip_2', 4, 1.2, 4, 1.2, 5.5));

  // Top header.
  root.add(ledPanel('LED_Header_Top', 14, 1.5, 0, 7.5, -4.9));

  // A couple of decorative non-LED objects.
  for (let i = 0; i < 4; i++) {
    const speaker = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 1.2, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x1f2937 })
    );
    speaker.name = `Speaker_${i + 1}`;
    speaker.position.set(-9 + i * 6, 1, 5);
    root.add(speaker);
  }

  return { root, fileName: 'demo-stage.gltf' };
}
