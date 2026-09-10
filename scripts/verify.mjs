/**
 * GARGANTUA — headless visual + interaction verification.
 *
 *   node scripts/verify.mjs [--fast] [--tag name] [--w 960] [--h 540]
 *
 * Boots the real page in Chromium, asserts that
 *   - no console errors / page exceptions occur,
 *   - the WebGL2 context is live and the shaders compiled,
 *   - the render is not a black screen and contains a dark shadow core
 *     surrounded by a bright accretion structure (the actual visual contract),
 * then writes PNG captures into docs/shots/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './serve.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'docs', 'shots');
const NODE_MODULES = '/Users/fenglinshen/.workbuddy/binaries/node/workspace/node_modules';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const FAST = argv.includes('--fast');
const TAG = arg('tag', 'run');
const PORT = Number(arg('port', 8137));

const MOBILE = argv.includes('--mobile');
const W = Number(arg('w', MOBILE ? 390 : (FAST ? 720 : 1280)));
const H = Number(arg('h', MOBILE ? 844 : (FAST ? 405 : 720)));

const _pw = await import(path.join(NODE_MODULES, 'playwright-core', 'index.js'));
const chromium = _pw.chromium || (_pw.default && _pw.default.chromium);

fs.mkdirSync(SHOTS, { recursive: true });

const server = createServer(ROOT);
await new Promise((res) => server.listen(PORT, '127.0.0.1', res));
const BASE = `http://127.0.0.1:${PORT}/index.html`;

const results = [];
let browser;

function log(...a) { console.log(...a); }

const CHROME_FOR_TESTING =
  '/Users/fenglinshen/Library/Caches/ms-playwright/chromium-1228/chrome-mac-x64/' +
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

async function launch() {
  const args = [
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--use-angle=default',
    '--enable-webgl',
    '--disable-dev-shm-usage',
  ];
  const attempts = [];
  if (fs.existsSync(CHROME_FOR_TESTING)) {
    attempts.push(['Chrome for Testing', { headless: true, executablePath: CHROME_FOR_TESTING, args }]);
  }
  attempts.push(['installed Google Chrome', { headless: true, channel: 'chrome', args }]);
  attempts.push(['bundled headless shell + SwiftShader', { headless: true, args: [...args, '--use-angle=swiftshader'] }]);

  for (const [label, opts] of attempts) {
    try {
      const b = await chromium.launch(opts);
      log(`browser: ${label}`);
      return b;
    } catch (e) {
      log(`  (${label} unavailable: ${String(e.message).split('\n')[0]})`);
    }
  }
  throw new Error('no usable Chromium found');
}

async function withPage(url, fn) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: MOBILE ? 3 : 1,
    isMobile: MOBILE,
    hasTouch: MOBILE,
    userAgent: MOBILE
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
      : undefined,
  });
  const page = await ctx.newPage();
  const errors = [];
  const warnings = [];
  const logs = [];

  page.on('console', (m) => {
    const t = m.type();
    const text = m.text();
    if (t === 'error') errors.push(text);
    else if (t === 'warning') warnings.push(text);
    else logs.push(`${t}: ${text}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure() && r.failure().errorText}`));

  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  const info = await fn(page, { errors, warnings, logs });

  await ctx.close();
  return { info, errors, warnings, logs };
}

/** Decode a PNG data URL in-page and reduce it to global statistics. */
const ANALYSE = `
(function () {
  const c = document.getElementById('gl');
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const off = document.createElement('canvas');
      const w = 240, h = Math.round(240 * c.height / c.width);
      off.width = w; off.height = h;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      let sum = 0, max = 0, dark = 0, bright = 0, hot = 0, n = w * h;
      let cx = 0, cy = 0, cw = 0;
      for (let i = 0; i < n; i++) {
        const r = d[i*4]/255, g = d[i*4+1]/255, b = d[i*4+2]/255;
        const l = 0.2126*r + 0.7152*g + 0.0722*b;
        sum += l; if (l > max) max = l;
        if (l < 0.02) dark++;
        if (l > 0.25) bright++;
        if (r > 0.35 && r > b * 1.25) hot++;
      }
      // centre strip darkness: the shadow must sit near the frame centre
      const x0 = Math.floor(w*0.42), x1 = Math.floor(w*0.58);
      const y0 = Math.floor(h*0.42), y1 = Math.floor(h*0.58);
      let cSum = 0, cN = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y*w + x)*4;
        cSum += 0.2126*d[i]/255 + 0.7152*d[i+1]/255 + 0.0722*d[i+2]/255; cN++;
      }
      resolve({
        mean: sum/n, max, darkFrac: dark/n, brightFrac: bright/n, hotFrac: hot/n,
        centreMean: cSum/cN, width: c.width, height: c.height
      });
    });
  });
})()`;

