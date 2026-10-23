// Loading, lighting, camera, controls, picking and the render-on-demand loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Interior room bounds (glTF axes): a wall is hidden while the camera is outside it.
export const ROOM = {
  yMax: 2.7,
  walls: { Wall_E: ['x', 2.25, 1], Wall_W: ['x', -2.25, -1], Wall_N: ['z', 2.0, 1], Wall_S: ['z', -2.0, -1] },
};

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Scene {
  constructor(canvas, labelsEl) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.03, 60);
    this.camera.position.set(3.55, 3.6, -4.3);
    this.labels = new CSS2DRenderer({ element: labelsEl });

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.35;
    this.controls.maxDistance = 12;
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(86);   // stay above the floor
    this.controls.target.set(-0.3, 1.0, 0.3);
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.addEventListener('start', () => { this.tween = null; });

    this._lights();
    this.dirty = true;
    this.tween = null;
    this.forceHideWalls = false;
    this.wallNodes = {};
    this.ceilingNode = null;
    this.beforeRender = [];
    this.afterRender = [];
    this.clock = new THREE.Clock();
    this.frameTimes = [];
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._resize();
    this._setupPicking();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  _lights() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8d939b, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(1.6, 6.0, -2.2);
    key.target.position.set(-0.3, 0.6, 0.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 1, far: 12 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.keyLight = key;
    this.scene.add(key, key.target);
    // soft fill under the two ceiling light panels (area-light stand-ins)
    for (const z of [-0.8, 1.0]) {
      const p = new THREE.PointLight(0xfff6ea, 2.2, 0, 2);
      p.position.set(-0.55, 2.55, z);
      this.scene.add(p);
    }
    // optional reference grid (toggle)
    this.grid = new THREE.GridHelper(4.4, 22, 0x6b7785, 0x9aa5b1);
    this.grid.position.y = 0.002;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.45;
    this.grid.visible = false;
    this.scene.add(this.grid);
  }

  setBackground(css) {
    this.scene.background = new THREE.Color(css);
    this.requestRender();
  }

  setGrid(on) { this.grid.visible = on; this.requestRender(); }

  setShadows(on) {
    this.keyLight.castShadow = on;
    this.requestRender();
  }

  /** Load from a URL or parse an ArrayBuffer (embedded copy used when opened from disk). */
  async load(source, onProgress) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = source instanceof ArrayBuffer
      ? await loader.parseAsync(source, '')
      : await loader.loadAsync(source, (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); });
    gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.scene.add(gltf.scene);
    for (const name of Object.keys(ROOM.walls)) this.wallNodes[name] = gltf.scene.getObjectByName(name);
    this.ceilingNode = gltf.scene.getObjectByName('Ceiling');
    for (const n of [...Object.values(this.wallNodes), this.ceilingNode]) n?.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    this.root = gltf.scene;
    this.requestRender();
    return gltf;
  }

  requestRender() { this.dirty = true; }

  _resize() {
    const host = this.canvas.parentElement;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  aspect() { return (this.canvas.clientWidth / this.canvas.clientHeight) || this.camera.aspect; }

  _cullWalls() {
    const c = this.camera.position;
    for (const [name, [axis, value, sign]] of Object.entries(ROOM.walls)) {
      const n = this.wallNodes[name];
      if (n) n.visible = !(this.forceHideWalls || (c[axis] - value) * sign > 0);
    }
    if (this.ceilingNode) this.ceilingNode.visible = !(this.forceHideWalls || c.y > ROOM.yMax);
  }

  _frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    for (const cb of this.beforeRender) cb(dt);
    if (this.tween) this._stepTween(dt);
    if (this.controls.update()) this.dirty = true;
    if (!this.dirty) return;
    this.dirty = false;
    const t0 = performance.now();
    this._cullWalls();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
    for (const cb of this.afterRender) cb();
    this.frameTimes.push(performance.now() - t0);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
  }

  // ------------------------------------------------------------ camera moves
  flyTo(position, target, duration = 1.1) {
    if (reducedMotion() || duration <= 0) {
      this.camera.position.copy(position);
      this.controls.target.copy(target);
      this.tween = null;
      this.requestRender();
      return;
    }
    this.tween = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: position.clone(), t1: target.clone(), time: 0, duration };
  }

  _stepTween(dt) {
    const tw = this.tween;
    tw.time += dt;
    const k = Math.min(1, tw.time / tw.duration);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    this.camera.position.lerpVectors(tw.p0, tw.p1, e);
    this.controls.target.lerpVectors(tw.t0, tw.t1, e);
    if (k >= 1) this.tween = null;
    this.dirty = true;
  }

  frameBox(box) {
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.12);
    const dist = Math.min(Math.max(radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 1.15, 0.6), 9);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.flyTo(center.clone().addScaledVector(dir, dist), center);
  }

  // ------------------------------------------------------------ drag handles
  /** A TransformControls gizmo that pauses orbiting while dragging. */
  makeGizmo({ mode = 'translate', size = 0.7 } = {}) {
    const tc = new TransformControls(this.camera, this.canvas);
    tc.setMode(mode);
    tc.setSize(size);
    tc.addEventListener('dragging-changed', (e) => { this.controls.enabled = !e.value; this.gizmoDragging = e.value; });
    tc.addEventListener('change', () => this.requestRender());
    this.scene.add(tc.getHelper());
    return tc;
  }

  // ------------------------------------------------------------ picking
  _setupPicking() {
    this.raycaster = new THREE.Raycaster();
    this.pickHandlers = [];   // functions(hit, event) -> true if handled
    let down = null;
    this.canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!down || !this.root || this.gizmoDragging) { down = null; return; }
      const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]);
      down = null;
      if (moved > 5) return;
      const hits = this.pick(e.clientX, e.clientY);
      for (const h of [...this.pickHandlers].reverse()) if (h(hits, e)) return;
    });
  }

  /** All visible mesh hits under a screen point, nearest first. */
  pick(clientX, clientY, objects = null) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets = objects ?? [this.root, ...this.scene.children.filter((c) => c.userData.pickable)];
    return this.raycaster.intersectObjects(targets, true).filter((h) => h.object.isMesh && isShown(h.object) && !h.object.userData.noPick);
  }

  screenshot() {
    this._cullWalls();
    this.renderer.render(this.scene, this.camera);
    return new Promise((res) => this.canvas.toBlob(res, 'image/png'));
  }

  fps() {
    if (!this.frameTimes.length) return null;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return { renderMs: avg, fpsCap: Math.min(60, 1000 / avg) };
  }
}

export function isShown(o) {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}
