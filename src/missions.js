// Interactive missions (simulation only): framework, Mission 1 (commission),
// Mission 2 (F/T zero + calibration), Mission 3 (dry run), bonus challenges.
// Scores are computed from measured criteria; formulas are in each
// mission's score() method.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { JOINTS } from './robot.js';
import { FTSensor, fitGravity, predict, conditioning, gauss } from './ftsensor.js';
import { Replay, exportRun, compareRows } from './report.js';
import {
  $, $$, el, toast, fmt, StripChart, Gauges, HoldButton, ringSVG, renderChecks, worstState, CHANNELS,
} from './ui.js';

const DEG = Math.PI / 180;
const JOINT_SECTION = { A1: 'base', A2: 'A2', A3: 'A3', A4: 'A4', A5: 'A5', A6: 'A6' };
const FIXTURE = new THREE.Vector3(-0.35, 0, -0.6);
const POT_TOP_Y = 0.425;
const sec = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ============================================================== framework
export class MissionControl {
  constructor(ctx) {
    Object.assign(this, ctx);   // scene, robot, inspector, hotspots, recorder, cfg, motion, state, saveState, setPreset
    this.mode = ctx.state.mode ?? 'guided';
    this.sensor = new FTSensor(this.robot, this.cfg.sensor);
    this.gizmo = this.scene.makeGizmo({ size: 0.6 });
    this.gizmo.addEventListener('objectChange', () => this.gizmoCb?.());
    this.missions = {
      m1: new Mission1(this),
      m2: new Mission2(this),
      m3: new Mission3(this),
      bonus: new Bonus(this),
    };
    this.active = 'm1';
    this._bindChrome();
    this.refreshLocks();
    this.select('m1', { brief: false });
  }

  get expert() { return this.mode === 'expert'; }
  tol() { return this.cfg.mission2.tolerance[this.mode]; }

