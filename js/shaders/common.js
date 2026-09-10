/**
 * GARGANTUA — shared GLSL chunks
 * Hash / value-noise / fbm / blackbody chromaticity / debug colormaps.
 * All snippets are GLSL ES 1.00 compatible (works on WebGL1 + WebGL2 backends).
 */

export const commonChunk = /* glsl */ `

#define PI      3.141592653589793
#define TAU     6.283185307179586
#define INV_PI  0.3183098861837907

// ---------------------------------------------------------------- hashing --
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

// ------------------------------------------------------------------ noise --
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);

  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

// Rotation-ish decorrelation applied between octaves so that axis-aligned
// value-noise lattices do not produce visible grid artefacts.
vec3 noiseRotate(vec3 p) {
  return vec3(
     p.x * 0.00 + p.y * 0.80 + p.z * 0.60,
    -p.x * 0.80 + p.y * 0.36 - p.z * 0.48,
    -p.x * 0.60 - p.y * 0.48 + p.z * 0.64
  );
}

// oct is a runtime int (uniform); the loop bound is a compile-time constant so
// this stays GLSL ES 1.00 legal while still allowing per-quality octave counts.
float fbm(vec3 p, int oct) {
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    sum += amp * vnoise(p);
    norm += amp;
    p = noiseRotate(p) * 2.03 + 19.19;
    amp *= 0.5;
  }
  return sum / max(norm, 1e-5);
}

float fbmRidged(vec3 p, int oct) {
  float amp = 0.5;
  float sum = 0.0;
  float norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
    sum += amp * n * n;
    norm += amp;
    p = noiseRotate(p) * 2.11 + 7.77;
    amp *= 0.5;
  }
  return sum / max(norm, 1e-5);
}

// -------------------------------------------------------------- blackbody --
// Planckian locus -> linear sRGB, then normalised to unit luminance so that
// chromaticity is decoupled from the bolometric brightness (which the caller
// supplies from the relativistic boost factor g^4).
vec3 blackbodyChroma(float kelvin) {
  float t = clamp(kelvin, 900.0, 42000.0) / 100.0;
  float r, g, b;

  if (t <= 66.0) {
    r = 255.0;
  } else {
    r = 329.698727446 * pow(max(t - 60.0, 1e-3), -0.1332047592);
  }

  if (t <= 66.0) {
    g = 99.4708025861 * log(max(t, 1.0)) - 161.1195681661;
  } else {
    g = 288.1221695283 * pow(max(t - 60.0, 1e-3), -0.0755148492);
  }

  if (t >= 66.0) {
    b = 255.0;
  } else if (t <= 19.0) {
    b = 0.0;
  } else {
    b = 138.5177312231 * log(max(t - 10.0, 1e-3)) - 305.0447927307;
  }

  vec3 srgb = clamp(vec3(r, g, b) / 255.0, 0.0, 1.0);
  vec3 lin = pow(srgb, vec3(2.2));

  float lum = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  return lin / max(lum, 0.06);
}

vec3 blackbodyRadiance(float kelvin, float bolometric) {
  return blackbodyChroma(kelvin) * bolometric;
}

// -------------------------------------------------------------- colormaps --
// Polynomial fit of Google's Turbo colormap (Zucker), valid on [0,1].
vec3 turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  const vec4 kR4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kG4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kB4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kR2 = vec2(-152.94239396, 59.28637943);
  const vec2 kG2 = vec2(4.27729857, 2.82956604);
  const vec2 kB2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(
    dot(v4, kR4) + dot(v2, kR2),
    dot(v4, kG4) + dot(v2, kG2),
    dot(v4, kB4) + dot(v2, kB2)
  ), 0.0, 1.0);
}

vec3 viridis(float x) {
  x = clamp(x, 0.0, 1.0);
  const vec3 c0 = vec3(0.2670, 0.0049, 0.3294);
  const vec3 c1 = vec3(0.2298, 0.3227, 0.5453);
  const vec3 c2 = vec3(0.1276, 0.5669, 0.5507);
  const vec3 c3 = vec3(0.3691, 0.7886, 0.3827);
  const vec3 c4 = vec3(0.9932, 0.9062, 0.1439);
  if (x < 0.25) return mix(c0, c1, x * 4.0);
  if (x < 0.50) return mix(c1, c2, (x - 0.25) * 4.0);
  if (x < 0.75) return mix(c2, c3, (x - 0.50) * 4.0);
  return mix(c3, c4, (x - 0.75) * 4.0);
}

// Diverging map for signed quantities (-1 .. +1): blue = receding, red = approaching.
vec3 diverging(float x) {
  float s = sign(x);
  float a = clamp(abs(x), 0.0, 1.0);
  vec3 warm = vec3(1.0, 0.28, 0.12);
  vec3 cool = vec3(0.22, 0.55, 1.0);
  vec3 base = mix(vec3(0.055, 0.06, 0.07), s > 0.0 ? warm : cool, pow(a, 0.7));
  return base;
}

float luma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// Small helper used by the debug views that need a hard log-ish ramp.
float normalizeLog(float value, float lo, float hi) {
  float v = clamp((value - lo) / max(hi - lo, 1e-5), 0.0, 1.0);
  return v;
}
`;

export const fullscreenVertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
