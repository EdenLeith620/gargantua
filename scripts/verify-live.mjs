import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let _pw = null;
try { _pw = require('playwright-core'); } catch { _pw = require('playwright'); }
const chromium = _pw.chromium || (_pw.default && _pw.default.chromium);

const URL_ARG = process.argv[2] || 'https://edenleith620.github.io/gargantua/';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
const failed = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => failed.push(r.url() + ' :: ' + (r.failure() && r.failure().errorText)));

console.log('target :', URL_ARG);

const t0 = Date.now();
await page.goto(URL_ARG, { waitUntil: 'load', timeout: 60000 });
console.log('load   :', (Date.now() - t0) + ' ms');

let ready = false;
try {
  await page.waitForFunction(() => window.__GARGANTUA_READY__ === true, null, { timeout: 45000 });
  ready = true;
} catch { ready = false; }
console.log('ready  :', ready);

await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
  const c = document.getElementById('gl');
  const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : 'no-gl');

  let stats = null;
  if (c && c.width > 0) {
    const W = 240, H = Math.max(1, Math.round(c.height * (W / c.width)));
    const off = document.createElement('canvas'); off.width = W; off.height = H;
    const x = off.getContext('2d'); x.drawImage(c, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data;
    let sum = 0, max = 0, dark = 0, bright = 0, warm = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += l; n++;
      if (l > max) max = l;
      if (l < 0.02) dark++;
      if (l > 0.25) bright++;
      if (r > 0.35 && r > b * 1.25) warm++;
    }
    stats = { mean: +(sum / n).toFixed(4), max: +max.toFixed(3), darkFrac: +(dark / n).toFixed(3), brightFrac: +(bright / n).toFixed(3), warmFrac: +(warm / n).toFixed(3) };
  }

  return {
    renderer,
    webgl2: !!(c && c.getContext('webgl2')),
    canvas: c ? [c.width, c.height] : null,
    stats,
    hud: !!document.querySelector('.g-hud'),
    presets: document.querySelectorAll('#g-preset-list .g-chip').length,
    params: document.querySelectorAll('#g-params .g-param').length,
    stats_fn: typeof (window.GARGANTUA && window.GARGANTUA.getStats),
  };
});

console.log('renderer:', info.renderer);
console.log('webgl2 :', info.webgl2, ' canvas:', info.canvas);
console.log('pixels :', JSON.stringify(info.stats));
console.log('hud    :', info.hud, ' presets:', info.presets, ' params:', info.params);
console.log('GARGANTUA.getStats:', info.stats_fn);

// one interaction pass: switch preset + debug view, confirm the loop still advances
const before = await page.evaluate(() => (window.GARGANTUA.getStats() || {}).frames);
await page.keyboard.press('Shift+3');
await page.waitForTimeout(700);
await page.keyboard.press('0');
await page.waitForTimeout(700);
const after = await page.evaluate(() => (window.GARGANTUA.getStats() || {}).frames);
console.log('frames :', before, '->', after);

await page.screenshot({ path: path.join(ROOT, 'docs/shots/live-pages.png') });

const checks = [
  ['page ready flag', ready],
  ['WebGL2 context', info.webgl2],
  ['real renderer (not null)', !!info.renderer && info.renderer !== 'no-gl'],
  ['not a black screen', !!info.stats && info.stats.max > 0.3 && info.stats.mean > 0.02],
  ['has warm disk tones', !!info.stats && info.stats.warmFrac > 0.02],
  ['HUD built', info.hud],
  ['4 presets', info.presets === 4],
  ['21 params', info.params === 21],
  ['frame loop advancing', after > before],
  ['0 console errors', errors.length === 0],
  ['0 failed requests', failed.length === 0],
];

let fail = 0;
console.log('\n---- live site checks ----');
for (const [name, ok] of checks) { if (!ok) fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name); }
if (errors.length) errors.slice(0, 8).forEach((e) => console.log('  err :', e));
if (failed.length) failed.slice(0, 8).forEach((e) => console.log('  net :', e));
console.log(fail ? `\nFAILED ${fail}` : '\nALL LIVE CHECKS PASSED');
console.log('screenshot: docs/shots/live-pages.png');

await browser.close();
process.exit(fail ? 1 : 0);
