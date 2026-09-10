/**
 * GARGANTUA — URL / window screenshot automation surface.
 *
 * Everything an external harness needs is exposed on `window.GARGANTUA`:
 *
 *   await GARGANTUA.ready                    // resolves after the first frame
 *   GARGANTUA.setParams({ diskTemp: 14000 })
 *   GARGANTUA.setParam('mass', 1.4)
 *   GARGANTUA.setQuality('cinematic')
 *   GARGANTUA.setView(4)
 *   GARGANTUA.setPreset(2)
 *   GARGANTUA.setCamera({ azimuth, elevation, distance, fov })
 *   GARGANTUA.setTime(12.5)                  // deterministic scene time
 *   await GARGANTUA.renderAt(12.5)           // set time + settle N frames
 *   await GARGANTUA.capture({ download:true })  // -> data URL (PNG)
 *   GARGANTUA.getState() / GARGANTUA.getStats()
 *
 * URL form (renders headless-friendly, no interaction required):
 *   index.html?shot=1&t=18&q=cinematic&preset=0&view=0&w=1920&h=1080&dpr=1&dl=1
 *
 * When `shot=1` the app enters deterministic mode: the cinematic loop is frozen
 * at `t`, time does not advance, and the captured frame is bit-reproducible for
 * a given (t, params, quality, resolution) tuple.
 */

export function installAutomation(app) {
  const api = {
    version: '1.0.0',
    ready: null,
    deterministic: false,
    contextLost: false,
    _resolveReady: null,
  };

  api.ready = new Promise((res) => { api._resolveReady = res; });

  api._markReady = () => {
    if (api._ready) return;
    api._ready = true;
    api._resolveReady(api);
    window.__GARGANTUA_READY__ = true;
    document.documentElement.setAttribute('data-gargantua', 'ready');
    window.dispatchEvent(new CustomEvent('gargantua-ready', { detail: api }));
  };

  api.getState = () => app.getState();
  api.getStats = () => app.getStats();

  api.setParam = (key, value) => app.setParam(key, value);
  api.setParams = (obj) => app.setParams(obj);
  api.reset = () => app.reset();
  api.setQuality = (id) => app.setQuality(id);
  api.cycleQuality = (delta) => app.cycleQuality(delta);
  api.setView = (id) => app.setView(id);
  api.setPreset = (id) => app.setPreset(id);
  api.setCinematic = (on) => app.setCinematic(on);
  api.setHudVisible = (on) => app.setHudVisible(on);
  api.setBloom = (on) => app.setBloom(on);

  api.setCamera = (cfg) => app.setCamera(cfg || {});
  api.setTime = (t) => app.setTime(t);
  api.advance = (dt) => app.advance(dt);

  api.renderAt = async (t, settleFrames = 6) => {
    if (t !== undefined) app.setTime(t);
    app.freeze(true);
    await app.settleFrames(settleFrames);
    return true;
  };

  api.capture = async (opts) => {
    const o = opts || {};
    if (o.settleFrames) await app.settleFrames(o.settleFrames);
    const url = app.captureDataURL(o.type || 'image/png', o.quality);
    if (o.download) {
      const a = document.createElement('a');
      a.href = url;
      a.download = o.filename || `gargantua-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    return url;
  };

  api.captureBlob = async (opts) => {
    const url = await api.capture(opts);
    return await (await fetch(url)).blob();
  };

  api.retryContext = () => app.rebuild();

  window.GARGANTUA = api;
  return api;
}
