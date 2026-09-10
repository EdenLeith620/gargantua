/**
 * GARGANTUA — HDR post-processing chain
 * bright-pass -> 4x progressive downsample (13-tap) -> 4x tent upsample
 *            -> composite (chromatic aberration, bloom, ACES, vignette, grain)
 *
 * The whole chain is authored by hand against raw WebGLRenderTargets instead of
 * pulling in the three.js EffectComposer addons, so there is exactly one
 * vendored dependency (three.module.js) and no version-coupling risk.
 */

import { commonChunk } from './common.js';

export const brightPassShader = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform float uThreshold;
uniform float uKnee;

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));

  // Karis soft knee: keeps the bloom from popping as pixels cross the threshold
  float knee = uThreshold * uKnee + 1e-5;
  float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-5);
  float contrib = max(soft, l - uThreshold) / max(l, 1e-5);

  gl_FragColor = vec4(c * contrib, 1.0);
}
`;

export const downsampleShader = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform vec2 uTexel;

void main() {
  vec2 t = uTexel;
  vec3 a = texture2D(tDiffuse, vUv + vec2(-2.0, -2.0) * t).rgb;
  vec3 b = texture2D(tDiffuse, vUv + vec2( 0.0, -2.0) * t).rgb;
  vec3 c = texture2D(tDiffuse, vUv + vec2( 2.0, -2.0) * t).rgb;
  vec3 d = texture2D(tDiffuse, vUv + vec2(-2.0,  0.0) * t).rgb;
  vec3 e = texture2D(tDiffuse, vUv).rgb;
  vec3 f = texture2D(tDiffuse, vUv + vec2( 2.0,  0.0) * t).rgb;
  vec3 g = texture2D(tDiffuse, vUv + vec2(-2.0,  2.0) * t).rgb;
  vec3 h = texture2D(tDiffuse, vUv + vec2( 0.0,  2.0) * t).rgb;
  vec3 i = texture2D(tDiffuse, vUv + vec2( 2.0,  2.0) * t).rgb;
  vec3 j = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * t).rgb;
  vec3 k = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * t).rgb;
  vec3 l = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * t).rgb;
  vec3 m = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * t).rgb;

  vec3 result = e * 0.125;
  result += (a + c + g + i) * 0.03125;
  result += (b + d + f + h) * 0.0625;
  result += (j + k + l + m) * 0.125;

  gl_FragColor = vec4(result, 1.0);
}
`;

export const upsampleShader = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tDiffuse;   // the smaller, already-accumulated mip
uniform sampler2D tBase;      // the current (larger) mip
uniform vec2  uTexel;         // texel size of tDiffuse
uniform float uScatter;

void main() {
  vec2 t = uTexel;
  vec3 s = vec3(0.0);
  s += texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * t).rgb;
  s += texture2D(tDiffuse, vUv + vec2( 0.0, -1.0) * t).rgb * 2.0;
  s += texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * t).rgb;
  s += texture2D(tDiffuse, vUv + vec2(-1.0,  0.0) * t).rgb * 2.0;
  s += texture2D(tDiffuse, vUv).rgb * 4.0;
  s += texture2D(tDiffuse, vUv + vec2( 1.0,  0.0) * t).rgb * 2.0;
  s += texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * t).rgb;
  s += texture2D(tDiffuse, vUv + vec2( 0.0,  1.0) * t).rgb * 2.0;
  s += texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * t).rgb;
  s /= 16.0;

  gl_FragColor = vec4(texture2D(tBase, vUv).rgb + s * uScatter, 1.0);
}
`;

export const compositeShader = /* glsl */ `
precision highp float;
varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tBloom;

uniform float uExposure;
uniform float uBloomStrength;
uniform float uChromatic;
uniform float uGrain;
uniform float uVignette;
uniform float uTime;
uniform vec2  uResolution;
uniform int   uView;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// ACES filmic tonemapping, fitted RRT + ODT (Stephen Hill), as shipped by three.js.
const mat3 ACES_IN = mat3(
  vec3(0.59719, 0.07600, 0.02840),
  vec3(0.35458, 0.90834, 0.13383),
  vec3(0.04823, 0.01566, 0.83777)
);
const mat3 ACES_OUT = mat3(
  vec3( 1.60475, -0.10208, -0.00327),
  vec3(-0.53108,  1.10813, -0.07276),
  vec3(-0.07367, -0.00605,  1.07602)
);

vec3 rrtOdtFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFitted(vec3 color) {
  color *= uExposure / 0.6;
  color = ACES_IN * color;
  color = rrtOdtFit(color);
  color = ACES_OUT * color;
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSRGB(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

void main() {
  // Views 1,2,4,5,6,8 already produce ready-to-display false colour maps and
  // must bypass the whole HDR path, otherwise the colormaps get double-gamma'd.
  bool ldrView = (uView == 1 || uView == 2 || uView == 4 || uView == 5 || uView == 6 || uView == 8);

  if (ldrView) {
    gl_FragColor = vec4(texture2D(tScene, vUv).rgb, 1.0);
    return;
  }

  // ---------------------------------------------- chromatic aberration (HDR)
  vec2 d = vUv - 0.5;
  float r2 = dot(d, d);
  float amt = uChromatic * 0.0125 * (0.35 + r2 * 3.4);

  vec3 scene = vec3(0.0);
  if (amt > 1e-5) {
    scene.r = texture2D(tScene, vUv + d * amt * 1.00).r;
    scene.g = texture2D(tScene, vUv + d * amt * 0.15).g;
    scene.b = texture2D(tScene, vUv - d * amt * 0.85).b;
  } else {
    scene = texture2D(tScene, vUv).rgb;
  }

  vec3 bloom = texture2D(tBloom, vUv).rgb;
  vec3 color;

  if (uView == 9) {
    color = bloom * uBloomStrength;
  } else {
    color = scene + bloom * uBloomStrength;
  }

  color = acesFitted(color);

  // ------------------------------------------------------------- vignette
  if (uVignette > 1e-4) {
    float v = length(d * vec2(1.06, 1.0));
    float falloff = smoothstep(0.86, 0.16, v);
    color *= mix(1.0, falloff, uVignette);
  }

  // ---------------------------------------------------------------- grain
  if (uGrain > 1e-4) {
    float n = hash21(vUv * uResolution + vec2(uTime * 91.7, uTime * 47.3));
    float n2 = hash21(vUv * uResolution * 1.71 - vec2(uTime * 63.1, uTime * 21.9));
    float g = (n * 0.65 + n2 * 0.35) - 0.5;
    float lum = dot(color, vec3(0.299, 0.587, 0.114));
    // Photographic grain lives in the mid-tones: fade it out of the deep blacks
    // and the highlights, otherwise empty space turns into television static.
    float weight = smoothstep(0.015, 0.20, lum) * (1.0 - 0.55 * lum);
    color += g * uGrain * 0.16 * weight;
  }

  gl_FragColor = vec4(linearToSRGB(clamp(color, 0.0, 1.0)), 1.0);
}
`;
