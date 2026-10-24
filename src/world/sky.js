/**
 * 心光 · 天空系统
 * ------------------------------------------------------------------
 * 一个工厂函数 createSky(renderer, opts) 返回：
 *   { object3D, tick(view), dispose() }
 *
 * 组成（全部是自定义 ShaderMaterial，不依赖任何外部图片）：
 *   1. 天空穹顶   radius 3000 的球，BackSide，每帧跟随相机；三色渐变 + 日晕 + 高空暗角
 *   2. 太阳圆盘   面向相机的 additive 圆盘，中心过曝到 >1 的线性值，边缘 #ff9a4d
 *   3. 日晕       比太阳大 5~7 倍的柔和暖光
 *   4. 云         2 层（high 质量 5 层）大平面，CPU 生成的可平铺噪声图，缓慢漂移
 *   5. 星空       980 颗点，伪随机分布在上半球，冷暖色差 + 各自闪烁相位
 *
 * 颜色策略：
 *   所有颜色都在"线性空间"里以关键帧形式写成 THREE.Color，
 *   按 view.eased 分段插值（uZenith / uHorizon / uSunSide）。
 *   eased = 0 时几乎全黑，只有太阳一侧地平线有一抹极弱的暖光；
 *   eased = 1 时是低饱和的金色晨光，天顶仍然偏冷蓝，保持电影感。
 *
 * 性能：tick 内不分配任何对象（全部用模块级临时变量），draw call 约 6 个。
 */

import * as THREE from 'three';
import { SUN_ELEVATION_START, SUN_ELEVATION_END, SUN_DISTANCE, DAY_RAMP } from '../config.js';

/* ------------------------------------------------------------------ *
 * 关键帧：t / 天顶 / 地平线 / 太阳侧暖色
 * 低饱和、厚重 haze 的电影感基调（线性空间，十六进制 sRGB 由 three 转换）
 * ------------------------------------------------------------------ */
const SKY_KEYS = [
  { t: 0.00, zenith: 0x03050e, horizon: 0x0c1730, sun: 0x201a14 },
  { t: 0.12, zenith: 0x04070f, horizon: 0x121e38, sun: 0x2e2318 },
  { t: 0.30, zenith: 0x0b1636, horizon: 0x24305a, sun: 0x5a3d2c },
  { t: 0.46, zenith: 0x122a52, horizon: 0x3b4d74, sun: 0x8f5b39 },
  { t: 0.60, zenith: 0x1c3c6d, horizon: 0x566a8f, sun: 0xc47343 },
  { t: 0.74, zenith: 0x2a5690, horizon: 0x7d90ab, sun: 0xee9a55 },
  { t: 0.85, zenith: 0x3570ad, horizon: 0x9db1c4, sun: 0xffaf66 },
  { t: 1.00, zenith: 0x2f7ac4, horizon: 0xa8c4dc, sun: 0xffc87a },
  /* 天光大亮之后：云层褪尽、天顶更深更蓝、地平线更接近正午的乳白 */
  { t: 1.14, zenith: 0x2a78cc, horizon: 0xb7cfe2, sun: 0xffd9a1 },
  { t: 1.33, zenith: 0x2574d2, horizon: 0xc9dced, sun: 0xffe6bd }
];
const SKY_KEY_COLORS = SKY_KEYS.map((k) => [
  new THREE.Color(k.zenith),
  new THREE.Color(k.horizon),
  new THREE.Color(k.sun)
]);

/* 地平线以下（海面以下的半球）压暗的系数 */
const BELOW_HORIZON_DIM = 0.16;

/* 天空整体亮度：色板已经按"输出到线性 0.004~0.5"的目标调过，
 * 这里保持 1.0；如果后期想要更亮的整体曝光，改这一个数就行。 */
const SKY_BRIGHTNESS = 1.0;

/* ------------------------------------------------------------------ *
 * 顶点着色器：天空穹顶
 * vDir = 从相机出发的视线方向（球心跟随相机，object 空间即世界方向）
 * ------------------------------------------------------------------ */
const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/* ------------------------------------------------------------------ *
 * 片元着色器：三色渐变 + 太阳方向光晕 + 高空压暗 + 抖动（防色带）
 * 只用 WebGL2 / GLSL ES 3.00 都合法的写法，没有 precision 声明。
 * ------------------------------------------------------------------ */
