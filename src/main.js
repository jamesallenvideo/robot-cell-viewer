// Entry point: loads data and model, owns the shared state (URL hash) and
// wires the panels, presets, toggles and keyboard shortcuts.
import * as THREE from 'three';
import { Scene, reducedMotion } from './scene.js';
import { Robot } from './robot.js';
import { Inspector } from './inspect.js';
import { Hotspots } from './hotspots.js';
import { MissionControl } from './missions.js';
import { Recorder } from './report.js';
import { $, $$, el, toast, download, storageGet, storageSet, encodeState, decodeState } from './ui.js';

const ASSETS = {
  model: 'assets/kuka_lab.glb',
  hotspots: 'assets/hotspots.json',
  motion: 'assets/motion.json',
  colliders: 'assets/colliders.json',
  config: 'assets/config.defaults.json',
};

// Browsers block fetch() on pages opened from disk (file://). The standalone
// build ships js/data.js with embedded copies for that case only.
const FROM_DISK = location.protocol === 'file:';

const fetchJSON = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`${src} could not be loaded (open the page through a web server, see README)`));
    document.head.append(s);
  });
}

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function loadData() {
  if (FROM_DISK) {
    await loadScript('js/data.js');
    const d = window.KUKA_DATA;
    return { content: d.hotspots, motion: d.motion, colliders: d.colliders, cfg: d.config, model: base64ToBuffer(d.glb) };
  }
  const [content, motion, colliders, cfg] = await Promise.all([ASSETS.hotspots, ASSETS.motion, ASSETS.colliders, ASSETS.config].map(fetchJSON));
  return { content, motion, colliders, cfg, model: ASSETS.model };
}

function webglAvailable() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

