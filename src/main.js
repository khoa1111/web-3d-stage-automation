// Application bootstrap. Wires the file loader, 3D viewer, 2D editor,
// LED manager, undo stack, sections manager and the surrounding UI together.

import { LedManager } from './ledManager.js';
import { Viewer3D } from './viewer3d.js';
import { Editor2D, GROUP_ALL } from './editor2d.js';
import { UI } from './ui.js';
import { UndoStack } from './undoStack.js';
import { SectionsManager } from './sectionsManager.js';
import { loadModelFromFile } from './fileLoader.js';
import { $, looksLikeLed, readFileAsDataURL, setStatus, toast } from './utils.js';
import { i18n, t } from './i18n.js';

// ============ Module instances ============

// Tracks the most recently-loaded model File. Set by handle3DFile() below;
// read by SectionsManager when "Save with assets" is requested. Declared at
// the top so the SectionsManager closure can capture it before initialization.
let _currentModelFile = null;

const ledManager = new LedManager();
const threeContainer = $('#three-container');
const viewer = new Viewer3D(threeContainer, ledManager);
const canvas2d = $('#canvas2d');
const editor = new Editor2D(canvas2d, ledManager);
const ui = new UI(ledManager, viewer, editor);
const undo = new UndoStack(ledManager, editor, { max: 5 });
const sections = new SectionsManager(ledManager, viewer, editor, undo, {
  getModelFile: () => _currentModelFile,
  loadModelFromFile: (file) => handle3DFile(file),
  loadMapledFromFile: (file) => loadMapledFile(file),
});

// 3D mapled overlay (depends on editor; construct after both exist).
viewer.attachEditor(editor);

// Make toast() reachable from undoStack and the UI without circular import.
window.__toast = toast;

// Wire editor "transaction-start" → undo snapshot.
editor.addEventListener('transaction-start', (e) => {
  undo.pushSnapshot(e.detail?.kind || 'edit-2d');
});

// ============ i18n bootstrap ============
document.documentElement.setAttribute('lang', i18n.lang);
i18n.applyTo(document);

function refreshLangToggle() {
  const isVi = i18n.lang === 'vi';
  $('#lang-opt-vi')?.classList.toggle('is-active', isVi);
  $('#lang-opt-en')?.classList.toggle('is-active', !isVi);
}
refreshLangToggle();
$('#btn-lang').addEventListener('click', () => {
  i18n.toggle();
  refreshLangToggle();
  toast(t('toast.langChanged'), 'info', 1800);
  updateModeStatus();
  updateFreezeAllLabel();
  rebuildGroupDropdown();
});

// ============ Mode switching ============

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
  updateModeStatus();

  viewer.setActive(isThree);
  if (isThree) requestAnimationFrame(() => viewer.resize());
  else requestAnimationFrame(() => { editor.resize(); editor.render(); });
}

function updateModeStatus() {
  const v2 = $('#view-2d');
  const isThree = !v2.classList.contains('view-active');
  $('#status-mode').textContent = `${t('status.mode')}: ${isThree ? t('status.mode.3d') : t('status.mode.2d')}`;
}
$('#mode-3d').addEventListener('click', () => setMode('3d'));
$('#mode-2d').addEventListener('click', () => setMode('2d'));

// ============ 3D file handling ============
async function handle3DFile(file) {
  if (!file) return;
  showLoading(`${t('toast.loaded')} ${file.name}…`);
  try {
    const { root, fileName } = await loadModelFromFile(file);
    _currentModelFile = file;
    afterModelLoaded(root, fileName);
    toast(`${t('toast.loaded')} ${fileName}`, 'success');
  } catch (err) {
    console.error(err);
    toast(err.message || 'Failed to load 3D file', 'error', 6000);
    setStatus(`Error: ${err.message}`);
  } finally {
    hideLoading();
  }
}

function afterModelLoaded(root, fileName) {
  ledManager.setModelRoot(root);
  viewer.setModel(root);
  ui.setModel(root);
  undo.clear();
  setStatus(`${t('toast.loaded')}: ${fileName} · ${countMeshes(root)} ${t('stat.leds')}`);
  setMode('3d');
}

