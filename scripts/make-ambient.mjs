/**
 * GARGANTUA — ambient loop generator.
 *
 * Produces a strictly seamless 30 s stereo bed.  Seamlessness is guaranteed by
 * construction rather than by cross-fading: every partial frequency, every AM
 * rate and every phase increment is chosen as an exact integer multiple of
 * 1/DURATION Hz, so each component completes a whole number of cycles inside
 * the window and sample[N-1] joins sample[0] with no discontinuity.
 *
 *   node scripts/make-ambient.mjs
 *   -> assets/audio/gargantua-ambient.wav   (16-bit PCM, 22.05 kHz)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '..', 'assets', 'audio');

const SR = 22050;
const DUR = 30;
const N = SR * DUR;
const BASE = 1 / DUR; // the quantum every frequency must be a multiple of

/** snap any frequency to the nearest seamless multiple of 1/DURATION */
const snap = (f) => Math.max(1, Math.round(f / BASE)) * BASE;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const rnd = lcg(0x5eed1a3);

/**
 * Partial table: [freq, amplitude, pan(-1..1), phase, amRate, amDepth]
 * Everything goes through snap(), so the whole stack is loop-safe.
 */
const PARTIALS = [];

function add(f, amp, pan = 0, amRate = 0, amDepth = 0) {
  PARTIALS.push({
    f: snap(f),
    amp,
    pan,
    phaseL: rnd() * Math.PI * 2,
    phaseR: rnd() * Math.PI * 2,
    amRate: amRate > 0 ? snap(amRate) : 0,
    amDepth,
    amPhase: rnd() * Math.PI * 2,
  });
}

// --- sub + drone ------------------------------------------------------------
add(27.5, 0.62);
add(41.25, 0.30);
add(55.0, 0.52, -0.18);
add(55.0 + BASE, 0.46, 0.18);
add(82.5, 0.24, 0.22);
add(110.0, 0.15, -0.25, 1 / 15, 0.45);
add(137.5, 0.085, 0.30, 1 / 15, 0.55);
add(165.0, 0.062, -0.30, 1 / 10, 0.6);
add(220.0, 0.040, 0.35, 1 / 10, 0.65);

// --- wide shimmer harmonics ------------------------------------------------
[
  [275.0, 0.024], [330.0, 0.020], [440.0, 0.015],
  [550.0, 0.011], [660.0, 0.0085], [880.0, 0.0058], [1100.0, 0.0040],
  [1320.0, 0.0026], [1760.0, 0.0015],
].forEach(([f, a], i) => {
  add(f, a, (i % 2 === 0 ? 1 : -1) * 0.42, 1 / 10 + (i % 3) / 30, 0.75);
});

// --- pseudo-noise bed: 96 random partials, all snap-locked ------------------
for (let i = 0; i < 96; i++) {
  const f = 190 + Math.pow(rnd(), 2.1) * 2100;
  const a = 0.0022 * (1 - rnd() * 0.65);
  add(f, a, rnd() * 2 - 1, 0.1 + rnd() * 0.4, 0.9);
}

// --- sparse bell-ish upper tones -------------------------------------------
for (let i = 0; i < 14; i++) {
  const f = [440, 523.25, 659.25, 783.99, 880, 1046.5][i % 6] * (i > 6 ? 2 : 1);
  add(f, 0.006 * (0.5 + rnd()), rnd() * 2 - 1, 1 / 30 + rnd() / 30, 1.0);
}

// --- render -----------------------------------------------------------------
const L = new Float64Array(N);
const R = new Float64Array(N);

for (const p of PARTIALS) {
  // Identical frequency on both channels (a half-quantum detune would break
  // periodicity); stereo width comes from fully decorrelated phases instead.
  const wl = 2 * Math.PI * p.f / SR;
  const wr = wl;
  const wam = 2 * Math.PI * p.amRate / SR;
  const gl = Math.cos((p.pan + 1) * Math.PI / 4);
  const gr = Math.sin((p.pan + 1) * Math.PI / 4);

  for (let i = 0; i < N; i++) {
    const am = p.amRate > 0
      ? (1 - p.amDepth) + p.amDepth * (0.5 + 0.5 * Math.sin(wam * i + p.amPhase))
      : 1;
    const s = p.amp * am;
    L[i] += s * gl * Math.sin(wl * i + p.phaseL) * 1.4142;
    R[i] += s * gr * Math.sin(wr * i + p.phaseR) * 1.4142;
  }
}

// --- DC block, gentle saturation, normalise ---------------------------------
let peak = 0;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * 1.05);
  R[i] = Math.tanh(R[i] * 1.05);
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const norm = peak > 0 ? 0.62 / peak : 1;

const pcm = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  const l = Math.max(-1, Math.min(1, L[i] * norm));
  const r = Math.max(-1, Math.min(1, R[i] * norm));
  pcm.writeInt16LE(Math.round(l * 32760), i * 4);
  pcm.writeInt16LE(Math.round(r * 32760), i * 4 + 2);
}

// --- WAV container ----------------------------------------------------------
const header = Buffer.alloc(44);
header.write('RIFF', 0, 'ascii');
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8, 'ascii');
header.write('fmt ', 12, 'ascii');
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);          // PCM
header.writeUInt16LE(2, 22);          // stereo
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28);     // byte rate
header.writeUInt16LE(4, 32);          // block align
header.writeUInt16LE(16, 34);         // bits
header.write('data', 36, 'ascii');
header.writeUInt32LE(pcm.length, 40);

fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, 'gargantua-ambient.wav');
fs.writeFileSync(out, Buffer.concat([header, pcm]));

// Seam check: the wrap-around step must look like any other adjacent step.
// Comparing |s[0]-s[N-1]| to zero would be meaningless for a signal with content
// up to a couple of kHz.
let sumAbs = 0;
let maxAbs = 0;
for (let i = 1; i < N; i++) {
  const d = Math.abs(L[i] - L[i - 1]);
  sumAbs += d;
  maxAbs = Math.max(maxAbs, d);
}
const meanStep = sumAbs / (N - 1);
const seamStep = Math.abs(L[0] - L[N - 1]);
const seamZ = seamStep / meanStep;

console.log(`wrote ${out}  (${(fs.statSync(out).size / 1048576).toFixed(2)} MB)`);
console.log(`partials=${PARTIALS.length}  peak=${peak.toFixed(4)}`);
console.log(`mean adjacent step=${meanStep.toExponential(3)}  wrap step=${seamStep.toExponential(3)}  ratio=${seamZ.toFixed(2)}x`);
console.log(seamZ < 4 ? 'LOOP: seamless (wrap step is within the normal sample-to-sample range)' : 'LOOP: DISCONTINUITY DETECTED');
