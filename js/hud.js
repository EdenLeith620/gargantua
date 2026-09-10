/**
 * GARGANTUA — HUD
 * Built entirely from JS so index.html stays a clean shell. No framework, no
 * build step: template strings + direct DOM wiring.
 */

import { PARAM_DEFS, GROUPS, QUALITY_TIERS, QUALITY_ORDER, VIEW_PRESETS, DEBUG_VIEWS } from './params.js';

const fmt = (v, def) => {
  const a = Math.abs(v);
  if (def.step >= 1) return v.toFixed(0);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(a % 1 === 0 ? 0 : 1);
  if (a >= 10) return v.toFixed(2);
  return v.toFixed(2);
};

export const SHORTCUTS = [
  ['H', '显示 / 隐藏 HUD'],
  ['P', '展开 / 收起 21 项参数面板'],
  ['Space', '暂停 / 恢复 电影镜头'],
  ['C', '切换 电影镜头 / 自由轨道'],
  ['⇧ 1 2 3 4', '四个视角预设'],
  ['0 – 9', '切换调试视图'],
  ['Q', '循环质量档 Standard / High / Cinematic'],
  ['M', '氛围音乐 开 / 关'],
  ['S', '保存当前帧 PNG'],
  ['B', 'Bloom 开 / 关'],
  ['F', '全屏'],
  ['R', '重置全部参数'],
  ['?', '快捷键面板'],
];

export class HUD {
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers;
    this.visible = true;
    this.panelOpen = true;
    this.helpOpen = false;
    this.sliders = new Map();
    this.readouts = new Map();
    this.presetButtons = [];
    this._toastTimer = null;

