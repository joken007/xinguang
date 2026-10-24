/**
 * 心光 · 主程序
 * ------------------------------------------------------------------
 * 职责：
 *   1. 建渲染器 / 场景 / 相机 / 太阳光
 *   2. 把四个世界模块（天空、地形、海洋、后期）缝起来
 *   3. 状态机：点击 → 升一帧太阳 + 换一条语录；闲置自动推进
 *   4. 每帧把 progress 插值成 ViewState，喂给所有模块
 *
 * 其余模块只依赖 config.js 与自己的 shader，主循环是唯一的"指挥"。
 */

import * as THREE from 'three';
import {
  TOTAL_TICKS, LIFT_EASE, SUN_AZIMUTH, DAY_RAMP,
  SUN_ELEVATION_START, SUN_ELEVATION_END, SUN_ELEVATION_EASE,
  SUN_ELEVATION_MAX, SUN_ELEVATION_TAIL,
  DAY_FADE_TAIL, AUTO_TICK_LIMIT, sunElevationAt, dayAmountAt,
  SUN_NEAR_COLOR, SUN_MID_COLOR, SUN_HIGH_COLOR,
  SUN_LIGHT_INTENSITY
} from './config.js';
import { QuoteDeck } from './quotes.js';
import { createHud } from './ui/hud.js';
import { createIntro } from './ui/intro.js';
import { createMusic } from './audio/music.js';
import { fogUniforms } from './util/resources.js';
import { clamp, smoothstep, mulberry32 } from './util/noise.js';
import { createSky } from './world/sky.js';
import { createTerrain } from './world/terrain.js';
import { createSea } from './world/sea.js';
import { createComposite } from './post/composite.js';

/* ---------------------------------------------------------------- 常量 */

const AUTO_DELAY_MS = 12000;   // 闲置多久自动升一帧
const EASE_TICK = 3.4;         // 一次点击的插值速度（指数逼近的速率）
const SKY_TOP_NIGHT = new THREE.Color('#03050c');
const SKY_HORIZON_NIGHT = new THREE.Color('#101b33');
const SUN_TINT = new THREE.Color('#ffd2a0');

/* ---------------------------------------------------------------- 启动 */

const canvas = document.getElementById('scene');
const hud = createHud();

let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false
  });
} catch (err) {
  hud.showFatal('无法创建 WebGL 上下文：' + (err && err.message ? err.message : err));
  throw err;
}

const isCoarse = window.matchMedia('(pointer: coarse)').matches;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const quality = isCoarse && window.devicePixelRatio >= 2.5 ? 'low' : 'high';

renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'low' ? 1.6 : 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#04060c');

const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.5, 12000);
camera.position.set(0, 7.2, 0);
// 俯角约 5.4°：地平线落在画面中线偏下（约 60% 高度），上半屏留给太阳升起
camera.lookAt(0, -2.3, -100);

/* ---------------------------------------------------------------- 光照 */

const sun = new THREE.DirectionalLight(0xffbb88, 0);
sun.castShadow = false;
scene.add(sun);
scene.add(sun.target);
sun.target.position.set(0, 0, -100);

const skyFill = new THREE.HemisphereLight(0x203050, 0x080a10, 0.0);
scene.add(skyFill);

// 共享雾 uniform 初始值（null 会直接崩，必须在任何 tick 之前填好）
fogUniforms.fogColor.value = new THREE.Color('#04060c');
fogUniforms.fogSunColor.value = new THREE.Color('#ff8a4a');
fogUniforms.fogSunDir.value = new THREE.Vector3(0, 0, -1);

/* ---------------------------------------------------------------- 世界 */

const skyLayer = createSky(renderer, { quality });
const terrain = createTerrain(renderer, { quality, debug: true });
const sea = createSea(renderer, { quality });
const composite = createComposite(renderer, { quality });

scene.add(skyLayer.object3D);
scene.add(terrain.object3D);
scene.add(sea.object3D);

/* ---------------------------------------------------------------- 状态 */

