// Application bootstrap. Wires the file loader, 3D viewer, 2D editor,
// LED manager, undo stack, sections manager and the surrounding UI together.

import { LedManager } from './ledManager.js';
import { Viewer3D } from './viewer3d.js';
import { Editor2D } from './editor2d.js';
import { UI } from './ui.js';
import { UndoStack } from './undoStack.js';
import { SectionsManager } from './sectionsManager.js';
import { loadModelFromFile } from './fileLoader.js';
import { $, looksLikeLed, readFileAsDataURL, setStatus, toast } from './utils.js';

// ============ Module instances ============

const ledManager = new LedManager();
const threeContainer = $('#three-container');
const viewer = new Viewer3D(threeContainer, ledManager);
const canvas2d = $('#canvas2d');
const editor = new Editor2D(canvas2d, ledManager);
const ui = new UI(ledManager, viewer, editor);
const undo = new UndoStack(ledManager, editor, { max: 5 });
const sections = new SectionsManager(ledManager, viewer, editor, undo);

// Make toast() reachable from undoStack without circular import.
window.__toast = toast;

// Wire editor "transaction-start" → undo snapshot.
editor.addEventListener('transaction-start', (e) => {
  undo.pushSnapshot(e.detail?.kind || 'edit-2d');
});

// ============ Mode switching ============
let _resumeVideoOn2D = false;

function setMode(mode) {
  const v3 = $('#view-3d'), v2 = $('#view-2d');
  const b3 = $('#mode-3d'), b2 = $('#mode-2d');
  const isThree = mode === '3d';
  v3.classList.toggle('view-active', isThree);
  v2.classList.toggle('view-active', !isThree);
  b3.classList.toggle('active', isThree);
  b2.classList.toggle('active', !isThree);
  b3.setAttribute('aria-selected', String(isThree));
  b2.setAttribute('aria-selected', String(!isThree));
  $('#status-mode').textContent = `Chế độ: ${isThree ? '3D' : '2D Mapping'}`;

  // Pause video when leaving 2D, optionally resume when returning.
  const vid = editor.getVideo();
  if (isThree && vid && !vid.paused) {
    _resumeVideoOn2D = true;
    vid.pause();
  } else if (!isThree && _resumeVideoOn2D && vid) {
    _resumeVideoOn2D = false;
    vid.play().catch(() => {});
  }

  if (isThree) requestAnimationFrame(() => viewer.resize());
  else requestAnimationFrame(() => { editor.resize(); editor.render(); });
}
$('#mode-3d').addEventListener('click', () => setMode('3d'));
$('#mode-2d').addEventListener('click', () => setMode('2d'));

// ============ 3D file handling ============
async function handle3DFile(file) {
  if (!file) return;
  showLoading(`Đang tải ${file.name}...`);
  try {
    const { root, fileName } = await loadModelFromFile(file);
    afterModelLoaded(root, fileName);
    toast(`Đã tải ${fileName} thành công`, 'success');
  } catch (err) {
    console.error(err);
    toast(err.message || 'Không tải được file 3D', 'error', 6000);
    setStatus(`Lỗi: ${err.message}`);
  } finally {
    hideLoading();
  }
}

function afterModelLoaded(root, fileName) {
  ledManager.setModelRoot(root);
  viewer.setModel(root);
  ui.setModel(root);
  undo.clear();
  setStatus(`Đã tải: ${fileName} · ${countMeshes(root)} object`);
  setMode('3d');
}

function countMeshes(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n++; });
  return n;
}

$('#file-3d').addEventListener('change', (e) => handle3DFile(e.target.files[0]));

// ============ Mapled image / video ============
let _mapledObjectUrl = null;

$('#file-mapled').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await loadMapledFile(file);
});

async function loadMapledFile(file) {
  // Revoke previous object URL to avoid leaks.
  if (_mapledObjectUrl) {
    URL.revokeObjectURL(_mapledObjectUrl);
    _mapledObjectUrl = null;
  }

  if (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name)) {
    const url = URL.createObjectURL(file);
    _mapledObjectUrl = url;
    const video = document.createElement('video');
    video.src = url;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    await new Promise((res, rej) => {
      video.addEventListener('loadeddata', res, { once: true });
      video.addEventListener('error', () => rej(new Error('Không đọc được video')), { once: true });
    });
    editor.setMapledImage(video);
    setupVideoControls(video);
    setMode('2d');
    toast(`Đã tải video (${video.videoWidth}×${video.videoHeight}, ${formatTime(video.duration)})`, 'success');
  } else if (file.type.startsWith('image/')) {
    try {
      const url = await readFileAsDataURL(file);
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('Không đọc được ảnh'));
        img.src = url;
      });
      editor.setMapledImage(img);
      hideVideoControls();
      setMode('2d');
      toast(`Đã tải ảnh mapled (${img.naturalWidth}×${img.naturalHeight})`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  } else {
    toast('Định dạng không hỗ trợ', 'warn');
  }
}

