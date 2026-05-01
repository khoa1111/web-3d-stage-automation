// Project persistence via localStorage.
//
// Named projects are stored as JSON under 'fs.stage.project.<encodedName>'.
// An autosave 'current' slot is written (debounced 500ms) on every change.
// On startup maybeOfferRestore() prompts the user to reload the last session.

import { _serializeLed } from './undoStack.js';
import { toast } from './utils.js';

const PREFIX = 'fs.stage.project.';
const AUTOSAVE_KEY = 'fs.stage.autosave.current';

export class SectionsManager {
  constructor(ledManager, viewer, editor, undo) {
    this.ledManager = ledManager;
    this.viewer = viewer;
    this.editor = editor;
    this.undo = undo;
    this._autoTimer = null;
    this._dlgProjects = document.getElementById('dlg-projects');
    this._dlgRestore = document.getElementById('dlg-restore');
  }

  // ---- Project list ----

  list() {
    const result = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.startsWith(PREFIX)) continue;
      try {
        const data = JSON.parse(localStorage.getItem(key));
        result.push({
          name: data.name,
          savedAt: data.savedAt,
          ledCount: data.ledCount ?? data.leds?.length ?? 0,
          key,
        });
      } catch {}
    }
    return result.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  }

  save(name) {
    if (!name?.trim()) { toast('Tên dự án không được trống', 'warn'); return false; }
    const snap = this._capture(name.trim());
    try {
      localStorage.setItem(PREFIX + encodeURIComponent(name.trim()), JSON.stringify(snap));
      toast(`Đã lưu dự án "${name.trim()}"`, 'success');
      return true;
    } catch (e) {
      if (e.name === 'QuotaExceededError') toast('Hết dung lượng lưu trữ. Hãy xoá bớt dự án cũ.', 'error', 5000);
      else toast('Không lưu được: ' + e.message, 'error');
      return false;
    }
  }

  load(name) {
    const key = PREFIX + encodeURIComponent(name);
    const raw = localStorage.getItem(key);
    if (!raw) { toast('Không tìm thấy dự án', 'error'); return; }
    try {
      const snap = JSON.parse(raw);
      this.undo.pushSnapshot('before-load');
      this._apply(snap);
      this.undo.clear();
      toast(`Đã mở dự án "${name}". Hãy nạp lại ảnh/video mapled nếu cần.`, 'success', 5000);
    } catch (e) {
      toast('Không mở được dự án: ' + e.message, 'error');
    }
  }

  remove(name) {
    localStorage.removeItem(PREFIX + encodeURIComponent(name));
    toast(`Đã xoá dự án "${name}"`, 'info');
  }

  rename(oldName, newName) {
    if (!newName?.trim()) { toast('Tên không được trống', 'warn'); return false; }
    const oldKey = PREFIX + encodeURIComponent(oldName);
    const newKey = PREFIX + encodeURIComponent(newName.trim());
    if (localStorage.getItem(newKey)) { toast('Tên đã tồn tại', 'warn'); return false; }
    const raw = localStorage.getItem(oldKey);
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      data.name = newName.trim();
      localStorage.setItem(newKey, JSON.stringify(data));
      localStorage.removeItem(oldKey);
      return true;
    } catch { return false; }
  }

  // ---- Auto-save ----

  startAutoSave() {
    this.ledManager.on('change', () => this._scheduleAutoSave());
  }

  _scheduleAutoSave() {
    if (this.undo.isApplying) return;
    clearTimeout(this._autoTimer);
    this._autoTimer = setTimeout(() => {
      if (!this.ledManager.list().length) return;
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this._capture('__autosave__')));
      } catch {}
    }, 500);
  }

  // ---- Restore prompt ----

  maybeOfferRestore() {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return;
    try {
      const snap = JSON.parse(raw);
      if (!snap.leds?.length) return;
      const dlg = this._dlgRestore;
      if (!dlg) return;
      const date = snap.savedAt ? new Date(snap.savedAt).toLocaleString('vi-VN') : '';
      dlg.innerHTML = `
        <div class="dlg-shell">
          <div class="dlg-header"><span>🔄 Khôi phục phiên trước?</span></div>
          <div class="dlg-body" style="padding:16px 12px">
            <p>Phiên làm việc trước có <b>${snap.leds.length}</b> LED đã được lưu tự động</p>
            <p style="color:var(--muted);font-size:12px">${date}</p>
          </div>
          <div class="dlg-footer">
            <button id="restore-yes" class="btn btn-primary">Khôi phục</button>
            <button id="restore-no" class="btn">Bỏ qua</button>
          </div>
        </div>`;
      dlg.showModal();
      dlg.querySelector('#restore-yes').addEventListener('click', () => {
        this._apply(snap);
        toast('Đã khôi phục phiên trước. Hãy nạp lại ảnh/video mapled nếu cần.', 'success', 5000);
        dlg.close();
      });
      dlg.querySelector('#restore-no').addEventListener('click', () => dlg.close());
    } catch {}
  }

  // ---- Dialogs ----

  openSaveDialog() {
    const existing = this.list();
    const suggestName = this._suggestName(existing);
    const name = window.prompt('Tên dự án:', suggestName);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) { toast('Tên không được trống', 'warn'); return; }
    const existingProject = existing.find(p => p.name === trimmed);
    if (existingProject) {
      if (!window.confirm(`Dự án "${trimmed}" đã tồn tại. Ghi đè?`)) return;
    }
    this.save(trimmed);
  }

  openOpenDialog() {
    const dlg = this._dlgProjects;
    if (!dlg) return;
    this._renderOpenDialog();
    dlg.showModal();
  }

  _renderOpenDialog() {
    const dlg = this._dlgProjects;
    const projects = this.list();
    const rows = projects.map(p => `
      <li class="proj-row" data-name="${_escAttr(p.name)}">
        <div>
          <div class="proj-name">${_escHtml(p.name)}</div>
          <div class="proj-meta">${p.ledCount} LED · ${p.savedAt ? new Date(p.savedAt).toLocaleString('vi-VN') : ''}</div>
        </div>
        <button class="btn btn-sm proj-open">Mở</button>
        <button class="btn btn-sm proj-rename">✎</button>
        <button class="btn btn-sm btn-ghost proj-del">🗑</button>
      </li>`).join('');

    dlg.innerHTML = `
      <div class="dlg-shell">
        <div class="dlg-header">
          <span>📁 Dự án đã lưu</span>
          <button class="dlg-close btn btn-sm btn-ghost">✕</button>
        </div>
        <div class="dlg-body">
          <ul id="proj-list" class="proj-list">${rows || ''}</ul>
          ${!rows ? '<div class="empty-state"><div>Chưa có dự án nào</div><small>Bấm "Lưu mới" để lưu phiên hiện tại</small></div>' : ''}
        </div>
        <div class="dlg-footer">
          <button id="proj-new" class="btn btn-primary">💾 Lưu mới</button>
          <button id="proj-cancel" class="btn">Đóng</button>
        </div>
      </div>`;

    dlg.querySelector('.dlg-close').addEventListener('click', () => dlg.close());
    dlg.querySelector('#proj-cancel').addEventListener('click', () => dlg.close());
    dlg.querySelector('#proj-new').addEventListener('click', () => {
      dlg.close();
      this.openSaveDialog();
    });

    dlg.querySelectorAll('.proj-open').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.closest('[data-name]').dataset.name;
        dlg.close();
        this.load(name);
      });
    });
    dlg.querySelectorAll('.proj-rename').forEach(btn => {
      btn.addEventListener('click', () => {
        const li = btn.closest('[data-name]');
        const oldName = li.dataset.name;
        const newName = window.prompt('Tên mới:', oldName);
        if (newName && this.rename(oldName, newName.trim())) {
          this._renderOpenDialog();
        }
      });
    });
    dlg.querySelectorAll('.proj-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.closest('[data-name]').dataset.name;
        if (!window.confirm(`Xoá dự án "${name}"?`)) return;
        this.remove(name);
        this._renderOpenDialog();
      });
    });
  }

  // ---- Internal ----

  _capture(name) {
    const m = this.editor.mapled;
    return {
      v: 1,
      name,
      savedAt: new Date().toISOString(),
      ledCount: this.ledManager.list().length,
      pixelPitch: this.ledManager.pixelPitch,
      selection: [...this.ledManager.selection],
      leds: this.ledManager.list().map(_serializeLed),
      view: {
        scale: this.editor.viewScale,
        tx: this.editor.viewTx,
        ty: this.editor.viewTy,
        mapledPos: { ...m },
        opacity: this.editor.mapledOpacity,
      },
    };
  }

  _apply(snap) {
    if (!snap?.leds) return;
    this.ledManager.pixelPitch = snap.pixelPitch ?? 3.9;
    this.ledManager.restore(snap, this.ledManager._modelRoot);
    if (snap.view) {
      this.editor.viewScale = snap.view.scale ?? 1;
      this.editor.viewTx = snap.view.tx ?? 0;
      this.editor.viewTy = snap.view.ty ?? 0;
      if (snap.view.mapledPos) Object.assign(this.editor.mapled, snap.view.mapledPos);
      if (snap.view.opacity != null) this.editor.mapledOpacity = snap.view.opacity;
    }
    this.editor.render();
  }

  _suggestName(existing) {
    let n = existing.length + 1;
    let name = `Dự án ${n}`;
    while (existing.find(p => p.name === name)) name = `Dự án ${++n}`;
    return name;
  }
}

function _escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function _escAttr(s) { return _escHtml(s); }
