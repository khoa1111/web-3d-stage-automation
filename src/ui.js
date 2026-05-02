// UI bindings: object tree, LED list, properties panel, stats.

import { $, fmt } from './utils.js';
import { i18n, t } from './i18n.js';

export class UI {
  constructor(ledManager, viewer3d, editor2d) {
    this.ledManager = ledManager;
    this.viewer = viewer3d;
    this.editor = editor2d;

    /** @type {Array<{node, name:string, depth:number, isGroup:boolean}>} */
    this._objectIndex = [];
    this._search = '';

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

    // Re-render dynamic content on language change.
    i18n.addEventListener('change', () => {
      this.renderObjectTree();
      this.renderLedList();
      this.renderProps();
      this.renderStats();
    });

    $('#search-obj').addEventListener('input', (e) => {
      this._search = e.target.value.toLowerCase();
      this.renderObjectTree();
    });
  }

  setModel(root) {
    this._objectIndex = [];
    if (root) {
      const addNode = (node, depth) => {
        if (node === root) {
          node.children.forEach((c) => addNode(c, 0));
          return;
        }
        if (!_hasMesh(node)) return;
        const name = node.name || (node.isMesh ? '(mesh)' : '(group)');
        this._objectIndex.push({ node, name, depth, isGroup: !node.isMesh });
        if (!node.isMesh) {
          node.children.forEach((c) => addNode(c, depth + 1));
        }
      };
      addNode(root, 0);
    }
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

    filtered.forEach((item) => {
      const { node, name, depth, isGroup } = item;

      let ledStatus = 'none';
      if (isGroup) {
        if (this.ledManager.hasGroup(node)) ledStatus = 'full';
        else if (this.ledManager.partialGroup(node)) ledStatus = 'partial';
      } else {
        if (this.ledManager.has(node.uuid)) ledStatus = 'full';
      }

      const li = document.createElement('li');
      li.className = 'tree-item'
        + (ledStatus === 'full' ? ' is-led' : '')
        + (ledStatus === 'partial' ? ' is-partial' : '')
        + (isGroup ? ' is-group' : '');
      li.style.paddingLeft = `${8 + depth * 16}px`;

      const iconHtml = ledStatus === 'full'
        ? '<span class="led-marker"></span>'
        : ledStatus === 'partial'
          ? '<span class="led-marker partial"></span>'
          : `<span class="obj-icon">${isGroup ? '▸' : '□'}</span>`;

      const toggleLabel = ledStatus === 'full' ? '★ LED'
        : ledStatus === 'partial' ? '◑ LED' : '+ LED';

      li.innerHTML = `
        ${iconHtml}
        <span class="obj-name" title="${escHtml(name)}">${escHtml(name)}</span>
        <button class="toggle-led" title="${ledStatus === 'full' ? t('led.remove.title') : 'Mark as LED'}">${toggleLabel}</button>
      `;

      li.addEventListener('click', (e) => {
        if (e.target.classList.contains('toggle-led')) return;
        if (isGroup) {
          const groupLeds = _collectGroupLeds(node, this.ledManager);
          if (groupLeds.length) {
            if (!e.ctrlKey && !e.metaKey) this.ledManager.selection.clear();
            groupLeds.forEach((l) => this.ledManager.selection.add(l.id));
            this.ledManager._emit('selection');
          } else {
            this.ledManager.addGroup(node);
          }
          this.viewer.fitToObject(node, 2.0);
        } else {
          const led = this.ledManager.findByMesh(node.uuid);
          if (led) {
            if (e.ctrlKey || e.metaKey) this.ledManager.toggleSelection(led.id);
            else this.ledManager.select(led.id, false);
            this.viewer.focusOnLed(led);
          } else {
            const newLed = this.ledManager.add(node);
            if (newLed) this.ledManager.select(newLed.id, false);
          }
        }
      });

      li.querySelector('.toggle-led').addEventListener('click', (e) => {
        e.stopPropagation();
        if (isGroup) this.ledManager.toggleGroup(node);
        else this.ledManager.toggleByMesh(node);
      });

      list.appendChild(li);
    });
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

    // "Group selected" button is enabled only when at least one LED is selected.
    const groupBtn = $('#btn-group-selected');
    if (groupBtn) groupBtn.disabled = this.ledManager.selection.size === 0;

    leds.forEach((led) => {
      const isSelected = this.ledManager.isSelected(led.id);
      const li = document.createElement('li');
      li.className = 'led-item'
        + (isSelected ? ' selected' : '')
        + (led.locked ? ' locked' : '');

      const groupBadge = led.group
        ? `<span class="led-group-badge">${escHtml(led.group)}</span>`
        : '';

      li.innerHTML = `
        <span class="led-color" style="background:${led.color}"></span>
        <div style="flex:1;min-width:0">
          <div class="led-name" title="${escHtml(led.name)}">${escHtml(led.name)} ${groupBadge}</div>
          <div class="led-info">${led.realW}×${led.realH}mm · ${led.pixelW}×${led.pixelH}px</div>
        </div>
        <button class="led-lock ${led.locked ? 'is-locked' : ''}" title="${escAttr(t('led.lock.title'))}" aria-label="${escAttr(t('led.lock.title'))}">
          ${_lockIcon(led.locked)}
        </button>
        <button class="led-remove" title="${escAttr(t('led.remove.title'))}">✕</button>
      `;

      li.addEventListener('click', (e) => {
        if (e.target.closest('.led-remove') || e.target.closest('.led-lock')) return;
        if (led.locked) return; // locked LEDs cannot be selected from the list either
        if (e.ctrlKey || e.metaKey) this.ledManager.toggleSelection(led.id);
        else this.ledManager.select(led.id, false);
        this.viewer.focusOnLed(led);
      });

      li.querySelector('.led-lock').addEventListener('click', (e) => {
        e.stopPropagation();
        // Snapshot for undo.
        window.__app?.undo?.pushSnapshot('lock-toggle');
        this.ledManager.setLocked(led.id, !led.locked);
        const { toast } = window.__app?.utils || {};
        if (toast) toast(led.locked ? t('toast.unlocked') : t('toast.locked'), 'info', 1500);
      });

      li.querySelector('.led-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        if (led.locked) return;
        this.ledManager.remove(led.id);
      });

      list.appendChild(li);
    });
  }

  // ============ Properties panel ============
  renderProps() {
    const body = $('#props-body');
    const nameBadge = $('#props-name');
    const sel = [...this.ledManager.selection];
    if (sel.length !== 1) {
      nameBadge.textContent = sel.length ? `${sel.length} ${t('props.multi')}` : '—';
      body.innerHTML = `
        <div class="empty-state">
          <div>${sel.length ? `${sel.length} ${t('props.multi')}` : t('props.empty')}</div>
          <small>${sel.length ? t('props.multi.sub') : t('props.empty.sub')}</small>
        </div>
      `;
      return;
    }
    const led = this.ledManager.get(sel[0]);
    if (!led) return;
    nameBadge.textContent = led.name;

    const groups = this.ledManager.listGroups().filter(Boolean);
    const groupOptions = ['', ...groups].map(g =>
      `<option value="${escAttr(g)}" ${(led.group || '') === g ? 'selected' : ''}>${escHtml(g || t('toolbar.activeGroup.ungrouped'))}</option>`
    ).join('');

    body.innerHTML = `
      <div class="prop-group">
        <div class="prop-group-title">${escHtml(t('props.identity'))}</div>
        <div class="prop-row">
          <label>${escHtml(t('props.name'))}</label><input id="p-name" type="text" value="${escAttr(led.name)}" />
        </div>
        <div class="prop-row">
          <label>${escHtml(t('props.color'))}</label><input id="p-color" type="color" class="prop-color" value="${hslToHexStr(led.color)}" />
        </div>
        <div class="prop-row">
          <label>${escHtml(t('props.group'))}</label>
          <select id="p-group">${groupOptions}</select>
        </div>
        <div class="prop-row">
          <label>${escHtml(t('props.locked'))}</label>
          <input id="p-locked" type="checkbox" ${led.locked ? 'checked' : ''} />
        </div>
      </div>
      <div class="prop-group">
        <div class="prop-group-title">${escHtml(t('props.size'))}</div>
        <div class="prop-row">
          <label>${escHtml(t('props.width'))}</label><input id="p-realw" type="number" min="1" value="${led.realW}" />
        </div>
        <div class="prop-row">
          <label>${escHtml(t('props.height'))}</label><input id="p-realh" type="number" min="1" value="${led.realH}" />
        </div>
      </div>
      <div class="prop-group">
        <div class="prop-group-title">${escHtml(t('props.pixels'))}</div>
        <div class="prop-row">
          <label>${escHtml(t('props.pitch'))}</label><input id="p-pitch" type="number" min="0.1" step="0.1" value="${led.pixelPitch}" />
        </div>
        <div class="prop-row">
          <label>${escHtml(t('props.pixW'))}</label><input id="p-pixw" type="number" min="1" value="${led.pixelW}" />
        </div>
        <div class="prop-row">
          <label>${escHtml(t('props.pixH'))}</label><input id="p-pixh" type="number" min="1" value="${led.pixelH}" />
        </div>
      </div>
      <div class="prop-group">
        <div class="prop-group-title">${escHtml(t('props.pos2d'))}</div>
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
          <label>${escHtml(t('props.rotate'))}</label><input id="p-rot" type="number" step="1" value="${fmt((led.map2d.rotation || 0) * 180 / Math.PI, 1)}" />
        </div>
      </div>
      <div class="prop-group">
        <div class="prop-group-title">${escHtml(t('props.pos3d'))}</div>
        <div class="prop-row"><label>${escHtml(t('props.cx'))}</label><input type="number" disabled value="${fmt(led.world.cx, 2)}" /></div>
        <div class="prop-row"><label>${escHtml(t('props.cy'))}</label><input type="number" disabled value="${fmt(led.world.cy, 2)}" /></div>
        <div class="prop-row"><label>${escHtml(t('props.cz'))}</label><input type="number" disabled value="${fmt(led.world.cz, 2)}" /></div>
      </div>
    `;

    const onNum = (id, key) => $(id).addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v)) this.ledManager.update(led.id, { [key]: v });
    });
    const onMap2d = (id, key, map = (v) => v) => $(id).addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (!isNaN(v)) this.ledManager.updateMap2d(led.id, { [key]: map(v) });
    });

    $('#p-name').addEventListener('input', (e) => this.ledManager.rename(led.id, e.target.value));
    $('#p-color').addEventListener('input', (e) => this.ledManager.update(led.id, { color: e.target.value }));
    $('#p-group').addEventListener('change', (e) => {
      window.__app?.undo?.pushSnapshot('group-change');
      this.ledManager.update(led.id, { group: e.target.value });
    });
    $('#p-locked').addEventListener('change', (e) => {
      window.__app?.undo?.pushSnapshot('lock-toggle');
      this.ledManager.setLocked(led.id, e.target.checked);
    });
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
    const totals = this.ledManager.computeTotals();
    $('#stat-total').textContent = totals.count;
    $('#stat-pix-w').textContent = totals.pixelWidthSum.toLocaleString();
    $('#stat-pix-h').textContent = totals.pixelHeightMax.toLocaleString();
    $('#stat-area').textContent = totals.areaM2.toFixed(2);
  }
}

// ============ Helpers ============
function _hasMesh(node) {
  if (node.isMesh) return true;
  return node.children?.some(_hasMesh) ?? false;
}

function _collectGroupLeds(groupNode, ledManager) {
  const out = [];
  groupNode.traverse((o) => {
    if (o.isMesh) {
      const led = ledManager.findByMesh(o.uuid);
      if (led) out.push(led);
    }
  });
  return out;
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escAttr(s) { return escHtml(s); }

function hslToHexStr(hsl) {
  const m = /hsl\((\d+),\s*(\d+)%?,\s*(\d+)%?\)/.exec(hsl);
  if (!m) return '#ff3366';
  const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const hex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

function _lockIcon(locked) {
  // Lucide lock / lock-open inline SVG (14px).
  if (locked) {
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
  }
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;
}
