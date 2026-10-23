// Robot kinematics built from the GLB's own joint nodes: joint map, forward
// kinematics, jogging with limits, damped-least-squares IK, singularity and
// clearance checks, path planning and the ghost (preview) robot.
// All limits / speeds come from config.defaults.json and are illustrative.
import * as THREE from 'three';

export const JOINTS = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];
const DEG = Math.PI / 180;
const AXIS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const LINK_INDEX = { A0: 0, A1: 1, A2: 2, A3: 3, A4: 4, A5: 5, A6: 6 };

export class Robot {
  /**
   * @param {THREE.Object3D} root  loaded glTF scene
   * @param {object} cfg           config.defaults.json
   * @param {object} colliders     colliders.json (bounding volumes)
   */
  constructor(root, cfg, colliders) {
    this.root = root;
    this.cfg = cfg;
    this.joints = JOINTS.map((id) => {
      const c = cfg.joints[id];
      const node = root.getObjectByName(c.node);
      if (!node) throw new Error(`Joint node ${c.node} (${id}) not found in the model`);
      return { id, node, axis: AXIS[c.axis].clone(), sign: c.sign, min: c.min, max: c.max, maxSpeed: c.maxSpeedDegS, rest: node.position.clone() };
    });
    this.byId = Object.fromEntries(this.joints.map((j) => [j.id, j]));
    this.tcp = root.getObjectByName(cfg.tcpNode);
    this.sensor = root.getObjectByName(cfg.sensorNode);
    this.base = this.joints[0].node.parent;
    root.updateMatrixWorld(true);
    // current angles from the GLB rest pose
    this.angles = Object.fromEntries(this.joints.map((j) => [j.id, this._angleFromQuat(j)]));
    // constant offsets of TCP and sensor in the A6 frame
    const a6inv = this.joints[5].node.matrixWorld.clone().invert();
    this.tcpInA6 = a6inv.clone().multiply(this.tcp.matrixWorld);
    this.sensorInA6 = a6inv.clone().multiply(this.sensor.matrixWorld);
    this.clearance = new Clearance(this, colliders);
    this.listeners = [];
    this._m = JOINTS.map(() => new THREE.Matrix4());
    this._tmp = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
  }

  _angleFromQuat(j) {
    const q = j.node.quaternion;
    const phi = 2 * Math.atan2(q.x * j.axis.x + q.y * j.axis.y + q.z * j.axis.z, q.w);
    return wrap180(phi / DEG) * j.sign;
  }

  onChange(fn) { this.listeners.push(fn); }

  // ------------------------------------------------------------ joint state
  /** Apply angles (deg). Returns ids that hit a limit when clamping. */
  setAngles(angles, { clamp = true, silent = false } = {}) {
    const hit = [];
    for (const j of this.joints) {
      if (angles[j.id] === undefined) continue;
      let a = angles[j.id];
      if (clamp && (a < j.min || a > j.max)) {
        hit.push(j.id);
        a = Math.min(j.max, Math.max(j.min, a));
      }
      this.angles[j.id] = a;
      j.node.quaternion.setFromAxisAngle(j.axis, j.sign * a * DEG);
    }
    this.base.updateMatrixWorld(true);
    if (!silent) for (const fn of this.listeners) fn(this.angles, hit);
    return hit;
  }

  getAngles() { return { ...this.angles }; }

  // ------------------------------------------------------------ forward kinematics
  /**
   * Chain FK from the joints' rest translations and axes (independent of the
   * rendered nodes, so it can be evaluated for any angles). Returns world
   * matrices of A1..A6 plus the TCP and sensor.
   */
  fk(angles = this.angles) {
    const m = this._m;
    let parent = this.base.matrixWorld;
    for (let i = 0; i < 6; i++) {
      const j = this.joints[i];
      this._q.setFromAxisAngle(j.axis, j.sign * angles[j.id] * DEG);
      this._tmp.compose(j.rest, this._q, ONE);
      m[i].multiplyMatrices(parent, this._tmp);
      parent = m[i];
    }
    const tcp = new THREE.Matrix4().multiplyMatrices(m[5], this.tcpInA6);
    const sensor = new THREE.Matrix4().multiplyMatrices(m[5], this.sensorInA6);
    const flange = new THREE.Vector3().setFromMatrixPosition(m[5]);
    const pos = new THREE.Vector3().setFromMatrixPosition(tcp);
    return { joints: m.map((x) => x.clone()), tcp, sensor, pos, dir: pos.clone().sub(flange).normalize() };
  }