async function main() {
  if (!webglAvailable()) {
    $('#webgl-error').hidden = false;
    $('#loader').hidden = true;
    return;
  }
  const scene = new Scene($('#viewport'), $('#labels'));
  applyTheme(scene);
  const t0 = performance.now();
  const setProgress = (f, text) => {
    $('#loader-bar').style.width = `${Math.round(f * 100)}%`;
    if (text) $('#loader-text').textContent = text;
  };
  let data;
  let gltf;
  try {
    data = await loadData();
    setProgress(0.05, 'Loading model…');
    gltf = await scene.load(data.model, (f) => setProgress(0.05 + 0.9 * f));
  } catch (e) {
    console.error(e);
    setProgress(1, `Could not load the model (${e.message}).`);
    return;
  }
  const loadMs = performance.now() - t0;
  $('#loader').hidden = true;

  // ------------------------------------------------------------ shared state (URL hash)
  const fromHash = location.hash.startsWith('#s=') ? decodeState(location.hash.slice(3)) : null;
  const state = { v: 1, mode: storageGet('kuka-viewer-mode') ?? 'guided', ...(fromHash ?? {}) };
  let saveT = 0;
  const saveState = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      history.replaceState(null, '', `#s=${encodeState(state)}`);
      storageSet('kuka-viewer-mode', state.mode);
    }, 250);
  };
  if (fromHash) toast('Settings restored from the link.');

  // ------------------------------------------------------------ core objects
  const narrow = window.matchMedia('(max-width: 900px)');
  const robot = new Robot(gltf.scene, data.cfg, data.colliders);
  const inspector = new Inspector(scene, robot, gltf.scene, data.content);
  const presets = makePresets(scene, inspector);
  let selected = null;
  let hotspots = null;
  let missions = null;
  const selectSection = (id, { frame = true, openInfo = true } = {}) => {
    if (id === selected) id = null;
    selected = id;
    inspector.isolate(id);
    $$('#section-list li').forEach((li) => li.setAttribute('aria-selected', String(li.dataset.id === id)));
    $('#btn-clear-isolate').disabled = !id;
    if (!id) return;
    if (narrow.matches) closeDrawers();
    const sec = inspector.sections.get(id);
    if (frame) scene.frameBox(inspector.sectionBox(id));
    if (openInfo && sec.hotspot) hotspots.open(sec.hotspot);
  };
  hotspots = new Hotspots(scene, inspector, data.content, {
    onIsolate: (id) => selectSection(id),
    onMission: (m) => { if (narrow.matches) openDrawer('#btn-toggle-right', '#mission-panel'); missions.select(m); },
  });
  const recorder = new Recorder();
  missions = new MissionControl({ scene, robot, inspector, hotspots, recorder, cfg: data.cfg, motion: data.motion, state, saveState });
  scene.beforeRender.push((dt) => missions.update(dt));
  robot.onChange(() => scene.requestRender());

  // ------------------------------------------------------------ sections
  for (const [id, s] of inspector.sections) {
    const li = el('li', { role: 'option', tabindex: '0', 'aria-selected': 'false', text: s.label });
    li.dataset.id = id;
    li.addEventListener('click', () => selectSection(id));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSection(id); } });
    $('#section-list').append(li);
  }
  $('#btn-clear-isolate').addEventListener('click', () => selectSection(null));
  // lowest-priority pick handler: clicking a part selects its section
  scene.pickHandlers.unshift((hits) => {
    const id = inspector.sectionOfMesh(hits[0]?.object);
    if (!id) return false;
    selectSection(id);
    return true;
  });

  // ------------------------------------------------------------ view controls
  $$('[data-preset]').forEach((b) => b.addEventListener('click', () => presets[b.dataset.preset]()));
  const explode = $('#explode');
  explode.addEventListener('input', () => {
    if (missions.active === 'm3') {
      explode.value = 0;
      inspector.setExplode(0);
      toast('Exploded view is off while Mission 3 is open (path checks need the assembled robot).');
      return;
    }
    inspector.setExplode(Number(explode.value));
  });
  const walls = $('#tg-walls');
  walls.addEventListener('change', () => { scene.forceHideWalls = walls.checked; scene.requestRender(); });
  $('#tg-hotspots').addEventListener('change', (e) => hotspots.setVisible(e.target.checked));
  $('#tg-wire').addEventListener('change', (e) => inspector.setWireframe(e.target.checked));
  $('#tg-axes').addEventListener('change', (e) => inspector.setJointAxes(e.target.checked));
  $('#tg-reach').addEventListener('change', (e) => inspector.setReach(e.target.checked));
  $('#tg-grid').addEventListener('change', (e) => scene.setGrid(e.target.checked));
  $('#tg-shadows').addEventListener('change', (e) => scene.setShadows(e.target.checked));

  const resetView = () => {
    selectSection(null);
    hotspots.close();
    presets.overview();
  };
  $('#btn-reset-view').addEventListener('click', resetView);
  $('#btn-screenshot').addEventListener('click', async () => download(`robot-cell-${Date.now()}.png`, await scene.screenshot(), 'image/png'));
  $('#btn-theme').addEventListener('click', () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    storageSet('kuka-viewer-theme', document.documentElement.dataset.theme);
    applyTheme(scene);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(scene));

  // drawers on narrow screens
  function closeDrawers() {
    $$('.sidebar, .mission-panel').forEach((p) => p.classList.remove('open'));
    $$('#btn-toggle-left, #btn-toggle-right').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }
  function openDrawer(btn, panel) {
    closeDrawers();
    $(panel).classList.add('open');
    $(btn).setAttribute('aria-expanded', 'true');
  }
  for (const [btn, panel] of [['#btn-toggle-left', '#sidebar'], ['#btn-toggle-right', '#mission-panel']]) {
    $(btn).addEventListener('click', () => ($(panel).classList.contains('open') ? closeDrawers() : openDrawer(btn, panel)));
  }

  // keyboard shortcuts (ignored while typing or when a button has focus)
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      hotspots.close();
      missions.closeWhy();
      closeDrawers();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === '1') presets.overview();
    else if (k === '2') presets.wrist();
    else if (k === '3') presets.base();
    else if (k === '4') presets.controller();
    else if (k === 'h') { walls.checked = !walls.checked; walls.dispatchEvent(new Event('change')); }
    else if (k === 'r') resetView();
  });

  presets.overview(0);
  // exposed for debugging and the automated tests
  window.robotCell = { THREE, scene, robot, inspector, hotspots, missions, recorder, presets, state, data, loadMs, reducedMotion };
  document.body.dataset.ready = 'true';
}

function makePresets(scene, inspector) {
  const w = (name) => inspector.nodes.get(name).getWorldPosition(new THREE.Vector3());
  const go = (target, offset, d) => scene.flyTo(target.clone().add(offset), target, d);
  return {
    // pull back on tall, narrow screens so the whole cell stays in frame
    overview: (d) => go(new THREE.Vector3(-0.3, 1.0, 0.3), new THREE.Vector3(3.85, 2.6, -4.6).multiplyScalar(Math.max(1, 1 / scene.aspect()) ** 0.75), d),
    wrist: (d) => go(w('HS_FT_Sensor'), new THREE.Vector3(0.85, 0.22, -0.95), d),
    base: (d) => go(w('A1_Rotating_Column').add(new THREE.Vector3(0, 0.3, 0)), new THREE.Vector3(1.7, 0.7, -1.5), d),
    controller: (d) => go(w('HS_Controller'), new THREE.Vector3(1.9, 0.55, -0.9), d),
  };
}

function applyTheme(scene) {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--scene-bg').trim();
  scene.setBackground(bg || '#dfe3e8');
}

main().catch((e) => {
  console.error(e);
  const t = $('#loader-text');
  if (t) t.textContent = `Something went wrong: ${e.message}`;
});
