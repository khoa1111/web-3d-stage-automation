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
