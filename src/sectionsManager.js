// Project persistence.
//
// Save  → downloads a JSON file (by default into the user's Downloads folder;
//         the user can move it into the repo's `saves/` folder for re-use).
// Open  → file picker that reads a previously-saved JSON.
// Autosave → localStorage (invisible to the user, used by maybeOfferRestore()).

import { _serializeLed } from './undoStack.js';
import { downloadJSON, readFileAsText, toast } from './utils.js';
import { t } from './i18n.js';

const AUTOSAVE_KEY = 'fs.stage.autosave.current';

export class SectionsManager {
  constructor(ledManager, viewer, editor, undo) {
    this.ledManager = ledManager;
    this.viewer = viewer;
    this.editor = editor;
    this.undo = undo;
    this._autoTimer = null;
    this._dlgRestore = document.getElementById('dlg-restore');
    this._fileInput = document.getElementById('file-project');
    if (this._fileInput) {
      this._fileInput.addEventListener('change', (e) => this._handleFile(e.target.files?.[0]));
    }
  }

  // ---- Save (download as JSON) ----

  openSaveDialog() {
    const suggest = this._suggestName();
    const name = window.prompt(t('prompt.projectName'), suggest);
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) { toast(t('prompt.nameEmpty'), 'warn'); return; }
    this._saveAsFile(trimmed);
  }

  _saveAsFile(name) {
    const snap = this._capture(name);
    const safeName = name.replace(/[^\w\d\-_. ]+/g, '_');
    const file = `${safeName}.fsproject.json`;
    try {
      downloadJSON(snap, file);
      toast(t('toast.savedProject', { file }), 'success', 5000);
    } catch (e) {
      toast(t('toast.saveFailed', { err: e.message }), 'error');
    }
  }

  // ---- Open (file picker) ----

  openOpenDialog() {
    if (!this._fileInput) return;
    this._fileInput.value = '';
    this._fileInput.click();
  }

  async _handleFile(file) {
    if (!file) return;
    try {
      const text = await readFileAsText(file);
      const snap = JSON.parse(text);
      if (!snap?.leds) { toast(t('toast.invalidProject'), 'error'); return; }
      this.undo.pushSnapshot('before-load');
      this._apply(snap);
      this.undo.clear();
      toast(t('toast.openedProject', { name: snap.name || file.name }), 'success', 5000);
    } catch (e) {
      toast(t('toast.openFailed', { err: e.message }), 'error');
    }
  }

  // ---- Auto-save to localStorage (silent recovery layer) ----

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
        activeGroup: this.editor.activeGroup,
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
      if (snap.view.mapledPos) this.editor.mapled = snap.view.mapledPos;
      if (snap.view.opacity != null) this.editor.mapledOpacity = snap.view.opacity;
      if (snap.view.activeGroup != null) this.editor.setActiveGroup(snap.view.activeGroup);
    }
    this.editor.render();
  }

  _suggestName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `Stage_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  }
}