  _bindChrome() {
    $$('#mode-toggle button').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    this.setMode(this.mode, { silent: true });
    $$('#mission-tabs [role="tab"]').forEach((t, i, tabs) => {
      t.addEventListener('click', () => this.select(t.dataset.mission));
      t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        n.focus();
        this.select(n.dataset.mission);
      });
    });
    $('#briefing-start').addEventListener('click', () => {
      $('#briefing').close();
      this.missions[this.active].begin();
    });
    $('#why-close').addEventListener('click', () => this.closeWhy());
    $('#hud-showme').addEventListener('click', () => this.showMe());
    $('#why-show').addEventListener('click', () => {
      if (this.whyHotspot) this.hotspots.focus(this.whyHotspot);
    });
  }

  setMode(mode, { silent = false } = {}) {
    this.mode = mode;
    $$('#mode-toggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    document.body.dataset.mode = mode;
    this.state.mode = mode;
    this.saveState();
    if (!silent) toast(mode === 'expert' ? 'Expert mode: no hints, tighter tolerances, random faults.' : 'Guided mode: hints and explanations on.');
    Object.values(this.missions ?? {}).forEach((m) => m.onMode?.());
  }

  refreshLocks() {
    const unlocked = !!this.state.m1?.locked;
    for (const id of ['m2', 'm3']) {
      const tab = $(`#mission-tabs [data-mission="${id}"]`);
      tab.classList.toggle('locked', !unlocked);
      tab.setAttribute('aria-disabled', String(!unlocked));
      tab.title = unlocked ? '' : 'Locked: complete Mission 1 (Commission the cell) first';
    }
  }

  select(id, { brief = true } = {}) {
    const tab = $(`#mission-tabs [data-mission="${id}"]`);
    if (tab.classList.contains('locked')) {
      toast('Locked: confirm and lock the cell configuration in Mission 1 first.');
      this.why({ title: 'Why is this mission locked?', body: 'Missions 2 and 3 use the tool mass, centre of mass, operating mode, speed limit and workspace box from Mission 1. Until that configuration is confirmed and locked, there is nothing safe to calibrate against or verify.', hotspot: 'HS_Controller' });
      return;
    }
    const prev = this.missions[this.active];
    if (prev && prev !== this.missions[id]) prev.deactivate?.();
    this.active = id;
    $$('#mission-tabs [role="tab"]').forEach((t) => {
      const on = t.dataset.mission === id;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    $$('.mission-pane').forEach((p) => { p.hidden = p.id !== `pane-${id}`; });
    const m = this.missions[id];
    m.activate?.();
    this.renderHud();
    if (brief && !m.started && m.briefing) this.brief(m);
  }

  brief(m) {
    const b = m.briefing;
    $('#briefing-title').textContent = b.title;
    $('#briefing-goal').textContent = b.goal;
    $('#briefing-config').replaceChildren(...b.configure.map((t) => el('li', { text: t })));
    $('#briefing-safety').replaceChildren(...b.safety.map((t) => el('li', { text: t })));
    $('#briefing').showModal();
  }

  /** "Why did this happen?" panel; pulses the related hotspot. */
  why({ title, body, hotspot }) {
    $('#why-title').textContent = title;
    $('#why-body').textContent = body;
    $('#why-show').hidden = !hotspot;
    this.whyHotspot = hotspot ?? null;
    this.hotspots.pulse(hotspot ?? null);
    $('#why-panel').hidden = false;
  }

  closeWhy() {
    $('#why-panel').hidden = true;
    this.hotspots.pulse(null);
  }

  renderHud() {
    const m = this.missions?.[this.active];
    if (!m) return;   // still constructing
    const steps = m.progress?.() ?? [];
    $('#hud-progress').replaceChildren(...steps.map((s, i) => el('li', { class: s.done ? 'done' : s.current ? 'current' : '', title: s.label },
      el('span', { class: 'sr-only', text: `Step ${i + 1}: ${s.label}, ${s.done ? 'done' : s.current ? 'current' : 'to do'}` }))));
    $('#hud-step').textContent = steps.find((s) => s.current)?.label ?? (steps.length && steps.every((s) => s.done) ? 'Complete' : '');
    // plain-language "next step" with a Show me button that points at the control
    const cur = steps.find((s) => s.current);
    const allDone = steps.length > 0 && steps.every((s) => s.done);
    const hint = cur?.hint ?? (allDone ? m.doneHint : null);
    const target = cur?.hint ? cur.target : m.doneTarget;
    $('#hud-next').hidden = !hint;
    if (hint && $('#hud-hint').textContent !== hint) $('#hud-hint').textContent = hint;
    this.showTarget = target ?? null;
    $('#hud-showme').hidden = !target;
    const sc = m.score?.();
    $('#hud-score').textContent = sc ? `${Math.round(sc.total)}` : '–';
    $('#hud-score').title = sc ? sc.parts.map((p) => `${p[0]}: ${Math.round(p[1])}`).join('\n') : '';
    const badges = Object.values(this.missions).flatMap((x) => x.badges ?? []);
    $('#hud-badges').replaceChildren(...[...new Set(badges)].map((b) => el('span', { class: 'badge-pill', text: b })));
  }

  /** Scroll to the control the current step needs and flash it. */
  showMe() {
    const t = this.showTarget && document.querySelector(this.showTarget);
    if (!t) return;
    t.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    t.classList.remove('flash-target');
    void t.offsetWidth;
    t.classList.add('flash-target');
    const focusable = t.matches('button, input, select') ? t : t.querySelector('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
    focusable?.focus({ preventScroll: true });
  }

  awardBadge(m, name) {
    if (m.badges.includes(name)) return;
    m.badges.push(name);
    toast(`Badge earned: ${name}`, 'good');
    this.renderHud();
  }

  update(dt) {
    for (const m of Object.values(this.missions)) m.tick?.(dt, m === this.missions[this.active]);
    const now = performance.now();
    if (now - (this._hudT ?? 0) > 400) { this._hudT = now; this.renderHud(); }
    const m = this.missions[this.active];
    $('#hud-timer').textContent = m.started && !m.finished ? sec((performance.now() - m.t0) / 1000) : m.finished ? sec(m.elapsed) : '0:00';
  }

  /** Physical tool for the current Mission 1 preset (ground truth). */
  physicalTool() {
    const s = this.state.m1;
    const presets = this.cfg.toolPresets;
    const p = presets[s.preset === 'custom' ? presets.custom.physical : s.preset];
    return { mass: p.mass, com_mm: p.com_mm, mountingDeg: 0 };
  }

  /** Tool the user configured in Mission 1. */
  configuredTool() {
    const s = this.state.m1;
    return { mass: s.mass, com_mm: s.com_mm, mountingDeg: s.mountingDeg };
  }

  specimenSeated() {
    if (!this.state.m1 || !['gripper_specimen', 'custom'].includes(this.state.m1.preset)) return false;
    if (this.missions.m3?.toolStatus === 'removed') return false;
    const p = this.robot.tcp.getWorldPosition(new THREE.Vector3());
    return p.y < POT_TOP_Y + 0.01 && Math.hypot(p.x - FIXTURE.x, p.z - FIXTURE.z) < 0.04;
  }
}

class MissionBase {
  constructor(mc, id) {
    this.mc = mc;
    this.id = id;
    this.pane = $(`#pane-${id}`);
    this.badges = [];
    this.started = false;
    this.finished = false;
    this.hintsUsed = 0;
  }

  begin() {
    this.started = true;
    this.t0 = performance.now();
    this.mc.renderHud();
  }

  finish() {
    this.finished = true;
    this.elapsed = (performance.now() - this.t0) / 1000;
    this.mc.renderHud();
  }

  hint(text) {
    if (this.mc.expert) return null;
    return el('p', { class: 'hint-box', text });
  }

  section(title, ...children) {
    return el('section', { class: 'm-step' }, el('h3', { text: title }), ...children);
  }

  /** Give each step box an id (m1-s1, m1-s2, …) so the Next-step guide can point at it. */
  idSteps() {
    $$('.m-step', this.pane).forEach((sec, i) => { sec.id = `${this.id}-s${i + 1}`; });
  }
}

// ============================================================== Mission 1
class Mission1 extends MissionBase {
  constructor(mc) {
    super(mc, 'm1');
    const d = mc.cfg.mission1.defaults;
    const preset = mc.cfg.toolPresets[d.preset];
    mc.state.m1 = {
      preset: d.preset, mass: preset.mass, com_mm: [...preset.com_mm], mountingDeg: d.mountingDeg,
      mode: d.mode, overridePct: d.overridePct, forceLimitN: d.forceLimitN, torqueLimitNm: d.torqueLimitNm,
      tcpSpeedLimitMmS: d.tcpSpeedLimitMmS, box: structuredClone(mc.cfg.mission1.workspaceBox), locked: false,
      ...(mc.state.m1 ?? {}),
    };
    this.s = mc.state.m1;
    this.failedLocks = 0;
    this.briefing = {
      title: 'Mission 1: Commission the cell',
      goal: 'Describe the tool on the robot, choose how the robot may move, and set protective limits, then confirm and lock the configuration. Missions 2 and 3 use what you set here.',
      configure: ['Tool preset, or a custom mass, centre of mass and sensor mounting rotation', 'Operating mode and speed override', 'A workspace box around the fixture', 'Force, torque and TCP-speed limits'],
      safety: ['Commission in manual reduced speed (T1) at a low override.', 'Every limit must be physically meaningful: no zero or out-of-range values.', 'Each safety acknowledgement is ticked on its own, deliberately.'],
    };
    this.doneHint = 'Mission 1 complete. Open the “2 · Calibrate” tab.';
    this.doneTarget = '[data-mission="m2"]';
    this._buildMarker();
    this._buildBox();
    this._build();
    this.idSteps();
    this.apply();
  }

  // ---------------------------------------------------------- 3D helpers
  _buildMarker() {
    this.frame = new THREE.Object3D();
    this.frame.name = 'Sensor_Frame_Configured';
    this.mc.robot.sensor.add(this.frame);
    this.marker = new THREE.Mesh(new THREE.SphereGeometry(0.018, 20, 14), new THREE.MeshBasicMaterial({ color: 0x1a8cff, depthTest: false, transparent: true }));
    this.marker.renderOrder = 997;
    this.marker.name = 'CoM_Marker';
    this.marker.userData.noPick = true;
    const tag = new CSS2DObject(el('span', { class: 'tag', text: 'CoM' }));
    tag.position.set(0, 0.035, 0);
    this.marker.add(tag);
    this.frame.add(this.marker);
    // sensor-frame axes for orientation
    const axes = new THREE.AxesHelper(0.08);
    axes.material.depthTest = false;
    axes.renderOrder = 996;
    this.frame.add(axes);
    this.frame.visible = false;
  }

  _buildBox() {
    this.boxGroup = new THREE.Group();
    this.boxGroup.name = 'Workspace_Box';
    this.boxLines = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x1a8cff }));
    this.boxFill = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x1a8cff, transparent: true, opacity: 0.05, depthWrite: false }));
    this.boxFill.userData.noPick = true;
    this.boxGroup.add(this.boxLines, this.boxFill);
    this.handles = [];
    const faces = [['x', 'min'], ['x', 'max'], ['y', 'min'], ['y', 'max'], ['z', 'min'], ['z', 'max']];
    for (const [axis, side] of faces) {
      const h = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), new THREE.MeshBasicMaterial({ color: 0x1a8cff }));
      h.userData = { axis, side, boxHandle: true };
      h.name = `Box_Handle_${axis}_${side}`;
      this.boxGroup.add(h);
      this.handles.push(h);
    }
    this.boxGroup.userData.pickable = true;
    this.boxGroup.visible = false;
    this.mc.scene.scene.add(this.boxGroup);
    this.mc.scene.pickHandlers.push((hits) => {
      if (!this.boxGroup.visible) return false;
      const h = hits.find((x) => x.object.userData.boxHandle);
      if (!h) return false;
      this.selectHandle(h.object);
      return true;
    });
  }

  updateBox() {
    const { min, max } = this.s.box;
    const size = new THREE.Vector3(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    const c = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    for (const o of [this.boxLines, this.boxFill]) { o.position.copy(c); o.scale.copy(size).max(new THREE.Vector3(0.01, 0.01, 0.01)); }
    const idx = { x: 0, y: 1, z: 2 };
    for (const h of this.handles) {
      if (h === this.dragHandle) continue;
      h.position.copy(c);
      h.position.setComponent(idx[h.userData.axis], (h.userData.side === 'min' ? min : max)[idx[h.userData.axis]]);
    }
    this.mc.scene.requestRender();
  }

  selectHandle(h) {
    const g = this.mc.gizmo;
    g.attach(h);
    g.showX = h.userData.axis === 'x';
    g.showY = h.userData.axis === 'y';
    g.showZ = h.userData.axis === 'z';
    this.dragHandle = h;
    this.mc.gizmoCb = () => {
      const idx = { x: 0, y: 1, z: 2 }[h.userData.axis];
      const v = +h.position.getComponent(idx).toFixed(3);
      const b = this.s.box;
      if (h.userData.side === 'min') b.min[idx] = Math.min(v, b.max[idx] - 0.05);
      else b.max[idx] = Math.max(v, b.min[idx] + 0.05);
      this.updateBox();
      this.refreshChecks();
      this.mc.saveState();
    };
  }

  selectMarker() {
    const g = this.mc.gizmo;
    g.attach(this.marker);
    g.showX = g.showY = g.showZ = true;
    this.dragHandle = null;
    this.mc.gizmoCb = () => {
      if (this.s.locked) return;
      if (this.s.preset !== 'custom') this.setPreset('custom', { keepValues: true });
      this.s.com_mm = this.marker.position.toArray().map((v) => Math.round(v * 1000));
      this.syncFields();
      this.refreshChecks();
      this.mc.saveState();
    };
  }

  // ---------------------------------------------------------- UI
  _build() {
    const c = this.mc.cfg;
    const presetRadios = Object.entries(c.toolPresets).filter(([k]) => !k.startsWith('_')).map(([k, p]) => el('label', { class: 'radio' },
      el('input', { type: 'radio', name: 'm1-preset', value: k, onchange: () => this.setPreset(k) }), el('span', { text: p.label })));
    const num = (id, label, unit, attrs = {}) => el('label', { class: 'field' }, el('span', { text: label }),
      el('input', { id, type: 'number', step: 'any', ...attrs, oninput: () => this.readFields() }), el('small', { text: unit }));
    this.pane.append(
      el('p', { class: 'mission-intro', text: 'Configure the cell before anything moves. Every change updates the 3D scene and the checks below.' }),
      this.section('1 · Tool setup',
        el('div', { class: 'radio-row', role: 'radiogroup', 'aria-label': 'Tool preset' }, presetRadios),
        el('div', { class: 'field-grid' },
          num('m1-mass', 'Tool mass', 'kg', { min: 0 }),
          num('m1-cx', 'CoM X', 'mm'), num('m1-cy', 'CoM Y', 'mm'), num('m1-cz', 'CoM Z', 'mm'),
          el('label', { class: 'field' }, el('span', { text: 'Sensor mounting' }),
            el('select', { id: 'm1-mount', onchange: () => this.readFields() }, ...[0, 90, 180, 270].map((d) => el('option', { value: d, text: `${d}° about A6` }))))),
        el('button', { class: 'btn small', type: 'button', id: 'm1-drag', text: 'Drag the CoM marker in 3D', onclick: () => this.selectMarker() }),
        this.hint('The blue CoM marker sits in the sensor frame (Z points along the tool). Drag it, or type values; they stay in sync. Custom values describe what you believe is mounted; Mission 2 measures what really is.')),
      this.section('2 · Operating mode',
        el('div', { class: 'radio-row', role: 'radiogroup', 'aria-label': 'Operating mode' },
          el('label', { class: 'radio' }, el('input', { type: 'radio', name: 'm1-mode', value: 'T1', onchange: () => this.readFields() }), el('span', { text: 'Manual reduced speed (T1)' })),
          el('label', { class: 'radio' }, el('input', { type: 'radio', name: 'm1-mode', value: 'AUT', onchange: () => this.readFields() }), el('span', { text: 'Automatic' }))),
        el('label', { class: 'range-row' }, el('span', {}, 'Speed override ', el('output', { id: 'm1-ovr-out' })),
          el('input', { id: 'm1-ovr', type: 'range', min: 1, max: 100, step: 1, oninput: () => this.readFields() }))),
      this.section('3 · Workspace boundary',
        el('p', { class: 'small', text: 'The blue box is the region the tool may enter. Click a handle on the box in the 3D view, then drag its arrow.' }),
        el('p', { class: 'mono small', id: 'm1-box-readout' }),
        el('button', { class: 'btn small', type: 'button', text: 'Reset box', onclick: () => { this.s.box = structuredClone(this.mc.cfg.mission1.workspaceBox); this.updateBox(); this.refreshChecks(); } })),
      this.section('4 · Protective limits',
        el('div', { class: 'field-grid' },
          num('m1-flim', 'Force limit', 'N'), num('m1-tlim', 'Torque limit', 'N·m'), num('m1-vlim', 'Max TCP speed', 'mm/s'))),
      this.section('5 · Configuration check', el('ul', { class: 'tl-list', id: 'm1-checks' })),
      this.section('6 · Confirm and lock',
        el('fieldset', { class: 'checklist', id: 'm1-acks' }, el('legend', { class: 'sr-only', text: 'Safety acknowledgements' }),
          ...['I have checked the tool data against what is physically mounted.',
            'I understand the robot will only move in the selected mode and override.',
            'The workspace box keeps the tool away from people and equipment outside the cell.',
            'The protective limits are set above normal working loads and below damage limits.']
            .map((t, i) => el('label', {}, el('input', { type: 'checkbox', 'data-ack': i, onchange: () => this.refreshLock() }), el('span', { text: t })))),
        el('button', { class: 'btn primary', type: 'button', id: 'm1-lock', text: 'Confirm and lock configuration', onclick: () => this.lock() }),
        el('button', { class: 'btn ghost small', type: 'button', id: 'm1-unlock', text: 'Unlock to edit', hidden: true, onclick: () => this.unlock() }),
        el('div', { class: 'result', id: 'm1-result' })),
    );
  }

  setPreset(key, { keepValues = false } = {}) {
    this.s.preset = key;
    const p = this.mc.cfg.toolPresets[key];
    if (!keepValues && key !== 'custom') { this.s.mass = p.mass; this.s.com_mm = [...p.com_mm]; }
    for (const [part, on] of Object.entries(p.show)) this.mc.inspector.setPartVisible(part, on);
    this.apply();
  }

  readFields() {
    if (this.s.locked) return;
    const n = (id) => Number($(id).value);
    if (this.s.preset === 'custom') {
      this.s.mass = n('#m1-mass');
      this.s.com_mm = [n('#m1-cx'), n('#m1-cy'), n('#m1-cz')];
    }
    this.s.mountingDeg = n('#m1-mount');
    this.s.mode = $('input[name="m1-mode"]:checked')?.value ?? 'T1';
    this.s.overridePct = n('#m1-ovr');
    this.s.forceLimitN = n('#m1-flim');
    this.s.torqueLimitNm = n('#m1-tlim');
    this.s.tcpSpeedLimitMmS = n('#m1-vlim');
    this.apply({ fromFields: true });
  }

  syncFields() {
    const s = this.s;
    $$('input[name="m1-preset"]').forEach((r) => { r.checked = r.value === s.preset; });
    const custom = s.preset === 'custom';
    for (const [id, v] of [['#m1-mass', s.mass], ['#m1-cx', s.com_mm[0]], ['#m1-cy', s.com_mm[1]], ['#m1-cz', s.com_mm[2]]]) {
      const i = $(id);
      if (document.activeElement !== i) i.value = String(v);
      i.disabled = !custom || s.locked;
    }
    $('#m1-mount').value = String(s.mountingDeg);
    $$('input[name="m1-mode"]').forEach((r) => { r.checked = r.value === s.mode; });
    $('#m1-ovr').value = String(s.overridePct);
    $('#m1-ovr-out').textContent = `${s.overridePct}%`;
    for (const [id, v] of [['#m1-flim', s.forceLimitN], ['#m1-tlim', s.torqueLimitNm], ['#m1-vlim', s.tcpSpeedLimitMmS]]) {
      if (document.activeElement !== $(id)) $(id).value = String(v);
    }
    this.pane.querySelectorAll('input, select').forEach((i) => {
      if (!i.matches('[data-ack]') && !i.matches('#m1-mass, #m1-cx, #m1-cy, #m1-cz')) i.disabled = s.locked;
    });
    const b = s.box;
    $('#m1-box-readout').textContent = `x ${b.min[0].toFixed(2)} … ${b.max[0].toFixed(2)} · y ${b.min[1].toFixed(2)} … ${b.max[1].toFixed(2)} · z ${b.min[2].toFixed(2)} … ${b.max[2].toFixed(2)} m`;
  }

  apply({ fromFields = false } = {}) {
    const s = this.s;
    this.frame.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), s.mountingDeg * DEG));
    this.marker.position.fromArray(s.com_mm.map((v) => v / 1000));
    this.marker.visible = s.mass > 0;
    const p = this.mc.cfg.toolPresets[s.preset];
    for (const [part, on] of Object.entries(p.show)) this.mc.inspector.setPartVisible(part, on);
    this.mc.sensor.setTool(this.mc.physicalTool());
    if (!fromFields) this.syncFields();
    else $('#m1-ovr-out').textContent = `${s.overridePct}%`;
    this.updateBox();
    this.refreshChecks();
    this.mc.saveState();
  }

  /** Traffic-light checks with explanations. */
  checks() {
    const s = this.s;
    const sc = this.mc.cfg.sensor;
    const out = [];
    const add = (id, label, state, detail, why, hotspot) => out.push({ id, label, state, detail, why: why ? { title: label, body: why, hotspot } : null });
    const weight = s.mass * 9.81;
    const moment = weight * Math.hypot(...s.com_mm) / 1000;
    if (s.mass < 0 || !Number.isFinite(s.mass)) add('mass', 'Tool mass', 'red', 'Mass must be zero or positive.', 'A negative or missing mass makes gravity compensation meaningless.', 'HS_Gripper');
    else if (s.mass > sc.maxToolMassKg || weight > sc.rangeN[2] * 0.5 || moment > sc.rangeNm[0] * 0.5) add('mass', 'Tool mass vs sensor range', 'red', `${s.mass} kg gives ${weight.toFixed(0)} N and ${moment.toFixed(1)} N·m static load.`, `The tool's own weight would use more than half the sensor's measuring range (illustrative ${sc.rangeN[2]} N, ${sc.rangeNm[0]} N·m, max ${sc.maxToolMassKg} kg), leaving too little for the test loads and risking overload.`, 'HS_FT_Sensor');
    else if (s.mass === 0 && s.preset !== 'empty') add('mass', 'Tool mass', 'amber', 'Mass is 0 kg but a tool is fitted.', 'With 0 kg the controller will not compensate the tool weight, so every orientation change shows up as a false force.', 'HS_Gripper');
    else add('mass', 'Tool mass', 'green', `${s.mass} kg (${weight.toFixed(1)} N static).`);
    const comLen = Math.hypot(...s.com_mm);
    if (comLen > 300) add('com', 'Centre of mass', 'amber', `${comLen.toFixed(0)} mm from the sensor.`, 'A centre of mass this far from the sensor gives large moments and is unusual for a compact tool. Check the units are mm.', 'HS_FT_Sensor');
    else add('com', 'Centre of mass', 'green', `[${s.com_mm.join(', ')}] mm`);
    if (s.mountingDeg !== 0) add('mount', 'Sensor mounting rotation', 'amber', `${s.mountingDeg}° about A6.`, 'Non-zero mounting rotations are valid, but they must match how the sensor is physically pinned to the adapter plate. If they do not, forces are reported in the wrong axes. Mission 2 will reveal a mismatch.', 'HS_Adapter_Plate');
    else add('mount', 'Sensor mounting rotation', 'green', '0° (matches the adapter dowel).');
    if (s.mode === 'AUT' && s.overridePct >= 100) add('mode', 'Operating mode', 'red', 'Automatic at 100% is blocked during commissioning.', 'An unverified program must never run at full automatic speed. Commission in T1 (manual reduced speed), where a person holds an enabling device and speed is limited.', 'HS_Controller');
    else if (s.mode === 'AUT') add('mode', 'Operating mode', 'amber', `Automatic at ${s.overridePct}%.`, 'Commissioning is normally done in T1 so the operator controls every movement. Automatic is allowed here but scored down.', 'HS_Controller');
    else if (s.overridePct > 25) add('mode', 'Speed override', 'amber', `T1 at ${s.overridePct}%.`, 'Start a new cell at a low override (around 10%) and raise it only after a clean pass.', 'HS_Controller');
    else add('mode', 'Operating mode', 'green', `T1 at ${s.overridePct}%.`);
    const fl = s.forceLimitN;
    if (!(fl > 0)) add('flim', 'Force limit', 'red', 'Zero or negative limit is invalid.', 'A protective force limit of zero would stop the robot immediately (or, in a badly written controller, disable the check). It must be a positive value above working loads.', 'HS_FT_Sensor');
    else if (fl > Math.max(...sc.rangeN)) add('flim', 'Force limit', 'red', `${fl} N is above the sensor range.`, 'A limit the sensor cannot measure is never reached; the protection would not work.', 'HS_FT_Sensor');
    else if (fl < 20) add('flim', 'Force limit', 'amber', `${fl} N is very tight.`, 'Noise, acceleration and small residual errors would trip a limit this low during normal motion.', 'HS_FT_Sensor');
    else add('flim', 'Force limit', 'green', `${fl} N`);
    const tl = s.torqueLimitNm;
    if (!(tl > 0)) add('tlim', 'Torque limit', 'red', 'Zero or negative limit is invalid.', 'As for force: the moment limit must be a positive, measurable value.', 'HS_FT_Sensor');
    else if (tl > Math.max(...sc.rangeNm)) add('tlim', 'Torque limit', 'red', `${tl} N·m is above the sensor range.`, 'A limit beyond the measuring range would never trip.', 'HS_FT_Sensor');
    else if (tl < 2) add('tlim', 'Torque limit', 'amber', `${tl} N·m is very tight.`, 'Small CoM errors alone produce moments of this size.', 'HS_FT_Sensor');
    else add('tlim', 'Torque limit', 'green', `${tl} N·m`);
    const vl = s.tcpSpeedLimitMmS;
    const cap = this.mc.cfg.mission1.reducedSpeedCapMmS;
    if (!(vl > 0)) add('vlim', 'Max TCP speed', 'red', 'Zero or negative limit is invalid.', 'The robot could not move at all, or the check would be ignored.', 'HS_A6_Flange');
    else if (s.mode === 'T1' && vl > cap) add('vlim', 'Max TCP speed', 'red', `${vl} mm/s exceeds the T1 cap of ${cap} mm/s.`, `In manual reduced speed the tool centre point is limited to ${cap} mm/s (a common reduced-speed value). A higher limit contradicts the selected mode.`, 'HS_A6_Flange');
    else add('vlim', 'Max TCP speed', 'green', `${vl} mm/s`);
    const b = s.box;
    const fixtureBox = new THREE.Box3().setFromObject(this.mc.inspector.nodes.get('Fixture_Baseplate'));
    const box = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
    const vol = box.getSize(new THREE.Vector3()).toArray().reduce((a, v) => a * v, 1);
    if (!box.containsBox(fixtureBox)) add('box', 'Workspace box', 'red', 'Does not contain the fixture.', 'The tool must reach the specimen on the fixture. A boundary that cuts through the fixture would stop every useful move, or (if you widen it carelessly) hide a real collision risk.', 'HS_Fixture');
    else if (vol > 3) add('box', 'Workspace box', 'amber', `${vol.toFixed(1)} m³ is very large.`, 'A boundary much larger than the task gives little protection. Keep it tight around the fixture and approach path.', 'HS_Fixture');
    else add('box', 'Workspace box', 'green', `${vol.toFixed(2)} m³, contains the fixture.`);
    return out;
  }

  refreshChecks() {
    const checks = this.checks();
    this.lastChecks = checks;
    renderChecks($('#m1-checks'), checks, { onWhy: (c) => this.mc.why(c.why) });
    this.refreshLock();
    this.mc.renderHud();
  }

  refreshLock() {
    const acks = $$('[data-ack]', this.pane);
    $('#m1-lock').disabled = this.s.locked || !acks.every((a) => a.checked);
    $('#m1-lock').hidden = this.s.locked;
    $('#m1-unlock').hidden = !this.s.locked;
    acks.forEach((a) => { a.disabled = this.s.locked; });
  }

  lock() {
    if (!this.started) this.begin();
    const red = this.lastChecks.filter((c) => c.state === 'red');
    if (red.length) {
      this.failedLocks++;
      $('#m1-result').textContent = `Cannot lock: ${red.length} red check(s). ${red.map((c) => c.label).join(', ')}.`;
      $('#m1-result').className = 'result fail';
      this.mc.why(red[0].why);
      this.mc.renderHud();
      return;
    }
    this.s.locked = true;
    this.mc.gizmo.detach();
    this.lockedChecks = this.lastChecks;
    this.finish();
    const sc = this.score();
    $('#m1-result').textContent = `Configuration locked. Score ${Math.round(sc.total)}/100. Missions 2 and 3 are unlocked.`;
    $('#m1-result').className = 'result pass';
    this.syncFields();
    this.refreshLock();
    this.mc.refreshLocks();
    this.mc.saveState();
    toast('Configuration locked: Missions 2 and 3 unlocked.', 'good');
  }

  unlock() {
    this.s.locked = false;
    this.finished = false;
    this.syncFields();
    this.refreshLock();
    this.mc.refreshLocks();
    this.mc.saveState();
  }

  /** 100 − 5 per amber check at lock − 10 per failed lock attempt − hint penalty. */
  score() {
    if (!this.started) return null;
    const checks = this.lockedChecks ?? this.lastChecks ?? [];
    const amber = checks.filter((c) => c.state === 'amber').length;
    const parts = [['Base', 100], ['Amber checks', -5 * amber], ['Failed lock attempts', -10 * this.failedLocks]];
    return { total: clamp(parts.reduce((a, p) => a + p[1], 0), 0, 100), parts };
  }

  progress() {
    const s = this.s;
    const checks = this.lastChecks ?? [];
    // a step is done when none of its checks is red (amber is allowed, as for locking)
    const ok = (ids) => checks.length > 0 && ids.every((id) => checks.find((c) => c.id === id)?.state !== 'red');
    return [
      { label: 'Tool setup', done: ok(['mass', 'com', 'mount']), target: '#m1-s1', hint: 'In “1 · Tool setup”, choose the tool fitted to the robot. “Gripper + specimen” matches what you can see in the 3D view.' },
      { label: 'Mode & speed', done: ok(['mode']), target: '#m1-s2', hint: 'Choose “Manual reduced speed (T1)” and set the speed override to about 10%.' },
      { label: 'Workspace box', done: ok(['box']), target: '#m1-s3', hint: 'The blue box must contain the fixture. Click “Reset box” to put it back.' },
      { label: 'Protective limits', done: ok(['flim', 'tlim', 'vlim']), target: '#m1-s4', hint: 'A limit is red: none can be 0. Safe values: force 150 N, torque 20 N·m, speed 250 mm/s.' },
      { label: 'Confirm & lock', done: s.locked, target: '#m1-s6', hint: 'Read each statement and tick all four boxes, then click “Confirm and lock configuration”.' },
    ].map((x, i, arr) => ({ ...x, current: !x.done && arr.slice(0, i).every((y) => y.done) }));
  }

  activate() {
    this.frame.visible = true;
    this.boxGroup.visible = true;
    this.mc.hotspots.pulse('HS_FT_Sensor');
    this.refreshChecks();
  }

  deactivate() {
    this.frame.visible = false;
    this.boxGroup.visible = false;
    this.mc.gizmo.detach();
    this.mc.hotspots.pulse(null);
  }

  begin() {
    super.begin();
    this.mc.scene.flyTo(new THREE.Vector3(1.2, 1.5, -2.0), new THREE.Vector3(-0.35, 0.75, -0.6));
  }
}

