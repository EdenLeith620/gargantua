/**
 * GARGANTUA — hand-rolled HDR pipeline
 *
 *   sceneRT (RGBA16F)
 *      |-> bright pass (1/2 res)
 *      |-> progressive 13-tap downsampling (L levels)
 *      |-> progressive 9-tap tent upsampling with additive scatter
 *      |-> composite: chromatic aberration -> bloom -> ACES -> vignette -> grain
 *
 * No EffectComposer / UnrealBloomPass dependency: everything is built on raw
 * WebGLRenderTargets so the vendor folder stays at exactly one file.
 */

import * as THREE from 'three';
import { fullscreenVertexShader } from './shaders/common.js';
import { blackHoleFragmentShader } from './shaders/blackhole.js';
import { brightPassShader, downsampleShader, upsampleShader, compositeShader } from './shaders/post.js';

function makeRT(width, height, type, filter = THREE.LinearFilter) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type,
    format: THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
  return rt;
}

export class Pipeline {
  constructor(renderer) {
    this.renderer = renderer;

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quadGeometry = new THREE.PlaneGeometry(2, 2);

    this.blackHoleMaterial = new THREE.ShaderMaterial({
      vertexShader: fullscreenVertexShader,
      fragmentShader: blackHoleFragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uFlowTime: { value: 0 },
        uPixelAngle: { value: 0.001 },
        uCamPos: { value: new THREE.Vector3(0, 3, 15) },
        uCamRight: { value: new THREE.Vector3(1, 0, 0) },
        uCamUp: { value: new THREE.Vector3(0, 1, 0) },
        uCamFwd: { value: new THREE.Vector3(0, 0, -1) },
        uTanHalfFov: { value: 0.38 },
        uAspect: { value: 1.77 },
        uEscapeR: { value: 60 },
        uRS: { value: 1 },
        uMM: { value: 0.5 },
        uDiskInner: { value: 3 },
        uDiskOuter: { value: 16 },
        uDiskThickness: { value: 0.42 },
        uDiskDensity: { value: 2.6 },
        uDiskTemp: { value: 9200 },
        uTurbulence: { value: 0.72 },
        uFlowSpeed: { value: 0.3 },
        uDoppler: { value: 1 },
        uRedshift: { value: 1 },
        uLensing: { value: 1 },
        uStarBright: { value: 1 },
        uStarDensity: { value: 0.55 },
        uGalaxy: { value: 1 },
        uDiskGain: { value: 1 },
        uMaxSteps: { value: 520 },
        uStepAngle: { value: 0.045 },
        uStepRadial: { value: 0.058 },
        uIntegrator: { value: 1 },
        uOct: { value: 4 },
        uDiskEnabled: { value: 1 },
        uView: { value: 0 },
      },
    });
    this.blackHoleMaterial.name = 'GargantuaRaytracer';

