// UI bindings: object tree, LED list, properties panel, stats.
// Checkboxes on each row + Shift-click for range multi-select.

import { $, $$, fmt, ledColor } from './utils.js';

export class UI {
  constructor(ledManager, viewer3d, editor2d) {
    this.ledManager = ledManager;
    this.viewer = viewer3d;
    this.editor = editor2d;

    this._objectIndex = []; // [{node, name}]
    this._search = '';
    this._lastObjIdx = -1;  // for shift-range
    this._lastLedIdx = -1;

    ledManager.on('change', () => {
      this.renderObjectTree();
      this.renderLedList();
      this.renderProps();
      this.renderStats();
    });
    ledManager.on('selection', () => {
      this.renderObjectTree();
      this.renderLedList();
      this.renderProps();
    });

    $('#search-obj').addEventListener('input', (e) => {
      this._search = e.target.value.toLowerCase();
      this._lastObjIdx = -1; // reset shift-range when filter changes
      this.renderObjectTree();
    });
  }

  setModel(root) {
    this._objectIndex = [];
    if (root) {
      root.traverse((o) => {
        if (o.isMesh) this._objectIndex.push({ node: o, name: o.name || '(unnamed)' });
      });
    }
    this._lastObjIdx = -1;
    this.renderObjectTree();
    this.renderLedList();
    this.renderStats();
  }

  // ============ Object tree ============
  renderObjectTree() {
    const list = $('#object-tree');
    const empty = $('#empty-tree');
    const count = $('#obj-count');
    list.innerHTML = '';

    const filtered = this._objectIndex.filter((o) =>
      !this._search || o.name.toLowerCase().includes(this._search)
    );
    count.textContent = filtered.length;
    empty.classList.toggle('hidden', this._objectIndex.length > 0);

    filtered.forEach((item, idx) => {
      const led = this.ledManager.findByMesh(item.node.uuid);
      const isSelected = led && this.ledManager.isSelected(led.id);

      const li = document.createElement('li');
      li.className = 'tree-item' + (led ? ' is-led' : '') + (isSelected ? ' selected' : '');

      // Checkbox (disabled for non-LED rows; acts as "mark as LED then select" on LED rows)
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'row-check';
      chk.checked = !!isSelected;
      if (!led) chk.disabled = true;
      li.appendChild(chk);

      li.insertAdjacentHTML('beforeend', `
        ${led ? '<span class="led-marker"></span>' : '<span class="obj-icon">▢</span>'}
        <span class="obj-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <button class="toggle-led" title="${led ? 'Bỏ đánh dấu LED' : 'Đánh dấu là LED'}">${led ? '★ LED' : '+ LED'}</button>
      `);

      // Checkbox click — shift-range support
      chk.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!led) return;
        if (e.shiftKey && this._lastObjIdx >= 0) {
          this._rangeSelectObj(filtered, this._lastObjIdx, idx);
        } else if (e.ctrlKey || e.metaKey) {
          this.ledManager.toggleSelection(led.id);
        } else {
          this.ledManager.select(led.id, false);
        }
        this._lastObjIdx = idx;
      });

      // Row click (non-checkbox area)
      li.addEventListener('click', (e) => {
        if (e.target === chk || e.target.classList.contains('toggle-led')) return;
        if (led) {
          if (e.shiftKey && this._lastObjIdx >= 0) {
            this._rangeSelectObj(filtered, this._lastObjIdx, idx);
          } else {
            this.ledManager.select(led.id, e.ctrlKey || e.metaKey);
          }
          this._lastObjIdx = idx;
          this.viewer.focusOnLed(led);
        } else {
          this.viewer.fitToObject(item.node, 2.4);
        }
      });

      li.querySelector('.toggle-led').addEventListener('click', (e) => {
        e.stopPropagation();
        this.ledManager.toggleByMesh(item.node);
      });