// ============================================================== jog panel (shared)
class JogPanel {
  constructor(mc, container, { onChange } = {}) {
    this.mc = mc;
    this.onChange = onChange;
    this.sliders = {};
    const robot = mc.robot;
    const rows = robot.joints.map((j) => {
      const out = el('output', { text: '' });
      const input = el('input', {
        type: 'range', min: j.min, max: j.max, step: 0.1, 'aria-label': `${j.id} angle`,
        oninput: () => this.jog(j.id, Number(input.value)),
      });
      const minus = el('button', { class: 'btn small', type: 'button', 'aria-label': `${j.id} minus 1 degree`, text: '−', onclick: () => this.jog(j.id, robot.angles[j.id] - 1) });
      const plus = el('button', { class: 'btn small', type: 'button', 'aria-label': `${j.id} plus 1 degree`, text: '+', onclick: () => this.jog(j.id, robot.angles[j.id] + 1) });
      this.sliders[j.id] = { input, out, row: null };
      const row = el('div', { class: 'jog-row' }, el('span', { class: 'jog-id', text: j.id }), minus, input, plus, out);
      this.sliders[j.id].row = row;
      return row;
    });
    container.append(el('div', { class: 'jog' }, rows),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn small', type: 'button', text: 'Tool down', onclick: () => this.toolDown() }),
        el('button', { class: 'btn small jog-up', type: 'button', text: 'Up 10 cm', onclick: () => this.moveTcp(new THREE.Vector3(0, 0.1, 0)) }),
        el('button', { class: 'btn small', type: 'button', text: 'Down 2 cm', onclick: () => this.moveTcp(new THREE.Vector3(0, -0.02, 0)) })));
    robot.onChange(() => this.sync());
    this.sync();
  }

  jog(id, value) {
    if (this.disabled) return;
    const hit = this.mc.robot.setAngles({ ...this.mc.robot.angles, [id]: value });
    if (hit.length) this.bump(hit);
    this.mc.scene.requestRender();
    this.onChange?.();
  }

  bump(ids) {
    for (const id of ids) {
      const r = this.sliders[id].row;
      r.classList.remove('bump');
      void r.offsetWidth;
      r.classList.add('bump');
      this.mc.inspector.flash(JOINT_SECTION[id]);
    }
    toast(`${ids.join(', ')} at its limit (illustrative).`, 'bad', 1800);
  }

  toolDown() {
    const r = this.mc.robot;
    const sol = r.ik(r.tcpPose().pos, new THREE.Vector3(0, -1, 0), r.angles);
    r.setAngles(sol.angles);
    if (sol.limited.length) this.bump(sol.limited);
    this.onChange?.();
  }

  moveTcp(delta) {
    const r = this.mc.robot;
    const p = r.tcpPose();
    const sol = r.ik(p.pos.clone().add(delta), p.dir, r.angles);
    if (sol.status === 'unreachable') { toast('That move is out of reach.', 'bad'); return; }
    r.setAngles(sol.angles);
    if (sol.limited.length) this.bump(sol.limited);
    this.onChange?.();
  }

  sync() {
    const a = this.mc.robot.angles;
    for (const [id, s] of Object.entries(this.sliders)) {
      if (document.activeElement !== s.input) s.input.value = String(a[id]);
      s.out.textContent = `${a[id].toFixed(1)}°`;
    }
  }

  setDisabled(d) {
    this.disabled = d;
    for (const s of Object.values(this.sliders)) s.input.disabled = d;
  }
}

// ============================================================== Mission 2
class Mission2 extends MissionBase {
  constructor(mc) {
    super(mc, 'm2');
    this.briefing = {
      title: 'Mission 2: Zero and calibrate the F/T sensor',
      goal: 'Make the force/torque sensor read only external loads: remove its offset, then measure the tool\'s mass and centre of mass from several poses so gravity can be compensated in any orientation.',
      configure: ['Jog the robot (sliders, Tool down)', 'Diagnose why readings are not zero', 'Hold to zero; capture 3–6 calibration poses', 'Solve, compare with Mission 1, then torture-test'],
      safety: ['Nothing may touch the tool while zeroing or capturing: withdraw the specimen first.', 'Keep the arm still while samples are averaged.', 'Simulated loads only; the robot is not connected to hardware.'],
    };
    this.doneHint = 'Mission 2 complete. Open the “3 · Dry run” tab.';
    this.doneTarget = '[data-mission="m3"]';
    this.reset();
    this._build();
    this.idSteps();
  }

  reset() {
    this.diagnosed = false;
    this.diagnoseTries = 0;
    this.zeroAttempts = 0;
    this.zeroRuined = 0;
    this.bias = null;
    this.zeroedWithContact = false;
    this.poses = [];
    this.fit = null;
    this.model = null;
    this.torture = null;
    this.fault = null;
    this.faultFixed = false;
    this.hold = null;
    this.forceOn = false;
  }

