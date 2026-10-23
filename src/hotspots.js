// Pulsing hotspot markers anchored to HS_* nodes (or anchors derived from a
// part's bounding box when the model has no HS_* node), with an
// occlusion-aware fade, the info card and keyboard access.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { isShown } from './scene.js';
import { $ } from './ui.js';

export class Hotspots {
  constructor(scene, inspector, content, { onIsolate, onMission }) {
    this.scene = scene;
    this.inspector = inspector;
    this.content = content.hotspots;
    this.onIsolate = onIsolate;
    this.onMission = onMission;
    this.items = [];
    this.derived = [];
    this.active = null;
    this.raycaster = new THREE.Raycaster();
    let i = 0;
    for (const [id, info] of Object.entries(this.content)) {
      const node = this._anchor(id, info);
      if (!node) continue;
      i += 1;
      const btn = document.createElement('button');
      btn.className = 'hotspot';
      btn.type = 'button';
      btn.textContent = String(i);
      btn.setAttribute('aria-label', `Hotspot ${i}: ${info.title}`);
      btn.title = info.title;
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.open(id); });
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      const obj = new CSS2DObject(btn);
      obj.name = `marker_${id}`;
      node.add(obj);
      this.items.push({ id, node, obj, btn, info });
    }
    this.lastOcclusion = 0;
    scene.afterRender.push(() => this._occlusion());
    $('#info-close').addEventListener('click', () => this.close());
    $('#info-focus').addEventListener('click', () => this.active && this.focus(this.active));
    $('#info-isolate').addEventListener('click', () => {
      const sec = this.active && this.content[this.active].section;
      if (sec) this.onIsolate(sec);
    });
    $('#info-mission').addEventListener('click', () => {
      const m = this.active && this.content[this.active].mission;
      if (m) this.onMission(m);
    });
  }

  /** The HS_* node, or an anchor derived from the named part's bounding box. */
  _anchor(id, info) {
    const existing = this.inspector.nodes.get(id);
    if (existing) return existing;
    const d = info.derive;
    const part = d && this.inspector.nodes.get(d.part);
    if (!part) {
      console.warn(`Hotspot ${id}: no HS node and no derivable part`);
      return null;
    }
    const box = new THREE.Box3().setFromObject(part);
    const world = box.getCenter(new THREE.Vector3());
    if (d.at === 'top') world.y = box.max.y;
    if (d.offset) world.add(new THREE.Vector3(...d.offset));
    const anchor = new THREE.Object3D();
    anchor.name = id;
    part.add(anchor);
    anchor.position.copy(part.worldToLocal(world));
    this.inspector.nodes.set(id, anchor);
    this.derived.push(id);
    return anchor;
  }

  setVisible(on) {
    for (const it of this.items) it.obj.visible = on;
    this.scene.requestRender();
  }

  /** Strong pulse on one hotspot (guidance from missions); null clears. */
  pulse(id) {
    for (const it of this.items) it.btn.classList.toggle('pulse-strong', it.id === id);
  }

  worldPos(id) { return this.inspector.nodes.get(id).getWorldPosition(new THREE.Vector3()); }

  open(id) {
    const info = this.content[id];
    if (!info) return;
    this.active = id;
    for (const it of this.items) it.btn.classList.toggle('active', it.id === id);
    $('#info-title').textContent = info.title;
    $('#info-body').textContent = info.body;
    const lab = $('#info-lab');
    lab.hidden = !info.labNote;
    lab.textContent = info.labNote ?? '';
    $('#info-isolate').hidden = !info.section;
    const mb = $('#info-mission');
    mb.hidden = !info.mission;
    mb.textContent = info.mission ? `Related mission: ${info.missionLabel ?? info.mission}` : '';
    $('#info-card').hidden = false;
    $('#info-close').focus({ preventScroll: true });
  }

  close() {
    const wasOpen = this.active;
    this.active = null;
    for (const it of this.items) it.btn.classList.remove('active');
    $('#info-card').hidden = true;
    if (wasOpen) this.items.find((i) => i.id === wasOpen)?.btn.focus({ preventScroll: true });
  }

  focus(id) {
    const target = this.worldPos(id);
    const dir = this.scene.camera.position.clone().sub(target).normalize();
    this.scene.flyTo(target.clone().addScaledVector(dir, 1.1), target);
  }

  _occlusion() {
    const now = performance.now();
    if (now - this.lastOcclusion < 120) {
      clearTimeout(this._occT);
      this._occT = setTimeout(() => this.scene.requestRender(), 130);
      return;
    }
    this.lastOcclusion = now;
    const cam = this.scene.camera.position;
    const targets = this.inspector.meshes.filter(isShown);
    for (const it of this.items) {
      if (!it.obj.visible) continue;
      const p = it.node.getWorldPosition(new THREE.Vector3());
      const dir = p.clone().sub(cam);
      const dist = dir.length();
      this.raycaster.set(cam, dir.normalize());
      this.raycaster.far = dist;
      const hit = this.raycaster.intersectObjects(targets, false)[0];
      it.btn.classList.toggle('occluded', !!hit && hit.distance < dist - 0.04);
    }
  }
}
