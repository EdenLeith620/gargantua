/** Diagnostic probe: reports WebGL backend, first-frame latency and errors. */
import path from 'node:path';
import { createServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NM = '/Users/fenglinshen/.workbuddy/binaries/node/workspace/node_modules';
const _pw = await import(path.join(NM, 'playwright-core', 'index.js'));
const chromium = _pw.chromium || (_pw.default && _pw.default.chromium);

const query = process.argv[2] || 'q=standard&preset=0&hud=0';
const PORT = 8139;

const server = createServer(ROOT);
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const args = ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=default', '--enable-webgl'];
const b = await chromium.launch({ headless: true, channel: 'chrome', args });
const ctx = await b.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();

const errs = [];
const warns = [];
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
  else if (m.type() === 'warning') warns.push(m.text());
});
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/index.html?${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log('domcontentloaded at', Date.now() - t0, 'ms');

for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(4000);
  const st = await page.evaluate(() => {
    const out = {};
    try {
      const c = document.getElementById('gl');
      const g = c.getContext('webgl2') || c.getContext('webgl');
      const d = g && g.getExtension('WEBGL_debug_renderer_info');
      out.renderer = g ? (d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?') : 'no ctx';
      out.ready = !!window.__GARGANTUA_READY__;
      out.stats = window.GARGANTUA ? window.GARGANTUA.getStats() : null;
      const f = document.getElementById('g-fatal');
      out.fatal = f ? !f.hidden : null;
    } catch (e) { out.err = String(e); }
    return out;
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log('t+' + secs + 's', JSON.stringify(st));
  if (st.ready) break;
  if (i === 1) {
    const proto = await page.evaluate(async () => {
      const m = await import('/js/hud.js');
      return Object.getOwnPropertyNames(m.HUD.prototype);
    });
    console.log('  HUD.prototype (as seen by the browser):', proto.join(', '));
  }
  if (i >= 3) break;
}

console.log('ERRORS', errs.length);
errs.slice(0, 15).forEach((e) => console.log('  E', e));
console.log('WARNS', warns.length);
warns.slice(0, 8).forEach((e) => console.log('  W', e));

await page.screenshot({ path: '/tmp/probe-shot.png' });
console.log('screenshot written');
await b.close();
server.close();
