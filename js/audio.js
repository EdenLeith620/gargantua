/**
 * GARGANTUA — optional ambient music.
 *
 * Primary path : assets/audio/gargantua-ambient.<ext>, a 30 s seamless loop that
 *                ships with the project, decoded once and looped through a
 *                master fader + stereo widener.
 * Fallback path: if the asset is missing or undecodable, a fully procedural
 *                Web Audio drone/pad/bell engine takes over — so audio never
 *                becomes a hard failure mode.
 *
 * Nothing starts before an explicit user gesture (browser autoplay policy).
 */

const ASSET_CANDIDATES = [
  'assets/audio/gargantua-ambient.ogg',
  'assets/audio/gargantua-ambient.wav',
];

export class AmbientAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = false;
    this.mode = 'idle'; // 'idle' | 'asset' | 'synth'
    this.targetVolume = 0.35;
    this._buffer = null;
    this._nodes = [];
    this._bellTimer = null;
    this._loadPromise = null;
  }

  get ready() { return !!this.ctx; }

  async _ensureContext() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio unavailable');
    this.ctx = new Ctx({ latencyHint: 'playback' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;

    // Gentle stereo widening + a shelf to take the edge off the top end.
    const shelf = this.ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 5200;
    shelf.gain.value = -5;

    const widen = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    this.master.connect(shelf);
    if (widen) { shelf.connect(widen); widen.connect(this.ctx.destination); }
    else shelf.connect(this.ctx.destination);
  }

  async _loadAsset() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      for (const url of ASSET_CANDIDATES) {
        try {
          const res = await fetch(url, { cache: 'force-cache' });
          if (!res.ok) continue;
          const raw = await res.arrayBuffer();
          const buf = await this.ctx.decodeAudioData(raw.slice(0));
          if (buf && buf.duration > 1) return buf;
        } catch (e) { /* try the next candidate */ }
      }
      return null;
    })();
    return this._loadPromise;
  }

  _startAssetLoop(buffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = 1;

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    lp.Q.value = 0.6;

    src.connect(lp);
    lp.connect(this.master);
    src.start(0);
    this._nodes.push(src, lp);
    this.mode = 'asset';
  }

  _startSynth() {
    const ctx = this.ctx;
    const t0 = ctx.currentTime;

    // --- drone: three detuned sines on a low G ------------------------------
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.30;
    droneGain.connect(this.master);

    [[55.0, 0.9], [82.41, 0.42], [110.0, 0.22]].forEach(([f, a], i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      osc.detune.value = (i - 1) * 6.5;
      const g = ctx.createGain();
      g.gain.value = a;
      osc.connect(g);
      g.connect(droneGain);
      osc.start(t0);
      this._nodes.push(osc, g);
    });

    // --- pad: filtered noise, slowly sweeping band --------------------------
    const len = Math.floor(ctx.sampleRate * 4);
    const noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + (Math.random() * 2 - 1) * 0.02) * 0.995;
      d[i] = last * 3.2;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 1.4;

    const padGain = ctx.createGain();
    padGain.gain.value = 0.16;

    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.031;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 240;
    lfo.connect(lfoGain);
    lfoGain.connect(bp.frequency);

    noise.connect(bp);
    bp.connect(padGain);
    padGain.connect(this.master);
    noise.start(t0);
    lfo.start(t0);
    this._nodes.push(noise, bp, padGain, lfo, lfoGain);

    // --- sparse bell tones --------------------------------------------------
    const scale = [220.0, 261.63, 329.63, 392.0, 440.0, 523.25, 659.25];
    const ping = () => {
      if (!this.enabled || this.mode !== 'synth') return;
      const now = ctx.currentTime;
      const f = scale[Math.floor(Math.random() * scale.length)] * (Math.random() < 0.4 ? 0.5 : 1);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.10, now + 0.6);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 7.5);
      o.connect(g);
      g.connect(this.master);
      o.start(now);
      o.stop(now + 8.0);
      this._bellTimer = setTimeout(ping, 6500 + Math.random() * 12000);
    };
    this._bellTimer = setTimeout(ping, 2500);
    this.mode = 'synth';
  }

  /** Must be invoked from a user gesture. */
  async enable() {
    await this._ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    if (!this.enabled) {
      const buf = await this._loadAsset();
      if (buf) this._startAssetLoop(buf);
      else this._startSynth();
      this.enabled = true;
    }

    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(Math.max(this.master.gain.value, 0.0001), now);
    this.master.gain.linearRampToValueAtTime(this.targetVolume, now + 2.8);
  }

  disable() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(Math.max(this.master.gain.value, 0.0001), now);
    this.master.gain.linearRampToValueAtTime(0.0001, now + 1.1);
    this.enabled = false;
    if (this._bellTimer) { clearTimeout(this._bellTimer); this._bellTimer = null; }

    const nodes = this._nodes;
    this._nodes = [];
    setTimeout(() => {
      nodes.forEach((n) => { try { n.stop && n.stop(); } catch (e) { /* noop */ } });
      this.mode = 'idle';
    }, 1400);
  }

  async toggle() {
    if (this.enabled) { this.disable(); return false; }
    await this.enable();
    return true;
  }

  setVolume(v) {
    this.targetVolume = Math.max(0, Math.min(1, v)) * 0.6;
    if (this.ctx && this.enabled) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.linearRampToValueAtTime(this.targetVolume, now + 0.4);
    }
  }
}