  tcpPose(angles = this.angles) {
    const f = this.fk(angles);
    return { pos: f.pos, dir: f.dir };
  }

  /** Wrist singularity: A4 and A6 axes align when A5 → 0 (returns |A5| in deg). */
  wristSingularityDeg(angles = this.angles) { return Math.abs(wrap180(angles.A5)); }

  /** Elbow stretch: 1.0 = fully extended (boundary singularity). */
  elbowStretch(angles = this.angles) {
    const f = this.fk(angles);
    const a2 = new THREE.Vector3().setFromMatrixPosition(f.joints[1]);
    const a3 = new THREE.Vector3().setFromMatrixPosition(f.joints[2]);
    const a5 = new THREE.Vector3().setFromMatrixPosition(f.joints[4]);
    return a2.distanceTo(a5) / (a2.distanceTo(a3) + a3.distanceTo(a5));
  }

  limitStatus(angles = this.angles, warnDeg = 5) {
    const out = {};
    for (const j of this.joints) {
      const a = angles[j.id];
      out[j.id] = a < j.min || a > j.max ? 'bad' : (a - j.min < warnDeg || j.max - a < warnDeg) ? 'warn' : 'ok';
    }
    return out;
  }

  // ------------------------------------------------------------ inverse kinematics
  /**
   * Damped least squares on the free joints so the TCP reaches `pos` with the
   * tool axis along `dir` (unit vector; optional). Seeded from `seed`;
   * respects joint limits; lightly regularised towards the seed so redundant
   * joints (A4) stay put unless needed.
   * @returns {{angles, status:'reached'|'partial'|'unreachable', posErr, oriErrDeg, limited, singularityDeg, iterations}}
   */
  ik(pos, dir = null, seed = this.angles, opts = {}) {
    const ikc = this.cfg.ik;
    const free = opts.free ?? ['A1', 'A2', 'A3', 'A4', 'A5'];
    const maxIt = opts.maxIterations ?? ikc.maxIterations;
    const wOri = 0.3;        // m per unit of direction error
    const wReg = 1e-5;       // tie-breaker towards the seed (per degree); must stay far below the 2 mm tolerance
    let q = { ...seed };
    let lambda = ikc.damping;
    const resid = (a) => {
      const p = this.tcpPose(a);
      const r = [p.pos.x - pos.x, p.pos.y - pos.y, p.pos.z - pos.z];
      if (dir) r.push(...[p.dir.x - dir.x, p.dir.y - dir.y, p.dir.z - dir.z].map((v) => v * wOri));
      for (const id of free) r.push((a[id] - seed[id]) * wReg * (id === 'A4' ? 4 : 1));
      return r;
    };
    const norm2 = (r) => r.reduce((s, v) => s + v * v, 0);
    let r = resid(q);
    let it = 0;
    for (; it < maxIt; it++) {
      const posErr = Math.hypot(r[0], r[1], r[2]);
      if (posErr < ikc.positionTolerance * 0.25 && (!dir || Math.hypot(r[3], r[4], r[5]) / wOri < 0.002)) break;
      const h = 0.01;
      const Jcols = free.map((id) => {
        const q2 = { ...q, [id]: q[id] + h };
        const r2 = resid(q2);
        return r2.map((v, k) => (v - r[k]) / h);
      });
      const n = free.length;
      const A = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => {
        let s = 0;
        for (let k = 0; k < r.length; k++) s += Jcols[a][k] * Jcols[b][k];
        return s + (a === b ? lambda * lambda * 1e-4 : 0);
      }));
      const g = Jcols.map((col) => -col.reduce((s, v, k) => s + v * r[k], 0));
      let dq;
      try { dq = solveLinear(A, g); } catch { lambda *= 4; continue; }
      const step = Math.max(...dq.map(Math.abs));
      if (step > 10) dq = dq.map((v) => (v * 10) / step);
      const trial = { ...q };
      free.forEach((id, k) => {
        const j = this.byId[id];
        trial[id] = Math.min(j.max, Math.max(j.min, q[id] + dq[k]));
      });
      const rt = resid(trial);
      if (norm2(rt) < norm2(r)) {
        q = trial; r = rt; lambda = Math.max(lambda * 0.5, 1e-4);
      } else {
        lambda *= 3;
        if (lambda > 1e4) break;
      }
    }
    const p = this.tcpPose(q);
    const posErr = p.pos.distanceTo(pos);
    const oriErrDeg = dir ? Math.acos(Math.min(1, Math.max(-1, p.dir.dot(dir)))) / DEG : 0;
    const limited = this.joints.filter((j) => Math.abs(q[j.id] - j.min) < 0.05 || Math.abs(q[j.id] - j.max) < 0.05).map((j) => j.id);
    let status = 'unreachable';
    if (posErr <= ikc.positionTolerance && oriErrDeg <= ikc.orientationToleranceDeg) status = 'reached';
    else if (posErr <= ikc.partialTolerance) status = 'partial';
    return { angles: q, status, posErr, oriErrDeg, limited, singularityDeg: this.wristSingularityDeg(q), iterations: it };
  }

  // ------------------------------------------------------------ path planning
  /**
   * Straight-line (LIN) path through waypoints with optional corner blends,
   * time-parameterised from each waypoint's speed and the override, then
   * solved with IK at `rate` Hz. Tool axis is interpolated between waypoints.
   * waypoints: [{ pos:Vector3, dir:Vector3, speedMmS, blendMm }]
   */
  planPath(startAngles, waypoints, { overridePct = 10, rate = 30, accel = 0.6 } = {}) {
    const start = this.tcpPose(startAngles);
    const pts = [{ pos: start.pos, dir: start.dir, speed: waypoints[0]?.speedMmS ?? 250, blend: 0 }]
      .concat(waypoints.map((w) => ({ pos: w.pos.clone(), dir: w.dir.clone().normalize(), speed: w.speedMmS, blend: (w.blendMm ?? 0) / 1000 })));
    // dense geometric path with blends (quadratic Bézier around blended corners)
    const dense = [];   // {pos, dir, vmax, wp (index reached at this sample or -1)}
    const push = (pos, dir, vmax, wp = -1, stop = false) => dense.push({ pos, dir, vmax, wp, stop });
    push(pts[0].pos.clone(), pts[0].dir.clone(), 0, 0, true);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      const vSeg = (b.speed / 1000) * (overridePct / 100);
      const ab = b.pos.clone().sub(a.pos);
      const lenAB = ab.length();
      const rIn = a.blend > 0 && i > 1 ? Math.min(a.blend, lenAB / 2) : 0;
      const rOut = c && b.blend > 0 ? Math.min(b.blend, lenAB / 2, b.pos.distanceTo(c.pos) / 2) : 0;
      const s0 = rIn;
      const s1 = lenAB - rOut;
      const n = Math.max(2, Math.ceil((s1 - s0) / 0.005));
      for (let k = 1; k <= n; k++) {
        const s = s0 + ((s1 - s0) * k) / n;
        const t = lenAB > 0 ? s / lenAB : 1;
        const pos = a.pos.clone().addScaledVector(ab, t);
        const dir = a.dir.clone().lerp(b.dir, t).normalize();
        const atEnd = k === n && rOut === 0;
        push(pos, dir, vSeg, atEnd ? i : -1, atEnd);
      }
      if (rOut > 0) {
        const p0 = b.pos.clone().addScaledVector(ab.clone().normalize(), -rOut);
        const bc = c.pos.clone().sub(b.pos).normalize();
        const p2 = b.pos.clone().addScaledVector(bc, rOut);
        const vNext = (c.speed / 1000) * (overridePct / 100);
        const m = Math.max(4, Math.ceil((2 * rOut) / 0.005));
        for (let k = 1; k <= m; k++) {
          const t = k / m;
          const pos = p0.clone().multiplyScalar((1 - t) ** 2).addScaledVector(b.pos, 2 * (1 - t) * t).addScaledVector(p2, t * t);
          const dir = b.dir.clone().lerp(c.dir, t).normalize();
          push(pos, dir, Math.min(vSeg, vNext), k === Math.round(m / 2) ? i : -1, false);
        }
      }
    }
    // velocity profile: forward/backward acceleration-limited pass
    const N = dense.length;
    const ds = dense.map((d, i) => (i ? d.pos.distanceTo(dense[i - 1].pos) : 0));
    const v = dense.map((d) => (d.stop ? 0 : d.vmax));
    for (let i = 1; i < N; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * accel * ds[i]));
    for (let i = N - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * accel * ds[i + 1]));
    // time stamps
    const tAt = [0];
    for (let i = 1; i < N; i++) {
      const vAvg = Math.max((v[i] + v[i - 1]) / 2, 1e-4);
      tAt.push(tAt[i - 1] + ds[i] / vAvg);
    }
    const duration = tAt[N - 1];
    // resample uniformly in time and solve IK
    const frames = [];
    let seed = { ...startAngles };
    let k = 0;
    const steps = Math.max(1, Math.ceil(duration * rate));
    const wpTimes = dense.map((d, i) => (d.wp > 0 ? { wp: d.wp, t: tAt[i] } : null)).filter(Boolean);
    for (let s = 0; s <= steps; s++) {
      const t = (duration * s) / steps;
      while (k < N - 2 && tAt[k + 1] < t) k++;
      const span = tAt[k + 1] - tAt[k] || 1;
      const u = Math.min(1, Math.max(0, (t - tAt[k]) / span));
      const pos = dense[k].pos.clone().lerp(dense[Math.min(k + 1, N - 1)].pos, u);
      const dir = dense[k].dir.clone().lerp(dense[Math.min(k + 1, N - 1)].dir, u).normalize();
      const sol = this.ik(pos, dir, seed, { maxIterations: 25 });
      seed = sol.angles;
      frames.push({ t, angles: sol.angles, target: pos, status: sol.status, posErr: sol.posErr });
    }
    // speeds from solved TCP positions
    for (let i = 0; i < frames.length; i++) {
      const p = this.tcpPose(frames[i].angles).pos;
      frames[i].tcp = p;
      frames[i].speed = i ? p.distanceTo(frames[i - 1].tcp) / Math.max(frames[i].t - frames[i - 1].t, 1e-6) : 0;
      if (i) {
        frames[i].jointSpeed = Object.fromEntries(JOINTS.map((id) => [id, Math.abs(frames[i].angles[id] - frames[i - 1].angles[id]) / Math.max(frames[i].t - frames[i - 1].t, 1e-6)]));
      }
    }
    return { frames, duration, waypointTimes: wpTimes, length: ds.reduce((a, b) => a + b, 0) };
  }

  // ------------------------------------------------------------ ghost robot
  /** Translucent copy of the moving arm for previewing IK poses. */
  makeGhost(color = 0x3b82f6) {
    const src = this.joints[0].node;
    const ghost = src.clone(true);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, depthWrite: false });
    const drop = [];
    ghost.traverse((o) => {
      if (o.isCSS2DObject || o.name.startsWith('HS_') || o.name.startsWith('axis_')) drop.push(o);
      if (o.isMesh) { o.material = mat; o.castShadow = false; o.receiveShadow = false; o.userData.noPick = true; }
    });
    drop.forEach((o) => o.parent?.remove(o));
    ghost.name = 'Ghost_Robot';
    src.parent.add(ghost);
    const nodes = Object.fromEntries(this.joints.map((j) => [j.id, j.id === 'A1' ? ghost : ghost.getObjectByName(j.node.name)]));
    ghost.visible = false;
    return {
      object: ghost,
      material: mat,
      setAngles: (a) => {
        for (const j of this.joints) nodes[j.id].quaternion.setFromAxisAngle(j.axis, j.sign * a[j.id] * DEG);
        ghost.updateMatrixWorld(true);
      },
      setColor: (c) => mat.color.set(c),
    };
  }
}

