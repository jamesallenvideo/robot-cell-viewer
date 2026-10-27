// Simulated 6-axis force/torque sensor and the calibration maths.
//
// Sensor frame S: Z points along the tool, away from the flange (derived from
// the model's FT_Sensor node rotated 180° about X), then rotated about Z by the
// mounting angle. Readings are what the sensor would output in ITS frame:
//   F = R_Sᵀ (m g + F_ext) + bias + drift·t + noise
//   M = r × (R_Sᵀ m g) + r_load × (R_Sᵀ F_ext) + bias + drift·t + noise
// All sensor values (ranges, bias, noise, drift) are illustrative.
import * as THREE from 'three';

export const GRAVITY = new THREE.Vector3(0, -9.81, 0);
const DEG = Math.PI / 180;
const FLIP_X = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);

export class FTSensor {
  constructor(robot, sensorCfg) {
    this.robot = robot;
    this.cfg = sensorCfg;
    this.t = 0;
    this.latest = new Array(6).fill(0);
    this.tool = { mass: 0, com: new THREE.Vector3(), mountingDeg: 0 };   // physical truth
    this.faults = { thermal: false, looseCable: false, wrongMount: false };
    this.extForceWorld = new THREE.Vector3();
    this.loadPointWorld = null;
    this.contact = false;
    this.wiggleUntil = -1;
    this.noiseScale = 1;
    this._q = new THREE.Quaternion();
  }

  /** Physical tool (ground truth). com_mm in the sensor frame. */
  setTool({ mass, com_mm, mountingDeg = 0 }) {
    this.tool = { mass, com: new THREE.Vector3(...com_mm).multiplyScalar(0.001), mountingDeg };
  }

  actualMountingDeg() { return this.tool.mountingDeg + (this.faults.wrongMount ? 90 : 0); }

  /** World orientation of the sensor frame for a mounting angle (deg). */
  frameQuat(mountingDeg, angles = null) {
    if (angles) {
      const m = this.robot.fk(angles).sensor;
      this._q.setFromRotationMatrix(m);
    } else {
      this.robot.sensor.getWorldQuaternion(this._q);
    }
    return this._q.clone().multiply(FLIP_X).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), mountingDeg * DEG));
  }

  /** Gravity acceleration expressed in the sensor frame with a given mounting. */
  gravityIn(mountingDeg, angles = null) {
    return GRAVITY.clone().applyQuaternion(this.frameQuat(mountingDeg, angles).invert());
  }

  /** Noise-free wrench for the current pose (ground truth), sensor frame. */
  idealWrench(angles = null) {
    const q = this.frameQuat(this.actualMountingDeg(), angles);
    const qi = q.clone().invert();
    const Fg = GRAVITY.clone().multiplyScalar(this.tool.mass).applyQuaternion(qi);
    const F = Fg.clone();
    const M = this.tool.com.clone().cross(Fg);
    const ext = this.extForceWorld.clone();
    if (this.contact) ext.add(new THREE.Vector3(...this.cfg.contactLoadN));
    if (ext.lengthSq() > 0) {
      const fs = ext.applyQuaternion(qi);
      const origin = this.robot.sensor.getWorldPosition(new THREE.Vector3());
      const pt = (this.loadPointWorld ?? this.robot.tcp.getWorldPosition(new THREE.Vector3())).clone().sub(origin).applyQuaternion(qi);
      F.add(fs);
      M.add(pt.cross(fs));
    }
    return [F.x, F.y, F.z, M.x, M.y, M.z];
  }

  sample() {
    const w = this.idealWrench();
    const c = this.cfg;
    const driftMul = this.faults.thermal ? 250 : 1;
    let noiseMul = this.noiseScale * (this.t < this.wiggleUntil ? 18 : 1);
    if (this.faults.looseCable && Math.random() < 0.04) noiseMul *= 40;   // intermittent spikes
    return w.map((v, i) => v + c.bias[i] + c.driftPerS[i] * this.t * driftMul + gauss() * c.noise[i] * noiseMul);
  }

  /** Advance simulated time by dt; returns the samples produced. */
  step(dt) {
    const rate = this.cfg.rateHz;
    const n0 = Math.floor(this.t * rate);
    this.t += dt;
    const n1 = Math.floor(this.t * rate);
    const out = [];
    for (let i = n0; i < n1; i++) out.push(this.sample());
    if (out.length) this.latest = out[out.length - 1];
    return out;
  }
}

