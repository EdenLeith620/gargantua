/**
 * GARGANTUA — Schwarzschild null-geodesic raytracer (fragment shader)
 * ===================================================================
 *
 * PHYSICS
 * -------
 * Units: the Schwarzschild radius r_s is the length unit of the integrator and
 * is supplied as uRS (param #1, "mass / horizon scale").  All radii handed to
 * the shader (disk inner/outer, scale height, camera radius, escape radius) are
 * absolute scene units, scaled on the JS side by the same factor, so uRS is the
 * only thing that decides how large the horizon appears in the frame.
 *
 * The exact null-geodesic orbit equation in Schwarzschild coordinates is
 *
 *      d^2u/dphi^2 + u = (3/2) r_s u^2 ,      u = 1/r
 *
 * which, after taking the first integral and identifying L = r^2 dphi/dlambda,
 * is *exactly* equivalent to the central 3-D ODE
 *
 *      d^2x/dlambda^2 = -(3/2) r_s h^2 x / r^5 ,   h = |x cross dx/dlambda|
 *
 * (checked by re-deriving the radial equation r'' = h^2/r^3 (1 - (3/2) r_s/r)
 * and matching it against the Binet form).  Because the ODE is central, the
 * vector x cross v is conserved along the numerical integration, which is what
 * makes the thin-disk Doppler term below well defined and exact.
 *
 * Initial conditions come from the local orthonormal frame of a *static*
 * observer at r0 — NOT the usual flat-space approximation:
 *      E_loc   = E / sqrt(1 - r_s/r0)             (locally measured energy)
 *      cos psi = (dr/dlambda) / E                 (psi = angle to radial dir)
 *      b = L/E = r0 sin psi / sqrt(1 - r_s/r0)
 * Fixing E = 1 gives the coordinate velocity
 *      v = cos(psi) r_hat + tangent / sqrt(1 - r_s/r0)
 * so |x cross v| = b is conserved to machine accuracy.
 *
 * OBSERVED RADIATION
 * ------------------
 * For Keplerian circular motion, Omega = sqrt(M/r^3), u^t = 1/sqrt(1-3M/r), and
 * the full frequency ratio between the emitter and a static observer at infinity
 * is
 *      g_full = sqrt(1 - 3M/r) / (1 - Omega b_phi),     b_phi = L_phi / E
 * which factorises into a purely gravitational and a purely Doppler part:
 *      g_grav = sqrt(1 - r_s/r),      D = g_full / g_grav
 * Then, using the invariance of I_nu/nu^3:
 *      T_obs = T_em * g_grav^a * D^b          (a = uRedshift, b = uDoppler)
 *      I_obs ~ I_em * (g_grav^a * D^b)^4      (bolometric)
 * With a = b = 1 this reproduces the textbook Schwarzschild disk: escaping
 * photons from r = 3 r_s are limited by b_crit = 3 sqrt(3) M = 2.598 r_s, which
 * caps the blueshift and yields the observed ~16x approaching/receding
 * brightness ratio rather than the naive 90x.
 */

import { commonChunk } from './common.js';

