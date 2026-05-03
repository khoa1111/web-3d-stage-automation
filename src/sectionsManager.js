// Project persistence.
//
// Save: opens a dialog with a name input + mode selector
//   * Light          → only LED layout + view state.    Tiny .fsp file.
//   * With assets    → also embeds the 3D model file and every group's
//                      mapled image/video as base64.    Self-contained .fsp.
// Open: file picker. If the .fsp embedded a model, it loads automatically.
//       Otherwise, if the loaded scene's mesh UUIDs don't match the saved
//       LEDs, a small dialog asks the user to pick the original 3D model
//       file before applying the LED layout.
// Autosave: localStorage, used by maybeOfferRestore() (light only).
//
// File extension is .fsp (still JSON internally; "format":"fsp" header).

import { _serializeLed } from './undoStack.js';
import { downloadJSON, readFileAsText, readFileAsDataURL, toast } from './utils.js';
import { t } from './i18n.js';

const AUTOSAVE_KEY = 'fs.stage.autosave.current';

export class SectionsManager {
  constructor(ledManager, viewer, editor, undo, hooks = {}) {
    this.ledManager = ledManager;
    this.viewer = viewer;
    this.editor = editor;
    this.undo = undo;
    this._hooks = hooks; // { getModelFile, loadModelFromFile, loadMapledFromFile }
    this._autoTimer = null;
    this._dlgRestore = document.getElementById('dlg-restore');
    this._dlgProjects = document.getElementById('dlg-projects');
    this._fileInput = document.getElementById('file-project');
    if (this._fileInput) {
      this._fileInput.addEventListener('change', (e) => this._handleFile(e.target.files?.[0]));
    }
  }

  // ---- Save ----

  openSaveDialog() {
    const dlg = this._dlgProjects;
    if (!dlg) { this._fallbackSave(); return; }

    const suggest = this._suggestName();
    dlg.innerHTML = `
      <form method="dialog" class="dlg-shell">
        <div class="dlg-header"><span>◆ ${this._txt('save.title', 'Save project')}</span></div>
        <div class="dlg-body" style="padding:16px 14px; display:flex; flex-direction:column; gap:14px">
          <label style="display:flex; flex-direction:column; gap:6px; font-size:12px">
            <span style="color:var(--muted)">${this._txt('save.name', 'Project name')}</span>
            <input id="dlg-save-name" type="text" value="${suggest}" autofocus
                   style="background:var(--bg-input); border:1px solid var(--border); color:var(--fg); padding:8px 10px; border-radius:6px; font-size:13px"/>
          </label>
          <fieldset style="border:1px solid var(--border); border-radius:6px; padding:10px 12px">
            <legend style="padding:0 6px; color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em">${this._txt('save.mode', 'Save mode')}</legend>
            <label style="display:flex; gap:8px; align-items:flex-start; padding:6px 0; cursor:pointer">
              <input type="radio" name="save-mode" value="light" checked />
              <span>
                <div><b>${this._txt('save.light', 'Light')}</b></div>
                <small style="color:var(--muted)">${this._txt('save.light.desc', 'Only LED layout + view. Smallest file.')}</small>
              </span>
            </label>
            <label style="display:flex; gap:8px; align-items:flex-start; padding:6px 0; cursor:pointer">
              <input type="radio" name="save-mode" value="assets" />
              <span>
                <div><b>${this._txt('save.assets', 'With assets')}</b></div>
                <small style="color:var(--muted)">${this._txt('save.assets.desc', 'Embeds 3D model + every group\'s image/video. Self-contained but larger.')}</small>
              </span>
            </label>
          </fieldset>
        </div>
        <div class="dlg-footer">
          <button id="dlg-save-cancel" type="button" class="btn">${this._txt('cancel', 'Cancel')}</button>
          <button id="dlg-save-ok" type="button" class="btn btn-primary">${this._txt('save', 'Save')}</button>
        </div>
      </form>`;

    const ok = dlg.querySelector('#dlg-save-ok');
    const cancel = dlg.querySelector('#dlg-save-cancel');
    cancel.addEventListener('click', () => dlg.close());
    ok.addEventListener('click', async () => {
      const name = (dlg.querySelector('#dlg-save-name').value || '').trim();
      if (!name) { toast(t('prompt.nameEmpty'), 'warn'); return; }
      const mode = dlg.querySelector('input[name="save-mode"]:checked')?.value || 'light';
      ok.disabled = true;
      try {
        await this._saveAsFile(name, mode);
        dlg.close();
      } catch (e) {
        toast(t('toast.saveFailed', { err: e.message }), 'error');
      } finally {
        ok.disabled = false;
      }
    });
    dlg.showModal();
  }