    const mk = (frag, uniforms, name) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: fullscreenVertexShader,
        fragmentShader: frag,
        depthTest: false,
        depthWrite: false,
        uniforms,
      });
      m.name = name;
      return m;
    };

    this.brightMaterial = mk(brightPassShader, {
      tDiffuse: { value: null },
      uThreshold: { value: 1.1 },
      uKnee: { value: 0.55 },
    }, 'BrightPass');

    this.downMaterial = mk(downsampleShader, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    }, 'Downsample13');

    this.upMaterial = mk(upsampleShader, {
      tDiffuse: { value: null },
      tBase: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uScatter: { value: 0.82 },
    }, 'UpsampleTent');

    this.compositeMaterial = mk(compositeShader, {
      tScene: { value: null },
      tBloom: { value: null },
      uExposure: { value: 1 },
      uBloomStrength: { value: 0.62 },
      uChromatic: { value: 0.3 },
      uGrain: { value: 0.32 },
      uVignette: { value: 0.55 },
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uView: { value: 0 },
    }, 'Composite');

    this.quad = new THREE.Mesh(this.quadGeometry, this.blackHoleMaterial);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    this.sceneRT = null;
    this.statsRT = null;
    this.brightRT = null;
    this.downRTs = [];
    this.upRTs = [];
    this.bloomLevels = 4;
    this.renderScale = 1;
    this.width = 1;
    this.height = 1;
  }

  get sceneMaterial() { return this.blackHoleMaterial; }

  dispose() {
    const kill = (rt) => { if (rt) rt.dispose(); };
    kill(this.sceneRT);
    kill(this.statsRT);
    kill(this.brightRT);
    this.downRTs.forEach(kill);
    this.upRTs.forEach(kill);
    this.downRTs = [];
    this.upRTs = [];
    this.quadGeometry.dispose();
    [this.blackHoleMaterial, this.brightMaterial, this.downMaterial, this.upMaterial, this.compositeMaterial]
      .forEach((m) => m.dispose());
  }

  setSize(cssWidth, cssHeight, dpr, renderScale, bloomLevels) {
    const w = Math.max(2, Math.floor(cssWidth * dpr * renderScale));
    const h = Math.max(2, Math.floor(cssHeight * dpr * renderScale));
    if (w === this.width && h === this.height && bloomLevels === this.bloomLevels && this.sceneRT) {
      return { width: w, height: h };
    }

    this.width = w;
    this.height = h;
    this.bloomLevels = bloomLevels;

    const kill = (rt) => { if (rt) rt.dispose(); };
    kill(this.sceneRT);
    kill(this.statsRT);
    kill(this.brightRT);
    this.downRTs.forEach(kill);
    this.upRTs.forEach(kill);
    this.downRTs = [];
    this.upRTs = [];

    const HF = THREE.HalfFloatType;
    this.sceneRT = makeRT(w, h, HF);
    this.statsRT = makeRT(16, 16, HF);
    this.brightRT = makeRT(Math.ceil(w / 2), Math.ceil(h / 2), HF);

    let dw = Math.ceil(w / 2);
    let dh = Math.ceil(h / 2);
    for (let i = 0; i < bloomLevels; i++) {
      dw = Math.max(2, Math.ceil(dw / 2));
      dh = Math.max(2, Math.ceil(dh / 2));
      this.downRTs.push(makeRT(dw, dh, HF));
    }
    for (let i = 0; i < bloomLevels - 1; i++) {
      const src = this.downRTs[i];
      this.upRTs.push(makeRT(src.width, src.height, HF));
    }

    return { width: w, height: h };
  }

  _blit(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /** 16x16 copy of the geodetic pass, used only for the step-count read-back. */
  renderStats(sceneMaterial) {
    if (!this.statsRT) return;
    this.quad.material = sceneMaterial;
    this.renderer.setRenderTarget(this.statsRT);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  render(sceneMaterial) {
    const r = this.renderer;
    if (!this.sceneRT) return;

    // 1) geodesic raytrace into the HDR buffer
    this.quad.material = sceneMaterial;
    r.setRenderTarget(this.sceneRT);
    r.render(this.quadScene, this.quadCamera);

    // 2) bloom pyramid
    this.brightMaterial.uniforms.tDiffuse.value = this.sceneRT.texture;
    this._blit(this.brightMaterial, this.brightRT);

    let prev = this.brightRT;
    for (let i = 0; i < this.downRTs.length; i++) {
      const dst = this.downRTs[i];
      this.downMaterial.uniforms.tDiffuse.value = prev.texture;
      this.downMaterial.uniforms.uTexel.value.set(1 / prev.width, 1 / prev.height);
      this._blit(this.downMaterial, dst);
      prev = dst;
    }

    let cur = this.downRTs[this.downRTs.length - 1];
    for (let i = this.downRTs.length - 2; i >= 0; i--) {
      const base = this.downRTs[i];
      const dst = this.upRTs[i];
      this.upMaterial.uniforms.tDiffuse.value = cur.texture;
      this.upMaterial.uniforms.tBase.value = base.texture;
      this.upMaterial.uniforms.uTexel.value.set(1 / cur.width, 1 / cur.height);
      this._blit(this.upMaterial, dst);
      cur = dst;
    }

    // 3) composite to the canvas
    this.compositeMaterial.uniforms.tScene.value = this.sceneRT.texture;
    this.compositeMaterial.uniforms.tBloom.value = cur.texture;
    this.compositeMaterial.uniforms.uResolution.value.set(this.width, this.height);
    this._blit(this.compositeMaterial, null);
  }
}