function countMeshes(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n++; });
  return n;
}

$('#file-3d').addEventListener('change', (e) => handle3DFile(e.target.files[0]));

// ============ Mapled image / video ============
let _mapledObjectUrls = []; // we keep a few for per-group videos

$('#file-mapled').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await loadMapledFile(file);
});

async function loadMapledFile(file) {
  if (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name)) {
    const url = URL.createObjectURL(file);
    _mapledObjectUrls.push(url);
    const video = document.createElement('video');
    video.src = url;
    video.loop = false;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    await new Promise((res, rej) => {
      video.addEventListener('loadeddata', res, { once: true });
      video.addEventListener('error', () => rej(new Error('Could not read video')), { once: true });
    });
    editor.setMapledImage(video, file);
    videoSync.refresh();
    setMode('2d');
    toast(t('toast.videoLoaded', { w: video.videoWidth, h: video.videoHeight, time: formatTime(video.duration) }), 'success');
  } else if (file.type.startsWith('image/')) {
    try {
      const url = await readFileAsDataURL(file);
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('Could not read image'));
        img.src = url;
      });
      editor.setMapledImage(img, file);
      videoSync.refresh();
      setMode('2d');
      toast(t('toast.imageLoaded', { w: img.naturalWidth, h: img.naturalHeight }), 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  } else {
    toast(t('toast.unsupported'), 'warn');
  }
}

// ============ Multi-video sync ============
// Drives every per-group video from a single play/seek control. The longest
// video defines the global timeline; shorter videos pause at their last frame
// once the timeline scrubs past their duration.

class VideoSync {
  constructor() {
    this.videos = [];
    this._listeners = []; // [el, evt, fn] entries
    this._dom = {
      ctrls: $('#video-controls'),
      play:  $('#vid-play'),
      seek:  $('#vid-seek'),
      time:  $('#vid-time'),
    };
    this._dom.play.addEventListener('click', () => this.toggle());
    this._dom.seek.addEventListener('input', () => {
      const D = this.duration();
      this.seek((+this._dom.seek.value / 1000) * D);
    });
    this._tick = this._tick.bind(this);
    this._raf = 0;
  }

  refresh() {
    // Collect every group's video element (deduplicated).
    this._cleanupListeners();
    const seen = new Set();
    const vs = [];
    for (const [, g] of editor.groupsWithState()) {
      if (g.image instanceof HTMLVideoElement && !seen.has(g.image)) {
        seen.add(g.image);
        vs.push(g.image);
      }
    }
    this.videos = vs;

    if (!this.videos.length) {
      this._dom.ctrls.classList.add('hidden');
      this._stopTick();
      return;
    }
    this._dom.ctrls.classList.remove('hidden');

    // Wire per-video listeners so the play/pause icon and seek bar reflect state.
    for (const v of this.videos) {
      const onState = () => this._renderControls();
      v.addEventListener('play',     onState); this._listeners.push([v, 'play', onState]);
      v.addEventListener('pause',    onState); this._listeners.push([v, 'pause', onState]);
      v.addEventListener('ended',    onState); this._listeners.push([v, 'ended', onState]);
      v.addEventListener('seeked',   onState); this._listeners.push([v, 'seeked', onState]);
    }
    this._renderControls();
    if (this.isPlaying()) this._startTick();
  }

  duration() {
    let max = 0;
    for (const v of this.videos) {
      const d = isFinite(v.duration) ? v.duration : 0;
      if (d > max) max = d;
    }
    return max;
  }

  // Time used as the global timeline cursor.
  currentTime() {
    // Use the longest unfinished video as the master clock; fall back to max.
    let master = null, maxD = -Infinity;
    for (const v of this.videos) {
      const d = isFinite(v.duration) ? v.duration : 0;
      if (d > maxD) { maxD = d; master = v; }
    }
    return master ? master.currentTime : 0;
  }

  isPlaying() {
    return this.videos.some(v => !v.paused && !v.ended);
  }

