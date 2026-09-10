/**
 * GARGANTUA — camera rig
 *  - free mode: real three.js OrbitControls on a dummy PerspectiveCamera
 *  - cinematic mode: deterministic Catmull-Rom dolly keyframe loop
 * Both modes feed the same (position, basis, fov) into the raytracer uniforms.
 */

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { VIEW_PRESETS } from './params.js';

const DEG = Math.PI / 180;

// t is normalised to [0,1] over the loop; the final key duplicates the first
// displaced by exactly 2*pi in azimuth, which makes the orbit seamless.
export const CINE_KEYS = [
  { t: 0.000, az: 0.350, pol: 1.4661, r: 24.0, fov: 42.0 },
  { t: 0.115, az: 0.980, pol: 1.5240, r: 18.6, fov: 38.0 },
  { t: 0.230, az: 1.720, pol: 1.3600, r: 16.2, fov: 33.0 },
  { t: 0.345, az: 2.460, pol: 1.0900, r: 19.6, fov: 40.0 },
  { t: 0.460, az: 3.120, pol: 0.7600, r: 27.5, fov: 47.0 },
  { t: 0.590, az: 3.820, pol: 0.9800, r: 33.0, fov: 50.0 },
  { t: 0.720, az: 4.520, pol: 1.2400, r: 25.2, fov: 39.0 },
  { t: 0.850, az: 5.180, pol: 1.5060, r: 17.4, fov: 33.0 },
  { t: 1.000, az: 5.933, pol: 1.4661, r: 24.0, fov: 42.0 },
];

export const CINE_DURATION = 78.0; // seconds per loop

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/** Evaluate the dolly curve at normalised loop time in [0,1). */
export function sampleCine(u) {
  const n = CINE_KEYS.length;
  let uu = u - Math.floor(u);
  let i = 0;
  while (i < n - 2 && uu > CINE_KEYS[i + 1].t) i++;
  const k1 = CINE_KEYS[i];
  const k2 = CINE_KEYS[i + 1];
  const local = (uu - k1.t) / Math.max(k2.t - k1.t, 1e-6);
  const k0 = CINE_KEYS[Math.max(i - 1, 0)];
  const k3 = CINE_KEYS[Math.min(i + 2, n - 1)];

  return {
    az: catmullRom(k0.az, k1.az, k2.az, k3.az, local),
    pol: catmullRom(k0.pol, k1.pol, k2.pol, k3.pol, local),
    r: catmullRom(k0.r, k1.r, k2.r, k3.r, local),
    fov: catmullRom(k0.fov, k1.fov, k2.fov, k3.fov, local),
  };
}

export class CameraRig {
  constructor(canvas, aspect) {
    this.camera = new THREE.PerspectiveCamera(42, aspect, 0.1, 4000);
    this.camera.position.set(0, 0.9, 15.0);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.62;
    this.controls.zoomSpeed = 0.85;
    this.controls.minDistance = 2.4;
    this.controls.maxDistance = 220;
    this.controls.minPolarAngle = 0.03;
    this.controls.maxPolarAngle = Math.PI - 0.03;

    this.cinematic = false;
    this.cineTime = 0;
    this.cinePhase = 0;

    this.spherical = new THREE.Spherical();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._worldUp = new THREE.Vector3(0, 1, 0);
    this._pos = new THREE.Vector3();

    this.basis = {
      position: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      right: new THREE.Vector3(),
      up: new THREE.Vector3(),
      tanHalfFov: Math.tan(42 * DEG / 2),
      fov: 42,
      radius: 15,
    };

    this.syncFromCamera();
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Pull azimuth / polar / radius out of the live camera into this.spherical. */
  syncFromCamera() {
    this._pos.copy(this.camera.position);
    this.spherical.setFromVector3(this._pos);
    this.basis.radius = this.spherical.radius;
    return this.spherical;
  }

  /** Programmatic placement (used by the 4 view presets and by reset). */
  applyPreset(preset) {
    const p = typeof preset === 'number' ? VIEW_PRESETS[preset] : preset;
    if (!p) return;
    const r = p.distance;
    const polar = Math.PI / 2 - p.elevation;
    const az = p.azimuth;
    const sinp = Math.sin(polar);
    this.camera.position.set(r * sinp * Math.sin(az), r * Math.cos(polar), r * sinp * Math.cos(az));
    this.camera.fov = p.fov;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.camera.lookAt(0, 0, 0);
    this.controls.update();
    this.syncFromCamera();
    return p;
  }

  setDistance(r) {
    const s = this.spherical.setFromVector3(this.camera.position);
    const R = Math.max(2.4, r);
    this.camera.position.set(
      R * Math.sin(s.phi) * Math.sin(s.theta),
      R * Math.cos(s.phi),
      R * Math.sin(s.phi) * Math.cos(s.theta)
    );
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.basis.radius = R;
  }

  setCinematic(on) {
    this.cinematic = !!on;
    this.controls.enabled = !this.cinematic;
    if (this.cinematic) {
      this.cinePhase = this.cineTime;
    }
  }

  /** Freeze the cinematic loop at an exact time (URL screenshot automation). */
  setCineTime(t) {
    this.cineTime = t;
    this.cinePhase = t;
  }

  update(dt) {
    if (this.cinematic) {
      this.cineTime += dt;
      const u = this.cineTime / CINE_DURATION;
      const s = sampleCine(u);

      // extremely subtle handheld drift so the move never reads as robotic
      const drift = this.cineTime;
      const dAz = 0.011 * Math.sin(drift * 0.21) + 0.005 * Math.sin(drift * 0.53 + 1.1);
      const dPol = 0.006 * Math.sin(drift * 0.27 + 2.2) + 0.003 * Math.sin(drift * 0.61);
      const dR = 1.0 + 0.014 * Math.sin(drift * 0.17 + 0.4);

      const pol = Math.max(0.045, Math.min(Math.PI - 0.045, s.pol + dPol));
      const az = s.az + dAz;
      const r = s.r * dR;
      const sinp = Math.sin(pol);

      this.camera.position.set(r * sinp * Math.sin(az), r * Math.cos(pol), r * sinp * Math.cos(az));
      this.camera.fov = s.fov + 0.5 * Math.sin(drift * 0.13);
      this.camera.updateProjectionMatrix();
      this.camera.lookAt(0, 0, 0);
      this.camera.updateMatrixWorld();
      this.basis.radius = r;
    } else {
      this.controls.update();
      this.syncFromCamera();
    }
  }

  /** Produce the orthonormal camera basis consumed by the raytracer. */
  getBasis() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    cam.getWorldDirection(this._fwd);

    this._right.crossVectors(this._fwd, this._worldUp);
    if (this._right.lengthSq() < 1e-8) this._right.set(1, 0, 0);
    this._right.normalize();
    this._up.crossVectors(this._right, this._fwd).normalize();

    this.basis.position.copy(cam.position);
    this.basis.forward.copy(this._fwd);
    this.basis.right.copy(this._right);
    this.basis.up.copy(this._up);
    this.basis.fov = cam.fov;
    // The shader treats uTanHalfFov as the VERTICAL half-tangent and derives the
    // horizontal extent from uAspect. On portrait / narrow viewports that makes
    // the horizontal field collapse and the scene over-zooms, so below aspect 1
    // we anchor the field to the horizontal axis instead (object-fit: contain).
    const vTan = Math.tan((cam.fov * DEG) / 2);
    const aspect = cam.aspect > 0 ? cam.aspect : 1;
    this.basis.tanHalfFov = aspect < 1 ? vTan / aspect : vTan;
    return this.basis;
  }
}