const state = {
  target: 0,          // 已经点了多少帧：0..TOTAL_TICKS 天光大亮，之后继续往上（没有上限）
  progress: 0,        // 平滑后的进度（第一阶段 = 0..1，之后继续增长，没有上限）
  eased: 0,           // 缓动后的进度（视觉用它）
  day: 0,             // "白天"进度：天光大亮之后继续 0→1，天色/雾/曝光靠它继续演化
  autoStopped: false, // 自动模式触到上限后置位（页脚据此提示一次）
  time: 0,
  auto: !reducedMotion,
  motion: !reducedMotion,
  sound: false,
  lastInputAt: performance.now(),
  running: true
};

// 调试开关：raw=true 时绕过后期直接出原图；worker 也可以用它分离问题
const debug = { raw: false };

const deck = new QuoteDeck();
const view = {
  progress: 0,
  eased: 0,
  sunElevation: SUN_ELEVATION_START,
  sunAzimuth: SUN_AZIMUTH,
  sunWorldDir: new THREE.Vector3(0, 0, -1),
  time: 0,
  motion: state.motion ? 1 : 0,
  camera,
  resolution: { width: 1, height: 1, pixelRatio: 1 }
};

/* ---------------------------------------------------------------- 颜色插值工具 */

const tmpColorA = new THREE.Color();
const tmpColorB = new THREE.Color();
const WHITE_DAY = new THREE.Color(1.0, 0.985, 0.965);   // 白天太阳漂向的暖白

/** 多段关键帧取色：stops = [[t, '#hex'], ...] */
function sampleColor(stops, t, out) {
  if (t <= stops[0][0]) return out.set(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1];
      const b = stops[i];
      const k = (t - a[0]) / (b[0] - a[0] || 1);
      tmpColorA.set(a[1]);
      tmpColorB.set(b[1]);
      return out.copy(tmpColorA).lerp(tmpColorB, k * k * (3 - 2 * k));
    }
  }
  return out.set(stops[stops.length - 1][1]);
}

/* 每条色带都有"白天延伸段"（1.10~1.33）：天光大亮之后雾更冷更透、
 * 太阳更白、天光更接近正午的清澈 —— 靠 day 把采样位置推过 1.0。
 * 采样用的 t = eased + DAY_RAMP(day)，day 只影响颜色，不影响几何与高度。 */
const FOG_COLOR_STOPS = [
  [0.00, '#04060c'],
  [0.22, '#101a2e'],
  [0.45, '#2c3352'],
  [0.68, '#6a5a6e'],
  [0.85, '#8fa4b8'],
  [1.00, '#b9cbda'],
  [1.14, '#c6d6e4'],
  [1.33, '#d3dfe9']
];
const SUN_COLOR_STOPS = [
  [0.00, '#ff7a3c'],
  [0.35, '#ff8f4a'],
  [0.70, '#ffb877'],
  [1.00, '#ffe0bb'],
  [1.20, '#fff3e2'],
  [1.33, '#fffaf4']
];
const HEMI_SKY_STOPS = [
  [0.00, '#0a1220'],
  [0.45, '#2d3a60'],
  [0.75, '#6d7fa6'],
  [1.00, '#a9c4e0'],
  [1.16, '#bdd4ea'],
  [1.33, '#cfe0f2']
];

const fogColor = new THREE.Color();
const sunColor = new THREE.Color();
const hemiColor = new THREE.Color();
const sunDirTmp = new THREE.Vector3();

/* ---------------------------------------------------------------- 升日 */

function lift() {
  // 没有硬上限：60 帧之后太阳仍在往上爬，只是越来越慢（见 sunElevationAt）
  state.target += 1;
  state.autoStopped = false;   // 手动一点，自动模式重新可用
  state.lastInputAt = performance.now();
  hud.toggleHint(true);
  hud.setQuote(deck.next());
  pulse();
}

/** 点击时的一点呼吸感（给 CSS 层一个短促的暖冲） */
function pulse() {
  const now = performance.now();
  lastPulse = now;
}
let lastPulse = 0;

function reset() {
  state.target = 0;
  state.progress = 0;
  state.eased = 0;
  state.day = 0;
  state.autoStopped = false;
  if (!reducedMotion) { state.auto = true; hud.setButton('auto', true); }
  state.lastInputAt = performance.now();
  hud.setQuote(deck.next(), true);
}