  _build() {
    const sc = this.mc.cfg.sensor;
    this.pane.append(
      el('p', { class: 'mission-intro', text: 'The sensor is live. Jog the arm and watch how the readings follow its orientation.' }),
      el('div', { class: 'readout' },
        el('div', { class: 'readout-head' }, el('span', { text: 'Sensor readings' }), el('span', { class: 'badge', id: 'm2-mode', text: 'raw' })),
        el('div', { class: 'gauges', id: 'm2-gauges' }),
        el('canvas', { class: 'chart', id: 'm2-chart', height: 140, 'aria-label': 'Rolling chart of the six sensor channels' }),
        el('div', { class: 'chart-legend', id: 'm2-legend' }),
        el('p', { class: 'small', id: 'm2-contact', hidden: true, text: '⚠ The specimen is seated in the fixture: contact forces are included.' })),
      this.section('1 · Jog the robot', el('div', { id: 'm2-jog' }),
        this.mc.expert ? null : el('p', { class: 'hint-box', text: 'The specimen starts seated in the fixture. Use "Up 10 cm" to withdraw it before zeroing.' })),
      this.section('2 · Diagnose',
        el('p', { text: 'Nothing is pushing on the tool, yet the readings are not zero. Which causes contribute right now? Select all that apply.' }),
        el('fieldset', { class: 'checklist', id: 'm2-diag' }, el('legend', { class: 'sr-only', text: 'Causes' }),
          ...[['gravity', 'The weight of the tool below the sensor'], ['bias', 'A constant sensor offset (bias)'], ['drift', 'Temperature drift'], ['contact', 'Contact with the fixture']]
            .map(([k, t]) => el('label', {}, el('input', { type: 'checkbox', value: k }), el('span', { text: t })))),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn small', type: 'button', text: 'Check my answer', onclick: () => this.diagnose() }),
          el('button', { class: 'btn ghost small guided-only', type: 'button', id: 'm2-reveal', text: 'Show answer', hidden: true, onclick: () => this.revealDiagnosis() })),
        el('div', { class: 'result', id: 'm2-diag-result' })),
      this.section('3 · Hold to zero',
        el('p', { text: `Hold the button while ${sc.zeroSamples} samples (${(sc.zeroSamples / sc.rateHz).toFixed(1)} s) are averaged. Releasing early or moving the arm ruins the sample.` }),
        el('button', { class: 'btn hold', type: 'button', id: 'm2-zero', disabled: true }, ringSVG(), el('span', { text: 'Hold to zero' })),
        el('p', { class: 'small', id: 'm2-zero-note', hidden: true, text: 'Zeroing is off while the specimen is in the fixture: click “Up 10 cm” first.' }),
        el('div', { class: 'result', id: 'm2-bias' })),
      this.section('4 · Capture calibration poses',
        el('p', { text: 'Jog to different orientations and capture 3–6 poses. Tilts in different directions are needed to separate mass from centre of mass.' }),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn', type: 'button', id: 'm2-capture', text: 'Capture pose', disabled: true, onclick: () => this.capture() }),
          el('button', { class: 'btn small guided-only', type: 'button', id: 'm2-example', text: 'Move to suggested pose 1', onclick: () => this.suggestedPose() })),
        el('div', { class: 'meter', 'aria-label': 'Pose diversity' }, el('span', { class: 'meter-fill', id: 'm2-div' })),
        el('p', { class: 'small', id: 'm2-div-text', text: 'Pose diversity: capture poses to measure it.' }),
        el('ol', { class: 'pose-list', id: 'm2-poses' })),
      this.section('5 · Solve',
        el('button', { class: 'btn primary', type: 'button', id: 'm2-solve', text: 'Solve least squares', disabled: true, onclick: () => this.solve() }),
        el('div', { class: 'result', id: 'm2-fit' }),
        el('div', { class: 'btn-row', id: 'm2-accept', hidden: true },
          el('button', { class: 'btn small', type: 'button', text: 'Accept estimate', onclick: () => this.useModel('estimate') }),
          el('button', { class: 'btn small', type: 'button', text: 'Use Mission 1 values', onclick: () => this.useModel('mission1') }))),
      this.section('6 · Torture test',
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn small', type: 'button', id: 'm2-load', 'aria-pressed': 'false', text: 'Apply simulated load', disabled: true, onclick: () => this.toggleForce() }),
          el('button', { class: 'btn small', type: 'button', id: 'm2-wiggle', text: 'Wiggle the cable', disabled: true, onclick: () => this.wiggle() })),
        this.hint('Drag the arrow handle in 3D to change the load direction and size (10 N per 10 cm).'),
        el('div', { class: 'expert-only', id: 'm2-fault-box' },
          el('p', { text: 'Expert: something is wrong with this sensor setup. Identify the fault from the plots and fix it.' }),
          el('select', { id: 'm2-fault-pick', 'aria-label': 'Fault' }, el('option', { value: '', text: 'Choose a fault…' }),
            el('option', { value: 'thermal', text: 'Thermal drift (readings creep)' }), el('option', { value: 'looseCable', text: 'Loose cable (spikes)' }),
            el('option', { value: 'wrongMount', text: 'Wrong mounting rotation' })),
          el('button', { class: 'btn small', type: 'button', text: 'Fix it', onclick: () => this.fixFault() })),
        el('button', { class: 'btn primary', type: 'button', id: 'm2-test', text: 'Run pass/fail test', disabled: true, onclick: () => this.runTorture() }),
        el('div', { class: 'result', id: 'm2-torture' })),
    );
    this.chart = new StripChart($('#m2-chart'), $('#m2-legend'));
    const fs = [...this.mc.cfg.sensor.rangeN.map((v) => v * 0.1), ...this.mc.cfg.sensor.rangeNm.map((v) => v * 0.1)];
    this.gauges = new Gauges($('#m2-gauges'), fs);
    this.jog = new JogPanel(this.mc, $('#m2-jog'), { onChange: () => { this.lastMove = performance.now(); } });
    this.mc.robot.onChange(() => { this.lastMove = performance.now(); });
    this.holdBtn = new HoldButton($('#m2-zero'), {
      onStart: () => this.startHold(),
      onRelease: () => this.releaseHold(),
    });
    this._buildForceArrow();
  }

  _buildForceArrow() {
    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 0.15, 0xff8800, 0.04, 0.025);
    this.arrow.line.material.depthTest = false;
    this.arrow.cone.material.depthTest = false;
    this.arrow.renderOrder = 998;
    this.arrowHandle = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff8800 }));
    this.arrowHandle.userData.forceHandle = true;
    this.arrowGroup = new THREE.Group();
    this.arrowGroup.userData.pickable = true;
    this.arrowGroup.add(this.arrow, this.arrowHandle);
    this.arrowGroup.visible = false;
    this.mc.scene.scene.add(this.arrowGroup);
    this.forceOffset = new THREE.Vector3(-0.15, 0, 0);
    this.mc.scene.pickHandlers.push((hits) => {
      if (!this.arrowGroup.visible || !hits.find((h) => h.object.userData.forceHandle)) return false;
      const g = this.mc.gizmo;
      g.attach(this.arrowHandle);
      g.showX = g.showY = g.showZ = true;
      this.mc.gizmoCb = () => { this.forceOffset.copy(this.arrowHandle.position).sub(this.loadPoint()); };
      return true;
    });
  }

  loadPoint() {
    const b = new THREE.Box3().setFromObject(this.mc.inspector.nodes.get('Gripper_Block'));
    return b.getCenter(new THREE.Vector3());
  }

  activate() {
    this.mc.hotspots.pulse('HS_FT_Sensor');
    if (!this.fault && this.mc.expert) this.injectFault();
    this.onMode();
  }

  deactivate() {
    this.mc.hotspots.pulse(null);
    if (this.forceOn) this.toggleForce();
    this.mc.gizmo.detach();
  }

  onMode() {
    $$('.expert-only', this.pane).forEach((e) => { e.hidden = !this.mc.expert; });
    if (this.mc.expert && !this.fault && this.mc.active === 'm2') this.injectFault();
  }

  begin() {
    super.begin();
    this.mc.scene.flyTo(new THREE.Vector3(0.55, 1.2, -1.55), new THREE.Vector3(-0.35, 0.85, -0.6));
  }

  injectFault() {
    const options = ['thermal', 'looseCable', 'wrongMount'];
    this.fault = options[Math.floor(Math.random() * options.length)];
    this.mc.sensor.faults[this.fault] = true;
    this.faultFixed = false;
  }

  fixFault() {
    const pick = $('#m2-fault-pick').value;
    if (!pick) return;
    if (pick === this.fault) {
      this.mc.sensor.faults[this.fault] = false;
      this.faultFixed = true;
      toast('Fault fixed. Re-zero and re-capture: earlier samples include the fault.', 'good', 5000);
      this.bias = null;
      this.poses = [];
      this.fit = null;
      this.model = null;
      this.renderPoses();
      this.refresh();
    } else {
      this.faultWrongGuesses = (this.faultWrongGuesses ?? 0) + 1;
      this.mc.why({ title: 'That is not the fault', body: 'Look at the chart: thermal drift shows as a slow ramp after zeroing, a loose cable as random spikes, and a wrong mounting rotation as forces swapping between X and Y (large residuals after solving).', hotspot: 'HS_FT_Sensor' });
    }
  }

  // ---------------------------------------------------------- readings
  displayValues(raw) {
    if (!this.bias) return raw;
    const z = raw.map((v, i) => v - this.bias[i]);
    if (!this.model) return z;
    const a = this.mc.sensor.gravityIn(this.mc.state.m1.mountingDeg).toArray();
    const pred = predict(this.model, a);
    return z.map((v, i) => v - pred[i]);
  }

  get mode() { return this.model ? 'compensated' : this.bias ? 'zeroed' : 'raw'; }

  tick(dt, active) {
    const s = this.mc.sensor;
    s.contact = this.mc.specimenSeated();
    if (this.forceOn) {
      const p = this.loadPoint();
      if (this.mc.gizmo.object !== this.arrowHandle || !this.mc.scene.gizmoDragging) this.arrowHandle.position.copy(p).add(this.forceOffset);
      const f = p.clone().sub(this.arrowHandle.position);
      const len = f.length();
      this.arrow.position.copy(this.arrowHandle.position);
      if (len > 1e-4) this.arrow.setDirection(f.clone().normalize());
      this.arrow.setLength(Math.max(len, 0.05), 0.04, 0.025);
      s.extForceWorld.copy(f.multiplyScalar(100));   // 10 N per 0.1 m
      s.loadPointWorld = p;
      if (active) this.mc.scene.requestRender();
    } else if (!this.forceOnHidden) {
      s.extForceWorld.set(0, 0, 0);   // (the torture test applies its own hidden load)
    }
    const fresh = s.step(dt);
    if (this.hold) this.tickHold(fresh);
    if (this.collecting) {
      this.collecting.raw.push(...fresh);
      this.collecting.a.push(s.gravityIn(this.mc.state.m1.mountingDeg).toArray());
      if (this.collecting.raw.length >= this.collecting.n) {
        const c = this.collecting;
        this.collecting = null;
        c.resolve(c);
      }
    }
    if (!active) return;
    const shown = this.displayValues(s.latest);
    this.chart.push(s.t, shown);
    this.gauges.set(shown);
    this.chart.draw();
    $('#m2-contact').hidden = !s.contact;
    const zb = $('#m2-zero');
    const zeroOff = !this.diagnosed || (s.contact && !this.hold);
    if (zb.disabled !== zeroOff) zb.disabled = zeroOff;
    $('#m2-zero-note').hidden = !(this.diagnosed && s.contact);
    const badge = $('#m2-mode');
    badge.textContent = this.mode;
    badge.className = `badge ${this.mode}`;
    // protective force limit from Mission 1 (cause and effect)
    const fz = Math.hypot(shown[0], shown[1], shown[2]);
    const lim = this.mc.state.m1.forceLimitN;
    if (this.model && fz > lim && !this.limitWarned) {
      this.limitWarned = true;
      this.mc.why({ title: 'Protective force limit exceeded', body: `The compensated force (${fz.toFixed(1)} N) is above your Mission 1 limit of ${lim} N. A real controller would trigger a protective stop here.`, hotspot: 'HS_FT_Sensor' });
    } else if (fz < lim * 0.8) this.limitWarned = false;
  }

  refresh() {
    $('#m2-zero').disabled = !this.diagnosed || this.mc.sensor.contact;
    $('#m2-capture').disabled = !this.bias || this.poses.length >= this.mc.cfg.mission2.maxPoses;
    $('#m2-solve').disabled = this.poses.length < this.mc.cfg.mission2.minPoses;
    $('#m2-load').disabled = !this.model;
    $('#m2-wiggle').disabled = !this.model;
    $('#m2-test').disabled = !this.model;
    const sp = this.mc.cfg.mission2.suggestedPoses.poses;
    const k = this.poses.length % sp.length;
    $('#m2-example').textContent = `Move to suggested pose ${k + 1} of ${sp.length}`;
    $('#m2-example').disabled = !this.bias;
    this.mc.renderHud();
  }

  // ---------------------------------------------------------- diagnose
  diagnose() {
    if (!this.started) this.begin();
    const picked = new Set($$('#m2-diag input:checked').map((i) => i.value));
    const s = this.mc.sensor;
    // must name the main causes (tool weight, sensor offset) and nothing that is absent;
    // contact (if the specimen is seated) and drift (with a thermal fault) are accepted too
    const needed = new Set(['bias']);
    if (s.tool.mass > 0) needed.add('gravity');
    const truth = new Set([...needed, ...(s.contact ? ['contact'] : []), ...(s.faults.thermal ? ['drift'] : [])]);
    this.diagnoseTries++;
    const ok = [...needed].every((t) => picked.has(t)) && [...picked].every((t) => truth.has(t));
    const out = $('#m2-diag-result');
    if (ok) {
      this.diagnosed = true;
      out.className = 'result pass';
      out.textContent = `Correct. ${truth.has('gravity') ? 'The tool\'s weight loads the sensor, ' : ''}every sensor has a constant offset${truth.has('contact') ? ', and the seated specimen is pushing on the fixture' : ''}. ${truth.has('drift') ? 'Drift is unusually strong here.' : 'Drift is real but tiny over a few seconds.'} Zero unlocked.`;
    } else {
      out.className = 'result fail';
      out.textContent = this.mc.expert ? 'Not quite. Try again.' : `Not quite. Hint: think about what is constant (offset), what depends on orientation (weight), whether anything touches the tool (${s.contact ? 'it does' : 'it doesn\'t'}), and how much can drift in a few seconds.`;
      if (!this.mc.expert) this.hintsUsed++;
      if (!this.mc.expert && this.diagnoseTries >= 2) $('#m2-reveal').hidden = false;
      this.mc.why({ title: 'Why are the readings not zero?', body: 'An F/T sensor reports everything below it: the tool\'s own weight (which changes direction as the arm moves), a constant electronic offset, slow thermal drift, and any contact. Zeroing removes the offset at one pose only; gravity compensation removes the weight at every pose.', hotspot: 'HS_FT_Sensor' });
    }
    this.refresh();
  }

  revealDiagnosis() {
    const s = this.mc.sensor;
    const needed = ['bias', ...(s.tool.mass > 0 ? ['gravity'] : []), ...(s.contact ? ['contact'] : [])];
    $$('#m2-diag input').forEach((i) => { i.checked = needed.includes(i.value); });
    this.hintsUsed++;
    this.diagnose();
    $('#m2-reveal').hidden = true;
  }

  // ---------------------------------------------------------- hold to zero
  startHold() {
    this.hold = { samples: [], startAngles: JSON.stringify(this.mc.robot.angles), n: this.mc.cfg.sensor.zeroSamples };
    this.zeroAttempts++;
  }

  tickHold(fresh) {
    if (JSON.stringify(this.mc.robot.angles) !== this.hold.startAngles) {
      this.ruinHold('The arm moved while averaging.');
      return;
    }
    this.hold.samples.push(...fresh);
    this.holdBtn.setProgress(this.hold.samples.length / this.hold.n);
    if (this.hold.samples.length >= this.hold.n) {
      const samples = this.hold.samples.slice(0, this.hold.n);
      this.hold = null;
      const newBias = samples[0].map((_, i) => samples.reduce((a, s) => a + s[i], 0) / samples.length);
      const oldBias = this.bias;
      this.bias = newBias;
      this.zeroedWithContact = this.mc.sensor.contact;
      if (oldBias && this.poses.length) {
        // re-zero: keep the captured poses consistent with the new offset
        const d = oldBias.map((v, i) => v - newBias[i]);
        this.poses.forEach((p) => { p.F = p.F.map((v, i) => v + d[i]); p.M = p.M.map((v, i) => v + d[i + 3]); });
      }
      if (this.fit) {
        // keep the solved mass and CoM; re-tare the offsets so this pose reads zero after compensation
        const a = this.mc.sensor.gravityIn(this.mc.state.m1.mountingDeg).toArray();
        const g = (mdl) => predict({ ...mdl, bF: [0, 0, 0], bM: [0, 0, 0] }, a).map((v) => -v);
        const gf = g(this.fit);
        this.fit = { ...this.fit, bF: gf.slice(0, 3), bM: gf.slice(3) };
        if (this.model) {
          const gm = g(this.model);
          this.model = { ...this.model, bF: gm.slice(0, 3), bM: gm.slice(3) };
        }
      } else this.model = null;
      this.chart.mark(this.mc.sensor.t, 'zero');
      $('#m2-bias').className = 'result pass';
      $('#m2-bias').textContent = `Stored bias (mean of ${samples.length} samples):\n${CHANNELS.map((c, i) => `${c.key} ${fmt(this.bias[i], i < 3 ? 3 : 4)}`).join('  ')}\n`
        + 'Note: this includes the tool\'s weight at this pose. Tilt the arm and the readings move away from zero again; that is what step 4 fixes.';
      if (this.zeroedWithContact) {
        $('#m2-bias').className = 'result fail';
        $('#m2-bias').textContent += '\n⚠ You zeroed while the specimen was seated, so the contact force is baked into the bias.';
        this.mc.why({ title: 'Zeroed with contact', body: 'The specimen was still pushing on the fixture, so the stored offset includes that contact load. When the tool lifts clear, readings jump by the contact force. Withdraw the specimen and zero again.', hotspot: 'HS_Specimen_Shaft' });
      }
      if (this.zeroAttempts === 1 && this.diagnoseTries === 1 && !this.zeroedWithContact) this.mc.awardBadge(this, 'Zero Hero');
      this.holdBtn.setProgress(1);
      this.refresh();
    }
  }

  releaseHold() {
    if (this.hold) this.ruinHold('Released too early.');
  }

  ruinHold(reason) {
    this.hold = null;
    this.zeroRuined++;
    this.holdBtn.ruin();
    $('#m2-bias').className = 'result fail';
    $('#m2-bias').textContent = `${reason} The sample was discarded; hold again.`;
  }

  // ---------------------------------------------------------- capture poses
  async capture() {
    if (performance.now() - (this.lastMove ?? 0) < 150) {
      toast('Wait until the arm is still before capturing.', 'bad');
      return;
    }
    $('#m2-capture').disabled = true;
    const startAngles = JSON.stringify(this.mc.robot.angles);
    const c = await new Promise((resolve) => { this.collecting = { n: 50, raw: [], a: [], resolve }; });
    if (JSON.stringify(this.mc.robot.angles) !== startAngles) {
      toast('The arm moved during capture; pose discarded.', 'bad');
      this.refresh();
      return;
    }
    const z = c.raw.map((s) => s.map((v, i) => v - this.bias[i]));
    const mean = z[0].map((_, i) => z.reduce((a, s) => a + s[i], 0) / z.length);
    const a = c.a[0].map((_, i) => c.a.reduce((acc, v) => acc + v[i], 0) / c.a.length);
    this.poses.push({ a, F: mean.slice(0, 3), M: mean.slice(3), angles: this.mc.robot.getAngles(), contact: this.mc.sensor.contact });
    if (this.mc.sensor.contact) toast('Captured while in contact with the fixture: this pose will distort the fit.', 'bad', 5000);
    this.renderPoses();
    this.refresh();
  }

  renderPoses() {
    $('#m2-poses').replaceChildren(...this.poses.map((p, i) => el('li', {},
      el('span', { text: `g = [${p.a.map((v) => v.toFixed(1)).join(', ')}] m/s²${p.contact ? ' · contact!' : ''}` }),
      el('button', { class: 'btn ghost small', type: 'button', 'aria-label': `Remove pose ${i + 1}`, text: '✕', onclick: () => { this.poses.splice(i, 1); this.renderPoses(); this.refresh(); } }))));
    const c = conditioning(this.poses, this.mc.cfg.mission2.conditionGood, this.mc.cfg.mission2.conditionPoor);
    this.diversity = c;
    const fill = $('#m2-div');
    fill.style.width = `${Math.round(c.quality * 100)}%`;
    fill.className = `meter-fill ${c.quality > 0.66 ? 'good' : c.quality > 0.33 ? 'ok' : 'poor'}`;
    $('#m2-div-text').textContent = !this.poses.length ? 'Pose diversity: capture poses to measure it.'
      : !Number.isFinite(c.condM) ? 'Pose diversity: too low. These poses cannot separate mass from centre of mass; add tilts in other directions.'
        : `Pose diversity: ${c.quality > 0.66 ? 'good' : c.quality > 0.33 ? 'fair' : 'poor'} (condition number ${Math.max(c.condF, c.condM).toFixed(0)}; lower is better).`;
  }

  /** Guided helper: move to the next of a few well-spread tilts (no penalty). */
  suggestedPose() {
    const list = this.mc.cfg.mission2.suggestedPoses.poses;
    const k = this.poses.length % list.length;
    if (!this.poseRef || this.poses.length === 0) this.poseRef = this.mc.robot.getAngles();
    const p = list[k];
    this.mc.robot.setAngles({ ...this.poseRef, A5: this.poseRef.A5 + p.A5, A6: this.poseRef.A6 + p.A6 });
    toast(`Suggested pose ${k + 1} of ${list.length} (${p.label}). Now click “Capture pose”.`);
  }

  // ---------------------------------------------------------- solve
  solve() {
    try {
      this.fit = fitGravity(this.poses);
    } catch (e) {
      $('#m2-fit').className = 'result fail';
      $('#m2-fit').textContent = e.message;
      this.mc.why({ title: 'The fit failed', body: 'Least squares needs the gravity direction (in the sensor frame) to vary in all three directions. Poses that only rotate about the tool axis while it points down all look the same to the sensor.', hotspot: 'HS_FT_Sensor' });
      return;
    }
    const f = this.fit;
    const m1 = this.mc.configuredTool();
    const tol = this.mc.tol();
    const comEst = f.com.map((v) => v * 1000);
    const massDiff = Math.abs(f.mass - m1.mass);
    const comDiff = Math.hypot(...comEst.map((v, i) => v - m1.com_mm[i]));
    const mismatch = massDiff > tol.massKg || comDiff > tol.com_mm;
    const out = $('#m2-fit');
    out.className = `result ${mismatch ? 'fail' : 'pass'}`;
    out.textContent = [
      `Estimated mass   ${f.mass.toFixed(3)} kg    Mission 1: ${m1.mass} kg ${massDiff > tol.massKg ? '⚠ mismatch' : '✓'}`,
      `Estimated CoM    [${comEst.map((v) => v.toFixed(0)).join(', ')}] mm    Mission 1: [${m1.com_mm.join(', ')}] ${comDiff > tol.com_mm ? '⚠ mismatch' : '✓'}`,
      `Force offset      [${f.bF.map((v) => v.toFixed(2)).join(', ')}] N  (includes the tool weight present when you zeroed)`,
      `Residual RMS     ${f.rmsF.toFixed(3)} N · ${f.rmsM.toFixed(4)} N·m`,
    ].join('\n');
    if (f.rmsF > 0.5 || f.rmsM > 0.05) {
      this.mc.why({ title: 'Large residual', body: 'The model cannot explain the captured readings. Usual causes: a pose captured while touching the fixture, the arm moving during capture, a sensor fault, or a mounting rotation in Mission 1 that does not match the real sensor.', hotspot: 'HS_Adapter_Plate' });
    } else if (mismatch) {
      this.mc.why({ title: 'Measured tool differs from Mission 1', body: 'The sensor measured a different mass or centre of mass than you entered in Mission 1. Either the entered data was wrong (accept the estimate) or something else is attached. Compensating with wrong data leaves orientation-dependent errors.', hotspot: 'HS_Gripper' });
    }
    $('#m2-accept').hidden = false;
    this.useModel('estimate');
    this.chart.mark(this.mc.sensor.t, 'fit');
  }

  useModel(which) {
    if (which === 'estimate') this.model = this.fit;
    else {
      const m1 = this.mc.configuredTool();
      const c = m1.com_mm.map((v) => (v / 1000) * m1.mass);
      this.model = { mass: m1.mass, c, bF: this.fit.bF, bM: this.fit.bM };
    }
    this.modelSource = which;
    toast(which === 'estimate' ? 'Compensating with the measured estimate.' : 'Compensating with your Mission 1 values.');
    this.refresh();
  }

  // ---------------------------------------------------------- torture test
  toggleForce() {
    this.forceOn = !this.forceOn;
    this.arrowGroup.visible = this.forceOn;
    const b = $('#m2-load');
    b.setAttribute('aria-pressed', String(this.forceOn));
    b.textContent = this.forceOn ? 'Remove simulated load' : 'Apply simulated load';
    if (this.forceOn) this.chart.mark(this.mc.sensor.t, 'load');
    else this.mc.gizmo.detach();
    this.mc.scene.requestRender();
  }

  wiggle() {
    const s = this.mc.sensor;
    s.wiggleUntil = s.t + this.mc.cfg.mission2.torture.wiggleSeconds;
    this.chart.mark(s.t, 'wiggle');
  }

  async runTorture() {
    if (this.forceOn) this.toggleForce();
    $('#m2-test').disabled = true;
    const out = $('#m2-torture');
    out.className = 'result';
    out.textContent = 'Testing: no load…';
    const tol = this.mc.tol();
    const sample = async (n) => {
      const c = await new Promise((resolve) => { this.collecting = { n, raw: [], a: [], resolve }; });
      return c.raw.map((s) => this.displayValues(s));
    };
    const s = this.mc.sensor;
    const noLoad = await sample(100);
    const meanNo = noLoad[0].map((_, i) => noLoad.reduce((a, r) => a + r[i], 0) / noLoad.length);
    // known hidden load at the gripper
    out.textContent = 'Testing: known load…';
    const F = this.mc.cfg.mission2.torture.loadN;
    const dirW = new THREE.Vector3(0.6, -0.5, 0.62).normalize();
    s.extForceWorld.copy(dirW).multiplyScalar(F);
    s.loadPointWorld = this.loadPoint();
    this.forceOnHidden = true;
    const withLoad = await sample(100);
    s.extForceWorld.set(0, 0, 0);
    this.forceOnHidden = false;
    const meanLoad = withLoad[0].map((_, i) => withLoad.reduce((a, r) => a + r[i], 0) / withLoad.length);
    const q = s.frameQuat(s.actualMountingDeg()).invert();
    const expected = dirW.clone().multiplyScalar(F).applyQuaternion(q);
    const loadErr = Math.hypot(meanLoad[0] - expected.x, meanLoad[1] - expected.y, meanLoad[2] - expected.z);
    // estimates vs hidden ground truth
    const truth = s.tool;
    const massErr = Math.abs((this.fit?.mass ?? 0) - truth.mass);
    const comErr = this.fit ? Math.hypot(...this.fit.com.map((v, i) => (v - truth.com.toArray()[i]) * 1000)) : Infinity;
    const zeroErrF = Math.hypot(meanNo[0], meanNo[1], meanNo[2]);
    const zeroErrM = Math.hypot(meanNo[3], meanNo[4], meanNo[5]);
    const crit = [
      ['Compensated force with no load', zeroErrF <= tol.forceN, `${zeroErrF.toFixed(3)} N (≤ ${tol.forceN})`],
      ['Compensated moment with no load', zeroErrM <= tol.momentNm, `${zeroErrM.toFixed(4)} N·m (≤ ${tol.momentNm})`],
      ['Known 15 N load reproduced', loadErr <= tol.forceN + 0.1 * F, `error ${loadErr.toFixed(2)} N`],
      ['Mass vs ground truth', massErr <= tol.massKg, `error ${massErr.toFixed(3)} kg (≤ ${tol.massKg})`],
      ['CoM vs ground truth', comErr <= tol.com_mm, `error ${Number.isFinite(comErr) ? comErr.toFixed(1) : '–'} mm (≤ ${tol.com_mm})`],
    ];
    if (this.mc.expert) crit.push(['Fault found and fixed', this.faultFixed, this.faultFixed ? 'fixed' : 'not fixed']);
    const pass = crit.every((c) => c[1]);
    this.torture = { pass, crit, massErr, comErr, zeroErrF, zeroErrM, loadErr };
    out.className = `result ${pass ? 'pass' : 'fail'}`;
    out.replaceChildren(el('span', { class: `verdict ${pass ? 'pass' : 'fail'}`, text: pass ? 'PASS' : 'FAIL' }),
      el('ul', { class: 'crit' }, crit.map(([l, ok, d]) => el('li', { class: ok ? 'ok' : 'bad', text: `${ok ? '✓' : '✗'} ${l}: ${d}` }))));
    if (!pass) {
      const first = crit.find((c) => !c[1]);
      this.mc.why({ title: `Failed: ${first[0]}`, body: whyTorture(first[0], this), hotspot: 'HS_FT_Sensor' });
    } else this.finish();
    $('#m2-test').disabled = false;
    this.refresh();
  }

  /**
   * Score (100): diagnosis 15 (first try; 5 later), zeroing 15 (−5 per ruined
   * hold, −10 if zeroed in contact), pose diversity 20 × quality, estimate
   * accuracy 30 × (1 − normalised error / 3), torture pass 20, minus hints.
   */
  score() {
    if (!this.started) return null;
    const tol = this.mc.tol();
    const parts = [];
    parts.push(['Diagnosis', this.diagnosed ? (this.diagnoseTries === 1 ? 15 : 5) : 0]);
    parts.push(['Zeroing', this.bias ? clamp(15 - 5 * this.zeroRuined - (this.zeroedWithContact ? 10 : 0), 0, 15) : 0]);
    parts.push(['Pose diversity', 20 * (this.diversity?.quality ?? 0)]);
    if (this.torture) {
      const e = Math.max(this.torture.massErr / tol.massKg, this.torture.comErr / tol.com_mm);
      parts.push(['Estimate accuracy', 30 * clamp(1 - (Number.isFinite(e) ? e : 3) / 3, 0, 1)]);
      parts.push(['Torture test', this.torture.pass ? 20 : 0]);
    }
    parts.push(['Hints', -this.mc.cfg.scoring.hintPenalty * this.hintsUsed]);
    return { total: clamp(parts.reduce((a, p) => a + p[1], 0), 0, 100), parts };
  }

  progress() {
    const minPoses = this.mc.cfg.mission2.minPoses;
    const seated = this.mc.sensor.contact;
    const guided = !this.mc.expert;
    return [
      { label: 'Lift clear', done: !seated || !!this.bias, target: '#pane-m2 .jog-up', hint: 'Click “Up 10 cm” (in “1 · Jog the robot”) so the specimen comes out of the fixture. Nothing may touch the tool.' },
      { label: 'Diagnose', done: this.diagnosed, target: '#m2-s2', hint: 'In “2 · Diagnose”, tick why the readings are not zero, then click “Check my answer”. Tip: the tool has weight, and every sensor has a small built-in offset.' },
      { label: 'Hold to zero', done: !!this.bias, target: '#m2-zero', hint: 'Press and keep holding “Hold to zero” until the ring is full (about 2 seconds). Don’t move the arm while it fills.' },
      { label: 'Capture poses', done: this.poses.length >= minPoses, target: '#m2-s4', hint: guided ? `Click “Move to suggested pose”, then “Capture pose”. Repeat until you have ${minPoses} poses (${this.poses.length} so far).` : `Jog the tool to at least ${minPoses} different tilts and capture each one (${this.poses.length} so far).` },
      { label: 'Solve', done: !!this.fit, target: '#m2-solve', hint: 'Click “Solve least squares” to work out the tool’s mass and centre of mass.' },
      { label: 'Pass/fail test', done: !!this.torture?.pass, target: '#m2-test', hint: this.torture && !this.torture.pass ? (this.modelSource === 'mission1' ? 'The test failed because it used your Mission 1 values. Click “Accept estimate”, then run the test again.' : (this.torture.zeroErrF > this.mc.tol().forceN || this.torture.zeroErrM > this.mc.tol().momentNm) && !this.mc.expert ? 'The readings have drifted since you zeroed. Hold “Hold to zero” again (nothing touching the tool), then run the test again.' : 'The test failed. Read the “Why?” panel, fix what it says, then run the test again.') : 'Click “Run pass/fail test” and wait a few seconds for the result.' },
    ].map((x, i, arr) => ({ ...x, current: !x.done && arr.slice(0, i).every((y) => y.done) }));
  }
}

