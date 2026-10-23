// DOM helpers and reusable widgets: toast, download, storage, URL-hash state,
// rolling strip chart, centre-zero gauges, hold-to-confirm button and the
// traffic-light check list.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

let toastTimer = 0;
export function toast(msg, kind = '', ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

export function download(filename, data, type = 'application/json') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export const fmt = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : '–');

// Only harmless preferences (theme, mode) are stored, and storage may be unavailable.
export function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
export function storageSet(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } }

// ---------------------------------------------------------------- URL-hash state
export function encodeState(obj) {
  const json = JSON.stringify(obj);
  return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function decodeState(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- strip chart
export const CHANNELS = [
  { key: 'Fx', color: '#e4572e' }, { key: 'Fy', color: '#17a398' }, { key: 'Fz', color: '#4c6ef5' },
  { key: 'Mx', color: '#e09f1f' }, { key: 'My', color: '#9b5de5' }, { key: 'Mz', color: '#7d8597' },
];

/** Forces (top band) and moments (bottom band) over the last `windowS` seconds. */
export class StripChart {
  constructor(canvas, legendEl, windowS = 10) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.window = windowS;
    this.points = [];
    this.events = [];
    if (legendEl) {
      legendEl.replaceChildren(...CHANNELS.map((c) => {
        const s = el('span', { text: c.key });
        s.style.setProperty('--c', c.color);
        return s;
      }));
    }
  }

  push(t, v) {
    this.points.push({ t, v: v.slice() });
    const cut = t - this.window - 1;
    while (this.points.length && this.points[0].t < cut) this.points.shift();
    while (this.events.length && this.events[0].t < cut) this.events.shift();
  }

  mark(t, label) { this.events.push({ t, label }); }
  clear() { this.points = []; this.events = []; }

  draw() {
    const c = this.canvas;
    if (!c.isConnected || c.offsetParent === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(document.documentElement);
    const grid = style.getPropertyValue('--border').trim() || '#ccc';
    const muted = style.getPropertyValue('--text-2').trim() || '#666';
    if (!this.points.length) return;
    const tEnd = this.points[this.points.length - 1].t;
    const t0 = tEnd - this.window;
    const x = (t) => ((t - t0) / this.window) * (w - 34) + 30;
    ctx.font = '10px system-ui, sans-serif';
    for (const b of [{ idx: [0, 1, 2], top: 2, bottom: h / 2 - 2, unit: 'N' }, { idx: [3, 4, 5], top: h / 2 + 2, bottom: h - 2, unit: 'N·m' }]) {
      let max = 1e-6;
      for (const p of this.points) for (const i of b.idx) max = Math.max(max, Math.abs(p.v[i]));
      max = niceCeil(max * 1.1);
      const mid = (b.top + b.bottom) / 2;
      const y = (v) => mid - (v / max) * (b.bottom - b.top) / 2;
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(30, mid); ctx.lineTo(w, mid); ctx.moveTo(30, b.top); ctx.lineTo(w, b.top); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(`±${fmtAxis(max)}`, 0, b.top + 9);
      ctx.fillText(b.unit, 0, mid + 3);
      for (const i of b.idx) {
        ctx.strokeStyle = CHANNELS[i].color;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        let started = false;
        for (const p of this.points) {
          if (p.t < t0) continue;
          if (!started) { ctx.moveTo(x(p.t), y(p.v[i])); started = true; } else ctx.lineTo(x(p.t), y(p.v[i]));
        }
        ctx.stroke();
      }
    }
    for (const e of this.events) {
      if (e.t < t0) continue;
      const px = x(e.t);
      ctx.strokeStyle = muted;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = muted;
      ctx.fillText(e.label, Math.min(px + 3, w - 40), 10);
    }
  }
}

function niceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
const fmtAxis = (v) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));

// ---------------------------------------------------------------- gauges
/** Six centre-zero bar gauges; full scale per channel. */
export class Gauges {
  constructor(container, fullScale) {
    this.fullScale = fullScale;
    this.rows = CHANNELS.map((c, i) => {
      const fill = el('span', { class: 'gauge-fill' });
      fill.style.background = c.color;
      const val = el('span', { class: 'gauge-val', text: '–' });
      const row = el('div', { class: 'gauge', role: 'meter', 'aria-label': c.key, 'aria-valuemin': -fullScale[i], 'aria-valuemax': fullScale[i] },
        el('span', { class: 'gauge-key', text: c.key }), el('span', { class: 'gauge-track' }, el('span', { class: 'gauge-zero' }), fill), val);
      container.append(row);
      return { row, fill, val };
    });
  }

  set(values) {
    values.forEach((v, i) => {
      const r = this.rows[i];
      const f = Math.max(-1, Math.min(1, v / this.fullScale[i]));
      r.fill.style.left = f >= 0 ? '50%' : `${50 + f * 50}%`;
      r.fill.style.width = `${Math.abs(f) * 50}%`;
      r.val.textContent = fmt(v, i < 3 ? 2 : 3);
      r.row.setAttribute('aria-valuenow', v.toFixed(3));
    });
  }
}

// ---------------------------------------------------------------- hold-to-confirm
/**
 * A button you must hold (pointer or Space/Enter) while a ring fills.
 * progress(): return 0..1 (driven by the caller); onRelease(early) fires on let-go.
 */
export class HoldButton {
  constructor(button, { onStart, onRelease }) {
    this.button = button;
    this.held = false;
    this.ring = button.querySelector('.ring-fg');
    const start = (e) => {
      if (button.disabled || this.held) return;
      e.preventDefault();
      this.held = true;
      button.classList.add('holding');
      button.classList.remove('ruined');
      onStart?.();
    };
    const end = () => {
      if (!this.held) return;
      this.held = false;
      button.classList.remove('holding');
      onRelease?.();
    };
    button.addEventListener('pointerdown', start);
    window.addEventListener('pointerup', end);
    button.addEventListener('pointerleave', end);
    button.addEventListener('keydown', (e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) start(e); });
    button.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') end(); });
    button.addEventListener('blur', end);
  }

  setProgress(f) {
    if (this.ring) this.ring.style.strokeDashoffset = String(100 - Math.max(0, Math.min(1, f)) * 100);
  }

  ruin() {
    this.button.classList.add('ruined');
    this.setProgress(0);
  }
}

export const ringSVG = () => el('span', {
  class: 'ring',
  html: '<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="ring-bg" cx="18" cy="18" r="15.9" pathLength="100"/><circle class="ring-fg" cx="18" cy="18" r="15.9" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></svg>',
});

// ---------------------------------------------------------------- traffic lights
/** checks: [{ id, label, state:'green'|'amber'|'red', detail, why? }] */
export function renderChecks(container, checks, { onWhy } = {}) {
  container.replaceChildren(...checks.map((c) => el('li', { class: `tl tl-${c.state}`, 'data-check': c.id },
    el('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
    el('span', { class: 'tl-body' },
      el('span', { class: 'tl-label', text: c.label }),
      c.detail ? el('span', { class: 'tl-detail', text: c.detail }) : null),
    el('span', { class: 'sr-only', text: ` status ${c.state}` }),
    c.why && onWhy ? el('button', { class: 'btn ghost small why', type: 'button', text: 'Why?', onclick: () => onWhy(c) }) : null)));
}

export const worstState = (checks) => (checks.some((c) => c.state === 'red') ? 'red' : checks.some((c) => c.state === 'amber') ? 'amber' : 'green');