const DOME_FRAG = /* glsl */`
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunSide;     // 太阳一侧的地平线色（关键帧里最暖的那一端）
uniform vec3 uSunColor;    // 当前太阳色（随高度变化）
uniform vec3 uSunDir;
uniform float uHaze;
uniform float uGlow;
uniform float uTime;
uniform float uDither;
uniform float uStarAmount;
uniform float uSkyBrightness;
uniform float uBelowDim;

varying vec3 vDir;

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  /* ---- 基础渐变：地平线 → 天顶，一条很宽的色带，绝不出现条带/硬切 ---- */
  float t = clamp(h, 0.0, 1.0);
  /* 指数越小球一下就蓝上来。0.62 时天色从地平线往上铺了 15° 还是灰白，海面斜掠反射
   * 就会把那一整层灰白抄下来，画成贴岸的苍白陆架 —— 所以收到 0.34。 */
  float band = pow(t, 0.34);
  vec3 color = mix(uHorizon, uZenith, band);

  /* ---- 太阳方位：地平线附近朝太阳那一侧更暖 ---- */
  vec3 sunFlat = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-5, 0.0, 1e-5));
  vec3 dirFlat = normalize(vec3(dir.x, 0.0, dir.z) + vec3(1e-5, 0.0, 1e-5));
  float dial = clamp(dot(dirFlat, sunFlat) * 0.5 + 0.5, 0.0, 1.0);

  /* 地平线暖色带：以地平线为中心的高斯，只在 h ∈ [-0.25, +0.20] 这一段起作用，
   * 沿方位朝太阳侧集中（pow(dial, 2.2)），所以"日出那一侧的地平线是金橙色，另一侧还是冷蓝"。 */
  float horizBand = exp(-abs(h) * 12.0);
  float sunward = pow(dial, 2.2);
  vec3 sideCol = mix(uHorizon, uSunSide, 0.35 + 0.65 * sunward);
  color = mix(color, sideCol, horizBand * (0.26 + 0.58 * sunward) * uHaze);

  /* 地平线以下：保持地平线色并缓慢压暗，海面那条缝隙不会突兀 */
  float belowH = clamp(-h * 6.0, 0.0, 1.0);
  color *= mix(1.0, uBelowDim, belowH);

  /* ---- 太阳方向光晕：能量全部收在日核周围，绝不把大面积天空提亮成灰雾 ---- */
  float cosA = clamp(dot(dir, uSunDir), -1.0, 1.0);
  float ang = acos(cosA);
  float inner = exp(-ang * 9.0);
  float outer = exp(-ang * 2.8);
  float fogEat = smoothstep(-0.05, 0.28, h);
  float glowAmount = (inner * 0.50 + outer * 0.13) * uGlow * mix(0.16, 1.0, fogEat);

  /* 贴地暖光带：太阳正下方极窄的一段，像大气散射 */
  float belt = exp(-abs(h - 0.010) * 26.0) * pow(dial, 3.0);
  glowAmount += belt * uGlow * 0.60;
  color += uSunColor * glowAmount;

  color *= uSkyBrightness;

  /* ---- 高空轻压：保住电影感 ---- */
  color *= mix(1.0, 0.92, smoothstep(0.30, 1.0, t));

  /* ---- 抖动：只在暗部生效，地平线附近不做任何硬切 ---- */
  float lum = dot(color, vec3(0.299, 0.587, 0.114));
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  color += (n - 0.5) * uDither * (1.0 - smoothstep(0.02, 0.10, lum));

  gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
}
`;

/* ------------------------------------------------------------------ *
 * 太阳 / 日晕：共用顶点着色器，圆盘在视图空间里展开成 billboard
 * ------------------------------------------------------------------ */
const SUN_VERT = /* glsl */`
varying vec2 vUv;

void main() {
  vUv = uv;
  /* 纯世界坐标 billboard：网格的 position 已经是 camera.position + dir*SUN_DISTANCE，
   * 每帧把 quaternion 抄成相机的 quaternion，于是平面的局部 XY 轴就等于屏幕的右/上，
   * 视觉大小由几何尺寸（世界单位半径）决定，屏幕投影交给 three 的矩阵——
   * 这样太阳的屏幕位置永远和 config 里的仰角/方位严格一致，不会因为换相机而跑偏。 */
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/* 太阳本体：不透明实心亮核 + 急剧衰减软边。
 * 用 NormalBlending 直出，核心 alpha≈1、颜色是远超 1 的过曝值，
 * 绝不用加法混合——加法叠在整片天空上会把天顶提亮成一层灰雾（上一版的教训）。 */
const SUN_FRAG = /* glsl */`
uniform vec3 uCoreColor;
uniform vec3 uEdgeColor;
uniform float uAlpha;
uniform float uOverexpose;
varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;

  /* 实心核 + 极短软边：0.88 之前全是实的（太阳在照片里就是"烧掉的一块"），
   * 只有最外面 12% 做柔化，避免出现一圈硬边轮廓。 */
  float body = 1.0 - smoothstep(0.86, 1.0, r);
  body = pow(body, 1.05);

  /* 中心过曝到近白，到边缘仍然要**比天空亮**（否则会在亮天空上抠出一圈暗棕） */
  vec3 col = mix(uEdgeColor, uCoreColor, smoothstep(1.0, 0.18, r));
  col *= mix(1.0, uOverexpose, smoothstep(0.92, 0.0, r));

  gl_FragColor = vec4(col, body * uAlpha);
}
`;

/* 日晕：半径是太阳的 3.6~6.2 倍，能量全部收在圆内，1.0 处严格为 0，绝不外溢成一片灰雾。 */
const HALO_FRAG = /* glsl */`
uniform vec3 uEdgeColor;
uniform vec3 uCoreColor;
uniform float uAlpha;
varying vec2 vUv;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;

  /* 只有两层指数衰减，没有环状结构，所以不会出现"光圈感" */
  float fall = exp(-r * 6.4) * (1.0 - smoothstep(0.45, 1.0, r));
  fall += exp(-r * 3.1) * 0.45 * (1.0 - smoothstep(0.30, 1.0, r));
  float a = fall * uAlpha;

  vec3 col = mix(uEdgeColor, uCoreColor, exp(-r * 3.6) * 0.65);
  gl_FragColor = vec4(col, a);
}
`;

/* ------------------------------------------------------------------ *
 * 云：大平面 + 可平铺噪声，几乎只提供"雾里的明暗层次"
 * ------------------------------------------------------------------ */
const CLOUD_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CLOUD_FRAG = /* glsl */`
uniform sampler2D uNoise;
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec2 uSunFlat;
uniform float uOpacity;
uniform float uBand;
uniform float uDrift;
uniform float uSeed;
uniform float uSolid;
uniform float uContrast;
varying vec2 vUv;