function whyTorture(label, m) {
  if (label.startsWith('Compensated force') || label.startsWith('Compensated moment')) {
    if (m.modelSource === 'mission1') return 'You are compensating with the Mission 1 values, which do not match the real tool. Click "Accept estimate", then run the test again.';
    return 'A small offset has crept in since you zeroed (sensor readings drift slowly with time and temperature). Make sure nothing touches the tool, press and hold "Hold to zero" again, then run the test again. Your solved mass and centre of mass are kept.';
  }
  if (label.startsWith('Known')) return 'An external load must appear in full on the compensated channels. If it does not, the sensor frame (mounting rotation) or the compensation model is wrong.';
  if (label.startsWith('Mass') || label.startsWith('CoM')) return 'The estimate does not match the real tool. More diverse poses (tilt the tool in two different directions) and capturing only when still improve accuracy.';
  return 'The injected fault distorts the readings. Identify it from the chart and fix it, then re-zero and re-capture.';
}

// ============================================================== Mission 3
class Mission3 extends MissionBase {
  constructor(mc) {
    super(mc, 'm3');
    this.briefing = {
      title: 'Mission 3: Plan and verify a low-speed dry run',
      goal: 'Prepare the cell, place your own waypoints above the fixture, make every check green, then run the path at low speed holding the dead-man\'s switch. React to anything unexpected.',
      configure: ['Pre-flight items (tool status, E-stop test, T1)', 'Waypoints: position, orientation, speed, blend', 'Speed ladder: 10% → 25% → 50%'],
      safety: ['Nobody inside the cell during the run.', 'Hold the dead-man\'s switch (button or Space) to move; let go to stop instantly.', 'If anything unexpected happens: E-stop first, investigate second.'],
    };
    this.waypoints = (mc.state.m3?.waypoints ?? []).map((w) => ({ ...w, pos: new THREE.Vector3(...w.p), id: Math.random().toString(36).slice(2, 8) }));
    this.ladderIdx = 0;
    this.cleanPasses = new Set();
    this.overrides = [];
    this.preflight = { tool: null, estopTested: false, estopPressed: false, mode: null, cellClear: false, skipped: new Set() };
    this.toolStatus = 'fitted';
    this.run = null;
    this.protectiveStops = 0;
    this.doneHint = 'Mission 3 complete. Try again at 25% for a better score, or open the Bonus tab.';
    this.doneTarget = '#m3-s3';
    this._buildScene();
    this._build();
    this.idSteps();
    this.renderWaypoints();
  }

