// Run recording, JSON export, replay with a scrubber and run comparison.
// Runs are kept in memory for this session only (no storage, no network).
import { download, el } from './ui.js';

const DISCLAIMER = 'Educational simulation only. Not connected to hardware; never use for real robot commissioning. All values illustrative.';

export class Recorder {
  constructor() {
    this.history = [];      // finished runs, newest last
    this.current = null;
  }

  start(kind, meta = {}) {
    this.current = { kind, meta, started: new Date().toISOString(), frames: [], events: [] };
    return this.current;
  }

  /** frame: { t, angles, tcp:[x,y,z], speed, clearance, ... } */
  frame(f) { this.current?.frames.push(f); }

  event(t, type, detail = {}) { this.current?.events.push({ t: +t.toFixed(3), type, ...detail }); }

  finish(summary) {
    if (!this.current) return null;
    const run = { ...this.current, finished: new Date().toISOString(), summary };
    this.history.push(run);
    this.current = null;
    return run;
  }

  last(kind) { return [...this.history].reverse().find((r) => r.kind === kind) ?? null; }
  previous(kind) { return this.history.filter((r) => r.kind === kind).slice(-2, -1)[0] ?? null; }
}

/** Downloadable report (frames are decimated so files stay small). */
export function exportRun(run, extra = {}) {
  const step = Math.max(1, Math.floor(run.frames.length / 600));
  const data = {
    title: 'Robot test cell: simulation report',
    disclaimer: DISCLAIMER,
    kind: run.kind,
    started: run.started,
    finished: run.finished,
    settings: run.meta,
    summary: run.summary,
    events: run.events,
    frames: run.frames.filter((_, i) => i % step === 0).map((f) => ({
      t: +f.t.toFixed(3), angles: Object.fromEntries(Object.entries(f.angles).map(([k, v]) => [k, +v.toFixed(2)])),
      tcp: f.tcp?.map((v) => +v.toFixed(4)), speedMmS: f.speed !== undefined ? +(f.speed * 1000).toFixed(1) : undefined,
      clearanceMm: f.clearance !== undefined ? +(f.clearance * 1000).toFixed(1) : undefined,
    })),
    ...extra,
  };
  download(`robot-cell-${run.kind}-${run.started.replace(/[:.]/g, '-')}.json`, JSON.stringify(data, null, 2));
  return data;
}

/** Table rows comparing two run summaries (numbers only). */
export function compareRows(a, b, fields) {
  return fields.map(([key, label, unit, better]) => {
    const va = a?.summary?.[key];
    const vb = b?.summary?.[key];
    let trend = '';
    if (typeof va === 'number' && typeof vb === 'number' && va !== vb) {
      const improved = better === 'higher' ? vb > va : vb < va;
      trend = improved ? '▲ better' : '▼ worse';
    }
    return el('tr', {}, el('th', { text: label }), el('td', { text: fmtVal(va, unit) }), el('td', { text: fmtVal(vb, unit) }), el('td', { class: trend.includes('better') ? 'good' : trend ? 'bad' : '', text: trend }));
  });
}

const fmtVal = (v, unit) => (v === undefined || v === null ? '–' : typeof v === 'number' ? `${+v.toFixed(1)}${unit ? ` ${unit}` : ''}` : String(v));

/** Scrubber-driven replay that poses the robot from recorded frames. */
export class Replay {
  constructor(robot, { range, label, onSeek }) {
    this.robot = robot;
    this.range = range;
    this.label = label;
    this.onSeek = onSeek;
    this.run = null;
    range.addEventListener('input', () => this.seek(Number(range.value)));
  }

  load(run) {
    this.run = run;
    this.range.max = String(Math.max(0, run.frames.length - 1));
    this.range.value = '0';
    this.range.disabled = !run.frames.length;
    this.seek(0);
  }

  seek(i) {
    if (!this.run?.frames.length) return;
    const f = this.run.frames[Math.min(i, this.run.frames.length - 1)];
    this.robot.setAngles(f.angles, { clamp: false });
    const ev = this.run.events.filter((e) => e.t <= f.t).pop();
    this.label.textContent = `t = ${f.t.toFixed(2)} s${f.clearance !== undefined ? ` · clearance ${(f.clearance * 1000).toFixed(0)} mm` : ''}${f.speed !== undefined ? ` · ${(f.speed * 1000).toFixed(0)} mm/s` : ''}${ev ? ` · last event: ${ev.type}` : ''}`;
    this.onSeek?.(f, i);
  }
}
