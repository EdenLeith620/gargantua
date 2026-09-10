import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let _pw = null;
try { _pw = require('playwright-core'); } catch { _pw = require('playwright'); }
const chromium = _pw.chromium || (_pw.default && _pw.default.chromium);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8231;

const server = spawn(process.execPath, [path.join(ROOT, 'scripts/serve.mjs'), String(PORT), ROOT], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

await page.goto(`http://127.0.0.1:${PORT}/index.html?hud=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GARGANTUA_READY__ === true, null, { timeout: 30000 });
await page.waitForTimeout(1200);

const layout = await page.evaluate(() => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const hud = document.getElementById('g-hud');
  const left = document.querySelector('.g-col--left');
  const right = document.querySelector('.g-col--right');
  const blocks = [...document.querySelectorAll('.g-col--left > *')].map((el) => ({
    cls: el.className, tag: el.tagName.toLowerCase(), rect: r(el),
  }));
  const overlaps = [];
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i].rect, b = blocks[j].rect;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        overlaps.push([blocks[i].cls, blocks[j].cls]);
      }
    }
  }
  const presets = document.querySelectorAll('#g-preset-list .g-chip').length;
  const views = document.querySelectorAll('#g-view-list .g-chip').length;
  const params = document.querySelectorAll('#g-params .g-param').length;
  return {
    hud: r(hud), left: left ? r(left) : null, right: right ? r(right) : null,
    blocks, overlaps, presets, views, params,
    viewport: { w: innerWidth, h: innerHeight },
  };
});

const rightEdge = (o) => (o ? o.x + o.w : 0);
const bottomEdge = (o) => (o ? o.y + o.h : 0);

console.log('viewport      :', layout.viewport.w + '×' + layout.viewport.h);
console.log('hud           :', JSON.stringify(layout.hud));
console.log('col--left     :', JSON.stringify(layout.left));
console.log('col--right    :', JSON.stringify(layout.right));
console.log('presets/views/params:', layout.presets, '/', layout.views, '/', layout.params);
for (const b of layout.blocks) console.log('  block', b.tag, b.cls.padEnd(34), JSON.stringify(b.rect));
console.log('block overlaps:', layout.overlaps.length ? JSON.stringify(layout.overlaps) : 'NONE');

const checks = [];
checks.push(['two columns exist', !!layout.left && !!layout.right]);
checks.push(['left column on the left of right column', rightEdge(layout.left) <= layout.right.x + 1]);
checks.push(['right column inside viewport', rightEdge(layout.right) <= layout.viewport.w + 1]);
checks.push(['left column inside viewport', layout.left.x >= -1 && rightEdge(layout.left) <= layout.viewport.w + 1]);
checks.push(['no block overlap', layout.overlaps.length === 0]);
checks.push(['4 presets', layout.presets === 4]);
checks.push(['10 debug views', layout.views === 10]);
checks.push(['21 params', layout.params === 21]);
checks.push(['no console errors', errors.length === 0]);

let fail = 0;
for (const [name, ok] of checks) { if (!ok) fail++; console.log((ok ? 'PASS  ' : 'FAIL  ') + name); }
if (errors.length) errors.slice(0, 10).forEach((e) => console.log('  err:', e));

await page.screenshot({ path: path.join(ROOT, 'docs/shots/hud-layout.png') });
console.log('screenshot    : docs/shots/hud-layout.png');
console.log(fail ? `FAILED ${fail}` : 'ALL HUD CHECKS PASSED');

await browser.close();
server.kill();
process.exit(fail ? 1 : 0);