  // ---------------------------------------------------------- scene props
  _buildScene() {
    const s = this.mc.scene;
    // E-stop station (viewer-side prop, not part of the GLB)
    const g = new THREE.Group();
    g.name = 'EStop_Station';
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.0, 16), new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.6, roughness: 0.4 }));
    post.position.y = 0.5;
    const boxM = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.12), new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.5 }));
    boxM.position.y = 1.07;
    this.estopCap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.04, 28), new THREE.MeshStandardMaterial({ color: 0xd11a1a, roughness: 0.45 }));
    this.estopCap.position.y = 1.16;
    for (const m of [post, boxM, this.estopCap]) { m.castShadow = true; m.userData.estop = true; }
    g.add(post, boxM, this.estopCap);
    g.position.fromArray(this.mc.cfg.mission3.estop.position);
    g.userData.pickable = true;
    const tag = new CSS2DObject(el('span', { class: 'tag', text: 'E-stop (viewer prop)' }));
    tag.position.set(0, 1.3, 0);
    g.add(tag);
    g.visible = false;
    s.scene.add(g);
    this.estopGroup = g;
    // waypoint markers, path line, TCP trail, clearance halo
    this.wpGroup = new THREE.Group();
    this.wpGroup.userData.pickable = true;
    this.wpGroup.visible = false;
    s.scene.add(this.wpGroup);
    this.pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0x7aa7d9, dashSize: 0.02, gapSize: 0.015, depthTest: false, transparent: true }));
    this.pathLine.renderOrder = 990;
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(30000 * 3), 3));
    this.trailGeo.setDrawRange(0, 0);
    this.trail = new THREE.Line(this.trailGeo, new THREE.LineBasicMaterial({ color: 0x1a8cff, depthTest: false, transparent: true }));
    this.trail.renderOrder = 991;
    this.trail.frustumCulled = false;
    this.halo = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.18, depthWrite: false }));
    this.halo.userData.noPick = true;
    this.halo.visible = false;
    this.wpGroup.add(this.pathLine, this.trail, this.halo);
    this.ghost = this.mc.robot.makeGhost();
    // surprise obstacle
    this.obstacle = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), new THREE.MeshStandardMaterial({ color: 0x3b3f46, roughness: 0.7 }));
    this.obstacle.visible = false;
    this.obstacle.castShadow = true;
    s.scene.add(this.obstacle);
    s.pickHandlers.push((hits) => this.onPick(hits));
  }

  // ---------------------------------------------------------- UI
  _build() {
    const c = this.mc.cfg.mission3;
    this.pane.append(
      el('p', { class: 'mission-intro', text: 'Work through the pre-flight in order, build a path, get every check green, then run it.' }),
      this.section('1 · Pre-flight',
        el('ol', { class: 'preflight', id: 'm3-pre' },
          el('li', { 'data-pf': 'tool' }, el('span', { class: 'pf-label', text: 'Tool / specimen status' }),
            el('select', { id: 'm3-tool', 'aria-label': 'Tool status', onchange: () => this.setTool($('#m3-tool').value) },
              el('option', { value: '', text: 'Choose…' }), el('option', { value: 'fitted', text: 'Specimen fitted' }),
              el('option', { value: 'removed', text: 'Specimen removed' }), el('option', { value: 'dummy', text: 'Dummy specimen fitted' }))),
          el('li', { 'data-pf': 'estop' }, el('span', { class: 'pf-label', text: 'Test the E-stop: press it, then release it (here, or the red button in the 3D view)' }),
            el('button', { class: 'btn small estop-btn', type: 'button', id: 'm3-estop-press', text: 'Press E-stop', onclick: () => this.pressEStop('panel') }),
            el('span', { class: 'pf-state', id: 'm3-estop-state', text: 'untested' }),
            el('button', { class: 'btn ghost small', type: 'button', id: 'm3-estop-find', text: 'Find it in 3D', onclick: () => this.showEStop() })),
          el('li', { 'data-pf': 'mode' }, el('span', { class: 'pf-label', text: 'Operating mode for the run' }),
            el('select', { id: 'm3-mode', 'aria-label': 'Operating mode', onchange: () => this.setMode($('#m3-mode').value) },
              el('option', { value: '', text: 'Choose…' }), el('option', { value: 'T1', text: 'T1 (manual reduced speed)' }), el('option', { value: 'AUT', text: 'Automatic' }))),
          el('li', { 'data-pf': 'cell' }, el('label', {}, el('input', { type: 'checkbox', id: 'm3-cell', onchange: () => this.setCellClear($('#m3-cell').checked) }), el('span', { text: 'Cell checked clear of people; door closed' })))),
        el('button', { class: 'btn ghost small', type: 'button', id: 'm3-skip', text: 'Skip the current item', onclick: () => this.skipItem() }),
        el('p', { class: 'small', id: 'm3-pf-msg' })),
      this.section('2 · Waypoints',
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn small', type: 'button', id: 'm3-add', 'aria-pressed': 'false', text: 'Add by clicking in 3D', onclick: () => this.toggleAddMode() }),
          el('button', { class: 'btn small', type: 'button', text: 'Add at TCP', onclick: () => this.addWaypoint(this.mc.robot.tcpPose().pos.clone().add(new THREE.Vector3(0, 0.05, 0))) }),
          el('button', { class: 'btn primary small', type: 'button', id: 'm3-load', text: 'Load example path', onclick: () => this.loadExample() }),
          el('button', { class: 'btn ghost small', type: 'button', text: 'Clear', onclick: () => { this.waypoints = []; this.renderWaypoints(); } })),
        this.hint('Click the fixture or floor to drop a waypoint 15 cm above it. Select a waypoint to drag it with the arrows or type exact values. The blue ghost shows the robot pose for the selected waypoint.'),
        el('ol', { class: 'wp-list', id: 'm3-wps' }),
        el('div', { class: 'wp-editor', id: 'm3-editor', hidden: true })),
      this.section('3 · Checks',
        el('ul', { class: 'tl-list', id: 'm3-checks' }),
        el('div', { class: 'ladder', role: 'group', 'aria-label': 'Speed ladder' },
          el('span', { class: 'small', text: 'Speed ladder:' }), ...c.speedLadderPct.map((p, i) => el('button', { class: 'btn small', type: 'button', 'data-ladder': i, text: `${p}%`, onclick: () => this.setLadder(i) })))),
      this.section('4 · Run',
        el('div', { class: 'run-controls' },
          el('button', { class: 'btn primary hold deadman', type: 'button', id: 'm3-deadman', disabled: true }, el('span', { text: 'Hold to run (or hold Space)' })),
          el('label', { class: 'toggle' }, el('input', { type: 'checkbox', id: 'm3-stepmode' }), el('span', { text: 'Step: stop at each waypoint' })),
          el('label', { class: 'toggle' }, el('input', { type: 'checkbox', id: 'm3-reverse' }), el('span', { text: 'Reverse' })),
          el('label', { class: 'toggle guided-only' }, el('input', { type: 'checkbox', id: 'm3-surprise' }), el('span', { text: 'Surprise event (optional in Guided)' })),
          el('button', { class: 'btn', type: 'button', id: 'm3-reset', text: 'Reset', onclick: () => this.resetRun() }),
          el('button', { class: 'btn estop-btn', type: 'button', id: 'm3-estop-hud', text: 'E-STOP (E)', onclick: () => this.pressEStop('button') })),
        el('div', { class: 'progress' }, el('div', { class: 'progress-bar', id: 'm3-progress' })),
        el('p', { class: 'status-line', id: 'm3-status', text: 'Complete the pre-flight and get the checks green.' }),
        el('div', { class: 'alert', id: 'm3-alert', hidden: true, role: 'alert' }),
        el('div', { class: 'btn-row', id: 'm3-ack-row', hidden: true },
          el('button', { class: 'btn primary', type: 'button', text: 'Acknowledge stop', onclick: () => this.acknowledge() })),
        el('div', { class: 'telemetry' },
          el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: 'Joint' }), el('th', { text: 'Angle' }), el('th', { text: 'Limits' }))),
            el('tbody', { id: 'm3-joints' }, this.mc.robot.joints.map((j) => el('tr', {}, el('td', { text: j.id }), el('td', { id: `m3-ang-${j.id}`, text: '–' }), el('td', { text: `${j.min}…${j.max}°` }))))),
          el('dl', { class: 'kv' }, el('dt', { text: 'TCP' }), el('dd', { id: 'm3-tcp', text: '–' }), el('dt', { text: 'TCP speed' }), el('dd', { id: 'm3-vel', text: '–' }),
            el('dt', { text: 'Clearance' }), el('dd', { id: 'm3-clear', text: '–' })))),
      this.section('5 · Replay & debrief',
        el('label', { class: 'range-row' }, el('span', { text: 'Replay last run' }), el('input', { type: 'range', id: 'm3-scrub', min: 0, max: 0, value: 0, disabled: true })),
        el('p', { class: 'small mono', id: 'm3-scrub-label' }),
        el('div', { class: 'btn-row' },
          el('button', { class: 'btn small', type: 'button', id: 'm3-export', text: 'Export report (JSON)', disabled: true, onclick: () => this.exportReport() }),
          el('button', { class: 'btn small', type: 'button', id: 'm3-debrief-btn', text: 'Show debrief', disabled: true, onclick: () => this.showDebrief() }))),
    );
    this.deadman = new HoldButton($('#m3-deadman'), { onStart: () => this.deadmanDown(), onRelease: () => this.deadmanUp() });
    this.replay = new Replay(this.mc.robot, { range: $('#m3-scrub'), label: $('#m3-scrub-label'), onSeek: () => this.mc.scene.requestRender() });
    window.addEventListener('keydown', (e) => {
      if (this.mc.active !== 'm3' || e.target.closest('input, select, textarea')) return;
      // E-stop must work whatever has focus (including the dead-man button)
      if (e.key.toLowerCase() === 'e' && !e.repeat) { this.pressEStop('key'); return; }
      // Space on a focused button is handled by that button (HoldButton) instead
      if (e.code === 'Space' && !e.repeat && !e.target.closest('button')) { e.preventDefault(); this.deadmanDown(); }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space' && this.mc.active === 'm3') this.deadmanUp(); });
    this.refreshPreflight();
    this.refreshLadder();
  }

  activate() {
    this.estopGroup.visible = true;
    this.wpGroup.visible = true;
    this.mc.inspector.setExplode(0);
    // start from a clear pose above the fixture rather than with the specimen seated
    const r = this.mc.robot;
    if (!this.run && r.tcpPose().pos.y < POT_TOP_Y + 0.12) {
      const p = r.tcpPose();
      const sol = r.ik(p.pos.clone().add(new THREE.Vector3(0, this.mc.cfg.mission3.clearStartLiftM, 0)), new THREE.Vector3(0, -1, 0), r.angles);
      if (sol.status === 'reached') {
        r.setAngles(sol.angles);
        toast('The robot has been moved to a clear start position above the fixture.');
      }
    }
    if (!this.preflight.mode) $('#m3-mode').value = '';
    this.onMode();
    this.replan();
  }

  deactivate() {
    this.estopGroup.visible = false;
    this.wpGroup.visible = false;
    this.ghost.object.visible = false;
    this.mc.gizmo.detach();
    this.addMode = false;
    this.deadmanUp();
  }

  onMode() {
    $$('.guided-only', this.pane).forEach((e) => { e.hidden = this.mc.expert; });
  }

  begin() {
    super.begin();
    this.mc.scene.flyTo(new THREE.Vector3(1.6, 1.9, -2.4), new THREE.Vector3(-0.3, 0.7, -0.4));
  }

  // ---------------------------------------------------------- pre-flight
  pfOrder() { return ['tool', 'estop', 'mode', 'cell']; }

  pfDone(k) {
    const p = this.preflight;
    return { tool: !!p.tool, estop: p.estopTested, mode: !!p.mode, cell: p.cellClear }[k] || p.skipped.has(k);
  }

  currentPf() { return this.pfOrder().find((k) => !this.pfDone(k)) ?? null; }

  refreshPreflight() {
    const cur = this.currentPf();
    for (const k of this.pfOrder()) {
      const li = $(`#m3-pre [data-pf="${k}"]`);
      const done = this.pfDone(k);
      li.className = done ? (this.preflight.skipped.has(k) ? 'skipped' : 'done') : k === cur ? 'current' : 'todo';
      li.querySelectorAll('select, input, button').forEach((i) => { i.disabled = !(k === cur || done) || this.run?.running; });
    }
    $('#m3-estop-press').textContent = this.preflight.estopPressed ? 'Release E-stop' : 'Press E-stop';
    $('#m3-estop-state').textContent = this.preflight.estopPressed ? 'PRESSED: click it again to release' : this.preflight.estopTested ? 'tested ✓' : this.preflight.skipped.has('estop') ? 'skipped' : 'untested';
    $('#m3-skip').disabled = !cur;
    this.refreshRun();
    this.mc.renderHud();
  }

  setTool(v) {
    if (!v) return;
    this.preflight.tool = v;
    this.toolStatus = v;
    this.mc.inspector.setPartVisible('Specimen_Shaft', v !== 'removed');
    if (v === 'removed') this.mc.robot.clearance.excluded.add('Specimen_Shaft');
    else this.mc.robot.clearance.excluded.delete('Specimen_Shaft');
    this.refreshPreflight();
    this.replan();
  }

  setMode(v) {
    if (!v) return;
    this.preflight.mode = v;
    if (v === 'AUT') this.mc.why({ title: 'Automatic mode for a dry run', body: 'In Automatic the robot runs without an enabling (dead-man) device and is not limited to reduced speed. A first run of a new path is always done in T1. Consequence here: the reduced-speed cap is enforced by a protective stop, and the dead-man switch is bypassed.', hotspot: 'HS_Controller' });
    this.refreshPreflight();
    this.replan();
  }

  setCellClear(on) {
    this.preflight.cellClear = on;
    this.refreshPreflight();
  }

  skipItem() {
    const k = this.currentPf();
    if (!k) return;
    this.preflight.skipped.add(k);
    const consequences = {
      tool: 'Skipped: the specimen stays fitted. Its clearance is checked and it can strike the fixture.',
      estop: 'Skipped: the E-stop is untested. If you need it, the first press may not register.',
      mode: 'Skipped: the controller stays in its last mode (Automatic).',
      cell: 'Skipped: nobody checked the cell. Someone may walk in during the run.',
    };
    if (k === 'tool') this.setTool('fitted');
    if (k === 'mode') this.setMode('AUT');
    $('#m3-pf-msg').textContent = consequences[k];
    this.refreshPreflight();
  }

  showEStop() {
    const p = this.estopGroup.position.clone().add(new THREE.Vector3(0, 1.1, 0));
    this.mc.scene.flyTo(p.clone().add(new THREE.Vector3(-0.9, 0.5, -1.2)), p);
  }

  onPick(hits) {
    if (this.mc.active !== 'm3') return false;
    if (hits.find((h) => h.object.userData.estop)) {
      this.pressEStop('scene');
      return true;
    }
    const wpHit = hits.find((h) => h.object.userData.waypointId);
    if (wpHit) {
      this.selectWaypoint(wpHit.object.userData.waypointId);
      return true;
    }
    if (this.addMode && hits.length) {
      const h = hits.find((x) => !x.object.userData.noPick);
      if (h) {
        this.addWaypoint(h.point.clone().add(new THREE.Vector3(0, 0.15, 0)));
        return true;
      }
    }
    return false;
  }

  pressEStop(source) {
    const p = this.preflight;
    // a run is "active" while started and not finished, even if paused (dead-man released)
    const active = this.run && !this.run.done && !this.awaitAck && this.run.t > 0;
    // E-stop test during pre-flight
    if (!active && this.currentPf() === 'estop') {
      p.estopPressed = !p.estopPressed;
      this.estopCap.position.y = p.estopPressed ? 1.14 : 1.16;
      if (!p.estopPressed) p.estopTested = true;
      this.mc.scene.requestRender();
      this.refreshPreflight();
      return;
    }
    if (!active) {
      p.estopPressed = !p.estopPressed;
      this.estopCap.position.y = p.estopPressed ? 1.14 : 1.16;
      this.mc.scene.requestRender();
      this.refreshRun();
      return;
    }
    // during a run
    if (!p.estopTested && !this.run.estopFailedOnce) {
      this.run.estopFailedOnce = true;
      this.mc.recorder.event(this.run.t, 'estop-not-registered', { source });
      toast('E-stop did not register: a contact is sticking (it was never tested). Press again!', 'bad', 3000);
      return;
    }
    this.stop('estop', source);
  }

  // ---------------------------------------------------------- waypoints
  toggleAddMode() {
    this.addMode = !this.addMode;
    $('#m3-add').setAttribute('aria-pressed', String(this.addMode));
    $('#m3-add').textContent = this.addMode ? 'Click in 3D to add… (click to stop)' : 'Add by clicking in 3D';
  }

  addWaypoint(pos) {
    const c = this.mc.cfg.mission3;
    this.waypoints.push({ id: Math.random().toString(36).slice(2, 8), pos, tilt: 0, heading: 0, speed: c.defaultWaypointSpeedMmS, blend: c.defaultBlendMm });
    this.renderWaypoints();
    this.selectWaypoint(this.waypoints[this.waypoints.length - 1].id);
  }

  loadExample() {
    const c = this.mc.cfg.mission3;
    this.waypoints = c.examplePath.points.map((p) => ({
      id: Math.random().toString(36).slice(2, 8), pos: new THREE.Vector3(...p), tilt: 0, heading: 0,
      speed: c.defaultWaypointSpeedMmS, blend: 0,
    }));
    if (this.mc.expert) this.hintsUsed++;
    this.selected = null;
    this.renderWaypoints();
    toast('Example path loaded: approach, hover, move sideways, hover, retreat.');
  }

  wpDir(w) {
    const t = w.tilt * DEG;
    const h = w.heading * DEG;
    return new THREE.Vector3(Math.sin(t) * Math.cos(h), -Math.cos(t), Math.sin(t) * Math.sin(h)).normalize();
  }

  renderWaypoints() {
    // markers are updated in place (recreating them would detach the drag gizmo)
    const ids = new Set(this.waypoints.map((w) => w.id));
    for (const m of [...this.wpGroup.children]) {
      if (m.userData.waypointId && !ids.has(m.userData.waypointId)) {
        if (this.mc.gizmo.object === m) this.mc.gizmo.detach();
        m.parent.remove(m);
      }
    }
    this.waypoints.forEach((w, i) => {
      if (!w.marker || !w.marker.parent) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 12), new THREE.MeshBasicMaterial({ color: 0x1a8cff, depthTest: false, transparent: true }));
        m.renderOrder = 995;
        m.userData.waypointId = w.id;
        m.userData.tag = el('span', { class: 'tag' });
        const tag = new CSS2DObject(m.userData.tag);
        tag.position.set(0, 0.04, 0);
        m.add(tag);
        this.wpGroup.add(m);
        w.marker = m;
      }
      if (this.mc.gizmo.object !== w.marker || !this.mc.scene.gizmoDragging) w.marker.position.copy(w.pos);
      w.marker.userData.tag.textContent = `WP${i + 1}`;
    });
    // list
    $('#m3-wps').replaceChildren(...this.waypoints.map((w, i) => el('li', { class: `wp ${w.status ?? ''} ${w.id === this.selected ? 'selected' : ''}` },
      el('button', { class: 'linklike', type: 'button', text: `WP${i + 1}`, onclick: () => this.selectWaypoint(w.id) }),
      el('span', { class: 'mono small', text: `${w.pos.toArray().map((v) => (v * 1000).toFixed(0)).join(', ')} mm · ${w.speed} mm/s${w.blend ? ` · r${w.blend}` : ''}` }),
      el('span', { class: 'wp-status', text: w.status ?? '' }),
      el('button', { class: 'btn ghost small', type: 'button', 'aria-label': `Move WP${i + 1} up`, text: '↑', disabled: i === 0, onclick: () => { this.waypoints.splice(i - 1, 0, this.waypoints.splice(i, 1)[0]); this.renderWaypoints(); } }),
      el('button', { class: 'btn ghost small', type: 'button', 'aria-label': `Delete WP${i + 1}`, text: '✕', onclick: () => { this.waypoints.splice(i, 1); if (this.selected === w.id) this.selected = null; this.renderWaypoints(); } }))));
    this.mc.state.m3 = { waypoints: this.waypoints.map((w) => ({ p: w.pos.toArray().map((v) => +v.toFixed(4)), tilt: w.tilt, heading: w.heading, speed: w.speed, blend: w.blend })) };
    this.mc.saveState();
    this.renderEditor();
    this.replan();
  }

  selectWaypoint(id) {
    this.selected = id;
    const w = this.waypoints.find((x) => x.id === id);
    if (!w) return;
    const g = this.mc.gizmo;
    g.attach(w.marker);
    g.showX = g.showY = g.showZ = true;
    this.mc.gizmoCb = () => {
      w.pos.copy(w.marker.position);
      this.renderEditor();
      clearTimeout(this._dragT);
      this._dragT = setTimeout(() => this.renderWaypoints(), 120);
    };
    $$('#m3-wps li').forEach((li, i) => li.classList.toggle('selected', this.waypoints[i]?.id === id));
    this.renderEditor();
    this.previewGhost();
  }

  renderEditor() {
    const w = this.waypoints.find((x) => x.id === this.selected);
    const ed = $('#m3-editor');
    ed.hidden = !w;
    if (!w) { this.ghost.object.visible = false; return; }
    const i = this.waypoints.indexOf(w);
    const num = (label, val, unit, onset, attrs = {}) => el('label', { class: 'field' }, el('span', { text: label }),
      el('input', { type: 'number', step: 'any', value: val, ...attrs, onchange: (e) => { onset(Number(e.target.value)); this.renderWaypoints(); } }), el('small', { text: unit }));
    ed.replaceChildren(el('h4', { text: `WP${i + 1}` }), el('div', { class: 'field-grid' },
      num('X', (w.pos.x * 1000).toFixed(0), 'mm', (v) => { w.pos.x = v / 1000; }),
      num('Y (up)', (w.pos.y * 1000).toFixed(0), 'mm', (v) => { w.pos.y = v / 1000; }),
      num('Z', (w.pos.z * 1000).toFixed(0), 'mm', (v) => { w.pos.z = v / 1000; }),
      num('Tool tilt', w.tilt, '° from down', (v) => { w.tilt = clamp(v, 0, 90); }, { min: 0, max: 90 }),
      num('Tilt heading', w.heading, '°', (v) => { w.heading = v; }),
      num('Speed', w.speed, 'mm/s', (v) => { w.speed = Math.max(1, v); }, { min: 1 }),
      num('Blend radius', w.blend, 'mm', (v) => { w.blend = Math.max(0, v); }, { min: 0 })),
    el('p', { class: 'small', id: 'm3-ik-info' }));
    this.previewGhost();
  }

  previewGhost() {
    const w = this.waypoints.find((x) => x.id === this.selected);
    if (!w) return;
    const i = this.waypoints.indexOf(w);
    const seed = this.waypoints[i - 1]?.ik?.angles ?? this.mc.robot.angles;
    const sol = this.mc.robot.ik(w.pos, this.wpDir(w), seed);
    w.ik = sol;
    this.ghost.setAngles(sol.angles);
    this.ghost.setColor(sol.status === 'reached' ? 0x3b82f6 : sol.status === 'partial' ? 0xf59e0b : 0xef4444);
    this.ghost.object.visible = this.mc.active === 'm3';
    const info = $('#m3-ik-info');
    if (info) {
      info.textContent = `IK: ${sol.status} (error ${(sol.posErr * 1000).toFixed(1)} mm, ${sol.oriErrDeg.toFixed(1)}°)`
        + `${sol.limited.length ? ` · at limit: ${sol.limited.join(', ')}` : ''} · wrist singularity margin |A5| = ${sol.singularityDeg.toFixed(1)}°`;
    }
    this.mc.scene.requestRender();
  }

  // ---------------------------------------------------------- planning & checks
  /** TCP speed cap: Mission 1 limit, and the reduced-speed cap for a verification run (also enforced in Automatic). */
  capMmS() {
    return Math.min(this.mc.state.m1.tcpSpeedLimitMmS, this.mc.cfg.mission1.reducedSpeedCapMmS);
  }

  overridePct() { return this.mc.cfg.mission3.speedLadderPct[this.ladderIdx]; }

  replan() {
    clearTimeout(this._planT);
    this._planT = setTimeout(() => this._replan(), 60);
  }

  _replan() {
    const robot = this.mc.robot;
    // per-waypoint IK (chained seeds)
    let seed = robot.getAngles();
    for (const w of this.waypoints) {
      w.ik = robot.ik(w.pos, this.wpDir(w), seed);
      w.status = w.ik.status;
      seed = w.ik.angles;
      if (w.marker) w.marker.material.color.set(w.status === 'reached' ? 0x1a8cff : w.status === 'partial' ? 0xf59e0b : 0xef4444);
    }
    $$('#m3-wps li').forEach((li, i) => {
      const w = this.waypoints[i];
      if (!w) return;
      li.className = `wp ${w.status} ${w.id === this.selected ? 'selected' : ''}`;
      li.querySelector('.wp-status').textContent = w.status === 'reached' ? '✓' : w.status;
    });
    if (!this.waypoints.length) {
      this.plan = null;
      this.pathLine.geometry.setFromPoints([]);
      this.checks = [];
      renderChecks($('#m3-checks'), [{ id: 'none', label: 'Add at least one waypoint', state: 'amber' }]);
      this.refreshRun();
      return;
    }
    const wps = this.waypoints.map((w) => ({ pos: w.pos, dir: this.wpDir(w), speedMmS: w.speed, blendMm: w.blend }));
    this.plan = robot.planPath(this.startAngles ?? robot.getAngles(), wps, { overridePct: this.overridePct() });
    this.pathLine.geometry.setFromPoints(this.plan.frames.map((f) => f.tcp));
    this.pathLine.computeLineDistances();
    this.analyse();
    this.previewGhost();
    this.mc.scene.requestRender();
  }

  analyse() {
    const robot = this.mc.robot;
    const cfg = this.mc.cfg;
    const plan = this.plan;
    const box = this.mc.state.m1.box;
    let limitBad = [];
    let limitWarn = [];
    let jointSpeedBad = [];
    let minClear = Infinity;
    let minPair = null;
    let minPoint = null;
    let peak = 0;
    let outOfBox = 0;
    let singMin = Infinity;
    let unreached = 0;
    const step = Math.max(1, Math.floor(plan.frames.length / 300));
    plan.frames.forEach((f, i) => {
      const ls = robot.limitStatus(f.angles);
      for (const [id, st] of Object.entries(ls)) {
        if (st === 'bad') limitBad.push(id);
        if (st === 'warn') limitWarn.push(id);
      }
      if (f.jointSpeed) for (const [id, v] of Object.entries(f.jointSpeed)) if (v > robot.byId[id].maxSpeed) jointSpeedBad.push(id);
      if (f.status !== 'reached') unreached++;
      peak = Math.max(peak, f.speed);
      const p = f.tcp;
      if (p.x < box.min[0] || p.y < box.min[1] || p.z < box.min[2] || p.x > box.max[0] || p.y > box.max[1] || p.z > box.max[2]) outOfBox++;
      singMin = Math.min(singMin, robot.wristSingularityDeg(f.angles));
      if (i % step === 0 || i === plan.frames.length - 1) {
        const c = robot.clearance.evaluate(f.angles);
        if (c.min < minClear) { minClear = c.min; minPair = c.pair; minPoint = c.point; this.minJoints = c.joints; }
      }
    });
    limitBad = [...new Set(limitBad)];
    limitWarn = [...new Set(limitWarn)];
    jointSpeedBad = [...new Set(jointSpeedBad)];
    const cap = this.capMmS();
    const thr = cfg.mission3.minClearanceMm / 1000;
    const warn = cfg.ik.singularityWarnDeg;
    const wpBad = this.waypoints.filter((w) => w.status !== 'reached');
    const checks = [
      { id: 'limits', label: 'Joint limits', state: limitBad.length || jointSpeedBad.length ? 'red' : limitWarn.length ? 'amber' : 'green',
        detail: limitBad.length ? `Exceeded: ${limitBad.join(', ')}` : jointSpeedBad.length ? `Joint speed too high: ${jointSpeedBad.join(', ')}` : limitWarn.length ? `Within 5° of a limit: ${limitWarn.join(', ')}` : 'All joints inside illustrative limits.',
        why: { title: 'Joint limits', body: 'Each axis has a mechanical range and a maximum speed (illustrative values here). A path that needs more triggers a software limit stop. Move the waypoint, change the tool tilt, or add an intermediate point.', hotspot: 'HS_A1_Base' }, joints: [...limitBad, ...jointSpeedBad, ...limitWarn] },
      { id: 'reach', label: 'Reachability', state: wpBad.some((w) => w.status === 'unreachable') || unreached > plan.frames.length * 0.05 ? 'red' : wpBad.length || unreached ? 'amber' : 'green',
        detail: wpBad.length ? `${wpBad.length} waypoint(s) not reached exactly` : unreached ? `${unreached} path sample(s) approximate` : 'Every waypoint and path sample solved.',
        why: { title: 'Reachability', body: 'Inverse kinematics could not place the tool exactly at that position and orientation: it is outside the arm\'s reach, needs a joint beyond its limit, or asks for an orientation the wrist cannot make there.', hotspot: 'HS_A3_Elbow' } },
      { id: 'clearance', label: 'Clearance', state: minClear < thr ? 'red' : minClear < 2 * thr ? 'amber' : 'green',
        detail: `Min ${(minClear * 1000).toFixed(0)} mm (${(minPair ?? []).join(' vs ')}); need ≥ ${cfg.mission3.minClearanceMm} mm`,
        why: { title: 'Clearance', body: 'Simplified bounding volumes around each link are checked against the fixture, plinth, walls, ceiling and other equipment, and against the robot itself. Lift the path or move it away from the obstacle shown by the halo.', hotspot: 'HS_Fixture' } },
      { id: 'speed', label: 'TCP speed vs cap', state: peak * 1000 > cap ? 'red' : peak * 1000 > cap * 0.9 ? 'amber' : 'green',
        detail: `Peak ${(peak * 1000).toFixed(0)} mm/s at ${this.overridePct()}% (cap ${cap} mm/s)`,
        why: { title: 'TCP speed', body: `Waypoint speed × override is limited by your Mission 1 maximum and, in reduced-speed mode, by ${cfg.mission1.reducedSpeedCapMmS} mm/s. Lower a waypoint's speed or stay on a lower rung of the speed ladder.`, hotspot: 'HS_A6_Flange' } },
      { id: 'box', label: 'Workspace boundary', state: outOfBox ? 'red' : 'green',
        detail: outOfBox ? `${outOfBox} sample(s) outside the Mission 1 box` : 'Path stays inside the box.',
        why: { title: 'Workspace boundary', body: 'The path leaves the workspace box you set in Mission 1. Either keep the waypoints inside it or (deliberately) unlock Mission 1 and enlarge it.', hotspot: 'HS_Fixture' } },
      { id: 'singularity', label: 'Singularity proximity', state: singMin < warn ? 'red' : singMin < warn * 2 ? 'amber' : 'green',
        detail: `Min wrist margin |A5| = ${singMin.toFixed(1)}° (warn < ${warn}°)`,
        why: { title: 'Wrist singularity', body: 'When A5 approaches 0°, axes A4 and A6 line up and tiny tool motions demand huge A4/A6 speeds. Tilt the tool slightly or move the waypoint so the wrist stays bent.', hotspot: 'HS_A5_Wrist' } },
    ];
    for (const c of checks) {
      const o = this.overrides.find((x) => x.id === c.id);
      if (o && c.state !== 'green') { c.overridden = o; c.detail += ` · OVERRIDDEN: "${o.text}"`; }
    }
    this.checks = checks;
    this.planStats = { minClear, minPair, peak, singMin, length: plan.length, duration: plan.duration };
    // clearance halo
    if (minPoint) {
      this.halo.visible = true;
      this.halo.position.copy(minPoint);
      this.halo.scale.setScalar(Math.max(0.03, minClear + 0.03));
      this.halo.material.color.set(minClear < thr ? 0xef4444 : minClear < 2 * thr ? 0xf59e0b : 0x22c55e);
    }
    renderChecks($('#m3-checks'), checks.map((c) => ({ ...c, state: c.overridden ? 'amber' : c.state, label: c.overridden ? `${c.label} (overridden)` : c.label })), { onWhy: (c) => this.mc.why(c.why) });
    // override buttons for non-green checks
    $$('#m3-checks li').forEach((li) => {
      const c = checks.find((x) => x.id === li.dataset.check);
      if (c && !this.checkOk(c) && !this.run?.running) {
        li.append(el('button', { class: 'btn ghost small', type: 'button', text: 'Override…', onclick: () => this.overrideCheck(c, li) }));
      }
    });
    // highlight joints in violation
    const viol = checks.find((c) => c.id === 'limits').joints ?? [];
    this.mc.inspector.highlight(viol.map((j) => JOINT_SECTION[j]), 0xff3030);
    this.refreshRun();
  }

  /** Inline justification box (replaces a browser prompt). */
  overrideCheck(c, li) {
    if (li.querySelector('.inline-override')) return;
    const input = el('input', { type: 'text', placeholder: 'Why is it safe? (at least 15 characters)', 'aria-label': `Reason for overriding ${c.label}` });
    const apply = () => {
      const text = input.value.trim();
      if (text.length < 15) { toast('Please give a fuller reason (at least 15 characters).', 'bad'); input.focus(); return; }
      this.overrides.push({ id: c.id, text, at: new Date().toISOString() });
      this.analyse();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    li.append(el('div', { class: 'inline-override' }, input, el('button', { class: 'btn small', type: 'button', text: `Override (−${this.mc.cfg.scoring.overridePenalty} points)`, onclick: apply })));
    input.focus();
  }

  /** In Guided mode an amber check is a caution, not a blocker; red always blocks. */
  checkOk(c) {
    const amberOk = !this.mc.expert && this.mc.cfg.mission3.amberRunsInGuided;
    return c.state === 'green' || !!c.overridden || (amberOk && c.state === 'amber');
  }

  allGreen() { return this.checks?.length && this.checks.every((c) => c.state === 'green' || c.overridden); }

  runnable() { return this.checks?.length && this.checks.every((c) => this.checkOk(c)); }

  setLadder(i) {
    if (i > 0 && !this.cleanPasses.has(i - 1)) {
      toast(`${this.mc.cfg.mission3.speedLadderPct[i]}% unlocks after a clean pass at ${this.mc.cfg.mission3.speedLadderPct[i - 1]}%.`, 'bad');
      return;
    }
    this.ladderIdx = i;
    this.refreshLadder();
    this.replan();
  }

  refreshLadder() {
    $$('[data-ladder]', this.pane).forEach((b) => {
      const i = Number(b.dataset.ladder);
      b.setAttribute('aria-pressed', String(i === this.ladderIdx));
      b.classList.toggle('locked', i > 0 && !this.cleanPasses.has(i - 1));
    });
  }

  refreshRun() {
    const pfOk = !this.currentPf();
    const ready = pfOk && this.runnable() && this.plan && !this.preflight.estopPressed && !this.awaitAck;
    $('#m3-deadman').disabled = !ready && !this.run?.running;
    if (!this.run?.running && !this.awaitAck) {
      $('#m3-status').textContent = !pfOk ? 'Finish the pre-flight first.' : this.preflight.estopPressed ? 'E-stop is pressed: release it to run.' : !this.plan ? 'Add waypoints.' : !this.runnable() ? (this.mc.expert ? 'Run is disabled until every check is green (or overridden).' : 'Run is disabled while a check is red. Click “Why?” next to it.') : `Ready at ${this.overridePct()}%. Press and hold “Hold to run”.`;
      $('#m3-status').className = `status-line ${ready ? 'ok' : ''}`;
    }
  }

  // ---------------------------------------------------------- run
  ensureRun() {
    if (this.run && !this.run.done) return this.run;
    if (!this.started) this.begin();
    this.startAngles = this.mc.robot.getAngles();
    this._replan();
    if (!this.runnable()) return null;
    const surprise = this.mc.expert || $('#m3-surprise').checked || this.preflight.skipped.has('cell');
    this.run = {
      t: 0, running: false, done: false, frames: this.plan.frames, duration: this.plan.duration, trail: 0,
      surpriseAt: surprise ? this.plan.duration * (0.3 + Math.random() * 0.4) : null,
      surpriseKind: this.preflight.skipped.has('cell') ? 'person' : Math.random() < 0.5 ? 'obstacle' : 'force',
      minClear: Infinity, minPair: null, peak: 0, reaction: null, protective: [], greenAtStart: this.checks.filter((c) => c.state === 'green').length,
      override: this.overridePct(), estopFailedOnce: false,
    };
    this.trailGeo.setDrawRange(0, 0);
    this.mc.recorder.start('dryrun', { overridePct: this.run.override, mode: this.preflight.mode, waypoints: this.mc.state.m3.waypoints, preflight: { ...this.preflight, skipped: [...this.preflight.skipped] }, overrides: this.overrides });
    this.mc.inspector.highlight([]);
    return this.run;
  }

  deadmanDown() {
    if (this.mc.active !== 'm3' || $('#m3-deadman').disabled) return;
    const run = this.ensureRun();
    if (!run) return;
    this.held = true;
    run.running = true;
    this.mc.gizmo.detach();
    this.ghost.object.visible = false;
    $('#m3-status').textContent = `Moving at ${run.override}%… (release to stop)`;
    $('#m3-status').className = 'status-line ok';
    this.refreshPreflight();
  }

  deadmanUp() {
    this.held = false;
    if (this.run?.running && this.preflight.mode !== 'AUT') {
      this.run.running = false;
      this.mc.recorder.event(this.run.t, 'deadman-released');
      $('#m3-status').textContent = 'Paused (dead-man released).';
      $('#m3-status').className = 'status-line';
    }
  }

  tick(dt, active) {
    const run = this.run;
    if (!run || run.done || !active || !run.running) return;
    const rev = $('#m3-reverse').checked;
    const prevT = run.t;
    run.t = clamp(run.t + (rev ? -dt : dt), 0, run.duration);
    // step mode: stop at the next waypoint time
    if ($('#m3-stepmode').checked) {
      const crossed = this.plan.waypointTimes.find((w) => (rev ? (w.t < prevT && w.t >= run.t) : (w.t > prevT && w.t <= run.t)));
      if (crossed) { run.t = crossed.t; run.running = false; $('#m3-status').textContent = `Step: stopped at WP${crossed.wp}. Release and hold again to continue.`; }
    }
    const fi = Math.min(run.frames.length - 1, Math.round((run.t / run.duration) * (run.frames.length - 1)));
    const f = run.frames[fi];
    this.mc.robot.setAngles(f.angles, { clamp: false, silent: true });
    // trail
    const tcp = this.mc.robot.tcp.getWorldPosition(new THREE.Vector3());
    const pos = this.trailGeo.attributes.position;
    if (run.trail < pos.count) { pos.setXYZ(run.trail++, tcp.x, tcp.y, tcp.z); pos.needsUpdate = true; this.trailGeo.setDrawRange(0, run.trail); }
    // live checks
    const c = this.mc.robot.clearance.evaluate();
    const speed = f.speed;
    if (c.min < run.minClear) { run.minClear = c.min; run.minPair = c.pair; }
    run.peak = Math.max(run.peak, speed);
    this.mc.recorder.frame({ t: run.t, angles: { ...f.angles }, tcp: tcp.toArray(), speed, clearance: c.min });
    this.telemetry(f, tcp, speed, c, run);
    // surprise
    if (run.surpriseAt !== null && !run.surpriseShown && run.t >= run.surpriseAt) this.surprise();
    if (run.surpriseShown && !run.reaction && (performance.now() - run.surpriseStart) / 1000 > this.mc.cfg.mission3.surpriseReactionLimitS[this.mc.mode]) {
      this.stop('protective', 'No E-stop within the reaction limit: the safety controller triggered a protective stop.');
      return;
    }
    // protective conditions
    const thr = this.mc.cfg.mission3.minClearanceMm / 1000;
    if (c.min < thr * 0.5 && !this.checks.find((x) => x.id === 'clearance')?.overridden) {
      const what = this.toolStatus === 'fitted' && c.pair?.[0] === 'Specimen_Shaft' ? ' The fitted specimen struck the fixture (specimen damaged).' : '';
      this.stop('protective', `Clearance ${(c.min * 1000).toFixed(0)} mm (${(c.pair ?? []).join(' vs ')}).${what}`, c.joints);
      return;
    }
    if (speed * 1000 > this.capMmS() * 1.001) {
      this.stop('protective', `TCP speed ${(speed * 1000).toFixed(0)} mm/s above the ${this.capMmS()} mm/s cap.`, ['A6']);
      return;
    }
    if (!rev && run.t >= run.duration) this.complete();
    this.mc.scene.requestRender();
  }

  telemetry(f, tcp, speed, c, run) {
    for (const j of JOINTS) $(`#m3-ang-${j}`).textContent = `${f.angles[j].toFixed(1)}°`;
    $('#m3-tcp').textContent = `${tcp.toArray().map((v) => v.toFixed(3)).join(', ')} m`;
    $('#m3-vel').textContent = `${(speed * 1000).toFixed(0)} mm/s (cap ${this.capMmS()})`;
    $('#m3-clear').textContent = `${(c.min * 1000).toFixed(0)} mm (min ${(run.minClear * 1000).toFixed(0)})`;
    $('#m3-progress').style.width = `${(100 * run.t) / run.duration}%`;
  }

  surprise() {
    const run = this.run;
    run.surpriseShown = true;
    run.surpriseStart = performance.now();
    const ahead = run.frames[Math.min(run.frames.length - 1, Math.round(((run.t + 1.5) / run.duration) * (run.frames.length - 1)))].tcp;
    let msg;
    if (run.surpriseKind === 'obstacle' || run.surpriseKind === 'person') {
      this.obstacle.position.copy(ahead).add(new THREE.Vector3(0.12, -0.08, 0));
      this.obstacle.scale.setScalar(run.surpriseKind === 'person' ? 1.4 : 1);
      this.obstacle.visible = true;
      this.mc.robot.clearance.setExtraObstacles([{ name: run.surpriseKind === 'person' ? 'Person' : 'Obstacle', type: 'box', c: this.obstacle.position.toArray(), h: [0.11 * this.obstacle.scale.x, 0.11 * this.obstacle.scale.x, 0.11 * this.obstacle.scale.x] }]);
      msg = run.surpriseKind === 'person' ? 'Someone has walked into the cell!' : 'An object has appeared in the robot\'s path!';
    } else {
      this.mc.sensor.wiggleUntil = this.mc.sensor.t + 1.5;
      msg = 'Force spike on the F/T sensor: unexpected contact!';
    }
    $('#m3-alert').hidden = false;
    $('#m3-alert').textContent = `⚠ ${msg} Press E-STOP (button, E key, or the red button in the scene).`;
    this.mc.recorder.event(run.t, 'surprise', { kind: run.surpriseKind });
    this.mc.scene.requestRender();
  }

  stop(kind, detail, joints = []) {
    const run = this.run;
    if (!run || run.done) return;
    run.running = false;
    if (run.surpriseShown && !run.reaction && kind === 'estop') run.reaction = (performance.now() - run.surpriseStart) / 1000;
    if (kind === 'protective') { run.protective.push(detail); this.protectiveStops++; }
    this.mc.recorder.event(run.t, kind === 'estop' ? 'estop' : 'protective-stop', { detail, reaction: run.reaction });
    this.awaitAck = true;
    this.preflight.estopPressed = kind === 'estop';
    this.estopCap.position.y = kind === 'estop' ? 1.14 : 1.16;
    $('#m3-alert').hidden = false;
    $('#m3-alert').textContent = kind === 'estop'
      ? `E-STOP pressed${run.reaction ? ` (reaction ${run.reaction.toFixed(2)} s)` : ''}. Acknowledge, review the replay, adjust, then reset.`
      : `PROTECTIVE STOP: ${detail} Acknowledge, review the replay, adjust, then reset.`;
    $('#m3-ack-row').hidden = false;
    $('#m3-status').textContent = 'Stopped.';
    $('#m3-status').className = 'status-line bad';
    if (joints.length) this.mc.inspector.highlight(joints.map((j) => JOINT_SECTION[j]), 0xff3030);
    const rec = this.mc.recorder.finish(this.summary('stopped'));
    this.afterRun(rec);
    if (kind === 'protective') this.mc.why({ title: 'Protective stop', body: `${detail} The safety controller stopped the robot because a monitored limit was crossed. Review the replay to see where it happened, then change the path, the speed or the pre-flight.`, hotspot: 'HS_Controller' });
  }

  acknowledge() {
    this.awaitAck = false;
    $('#m3-ack-row').hidden = true;
    $('#m3-alert').hidden = true;
    if (this.preflight.estopPressed) $('#m3-status').textContent = 'Acknowledged. Release the E-stop (click it in the scene), review the replay, then Reset.';
    this.refreshRun();
  }

  resetRun() {
    if (this.run?.running) return;
    this.run = null;
    this.awaitAck = false;
    this.obstacle.visible = false;
    this.mc.robot.clearance.setExtraObstacles([]);
    $('#m3-alert').hidden = true;
    $('#m3-ack-row').hidden = true;
    this.trailGeo.setDrawRange(0, 0);
    if (this.startAngles) this.mc.robot.setAngles(this.startAngles);
    this.startAngles = null;
    this.mc.inspector.highlight([]);
    $('#m3-progress').style.width = '0%';
    this.replan();
  }

  complete() {
    const run = this.run;
    run.running = false;
    run.done = true;
    const clean = !run.protective.length && !this.overrides.length && run.greenAtStart === this.checks.length && !(run.surpriseShown && !run.reaction);
    if (clean) {
      this.cleanPasses.add(this.ladderIdx);
      this.refreshLadder();
      this.mc.awardBadge(this, 'Clean Path');
    }
    const rec = this.mc.recorder.finish(this.summary('completed'));
    $('#m3-status').textContent = clean ? `Clean pass at ${run.override}%.${this.ladderIdx < 2 ? ' The next speed rung is unlocked.' : ''}` : 'Run complete with issues; see the debrief.';
    $('#m3-status').className = `status-line ${clean ? 'ok' : 'bad'}`;
    this.afterRun(rec);
    if (clean && (this.preflight.estopTested && !this.preflight.skipped.size) && (!run.surpriseShown || run.reaction <= this.mc.cfg.mission3.surpriseReactionLimitS[this.mc.mode])) this.mc.awardBadge(this, 'Safe Hands');
    this.finish();
    this.showDebrief();
  }

  summary(outcome) {
    const run = this.run;
    const straight = this.waypoints.reduce((acc, w, i) => acc + (i ? w.pos.distanceTo(this.waypoints[i - 1].pos) : 0), 0);
    return {
      outcome, overridePct: run.override, minClearanceMm: +(run.minClear * 1000).toFixed(1), minClearanceBetween: run.minPair,
      peakSpeedMmS: +(run.peak * 1000).toFixed(1), capMmS: this.capMmS(), checksGreenAtStart: run.greenAtStart, checksTotal: this.checks.length,
      overridesUsed: this.overrides.length, protectiveStops: run.protective, reactionTimeS: run.reaction !== null ? +run.reaction.toFixed(2) : null,
      surprise: run.surpriseShown ? run.surpriseKind : null, pathLengthM: +this.plan.length.toFixed(3), straightLengthM: +straight.toFixed(3),
      durationS: +run.t.toFixed(2), preflightSkipped: [...this.preflight.skipped], score: Math.round(this.score(run)?.total ?? 0),
    };
  }

  afterRun(rec) {
    this.lastRun = rec;
    $('#m3-export').disabled = false;
    $('#m3-debrief-btn').disabled = false;
    this.replay.load(rec);
    this.refreshPreflight();
    this.mc.renderHud();
  }

  exportReport() {
    if (this.lastRun) exportRun(this.lastRun, { scoreBreakdown: this.score()?.parts });
  }

  showDebrief() {
    const r = this.lastRun;
    if (!r) return;
    const s = r.summary;
    const prev = this.mc.recorder.previous('dryrun');
    const body = $('#debrief-body');
    const tiles = [
      ['Score', s.score, '/100'], ['Min clearance', s.minClearanceMm, 'mm'], ['Peak TCP speed', s.peakSpeedMmS, 'mm/s'],
      ['Checks green', s.checksGreenAtStart, `/${s.checksTotal}`], ['Overrides', s.overridesUsed, ''], ['Reaction time', s.reactionTimeS ?? '–', s.reactionTimeS !== null ? 's' : ''],
    ];
    body.replaceChildren(...[
      el('p', { class: 'small', text: `Outcome: ${s.outcome}${s.protectiveStops.length ? ` · protective stops: ${s.protectiveStops.length}` : ''}${s.surprise ? ` · surprise: ${s.surprise}` : ''}${s.preflightSkipped.length ? ` · skipped pre-flight: ${s.preflightSkipped.join(', ')}` : ''}` }),
      el('div', { class: 'tiles' }, tiles.map(([l, v, u]) => el('div', { class: 'tile' }, el('span', { class: 'tile-val', 'data-target': typeof v === 'number' ? v : '', text: typeof v === 'number' ? '0' : String(v) }), el('span', { class: 'tile-unit', text: u }), el('span', { class: 'tile-label', text: l })))),
      el('h3', { text: 'Score breakdown' }),
      el('ul', { class: 'crit' }, (this.score(this.run)?.parts ?? []).map(([l, v]) => el('li', { text: `${l}: ${Math.round(v)}` }))),
      prev ? el('h3', { text: 'Compared with your previous run' }) : null,
      prev ? el('table', { class: 'compare' }, el('thead', {}, el('tr', {}, el('th', { text: '' }), el('th', { text: 'Previous' }), el('th', { text: 'This run' }), el('th', { text: '' }))),
        el('tbody', {}, compareRows(prev, r, [['score', 'Score', '', 'higher'], ['minClearanceMm', 'Min clearance', 'mm', 'higher'], ['peakSpeedMmS', 'Peak speed', 'mm/s', 'lower'], ['overridesUsed', 'Overrides', '', 'lower'], ['reactionTimeS', 'Reaction', 's', 'lower']]))) : null,
    ].filter(Boolean));
    $('#debrief').showModal();
    // animate numbers up (instant with reduced motion)
    const tilesEls = $$('.tile-val[data-target]', body).filter((e) => e.dataset.target !== '');
    const t0 = performance.now();
    const dur = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 900;
    const stepAnim = () => {
      const k = dur ? Math.min(1, (performance.now() - t0) / dur) : 1;
      for (const e of tilesEls) { const v = Number(e.dataset.target); e.textContent = (v * (1 - (1 - k) ** 3)).toFixed(Number.isInteger(v) ? 0 : 1); }
      if (k < 1) requestAnimationFrame(stepAnim);
    };
    stepAnim();
  }

  /**
   * Score (100): pre-flight 15 (−5 per skipped item), checks green at start
   * 25 × fraction, clearance 15 × min(1, minClear / 2·threshold), speed 15
   * (peak ≤ cap), reaction 20 (no surprise → 20; E-stop in time → 20 − 10 ×
   * t/limit; too late → 0), efficiency 10 × straight/actual length; minus 15
   * per override, 10 per protective stop, hint penalty.
   */
  score(run = this.run ?? null) {
    if (!this.started) return null;
    const cfg = this.mc.cfg;
    const parts = [['Pre-flight', clamp(15 - 5 * this.preflight.skipped.size - (this.currentPf() ? 5 : 0), 0, 15)]];
    if (run) {
      parts.push(['Checks green', 25 * (run.greenAtStart / Math.max(1, this.checks.length))]);
      parts.push(['Clearance', 15 * clamp(run.minClear / (2 * cfg.mission3.minClearanceMm / 1000), 0, 1)]);
      parts.push(['Speed', run.peak * 1000 <= this.capMmS() * 1.001 ? 15 : 0]);
      const lim = cfg.mission3.surpriseReactionLimitS[this.mc.mode];
      parts.push(['Reaction', !run.surpriseShown ? 20 : run.reaction ? clamp(20 - 10 * (run.reaction / lim), 0, 20) : 0]);
      const straight = this.waypoints.reduce((acc, w, i) => acc + (i ? w.pos.distanceTo(this.waypoints[i - 1].pos) : 0), 0) + (this.plan ? this.plan.frames[0].tcp.distanceTo(this.waypoints[0].pos) : 0);
      parts.push(['Efficiency', 10 * clamp(straight / Math.max(this.plan?.length ?? 1, 1e-6), 0, 1)]);
    }
    parts.push(['Overrides', -cfg.scoring.overridePenalty * this.overrides.length]);
    parts.push(['Protective stops', -10 * this.protectiveStops]);
    parts.push(['Hints', -cfg.scoring.hintPenalty * this.hintsUsed]);
    return { total: clamp(parts.reduce((a, p) => a + p[1], 0), 0, 100), parts };
  }

  progress() {
    const pf = this.currentPf();
    const pfHint = {
      tool: 'In “1 · Pre-flight”, choose “Specimen removed” in the first box.',
      estop: 'Click “Press E-stop”, then click it again to release. This proves the emergency stop works.',
      mode: 'Choose “T1 (manual reduced speed)” in the mode box.',
      cell: 'Tick “Cell checked clear of people; door closed”.',
    }[pf];
    const red = (this.checks ?? []).filter((c) => !this.checkOk(c));
    const runHint = this.awaitAck ? 'The robot stopped. Click “Acknowledge stop”, release the E-stop if it is pressed, then click “Reset” and run again.'
      : 'Press and HOLD “Hold to run” (or hold the Space bar) until the bar is full. Let go to pause. If something unexpected appears, press E-STOP.';
    return [
      { label: 'Pre-flight', done: !pf, target: '#m3-pre', hint: pfHint },
      { label: 'Waypoints', done: this.waypoints.length > 0 && this.waypoints.every((w) => w.status === 'reached'), target: this.waypoints.length ? '#m3-wps' : '#m3-load',
        hint: this.waypoints.length ? 'A waypoint is out of reach (shown red). Delete it (✕) or move it closer to the fixture.' : 'Click “Load example path”, or click the fixture in the 3D view to add your own points.' },
      { label: 'Checks', done: !!this.runnable(), target: '#m3-checks',
        hint: red.length ? `Fix the ${red[0].state} check “${red[0].label}”: click “Why?” next to it to see how.` : 'Waiting for the checks…' },
      { label: 'Run', done: !!this.run?.done, target: this.awaitAck ? '#m3-ack-row' : '#m3-deadman', hint: runHint },
      { label: 'Debrief', done: !!this.lastRun && this.finished, target: '#m3-debrief-btn', hint: 'Read your debrief. Download the report if your tutor asks for it.' },
    ].map((x, i, arr) => ({ ...x, current: !x.done && arr.slice(0, i).every((y) => y.done) }));
  }
}

