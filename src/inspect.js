// Inspection tools: sections, isolate / highlight, exploded view, wireframe,
// joint axes, reach envelope and part visibility.
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const AXIS_COLORS = { A1: 0xe4572e, A2: 0x17a398, A3: 0x4c6ef5, A4: 0xe09f1f, A5: 0x9b5de5, A6: 0xd6336c };
const TOOL_PARTS = ['Adapter_Plate', 'FT_Sensor', 'Gripper_Block', 'Specimen_Shaft'];
// Illustrative flange reach from the A2 axis (upper arm + forearm + wrist), not manufacturer data.
export const REACH_RADIUS = 1.05 + 1.10 + 0.215;

export class Inspector {
  constructor(scene, robot, root, content) {
    this.scene = scene;
    this.robot = robot;
    this.root = root;
    this.nodes = new Map();
    root.traverse((o) => { if (o.name && !this.nodes.has(o.name)) this.nodes.set(o.name, o); });
    this.meshes = [];
    root.traverse((o) => {
      if (o.isMesh) {
        o.userData.baseMat = o.material;
        o.userData.castShadowBase = o.castShadow;
        this.meshes.push(o);
      }
    });
    this.variants = new Map();
    this.wireframe = false;
    this.isolated = null;
    this.highlighted = new Map();    // section id -> colour
    this._buildSections(content.sections);
    this._captureExplode();
  }

  // ---------------------------------------------------------------- sections
  _buildSections(defs) {
    this.sections = new Map();
    this.meshSection = new Map();
    for (const def of defs) {
      const meshes = new Set();
      const stop = new Set(def.exclude);
      const walk = (o) => {
        if (stop.has(o.name)) return;
        if (o.isMesh) meshes.add(o);
        o.children.forEach(walk);
      };
      for (const r of def.roots) {
        const n = this.nodes.get(r);
        if (n) walk(n);
        else console.warn(`Section ${def.id}: node ${r} not found`);
      }
      this.sections.set(def.id, { ...def, meshes });
      for (const m of meshes) this.meshSection.set(m, def.id);
    }
  }

  sectionOfMesh(mesh) { return mesh ? this.meshSection.get(mesh) ?? null : null; }

  sectionBox(id) {
    const box = new THREE.Box3();
    for (const m of this.sections.get(id).meshes) if (m.visible) box.expandByObject(m);
    return box;
  }

  _variant(base, kind, color) {
    const key = `${base.uuid}:${kind}:${color ?? ''}`;
    let v = this.variants.get(key);
    if (!v) {
      v = base.clone();
      if (kind === 'dim') {
        v.transparent = true;
        v.opacity = 0.25;
        v.depthWrite = false;
      } else if (kind === 'alert') {
        v.emissive = new THREE.Color(color);
        v.emissiveIntensity = 0.85;
        v.color = new THREE.Color(color);
      }
      v.wireframe = this.wireframe;
      this.variants.set(key, v);
    }
    return v;
  }

  _apply() {
    for (const m of this.meshes) {
      const sec = this.meshSection.get(m);
      let mat = m.userData.baseMat;
      if (sec && this.highlighted.has(sec)) mat = this._variant(m.userData.baseMat, 'alert', this.highlighted.get(sec));
      else if (this.isolated && sec !== this.isolated) mat = this._variant(m.userData.baseMat, 'dim');
      m.material = mat;
      m.castShadow = mat.opacity === 1 && m.userData.castShadowBase !== false;
    }
    this.scene.requestRender();
  }

  isolate(id) { this.isolated = id; this._apply(); }

  /** Tint sections (e.g. a joint at its limit, a link in collision). */
  highlight(ids, color = 0xff3030) {
    this.highlighted = new Map(ids.map((id) => [id, color]));
    this._apply();
  }

  /** Short red flash on a section (joint-limit "bumper"). */
  flash(id, ms = 350) {
    this.highlight([id], 0xff2020);
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => this.highlight([]), ms);
  }

  setWireframe(on) {
    this.wireframe = on;
    for (const m of this.meshes) m.userData.baseMat.wireframe = on;
    for (const v of this.variants.values()) v.wireframe = on;
    this.scene.requestRender();
  }

  setPartVisible(name, on) {
    const n = this.nodes.get(name);
    if (n) n.visible = on;
    this.scene.requestRender();
  }

  // ---------------------------------------------------------------- exploded view
  // Each joint node is pushed along its own rotation axis (the direction a
  // rotary joint comes apart); tool parts along the tool axis. Positions are
  // restored exactly from the stored rest values at zero.
  _captureExplode() {
    this.explodeParts = this.robot.joints.map((j) => ({ node: j.node, rest: j.node.position.clone(), dir: j.axis.clone(), gap: 0.16 }));
    const stack = this.nodes.get('Tool_Stack');
    const toolDir = stack.worldToLocal(this.robot.tcp.getWorldPosition(new THREE.Vector3())).normalize();
    TOOL_PARTS.forEach((name, i) => {
      const n = this.nodes.get(name);
      if (n) this.explodeParts.push({ node: n, rest: n.position.clone(), dir: toolDir.clone(), gap: 0.07 * (i + 1) });
    });
    this.explode = 0;
  }

  setExplode(s) {
    this.explode = s;
    for (const p of this.explodeParts) {
      if (s === 0) p.node.position.copy(p.rest);
      else p.node.position.copy(p.rest).addScaledVector(p.dir, p.gap * s);
    }
    this.root.updateMatrixWorld(true);
    this.scene.requestRender();
  }

  // ---------------------------------------------------------------- helpers
  setJointAxes(on) {
    if (!this.axisHelpers) {
      this.axisHelpers = this.robot.joints.map((j) => {
        const v = j.axis.clone();
        const g = new THREE.BufferGeometry().setFromPoints([v.clone().multiplyScalar(-0.42), v.clone().multiplyScalar(0.42)]);
        const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: AXIS_COLORS[j.id], depthTest: false, transparent: true }));
        line.renderOrder = 999;
        line.name = `axis_${j.id}`;
        const tag = new CSS2DObject(Object.assign(document.createElement('span'), { className: 'tag', textContent: j.id }));
        tag.position.copy(v.multiplyScalar(0.47));
        line.add(tag);
        j.node.add(line);
        return line;
      });
    }
    for (const h of this.axisHelpers) h.visible = on;
    this.scene.requestRender();
  }

  setReach(on) {
    if (!this.reach) {
      const a2 = this.robot.joints[1].node.getWorldPosition(new THREE.Vector3());
      const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const geo = new THREE.SphereGeometry(REACH_RADIUS, 48, 24);
      const common = { color: 0xf07a2e, transparent: true, depthWrite: false, clippingPlanes: [floor] };
      this.reach = new THREE.Group();
      this.reach.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ ...common, opacity: 0.06, side: THREE.DoubleSide })));
      this.reach.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ ...common, opacity: 0.16, wireframe: true })));
      this.reach.traverse((o) => { o.userData.noPick = true; });
      this.reach.position.copy(a2);
      const tag = new CSS2DObject(Object.assign(document.createElement('span'), {
        className: 'tag', textContent: `Illustrative flange reach ≈ ${REACH_RADIUS.toFixed(2)} m from A2 (not manufacturer data)`,
      }));
      tag.position.set(0, REACH_RADIUS * 0.72, 0);
      this.reach.add(tag);
      this.reach.name = 'Reach_Envelope';
      this.scene.scene.add(this.reach);
    }
    this.reach.visible = on;
    this.scene.requestRender();
  }
}