function setupVideoControls(video) {
  const ctrls = $('#video-controls');
  ctrls.classList.remove('hidden');
  const playBtn = $('#vid-play');
  const seek = $('#vid-seek');
  const timeLbl = $('#vid-time');

  const updateBtn = () => { playBtn.textContent = video.paused ? '▶' : '⏸'; };
  const updateTime = () => {
    if (!isFinite(video.duration)) return;
    seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
    timeLbl.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
  };

  playBtn.onclick = () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    updateBtn();
  };
  seek.oninput = () => {
    if (!isFinite(video.duration)) return;
    video.currentTime = (+seek.value / 1000) * video.duration;
    updateTime();
  };
  video.addEventListener('play', updateBtn);
  video.addEventListener('pause', updateBtn);
  video.addEventListener('timeupdate', updateTime);
  updateBtn(); updateTime();
}

function hideVideoControls() {
  $('#video-controls').classList.add('hidden');
}

function formatTime(sec) {
  if (!isFinite(sec)) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ============ Auto-detect / Clear LEDs ============
$('#btn-autodetect').addEventListener('click', () => {
  if (!viewer.modelRoot) {
    toast('Cần import model 3D trước', 'warn');
    return;
  }
  undo.pushSnapshot('auto-detect');
  const added = viewer.autoDetectLEDs(looksLikeLed);
  if (added.length) toast(`Đã tự động phát hiện ${added.length} LED panel`, 'success');
  else toast('Không tìm thấy object nào trông giống LED. Hãy click thủ công vào các tấm LED trong khung 3D.', 'info', 5000);
});

$('#btn-clear-led').addEventListener('click', () => {
  if (!ledManager.list().length) return;
  if (!confirm('Bỏ đánh dấu tất cả LED?')) return;
  undo.pushSnapshot('clear-all-leds');
  for (const led of ledManager.list()) ledManager.remove(led.id);
});

// ============ 3D camera presets ============
$('#cam-front').addEventListener('click', () => viewer.setCameraPreset('front'));
$('#cam-top').addEventListener('click', () => viewer.setCameraPreset('top'));
$('#cam-left').addEventListener('click', () => viewer.setCameraPreset('left'));
$('#cam-right').addEventListener('click', () => viewer.setCameraPreset('right'));
$('#cam-iso').addEventListener('click', () => viewer.setCameraPreset('iso'));
$('#cam-fit').addEventListener('click', () => viewer.modelRoot && viewer.fitToObject(viewer.modelRoot));

const gridBtn = $('#toggle-grid');
gridBtn.addEventListener('click', () => {
  const on = !gridBtn.classList.contains('active');
  gridBtn.classList.toggle('active', on);
  viewer.setGridVisible(on);
});
const wireBtn = $('#toggle-wire');
wireBtn.addEventListener('click', () => {
  const on = !wireBtn.classList.contains('active');
  wireBtn.classList.toggle('active', on);
  viewer.setWireframe(on);
});

// 3D viewer should also push undo snapshots when LEDs are toggled by clicking.
viewer.renderer.domElement.addEventListener('pointerdown', () => {
  // We can't easily know if this click will toggle a LED before the click resolves;
  // simpler: snapshot on any click that lands on a mesh.
  // Defer to viewer's own logic; we add undo at the toggleByMesh wrapper below.
});

// Wrap ledManager.toggleByMesh to push undo. The viewer's _handleClick calls
// either findByMesh+select (no mutation) or add/toggle (mutation).
const _origAdd = ledManager.add.bind(ledManager);
const _origRemove = ledManager.remove.bind(ledManager);
const _origToggleByMesh = ledManager.toggleByMesh.bind(ledManager);
ledManager.add = function (mesh) {
  if (!ledManager.has(mesh.uuid) && !undo.isApplying) undo.pushSnapshot('add-led');
  return _origAdd(mesh);
};
ledManager.remove = function (id) {
  if (ledManager.leds.has(id) && !undo.isApplying) undo.pushSnapshot('remove-led');
  return _origRemove(id);
};
ledManager.toggleByMesh = function (mesh) {
  if (!undo.isApplying) undo.pushSnapshot('toggle-led');
  return _origToggleByMesh(mesh);
};

// ============ 2D toolbar ============
$('#scale-select').addEventListener('change', (e) => editor.setViewScale(parseFloat(e.target.value)));
$('#grid-size').addEventListener('input', (e) => editor.setGridSize(e.target.value));
const snapBtn = $('#toggle-snap');
snapBtn.addEventListener('click', () => {
  const on = !snapBtn.classList.contains('active');
  snapBtn.classList.toggle('active', on);
  editor.setSnap(on);
});

// Pixel-pitch — debounced undo snapshot.
let _pitchTimer = null;
$('#pixel-pitch').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  if (!isNaN(v) && v > 0) {
    clearTimeout(_pitchTimer);
    _pitchTimer = setTimeout(() => undo.pushSnapshot('pixel-pitch'), 0);
    ledManager.setPixelPitch(v);
  }
});