  play() {
    if (!this.videos.length) return;
    // If every video has reached its end, rewind to 0 before playing.
    const allEnded = this.videos.every(v => v.ended || v.currentTime >= (v.duration || 0) - 0.05);
    if (allEnded) this.seek(0);
    const t = this.currentTime();
    for (const v of this.videos) {
      if (t >= v.duration - 0.05) {
        try { v.pause(); } catch {}
        continue;
      }
      v.play().catch(() => {});
    }
    this._startTick();
  }

  pause() {
    for (const v of this.videos) { try { v.pause(); } catch {} }
    this._stopTick();
  }

  toggle() {
    if (this.isPlaying()) this.pause();
    else this.play();
  }

  seek(time) {
    const D = this.duration();
    const T = Math.max(0, Math.min(D, time));
    for (const v of this.videos) {
      if (T <= v.duration) {
        v.currentTime = T;
      } else {
        try { v.pause(); } catch {}
        v.currentTime = Math.max(0, v.duration - 0.01);
      }
    }
    this._renderControls();
  }

  _renderControls() {
    const D = this.duration();
    const t = this.currentTime();
    this._dom.play.textContent = this.isPlaying() ? '⏸' : '▶';
    this._dom.time.textContent = `${formatTime(t)} / ${formatTime(D)}`;
    this._dom.seek.value = D > 0 ? String(Math.round((t / D) * 1000)) : '0';
  }

  // Auto-pause shorter videos as the longest plays past their length.
  _tick() {
    if (!this.isPlaying()) { this._raf = 0; return; }
    const t = this.currentTime();
    for (const v of this.videos) {
      if (t >= v.duration - 0.05 && !v.paused) {
        try { v.pause(); } catch {}
        v.currentTime = Math.max(0, v.duration - 0.01);
      }
    }
    this._renderControls();
    this._raf = requestAnimationFrame(this._tick);
  }

  _startTick() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(this._tick);
  }
  _stopTick() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _cleanupListeners() {
    for (const [el, evt, fn] of this._listeners) el.removeEventListener(evt, fn);
    this._listeners = [];
  }
}

const videoSync = new VideoSync();

