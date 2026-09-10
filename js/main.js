/**
 * GARGANTUA — application shell
 * Boots the renderer, owns the 21-parameter state, drives the frame loop,
 * persists state, recovers from WebGL context loss and exposes the automation
 * surface defined in automation.js.
 */

import * as THREE from 'three';
import { Pipeline } from './postprocess.js';
import { CameraRig } from './camera.js';
import { HUD } from './hud.js';
import { AmbientAudio } from './audio.js';
import { installAutomation } from './automation.js';
import {
  PARAM_DEFS, DEFAULTS, QUALITY_TIERS, QUALITY_ORDER, VIEW_PRESETS, DEBUG_VIEWS,
  readState, writeState, clearState, clampParam, parseUrlOverrides,
} from './params.js';

const byKey = Object.fromEntries(PARAM_DEFS.map((d) => [d.key, d]));

function halfToFloat(h) {
  const s = (h & 0x8000) >> 15;
  const e = (h & 0x7C00) >> 10;
  const f = h & 0x03FF;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : (s ? -1 : 1) * Infinity;
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

function detectDefaultQuality() {
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
    (navigator.maxTouchPoints > 1 && window.innerWidth < 900);
  if (mobile) return 'standard';
  const cores = navigator.hardwareConcurrency || 4;
  const dpr = window.devicePixelRatio || 1;
  if (cores >= 8 && dpr >= 2) return 'high';
  if (cores >= 4) return 'high';
  return 'standard';
}

class Gargantua {
  constructor(canvas, hudRoot) {
    this.canvas = canvas;
    this.fill = document.getElementById('fallback');

    this.state = {
      params: Object.assign({}, DEFAULTS),
      quality: detectDefaultQuality(),
      view: 0,
      preset: 0,
      cinematic: true,
      hud: true,
      panel: true,
      music: false,
      volume: 0.5,
      bloomEnabled: true,
    };

    this.sceneTime = 0;
    this.flowTime = 0;
    this.frozen = false;
    this.paused = false;
    this.frameCount = 0;
    this.contextLost = false;
    this.adaptiveScale = 1;

    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this._lastStatsPush = 0;
    this._stats = { fps: null, ms: null, res: '', steps: null };
    this._stepReadCounter = 0;

    this._settleResolvers = [];
    this._settleTarget = 0;

    this.renderer = null;
    this.pipeline = null;
    this.rig = null;
    this.audio = new AmbientAudio();

    this._lastRect = { w: 0, h: 0, dpr: 0 };

    this._buildRenderer();
    this._buildPipeline();

    this.rig = new CameraRig(canvas, this._aspect());

    this.hud = new HUD(hudRoot, {
      onParam: (k, v) => this.setParam(k, v, { silent: false }),
      onPreset: (id) => this.setPreset(id, true),
      onView: (id) => this.setView(id, true),
      onReset: () => this.reset(),
      onScreenshot: () => this.saveScreenshot(),
      onFullscreen: () => this.toggleFullscreen(),
      onMusic: () => this.toggleMusic(),
      onRetryContext: () => this.rebuild(),
    });

    this._loadPersisted();
    this._applyUrl();

    this.hud.setQuality(this.state.quality);
    this.hud.setView(this.state.view);
    this.hud.setPresetActive(this.state.preset);
    this.hud.setMusicState(false);
    this.hud.setHudVisible = undefined;
    if (!this.state.hud) this.hud.toggle();
    if (!this.state.panel) this.hud.togglePanel(false);
    if (this._pendingShot) this.hud.setInstant(true);

    this._bindEvents();
    this.resize(true);

    this.auto = installAutomation(this);
    this._bindAutomation();

    this._lastTime = performance.now();
    this._raf = this._loop.bind(this);
    requestAnimationFrame(this._raf);

    // Hard watchdog: if nothing has been drawn after 12 s (driver hang, shader
    // compile failure inside a driver that never reports it), surface the error
    // overlay instead of leaving the user on a black screen.
    this._watchdog = setTimeout(() => {
      if (this.frameCount < 2) {
        this.hud.hideIntro();
        this.hud.showFatal(
          '渲染未启动',
          'WebGL 上下文在 12 秒内没有产生任何帧。请尝试「重建渲染上下文」，或换用支持 WebGL2 的浏览器。'
        );
      }
    }, 12000);
  }

  // ------------------------------------------------------------- rendering --
  _buildRenderer() {
    try {
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: false,
        alpha: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true,   // required for canvas.toDataURL screenshots
        failIfMajorPerformanceCaveat: false,
      });
    } catch (err) {
      this.renderer = null;
    }

    if (!this.renderer || !this.renderer.getContext()) {
      this.hud && this.hud.showFatal('WebGL 不可用', '当前浏览器或 GPU 驱动没有提供可用的 WebGL 上下文。');
      this.hud && this.hud.hideIntro();
      throw new Error('WebGL unavailable');
    }

    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = true;
    this.renderer.debug.checkShaderErrors = true;
    this.renderer.setClearColor(0x000000, 1);
  }

  _buildPipeline() {
    if (this.pipeline) this.pipeline.dispose();
    this.pipeline = new Pipeline(this.renderer);
  }

  _aspect() {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    return w / h;
  }

  resize(force) {
    if (!this.renderer) return;
    const tier = QUALITY_TIERS[this.state.quality];
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);

    let dpr = Math.min(window.devicePixelRatio || 1, tier.dprCap);
    if (this.adaptiveScale < 1) dpr = Math.max(0.7, dpr * this.adaptiveScale);

    if (!force && w === this._lastRect.w && h === this._lastRect.h && Math.abs(dpr - this._lastRect.dpr) < 1e-3) {
      return;
    }
    this._lastRect = { w, h, dpr };

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, true);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';

    const target = this.pipeline.setSize(w, h, dpr, tier.renderScale, tier.bloomLevels);
    this.rig && this.rig.setAspect(this._aspect());

    this._renderW = target.width;
    this._renderH = target.height;
    this._stats.res = `${target.width}×${target.height}`;
  }

  /** Build every scene uniform from the current 21-parameter state. */
  _syncUniforms() {
    const u = this.pipeline.sceneMaterial.uniforms;
    const p = this.state.params;
    const mass = p.mass;

    const basis = this.rig.getBasis();
    u.uCamPos.value.copy(basis.position);
    u.uCamRight.value.copy(basis.right);
    u.uCamUp.value.copy(basis.up);
    u.uCamFwd.value.copy(basis.forward);
    u.uTanHalfFov.value = basis.tanHalfFov;
    u.uAspect.value = this._aspect();

    u.uRS.value = mass;
    u.uMM.value = mass * 0.5;
    u.uDiskInner.value = p.diskInner * mass;
    u.uDiskOuter.value = Math.max(p.diskOuter * mass, p.diskInner * mass + 2.0);
    u.uDiskThickness.value = p.diskThickness;
    u.uDiskDensity.value = p.diskDensity;
    u.uDiskTemp.value = p.diskTemp;
    u.uTurbulence.value = p.turbulence;
    u.uDoppler.value = p.doppler;
    u.uRedshift.value = p.redshift;
    u.uLensing.value = p.lensing;
    u.uStarBright.value = p.starBright;
    u.uStarDensity.value = p.starDensity;
    u.uGalaxy.value = p.galaxy;

    // Display gain that keeps the Shakura-Sunyaev source function in the range
    // ACES likes without clipping. The *shape* of the profile is untouched, so
    // the physics (T^4 falloff, g^4 beaming, 16x approaching/receding ratio) is
    // unaffected — only the absolute scale, which is arbitrary anyway for a
    // scene with no absolute luminosity reference.
    u.uDiskGain.value = 0.33;

    u.uEscapeR.value = Math.max(
      70 * mass,
      p.distance * 2.4,
      u.uDiskOuter.value * 2.2
    );

    u.uTime.value = this.sceneTime;
    u.uFlowTime.value = this.flowTime;
    u.uView.value = this.state.view;
    u.uDiskEnabled.value = this.state.view === 7 ? 0 : 1;

    const tier = QUALITY_TIERS[this.state.quality];
    u.uMaxSteps.value = tier.maxSteps;
    u.uStepAngle.value = tier.stepAngle;
    u.uStepRadial.value = tier.stepRadial;
    u.uIntegrator.value = tier.integrator;
    u.uOct.value = tier.oct;

    const height = this._renderH || 1080;
    u.uPixelAngle.value = (2.0 * basis.tanHalfFov) / height;

    const c = this.pipeline.compositeMaterial.uniforms;
    c.uExposure.value = p.exposure;
    c.uBloomStrength.value = this.state.bloomEnabled ? p.bloom : 0;
    c.uChromatic.value = p.chromatic;
    c.uGrain.value = p.grain;
    c.uVignette.value = p.vignette;
    c.uTime.value = this.sceneTime;
    c.uView.value = this.state.view;

    const b = this.pipeline.brightMaterial.uniforms;
    b.uThreshold.value = p.bloomThreshold;
  }

  _renderOnce() {
    this._syncUniforms();
    this.pipeline.render(this.pipeline.sceneMaterial);
    this.frameCount++;
  }

  _loop(now) {
    this._raf = this._loop.bind(this);
    requestAnimationFrame(this._raf);

    if (this.contextLost) return;

    const rawDt = Math.min((now - this._lastTime) / 1000, 0.25);
    this._lastTime = now;

    if (!this.frozen && !this.paused) {
      this.sceneTime += rawDt;
      this.flowTime += rawDt * this.state.params.flowSpeed;
      this.rig.update(rawDt);
    } else {
      this.rig.update(0);
    }

    this._renderOnce();
    const t1 = performance.now();

    this._fpsAccum += rawDt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this._stats.fps = this._fpsFrames / this._fpsAccum;
      // Wall-clock frame time. Timing just the JS submit call would report ~0.6 ms
      // while the GPU is actually spending 40 ms per frame — the GPU work is
      // asynchronous, so the honest number is the frame interval itself.
      this._stats.ms = 1000 / Math.max(this._stats.fps, 1);
      this._fpsAccum = 0;
      this._fpsFrames = 0;
      this._maybeAdaptive();
    }

    if (this._renderW && this._stepReadCounter++ % 48 === 0) {
      this._readSteps();
    }

    // The intro curtain only lifts once real frames are landing on screen, so a
    // shader-compile failure surfaces as the fatal overlay rather than a blank
    // page behind a spinner.
    if (!this._readyCalled && this.frameCount >= 3) {
      this._readyCalled = true;
      clearTimeout(this._watchdog);
      this.hud.hideIntro();
      this.auto._markReady();
    }

    this._pushStats(t1);
    this._drainSettle();
  }

  _maybeAdaptive() {
    const fps = this._stats.fps;
    if (!fps) return;
    if (fps < 20 && this.adaptiveScale > 0.62) {
      this.adaptiveScale = Math.max(0.62, this.adaptiveScale - 0.09);
      this.resize(true);
    } else if (fps > 52 && this.adaptiveScale < 1) {
      this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
      this.resize(true);
    }
  }

  /**
   * Average iteration count. A 16x16 copy of the same geodetic pass is rendered
   * into a tiny RGBA16F target (1024 pixels, effectively free) and the alpha
   * channel, which carries the normalised step count, is read back. That is a
   * real measurement of the integrator rather than an estimate — a 4x4 read-back
   * at the frame centre would only ever sample the shadow.
   */
  _readSteps() {
    try {
      const rt = this.pipeline.statsRT;
      if (!rt) return;
      this.pipeline.renderStats(this.pipeline.sceneMaterial);
      const n = this._stepBuf || (this._stepBuf = new Uint16Array(16 * 16 * 4));
      this.renderer.readRenderTargetPixels(rt, 0, 0, 16, 16, n);
      let acc = 0;
      for (let i = 0; i < 256; i++) acc += halfToFloat(n[i * 4 + 3]);
      const tier = QUALITY_TIERS[this.state.quality];
      this._stats.steps = (acc / 256) * tier.maxSteps;
    } catch (e) {
      this._stats.steps = null;
    }
  }

  _pushStats(frameMs) {
    const now = performance.now();
    if (now - this._lastStatsPush < 220) return;
    this._lastStatsPush = now;
    this.hud.setStats(this._stats);
  }

  _drainSettle() {
    if (this._settleResolvers.length && this.frameCount >= this._settleTarget) {
      const rs = this._settleResolvers.slice();
      this._settleResolvers.length = 0;
      rs.forEach((r) => r(true));
    }
  }

  settleFrames(n) {
    if (n <= 0) return Promise.resolve(true);
    this._settleTarget = this.frameCount + n;
    return new Promise((res) => this._settleResolvers.push(res));
  }

  // ------------------------------------------------------------------ state --
  setParam(key, value, opts) {
    if (!byKey[key]) return;
    const v = clampParam(key, value);
    this.state.params[key] = v;
    this.hud.setParam(key, v);
    if (key === 'distance') this.rig.setDistance(v);
    if (!opts || !opts.silent) this._persist();
  }

  setParams(obj) {
    Object.keys(obj || {}).forEach((k) => this.setParam(k, obj[k], { silent: true }));
    this._persist();
  }

  reset() {
    this.state.params = Object.assign({}, DEFAULTS);
    PARAM_DEFS.forEach((d) => this.hud.setParam(d.key, d.def));
    this.rig.setDistance(DEFAULTS.distance);
    this.state.view = 0;
    this.state.preset = 0;
    this.state.bloomEnabled = true;
    this.hud.setView(0);
    this.hud.setPresetActive(0);
    this.hud.toast('已恢复默认参数');
    this._persist();
  }

  setQuality(id) {
    if (!QUALITY_TIERS[id]) return;
    this.state.quality = id;
    this.adaptiveScale = 1;
    this.hud.setQuality(id);
    this.hud.setIntegrator(QUALITY_TIERS[id].integrator === 1 ? 'RK4' : 'Verlet');
    this.resize(true);
    this._persist();
  }

  cycleQuality(delta = 1) {
    const i = QUALITY_ORDER.indexOf(this.state.quality);
    const next = QUALITY_ORDER[(i + delta + QUALITY_ORDER.length) % QUALITY_ORDER.length];
    this.setQuality(next);
    this.hud.toast(`质量档：${QUALITY_TIERS[next].label}`);
  }

  setView(id) {
    const v = Math.max(0, Math.min(9, id | 0));
    this.state.view = v;
    this.hud.setView(v);
    const meta = DEBUG_VIEWS.find((d) => d.id === v);
    this.hud.toast(`视图 ${v} · ${meta ? meta.name : ''}`, 1200);
    this._persist();
  }

  setPreset(id, animate) {
    const preset = VIEW_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    this.state.preset = preset.id;
    this.hud.setPresetActive(preset.id);
    this.setCinematic(false);
    this.rig.applyPreset(preset);
    this.setParam('distance', preset.distance, { silent: true });
    this._persist();
    this.hud.toast(`视角：${preset.name}`, 1400);
  }

  setCinematic(on) {
    this.state.cinematic = !!on;
    this.rig.setCinematic(this.state.cinematic);
    this._persist();
  }

  setCamera(cfg) {
    if (cfg.distance !== undefined) {
      this.rig.setDistance(cfg.distance);
      this.setParam('distance', cfg.distance, { silent: true });
    }
    if (cfg.fov !== undefined) {
      this.rig.camera.fov = cfg.fov;
      this.rig.camera.updateProjectionMatrix();
    }
    if (cfg.azimuth !== undefined || cfg.elevation !== undefined) {
      const cur = this.rig.syncFromCamera();
      const az = cfg.azimuth !== undefined ? cfg.azimuth : cur.theta;
      const el = cfg.elevation !== undefined ? cfg.elevation : (Math.PI / 2 - cur.phi);
      const pol = Math.PI / 2 - el;
      const r = this.rig.spherical.radius;
      const sp = Math.sin(pol);
      this.rig.camera.position.set(r * sp * Math.sin(az), r * Math.cos(pol), r * sp * Math.cos(az));
      this.rig.camera.lookAt(0, 0, 0);
      this.rig.controls.update();
    }
    this._persist();
  }

  setTime(t) {
    this.sceneTime = Number(t) || 0;
    this.flowTime = this.sceneTime * this.state.params.flowSpeed;
    this.rig.setCineTime(this.sceneTime);
    this.rig.setCinematic(this.state.cinematic);
    this.rig.update(0);
  }

  advance(dt) {
    const d = Number(dt) || 0;
    this.sceneTime += d;
    this.flowTime += d * this.state.params.flowSpeed;
    this.rig.update(d);
  }

  freeze(on) {
    this.frozen = !!on;
  }

  setHudVisible(on) {
    if (this.state.hud !== !!on) this.hud.toggle();
    this.state.hud = !!on;
  }

  setBloom(on) {
    this.state.bloomEnabled = !!on;
    this.hud.toast(this.state.bloomEnabled ? 'Bloom 开' : 'Bloom 关', 1000);
  }

  getState() {
    return {
      params: Object.assign({}, this.state.params),
      quality: this.state.quality,
      view: this.state.view,
      preset: this.state.preset,
      cinematic: this.state.cinematic,
      bloomEnabled: this.state.bloomEnabled,
      time: this.sceneTime,
      flowTime: this.flowTime,
      camera: {
        fov: this.rig.camera.fov,
        radius: this.rig.spherical.radius,
        theta: this.rig.spherical.theta,
        phi: this.rig.spherical.phi,
      },
    };
  }

  getStats() {
    return Object.assign({}, this._stats, {
      frames: this.frameCount,
      renderSize: [this._renderW, this._renderH],
      contextLost: this.contextLost,
      audio: this.audio.mode,
    });
  }

  // -------------------------------------------------------------- utilities --
  captureDataURL(type, quality) {
    this._renderOnce();
    return this.canvas.toDataURL(type || 'image/png', quality);
  }

  async saveScreenshot() {
    try {
      const url = await this.auto.capture({ download: true });
      this.hud.toast('已保存截图');
      return url;
    } catch (e) {
      this.hud.toast('截图失败', 1600, 'is-warn');
      return null;
    }
  }

  async toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch (e) { /* user denied */ }
  }

  async toggleMusic() {
    try {
      const on = await this.audio.toggle();
      this.state.music = on;
      this.hud.setMusicState(on);
      this.hud.toast(on ? `氛围音乐 开（${this.audio.mode === 'asset' ? '音轨' : '合成器'}）` : '氛围音乐 关', 1500);
      this._persist();
    } catch (e) {
      this.hud.toast('音频不可用', 1500, 'is-warn');
    }
  }

  scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._persist(), 400);
  }

  _persist() {
    writeState({
      v: 1,
      params: this.state.params,
      quality: this.state.quality,
      view: this.state.view,
      preset: this.state.preset,
      cinematic: this.state.cinematic,
      hud: this.state.hud,
      panel: this.state.panel,
      music: this.state.music,
      volume: this.state.volume,
      bloomEnabled: this.state.bloomEnabled,
      camera: {
        fov: this.rig ? this.rig.camera.fov : 42,
        radius: this.rig ? this.rig.spherical.radius : DEFAULTS.distance,
        theta: this.rig ? this.rig.spherical.theta : 0.35,
        phi: this.rig ? this.rig.spherical.phi : Math.PI / 2 - 0.115,
      },
    });
  }

  _loadPersisted() {
    const saved = readState();
    if (!saved) return;
    try {
      if (saved.params) {
        Object.keys(saved.params).forEach((k) => {
          if (byKey[k]) this.state.params[k] = clampParam(k, saved.params[k]);
        });
      }
      if (QUALITY_TIERS[saved.quality]) this.state.quality = saved.quality;
      if (typeof saved.view === 'number') this.state.view = Math.max(0, Math.min(9, saved.view));
      if (typeof saved.preset === 'number') this.state.preset = saved.preset;
      if (typeof saved.cinematic === 'boolean') this.state.cinematic = saved.cinematic;
      if (typeof saved.hud === 'boolean') this.state.hud = saved.hud;
      if (typeof saved.panel === 'boolean') this.state.panel = saved.panel;
      if (typeof saved.volume === 'number') this.state.volume = saved.volume;
      if (typeof saved.bloomEnabled === 'boolean') this.state.bloomEnabled = saved.bloomEnabled;
      this._restoreCamera = saved.camera || null;
    } catch (e) { /* corrupt payload: fall back to defaults */ }

    PARAM_DEFS.forEach((d) => this.hud.setParam(d.key, this.state.params[d.key]));
    this.rig.setCinematic(this.state.cinematic);

    const cam = this._restoreCamera;
    if (cam && cam.radius) {
      const pol = cam.phi !== undefined ? cam.phi : Math.PI / 2 - 0.115;
      const az = cam.theta !== undefined ? cam.theta : 0.35;
      const r = cam.radius;
      const sp = Math.sin(pol);
      this.rig.camera.position.set(r * sp * Math.sin(az), r * Math.cos(pol), r * sp * Math.cos(az));
      if (cam.fov) this.rig.camera.fov = cam.fov;
      this.rig.camera.updateProjectionMatrix();
      this.rig.camera.lookAt(0, 0, 0);
      this.rig.controls.update();
    } else {
      this.rig.applyPreset(this.state.preset);
    }
    this.rig.syncFromCamera();
  }

  _applyUrl() {
    const o = parseUrlOverrides();
    const flags = o.flags || {};

    if (Object.keys(o.params).length) {
      Object.keys(o.params).forEach((k) => this.setParam(k, o.params[k], { silent: true }));
    }
    if (flags.q && QUALITY_TIERS[flags.q]) this.state.quality = flags.q;
    if (flags.quality && QUALITY_TIERS[flags.quality]) this.state.quality = flags.quality;
    if (flags.view !== undefined) this.state.view = Math.max(0, Math.min(9, parseInt(flags.view, 10) || 0));
    if (flags.preset !== undefined) {
      const p = VIEW_PRESETS.find((x) => x.id === parseInt(flags.preset, 10));
      if (p) {
        this.state.preset = p.id;
        this.rig.applyPreset(p);
        this.setParam('distance', p.distance, { silent: true });
      }
    }
    if (flags.cine !== undefined) this.state.cinematic = !(flags.cine === '0' || flags.cine === 'false');
    if (flags.hud !== undefined) this.state.hud = !(flags.hud === '0' || flags.hud === 'false');
    if (flags.panel !== undefined) this.state.panel = !(flags.panel === '0' || flags.panel === 'false');
    if (flags.bloom !== undefined) this.state.bloomEnabled = !(flags.bloom === '0' || flags.bloom === 'false');
    if (flags.cam) {
      const [az, el, r, fov] = String(flags.cam).split(',').map(Number);
      this.setCamera({ azimuth: az, elevation: el, distance: r, fov });
    }

    if (flags.shot !== undefined || flags.autoshot !== undefined || flags.screenshot !== undefined) {
      this._pendingShot = {
        t: flags.t !== undefined ? parseFloat(flags.t) : 18,
        download: flags.dl === '1' || flags.dl === 'true',
        settle: flags.settle ? parseInt(flags.settle, 10) : 8,
      };
      this.state.cinematic = false;
      this.rig.setCinematic(false);
    }

    if (flags.nostore !== undefined) clearState();
  }

  _bindAutomation() {
    const api = this.auto;
    api.deterministic = !!this._pendingShot;

    if (this._pendingShot) {
      const shot = this._pendingShot;
      this.freeze(true);
      this.setTime(shot.t);
      this.hud.hideIntro(true);
      this.settleFrames(shot.settle).then(async () => {
        this._renderOnce();
        clearTimeout(this._watchdog);
        this.hud.hideIntro(true);
        api._markReady();
        const url = this.captureDataURL('image/png');
        window.__GARGANTUA_SHOT__ = url;
        document.title = 'GARGANTUA-SHOT-READY';
        window.dispatchEvent(new CustomEvent('gargantua-shot', { detail: { dataURL: url, time: shot.t } }));
        if (shot.download) {
          const a = document.createElement('a');
          a.href = url;
          a.download = `gargantua-t${shot.t}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
      });
    }
  }

  _bindEvents() {
    window.addEventListener('resize', () => this.resize(false));
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(true), 220));

    document.addEventListener('visibilitychange', () => {
      this._lastTime = performance.now();
    });

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.auto.contextLost = true;
      this.hud.showFatal('WebGL 上下文丢失', 'GPU 驱动回收了渲染上下文（常见于显卡驱动重置或标签页长时间后台）。正在等待自动恢复…');
    }, false);

    this.canvas.addEventListener('webglcontextrestored', () => {
      this.hud.toast('渲染上下文已恢复');
      this.rebuild();
    }, false);

    this.renderer.domElement.addEventListener('pointerdown', () => {
      if (!this.rig.cinematic) return;
      this.setCinematic(false);
      this.hud.toast('已切换为自由轨道（按 C 返回电影镜头）', 1800);
    });

    window.addEventListener('keydown', (e) => this._onKey(e));

    // Keep a debounced copy of the live camera in storage.
    setInterval(() => { if (!this.frozen) this.scheduleSave(); }, 5000);
  }

  _onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key;

    // View presets live on Shift+1..4 / F1..F4 so that plain digits stay reserved
    // for the ten debug views, exactly as specified.
    if (e.shiftKey && ['!', '@', '#', '$'].indexOf(k) >= 0) {
      e.preventDefault();
      this.setPreset(['!', '@', '#', '$'].indexOf(k));
      return;
    }
    if (/^F[1-4]$/.test(k)) {
      e.preventDefault();
      this.setPreset(parseInt(k.slice(1), 10) - 1);
      return;
    }
    if (k >= '0' && k <= '9') { this.setView(parseInt(k, 10)); return; }

    switch (k.toLowerCase()) {
      case 'h': this.hud.toggle(); this.state.hud = this.hud.visible; this._persist(); break;
      case 'p': this.hud.togglePanel(); this.state.panel = this.hud.panelOpen; this._persist(); break;
      case 'c': this.setCinematic(!this.state.cinematic); this.hud.toast(this.state.cinematic ? '电影镜头 开' : '自由轨道'); break;
      case ' ':
        e.preventDefault();
        this.paused = !this.paused;
        this.frozen = this.paused;
        this.hud.toast(this.paused ? '已暂停' : '已继续');
        break;
      case 'q': this.cycleQuality(1); break;
      case 'm': this.toggleMusic(); break;
      case 's': this.saveScreenshot(); break;
      case 'b': this.setBloom(!this.state.bloomEnabled); break;
      case 'f': this.toggleFullscreen(); break;
      case 'r': this.reset(); break;
      case '?': this.hud.toggleHelp(); break;
      case '/': this.hud.toggleHelp(); break;
      case 'escape': this.hud.toggleHelp(false); break;
      default: break;
    }
  }

  rebuild() {
    try {
      this.contextLost = false;
      this.auto.contextLost = false;
      this.hud.hideFatal();
      this._buildPipeline();
      this.resize(true);
      this._renderOnce();
      this.hud.toast('渲染管线已重建');
    } catch (e) {
      this.hud.showFatal('重建失败', String(e && e.message ? e.message : e));
    }
  }
}

// ------------------------------------------------------------------ bootstrap
function boot() {
  const canvas = document.getElementById('gl');
  const hudRoot = document.getElementById('ui');
  const fallback = document.getElementById('fallback');

  const fail = (title, body) => {
    if (fallback) {
      fallback.hidden = false;
      fallback.innerHTML = `<h1>${title}</h1><p>${body}</p>`;
    }
    const intro = document.getElementById('g-intro');
    if (intro) intro.remove();
  };

  try {
    if (!canvas || !hudRoot) throw new Error('缺少必要的 DOM 节点');
    window.__GARGANTUA__ = new Gargantua(canvas, hudRoot);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[GARGANTUA] 启动失败：', err);
    fail('无法启动 GARGANTUA', (err && err.message) || '未知错误');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