// ============================================================== bonus
class Bonus extends MissionBase {
  constructor(mc) {
    super(mc, 'bonus');
    this.briefing = null;
    this._build();
  }

  _build() {
    this.pane.append(
      el('p', { class: 'mission-intro', text: 'Quick challenges. Each is self-contained and scored on its own.' }),
      this.section('Find the Fault (60 s)',
        el('p', { text: 'Three plots of compensated sensor readings, each with one fault. Name the fault for each plot before time runs out.' }),
        el('button', { class: 'btn', type: 'button', id: 'b-fault-start', text: 'Start', onclick: () => this.startFault() }),
        el('div', { id: 'b-fault', hidden: true },
          el('p', { class: 'mono', id: 'b-fault-timer' }),
          el('canvas', { class: 'chart', id: 'b-fault-chart', height: 140, 'aria-label': 'Fault plot' }),
          el('div', { class: 'chart-legend', id: 'b-fault-legend' }),
          el('div', { class: 'btn-row' }, ...[['drift', 'Bias drift'], ['com', 'Wrong CoM'], ['noise', 'Cable noise']].map(([k, t]) => el('button', { class: 'btn small', type: 'button', text: t, onclick: () => this.answerFault(k) })))),
        el('div', { class: 'result', id: 'b-fault-result' })),
      this.section('Hotspot Hunt',
        el('p', { text: 'Read the description, then click that part in the 3D view.' }),
        el('button', { class: 'btn', type: 'button', id: 'b-hunt-start', text: 'Start', onclick: () => this.startHunt() }),
        el('p', { class: 'hunt-q', id: 'b-hunt-q' }),
        el('div', { class: 'result', id: 'b-hunt-result' })),
      this.section('Reach Test',
        el('p', { text: 'Drag the orange target. The ghost robot tries to reach it; watch reachability, the reach envelope and the wrist singularity margin.' }),
        el('button', { class: 'btn', type: 'button', id: 'b-reach-start', 'aria-pressed': 'false', text: 'Start', onclick: () => this.toggleReach() }),
        el('p', { class: 'mono small', id: 'b-reach-info' })),
    );
    this.faultChart = new StripChart($('#b-fault-chart'), $('#b-fault-legend'), 20);
    this.target = new THREE.Mesh(new THREE.SphereGeometry(0.03, 20, 14), new THREE.MeshBasicMaterial({ color: 0xff8800, depthTest: false, transparent: true }));
    this.target.renderOrder = 996;
    this.target.visible = false;
    this.mc.scene.scene.add(this.target);
    this.ghost = this.mc.robot.makeGhost(0xff8800);
    this.mc.scene.pickHandlers.push((hits) => this.onPick(hits));
  }

