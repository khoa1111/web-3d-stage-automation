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

const ledManager = new LedManager();
const threeContainer = $('#three-container');
const viewer = new Viewer3D(threeContainer, ledManager);
const canvas2d = $('#canvas2d');
const editor = new Editor2D(canvas2d, ledManager);
const ui = new UI(ledManager, viewer, editor);
const undo = new UndoStack(ledManager, editor, { max: 5 });
const sections = new SectionsManager(ledManager, viewer, editor, undo);

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
$('#btn-lang-label').textContent = i18n.lang === 'vi' ? 'VI' : 'EN';
$('#btn-lang').addEventListener('click', () => {
  i18n.toggle();
  $('#btn-lang-label').textContent = i18n.lang === 'vi' ? 'VI' : 'EN';
  toast(t('toast.langChanged'), 'info', 1800);
  // Refresh dynamic chrome that depends on language.
  updateModeStatus();
  updateFreezeAllLabel();
  rebuildGroupDropdown();
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
  updateModeStatus();

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
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    await new Promise((res, rej) => {
      video.addEventListener('loadeddata', res, { once: true });
      video.addEventListener('error', () => rej(new Error('Could not read video')), { once: true });
    });
    editor.setMapledImage(video);
    bindVideoControls(video);
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
      editor.setMapledImage(img);
      hideVideoControls();
      setMode('2d');
      toast(t('toast.imageLoaded', { w: img.naturalWidth, h: img.naturalHeight }), 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  } else {
    toast(t('toast.unsupported'), 'warn');
  }
}

// Global topbar video controls — bind/rebind to whichever video is currently
// "active" (the active group's, or null).
let _videoBindCleanup = null;

function bindVideoControls(video) {
  if (_videoBindCleanup) _videoBindCleanup();
  _videoBindCleanup = null;
  if (!video) { hideVideoControls(); return; }

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

  const onPlayClick = () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    updateBtn();
  };
  const onSeek = () => {
    if (!isFinite(video.duration)) return;
    video.currentTime = (+seek.value / 1000) * video.duration;
    updateTime();
  };
  playBtn.onclick = onPlayClick;
  seek.oninput = onSeek;
  video.addEventListener('play', updateBtn);
  video.addEventListener('pause', updateBtn);
  video.addEventListener('timeupdate', updateTime);
  updateBtn(); updateTime();

  _videoBindCleanup = () => {
    playBtn.onclick = null;
    seek.oninput = null;
    video.removeEventListener('play', updateBtn);
    video.removeEventListener('pause', updateBtn);
    video.removeEventListener('timeupdate', updateTime);
  };
}

function hideVideoControls() {
  $('#video-controls').classList.add('hidden');
  if (_videoBindCleanup) { _videoBindCleanup(); _videoBindCleanup = null; }
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
    toast(t('toast.import3dFirst'), 'warn');
    return;
  }
  undo.pushSnapshot('auto-detect');

  let total = 0;
  ledManager._inBatchAdd = true;
  try {
    const LED_RE = /led|screen|display|panel/i;
    viewer.modelRoot.traverse((node) => {
      if (!node.isMesh && LED_RE.test(node.name || '')) {
        node.traverse((o) => {
          if (o.isMesh && !ledManager.has(o.uuid)) {
            const r = ledManager.add(o);
            if (r) total++;
          }
        });
      }
    });

    const byName = viewer.autoDetectLEDs((m) => {
      if (ledManager.has(m.uuid)) return false;
      return looksLikeLed(m);
    });
    total += byName.length;

    if (ledManager.list().length > 0) {
      const pred = ledManager.sizePredicate(0.05);
      const bySize = viewer.autoDetectLEDs((m) => !ledManager.has(m.uuid) && pred(m));
      total += bySize.length;
    }
  } finally {
    ledManager._inBatchAdd = false;
  }

  if (total) toast(t('toast.detected', { n: total }), 'success');
  else toast(t('toast.detected.none'), 'info', 5000);
});

$('#btn-clear-led').addEventListener('click', () => {
  if (!ledManager.list().length) return;
  if (!confirm(t('toast.confirmClear'))) return;
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
  // Bind topbar video controls to the active group's video (if any).
  bindVideoControls(editor.getVideo());
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
editor.addEventListener('group-changed', () => {
  // Selecting the dropdown also fires this; rebind video controls each time.
  bindVideoControls(editor.getVideo());
});

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
