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
    if (!name?.trim()) { toast('Project name cannot be empty', 'warn'); return false; }
    const snap = this._capture(name.trim());
    try {
      localStorage.setItem(PREFIX + encodeURIComponent(name.trim()), JSON.stringify(snap));
      toast(`Saved "${name.trim()}"`, 'success');
      return true;
    } catch (e) {
      if (e.name === 'QuotaExceededError') toast('Storage full. Delete older projects.', 'error', 5000);
      else toast('Could not save: ' + e.message, 'error');
      return false;
    }
  }

  load(name) {
    const key = PREFIX + encodeURIComponent(name);
    const raw = localStorage.getItem(key);
    if (!raw) { toast('Project not found', 'error'); return; }
    try {
      const snap = JSON.parse(raw);
      this.undo.pushSnapshot('before-load');
      this._apply(snap);
      this.undo.clear();
      toast(`Opened "${name}". Reload the mapled image/video if needed.`, 'success', 5000);
    } catch (e) {
      toast('Could not open project: ' + e.message, 'error');
    }
  }

  remove(name) {
    localStorage.removeItem(PREFIX + encodeURIComponent(name));
    toast(`Deleted "${name}"`, 'info');
  }

  rename(oldName, newName) {
    if (!newName?.trim()) { toast('Name cannot be empty', 'warn'); return false; }
    const oldKey = PREFIX + encodeURIComponent(oldName);
    const newKey = PREFIX + encodeURIComponent(newName.trim());
    if (localStorage.getItem(newKey)) { toast('Name already in use', 'warn'); return false; }
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
      const date = snap.savedAt ? new Date(snap.savedAt).toLocaleString() : '';
      dlg.innerHTML = `
        <div class="dlg-shell">
          <div class="dlg-header"><span>◆ Restore previous session?</span></div>
          <div class="dlg-body" style="padding:16px 12px">
            <p>Your last session had <b>${snap.leds.length}</b> LED panels and was auto-saved.</p>
            <p style="color:var(--muted);font-size:12px">${date}</p>
          </div>
          <div class="dlg-footer">
            <button id="restore-yes" class="btn btn-primary">Restore</button>
            <button id="restore-no" class="btn">Skip</button>
          </div>
        </div>`;
      dlg.showModal();
      dlg.querySelector('#restore-yes').addEventListener('click', () => {
        this._apply(snap);
        toast('Session restored. Reload the mapled image/video if needed.', 'success', 5000);
        dlg.close();
      });
      dlg.querySelector('#restore-no').addEventListener('click', () => dlg.close());
    } catch {}
  }

  // ---- Dialogs ----

  openSaveDialog() {
    const existing = this.list();
    const suggestName = this._suggestName(existing);
    const name = window.prompt('Project name:', suggestName);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) { toast('Name cannot be empty', 'warn'); return; }
    const existingProject = existing.find(p => p.name === trimmed);
    if (existingProject) {
      if (!window.confirm(`"${trimmed}" already exists. Overwrite?`)) return;
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
          <div class="proj-meta">${p.ledCount} LEDs · ${p.savedAt ? new Date(p.savedAt).toLocaleString() : ''}</div>
        </div>
        <button class="btn btn-sm proj-open">Open</button>
        <button class="btn btn-sm proj-rename">✎</button>
        <button class="btn btn-sm btn-ghost proj-del">✕</button>
      </li>`).join('');

    dlg.innerHTML = `
      <div class="dlg-shell">
        <div class="dlg-header">
          <span>◆ Saved Projects</span>
          <button class="dlg-close btn btn-sm btn-ghost">✕</button>
        </div>
        <div class="dlg-body">
          <ul id="proj-list" class="proj-list">${rows || ''}</ul>
          ${!rows ? '<div class="empty-state"><div>No saved projects</div><small>Use Save (Ctrl+S) to save the current session</small></div>' : ''}
        </div>
        <div class="dlg-footer">
          <button id="proj-new" class="btn btn-primary">Save current</button>
          <button id="proj-cancel" class="btn">Close</button>
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
        const newName = window.prompt('New name:', oldName);
        if (newName && this.rename(oldName, newName.trim())) {
          this._renderOpenDialog();
        }
      });
    });
    dlg.querySelectorAll('.proj-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.closest('[data-name]').dataset.name;
        if (!window.confirm(`Delete "${name}"?`)) return;
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
    let name = `Project ${n}`;
    while (existing.find(p => p.name === name)) name = `Project ${++n}`;
    return name;
  }
}

function _escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function _escAttr(s) { return _escHtml(s); }