function formatTime(sec) {
  if (!isFinite(sec)) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ============ Auto-detect / Clear LEDs ============
$('#btn-autodetect').addEventListener('click', () => {
  if (!viewer.modelRoot) {
    toast(t('toast.import3dFirst'), 'warn');
    return;
  }
  undo.pushSnapshot('auto-detect');

  // Single batched mutation. Without this, each add() emits 'change', which
  // triggers the LED list rebuild + 3D overlay refresh + 2D editor render —
  // O(N²) work for N detected panels and a guaranteed UI freeze on a real
  // stage model. batch() defers all events until the entire detection is
  // done, so the UI only updates once.
  let total = 0;
  ledManager._inBatchAdd = true;
  ledManager.batch(() => {
    const LED_RE = /led|screen|display|panel/i;

    // Pass 1: meshes inside any node whose name contains a LED keyword.
    viewer.modelRoot.traverse((node) => {
      if (!node.isMesh && LED_RE.test(node.name || '')) {
        node.traverse((o) => {
          if (o.isMesh && !ledManager.has(o.uuid)) {
            if (ledManager.add(o)) total++;
          }
        });
      }
    });

    // Pass 2: meshes whose own name / material looks like a LED.
    viewer.modelRoot.traverse((o) => {
      if (o.isMesh && !ledManager.has(o.uuid) && looksLikeLed(o)) {
        if (ledManager.add(o)) total++;
      }
    });

    // Pass 3: meshes the same size as already-marked LEDs.
    if (ledManager.list().length > 0) {
      const pred = ledManager.sizePredicate(0.05);
      viewer.modelRoot.traverse((o) => {
        if (o.isMesh && !ledManager.has(o.uuid) && pred(o)) {
          if (ledManager.add(o)) total++;
        }
      });
    }
  });
  ledManager._inBatchAdd = false;

  if (total) toast(t('toast.detected', { n: total }), 'success');
  else toast(t('toast.detected.none'), 'info', 5000);
});

$('#btn-clear-led').addEventListener('click', () => {
  if (!ledManager.list().length) return;
  if (!confirm(t('toast.confirmClear'))) return;
  undo.pushSnapshot('clear-all-leds');
  ledManager._inBatchAdd = true;
  ledManager.batch(() => {
    for (const led of ledManager.list()) ledManager.remove(led.id);
  });
  ledManager._inBatchAdd = false;
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
const overlay3dBtn = $('#toggle-overlay-3d');
overlay3dBtn.addEventListener('click', () => {
  const on = !overlay3dBtn.classList.contains('active');
  overlay3dBtn.classList.toggle('active', on);
  editor.setOverlay3dEnabled(on);
});

// Wrap ledManager mutation methods to push undo snapshots.
const _origAdd = ledManager.add.bind(ledManager);
const _origRemove = ledManager.remove.bind(ledManager);
const _origToggleByMesh = ledManager.toggleByMesh.bind(ledManager);
const _origAddGroup = ledManager.addGroup.bind(ledManager);
const _origRemoveGroup = ledManager.removeGroup.bind(ledManager);
const _origToggleGroup = ledManager.toggleGroup.bind(ledManager);

ledManager.add = function (mesh) {
  if (!ledManager.has(mesh.uuid) && !undo.isApplying && !ledManager._inBatchAdd) {
    undo.pushSnapshot('add-led');
  }
  return _origAdd(mesh);
};
ledManager.remove = function (id) {
  if (ledManager.leds.has(id) && !undo.isApplying && !ledManager._inBatchAdd) {
    undo.pushSnapshot('remove-led');
  }
  return _origRemove(id);
};
ledManager.toggleByMesh = function (mesh) {
  if (!undo.isApplying) undo.pushSnapshot('toggle-led');
  return _origToggleByMesh(mesh);
};
ledManager.addGroup = function (group) {
  if (!undo.isApplying) undo.pushSnapshot('add-led-group');
  return _origAddGroup(group);
};
ledManager.removeGroup = function (group) {
  if (!undo.isApplying) undo.pushSnapshot('remove-led-group');
  return _origRemoveGroup(group);
};
ledManager.toggleGroup = function (group) {
  if (!undo.isApplying) undo.pushSnapshot('toggle-led-group');
  return _origToggleGroup(group);
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
  if (!ledManager.list().length) { toast(t('toast.noLeds'), 'warn'); return; }
  undo.pushSnapshot('auto-arrange');
  ledManager.autoArrangeFromWorld(120, 60, 60);
  // After re-positioning every LED, the previously fitted mapled is almost
  // certainly off the new layout — re-fit so the "Mask" preview and the 3D
  // overlay still cover every panel. autoFitMapled() is a no-op when the
  // active group has no mapled image.
  editor.autoFitMapled();
  editor.resetView();
  toast(t('toast.aligned'), 'success');
});
$('#mapled-fit').addEventListener('click', () => {
  if (!editor.autoFitMapled()) {
    toast(t('toast.noLeds'), 'warn');
    return;
  }
  toast(t('toast.fitted'), 'success');
});
$('#reset-2d').addEventListener('click', () => editor.resetView());

// Tool toggle.
const toolSelectBtn = $('#tool-select'), toolPanBtn = $('#tool-pan'), toolMapledBtn = $('#tool-mapled');
toolSelectBtn.addEventListener('click', () => switchTool('select'));
toolPanBtn.addEventListener('click', () => switchTool('pan'));
toolMapledBtn.addEventListener('click', () => switchTool('mapled'));
function switchTool(t) {
  editor.setTool(t);
  toolSelectBtn.classList.toggle('active', t === 'select');
  toolPanBtn.classList.toggle('active', t === 'pan');
  toolMapledBtn.classList.toggle('active', t === 'mapled');
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

// ============ Groups & locking ============

// "Group selected" button — assigns currently-selected LEDs to a new group.
$('#btn-group-selected').addEventListener('click', () => {
  if (!ledManager.selection.size) {
    toast(t('toast.noSelection'), 'warn');
    return;
  }
  const suggested = ledManager._nextGroupName();
  const name = window.prompt(t('prompt.groupName'), suggested);
  if (name === null) return;
  const finalName = name.trim() || suggested;
  undo.pushSnapshot('group-selected');
  const result = ledManager.groupSelected(finalName);
  if (result) {
    toast(t('toast.grouped', { n: result.count, g: result.name }), 'success');
    rebuildGroupDropdown(result.name);
    editor.setActiveGroup(result.name);
  }
});

// Active group dropdown — reflects ledManager.listGroups() plus an "All" sentinel.
const groupSelect = $('#group-active');
function rebuildGroupDropdown(activate) {
  const groups = ledManager.listGroups();
  const cur = activate ?? editor.activeGroup;
  groupSelect.innerHTML = '';

  // "All" sentinel
  const optAll = document.createElement('option');
  optAll.value = GROUP_ALL;
  optAll.textContent = t('toolbar.activeGroup.all');
  groupSelect.appendChild(optAll);

  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g || t('toolbar.activeGroup.ungrouped');
    groupSelect.appendChild(opt);
  }

  groupSelect.value = cur ?? '';
  if (groupSelect.selectedIndex < 0) groupSelect.value = GROUP_ALL;
}
groupSelect.addEventListener('change', () => {
  const value = groupSelect.value;
  editor.setActiveGroup(value === GROUP_ALL ? GROUP_ALL : value);
  videoSync.refresh();
});

// Rename active group
$('#btn-rename-group').addEventListener('click', () => {
  const cur = editor.activeGroup;
  if (cur === GROUP_ALL || !cur) {
    toast(t('toolbar.activeGroup.ungrouped'), 'warn', 1500);
    return;
  }
  const newName = window.prompt(t('prompt.renameGroup'), cur);
  if (!newName || newName.trim() === cur) return;
  undo.pushSnapshot('rename-group');
  if (ledManager.renameGroup(cur, newName.trim())) {
    rebuildGroupDropdown(newName.trim());
    editor.setActiveGroup(newName.trim());
  }
});

// Freeze all / unfreeze all
function updateFreezeAllLabel() {
  const lbl = $('#btn-freeze-all-label');
  if (!lbl) return;
  lbl.textContent = ledManager.allLocked() && ledManager.list().length > 0
    ? t('topbar.unfreezeAll')
    : t('topbar.freezeAll');
}
$('#btn-freeze-all').addEventListener('click', () => {
  if (!ledManager.list().length) { toast(t('toast.noLeds'), 'warn'); return; }
  undo.pushSnapshot('freeze-all');
  const lockAll = !ledManager.allLocked();
  ledManager.setLockedAll(lockAll);
  toast(lockAll ? t('toast.frozen') : t('toast.unfrozen'), 'info');
  updateFreezeAllLabel();
});
ledManager.addEventListener('change', () => {
  updateFreezeAllLabel();
  rebuildGroupDropdown();
});
ledManager.addEventListener('selection', () => {
  // Keep "Group selected" button enabled state in sync (UI also handles it).
});
editor.addEventListener('group-changed', () => videoSync.refresh());
editor.addEventListener('mapled-changed', () => videoSync.refresh());

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
  else if (e.key === 'm' || e.key === 'M') switchTool('mapled');
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    // 3D-view-only Del → remove selected LEDs (the 2D editor handles this on its own).
    if (!$('#view-3d').classList.contains('view-active')) return;
    const ids = [...ledManager.selection].filter(id => {
      const led = ledManager.get(id);
      return led && !led.locked;
    });
    if (!ids.length) return;
    e.preventDefault();
    undo.pushSnapshot('delete');
    for (const id of ids) ledManager.remove(id);
  }
  else if (e.key === ' ') {
    if (viewer.modelRoot) viewer.fitToObject(viewer.modelRoot);
    e.preventDefault();
  } else if (e.key === '1') setMode('3d');
  else if (e.key === '2') setMode('2d');
});

// ============ Loading overlay ============
function showLoading(msg) {
  $('#loading-text').textContent = msg || 'Loading…';
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
setStatus(t('status.ready'));
updateModeStatus();
updateFreezeAllLabel();
rebuildGroupDropdown();

// Start auto-save & offer restore from previous session.
sections.startAutoSave();
sections.maybeOfferRestore();

// Expose for debugging and for the UI's internal handlers (lock toggle uses it).
window.__app = { ledManager, viewer, editor, ui, undo, sections, utils: { toast } };