/* ---------------------------------------------------------------- 交互 */

const stage = document.getElementById('stage');
const btnAuto = document.getElementById('btn-auto');
const btnMotion = document.getElementById('btn-motion');
const btnSound = document.getElementById('btn-sound');
const btnReset = document.getElementById('btn-reset');

let pointerDownAt = 0;
function onPointerUp(e) {
  // 只响应主按键；忽略在按钮上的点击（按钮自己 stopPropagation）
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  lift();
}

stage.addEventListener('pointerup', onPointerUp);
/* 只在这里处理 Enter：空格由下面的 window 级监听统一处理，
 * 否则 stage 获得焦点后一次按键会被两个监听各加一帧（实测 5 次点击后按一次空格 → 7/60）。 */
stage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    lift();
  }
});

btnAuto.addEventListener('click', (e) => {
  e.stopPropagation();
  state.auto = !state.auto;
  hud.setButton('auto', state.auto);
  state.lastInputAt = performance.now();
});
btnMotion.addEventListener('click', (e) => {
  e.stopPropagation();
  state.motion = !state.motion;
  hud.setButton('motion', state.motion);
});
btnSound.addEventListener('click', (e) => {
  e.stopPropagation();
  state.sound = !state.sound;
  hud.setButton('sound', state.sound);
  audio.setEnabled(state.sound);
});
btnReset.addEventListener('click', (e) => {
  e.stopPropagation();
  reset();
});

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // e.repeat: 长按空格不该一路冲到天亮 —— "一帧一帧"是这套交互的核心
  if (e.key === ' ') { e.preventDefault(); if (!e.repeat) lift(); }
  else if (e.key === 'a' || e.key === 'A') btnAuto.click();
  else if (e.key === 'm' || e.key === 'M') btnMotion.click();
  else if (e.key === 's' || e.key === 'S') btnSound.click();
  else if (e.key === 'r' || e.key === 'R') btnReset.click();
  else if (e.key === 'ArrowRight') { e.preventDefault(); lift(); }
});

/* ---------------------------------------------------------------- 音乐（WebAudio 实时合成，无外部音频文件） */

const audio = createMusic();


/* ---------------------------------------------------------------- 自适应质量 */

const perf = { samples: [], lastDrop: 0 };
function watchPerformance(dtMs) {
  perf.samples.push(dtMs);
  if (perf.samples.length > 120) perf.samples.shift();
  if (perf.samples.length < 120) return;
  const avg = perf.samples.reduce((a, b) => a + b, 0) / perf.samples.length;
  const now = performance.now();
  if (avg > 26 && now - perf.lastDrop > 8000 && renderer.getPixelRatio() > 1) {
    perf.lastDrop = now;
    renderer.setPixelRatio(Math.max(1, renderer.getPixelRatio() * 0.8));
    resize();
  }
}

/* ---------------------------------------------------------------- 尺寸 */

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const pr = renderer.getPixelRatio();
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // 竖屏时略微放宽视野，保证仍然看得见两侧的山与林
  camera.fov = w / h < 0.85 ? 60 : 46;
  camera.updateProjectionMatrix();
  composite.setSize(w, h, pr);
  view.resolution.width = w;
  view.resolution.height = h;
  view.resolution.pixelRatio = pr;
}
window.addEventListener('resize', resize);

/* ---------------------------------------------------------------- 主循环 */