    root.innerHTML = this._template();
    this._wire();
    this._buildParams();
    this._buildPresets();
    this._buildViews();
    this._buildHelp();
  }

  _template() {
    return `
      <div class="g-hud" id="g-hud">
        <div class="g-col g-col--left">
        <header class="g-brand">
          <div class="g-brand__mark">
            <svg viewBox="0 0 40 40" aria-hidden="true">
              <circle cx="20" cy="20" r="13" fill="none" stroke="currentColor" stroke-width="1.1" opacity=".55"/>
              <circle cx="20" cy="20" r="7.4" fill="none" stroke="currentColor" stroke-width="1.6"/>
              <ellipse cx="20" cy="20" rx="18" ry="4.4" fill="none" stroke="currentColor" stroke-width="1.3"/>
              <circle cx="20" cy="20" r="3.6" fill="currentColor"/>
            </svg>
          </div>
          <div class="g-brand__text">
            <h1>GARGANTUA</h1>
            <p>Schwarzschild Black Hole Raytracer · 实时零测地线积分</p>
          </div>
        </header>

        <section class="g-stats" id="g-stats">
          <div class="g-stat"><span class="k">FPS</span><span class="v" id="s-fps">–</span></div>
          <div class="g-stat"><span class="k">帧时</span><span class="v" id="s-ms">–</span></div>
          <div class="g-stat"><span class="k">积分分辨率</span><span class="v" id="s-res">–</span></div>
          <div class="g-stat"><span class="k">平均步数</span><span class="v" id="s-steps">–</span></div>
          <div class="g-stat"><span class="k">积分器</span><span class="v" id="s-int">–</span></div>
          <div class="g-stat"><span class="k">质量档</span><span class="v" id="s-q">–</span></div>
        </section>

        <section class="g-block" id="g-presets">
          <h2>视角预设</h2>
          <div class="g-chips" id="g-preset-list"></div>
        </section>

        <section class="g-block" id="g-views">
          <h2>调试视图 <em id="g-view-name">最终合成</em></h2>
          <div class="g-chips g-chips--tight" id="g-view-list"></div>
        </section>

        <section class="g-block g-block--actions">
          <div class="g-actions">
            <button class="g-btn" data-act="reset">重置</button>
            <button class="g-btn" data-act="shot">截图</button>
            <button class="g-btn" data-act="music">音乐</button>
            <button class="g-btn" data-act="help">快捷键</button>
            <button class="g-btn" data-act="fullscreen">全屏</button>
          </div>
          <p class="g-foot">拖拽旋转 · 滚轮缩放 · 全部参数实时生效 · 按 ? 查看快捷键</p>
        </section>
        </div>

        <div class="g-col g-col--right">
          <section class="g-block g-block--panel" id="g-param-block">
            <h2 class="g-panel-head" id="g-param-toggle">
              参数 <em><span id="g-param-count">21</span> 项</em>
              <span class="g-caret">▾</span>
            </h2>
            <div class="g-params" id="g-params"></div>
          </section>
        </div>

        <div class="g-toast" id="g-toast"></div>
      </div>

      <div class="g-overlay" id="g-help" hidden>
        <div class="g-overlay__box">
          <h2>快捷键</h2>
          <ul class="g-keys">
            ${SHORTCUTS.map(([k, d]) => `<li><kbd>${k}</kbd><span>${d}</span></li>`).join('')}
          </ul>
          <button class="g-btn g-btn--primary" data-act="close-help">关闭</button>
        </div>
      </div>

      <div class="g-overlay g-overlay--fatal" id="g-fatal" hidden>
        <div class="g-overlay__box">
          <h2 id="g-fatal-title">渲染中断</h2>
          <p id="g-fatal-body"></p>
          <button class="g-btn g-btn--primary" data-act="retry-context">重建渲染上下文</button>
        </div>
      </div>

      <div class="g-intro" id="g-intro">
        <div class="g-intro__inner">
          <div class="g-intro__ring"></div>
          <h1>GARGANTUA</h1>
          <p>正在编译测地线积分器…</p>
        </div>
      </div>
    `;
  }

  /** Single selector helper. (Deliberately not named $_ — a one-character
   *  ordering mistake there is invisible in review and cost a debug cycle.) */
  qs(sel) { return this.root.querySelector(sel); }

  _wire() {
    const bind = (act, fn) => {
      this.root.querySelectorAll(`[data-act="${act}"]`).forEach((b) => b.addEventListener('click', fn));
    };
    bind('reset', () => this.h.onReset && this.h.onReset());
    bind('shot', () => this.h.onScreenshot && this.h.onScreenshot());
    bind('fullscreen', () => this.h.onFullscreen && this.h.onFullscreen());
    bind('help', () => this.toggleHelp(true));
    bind('close-help', () => this.toggleHelp(false));
    bind('retry-context', () => this.h.onRetryContext && this.h.onRetryContext());
    bind('music', () => this.h.onMusic && this.h.onMusic());

    const head = this.qs('#g-param-toggle');
    head.addEventListener('click', () => this.togglePanel());
  }

  _buildParams() {
    const host = this.qs('#g-params');
    const frag = document.createDocumentFragment();

    GROUPS.forEach((g) => {
      const items = PARAM_DEFS.filter((d) => d.group === g.id);
      if (!items.length) return;

      const group = document.createElement('div');
      group.className = 'g-group';
      group.innerHTML = `<h3>${g.label}</h3>`;

      items.forEach((d) => {
        const row = document.createElement('div');
        row.className = 'g-param';
        if (d.hint) row.title = d.hint;
        row.innerHTML = `
          <div class="g-param__top">
            <label for="p-${d.key}">${d.label}</label>
            <output class="g-param__val" id="v-${d.key}"></output>
          </div>
          <input type="range" id="p-${d.key}" min="${d.min}" max="${d.max}" step="${d.step}" value="${d.def}" />
        `;
        const input = row.querySelector('input');
        const out = row.querySelector('output');
        input.addEventListener('input', () => {
          const val = parseFloat(input.value);
          this.h.onParam && this.h.onParam(d.key, val);
          this.setParam(d.key, val);
        });
        this.sliders.set(d.key, input);
        this.readouts.set(d.key, out);
        group.appendChild(row);
      });

      frag.appendChild(group);
    });

    host.appendChild(frag);
    PARAM_DEFS.forEach((d) => this.setParam(d.key, d.def));
    this.qs('#g-param-count').textContent = String(PARAM_DEFS.length);
  }

  setParam(key, value) {
    const def = PARAM_DEFS.find((d) => d.key === key);
    if (!def) return;
    const input = this.sliders.get(key);
    const out = this.readouts.get(key);
    if (input && document.activeElement !== input) input.value = String(value);
    if (out) out.textContent = `${fmt(value, def)}${def.unit ? ' ' + def.unit : ''}`;
  }

  _buildPresets() {
    const host = this.qs('#g-preset-list');
    VIEW_PRESETS.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'g-chip';
      b.innerHTML = `<b>${i + 1}</b>${p.name}`;
      b.title = p.desc;
      b.addEventListener('click', () => this.h.onPreset && this.h.onPreset(p.id));
      host.appendChild(b);
      this.presetButtons.push(b);
    });
  }

  setPresetActive(id) {
    this.presetButtons.forEach((b, i) => b.classList.toggle('is-active', i === id));
  }

  _buildViews() {
    const host = this.qs('#g-view-list');
    DEBUG_VIEWS.forEach((v) => {
      const b = document.createElement('button');
      b.className = 'g-chip g-chip--num';
      b.innerHTML = `<b>${v.id}</b><span>${v.name}</span>`;
      b.title = v.desc;
      b.addEventListener('click', () => this.h.onView && this.h.onView(v.id));
      host.appendChild(b);
    });
    this.viewButtons = Array.from(host.children);
  }

  setView(id) {
    this.viewButtons.forEach((b, i) => b.classList.toggle('is-active', i === id));
    const meta = DEBUG_VIEWS.find((v) => v.id === id);
    this.qs('#g-view-name').textContent = meta ? meta.name : '';
  }

  _buildHelp() {
    const overlay = this.qs('#g-help');
    if (!overlay) return;
    this.helpEl = overlay;
    // clicking the dimmed backdrop (but not the box) dismisses the panel
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.toggleHelp(false);
    });
  }

  setQuality(id) {
    this.qs('#s-q').textContent = QUALITY_TIERS[id] ? QUALITY_TIERS[id].label : id;
  }

  setIntegrator(label) { this.qs('#s-int').textContent = label; }

  setStats(s) {
    this.qs('#s-fps').textContent = s.fps == null ? '–' : s.fps.toFixed(0);
    this.qs('#s-ms').textContent = s.ms == null ? '–' : `${s.ms.toFixed(1)} ms`;
    this.qs('#s-res').textContent = s.res || '–';
    this.qs('#s-steps').textContent = s.steps == null ? '–' : s.steps.toFixed(0);
  }

  setMusicState(on) {
    const b = this.root.querySelector('[data-act="music"]');
    if (b) {
      b.classList.toggle('is-active', !!on);
      b.textContent = on ? '音乐 开' : '音乐';
    }
  }

  toggle() {
    this.visible = !this.visible;
    this.qs('#g-hud').classList.toggle('is-hidden', !this.visible);
  }

  togglePanel(force) {
    const next = force === undefined ? !this.panelOpen : !!force;
    this.panelOpen = next;
    this.qs('#g-param-block').classList.toggle('is-collapsed', !next);
  }

  toggleHelp(force) {
    const next = force === undefined ? !this.helpOpen : !!force;
    this.helpOpen = next;
    this.qs('#g-help').hidden = !next;
  }

  toast(msg, ms = 1700, tone = '') {
    const el = this.qs('#g-toast');
    el.textContent = msg;
    el.className = `g-toast is-on ${tone}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.className = 'g-toast'; }, ms);
  }

  hideIntro(immediate) {
    const el = this.qs('#g-intro');
    if (!el) return;
    if (immediate) { el.remove(); return; }
    el.classList.add('is-gone');
    setTimeout(() => el.remove(), 900);
  }

  /** Kill every CSS transition so automated captures never catch a fade. */
  setInstant(on) {
    this.root.classList.toggle('is-instant', !!on);
  }

  showFatal(title, body) {
    this.qs('#g-fatal-title').textContent = title;
    this.qs('#g-fatal-body').textContent = body;
    this.qs('#g-fatal').hidden = false;
  }

  hideFatal() { this.qs('#g-fatal').hidden = true; }
}

export { QUALITY_ORDER };