  deactivate() {
    if (this.reachOn) this.toggleReach();
    this.hunt = null;
    clearInterval(this.faultTimer);
  }

  // ---------------------------------------------------------- find the fault
  startFault() {
    this.faultQ = ['drift', 'com', 'noise'].sort(() => Math.random() - 0.5);
    this.faultIdx = 0;
    this.faultCorrect = 0;
    this.faultEnd = performance.now() + 60000;
    $('#b-fault').hidden = false;
    $('#b-fault-result').textContent = '';
    clearInterval(this.faultTimer);
    this.faultTimer = setInterval(() => {
      const left = (this.faultEnd - performance.now()) / 1000;
      $('#b-fault-timer').textContent = `Plot ${this.faultIdx + 1}/3 · ${Math.max(0, left).toFixed(0)} s left`;
      if (left <= 0) this.endFault('Time is up.');
    }, 200);
    this.drawFault();
  }

  drawFault() {
    const kind = this.faultQ[this.faultIdx];
    this.faultChart.clear();
    for (let i = 0; i < 400; i++) {
      const t = i * 0.05;
      const tilt = Math.sin(t * 0.6);           // the arm tilts back and forth
      const n = (s) => gauss() * s;
      let v;
      if (kind === 'drift') v = [0.06 * t + n(0.04), -0.04 * t + n(0.04), 0.08 * t + n(0.05), 0.002 * t + n(0.002), n(0.002), n(0.0015)];
      else if (kind === 'com') v = [2.2 * tilt + n(0.04), n(0.04), 0.3 * tilt * tilt + n(0.05), n(0.002), 0.35 * tilt + n(0.002), n(0.0015)];
      else v = [n(0.04) * (Math.random() < 0.05 ? 40 : 1), n(0.04) * (Math.random() < 0.05 ? 40 : 1), n(0.05) * (Math.random() < 0.05 ? 40 : 1), n(0.002), n(0.002), n(0.0015)];
      this.faultChart.push(t, v);
    }
    requestAnimationFrame(() => this.faultChart.draw());
  }

  answerFault(k) {
    if (!this.faultQ) return;
    const right = this.faultQ[this.faultIdx] === k;
    if (right) this.faultCorrect++;
    toast(right ? 'Correct.' : `No: that was ${{ drift: 'bias drift (a slow ramp)', com: 'a wrong CoM (error follows the tilt)', noise: 'cable noise (random spikes)' }[this.faultQ[this.faultIdx]]}.`, right ? 'good' : 'bad');
    this.faultIdx++;
    if (this.faultIdx >= 3) this.endFault('Done.');
    else this.drawFault();
  }

  endFault(msg) {
    clearInterval(this.faultTimer);
    const left = Math.max(0, (this.faultEnd - performance.now()) / 1000);
    this.faultScore = Math.round(this.faultCorrect * 30 + (this.faultCorrect === 3 ? Math.min(10, left / 3) : 0));
    $('#b-fault-result').textContent = `${msg} ${this.faultCorrect}/3 correct · score ${this.faultScore}/100`;
    this.faultQ = null;
    $('#b-fault').hidden = true;
    this.mc.renderHud();
  }

  // ---------------------------------------------------------- hotspot hunt
  startHunt() {
    const items = Object.entries(this.mc.hotspots.content).filter(([, v]) => v.section).sort(() => Math.random() - 0.5).slice(0, 5);
    this.hunt = { items, i: 0, correct: 0 };
    $('#b-hunt-result').textContent = '';
    this.askHunt();
  }

  askHunt() {
    const [, info] = this.hunt.items[this.hunt.i];
    const firstSentence = info.body.split('. ')[0].replace(/^(Axis \d|The|A|An) /, '');
    $('#b-hunt-q').textContent = `${this.hunt.i + 1}/5: Find the part that ${firstSentence.charAt(0).toLowerCase()}${firstSentence.slice(1)}.`;
  }

  onPick(hits) {
    if (this.mc.active !== 'bonus' || !this.hunt) return false;
    const sec = this.mc.inspector.sectionOfMesh(hits[0]?.object);
    if (!sec) return false;
    const [, info] = this.hunt.items[this.hunt.i];
    const right = sec === info.section;
    if (right) this.hunt.correct++;
    toast(right ? `Correct: ${info.title}` : `Not that one. It was: ${info.title}`, right ? 'good' : 'bad');
    this.mc.inspector.isolate(info.section);
    setTimeout(() => this.mc.inspector.isolate(null), 900);
    this.hunt.i++;
    if (this.hunt.i >= this.hunt.items.length) {
      this.huntScore = this.hunt.correct * 20;
      $('#b-hunt-result').textContent = `${this.hunt.correct}/5 · score ${this.huntScore}/100`;
      $('#b-hunt-q').textContent = '';
      this.hunt = null;
      this.mc.renderHud();
    } else this.askHunt();
    return true;
  }

  // ---------------------------------------------------------- reach test
  toggleReach() {
    this.reachOn = !this.reachOn;
    $('#b-reach-start').setAttribute('aria-pressed', String(this.reachOn));
    $('#b-reach-start').textContent = this.reachOn ? 'Stop' : 'Start';
    this.target.visible = this.reachOn;
    this.ghost.object.visible = this.reachOn;
    this.mc.inspector.setReach(this.reachOn);
    $('#tg-reach').checked = this.reachOn;
    if (this.reachOn) {
      this.target.position.copy(this.mc.robot.tcpPose().pos).add(new THREE.Vector3(0.3, 0.2, 0));
      const g = this.mc.gizmo;
      g.attach(this.target);
      g.showX = g.showY = g.showZ = true;
      this.mc.gizmoCb = () => this.solveReach();
      this.seed = this.mc.robot.getAngles();
      this.solveReach();
    } else this.mc.gizmo.detach();
    this.mc.scene.requestRender();
  }

  solveReach() {
    const r = this.mc.robot;
    const sol = r.ik(this.target.position, new THREE.Vector3(0, -1, 0), this.seed ?? r.angles);
    this.seed = sol.angles;
    this.ghost.setAngles(sol.angles);
    this.ghost.setColor(sol.status === 'reached' ? (sol.singularityDeg < this.mc.cfg.ik.singularityWarnDeg ? 0xf59e0b : 0x22c55e) : sol.status === 'partial' ? 0xf59e0b : 0xef4444);
    const stretch = r.elbowStretch(sol.angles);
    $('#b-reach-info').textContent = `${sol.status.toUpperCase()} · error ${(sol.posErr * 1000).toFixed(0)} mm · wrist |A5| ${sol.singularityDeg.toFixed(1)}°${sol.singularityDeg < this.mc.cfg.ik.singularityWarnDeg ? ' (near singularity!)' : ''} · arm stretch ${(stretch * 100).toFixed(0)}%${sol.limited.length ? ` · at limit: ${sol.limited.join(', ')}` : ''}`;
    this.mc.scene.requestRender();
  }

  score() {
    const s = [this.faultScore, this.huntScore].filter((v) => v !== undefined);
    if (!s.length) return null;
    return { total: s.reduce((a, b) => a + b, 0) / s.length, parts: [['Find the Fault', this.faultScore ?? 0], ['Hotspot Hunt', this.huntScore ?? 0]] };
  }

  progress() {
    return [
      { label: 'Find the Fault', done: this.faultScore !== undefined },
      { label: 'Hotspot Hunt', done: this.huntScore !== undefined },
      { label: 'Reach Test', done: !!this.seed },
    ].map((x) => ({ ...x, current: false }));
  }
}