const ONE = new THREE.Vector3(1, 1, 1);
export const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-14) throw new Error('singular system');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// ---------------------------------------------------------------- clearance
/**
 * Bounding-volume clearance (port of tools/c4d/anim.py): robot links are
 * capsules in their joint frames, obstacles are planes / boxes / vertical
 * cylinders in world coordinates. Illustrative volumes, not mesh-accurate.
 */
export class Clearance {
  constructor(robot, colliders) {
    this.robot = robot;
    this.minLinkGap = colliders.self_check_min_link_gap ?? 3;
    this.caps = colliders.robot.map((c) => ({
      ...c, jointIndex: JOINTS.indexOf(c.joint), a: new THREE.Vector3(...c.a), b: new THREE.Vector3(...c.b),
      wa: new THREE.Vector3(), wb: new THREE.Vector3(), link: LINK_INDEX[c.joint],
    }));
    this.env = colliders.environment.map((e) => ({ ...e }));
    this.extra = [];            // runtime obstacles, e.g. the surprise event
    this.excluded = new Set();  // capsule names to ignore (e.g. specimen removed)
  }

  setExtraObstacles(list) { this.extra = list; }

  /** Min distances for `angles` (defaults to current). */
  evaluate(angles = this.robot.angles, samples = 9) {
    const f = this.robot.fk(angles);
    const caps = this.caps.filter((c) => !this.excluded.has(c.name));
    for (const c of caps) {
      c.wa.copy(c.a).applyMatrix4(f.joints[c.jointIndex]);
      c.wb.copy(c.b).applyMatrix4(f.joints[c.jointIndex]);
    }
    let envMin = Infinity;
    let envPair = null;
    let envPoint = null;
    const p = new THREE.Vector3();
    for (const c of caps) {
      for (const e of [...this.env, ...this.extra]) {
        if ((e.name === 'Plinth' || e.name === 'A0_Base') && c.link < 2) continue;
        for (let k = 0; k <= samples; k++) {
          p.lerpVectors(c.wa, c.wb, k / samples);
          const v = sdf(p, e) - c.r;
          if (v < envMin) { envMin = v; envPair = [c, e.name]; envPoint = p.clone(); }
        }
      }
    }
    let selfMin = Infinity;
    let selfPair = null;
    for (let i = 0; i < caps.length; i++) {
      for (let k = i + 1; k < caps.length; k++) {
        if (Math.abs(caps[i].link - caps[k].link) < this.minLinkGap) continue;
        const v = segSeg(caps[i].wa, caps[i].wb, caps[k].wa, caps[k].wb) - caps[i].r - caps[k].r;
        if (v < selfMin) { selfMin = v; selfPair = [caps[i], caps[k]]; }
      }
    }
    const envWorse = envMin <= selfMin;
    return {
      min: Math.min(envMin, selfMin), envMin, selfMin, point: envPoint,
      pair: envWorse ? envPair && [envPair[0].name, envPair[1]] : selfPair && [selfPair[0].name, selfPair[1].name],
      joints: envWorse ? (envPair ? [envPair[0].joint] : []) : (selfPair ? [selfPair[0].joint, selfPair[1].joint] : []),
    };
  }
}