const clock = new THREE.Clock();
let fpsAcc = 0;
let fpsFrames = 0;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  state.time += dt;

  // ---- 闲置自动推进
  // 上限 AUTO_TICK_LIMIT 帧：再往后就交给用户 —— 自动把戏演完，反而夺走了"再点一下"的乐趣
  if (state.auto && !state.autoStopped && state.target >= AUTO_TICK_LIMIT) {
    state.autoStopped = true;
    state.auto = false;
    hud.setButton('auto', false);
  }
  if (state.auto && !state.autoStopped && !intro.isOpen &&
      performance.now() - state.lastInputAt > AUTO_DELAY_MS) {
    lift();
  }

  // ---- 进度平滑（指数逼近，帧率无关）
  const targetProgress = state.target / TOTAL_TICKS;
  const k = 1 - Math.exp(-EASE_TICK * dt);
  state.progress += (targetProgress - state.progress) * k;
  if (Math.abs(targetProgress - state.progress) < 0.0002) state.progress = targetProgress;

  // ---- 缓动：开头慢，地平线附近给一段"卡住"的呼吸（太阳刚露头时最动人）
  const p = state.progress;
  const p1 = clamp(p, 0, 1);          // 第一阶段（0..60 帧）的天亮程度：到这里"天光大亮"
  const eased = clamp(
    0.55 * smoothstep(0, 1, p1) + 0.45 * (p1 * p1 * (3 - 2 * p1)),
    0, 1
  );
  state.eased = eased;

  // ---- 太阳位置
  /* 两段：
   *   p<=1：从地平线下爬到 SUN_ELEVATION_END（天光大亮）。
   *   p>1 ：指数尾巴继续往上，再过一个 softcap 软上限（SUN_ELEVATION_CEIL）：
   *         单调、有界、处处连续 —— 有界单调函数必有极限，所以"永远在升"在数学上
   *         只能取极限；这里让极限落在 SUN_ELEVATION_CEIL - BAND*ln2 ≈ 14.7°，
   *         正好停在画面上缘（约 17.6°）之下，太阳与日晕都不会被切掉。
   *         同时 dayAmountAt 让"天亮之后"的世界继续演化（见下）。 */
  const day = dayAmountAt(p);
  state.day = day;
  // 颜色带的采样位置：天光大亮之后被 day 推过 1.0，进入"白天延伸段"
  const cT = Math.min(1.33, eased + DAY_RAMP(day));

  const elev = sunElevationAt(p, eased);
  const ce = Math.cos(elev);
  sunDirTmp.set(Math.sin(SUN_AZIMUTH) * ce, Math.sin(elev), -Math.cos(SUN_AZIMUTH) * ce).normalize();

  // ---- 颜色
  sampleColor(FOG_COLOR_STOPS, cT, fogColor);
  sampleColor(SUN_COLOR_STOPS, cT, sunColor);
  sampleColor(HEMI_SKY_STOPS, cT, hemiColor);

  // 太阳本体颜色：低 → 高，从红橙到暖白
  if (eased < 0.5) {
    tmpColorA.setRGB(SUN_NEAR_COLOR[0], SUN_NEAR_COLOR[1], SUN_NEAR_COLOR[2]);
    tmpColorB.setRGB(SUN_MID_COLOR[0], SUN_MID_COLOR[1], SUN_MID_COLOR[2]);
    sun.color.copy(tmpColorA).lerp(tmpColorB, eased / 0.5);
  } else {
    tmpColorA.setRGB(SUN_MID_COLOR[0], SUN_MID_COLOR[1], SUN_MID_COLOR[2]);
    tmpColorB.setRGB(SUN_HIGH_COLOR[0], SUN_HIGH_COLOR[1], SUN_HIGH_COLOR[2]);
    sun.color.copy(tmpColorA).lerp(tmpColorB, (eased - 0.5) / 0.5);
  }
  // 白天：太阳本体继续往"正午的暖白"漂一点点
  sun.color.lerp(WHITE_DAY, 0.30 * DAY_RAMP(day));

  // ---- 光照强度：地平线下几乎无直射光，露出地平线后指数上升
  const above = smoothstep(-0.02, 0.07, elev);
  const sunPower = Math.pow(eased, 1.35);
  sun.intensity = SUN_LIGHT_INTENSITY * (0.06 + 0.94 * above) * (0.15 + 0.85 * sunPower) * (1 + 0.12 * DAY_RAMP(day));
  sun.position.copy(sunDirTmp).multiplyScalar(1800);
  sun.target.position.set(0, 0, -100);

  // 天空补光 / 环境光：夜里极弱偏蓝，天亮后大幅增强（地景靠它才看得清）
  skyFill.intensity = 0.10 + 1.55 * Math.pow(eased, 1.25) + 0.40 * DAY_RAMP(day);
  skyFill.color.copy(hemiColor);
  const dG = DAY_RAMP(day);
  skyFill.groundColor.setRGB(
    0.06 * (0.4 + eased) + 0.035 * dG,
    0.055 * (0.4 + eased) + 0.032 * dG,
    0.048 * (0.4 + eased) + 0.030 * dG
  );

  // 低处补一盏"水面反射"的暖光（不加光源，用雾的暖色近似）

  // ---- 共享雾参数
  fogUniforms.fogColor.value.copy(fogColor);
  fogUniforms.fogSunColor.value.copy(sunColor);
  fogUniforms.fogSunDir.value.copy(sunDirTmp);
  fogUniforms.fogDensityScale.value = (0.25 + 0.95 * (1 - eased)) * (1 - 0.30 * DAY_RAMP(day));
  fogUniforms.fogSunAmount.value = Math.pow(eased, 1.5);

  // ---- ViewState
  view.progress = p;
  view.eased = eased;
  view.day = day;
  view.sunElevation = elev;
  view.sunWorldDir.copy(sunDirTmp);
  view.time = state.time;
  view.motion = state.motion ? 1 : 0;

  // ---- 世界更新
  skyLayer.tick(view);
  terrain.tick(view);
  sea.tick(view, dt);

  // ---- 渲染（debug.raw = 跳过后期，直接看 WebGL 原图，用来分离"场景问题"和"调色问题"）
  if (debug.raw) {
    renderer.setRenderTarget(null);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.autoClear = true;
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
  } else {
    composite.render(scene, camera, view);
  }

  // ---- 界面（每帧只写 DOM 字符串，很便宜；进度条用 CSS 过渡）
  hud.setAtmosphere(eased, day);
  hud.setProgress(p1, state.target, TOTAL_TICKS);
  audio.update(eased);

  // ---- fps
  fpsAcc += dt;
  fpsFrames++;
  if (fpsAcc >= 0.5) {
    hud.setFps(Math.round(fpsFrames / fpsAcc));
    fpsAcc = 0;
    fpsFrames = 0;
  }
  watchPerformance(dt * 1000);
}