void main() {
  /* 噪声坐标：横向 1 个平铺、纵向 0.45 个平铺 —— 云是水平拉长的软团块 */
  vec2 uv = vec2(vUv.x * 1.0, vUv.y * 0.45) + vec2(uSeed * 3.7, uSeed * 1.3);

  /* 两层不同速度的漂移，叠出缓慢的形变（纹理平铺，漂移不会露边） */
  vec2 d1 = vec2(uDrift * 0.016, 0.0);
  vec2 d2 = vec2(uDrift * 0.0085, uDrift * 0.0011);
  float n1 = texture2D(uNoise, uv + d1).r;
  float n2 = texture2D(uNoise, uv * 1.9 + vec2(0.31, 0.17) - d2).r;
  float n = n1 * 0.72 + n2 * 0.28;

  /* 水平调制：中间厚、两侧薄，避免像糊满的墙纸 */
  float horiz = 1.0 - smoothstep(0.22, 0.98, abs(vUv.x - 0.5) * 2.0);

  /* 极软的门限：只在噪声最高的一小段里出现云，其余全是"雾"。
   * 再叠一层很慢的低频调制，让云的上下边界起伏，呈现"长云"而不是一条带子。 */
  float thr = uBand
    - 0.055 * sin(vUv.x * 2.6 + uSeed * 6.2831)
    - 0.030 * sin(vUv.x * 5.3 - uSeed * 3.1);
  float shape = smoothstep(thr - 0.16, thr + 0.30 + uSolid, n);
  shape *= mix(0.28, 1.0, horiz);
  /* 云的"厚度"：用噪声本身当暗部，而不是画一个实心块 */
  shape *= 0.55 + 0.45 * smoothstep(thr, thr + 0.42, n);

  /* 受光面暖、背光面冷：用噪声梯度的近似（额外采样） */
  float nx = texture2D(uNoise, uv + d1 + vec2(0.008, 0.0)).r;
  float ny = texture2D(uNoise, uv + d1 + vec2(0.0, 0.008)).r;
  vec2 grad = vec2(nx - n1, ny - n1) * 26.0;
  vec2 sunV = normalize(uSunFlat + vec2(1e-4));
  vec2 gV = normalize(-grad + vec2(1e-4));
  float sunward = clamp(dot(sunV, gV) * 0.5 + 0.5, 0.0, 1.0);
  float lift = clamp(0.40 + grad.y * 0.55 + sunward * 0.40, 0.0, 1.0);

  vec3 col = mix(uShade, uLit, pow(lift, 1.8));
  col *= mix(0.92, 1.03, shape);

  float a = shape * uOpacity;
  a *= smoothstep(0.0, 0.30, vUv.y) * (1.0 - smoothstep(0.62, 1.0, vUv.y));
  a = clamp(a * uContrast, 0.0, 1.0);

  gl_FragColor = vec4(col * a, a);
}
`;

/* ------------------------------------------------------------------ *
 * 星空
 * ------------------------------------------------------------------ */
const STAR_VERT = /* glsl */`
attribute vec3 aColor;
attribute vec3 aMeta;   /* x = 亮度/尺寸, y = 闪烁相位, z = 闪烁速度 */
uniform float uTime;
uniform float uPixelRatio;
uniform float uFade;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);

  float twinkle = 0.62 + 0.38 * sin(uTime * (0.7 + aMeta.z * 1.6) + aMeta.y * 6.2831);
  float bright = aMeta.x;
  float a = uFade * twinkle * smoothstep(0.0, 1.4, bright);
  /* 天亮之后只留最亮的几颗 */
  a *= mix(1.0, step(1.2, bright), smoothstep(0.35, 0.85, 1.0 - uFade));

  vAlpha = a;
  gl_Position = projectionMatrix * mv;
  gl_PointSize = (1.0 + bright * 1.15) * uPixelRatio * 2.1;
}
`;

const STAR_FRAG = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = dot(p, p);
  if (d > 1.0) discard;
  float falloff = exp(-d * 3.4);
  gl_FragColor = vec4(vColor * falloff * vAlpha, falloff * vAlpha);
}
`;