$('#mapled-opacity').addEventListener('input', (e) => editor.setMapledOpacity(+e.target.value / 100));
$('#auto-arrange').addEventListener('click', () => {
  if (!ledManager.list().length) { toast('Chưa có LED nào để sắp xếp', 'warn'); return; }
  undo.pushSnapshot('auto-arrange');
  ledManager.autoArrangeFromWorld(120, 60, 60);
  editor.resetView();
  toast('Đã chiếu vị trí 2D từ vị trí 3D', 'success');
});
$('#reset-2d').addEventListener('click', () => editor.resetView());

// Tool toggle.
const toolSelectBtn = $('#tool-select'), toolPanBtn = $('#tool-pan');
toolSelectBtn.addEventListener('click', () => switchTool('select'));
toolPanBtn.addEventListener('click', () => switchTool('pan'));
function switchTool(t) {
  editor.setTool(t);
  toolSelectBtn.classList.toggle('active', t === 'select');
  toolPanBtn.classList.toggle('active', t === 'pan');
}

// Preview mode + Mask toggles.
const previewBtn = $('#toggle-preview'), maskBtn = $('#toggle-mask');
previewBtn.addEventListener('click', () => {
  const on = !previewBtn.classList.contains('active');
  previewBtn.classList.toggle('active', on);
  editor.setRenderMode(on ? 'preview' : 'setup');
});
maskBtn.addEventListener('click', () => {
  const on = !maskBtn.classList.contains('active');
  maskBtn.classList.toggle('active', on);
  editor.setMaskOutside(on);
});

// Undo buttons in both views.
$('#btn-undo').addEventListener('click', () => undo.undo());
$('#btn-undo-2d').addEventListener('click', () => undo.undo());

// ============ Save / Open project ============
$('#btn-save-project').addEventListener('click', () => sections.openSaveDialog());
$('#btn-open-project').addEventListener('click', () => sections.openOpenDialog());

// ============ Drag & drop ============
['dragover', 'drop'].forEach((ev) => {
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev !== 'drop') return;
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (/\.(png|jpe?g|webp|gif|bmp|mp4|webm|mov|m4v|ogv)$/i.test(f.name) || f.type.startsWith('image/') || f.type.startsWith('video/')) {
      loadMapledFile(f);
    } else {
      handle3DFile(f);
    }
  });
});

// ============ Keyboard shortcuts ============
window.addEventListener('keydown', (e) => {
  const tag = (e.target?.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;

  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo.undo();
    return;
  }
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    sections.openSaveDialog();
    return;
  }
  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    sections.openOpenDialog();
    return;
  }
  if (mod) return;

  if (e.key === 'f' || e.key === 'F') viewer.setCameraPreset('front');
  else if (e.key === 't' || e.key === 'T') viewer.setCameraPreset('top');
  else if (e.key === 'l' || e.key === 'L') viewer.setCameraPreset('left');
  else if (e.key === 'i' || e.key === 'I') viewer.setCameraPreset('iso');
  else if (e.key === 'v' || e.key === 'V') switchTool('select');
  else if (e.key === 'h' || e.key === 'H') switchTool('pan');
  else if (e.key === ' ') {
    if (viewer.modelRoot) viewer.fitToObject(viewer.modelRoot);
    e.preventDefault();
  } else if (e.key === '1') setMode('3d');
  else if (e.key === '2') setMode('2d');
});

// ============ Loading overlay ============
function showLoading(msg) {
  $('#loading-text').textContent = msg || 'Đang tải...';
  $('#loading-overlay').classList.remove('hidden');
}
function hideLoading() {
  $('#loading-overlay').classList.add('hidden');
}

// ============ Initial render ============
viewer.resize();
editor.resize();
ui.renderObjectTree();
ui.renderLedList();
ui.renderStats();
setStatus('Sẵn sàng. Hãy import file 3D.');

// Start auto-save & offer restore from previous session.
sections.startAutoSave();
sections.maybeOfferRestore();

// Expose for debugging.
window.__app = { ledManager, viewer, editor, ui, undo, sections };