export function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------- calibration maths
// Each pose: { a:[ax,ay,az] gravity (m/s²) in the configured sensor frame,
//              F:[3], M:[3] mean readings (bias-zeroed or raw) }.
// Force model:  F = m a + bF                 unknowns m, bF        (4)
// Moment model: M = c × a + bM, c = m·r      unknowns c, bM        (6)

function forceRows(poses) {
  const A = [];
  const b = [];
  for (const p of poses) {
    const [ax, ay, az] = p.a;
    A.push([ax, 1, 0, 0], [ay, 0, 1, 0], [az, 0, 0, 1]);
    if (p.F) b.push(...p.F);
  }
  return { A, b };
}

function momentRows(poses) {
  const A = [];
  const b = [];
  for (const p of poses) {
    const [ax, ay, az] = p.a;
    // c × a = -[a]x c
    A.push([0, az, -ay, 1, 0, 0], [-az, 0, ax, 0, 1, 0], [ay, -ax, 0, 0, 0, 1]);
    if (p.M) b.push(...p.M);
  }
  return { A, b };
}

/** Least-squares fit of tool mass, centre of mass and residual offsets. */
export function fitGravity(poses) {
  if (poses.length < 2) throw new Error('Capture at least two poses.');
  const f = forceRows(poses);
  const m = momentRows(poses);
  const xF = lstsq(f.A, f.b);
  const xM = lstsq(m.A, m.b);
  const mass = xF[0];
  const c = xM.slice(0, 3);
  return {
    mass, bF: xF.slice(1), c, com: c.map((v) => (Math.abs(mass) > 1e-6 ? v / mass : 0)), bM: xM.slice(3),
    rmsF: rms(f.A, xF, f.b), rmsM: rms(m.A, xM, m.b),
  };
}

/** Predicted (gravity + offset) wrench for gravity vector a, from a fit. */
export function predict(fit, a) {
  const [ax, ay, az] = a;
  const [cx, cy, cz] = fit.c;
  return [
    fit.mass * ax + fit.bF[0], fit.mass * ay + fit.bF[1], fit.mass * az + fit.bF[2],
    cy * az - cz * ay + fit.bM[0], cz * ax - cx * az + fit.bM[1], cx * ay - cy * ax + fit.bM[2],
  ];
}

/**
 * Pose diversity: condition numbers of the normal matrices. The moment
 * system (centre of mass + offsets) is the demanding one: it is singular
 * unless the gravity directions span 3-D.
 */
export function conditioning(poses, good = 60, poor = 400) {
  if (poses.length < 2) return { condF: Infinity, condM: Infinity, quality: 0 };
  // gravity normalised to 1 g so the gravity and offset columns have the same scale
  const unit = poses.map((p) => ({ a: p.a.map((v) => v / 9.81) }));
  const condF = cond(normal(forceRows(unit).A));
  const condM = cond(normal(momentRows(unit).A));
  const worst = Math.max(condF, condM);
  let quality;
  if (!Number.isFinite(worst)) quality = 0;
  else if (worst <= good) quality = 1;
  else if (worst >= poor * 10) quality = 0;
  else quality = Math.max(0, 1 - Math.log(worst / good) / Math.log((poor * 10) / good));
  return { condF, condM, quality };
}

function normal(A) {
  const n = A[0].length;
  const N = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const row of A) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) N[i][j] += row[i] * row[j];
  return N;
}

function cond(N) {
  const ev = symEig(N).map(Math.abs);
  const max = Math.max(...ev);
  const min = Math.min(...ev);
  return min < max * 1e-12 ? Infinity : max / min;
}

/** Eigenvalues of a symmetric matrix (cyclic Jacobi). */
export function symEig(S) {
  const n = S.length;
  const A = S.map((r) => r.slice());
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k];
          const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
      }
    }
  }
  return A.map((r, i) => r[i]);
}

/** Least squares via normal equations with partial-pivot Gaussian elimination. */
export function lstsq(A, b) {
  const N = normal(A);
  const y = new Array(N.length).fill(0);
  for (let r = 0; r < A.length; r++) for (let i = 0; i < N.length; i++) y[i] += A[r][i] * b[r];
  const n = y.length;
  const M = N.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) throw new Error('The captured poses cannot separate mass from centre of mass. Add poses with different tilts.');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function rms(A, x, b) {
  let s = 0;
  for (let r = 0; r < A.length; r++) {
    const pred = A[r].reduce((acc, v, i) => acc + v * x[i], 0);
    s += (pred - b[r]) ** 2;
  }
  return Math.sqrt(s / A.length);
}
