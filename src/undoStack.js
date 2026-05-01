// Bounded undo stack (max 5 steps) for LED mapping state.
//
// Snapshots are taken BEFORE a mutation. Callers push a snapshot at the right
// site (pointerdown before drag, before add/remove, etc.) — never inside a
// render loop or event handler that fires on every frame.

export class UndoStack {
  constructor(ledManager, editor, opts = {}) {
    this.ledManager = ledManager;
    this.editor = editor;
    this.max = opts.max ?? 5;
    /** @type {Array<object>} */
    this._stack = [];
    this.isApplying = false;
  }

  // Push the current state as a snapshot. Call BEFORE the mutating operation.
  pushSnapshot(label = 'edit') {
    if (this.isApplying) return;
    const snap = this._capture(label);
    this._stack.push(snap);
    if (this._stack.length > this.max) this._stack.shift();
  }

  // Pop and apply the most recent snapshot. No-op if stack is empty.
  undo() {
    if (!this._stack.length) {
      const { toast } = _utils();
      toast('Không còn thao tác nào để hoàn tác', 'info', 2000);
      return;
    }
    const snap = this._stack.pop();
    this.isApplying = true;
    try {
      this._apply(snap);
      const { toast } = _utils();
      toast(`Đã hoàn tác: ${snap.label}`, 'info', 1800);
    } finally {
      this.isApplying = false;
    }
  }

  canUndo() { return this._stack.length > 0; }

  clear() { this._stack = []; }

  // ---- Internal ----

  _capture(label) {
    const m = this.editor.mapled;
    const snap = {
      v: 1,
      label,
      ts: Date.now(),
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
    return snap;
  }

  _apply(snap) {
    this.ledManager.pixelPitch = snap.pixelPitch;
    this.ledManager.restore(snap, this.ledManager._modelRoot);
    // Restore view state.
    if (snap.view) {
      this.editor.viewScale = snap.view.scale;
      this.editor.viewTx = snap.view.tx;
      this.editor.viewTy = snap.view.ty;
      Object.assign(this.editor.mapled, snap.view.mapledPos || {});
      this.editor.mapledOpacity = snap.view.opacity;
    }
    this.editor.render();
  }
}

export function _serializeLed(led) {
  return {
    id: led.id,
    meshUuid: led.meshUuid,
    name: led.name,
    color: led.color,
    realW: led.realW,
    realH: led.realH,
    pixelW: led.pixelW,
    pixelH: led.pixelH,
    pixelPitch: led.pixelPitch,
    world: { ...led.world },
    map2d: { ...led.map2d },
    hidden: led.hidden,
  };
}

// Lazy import of toast to avoid circular deps.
function _utils() {
  return { toast: window.__toast || ((m) => console.log(m)) };
}
