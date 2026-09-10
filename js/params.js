/**
 * GARGANTUA — the 21 parameters, quality tiers, camera presets, persistence.
 */

export const PARAM_DEFS = [
  // ---- spacetime -----------------------------------------------------------
  { key: 'mass',           label: '黑洞质量 / 视界尺度', group: 'spacetime',  min: 0.40,  max: 2.50,  step: 0.01, def: 1.00,  unit: 'r_s',
    hint: '整体缩放史瓦西半径 r_s。相机距离为绝对场景单位，因此调大质量会让视界在画面中变大。' },

  // ---- accretion disk ------------------------------------------------------
  { key: 'diskInner',      label: '盘内半径 (ISCO=3)',   group: 'disk',       min: 1.80,  max: 9.00,  step: 0.05, def: 3.00,  unit: 'r_s',
    hint: '吸积盘内边界。史瓦西时空 ISCO = 6M = 3 r_s，取更小值会进入不稳定圆轨道区。' },
  { key: 'diskOuter',      label: '盘外半径',            group: 'disk',       min: 6.00,  max: 34.0,  step: 0.10, def: 14.0,  unit: 'r_s' },
  { key: 'diskThickness',  label: '盘标高 / 厚度',       group: 'disk',       min: 0.03,  max: 1.20,  step: 0.01, def: 0.34,
    hint: 'H(r) = k·(0.17r + 0.22r_s)，略微波纹状外扩。同时决定掠射路径长度与体渲染晕的厚度。' },
  { key: 'diskDensity',    label: '盘光学厚度 κ',        group: 'disk',       min: 0.05,  max: 7.00,  step: 0.01, def: 2.00,
    hint: 'τ = κ·L·ρ，L 为穿越几何路径长度。高值使盘不透明，背面被前面遮挡。' },
  { key: 'diskTemp',       label: '盘峰值温度',          group: 'disk',       min: 2000,  max: 26000, step: 50,   def: 5600,  unit: 'K',
    hint: 'T ∝ r^(-3/4)·(1-√(r_in/r))^(1/4)（Shakura–Sunyaev），此处为归一化峰值温度。' },
  { key: 'turbulence',     label: '湍流强度',            group: 'disk',       min: 0.00,  max: 1.00,  step: 0.01, def: 0.82 },
  { key: 'flowSpeed',      label: '盘流动速度',          group: 'disk',       min: 0.00,  max: 1.60,  step: 0.01, def: 0.42,
    hint: '湍流场随本地开普勒角速度 Ω(r)=√(M/r³) 共动，差速剪切自动卷出旋臂。' },

  // ---- relativity ----------------------------------------------------------
  { key: 'doppler',        label: '多普勒增亮指数',      group: 'relativity', min: 0.00,  max: 2.00,  step: 0.01, def: 1.00,
    hint: 'D 的幂次。1.0 = 物理真值（I ∝ D⁴），观测量级为迎向侧/背向侧 ≈ 16 倍。' },
  { key: 'redshift',       label: '引力红移指数',        group: 'relativity', min: 0.00,  max: 1.50,  step: 0.01, def: 1.00,
    hint: '√(1-r_s/r) 的幂次。1.0 = 物理真值。' },
  { key: 'lensing',        label: '引力透镜强度',        group: 'relativity', min: 0.00,  max: 1.40,  step: 0.01, def: 1.00,
    hint: '测地线方程中曲率项的整体系数。1.0 = 精确史瓦西解，0.0 = 直线传播（可对比验证）。' },

  // ---- sky -----------------------------------------------------------------
  { key: 'starBright',     label: '星空亮度',            group: 'sky',        min: 0.00,  max: 3.00,  step: 0.01, def: 1.00 },
  { key: 'starDensity',    label: '星空密度',            group: 'sky',        min: 0.00,  max: 1.00,  step: 0.01, def: 0.55 },
  { key: 'galaxy',         label: '银河强度',            group: 'sky',        min: 0.00,  max: 3.00,  step: 0.01, def: 1.00 },

  // ---- image ---------------------------------------------------------------
  { key: 'exposure',       label: '曝光',                group: 'image',      min: 0.05,  max: 3.00,  step: 0.01, def: 1.45 },
  { key: 'bloom',          label: 'Bloom 强度',          group: 'image',      min: 0.00,  max: 2.50,  step: 0.01, def: 0.75 },
  { key: 'bloomThreshold', label: 'Bloom 阈值',          group: 'image',      min: 0.00,  max: 6.00,  step: 0.01, def: 0.40 },
  { key: 'chromatic',      label: '色散',                group: 'image',      min: 0.00,  max: 1.00,  step: 0.01, def: 0.30 },
  { key: 'grain',          label: '胶片颗粒',            group: 'image',      min: 0.00,  max: 1.00,  step: 0.01, def: 0.24 },
  { key: 'vignette',       label: '暗角',                group: 'image',      min: 0.00,  max: 1.00,  step: 0.01, def: 0.55 },

  // ---- camera --------------------------------------------------------------
  { key: 'distance',       label: '观察距离',            group: 'camera',     min: 4.00,  max: 60.0,  step: 0.10, def: 22.0,  unit: 'u',
    hint: '绝对场景单位。质量 = 1 时 1 u = 1 r_s；调大质量而保持距离不变，视界会明显变大。' },
];