const AX = { x: 0, y: 1, z: 2 };
export function sdf(p, e) {
  switch (e.type) {
    case 'plane': return (p.getComponent(AX[e.axis]) - e.value) * e.sign;
    case 'box': {
      const qx = Math.abs(p.x - e.c[0]) - e.h[0];
      const qy = Math.abs(p.y - e.c[1]) - e.h[1];
      const qz = Math.abs(p.z - e.c[2]) - e.h[2];
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
    }
    case 'vcyl': return vcyl(p, e.c, e.y0, e.y1, e.r);
    case 'pot': {
      const body = Math.min(vcyl(p, e.c, e.y0, e.y1, e.r), vcyl(p, e.c, e.y0, e.flange_y1, e.flange_r));
      return Math.max(body, -vcyl(p, e.c, e.bore_y0, e.y1 + 1.0, e.bore_r));
    }
    default: return Infinity;
  }
}

function vcyl(p, c, y0, y1, r) {
  const dx = Math.hypot(p.x - c[0], p.z - c[2]) - r;
  const dy = Math.max(y0 - p.y, p.y - y1);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

export function segSeg(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1);
  const d2 = q2.clone().sub(p2);
  const r = p1.clone().sub(p2);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  let s;
  let t;
  if (a <= 1e-12 && e <= 1e-12) return p1.distanceTo(p2);
  if (a <= 1e-12) { s = 0; t = clamp01(f / e); } else {
    const c = d1.dot(r);
    if (e <= 1e-12) { t = 0; s = clamp01(-c / a); } else {
      const b = d1.dot(d2);
      const den = a * e - b * b;
      s = den > 1e-12 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));