  _fallbackSave() {
    const name = window.prompt(t('prompt.projectName'), this._suggestName());
    if (!name) return;
    this._saveAsFile(name.trim(), 'light').catch((e) =>
      toast(t('toast.saveFailed', { err: e.message }), 'error')
    );
  }

  async _saveAsFile(name, mode) {
    const snap = this._capture(name);
    if (mode === 'assets') {
      snap.assets = await this._gatherAssets();
    }
    const safeName = name.replace(/[^\w\d\-_. ]+/g, '_');
    const file = `${safeName}.fsp`;
    downloadJSON(snap, file);
    toast(t('toast.savedProject', { file }), 'success', 5000);
  }

  async _gatherAssets() {
    const out = { model: null, media: {} };

    // Embed the 3D model file if we have a reference to it.
    const modelFile = this._hooks.getModelFile?.();
    if (modelFile) {
      out.model = {
        name: modelFile.name,
        type: modelFile.type || '',
        data: await readFileAsDataURL(modelFile),
      };
    }

    // Embed each group's mapled file.
    for (const [groupName, g] of this.editor.groupsWithState()) {
      const f = g._sourceFile;
      if (!f) continue;
      try {
        out.media[groupName] = {
          name: f.name,
          type: f.type || '',
          data: await readFileAsDataURL(f),
        };
      } catch {}
    }
    return out;
  }