export const blackHoleFragmentShader = /* glsl */ `
precision highp float;
precision highp int;

varying vec2 vUv;

// ------------------------------------------------------------------ inputs --
uniform float uTime;
uniform float uFlowTime;
uniform float uPixelAngle;      // angular size of one render-target pixel (rad)

uniform vec3  uCamPos;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform vec3  uCamFwd;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uEscapeR;

// --- spacetime scale --------------------------------------------------------
uniform float uRS;              // Schwarzschild radius in scene units
uniform float uMM;              // 0.5 * uRS  (geometric mass GM/c^2)

// --- physics params ---------------------------------------------------------
uniform float uDiskInner;
uniform float uDiskOuter;
uniform float uDiskThickness;
uniform float uDiskDensity;
uniform float uDiskTemp;
uniform float uTurbulence;
uniform float uFlowSpeed;
uniform float uDoppler;
uniform float uRedshift;
uniform float uLensing;
uniform float uStarBright;
uniform float uStarDensity;
uniform float uGalaxy;
uniform float uDiskGain;

// --- integration / quality --------------------------------------------------
uniform int   uMaxSteps;
uniform float uStepAngle;
uniform float uStepRadial;
uniform int   uIntegrator;      // 0 = velocity Verlet, 1 = RK4
uniform int   uOct;             // fbm octaves
uniform int   uDiskEnabled;
uniform int   uView;

${commonChunk}

const int MAX_STEPS = 1152;

// ============================================================ geodesic ODE ==

vec3 geoAccel(vec3 p, float h2) {
  float r2 = dot(p, p);
  float r  = sqrt(r2);
  // -(3/2) r_s h^2 x / r^5 .  uLensing scales the curvature term; 1.0 = exact GR,
  // 0.0 degenerates to straight lines (flat spacetime).
  return (-1.5 * uRS * uLensing * h2 / max(r2 * r2 * r, 1e-6)) * p;
}

// Velocity Verlet: symmetric, 2 force evaluations, good long-term behaviour.
void integrateVerlet(vec3 p, vec3 v, float h2, float dl, out vec3 np, out vec3 nv) {
  vec3 a0 = geoAccel(p, h2);
  np = p + v * dl + 0.5 * a0 * dl * dl;
  vec3 a1 = geoAccel(np, h2);
  nv = v + 0.5 * (a0 + a1) * dl;
}

// Classical RK4: 4 force evaluations, allows far larger steps through the
// critical region — this is what resolves the higher-order photon-ring images.
void integrateRK4(vec3 p, vec3 v, float h2, float dl, out vec3 np, out vec3 nv) {
  vec3 k1p = v;
  vec3 k1v = geoAccel(p, h2);

  vec3 p2 = p + 0.5 * dl * k1p;
  vec3 v2 = v + 0.5 * dl * k1v;
  vec3 k2p = v2;
  vec3 k2v = geoAccel(p2, h2);

  vec3 p3 = p + 0.5 * dl * k2p;
  vec3 v3 = v + 0.5 * dl * k2v;
  vec3 k3p = v3;
  vec3 k3v = geoAccel(p3, h2);

  vec3 p4 = p + dl * k3p;
  vec3 v4 = v + dl * k3v;
  vec3 k4p = v4;
  vec3 k4v = geoAccel(p4, h2);

  np = p + (dl / 6.0) * (k1p + 2.0 * k2p + 2.0 * k3p + k4p);
  nv = v + (dl / 6.0) * (k1v + 2.0 * k2v + 2.0 * k3v + k4v);
}

// Adaptive step: bounded angular advance + bounded relative radial advance.
// Far out the radial bound dominates and the ray coasts cheaply; near the
// photon sphere the angular bound takes over and resolves the critical orbits.
float stepSize(float r, float hAbs) {
  float bUse = max(hAbs, 0.02);
  float dlAng = uStepAngle * r * r / bUse;
  float dlRad = uStepRadial * r;
  return clamp(min(dlAng, dlRad), 0.0035, 4.0);
}

// ============================================================ accretion disk ==

float diskScaleHeight(float r) {
  return max(uDiskThickness * (0.17 * r + 0.22 * uRS), 0.012 * uRS);
}

// Shakura-Sunyaev thin-disk temperature profile, normalised so T^4 peaks at
// exactly 1.0.  The peak sits at x = rin/r = 0.7347, i.e. r = 1.361 * rin.
float diskT4(float r) {
  float x = uDiskInner / max(r, 1e-4);
  float f = pow(max(x, 0.0), 3.0) * max(1.0 - sqrt(max(x, 0.0)), 0.0);
  return clamp(f / 0.0566618, 0.0, 1.35);
}

// Turbulence is evaluated in the frame that co-rotates with the local Keplerian
// flow, so the differential rotation winds the field into spiral filaments on
// its own — no spiral geometry is ever authored by hand.
float diskTurbulence(float r, float phi, int oct) {
  float lr = log(max(r / uDiskInner, 1e-3));
  float omega = sqrt(uMM / max(r * r * r, 1e-6));
  // 1.15*lr is a *static* logarithmic-spiral phase, so the disk reads as a sheared
  // cascade from the very first frame instead of only after the flow has had time
  // to wind up. The omega term then adds the live differential rotation on top.
  float ang = phi + 1.15 * lr - omega * uFlowTime * 4.0;

  // Azimuthal coordinate is stretched relative to the radial one, so eddies come
  // out as long streaks rather than isotropic blobs.
  float w = 2.60 + 3.60 * lr;
  vec2 rc = vec2(cos(ang), sin(ang)) * w;

  int o2 = max(oct - 1, 2);
  float n1 = fbm(vec3(rc.x, 0.32 * lr, rc.y) * 0.95, oct);
  float n2 = fbm(vec3(rc.x * 2.60, lr * 3.60, rc.y * 2.60), o2);
  float st = fbm(vec3(rc.x * 6.40, lr * 1.10, rc.y * 6.40), o2);
  // ridged octaves give the sharp-edged filaments a sheared cascade actually has
  float fil = fbmRidged(vec3(rc.x * 1.70, lr * 2.60, rc.y * 1.70), o2);

  float v = n1 * 0.52 + n2 * 0.24 + st * 0.13 + fil * 0.40;
  return clamp(v, 0.0, 1.7);
}

// Contrast curve: the raw fbm sits in a narrow band around its mean, which reads
// as flat grey.  Remapping through a steep S-curve is what actually turns it into
// visible filaments.
float turbContrast(float t) {
  float x = clamp((t - 0.30) / 0.72, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

float diskEnvelope(float r) {
  float inner = smoothstep(uDiskInner, uDiskInner * 1.18 + 0.05 * uRS, r);
  float outer = 1.0 - smoothstep(uDiskOuter * 0.60, uDiskOuter, r);
  return clamp(inner * outer, 0.0, 1.0);
}

// Optically thick source function at radius r, given the conserved angular
// momentum projected on the disk axis.
vec3 diskSource(float r, float bPhi, out float gTot, out float gravF, out float dopF) {
  float t4 = diskT4(r);
  float tn = pow(max(t4, 1e-7), 0.25);

  float omega = sqrt(uMM / max(r * r * r, 1e-6));
  // 1 - Omega*b_phi is strictly positive for every photon that actually reaches
  // this radius from the disk, so the clamp is a pure numerical guard — and it
  // must clamp to a POSITIVE floor, otherwise dopF goes negative and pow()
  // returns NaN, which is exactly how a black hole renderer turns into a white
  // screen.
  float denom = max(1.0 - omega * bPhi, 0.20);

  gravF = sqrt(max(1.0 - uRS / r, 1e-3));
  float gFull = sqrt(max(1.0 - 3.0 * uMM / r, 1e-3)) / denom;
  dopF = clamp(gFull / gravF, 0.05, 4.0);

  gTot = pow(gravF, uRedshift) * pow(dopF, uDoppler);
  gTot = clamp(gTot, 0.05, 3.0);

  float g4 = pow(gTot, 4.0);
  vec3 chroma = blackbodyChroma(uDiskTemp * tn * gTot);
  return chroma * t4 * g4 * uDiskGain;
}

// ============================================================ procedural sky ==

// Cell-based star layer.  Only the cell containing the sample point is
// inspected: the PSF is small compared with the randomised star offset, so
// nothing can bleed across a cell boundary and a single tap is sufficient.
vec3 starLayer(vec3 dir, float scale, float seed, float density, float gain) {
  vec3 p = dir * scale;
  vec3 id = floor(p);
  vec3 f = fract(p) - 0.5;
  vec3 rnd = hash33(id + seed);

  if (rnd.x > density) return vec3(0.0);

  vec3 sp = (rnd - 0.5) * 0.70;
  float d = length(f - sp);

  float mag = pow(hash13(id * 1.7 + seed * 3.13), 4.5);
  float rad = mix(0.045, 0.135, mag);
  float pxCells = max(uPixelAngle * scale, 1e-5);
  float aa = max(rad, pxCells * 0.62);

  float s = d / aa;
  float core = exp(-1.7 * s * s);
  float halo = 0.075 * exp(-0.58 * s);
  // flux conserving: stops faint sub-pixel stars from ballooning into blobs
  float flux = min(1.0, rad / aa);
  float I = (core + halo) * mag * gain * flux * flux;

  float kelvin = mix(2500.0, 15000.0, pow(hash13(id + 17.3), 1.7));
  return blackbodyChroma(kelvin) * I;
}

vec3 starField(vec3 dir) {
  float dens = uStarDensity;
  vec3 c = vec3(0.0);
  c += starLayer(dir, 54.0, 1.7, clamp(dens * 1.00, 0.0, 1.0), 1.90);
  c += starLayer(dir, 148.0, 9.1, clamp(dens * 0.48, 0.0, 1.0), 0.62);
  c += starLayer(dir, 402.0, 23.7, clamp(dens * 0.34, 0.0, 1.0), 0.20);
  return c;
}

const vec3 GAL_N = normalize(vec3(0.3524, 0.8018, -0.4843));
const vec3 GAL_C = normalize(vec3(-0.7195, 0.2763, 0.6371));

vec3 galaxyBand(vec3 dir) {
  float lat = dot(dir, GAL_N);
  float band = exp(-pow(abs(lat) / 0.185, 1.65));

  float n1 = fbm(dir * 6.5 + 3.0, 4);
  float n2 = fbm(dir * 17.0 + 41.0, 3);
  float clouds = pow(clamp(n1 * 0.78 + n2 * 0.42, 0.0, 1.5), 2.1);
  float dust = smoothstep(0.34, 0.78, fbm(dir * 10.5 + 61.0, 4));

  float core = pow(max(dot(dir, GAL_C), 0.0), 26.0);

  float glow = band * (0.16 + 1.05 * clouds) * (1.0 - 0.72 * dust);
  vec3 warm = vec3(1.000, 0.735, 0.435);
  vec3 cool = vec3(0.545, 0.690, 1.000);
  vec3 col = mix(cool, warm, clamp(n1 * 1.25 + 0.10, 0.0, 1.0)) * glow;
  col += warm * core * 1.35 + cool * core * 0.45;
  col += vec3(0.020, 0.028, 0.045) * (0.35 + 0.65 * n2);
  return col * 0.075;
}

vec3 skyRadiance(vec3 dir) {
  return starField(dir) * uStarBright + galaxyBand(dir) * uGalaxy;
}

// ==================================================================== main ==

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;

  vec3 rayDir = normalize(
    uCamFwd
    + uCamRight * (ndc.x * uTanHalfFov * uAspect)
    + uCamUp    * (ndc.y * uTanHalfFov)
  );

  float r0 = length(uCamPos);
  vec3  rHat = uCamPos / max(r0, 1e-5);
  float cosPsi = dot(rayDir, rHat);
  vec3  tangent = rayDir - cosPsi * rHat;

  float lapse = sqrt(max(1.0 - uRS / max(r0, 1.001 * uRS), 1e-4));
  vec3  x = uCamPos;
  vec3  v = cosPsi * rHat + tangent / lapse;   // E = 1 normalisation

  vec3  hVec = cross(x, v);
  float hAbs = length(hVec);
  float h2   = hAbs * hAbs;

  // Conjugate momentum to the disk azimuth, and the one sign in this shader that
  // is genuinely easy to get backwards.
  //
  //   With x = r(cos phi, 0, sin phi), phi increasing anti-clockwise about -y:
  //       p_phi = r^2 dphi/dlambda = -(x cross v)_y
  //   But lambda runs from the camera OUTWARDS, so dx/dlambda is the time
  //   reverse of the photon's actual momentum: under time reversal the spatial
  //   momentum flips while the energy stays positive, hence
  //       b_phi = L_real/E = +(x cross v)_y / E
  //   Taking the minus sign puts the Doppler-brightened limb on the wrong side
  //   of the disk — an error that looks entirely plausible until you compare the
  //   bright limb against the direction the turbulence is actually flowing.
  float bPhi = hVec.y;

  vec3  accum = vec3(0.0);
  float throughput = 1.0;
  bool  captured = false;
  bool  diskHit = false;

  float dopBest = 1.0;
  float redBest = 1.0;
  float tauBest = 0.0;
  float emisBest = 0.0;
  float stepsUsed = 0.0;

  vec3 vStart = normalize(v);
  vec3 dirFinal = vStart;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= uMaxSteps) break;
    stepsUsed = float(i);

    float r = length(x);
    if (r <= uRS) { captured = true; break; }
    if (r > uEscapeR && dot(v, x) > 0.0) { dirFinal = normalize(v); break; }
    if (throughput < 0.004) break;

    float dl = stepSize(r, hAbs);
    vec3 nx, nv;
    if (uIntegrator == 1) integrateRK4(x, v, h2, dl, nx, nv);
    else                  integrateVerlet(x, v, h2, dl, nx, nv);

    // -------------------------------------------------- disk plane crossings
    // Exact linear interpolation onto y = 0 keeps the disk edge razor sharp no
    // matter how coarse the geodesic step is.  Every crossing is accumulated in
    // front-to-back order, which is what produces the multiple-images look.
    if (uDiskEnabled == 1 && x.y * nx.y < 0.0) {
      float t = x.y / (x.y - nx.y);
      vec3 hp = mix(x, nx, t);
      float hr = length(hp.xz);
      if (hr > uDiskInner && hr < uDiskOuter) {
        vec3 hv = mix(v, nv, t);
        float phi = atan(hp.z, hp.x);

        float env = diskEnvelope(hr);
        float tc = turbContrast(diskTurbulence(hr, phi, uOct));

        // Turbulence has to act on BOTH axes. Opacity alone is useless here: at
        // grazing incidence tau saturates, alpha pins to 1, and the whole disk
        // collapses into a featureless grey plate — which is exactly what it did
        // before this line existed. Free-free emission goes as rho^2, so the
        // emissivity gets the squared (steeper) modulation.
        float fOpac = mix(1.0, 0.28 + 1.45 * tc, uTurbulence);
        float fEmis = mix(1.0, 0.06 + 2.55 * pow(tc, 2.15), uTurbulence);
        float dens = clamp(env * fOpac, 0.0, 2.4);

        float cosT = abs(hv.y) / max(length(hv), 1e-6);
        float path = 2.0 * diskScaleHeight(hr) / max(cosT, 0.045);
        float tau = uDiskDensity * path * dens;

        if (tau > 1e-4 && dens > 1e-3) {
          float gT, gG, gD;
          vec3 S = diskSource(hr, bPhi, gT, gG, gD) * fEmis;
          float alpha = 1.0 - exp(-tau);
          accum += throughput * S * alpha;
          throughput *= (1.0 - alpha);
          diskHit = true;

          float em = luma(S) * alpha * env;
          if (em > emisBest) {
            emisBest = em;
            dopBest = gD;
            redBest = gG;
            tauBest = tau;
          }
        }
      }
    }

    // ---------------------------------------------- volumetric disk corona
    if (uDiskEnabled == 1 && throughput > 0.01) {
      vec3 mp = mix(x, nx, 0.5);
      float mr = length(mp);
      if (mr > uDiskInner && mr < uDiskOuter) {
        float H = diskScaleHeight(mr);
        if (abs(mp.y) < H * 3.2) {
          float phi = atan(mp.z, mp.x);
          float env = diskEnvelope(mr);
          float tc = turbContrast(diskTurbulence(mr, phi, max(uOct - 1, 2)));
          float vert = exp(-0.5 * (mp.y / H) * (mp.y / H));
          float dens = env * vert * mix(1.0, 0.30 + 1.40 * tc, uTurbulence);
          float dtau = uDiskDensity * dens * dl * 0.20;
          if (dtau > 1e-5) {
            float gT, gG, gD;
            vec3 S = diskSource(mr, bPhi, gT, gG, gD) * 0.55;
            float alpha = 1.0 - exp(-dtau);
            accum += throughput * S * alpha;
            throughput *= (1.0 - alpha);
            diskHit = true;
          }
        }
      }
    }

    x = nx;
    v = nv;
  }

  float defl = acos(clamp(dot(vStart, dirFinal), -1.0, 1.0));
  vec3 color = accum + skyRadiance(dirFinal) * throughput;

  // ============================================================ debug views
  if (uView == 1) {
    color = turbo(clamp(stepsUsed / max(float(uMaxSteps), 1.0), 0.0, 1.0));
  } else if (uView == 2) {
    float signal = clamp(luma(color) * 2.0 + 0.30, 0.0, 1.0);
    if (captured) {
      color = vec3(0.03, 0.05, 0.13);
    } else if (diskHit) {
      color = vec3(1.0, 0.50, 0.10) * mix(0.30, 1.0, signal);
    } else {
      color = vec3(0.05, 0.30, 0.34) * mix(0.30, 1.0, signal);
    }
  } else if (uView == 3) {
    color = accum;
  } else if (uView == 4) {
    color = diverging((dopBest - 1.0) * 2.2);
  } else if (uView == 5) {
    color = viridis(clamp((redBest - 0.30) / 0.70, 0.0, 1.0));
  } else if (uView == 6) {
    color = turbo(clamp(log(1.0 + tauBest) / 3.2, 0.0, 1.0));
  } else if (uView == 7) {
    color = starField(dirFinal) * uStarBright + galaxyBand(dirFinal) * uGalaxy;
  } else if (uView == 8) {
    color = turbo(clamp(defl / PI, 0.0, 1.0));
  }

  // alpha carries the normalised iteration count so the HUD can report the true
  // per-pixel average integration cost via a cheap 4x4 read-back.
  gl_FragColor = vec4(color, clamp(stepsUsed / max(float(uMaxSteps), 1.0), 0.0, 1.0));
}
`;
