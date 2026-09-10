import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let _pw = null;
try { _pw = require('playwright-core'); } catch { _pw = require('playwright'); }
const chromium = _pw.chromium || (_pw.default && _pw.default.chromium);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8241;
const TIERS = ['standard', 'high', 'cinematic'];

const server = spawn(process.execPath, [path.join(ROOT, 'scripts/serve.mjs'), String(PORT), ROOT], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${PORT}/index.html?nostore=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__GARGANTUA_READY__ === true, null, { timeout: 30000 });

console.log('viewport 1600×900  dpr 1  (adaptive resolution ON — settles by itself)\n');
console.log('tier         fps    frame   render px     Mpx/f   steps   Mstep/f');
console.log('---------------------------------------------------------------');

for (const tier of TIERS) {
  await page.evaluate((t) => window.GARGANTUA.setQuality(t), tier);
  // let the adaptive-resolution controller settle instead of sampling the first frame
  await page.waitForTimeout(7000);
  const s = await page.evaluate(() => window.GARGANTUA.getStats());
  const rw = s.renderW ?? s.renderWidth ?? (s.renderSize && s.renderSize[0]);
  const rh = s.renderH ?? s.renderHeight ?? (s.renderSize && s.renderSize[1]);
  const px = rw * rh;
  const stepM = (px * s.steps) / 1e6;
  console.log(
    tier.padEnd(12),
    String(Math.round(s.fps)).padStart(4),
    (Math.round(1000 / s.fps) + 'ms').padStart(7),
    (rw + '×' + rh).padStart(11),
    (px / 1e6).toFixed(2).padStart(7),
    String(s.steps).padStart(6),
    stepM.toFixed(1).padStart(9)
  );
}

console.log('\nnote: headless Chrome has no display vsync; treat these as relative cost,');
console.log('      and note the adaptive controller trades resolution to hold ~20+ fps.');

await browser.close();
server.kill();
