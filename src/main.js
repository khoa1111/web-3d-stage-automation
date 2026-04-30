// Application bootstrap. Wires the file loader, 3D viewer, 2D editor,
// LED manager and the surrounding UI together.

import { LedManager } from './ledManager.js';
import { Viewer3D } from './viewer3d.js';
import { Editor2D } from './editor2d.js';
import { UI } from './ui.js';
import { loadModelFromFile, buildDemoStage } from './fileLoader.js';
import { $, downloadJSON, looksLikeLed, readFileAsDataURL, readFileAsText, setStatus, toast } from './utils.js';

const ledManager = new LedManager();

// Boot 3D viewer.
const threeContainer = $('#three-container');
const viewer = new Viewer3D(threeContainer, ledManager);

// Boot 2D editor.
const canvas2d = $('#canvas2d');
const editor = new Editor2D(canvas2d, ledManager);

// UI.
const ui = new UI(ledManager, viewer, editor);

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
  $('#status-mode').textContent = `Chế độ: ${isThree ? '3D' : '2D Mapping'}`;
  if (isThree) {
    requestAnimationFrame(() => viewer.resize());
  } else {
    requestAnimationFrame(() => { editor.resize(); editor.render(); });
  }
}
$('#mode-3d').addEventListener('click', () => setMode('3d'));
$('#mode-2d').addEventListener('click', () => setMode('2d'));

// ============ File handling ============
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
  setStatus(`Đã tải: ${fileName} · ${countMeshes(root)} object`);
  setMode('3d');
}

function countMeshes(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n++; });
  return n;
}

$('#file-3d').addEventListener('change', (e) => handle3DFile(e.target.files[0]));
$('#btn-demo').addEventListener('click', () => {
  const { root, fileName } = buildDemoStage();
  afterModelLoaded(root, fileName);
  toast('Đã tạo sân khấu demo. Bấm "Tự động phát hiện LED" để bắt đầu.', 'info', 4500);
});

// ============ Mapled image ============
$('#file-mapled').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const url = await readFileAsDataURL(file);
    const img = new Image();
    img.onload = () => {
      editor.setMapledImage(img);
      setMode('2d');
      toast(`Đã tải mapled tham chiếu (${img.naturalWidth}×${img.naturalHeight})`, 'success');
    };
    img.onerror = () => toast('Không đọc được ảnh mapled', 'error');
    img.src = url;
  } catch (err) {
    toast('Lỗi khi tải mapled: ' + err.message, 'error');
  }
});

// ============ Auto detect ============
$('#btn-autodetect').addEventListener('click', () => {
  if (!viewer.modelRoot) {
    toast('Cần import model 3D trước', 'warn');
    return;
  }
  const added = viewer.autoDetectLEDs(looksLikeLed);
  if (added.length) {
    toast(`Đã tự động phát hiện ${added.length} LED panel`, 'success');
  } else {
    toast('Không tìm thấy object nào trông giống LED. Hãy click thủ công vào các tấm LED trong khung 3D.', 'info', 5000);
  }
});

$('#btn-clear-led').addEventListener('click', () => {
  if (!ledManager.list().length) return;
  if (!confirm('Bỏ đánh dấu tất cả LED?')) return;
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

// ============ 2D toolbar ============
$('#scale-select').addEventListener('change', (e) => editor.setViewScale(parseFloat(e.target.value)));
$('#grid-size').addEventListener('input', (e) => editor.setGridSize(e.target.value));
const snapBtn = $('#toggle-snap');
snapBtn.addEventListener('click', () => {
  const on = !snapBtn.classList.contains('active');
  snapBtn.classList.toggle('active', on);
  editor.setSnap(on);
});
$('#pixel-pitch').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  if (!isNaN(v) && v > 0) ledManager.setPixelPitch(v);
});
$('#mapled-opacity').addEventListener('input', (e) => editor.setMapledOpacity(+e.target.value / 100));
$('#auto-arrange').addEventListener('click', () => {
  if (!ledManager.list().length) {
    toast('Chưa có LED nào để sắp xếp', 'warn');
    return;
  }
  ledManager.autoArrangeFromWorld(120, 60, 60);
  editor.resetView();
  toast('Đã chiếu vị trí 2D từ vị trí 3D', 'success');
});
$('#reset-2d').addEventListener('click', () => {
  editor.resetView();
});

// ============ Export / Import config ============
$('#btn-export').addEventListener('click', () => {
  if (!ledManager.list().length) {
    toast('Chưa có LED nào để export', 'warn');
    return;
  }
  const cfg = ledManager.exportConfig({
    model: viewer.modelRoot?.name || 'unknown',
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  downloadJSON(cfg, `led-mapping-${stamp}.json`);
  toast('Đã xuất file cấu hình JSON', 'success');
});

$('#file-config').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await readFileAsText(file);
    const cfg = JSON.parse(text);
    ledManager.importConfig(cfg, viewer.modelRoot);
    toast(`Đã nhập ${cfg.leds?.length ?? 0} LED từ ${file.name}`, 'success');
  } catch (err) {
    toast('Không đọc được cấu hình: ' + err.message, 'error', 6000);
  }
});

// ============ Drag & drop ============
['dragover', 'drop'].forEach((ev) => {
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev !== 'drop') return;
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (/\.(json)$/i.test(f.name)) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          ledManager.importConfig(JSON.parse(reader.result), viewer.modelRoot);
          toast(`Đã nhập cấu hình từ ${f.name}`, 'success');
        } catch (err) { toast('JSON không hợp lệ: ' + err.message, 'error'); }
      };
      reader.readAsText(f);
    } else if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)) {
      readFileAsDataURL(f).then((url) => {
        const img = new Image();
        img.onload = () => {
          editor.setMapledImage(img);
          setMode('2d');
          toast('Đã tải mapled từ drag & drop', 'success');
        };
        img.src = url;
      });
    } else {
      handle3DFile(f);
    }
  });
});

// ============ Keyboard shortcuts ============
window.addEventListener('keydown', (e) => {
  const tag = (e.target?.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return;
  if (e.key === 'f' || e.key === 'F') viewer.setCameraPreset('front');
  else if (e.key === 't' || e.key === 'T') viewer.setCameraPreset('top');
  else if (e.key === 'l' || e.key === 'L') viewer.setCameraPreset('left');
  else if (e.key === 'i' || e.key === 'I') viewer.setCameraPreset('iso');
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
setStatus('Sẵn sàng. Hãy import file 3D hoặc bấm "Demo sân khấu".');

// Expose for debugging.
window.__app = { ledManager, viewer, editor, ui };
