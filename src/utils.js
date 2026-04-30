// Utility helpers shared by all modules.

export function $(sel, root = document) { return root.querySelector(sel); }
export function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

export function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export function fmt(n, digits = 2) {
  if (!isFinite(n)) return '0';
  return Number(n).toFixed(digits);
}

export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

// Simple toast system (matches index.html toast-host).
let _toastSeq = 0;
export function toast(msg, kind = 'info', ms = 3000) {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  el.dataset.id = ++_toastSeq;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 250);
  }, ms);
}

// Detect if a 3D mesh "looks like" an LED panel by name hints / material colour.
const LED_NAME_HINTS = [
  'led', 'panel', 'screen', 'monitor', 'display', 'video',
  'man hinh', 'man-hinh', 'manhinh', 'tv', 'mapled'
];
export function looksLikeLed(mesh) {
  const name = (mesh?.name || '').toLowerCase();
  if (!name) return false;
  for (const h of LED_NAME_HINTS) {
    if (name.includes(h)) return true;
  }
  // Material name hint.
  const mat = mesh.material;
  const matName = Array.isArray(mat)
    ? mat.map(m => m?.name || '').join(' ').toLowerCase()
    : (mat?.name || '').toLowerCase();
  for (const h of LED_NAME_HINTS) {
    if (matName.includes(h)) return true;
  }
  return false;
}

export function setStatus(text) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = text;
}

// Generate a stable color for an LED id.
export function ledColor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 75%, 55%)`;
}

// Convert hsl string back to hex (used when assigning to materials).
export function hslToHex(hslStr) {
  const m = /hsl\((\d+),\s*(\d+)%?,\s*(\d+)%?\)/.exec(hslStr);
  if (!m) return 0xff3366;
  const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const to = (x) => Math.round(x * 255);
  return (to(f(0)) << 16) | (to(f(8)) << 8) | to(f(4));
}