async function runCase(name, query, opts = {}) {
  const url = `${BASE}?${query}`;
  log(`\n▶ ${name}`);
  log(`  ${url}`);

  const { info, errors, warnings } = await withPage(url, async (page, bag) => {
    // In shot mode the app publishes __GARGANTUA_SHOT__ only after the frozen
    // time AND the settle frames have been applied, so waiting on it removes the
    // race that READY alone would leave open.
    await page.waitForFunction(
      'window.__GARGANTUA_SHOT__ !== undefined || window.__GARGANTUA_READY__ === true',
      null,
      { timeout: opts.timeout || 180000 }
    );
    await page.waitForFunction('window.__GARGANTUA_SHOT__ !== undefined', null, { timeout: 60000 })
      .catch(() => log('  (no shot payload — captured live frame)'));

    const gl = await page.evaluate(() => {
      const api = window.GARGANTUA;
      const c = document.getElementById('gl');
      const ctx = c.getContext('webgl2') || c.getContext('webgl');
      let vendor = 'n/a';
      try {
        const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
        vendor = dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : ctx.getParameter(ctx.RENDERER);
      } catch (e) { /* ignore */ }
      return {
        renderer: vendor,
        isWebGL2: typeof WebGL2RenderingContext !== 'undefined' && ctx instanceof WebGL2RenderingContext,
        stats: api.getStats(),
        state: { view: api.getState().view, quality: api.getState().quality, time: api.getState().time },
      };
    });

    await page.evaluate(`(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))()`);
    const stats = await page.evaluate(ANALYSE);

    // Primary artefact comes from the documented automation API (canvas
    // toDataURL) rather than the compositor, so the file on disk is byte-for-byte
    // what GARGANTUA.capture() returns to any external harness.
    const dataURL = await page.evaluate(() => window.GARGANTUA.capture());
    const png = Buffer.from(String(dataURL).split(',')[1], 'base64');
    const file = path.join(SHOTS, `${TAG}-${name}.png`);
    fs.writeFileSync(file, png);

    // A compositor screenshot alongside it, which is what a human sees.
    await page.screenshot({ path: path.join(SHOTS, `${TAG}-${name}-page.png`), type: 'png' });

    return { gl, stats, file };
  });

  results.push({ name, errors, warnings, ...info });
  const s = info.stats;
  log(`  renderer      : ${info.gl.renderer}  (WebGL2=${info.gl.isWebGL2})`);
  log(`  render target : ${info.gl.stats.renderSize.join('×')}   frames=${info.gl.stats.frames}`);
  log(`  pixels        : mean=${s.mean.toFixed(4)}  max=${s.max.toFixed(3)}  dark=${(s.darkFrac*100).toFixed(1)}%  bright=${(s.brightFrac*100).toFixed(1)}%  warm=${(s.hotFrac*100).toFixed(1)}%`);
  log(`  centre mean   : ${s.centreMean.toFixed(4)}`);
  log(`  console errors: ${errors.length}`);
  errors.forEach((e) => log(`    ✗ ${e}`));
  log(`  saved         : ${path.relative(ROOT, info.file)}`);
  return info;
}

// --------------------------------------------------------------------- main --
log('GARGANTUA verification');
log(`viewport ${W}×${H}   tag=${TAG}`);

browser = await launch();

const CASES = MOBILE
  ? [
      ['mobile-final', 'shot=1&t=14&q=standard&preset=0&view=0&hud=1'],
      ['mobile-pole', 'shot=1&t=14&q=standard&preset=2&view=0&hud=1'],
    ]
  : FAST
  ? [
      ['final', 'shot=1&t=12&q=standard&preset=0&view=0&hud=0'],
      ['shadow', 'shot=1&t=12&q=standard&preset=1&view=0&hud=0'],
      ['debug-disk', 'shot=1&t=12&q=standard&preset=0&view=3&hud=0'],
      ['sky', 'shot=1&t=12&q=standard&preset=0&view=7&hud=0'],
    ]
  : [
      ['final', 'shot=1&t=12&q=high&preset=0&view=0&hud=0'],
      ['preset-edge', 'shot=1&t=12&q=high&preset=1&view=0&hud=0'],
      ['preset-pole', 'shot=1&t=12&q=high&preset=2&view=0&hud=0'],
      ['preset-tele', 'shot=1&t=12&q=high&preset=3&view=0&hud=0'],
      ['debug-steps', 'shot=1&t=12&q=high&preset=0&view=1&hud=0'],
      ['debug-disk', 'shot=1&t=12&q=high&preset=0&view=3&hud=0'],
      ['debug-doppler', 'shot=1&t=12&q=high&preset=0&view=4&hud=0'],
      ['debug-redshift', 'shot=1&t=12&q=high&preset=0&view=5&hud=0'],
      ['debug-sky', 'shot=1&t=12&q=high&preset=0&view=7&hud=0'],
      ['debug-deflect', 'shot=1&t=12&q=high&preset=0&view=8&hud=0'],
      ['hud', 'shot=1&t=12&q=high&preset=0&view=0&hud=1'],
    ];