/* ------------------------------------------------------------------ *
 * 天空在画面里"该有多亮"的关键帧（eased）：云 / 星 / 太阳都按这些曲线走
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 工具：可平铺噪声纹理（云用）。纯 CPU 生成，不依赖外部图片。
 * 由若干整数频率的正弦波叠加而成，因此两个方向都以 size 为周期，可无缝 RepeatWrapping。
 * ------------------------------------------------------------------ */
function makeCloudNoiseTexture(size = 128, seed = 1337) {
  const data = new Uint8Array(size * size * 4);
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const buildWaves = (count, fMin, fStep, fRange, freqScale) => {
    const out = [];
    let ampSum = 0;
    for (let i = 0; i < count; i++) {
      const fx = fMin + Math.floor(rand() * fRange) * fStep;
      const fy = fMin + Math.floor(rand() * fRange) * fStep;
      const amp = 1 / (1 + (fx + fy) * freqScale);
      out.push({ fx, fy, phase: rand() * Math.PI * 2, amp });
      ampSum += amp;
    }
    return { waves: out, ampSum };
  };

  const lo = buildWaves(30, 1, 2, 5, 0.55);
  const hi = buildWaves(26, 5, 2, 7, 0.05);

  const gamma = (val) => val * val * (3 - 2 * val);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let n1 = 0;
      for (let i = 0; i < lo.waves.length; i++) {
        const w = lo.waves[i];
        n1 += w.amp * Math.sin((u * w.fx + v * w.fy) * Math.PI * 2 + w.phase);
      }
      n1 /= lo.ampSum;
      let n2 = 0;
      for (let i = 0; i < hi.waves.length; i++) {
        const w = hi.waves[i];
        n2 += w.amp * Math.sin((u * w.fx + v * w.fy) * Math.PI * 2 + w.phase);
      }
      n2 /= hi.ampSum;

      /* 主要用纵向变化很慢的低频成分，高频只给一点点细节：
       * 这样放大到 3000m 的平面上是"大块的长云"，而不是一道道的细条纹。 */
      /* 用 tanh 形状把分布压成平滑的大块（避免"云里云气"的锐利细纹），
       * 高频只占 10%，纯粹是给低对比度表面加一点颗粒。 */
      let val = (n1 * 0.90 + n2 * 0.10) * 1.12 + 0.5;
      val = val < 0 ? 0 : val > 1 ? 1 : val;

      const k = (y * size + x) * 4;
      const b = Math.round(val * 255);
      data[k] = b;
      data[k + 1] = b;
      data[k + 2] = b;
      data[k + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ *
 * 模块级临时变量：tick 中绝不允许 new
 * ------------------------------------------------------------------ */
const _camDir = new THREE.Vector3();
const rhVec = new THREE.Vector3();
const upVec = new THREE.Vector3();
/* uOffset/uPxScale 需要的临时量在 tick 里就地算，不新分配对象。 */
/* 太阳圆盘半径 = 屏高的这个比例（直径 2 倍 = 屏高 4%）。 */
const SUN_SCREEN_RATIO = 0.020;
const DEG2RAD = Math.PI / 180;
/** 分段插值关键帧颜色到三个输出 Color 里（带 smoothstep 柔化） */
function sampleKeys(t, outZenith, outHorizon, outSun) {
  const n = SKY_KEYS.length;
  let i = 0;
  while (i < n - 2 && t > SKY_KEYS[i + 1].t) i++;
  const a = SKY_KEYS[i];
  const b = SKY_KEYS[i + 1];
  let f = (t - a.t) / Math.max(b.t - a.t, 1e-6);
  f = f < 0 ? 0 : f > 1 ? 1 : f;
  const sf = f * f * (3 - 2 * f);
  outZenith.lerpColors(SKY_KEY_COLORS[i][0], SKY_KEY_COLORS[i + 1][0], sf);
  outHorizon.lerpColors(SKY_KEY_COLORS[i][1], SKY_KEY_COLORS[i + 1][1], sf);
  outSun.lerpColors(SKY_KEY_COLORS[i][2], SKY_KEY_COLORS[i + 1][2], sf);
}

/** 太阳高度 → 太阳色（线性 RGB）：地平线偏红，高处发白黄。返回写入 out。 */
function sunColorAt(sunUp, out) {
  if (sunUp < 0.5) {
    const f = sunUp / 0.5;
    out.setRGB(1.0, 0.40 + 0.28 * f, 0.15 + 0.19 * f, THREE.LinearSRGBColorSpace);
  } else {
    const f = (sunUp - 0.5) / 0.5;
    out.setRGB(1.0, 0.68 + 0.25 * f, 0.34 + 0.40 * f, THREE.LinearSRGBColorSpace);
  }
  return out;
}

/**
 * 创建天空系统。
 * @param {THREE.WebGLRenderer} renderer
 * @param {{quality?: 'high'|'low', debug?: boolean}} opts
 */
export function createSky(renderer, opts = {}) {
  const quality = opts.quality === 'low' ? 'low' : 'high';
  const debug = !!opts.debug;

  const root = new THREE.Group();
  root.name = 'sky';

  /* ---------------- 1. 天空穹顶 ---------------- */
  const domeSeg = quality === 'low' ? [32, 20] : [48, 32];
  const domeGeo = new THREE.SphereGeometry(3000, domeSeg[0], domeSeg[1]);
  const domeUniforms = {
    uZenith: { value: new THREE.Color(0x02030a) },
    uHorizon: { value: new THREE.Color(0x0c1626) },
    uSunSide: { value: new THREE.Color(0x241e14) },
    uSunColor: { value: new THREE.Color(0xff9a4d) },
    uSunDir: { value: new THREE.Vector3(0, -0.155, -0.988) },
    uHaze: { value: 1.0 },
    uGlow: { value: 0.05 },
    uTime: { value: 0 },
    uDither: { value: quality === 'low' ? 0.0 : 0.0016 },
    uStarAmount: { value: 1.0 },
    uSkyBrightness: { value: SKY_BRIGHTNESS },
    uBelowDim: { value: BELOW_HORIZON_DIM }
  };
  const domeMat = new THREE.ShaderMaterial({
    uniforms: domeUniforms,
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    /* 天空是画面上最先铺底的一层：depthTest 关掉，永远画在最前面，不参与任何深度比较 */
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.name = 'sky-dome';
  dome.frustumCulled = false;
  dome.matrixAutoUpdate = true;
  dome.renderOrder = -1000;
  root.add(dome);

  /* ---------------- 2. 太阳圆盘 ---------------- */
  /* 太阳圆盘一律按"屏幕上的比例"绘制：半径 = 屏高 * SUN_SCREEN_RATIO（直径 = 屏高 4%）。
   * 这样太阳的大小与距离、透视、海面雾完全解耦，config 改俯仰时太阳也始终是同一个尺寸。 */
  const sunGeo = new THREE.PlaneGeometry(2, 2, 1, 1);
  const sunUniforms = {
    uCoreColor: { value: new THREE.Color().setRGB(3.10, 2.86, 2.42, THREE.LinearSRGBColorSpace) },
    uEdgeColor: { value: new THREE.Color().setRGB(1.85, 1.16, 0.58, THREE.LinearSRGBColorSpace) },
    uAlpha: { value: 0 },
    uOverexpose: { value: 1.7 }
  };
  const sunMat = new THREE.ShaderMaterial({
    uniforms: sunUniforms,
    vertexShader: SUN_VERT,
    fragmentShader: SUN_FRAG,
    transparent: true,
    /* 加法混合：日出到天光大亮的过程中，太阳周围的天空从 0.1 亮到 1.2+，
     * 用 NormalBlending 时圆盘边缘的暖色一旦比天空暗，就会在太阳外面抠出一圈
     * 明显的暗环（v2-1 截图里的"甜甜圈"）。加法混合永远不会把背景压暗，
     * 而能量又全部收在 r<1 的圆内（alpha 在边界严格为 0），不会把天空提亮成灰雾。 */
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    /* depthTest=true：太阳圆盘属于透明层，晚于不透明地形/海面渲染；
     * 再加上 SUN_DISTANCE 放在所有地形之后，太阳沉在海平线下或躲在山后时会被真正遮住，
     * 而不是像以前那样浮在最前面。 */
    depthTest: true,
    fog: false,
    toneMapped: false
  });
  const sunMesh = new THREE.Mesh(sunGeo, sunMat);
  sunMesh.name = 'sky-sun';
  sunMesh.frustumCulled = false;
  sunMesh.renderOrder = -880;
  root.add(sunMesh);

  /* ---------------- 3. 日晕 ---------------- */
  const haloGeo = new THREE.PlaneGeometry(2, 2, 1, 1);
  const haloUniforms = {
    uEdgeColor: { value: new THREE.Color().setRGB(1.34, 0.86, 0.46, THREE.LinearSRGBColorSpace) },
    uCoreColor: { value: new THREE.Color().setRGB(1.72, 1.24, 0.78, THREE.LinearSRGBColorSpace) },
    uAlpha: { value: 0 }
  };
  const haloMat = new THREE.ShaderMaterial({
    uniforms: haloUniforms,
    vertexShader: SUN_VERT,
    fragmentShader: HALO_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false
  });
  const haloMesh = new THREE.Mesh(haloGeo, haloMat);
  haloMesh.name = 'sky-halo';
  haloMesh.frustumCulled = false;
  haloMesh.renderOrder = -890;
  root.add(haloMesh);

  /* ---------------- 4. 云 ---------------- */
  const cloudTex = makeCloudNoiseTexture(quality === 'low' ? 64 : 128, 9173);
  const cloudPlaneGeo = new THREE.PlaneGeometry(1, 1, 1, 1);

  // z 深度 / y 高度 / 平面宽高 / 阈值 / 不透明度 / 漂移速度 / 软程度 / 纹理偏移
  /* 云层：z 越远、y 越高，越接近画面上方。
   * 相机俯角 5.4°、海平线在画面 60% 高，所以云必须抬到 y≈260~560 才落在海平线之上；
   * 全部留在「天空的中下段」，只在太阳周围衬托，不糊住天顶。 */
  const CLOUD_LAYERS = quality === 'low'
    ? [
      { z: -1500, y: 300, w: 3800, h: 620, band: 0.50, opacity: 0.16, drift: 1.0, solid: 0.05, seed: 0.13 },
      { z: -2100, y: 440, w: 5200, h: 780, band: 0.53, opacity: 0.12, drift: 0.7, solid: 0.07, seed: 0.57 }
    ]
    : [
      { z: -1300, y: 262, w: 3200, h: 560, band: 0.55, opacity: 0.13, drift: 1.00, solid: 0.03, seed: 0.13 },
      { z: -1600, y: 336, w: 4000, h: 640, band: 0.57, opacity: 0.115, drift: 0.82, solid: 0.04, seed: 0.41 },
      { z: -1900, y: 418, w: 4800, h: 720, band: 0.59, opacity: 0.10, drift: 0.63, solid: 0.05, seed: 0.57 },
      { z: -2250, y: 488, w: 5600, h: 820, band: 0.60, opacity: 0.085, drift: 0.48, solid: 0.06, seed: 0.79 },
      { z: -2500, y: 556, w: 6200, h: 900, band: 0.61, opacity: 0.07, drift: 0.36, solid: 0.07, seed: 0.93 }
    ];

  const clouds = [];
  for (let i = 0; i < CLOUD_LAYERS.length; i++) {
    const L = CLOUD_LAYERS[i];
    const uni = {
      uNoise: { value: cloudTex },
      uLit: { value: new THREE.Color(0x2c3350) },
      uShade: { value: new THREE.Color(0x1a2036) },
      uSunFlat: { value: new THREE.Vector2(0, -1) },
      uOpacity: { value: 0 },
      uBand: { value: L.band },
      uDrift: { value: 0 },
      uSeed: { value: L.seed },
      uSolid: { value: L.solid },
      uContrast: { value: 1.0 }
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: uni,
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
      side: THREE.DoubleSide
    });
    const mesh = new THREE.Mesh(cloudPlaneGeo, mat);
    mesh.scale.set(L.w, L.h, 1);
    mesh.position.set(0, L.y, L.z);
    mesh.name = 'sky-cloud-' + i;
    mesh.frustumCulled = false;
    mesh.renderOrder = -800 + i;
    root.add(mesh);
    clouds.push({ mesh, mat, uni, layer: L });
  }

  /* ---------------- 5. 星空 ---------------- */
  const STAR_COUNT = quality === 'low' ? 520 : 980;
  const STAR_RADIUS = 2600;
  const starPos = new Float32Array(STAR_COUNT * 3);
  const starCol = new Float32Array(STAR_COUNT * 3);
  const starMeta = new Float32Array(STAR_COUNT * 3);

  let srand = 20240917 >>> 0;
  const rnd = () => {
    srand = (srand + 0x6d2b79f5) >>> 0;
    let t = srand;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < STAR_COUNT; i++) {
    // 上半球分布：y 靠近地平线更密（抬头看天时星星是均匀的）
    const y = 0.02 + Math.pow(rnd(), 0.85) * 0.97;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = rnd() * Math.PI * 2;
    starPos[i * 3] = Math.cos(phi) * r * STAR_RADIUS;
    starPos[i * 3 + 1] = y * STAR_RADIUS;
    starPos[i * 3 + 2] = Math.sin(phi) * r * STAR_RADIUS;

    // 亮度幂律：多数暗、少数亮；另有 3.5% 的"最亮的几颗"
    let b = Math.pow(rnd(), 1.7);
    if (rnd() < 0.035) b = 1.25 + rnd() * 0.55;
    starMeta[i * 3] = b;
    starMeta[i * 3 + 1] = rnd();
    starMeta[i * 3 + 2] = rnd();

    // 冷暖色差：少量偏蓝、少量偏暖
    const c = rnd();
    let rr;
    let gg;
    let bb;
    if (c < 0.14) {
      rr = 0.62; gg = 0.78; bb = 1.0;      // 偏蓝
    } else if (c < 0.30) {
      rr = 1.0; gg = 0.84; bb = 0.66;      // 偏暖
    } else if (c < 0.52) {
      rr = 0.86; gg = 0.92; bb = 1.0;      // 冷白
    } else {
      rr = 1.0; gg = 0.97; bb = 0.92;      // 近白
    }
    const lum = 2.6 + b * 2.6;
    starCol[i * 3] = rr * lum;
    starCol[i * 3 + 1] = gg * lum;
    starCol[i * 3 + 2] = bb * lum;
  }

  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(starCol, 3));
  starGeo.setAttribute('aMeta', new THREE.BufferAttribute(starMeta, 3));
  starGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), STAR_RADIUS * 1.2);

  const starUniforms = {
    uTime: { value: 0 },
    uPixelRatio: { value: 1 },
    uFade: { value: 1 }
  };
  const starMat = new THREE.ShaderMaterial({
    uniforms: starUniforms,
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    /* 星星挂在穹顶内侧，永远画在天空之上、太阳之下（renderOrder 控制） */
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.name = 'sky-stars';
  stars.frustumCulled = false;
  stars.renderOrder = -950;
  root.add(stars);

  /* ---------------- 每帧更新 ---------------- */
  let reported = false;

  function tick(view) {
    if (!view) return;

    const eased0 = view.eased == null ? 0 : view.eased < 0 ? 0 : view.eased > 1 ? 1 : view.eased;
    // "白天"进度：天光大亮之后天色/云/星空继续演化，世界不会在 60 帧后冻住
    const day = view.day == null ? 0 : view.day < 0 ? 0 : view.day > 1 ? 1 : view.day;
    const eased = Math.min(1.33, eased0 + DAY_RAMP(day));
    const ease0 = eased0;   // 需要 0..1 语义的地方（星、云、亮度）继续用这个
    const time = view.time || 0;
    const motion = view.motion == null ? 1 : view.motion;
    const cam = view.camera;
    const sunDir = view.sunWorldDir || domeUniforms.uSunDir.value;
    const sunY = sunDir.y;
    const pix = view.resolution && view.resolution.pixelRatio ? view.resolution.pixelRatio : 1;
    // 太阳在整段 elevation 区间里的进度（0 = 起始地平线下，1 = 终局高度）。
    // 用 view.sunElevation 归一化，而不是写死角度：config 里改 SUN_ELEVATION_* 天空自动跟随。
    const elev = view.sunElevation == null ? Math.asin(sunY) : view.sunElevation;
    let sunUp = (elev - SUN_ELEVATION_START) / (SUN_ELEVATION_END - SUN_ELEVATION_START);
    sunUp = sunUp < 0 ? 0 : sunUp > 1 ? 1 : sunUp;

    /* 穹顶/太阳/云都跟随相机：球心永远在相机处，永远不会穿帮 */
    if (cam) {
      root.position.set(cam.position.x, cam.position.y, cam.position.z);
      cam.getWorldDirection(_camDir);
    }

    /* ---- 穹顶颜色 ---- */
    sampleKeys(eased, domeUniforms.uZenith.value, domeUniforms.uHorizon.value, domeUniforms.uSunSide.value);
    sunColorAt(sunUp, domeUniforms.uSunColor.value);
    domeUniforms.uSunDir.value.copy(sunDir);
    /* 太阳越高能量越集中在日核周围；原来上限只有 0.34，
   * 全亮那一帧太阳显得"寡淡"，日出该有的那圈金白色光晕站不住。 */
  domeUniforms.uGlow.value = 0.05 + 0.62 * Math.pow(sunUp, 1.55);
    domeUniforms.uHaze.value = (0.52 + 0.22 * eased0) * (1.0 - 0.20 * DAY_RAMP(day));
    domeUniforms.uTime.value = time;

  /* ---- 太阳 / 日晕：世界坐标 billboard ---- */
  /* 太阳网格放在 camera.position + sunDir * SUN_DISTANCE，每帧把 quaternion 抄成相机的
   * quaternion，于是平面局部 XY 轴严格等于屏幕的右/上；屏幕位置由 three 的投影矩阵决定，
   * 与 config 里的方位/仰角完全一致，换相机也不会跑偏。
   * 视觉大小用"角直径"控制：半径 = D * 2 * s * tan(fov/2)，s = 半径占屏高的比例。 */
  const halfFov = (cam && cam.fov ? cam.fov : 46) * 0.5 * DEG2RAD;
  const tanHalf = Math.tan(halfFov);
  const c = _camDir;
  const sFwd = sunDir.x * c.x + sunDir.y * c.y + sunDir.z * c.z;

  const sunR = SUN_DISTANCE * 2.0 * SUN_SCREEN_RATIO * tanHalf;        // 世界单位半径
  /* 日晕半径：太阳越高晕越大，但不能让它顶出画面上缘被切掉。
   * 做法是同时算"自然角半径"和"太阳中心到画面上缘还剩多少角余量"，取小者，
   * 于是太阳升到软上限附近时晕会自然收成围着太阳的一圈紧光，而不是被削平。 */
  const naturalHalo = Math.atan((sunR * (3.6 + 2.8 * sunUp)) / SUN_DISTANCE);
  const axisElev = cam ? Math.asin(Math.max(-1, Math.min(1, _camDir.y))) : 0;
  const topElev = axisElev + Math.atan(0.94 * tanHalf);   // 画面上缘视线对应的仰角
  const roomR = Math.max(0, topElev - elev);
  const haloAng = Math.max(sunR / SUN_DISTANCE * 1.6, Math.min(naturalHalo, roomR * 0.92));
  const haloR = SUN_DISTANCE * Math.tan(haloAng);

  if (cam) {
    sunMesh.position.copy(cam.position).addScaledVector(sunDir, SUN_DISTANCE);
    sunMesh.quaternion.copy(cam.quaternion);
    sunMesh.scale.setScalar(sunR);
    haloMesh.position.copy(sunMesh.position);
    haloMesh.quaternion.copy(cam.quaternion);
    haloMesh.scale.setScalar(haloR);
  }

  sunUniforms.uOverexpose.value = 1.30 + 0.55 * sunUp;

  /* 可见度：太阳在相机背后时熄灭；夜里（eased 很小）太阳本来就不该亮。 */
  let vis = 1;
  if (sFwd <= 0) vis = 0;
  // 太阳沉到地平线下时，靠"被海面雾吃掉"的观感淡出：低于 -0.02 开始，到 -0.09 完全消失
  let under = (sunDir.y + 0.02) / 0.07;
  under = under < 0 ? 0 : under > 1 ? 1 : under;
  under = under * under * (3 - 2 * under);
  vis *= 0.05 + 0.95 * under;
  // 夜里只留一点点余温（避免 eased=0 时画面上还挂着一个亮点）
  vis *= Math.min(1, ease0 * 2.2);

  sunUniforms.uAlpha.value = vis;
  /* 晕被上缘逼窄时补一点亮度，收成"紧光"也还是看得出那一圈暖 */
  const clipAmt = naturalHalo > 1e-6 ? 1 - haloAng / naturalHalo : 0;
  haloUniforms.uAlpha.value = vis * (0.20 + 0.30 * sunUp) * (1 + 0.85 * clipAmt);

    const flatLen = Math.sqrt(sunDir.x * sunDir.x + sunDir.z * sunDir.z) || 1;
    const flatX = sunDir.x / flatLen;
    const flatZ = sunDir.z / flatLen;
    // eased < 0.2 时云几乎不可见，之后逐渐显现成薄薄的金色长云
    let reveal = (ease0 - 0.18) / 0.5;
    reveal = reveal < 0 ? 0 : reveal > 1 ? 1 : reveal;
    reveal = reveal * reveal * (3 - 2 * reveal);

    // 漂移：view.motion = 0 时几乎不动（保留 6% 的极慢漂移，画面不会完全死掉）
    const driftScale = 0.06 + 0.94 * motion;

    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      const L = c.layer;
      const uni = c.uni;

      uni.uOpacity.value = L.opacity * reveal * (0.55 + 0.45 * ease0) * (1 - 0.65 * DAY_RAMP(day));
      uni.uDrift.value = time * driftScale * L.drift * 6.0;
      uni.uSunFlat.value.set(flatX, flatZ);
      uni.uContrast.value = 0.85 + 0.35 * ease0;

      /* 受光面随日出变暖（朝向 #ffb07a），背光面保持冷蓝（朝向 #2c3350）。
       * 两端的绝对亮度都刻意压得很低：云只是"雾里的明暗层次"，不能比天空更抢眼。 */
      const warm = 0.10 + 0.90 * ease0;
      uni.uLit.value.setRGB(
        0.020 + 0.98 * warm,
        0.026 + 0.66 * warm,
        0.040 + 0.44 * warm,
        THREE.LinearSRGBColorSpace
      );
      /* 云的暗面曾经压在 0.30~0.42：天一亮它就是天上一坨灰黑涂抹。
       * 真实晨云背光面是被天光照亮的灰白，只比受光面冷一点、暗一档。 */
      uni.uShade.value.setRGB(
        0.010 + 0.66 * warm,
        0.013 + 0.62 * warm,
        0.021 + 0.66 * warm,
        THREE.LinearSRGBColorSpace
      );

      // 云的"基准高度"跟随相机，保证无论如何相机多高，云都在视线以上
      c.mesh.position.set(root.position.x, root.position.y + L.y - 7.0, root.position.z + L.z);
    }

    /* ---- 星空 ---- */
    starUniforms.uTime.value = time;
    starUniforms.uPixelRatio.value = pix;
    // 0.42 之前完全淡出
    let sf = 1 - ease0 / 0.42;
    sf = sf < 0 ? 0 : sf;
    starUniforms.uFade.value = sf * sf;

    if (debug && !reported) {
      reported = true;
      console.info('[sky] quality=' + quality + ' clouds=' + clouds.length + ' stars=' + STAR_COUNT);
    }
  }
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    domeGeo.dispose();
    domeMat.dispose();
    sunGeo.dispose();
    sunMat.dispose();
    haloGeo.dispose();
    haloMat.dispose();
    cloudPlaneGeo.dispose();
    for (let i = 0; i < clouds.length; i++) clouds[i].mat.dispose();
    cloudTex.dispose();
    starGeo.dispose();
    starMat.dispose();
    if (root.parent) root.parent.remove(root);
  }

  return { object3D: root, tick, dispose };
}