      list.appendChild(li);
    });
  }

  _rangeSelectObj(filtered, fromIdx, toIdx) {
    const [a, b] = [Math.min(fromIdx, toIdx), Math.max(fromIdx, toIdx)];
    for (let i = a; i <= b; i++) {
      const item = filtered[i];
      const led = this.ledManager.findByMesh(item.node.uuid);
      if (led) this.ledManager.select(led.id, true);
    }
  }

  // ============ LED list ============
  renderLedList() {
    const list = $('#led-list');
    const empty = $('#empty-led');
    const count = $('#led-count');
    list.innerHTML = '';

    const leds = this.ledManager.list();
    count.textContent = leds.length;
    empty.classList.toggle('hidden', leds.length > 0);

    leds.forEach((led, idx) => {
      const isSelected = this.ledManager.isSelected(led.id);
      const li = document.createElement('li');
      li.className = 'led-item' + (isSelected ? ' selected' : '');

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'row-check';
      chk.checked = isSelected;
      li.appendChild(chk);

      li.insertAdjacentHTML('beforeend', `
        <span class="led-color" style="background:${led.color}"></span>
        <div style="flex:1;min-width:0">
          <div class="led-name" title="${escapeHtml(led.name)}">${escapeHtml(led.name)}</div>
          <div class="led-info">${led.realW}×${led.realH}mm · ${led.pixelW}×${led.pixelH}px</div>
        </div>
        <button title="Bỏ đánh dấu LED">✕</button>
      `);

      chk.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.shiftKey && this._lastLedIdx >= 0) {
          this._rangeSelectLed(leds, this._lastLedIdx, idx);
        } else if (e.ctrlKey || e.metaKey) {
          this.ledManager.toggleSelection(led.id);
        } else {
          this.ledManager.select(led.id, false);
        }
        this._lastLedIdx = idx;
      });

      li.addEventListener('click', (e) => {
        if (e.target === chk || e.target.tagName === 'BUTTON') return;
        if (e.shiftKey && this._lastLedIdx >= 0) {
          this._rangeSelectLed(leds, this._lastLedIdx, idx);
        } else {
          this.ledManager.select(led.id, e.ctrlKey || e.metaKey);
        }
        this._lastLedIdx = idx;
        this.viewer.focusOnLed(led);
      });

      li.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        this.ledManager.remove(led.id);
      });

      list.appendChild(li);
    });
  }

  _rangeSelectLed(leds, fromIdx, toIdx) {
    const [a, b] = [Math.min(fromIdx, toIdx), Math.max(fromIdx, toIdx)];
    for (let i = a; i <= b; i++) this.ledManager.select(leds[i].id, true);
  }

  // ============ Properties panel ============
  renderProps() {
    const body = $('#props-body');
    const nameBadge = $('#props-name');
    const sel = [...this.ledManager.selection];
    if (sel.length !== 1) {
      nameBadge.textContent = sel.length ? `${sel.length} LED` : '—';
      body.innerHTML = `
        <div class="empty-state">
          <div>${sel.length ? `Đã chọn ${sel.length} LED` : 'Chưa chọn LED nào'}</div>
          <small>${sel.length ? 'Chọn 1 LED để chỉnh thuộc tính chi tiết' : 'Chọn 1 LED ở 3D hoặc 2D để chỉnh thuộc tính'}</small>
        </div>
      `;
      return;
    }
    const led = this.ledManager.get(sel[0]);
    if (!led) return;
    nameBadge.textContent = led.name;

    body.innerHTML = `
      <div class="prop-group">
        <div class="prop-group-title">Định danh</div>
        <div class="prop-row">
          <label>Tên</label><input id="p-name" type="text" value="${escapeAttr(led.name)}" />
        </div>
        <div class="prop-row">
          <label>Màu</label><input id="p-color" type="color" class="prop-color" value="${hslToHexString(led.color)}" />
        </div>
      </div>
      <div class="prop-group">
        <div class="prop-group-title">Kích thước thật</div>
        <div class="prop-row">
          <label>Rộng (mm)</label><input id="p-realw" type="number" min="1" value="${led.realW}" />
        </div>
        <div class="prop-row">
          <label>Cao (mm)</label><input id="p-realh" type="number" min="1" value="${led.realH}" />
        </div>
      </div>
      <div class="prop-group">
        <div class="prop-group-title">Điểm ảnh</div>
        <div class="prop-row">
          <label>Pitch (mm)</label><input id="p-pitch" type="number" min="0.1" step="0.1" value="${led.pixelPitch}" />
        </div>
        <div class="prop-row">
          <label>Pixel W</label><input id="p-pixw" type="number" min="1" value="${led.pixelW}" />
        </div>
        <div class="prop-row">
          <label>Pixel H</label><input id="p-pixh" type="number" min="1" value="${led.pixelH}" />
        </div>
      </div>
      <div class="prop-group">
        <div class="prop-group-title">Vị trí 2D (px)</div>
        <div class="prop-row">
          <label>X</label><input id="p-x" type="number" value="${fmt(led.map2d.x, 1)}" />
        </div>
        <div class="prop-row">
          <label>Y</label><input id="p-y" type="number" value="${fmt(led.map2d.y, 1)}" />
        </div>
        <div class="prop-row">
          <label>W</label><input id="p-w" type="number" value="${fmt(led.map2d.w, 1)}" />
        </div>
        <div class="prop-row">
          <label>H</label><input id="p-h" type="number" value="${fmt(led.map2d.h, 1)}" />
        </div>
        <div class="prop-row">
          <label>Xoay (°)</label><input id="p-rot" type="number" step="1" value="${fmt((led.map2d.rotation || 0) * 180 / Math.PI, 1)}" />
        </div>
      </div>
      <div class="prop-group">
        <div class="prop-group-title">Vị trí 3D (m)</div>
        <div class="prop-row"><label>Center X</label><input type="number" disabled value="${fmt(led.world.cx, 2)}" /></div>
        <div class="prop-row"><label>Center Y</label><input type="number" disabled value="${fmt(led.world.cy, 2)}" /></div>
        <div class="prop-row"><label>Center Z</label><input type="number" disabled value="${fmt(led.world.cz, 2)}" /></div>
      </div>
    `;

    const onNum = (id, key, mapped = (v) => v) => $(id).addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (isNaN(v)) return;
      this.ledManager.update(led.id, { [key]: mapped(v) });
    });
    const onMap2d = (id, key, mapped = (v) => v) => $(id).addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (isNaN(v)) return;
      this.ledManager.updateMap2d(led.id, { [key]: mapped(v) });
    });

    $('#p-name').addEventListener('input', (e) => this.ledManager.rename(led.id, e.target.value));
    $('#p-color').addEventListener('input', (e) => this.ledManager.update(led.id, { color: e.target.value }));
    onNum('#p-realw', 'realW');
    onNum('#p-realh', 'realH');
    onNum('#p-pitch', 'pixelPitch');
    onNum('#p-pixw', 'pixelW');
    onNum('#p-pixh', 'pixelH');
    onMap2d('#p-x', 'x');
    onMap2d('#p-y', 'y');
    onMap2d('#p-w', 'w');
    onMap2d('#p-h', 'h');
    onMap2d('#p-rot', 'rotation', (deg) => deg * Math.PI / 180);
  }

  // ============ Stats ============
  renderStats() {
    const t = this.ledManager.computeTotals();
    $('#stat-total').textContent = t.count;
    $('#stat-pix-w').textContent = t.pixelWidthSum.toLocaleString();
    $('#stat-pix-h').textContent = t.pixelHeightMax.toLocaleString();
    $('#stat-area').textContent = t.areaM2.toFixed(2);
  }
}

// ============ Helpers ============
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function hslToHexString(hsl) {
  const m = /hsl\((\d+),\s*(\d+)%?,\s*(\d+)%?\)/.exec(hsl);
  if (!m) return '#ff3366';
  const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