/* ---------------------------------------------------------------- 启动 */

resize();
hud.setButton('auto', state.auto);
hud.setButton('motion', state.motion);
hud.setButton('sound', state.sound);
hud.setQuote(deck.next(), true);
hud.setProgress(0, 0, TOTAL_TICKS);
setTimeout(() => hud.toggleHint(false), 50);

/* ---------------------------------------------------------------- 解锁声音
 * 浏览器只允许在用户手势里创建/恢复 AudioContext。
 * 这里抢在首屏 intro 之前注册（intro 会在 window 捕获阶段吃掉事件，
 * 但它是在后面才注册的，所以这个监听一定先跑）。
 * 第一次轻触 = 首屏的"轻触开始"，音乐就跟着一起亮起来。 */
let soundUnlocked = false;
function unlockSound() {
  if (soundUnlocked) return;
  soundUnlocked = true;
  if (!state.sound) {
    state.sound = true;
    hud.setButton('sound', true);
  }
  audio.setEnabled(true);
}
window.addEventListener('pointerdown', unlockSound, { capture: true, passive: true });
window.addEventListener('keydown', unlockSound, { capture: true });
// 离开页面时淡出，避免混响被硬切断出"咔"的一声
window.addEventListener('pagehide', () => { audio.setEnabled(false); });

/* ---------------------------------------------------------------- 首屏
 * 纯黑底 + 打字机介绍。它盖住画面并自己吞掉全部输入，
 * 所以渲染照常跑，只是先看不见；关闭后的第一次点击才会升第一帧。 */
const intro = createIntro();
intro.done.then(() => {
  state.lastInputAt = performance.now();
});

// 暴露给调试与自动化截图
window.__XINGUANG__ = {
  state,
  view,
  renderer,
  scene,
  camera,
  audio,
  intro,
  lift,
  reset,
  debug,
  layers: { skyLayer, terrain, sea, composite },
  /** 直接把进度拨到 v（0..1 = 第一阶段；>1 = 天光大亮之后继续往上升） */
  setProgressInstant(v) {
    state.target = Math.round(Math.max(0, v) * TOTAL_TICKS);
    state.progress = state.target / TOTAL_TICKS;
    state.lastInputAt = performance.now();
  }
};

requestAnimationFrame(frame);