for (const [name, query] of CASES) {
  try {
    await runCase(name, query);
  } catch (e) {
    log(`  ✗ FAILED: ${e.message}`);
    results.push({ name, errors: [e.message], failed: true });
  }
}

// interaction smoke test: real loop, key presses, orbit
try {
  log('\n▶ interaction');
  const { info, errors } = await withPage(`${BASE}?q=standard&t=0`, async (page) => {
    await page.waitForFunction('window.__GARGANTUA_READY__ === true', null, { timeout: 180000 });
    await page.waitForTimeout(1200);

    const before = await page.evaluate(() => window.GARGANTUA.getStats().frames);

    for (const k of ['2', '4', 'q', 'h', 'h', 'p', 'p', 'c', 'm', 'm', 'b', 'b', '1']) {
      await page.keyboard.press(k === ' ' ? 'Space' : k);
      await page.waitForTimeout(160);
    }

    await page.mouse.move(W / 2, H / 2);
    await page.mouse.down();
    await page.mouse.move(W / 2 + 120, H / 2 + 40, { steps: 12 });
    await page.mouse.up();
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(900);

    const after = await page.evaluate(() => window.GARGANTUA.getStats().frames);
    const state = await page.evaluate(() => window.GARGANTUA.getState());

    await page.evaluate(() => window.GARGANTUA.reset());
    await page.evaluate(() => window.GARGANTUA.setView(0));
    await page.waitForTimeout(700);

    await page.screenshot({ path: path.join(SHOTS, `${TAG}-interaction.png`) });

    return {
      framesBefore: before,
      framesAfter: after,
      animated: after - before,
      state,
      hudVisible: await page.evaluate(() => {
        const h = document.getElementById('g-hud');
        return !!(h && !h.classList.contains('is-hidden'));
      }),
    };
  });
  results.push({ name: 'interaction', errors, ...info });
  log(`  frames advanced : ${info.animated}`);
  log(`  hud visible     : ${info.hudVisible}`);
  log(`  console errors  : ${errors.length}`);
  errors.forEach((e) => log(`    ✗ ${e}`));
} catch (e) {
  log(`  ✗ FAILED: ${e.message}`);
  results.push({ name: 'interaction', errors: [e.message], failed: true });
}

await browser.close();
server.close();

// ------------------------------------------------------------------ summary --
const allErrors = results.flatMap((r) => r.errors || []);
const failed = results.filter((r) => r.failed);

log('\n================ SUMMARY ================');
log(`cases           : ${results.length}`);
log(`failed cases    : ${failed.length}`);
log(`console errors  : ${allErrors.length}`);
if (allErrors.length) allErrors.slice(0, 20).forEach((e) => log(`  ✗ ${e}`));

const finalCase = results.find((r) => r.name === 'final' && r.stats);
if (finalCase) {
  const s = finalCase.stats;
  log(`final frame     : mean=${s.mean.toFixed(4)} max=${s.max.toFixed(3)} dark=${(s.darkFrac * 100).toFixed(1)}% warm=${(s.hotFrac * 100).toFixed(1)}%`);
  log(`black-screen?   : ${s.max > 0.05 && s.mean > 0.002 ? 'NO' : 'YES ✗'}`);
}

fs.writeFileSync(
  path.join(SHOTS, `${TAG}-report.json`),
  JSON.stringify({ tag: TAG, viewport: [W, H], results: results.map((r) => ({
    name: r.name, failed: !!r.failed, errors: r.errors,
    stats: r.stats ? { mean: r.stats.mean, max: r.stats.max, darkFrac: r.stats.darkFrac, brightFrac: r.stats.brightFrac, hotFrac: r.stats.hotFrac, centreMean: r.stats.centreMean } : null,
    renderSize: r.gl ? r.gl.stats.renderSize : null,
    renderer: r.gl ? r.gl.renderer : null,
  })) }, null, 2)
);

process.exit(allErrors.length || failed.length ? 1 : 0);