  // ---- Open ----

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
      await this._applyWithModel(snap, file.name);
    } catch (e) {
      toast(t('toast.openFailed', { err: e.message }), 'error');
    }
  }

  // Walk through the steps: ensure model is loaded → apply LED snapshot →
  // restore mapled assets → apply view state.
  async _applyWithModel(snap, fileName) {
    this.undo.pushSnapshot('before-load');

    const meshUuids = new Set((snap.leds || []).map(l => l.meshUuid).filter(Boolean));
    const meshNames = new Set((snap.leds || []).map(l => l.name).filter(Boolean));

    // Step 1: model. Three sources, in priority order:
    //   a) embedded `assets.model`
    //   b) currently-loaded model whose meshes cover the saved LEDs
    //   c) prompt the user with a file picker
    const modelOk = this._currentModelCovers(meshUuids, meshNames);

    if (snap.assets?.model && !modelOk) {
      await this._loadEmbeddedModel(snap.assets.model);
    } else if (!modelOk && (meshUuids.size > 0 || meshNames.size > 0)) {
      const picked = await this._promptForModelFile();
      if (picked) await this._hooks.loadModelFromFile?.(picked);
      // Even if the user skips, apply LED data — they become orphans.
    }

    // Step 2: LED layout + view state.
    this._apply(snap);

    // Step 3: media (per-group images / videos), if present.
    if (snap.assets?.media) {
      await this._restoreMedia(snap.assets.media, snap.view?.activeGroup);
    }

    this.undo.clear();
    toast(t('toast.openedProject', { name: snap.name || fileName }), 'success', 5000);
  }

  _currentModelCovers(meshUuids, meshNames) {
    if (!meshUuids.size && !meshNames.size) return true;
    const root = this.ledManager._modelRoot;
    if (!root) return false;
    const haveUuids = new Set();
    const haveNames = new Set();
    root.traverse((o) => {
      if (o.isMesh) {
        haveUuids.add(o.uuid);
        if (o.name) haveNames.add(o.name);
      }
    });
    // Three.js regenerates mesh UUIDs on every parse, so a fresh import of the
    // same model file will have all-new UUIDs. ledManager.restore() falls back
    // to mesh name lookup in that case — match the same logic here so we don't
    // unnecessarily prompt the user when their currently-loaded model already
    // works.
    for (const u of meshUuids) if (haveUuids.has(u)) return true;
    for (const n of meshNames) if (haveNames.has(n)) return true;
    return false;
  }

  async _loadEmbeddedModel(modelAsset) {
    const blob = await (await fetch(modelAsset.data)).blob();
    const file = new File([blob], modelAsset.name, { type: modelAsset.type || '' });
    await this._hooks.loadModelFromFile?.(file);
  }

  // Show a small modal asking the user to select the original 3D model.
  // Resolves with the chosen File or null.
  _promptForModelFile() {
    return new Promise((resolve) => {
      const dlg = this._dlgProjects;
      if (!dlg) { resolve(null); return; }
      dlg.innerHTML = `
        <form method="dialog" class="dlg-shell">
          <div class="dlg-header"><span>◆ ${this._txt('open.modelNeeded', 'Source 3D model needed')}</span></div>
          <div class="dlg-body" style="padding:16px 14px; display:flex; flex-direction:column; gap:12px; max-width:440px">
            <p style="margin:0; font-size:13px; line-height:1.5">
              ${this._txt('open.modelNeeded.body', 'This project references a 3D model that isn\'t loaded yet. Select the original .dae / .gltf / .obj / .fbx file to restore the LED layout.')}
            </p>
            <input id="dlg-pick-model" type="file" accept=".gltf,.glb,.obj,.dae,.fbx"
                   style="background:var(--bg-input); border:1px solid var(--border); color:var(--fg); padding:8px; border-radius:6px"/>
          </div>
          <div class="dlg-footer">
            <button id="dlg-pick-skip" type="button" class="btn">${this._txt('open.skip', 'Skip')}</button>
            <button id="dlg-pick-ok"   type="button" class="btn btn-primary" disabled>${this._txt('open.useModel', 'Use this file')}</button>
          </div>
        </form>`;
      const fileInput = dlg.querySelector('#dlg-pick-model');
      const ok = dlg.querySelector('#dlg-pick-ok');
      const skip = dlg.querySelector('#dlg-pick-skip');
      let picked = null;
      fileInput.addEventListener('change', () => {
        picked = fileInput.files?.[0] || null;
        ok.disabled = !picked;
      });
      ok.addEventListener('click', () => { dlg.close(); resolve(picked); });
      skip.addEventListener('click', () => { dlg.close(); resolve(null); });
      dlg.showModal();
    });
  }

  async _restoreMedia(media, preferredActive) {
    const prevActive = this.editor.activeGroup;
    for (const [groupName, asset] of Object.entries(media)) {
      try {
        const blob = await (await fetch(asset.data)).blob();
        const file = new File([blob], asset.name, { type: asset.type || '' });
        // Switch to the target group so loadMapledFromFile writes into it.
        this.editor.setActiveGroup(groupName);
        await this._hooks.loadMapledFromFile?.(file);
      } catch (e) {
        console.warn(`Could not restore media for group "${groupName}":`, e);
      }
    }
    // Restore the saved active group if specified, else the prior one.
    const target = preferredActive ?? prevActive;
    if (target != null) this.editor.setActiveGroup(target);
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
        // Light-only: assets would blow past the 5MB localStorage budget.
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
      format: 'fsp',
      version: 1,
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
        // Per-group mapled position/scale survives even when assets aren't
        // embedded — re-loading the same media will land in the right place.
        groups: this._captureGroups(),
      },
    };
  }

  _captureGroups() {
    const out = {};
    for (const [name, g] of this.editor.groupsWithState()) {
      out[name] = {
        x: g.x, y: g.y, scale: g.scale,
        opacity: g.opacity,
        overlayHidden: !!g.overlayHidden,
        hasMedia: !!g.image,
      };
    }
    return out;
  }

  _apply(snap) {
    if (!snap?.leds) return;
    this.ledManager.pixelPitch = snap.pixelPitch ?? 3.9;
    this.ledManager.restore(snap, this.ledManager._modelRoot);
    if (snap.view) {
      this.editor.viewScale = snap.view.scale ?? 1;
      this.editor.viewTx = snap.view.tx ?? 0;
      this.editor.viewTy = snap.view.ty ?? 0;
      // Replay per-group placements (without media — that comes via _restoreMedia).
      const groups = snap.view.groups || {};
      for (const [name, g] of Object.entries(groups)) {
        const ent = this.editor._ensureGroup(name);
        ent.x = g.x ?? ent.x;
        ent.y = g.y ?? ent.y;
        ent.scale = g.scale ?? ent.scale;
        ent.opacity = g.opacity ?? ent.opacity;
        ent.overlayHidden = !!g.overlayHidden;
      }
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

  // Tiny i18n shim: try the key, fall back to the literal if missing.
  _txt(key, fallback) {
    const v = t(`projects.${key}`);
    return (v && v !== `projects.${key}`) ? v : fallback;
  }
}