export const PARAM_COUNT = PARAM_DEFS.length; // 21

export const GROUPS = [
  { id: 'spacetime',  label: '时空' },
  { id: 'disk',       label: '吸积盘' },
  { id: 'relativity', label: '相对论效应' },
  { id: 'sky',        label: '背景天球' },
  { id: 'image',      label: '成像' },
  { id: 'camera',     label: '相机' },
];

export const QUALITY_TIERS = {
  standard: {
    id: 'standard', label: 'Standard',
    renderScale: 0.55, dprCap: 1.0,
    maxSteps: 260, stepAngle: 0.062, stepRadial: 0.078,
    integrator: 0, oct: 3, bloomLevels: 3,
  },
  high: {
    id: 'high', label: 'High',
    renderScale: 0.85, dprCap: 1.5,
    maxSteps: 520, stepAngle: 0.045, stepRadial: 0.058,
    integrator: 1, oct: 4, bloomLevels: 4,
  },
  cinematic: {
    id: 'cinematic', label: 'Cinematic',
    renderScale: 1.00, dprCap: 2.0,
    maxSteps: 900, stepAngle: 0.032, stepRadial: 0.042,
    integrator: 1, oct: 6, bloomLevels: 5,
  },
};

export const QUALITY_ORDER = ['standard', 'high', 'cinematic'];

export const VIEW_PRESETS = [
  {
    id: 0, key: 'preset1', name: '经典 GARGANTUA',
    desc: '近盘低掠视角，盘面上下二次像与光子环同时可见',
    azimuth: 0.35, elevation: 0.112, distance: 22.0, fov: 42,
  },
  {
    id: 1, key: 'preset2', name: '掠射光环',
    desc: '几乎正侧视，强调边缘增亮与多层盘面穿越',
    azimuth: -0.55, elevation: 0.030, distance: 16.5, fov: 34,
  },
  {
    id: 2, key: 'preset3', name: '极地俯视',
    desc: '高倾角，完整展开开普勒差速与湍流旋臂',
    azimuth: 1.15, elevation: 1.150, distance: 30.0, fov: 50,
  },
  {
    id: 3, key: 'preset4', name: '深空长焦',
    desc: '远距窄视场，爱因斯坦环与背景星空透镜被压缩放大',
    azimuth: 2.30, elevation: 0.200, distance: 46.0, fov: 18,
  },
];

export const DEBUG_VIEWS = [
  { id: 0, name: '最终合成', desc: '完整 HDR + Bloom + ACES 成像' },
  { id: 1, name: '积分步数', desc: '每像素 RK4/Verlet 迭代次数热力图' },
  { id: 2, name: '命中分类', desc: '深蓝=落入视界 / 橙=穿越盘面 / 青=逃逸至天球' },
  { id: 3, name: '盘面辐射', desc: '仅吸积盘累积辐射（线性 HDR，未经色调映射）' },
  { id: 4, name: '多普勒因子', desc: 'D 偏离 1 的发散色图：红=蓝移迎向，蓝=红移背向' },
  { id: 5, name: '引力红移', desc: '√(1-r_s/r) 的 Viridis 映射' },
  { id: 6, name: '光学厚度', desc: 'log(1+τ) Turbo 映射' },
  { id: 7, name: '天球 / 银河', desc: '关闭吸积盘，仅显示被透镜后的星空与银河' },
  { id: 8, name: '总偏折角', desc: '初末方向夹角，Turbo 映射到 [0,π]' },
  { id: 9, name: 'Bloom 高亮', desc: '仅显示 HDR 亮部通道与光晕金字塔' },
];

export const DEFAULTS = Object.fromEntries(PARAM_DEFS.map((d) => [d.key, d.def]));

const STORAGE_KEY = 'gargantua.state.v1';

export function clampParam(key, value) {
  const def = PARAM_DEFS.find((d) => d.key === key);
  if (!def) return value;
  const v = Number(value);
  if (!Number.isFinite(v)) return def.def;
  return Math.min(def.max, Math.max(def.min, v));
}

export function readState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

export function writeState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

export function clearState() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
}

/** Parse the URL query into an override object. Never throws. */
export function parseUrlOverrides() {
  const out = { params: {}, flags: {} };
  let q;
  try {
    q = new URLSearchParams(window.location.search);
  } catch (e) {
    return out;
  }

  const known = new Set(PARAM_DEFS.map((d) => d.key));

  q.forEach((value, key) => {
    if (known.has(key)) {
      out.params[key] = clampParam(key, parseFloat(value));
      return;
    }
    if (key === 'p' || key === 'params') {
      // ?p=mass:1.4,diskTemp:14000
      value.split(',').forEach((pair) => {
        const [k, v] = pair.split(':');
        if (k && known.has(k)) out.params[k.trim()] = clampParam(k.trim(), parseFloat(v));
      });
      return;
    }
    out.flags[key] = value === '' ? true : value;
  });

  return out;
}
