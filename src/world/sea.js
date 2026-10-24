/**
 * 心光 · 海面
 * ------------------------------------------------------------------
 * 负责：海面几何（近密远疏的梯形铺展）、顶点位移波浪、太阳镜面光路、
 *       菲涅尔 + 解析天空反射、指数雾、近岸白沫。
 *
 * 设计要点
 * 1) 几何：从 z=-13 铺到 z=-INF_Z（比可见范围更远，避免出现一个"硬边"）。
 *    行距按等比增长，16m 以内约 0.16m 一行，往外逐渐变粗；列距全局等距、
 *    左右各一圈外扩环把网格拉到 ±2800。高画质约 6.5 万三角形。
 *    顶点密度随距离正好贴合屏幕投影密度，所以远处不出锯齿。
 * 2) 波浪：5 层 Gerstner 在顶点着色器里做（18~60m 长波，深水色散），
 *    位移在 40m -> 210m 内线性归零、280m 外完全不位移，所以地平线是
 *    一条绝对平滑的直线，不会抖成锯齿。近岸（z≈-16）位移也收敛到 0。
 * 3) 着色：菲涅尔驱动的解析天空反射 + 两级太阳高光（宽光路 + 极锐碎闪），
 *    碎闪来自片元里的值噪声，不需要任何贴图。
 * 4) 太阳光路：用"太阳镜像点"几何法 —— 每个片元求出唯一能满足镜面反射的
 *    水面点 mx，把镜面法线残差 e=(mx-x)/depth 塞进一个窄高斯；光路宽度随
 *    距离变宽、越远越亮，地平线附近过曝成暖白色；再叠一层"沿 x 抖动"的
 *    一维噪声让它碎成万千光斑。
 */

import * as THREE from 'three';
import { clamp } from '../util/noise.js';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 几何近端（沙滩外侧一点） */
const NEAR_Z = -13;
/** 几何远端：比可见距离更远，保证没有"硬边" */
const INF_Z = 9000;
/** 超过它直接丢弃片元（省掉大量无效像素） */
const CULL_Z = 1700;
/** 行方向的循环拆分：只在 40m 以内（顶点波浪满幅的地方）跑完整 5 层 Gerstner */
const WAVE_NEAR = 60;

/** 远景：超过它直接丢弃片元（省掉大量无效像素，几何也只是个空壳） */
const FAR_VISIBLE = 1400;

/** 顶点位移淡出：40m 内满幅，210m 归零，280m 外完全不位移 */
const WAVE_FADE0 = 40;
const WAVE_FADE1 = 210;

/** 近岸：z 在 [-16, -5] 之间位移从 0 坡升到 1，与沙滩(y≈0.15)无缝衔接 */
const SHORE_Z = -16;
const SHORE_FADE = 11;

/* ------------------------------------------------------------------ *
 * 调色板（十六进制按 sRGB 写，THREE.Color 自动转线性）
 * ------------------------------------------------------------------ */

const PAL = {
  deepNight: new THREE.Color(0x050a14),
  deepDawn: new THREE.Color(0x16233c),
  deepSun: new THREE.Color(0x14304c),
  horizNight: new THREE.Color(0x101b33),
  horizDawn: new THREE.Color(0x3b3a54),
  horizSun: new THREE.Color(0xb9cbda),
  zenNight: new THREE.Color(0x060a16),
  zenDawn: new THREE.Color(0x1b2a4a),
  zenSun: new THREE.Color(0x5d84ae),
  sunLow: new THREE.Color(0xff9d5c),
  sunHigh: new THREE.Color(0xffe6c2),
  night: new THREE.Color(0x0a1424)
};

/** 默认太阳方向（eased=1.0，仰角 0.26）与默认相机位置 */
PAL.sunDir0 = new THREE.Vector3(Math.sin(0.06) * Math.cos(0.26), Math.sin(0.26), -Math.cos(0.06) * Math.cos(0.26)).normalize();
PAL.cam0 = new THREE.PerspectiveCamera(46, 16 / 9, 0.5, 30000);
PAL.cam0.position.set(0, 7.2, 0);
PAL.cam0.lookAt(0, -2.3, -100);
PAL.cam0.updateMatrixWorld();

/** 三个关键点（夜 / 黎明 / 日出）之间的两段线性插值 */
function ramp3(out, a, b, c, t) {
  if (t <= 0.5) return out.copy(a).lerp(b, t * 2);
  return out.copy(b).lerp(c, (t - 0.5) * 2);
}

/* ------------------------------------------------------------------ *
 * 几何：近密远疏的梯形海面
 * ------------------------------------------------------------------ */

/** 三角形预算：高画质约 6 万，低画质约 1.5 万 */
const GEOM = {
  high: { growth: 1.16, maxSpacing: 24, colStep: 9, halfX: 1200, rows: 92, cols: 100 },
  low: { growth: 1.20, maxSpacing: 70, colStep: 34, halfX: 1200, rows: 46, cols: 64 }
};

/** 近岸行距：贴着沙滩密一点，才撑得住顶点波浪和浪花带 */
const NEAR_SPACING = 0.9;

/**
 * 生成海面网格（单行索引带）。
 *
 * 布局：
 *  · 行（沿 Z）：从 NEAR_Z 排到 -INF_Z 再往回走到 2m，行距按 growth 等比增长，
 *    只用一个索引带（不做镜像 wrap），所以围栏绕序永远一致、不会出现"大三角"。
 *  · 列（沿 X）：中间为负、两侧为正，正中一条列在 x=0（保证光路中心对称），
 *    列距随 |x| 等比增长，最后两列直接拉到 ±HALF_X（远景外包）。
 *  · x 方向永远是一个横跨全宽的三角形，所以不会出现"竖条"或纵向接缝。
 *
 * 顶点密度跟着屏幕投影走，远处三角形自然拉大；远景靠片元丢弃 + 雾收掉。
 */
function buildSeaGeometry(isLow) {
  const cfg = isLow ? GEOM.low : GEOM.high;

  // ---- 行：去程 NEAR_Z -> -INF_Z，回程到 2m（保证海面在相机两侧都铺满） ----
  const rows = [];
  let s = NEAR_SPACING;
  if (isLow) s = NEAR_SPACING * 2;
  for (let z = NEAR_Z; z > -INF_Z; z -= s) { rows.push(z); s = Math.min(cfg.maxSpacing, s * cfg.growth); }
  s = Math.min(cfg.maxSpacing, s * 0.35);
  for (let z = -INF_Z + s; z <= 2; z += s) { rows.push(z); s = Math.min(cfg.maxSpacing, s * cfg.growth); }
  while (rows.length > cfg.rows) rows.splice(1 + Math.floor((rows.length - 1) * 0.78), 1);

  // ---- 列：x=0 为中心，向两侧等比展开 ----
  const xs = [0];
  let cs = cfg.colStep * 0.45;
  while (xs[xs.length - 1] < cfg.halfX) { xs.push(xs[xs.length - 1] + cs); cs = Math.min(cfg.colStep * 3.2, cs * cfg.growth); }
  while (xs.length > cfg.cols / 2) xs.splice(1 + Math.floor((xs.length - 1) * 0.8), 1);
  const colX = [];
  for (let k = xs.length - 1; k >= 1; k--) colX.push(-xs[k]);
  for (let k = 0; k < xs.length; k++) colX.push(xs[k]);

  // ---- 顶点 ----
  const rowCount = rows.length;
  const colCount = colX.length;
  const vCount = rowCount * colCount;
  const pos = new Float32Array(vCount * 3);
  const base = new Float32Array(vCount * 3); // (x, z, 顶点波浪权重)
  const nrm = new Float32Array(vCount * 3);

  let v = 0;
  for (let i = 0; i < rowCount; i++) {
    const zz = rows[i];
    const az = Math.abs(zz);
    let w = 0;
    if (az <= WAVE_FADE0) w = 1;
    else if (az < WAVE_FADE1) w = 1 - (az - WAVE_FADE0) / (WAVE_FADE1 - WAVE_FADE0);
    // 近岸收敛：z 在 [-16, -5] 之间再乘一个 0 -> 1 的斜坡
    if (zz > SHORE_Z) w *= Math.min(1, (zz - SHORE_Z) / SHORE_FADE);
    for (let j = 0; j < colCount; j++) {
      const x = colX[j];
      pos[v * 3] = x;
      pos[v * 3 + 1] = 0;
      pos[v * 3 + 2] = zz;
      base[v * 3] = x;
      base[v * 3 + 1] = zz;
      base[v * 3 + 2] = w;
      nrm[v * 3 + 1] = 1;
      v++;
    }
  }

  // ---- 索引：行 i 更靠近相机（z 更大），顺时针从 +y 看朝上 ----
  const maxIdx = (rowCount - 1) * (colCount - 1) * 6;
  const indices = new Uint16Array(maxIdx);
  let t = 0;
  for (let i = 0; i < rowCount - 1; i++) {
    const r0 = i * colCount;
    const r1 = (i + 1) * colCount;
    for (let j = 0; j < colCount - 1; j++) {
      const a = r0 + j, b = r0 + j + 1, c = r1 + j, d = r1 + j + 1;
      indices[t++] = a; indices[t++] = b; indices[t++] = c;
      indices[t++] = b; indices[t++] = d; indices[t++] = c;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('aBase', new THREE.BufferAttribute(base, 3));
  geo.setIndex(new THREE.BufferAttribute(indices.subarray(0, t), 1));
  // 顶点位移不超过 ±0.4m，手工给一个保守包围体，避免每帧重算
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -INF_Z * 0.5), INF_Z * 1.3);
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(-cfg.halfX, -2, -INF_Z - 4),
    new THREE.Vector3(cfg.halfX, 2, 3)
  );

  return { geo, triangles: (t / 3) | 0, vertices: vCount };
}

/* ------------------------------------------------------------------ *
 * GLSL
 * ------------------------------------------------------------------ */

const VERT = /* glsl */`
attribute vec3 aBase;          // x, z, 位移权重 (近 1 -> 远 0)
uniform vec3 uCamPos;
uniform float uTime;
uniform float uMotion;
varying vec2 vBaseXZ;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying float vCrest;
varying float vFar;

void main() {
  vec2 bXZ = aBase.xy;
  float bW = aBase.z;

  vBaseXZ = bXZ;
  vFar = clamp(-bXZ.y / 700.0, 0.0, 1.0);

  vec3 wDisp = vec3(0.0);
  vec3 wNrm = vec3(0.0, 1.0, 0.0);
  float wCrest = 0.0;
  if (bW > 0.002) {
    // 顶点只跑一层低频涌浪（轮廓够用、地平线也稳）；高频细节全交给片元法线。
    float lambda = 46.0;
    vec2 d0 = normalize(vec2(0.22, -1.0));
    float k = 6.28318530718 / lambda;
    float om = sqrt(9.81 * k);
    float f = k * dot(d0, bXZ) - om * uTime;
    float a = 0.20;
    wDisp.y = a * sin(f) * bW * uMotion;
    wDisp.x = d0.x * a * cos(f) * 0.55 * bW * uMotion;
    wDisp.z = d0.y * a * cos(f) * 0.55 * bW * uMotion;
    wNrm = normalize(vec3(-d0.x * k * a * cos(f) * bW, 1.0, -d0.y * k * a * cos(f) * bW));
    wCrest = sin(f) * bW * uMotion;
  }

  vec3 transformed = position + wDisp;
  vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vNormalW = wNrm;
  vCrest = wCrest;

  // 顶点在相机一侧的海面推到远裁剪面之外，避免近裁剪面切出空洞；
  // 该片元会被片元着色器里的逐像素地平线测试丢掉，不会花屏。
  vec3 rel = vWorldPos - uCamPos;
  if (rel.z > 0.5) {
    vWorldPos = uCamPos + normalize(rel + vec3(0.0, 0.0, 1e-4)) * 60000.0;
  }

  gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
}
`;

const FRAG = /* glsl */`
uniform float uTime;
uniform float uMotion;
uniform vec3 uSunDir;
uniform float uSunElevation;
uniform float uEased;           // 0..1，第一阶段"天亮"进度
uniform float uDay;             // 0..1，天亮之后的白天进度（水面逐渐更透更冷）
uniform float uFade;            // 1 - eased^3：夜里全局压暗
uniform vec3 uHorizonColor;
uniform vec3 uZenithColor;
uniform vec3 uSunColor;
uniform float uDebug;
uniform vec3 uSkyNight;
uniform vec3 uDeepColor;
uniform vec2 uResolution;
uniform float uPixelRatio;
uniform vec2 uHorizonY;        // 地平线在 NDC 的 y（极远处的地面投影）
uniform float uTanHalf;        // tan(fov/2)
uniform vec3 uCamPos;

varying vec2 vBaseXZ;
varying vec3 vWorldPos;
varying vec3 vNormalW;
varying float vCrest;
varying float vFar;

// ---------- 哈希与值噪声（全程不用贴图） ----------
vec2 sHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float sNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = dot(sHash22(i) * 2.0 - 1.0, f);
  float b = dot(sHash22(i + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(sHash22(i + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(sHash22(i + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float sFbm3(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * sNoise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return s;
}

// 解析天空近似：地平线暖色 -> 天顶冷色。
// 水面反射向下的方向会落到地平线基线之下，这里必须夹住——否则会把地平线以下的
// 暖色当成天空色，整片海变成米色。
vec3 seaSky(vec3 d) {
  float h = clamp(d.y * 1.55 + 0.02, 0.0, 1.0);
  vec3 c = mix(uHorizonColor, uZenithColor, pow(h, 0.36));
  /* 斜掠角反射到的是紧贴地平线的那层天空，被 haze 染得偏白；往冷蓝推一点，
   * 否则整片近海会变成一块苍白的陆架。只在离地平线有余量处生效。 */
  c = mix(c, uZenithColor * 0.92, 0.26 * smoothstep(0.02, 0.26, h));
  return mix(c, uSkyNight * 0.7, uFade * 0.75);
}

void main() {
  // ---------- 逐像素地平面：海面本身就是一整块"无限远"的地平面 ----------
  // 做法：海面几何是一个盖住整个相机的半球壳（几何足够光滑，线性插值即可），
  // 片元里用屏幕坐标 + 相机高度反算这条视线打在 y=0 平面上的真实交点。
  // 好处：地平线是数学上精确的一条水平线；近处（含相机脚下）都能被正确着色；
  // 远处海面被压在几个像素里也不会产生横向脏条；而且不需要改变画幅。
  vec2 ndc = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
  if (ndc.y < uHorizonY.x) discard;

  vec3 rel0 = vWorldPos - uCamPos;
  float relLen = length(rel0);
  vec3 V = rel0 / max(relLen, 1e-4);
  float dvx = (uResolution.x / uResolution.y) * uTanHalf * ndc.x;
  float dvy = uTanHalf * ndc.y;
  vec3 dir = normalize(vec3(dvx, dvy, -1.0));
  /* viewMatrix 是"世界→视图"，把视图空间的射线转回世界要用它的转置（旋转矩阵的逆）。
   * 直接乘会把俯角加反，地平线被算到画面下方约 110px 处 → 那一带全变成"深度饱和的均匀灰板"。 */
  {
    mat3 vm = mat3(viewMatrix);
    mat3 v2w = mat3(vm[0][0], vm[1][0], vm[2][0],
                    vm[0][1], vm[1][1], vm[2][1],
                    vm[0][2], vm[1][2], vm[2][2]);
    dir = normalize(v2w * dir);
  }
  float depth = uCamPos.y / max(-dir.y, 1e-5);
  depth = min(depth, 600000.0);
  vec3 surf = uCamPos + dir * depth;
  vec3 wp = surf;
  vec3 vd = wp - uCamPos;
  float dist = length(vd);
  V = vd / max(dist, 1e-3);
  float sunUp = clamp(uSunDir.y / 0.30, 0.0, 1.0);
  float distXZ = length(vd.xz);
  float far01 = smoothstep(900.0, 3000.0, distXZ);
  float pixWorld = (2.0 * dist) / (uResolution.y * uPixelRatio);
  float lowZ = clamp(-surf.z, 0.0, 4000.0);
  float nearBoost = 1.0 - smoothstep(20.0, 320.0, lowZ);
  float nearW = 1.0 - smoothstep(140.0, 1000.0, dist);
  float nearW2 = 1.0 - smoothstep(70.0, 520.0, dist);
  float flatFar = smoothstep(1500.0, 2500.0, dist);
  float t = uTime * uMotion;

  // ===================== 法线 =====================
  vec3 n = normalize(vNormalW);
  vec2 g = vec2(0.0);
  float amp = nearW;

  if (amp > 0.003) {
    // 中尺度涌浪（只改法线）：让光路在近处自然弯折
    {
      float lambda = 78.0;
      float vis = 1.0 - smoothstep(lambda / 9.0, lambda / 3.0, pixWorld);
      vec2 d1 = normalize(vec2(0.12, -1.0));
      float k = 6.2831853 / lambda;
      float ph = k * dot(wp.xz, d1) - t * 0.52;
      g += d1 * (cos(ph) * k * 0.115) * vis;
    }
    {
      float lambda = 37.0;
      float vis = 1.0 - smoothstep(lambda / 9.0, lambda / 3.0, pixWorld);
      vec2 d2 = normalize(vec2(-0.34, -1.0));
      float k = 6.2831853 / lambda;
      float ph = k * dot(wp.xz, d2) - t * 0.76 + 1.7;
      g += d2 * (cos(ph) * k * 0.058) * vis;
    }
  }

  // 高频碎波：三层，按像素足迹做 LOD（省掉看不见的倍频）
  if (amp > 0.003) {
    vec2 q = wp.xz;
    float w1 = 1.0 - smoothstep(0.55, 1.60, pixWorld);
    float w2 = (1.0 - smoothstep(0.26, 0.85, pixWorld)) * nearW2;
    float w3 = (1.0 - smoothstep(0.10, 0.40, pixWorld)) * nearW2;
    if (w1 > 0.002) {
      vec2 pp = q * 0.075 + vec2(t * 0.06, -t * 0.10);
      g += vec2((sFbm3(pp + vec2(0.7, 0.0)) - sFbm3(pp)) / 0.7) * 0.34 * w1;
    }
    if (w2 > 0.002) {
      vec2 pp = q * 0.42 + vec2(-t * 0.16, -t * 0.06) + sNoise(q * 0.05) * 3.0;
      g += vec2((sNoise(pp + vec2(0.7, 0.0)) - sNoise(pp)) / 0.7) * 0.30 * w2;
    }
    if (w3 > 0.002) {
      vec2 pp = q * 1.9 + vec2(t * 0.40, -t * 0.24);
      g += vec2((sNoise(pp + vec2(0.7, 0.0)) - sNoise(pp)) / 0.7) * 0.20 * w3 * nearBoost;
    }
    // 顺风各向异性：波纹被"吹长"，横向更密
    g *= vec2(1.0, 0.55) * amp;
  }

  n = normalize(n + vec3(-g.x, 0.0, -g.y));
  float ripple = clamp(length(g) * 1.6, 0.0, 1.0);
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), flatFar));

  /* V 是"相机 → 水面"的方向（朝下），掠射角要的是"水面 → 相机"，
   * 符号反了会把 dot 夹成 0、菲涅尔永远等于 1 —— 整片海就成了一张反射天空的浅色塑料板。 */
  float NdV = clamp(dot(n, -V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - NdV, 4.2);
  vec3 R = reflect(-V, n);
  R.y = max(R.y, 0.0);

  // ===================== 水体色 =====================
  // 深水：低饱和的青蓝，永远比天空暗一档；反射色只取天空地平线以上的部分。
  /* day 项：天亮之后水体的散射一点点变强、偏冷偏透，水面不会在 60 帧后冻住。
   * 只动"颜色"，不动 CSP / artWidth / 光路几何 —— 那些是上一轮刚校准过的。 */
  float dayMix = clamp(uDay, 0.0, 1.0);
  vec3 body = uDeepColor * (1.20 + 0.16 * dayMix) + vec3(0.006, 0.016, 0.030) * (0.35 + 0.65 * uEased) * (1.0 + 0.9 * dayMix);
  float scat = pow(clamp(dot(V, -uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  body += uSunColor * scat * 0.018 * (0.2 + 0.8 * uEased);
  body *= 0.88 + 0.12 * ripple;

  vec3 skyRefl = seaSky(vec3(R.x, max(R.y, 0.0) + 0.01, R.z));
  // 白天：天光更强，反射里蓝通道再托一点点底（这是"更透"的来源）
  /* 天空反射要做三件事，否则整片海会被黎明的暖地平线染成沙黄色：
   *   1) 先去一点饱和（真实水面反射天光不会那么艳）；
   *   2) 蓝通道托底 —— 反射色再暖，海也必须是"蓝的"；
   *   3) 再往深水色里拉一点，让海比天空暗一档、青一档。 */
  float rl = dot(skyRefl, vec3(0.2126, 0.7152, 0.0722));
  skyRefl = mix(skyRefl, vec3(rl), 0.12);
  skyRefl.b = max(skyRefl.b, rl * 0.95);
  skyRefl = mix(skyRefl, uDeepColor * 1.75, 0.26 - 0.08 * dayMix);
  vec3 col = mix(body, skyRefl * 0.62, clamp(fres * 0.86, 0.0, 1.0));
  col *= 0.92 + 0.08 * ripple;
  // ===================== 太阳高光（碎闪） =====================
  // 锐利高光：太阳本身就是个点光源，pow 越高越像真水面。
  float specPow = mix(300.0, 900.0, uEased) * (1.0 + 0.35 * dayMix);
  float RdotS = max(dot(R, uSunDir), 0.0);
  float sunUpMask = smoothstep(-0.02, 0.08, sunUp + 0.06);
  float specSharp = pow(RdotS, specPow) * 52.0;
  float specWide = pow(RdotS, 60.0) * 0.18;
  // 只有"能看见的高频法线"才允许出闪点：远到像素装不下的地方本来就没有波光。
  float sparkVis = 1.0 - smoothstep(0.30, 1.10, pixWorld);
  float micro = sNoise(wp.xz * 2.7 + vec2(t * 0.9, -t * 1.3)) * 0.5 + 0.5;
  float gate = sNoise(wp.xz * 0.7 - vec2(t * 0.33, t * 0.55)) * 0.5 + 0.5;
  float sparkGate = mix(1.0, 0.30 + 1.75 * smoothstep(0.25, 0.80, gate) * (0.30 + 1.25 * micro), sparkVis);
  float spec = (specSharp + specWide) * sparkGate;
  col += uSunColor * spec * (0.10 + 0.90 * uEased) * sunUpMask;
  // ===================== 太阳光路（画面灵魂） =====================
  /* 残差改成"方位角差（弧度）"而不是旧的镜面横向偏移比。
   * 原因：旧公式里 e=0 的中线恒定落在 x = uCamPos.x（画面正中央），
   * 太阳明明偏右（SUN_AZIMUTH=0.06），光路却贴着画面中线 —— 这就是"太阳和反光对不上"。
   * 现在直接把"水面点相对相机的方位角"与"太阳方位角"相减，
   * e=0 的中线在任意距离都精确对齐太阳的屏幕横坐标。 */
  float azSun = atan(uSunDir.x, -uSunDir.z);            // 太阳方位角（与 uSunDir 同一约定）
  float azSurf = atan(wp.x - uCamPos.x, max(-(wp.z - uCamPos.z), 1e-3));  // 水面点方位角
  float e = azSurf - azSun;                    // 方位残差（弧度，0 = 正对太阳）
  float eLim = max(0.0020, pixWorld / max(depth, 1.0));    // 单像素对应的最小残差，用来抗走样

  /* 光路宽度（单位：弧度，≈ 屏幕横向 0.00235 rad/px）：
   * 近处约 0.055 rad（≈23px，一根有质感的亮带），
   * 远处被波面斜率筛开到 0.10 rad（≈42px，在地平线前糊成一片暖白）。 */
  float artWidth = mix(0.070, 0.130, smoothstep(20.0, 1200.0, lowZ));
  float hh = e / (artWidth + eLim * 1.6);
  float artMask = exp(-hh * hh);
  // 侧翼：给光路一点柔和的外晕，但不能拉宽成柱子
  /* 外晕必须窄：高斯等效宽度过大时会把整片海染成暖黄（上一版的大坑） */
  float artHalo = exp(-hh * hh * 0.85) * 0.14;

  // 越远越靠近太阳镜像处，能量越集中 -> 地平线附近过曝成暖白
  float artFar = smoothstep(60.0, 1500.0, lowZ);
  vec3 artCol = mix(uSunColor, vec3(1.55, 1.10, 0.70), 0.40);
  artCol = mix(artCol, vec3(1.95, 1.52, 1.02), artFar);
  // 光路只属于"中远距离"的水面：镜头脚下那一片不该有一大团暖光
  float artNear = smoothstep(18.0, 130.0, lowZ);
  float artLevel = smoothstep(-0.03, 0.10, sunUp + 0.09);
  // 掠射角本来就是镜面 -> 光路不受菲涅尔压制
  float artFres = clamp(fres * 0.35 + 0.72, 0.0, 1.0);
  float artEnergy = (0.10 + 0.90 * uEased) * artLevel * artFres;
  col += artCol * (artMask * (0.30 + 0.62 * artFar) + artHalo * (0.30 + 0.55 * artFar)) * artEnergy * 0.72 * artNear;

  // 碎钻：沿光路中线的一维噪声，越近越碎、越远越糊成一条亮带
  {
    float lane = e * depth;                    // 到光路中线的横向距离(米)
    float zz = -wp.z;
    float n1 = sNoise(vec2(lane * 0.9, zz * 0.26 - t * 0.48));
    float n2 = sNoise(vec2(lane * 2.5 + 13.7, zz * 0.80 - t * 0.86));
    float n3 = sNoise(vec2(lane * 6.1 - 5.3, zz * 2.30 - t * 1.35));
    float sp = n1 * 0.52 + n2 * 0.33 + n3 * 0.24;
    float facet = smoothstep(0.06, 0.62, sp);
    float sparkFade = 1.0 - smoothstep(0.30, 1.20, pixWorld);
    float dens = 0.45 + 0.75 * smoothstep(25.0, 700.0, zz);
    col += artCol * (artMask * 0.62 + artHalo * 0.35) * facet * dens * sparkFade * artEnergy * artNear;
  }
  // ===================== 近岸白沫 =====================
#ifndef SEA_LOW
  {
    /* 相机是"在水面上朝外看"，正前方（x≈0）没有岸 —— 白沫只能出现在左右两侧的岸线附近，
     * 之前只按 z 距离判断，结果整个画幅底部被糊成一条奶白带。 */
    float lateral = smoothstep(12.0, 30.0, abs(wp.x - uCamPos.x));
    float shore = (1.0 - smoothstep(10.0, 64.0, lowZ)) * lateral;
    float edge = 1.0 - smoothstep(500.0, 1400.0, abs(wp.x - uCamPos.x));
    if (shore * edge > 0.002) {
      float adv = lowZ * 0.13 + t * 0.48 + sFbm3(wp.xz * 0.09) * 2.6;
      float band = smoothstep(0.30, 0.95, sin(adv) * 0.5 + 0.5);
      float grain = sNoise(wp.xz * 1.6 + vec2(t * 0.22, -t * 0.14)) * 0.5 + 0.5;
      float foam = band * smoothstep(0.42, 0.90, grain) * shore * edge;
      foam *= 1.0 - smoothstep(0.10, 0.50, pixWorld);
      vec3 foamCol = mix(uHorizonColor * 0.90, vec3(0.80, 0.86, 0.92), 0.40) * (0.32 + 0.72 * uEased) * (1.0 + 0.10 * dayMix);
      col = mix(col, foamCol, clamp(foam, 0.0, 1.0) * 0.35);
    }
  }
#endif

  // ===================== 雾：与天空地平线无缝衔接 =====================
  /* 只用"视线倾角"决定雾量：drop=0 就是正对地平线。
   * 之前用的是反算出的距离（1-exp(-distXZ*k) + 一个 smoothstep 硬饱和），
   * 远处数值退化后整块海会被压成一片均匀的浅灰板，还在 y≈278 留一条硬边。
   * 倾角公式没有数值退化，地平线附近注定全雾、视线压下去就逐渐清透。 */
  float drop = clamp(-dir.y, 0.0, 1.0);
  /* 雾带必须夹在真正的"地平线附近"（几个角分到 3° 之内）。范围一宽，中景整片海就被
   * 压成一块中性浅灰板 —— 那是"液态金属"感的来源。 */
  float fogAmt = mix(0.90, 0.0, smoothstep(0.001, 0.036, drop));
  fogAmt = max(fogAmt, 0.04 * (1.0 - smoothstep(0.03, 0.30, drop)));

  float lean = 1.0 - smoothstep(0.02, 0.30, drop);      // 远处海面本身就更接近地平线色
  vec3 fogBase = mix(uHorizonColor, seaSky(normalize(vec3(V.x, 0.025, V.z))), 0.32 * lean);
  float sunWarm = smoothstep(0.55, 0.995,
    max(dot(normalize(vec3(V.x, 0.0, V.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0));
  /* 雾色绝不能被 uSunColor 大量拉成米黄：那一层正好贴着地平线横贯全屏，
   * 一暖就是一整条"苍白陆架"。只在太阳正下方留一点点金色。 */
  vec3 fogCol = mix(fogBase, uSunColor * 1.05, sunWarm * (0.05 + 0.12 * uEased));

  col = mix(col, fogCol, clamp(fogAmt, 0.0, 1.0));

  if (uDebug > 0.5) {
    // R: dir.y 编码在 0.5 附近（>0.5 表示视线朝上）；G: ndc.y 编码；B: uCamPos.y/20
    gl_FragColor = vec4(clamp(dir.y * 4.0 + 0.5, 0.0, 1.0), clamp(ndc.y * 0.5 + 0.5, 0.0, 1.0), clamp(uCamPos.y / 20.0, 0.0, 1.0), 1.0);
    return;
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;

/* ------------------------------------------------------------------ *
 * 工厂
 * ------------------------------------------------------------------ */

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {{quality?: 'high'|'low'}} opts
 * @returns {{ object3D: THREE.Object3D, tick: Function, dispose: Function }}
 */
export function createSea(renderer, opts = {}) {
  const isLow = opts.quality === 'low';
  const { geo, triangles, vertices } = buildSeaGeometry(isLow);

  let resW = 1920;
  let resH = 1080;
  if (renderer && renderer.getSize) {
    renderer.getSize(tmpSize);
    if (tmpSize.x > 0 && tmpSize.y > 0) { resW = tmpSize.x; resH = tmpSize.y; }
  }
  const dpr = renderer && renderer.getPixelRatio ? renderer.getPixelRatio() : 1;

  const uniforms = {
    uTime: { value: 0 },
  uDebug: { value: 0 },
    uMotion: { value: 1 },
    uSunDir: { value: new THREE.Vector3(0, 0.085, -1).normalize() },
    uSunElevation: { value: 0.085 },
    uEased: { value: 1 },
  uDay: { value: 0 },
    uFade: { value: 0 },
    uHorizonColor: { value: PAL.horizSun.clone() },
    uZenithColor: { value: PAL.zenSun.clone() },
    uSunColor: { value: PAL.sunHigh.clone() },
    uSkyNight: { value: PAL.horizNight.clone() },
    uDeepColor: { value: PAL.deepSun.clone() },
    uResolution: { value: new THREE.Vector2(resW, resH) },
    uPixelRatio: { value: dpr },
    uHorizonY: { value: new THREE.Vector2(0, 0) },
    uTanHalf: { value: Math.tan(THREE.MathUtils.degToRad(23)) },
    uCamPos: { value: new THREE.Vector3(0, 7.2, 0) }
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.FrontSide,
    fog: false
  });
  if (isLow) material.defines = { SEA_LOW: '' };
  material.customProgramCacheKey = () => (isLow ? 'xinguang-sea-low-v1' : 'xinguang-sea-high-v1');

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'sea';
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.frustumCulled = false;

  const object3D = new THREE.Group();
  object3D.name = 'sea-root';
  object3D.add(mesh);

  // 模块内临时量（tick 里不分配）
  const cHoriz = new THREE.Color();
  const cSun = new THREE.Color();
  const tmpCam = new THREE.PerspectiveCamera();
  const tmpFwd = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();

  /** 每帧：把视图状态写进 uniform（颜色跟随 eased，太阳方向跟随视图） */
  const tick = (view, dt) => {
    if (!view) return;
    const eased = view.eased === undefined ? 1 : view.eased;
    const motion = view.motion === undefined ? 1 : view.motion;

    uniforms.uEased.value = eased;
    uniforms.uDay.value = clamp(view.day === undefined ? 0 : view.day, 0, 1);
    uniforms.uFade.value = 1 - eased * eased * eased;
    uniforms.uMotion.value = motion;
    uniforms.uTime.value = (view.time || 0);

    // 夜 -> 黎明 -> 日出
    ramp3(uniforms.uDeepColor.value, PAL.deepNight, PAL.deepDawn, PAL.deepSun, eased);
    ramp3(cHoriz, PAL.horizNight, PAL.horizDawn, PAL.horizSun, eased);
    uniforms.uHorizonColor.value.copy(cHoriz);
    ramp3(uniforms.uZenithColor.value, PAL.zenNight, PAL.zenDawn, PAL.zenSun, eased);
    uniforms.uSkyNight.value.copy(PAL.night);
    cSun.copy(PAL.sunLow).lerp(PAL.sunHigh, Math.min(1, Math.max(0, (eased - 0.25) * 1.6)));
    uniforms.uSunColor.value.copy(cSun);

    if (view.sunWorldDir && view.sunWorldDir.isVector3) {
      uniforms.uSunDir.value.copy(view.sunWorldDir).normalize();
    } else if (view.sunElevation !== undefined) {
      const az = view.sunAzimuth === undefined ? 0.06 : view.sunAzimuth;
      const ce = Math.cos(view.sunElevation);
      tmpDir.set(Math.sin(az) * ce, Math.sin(view.sunElevation), -Math.cos(az) * ce).normalize();
      uniforms.uSunDir.value.copy(tmpDir);
    } else {
      uniforms.uSunDir.value.copy(PAL.sunDir0);
    }
    uniforms.uSunElevation.value = Math.asin(Math.min(1, Math.max(-1, uniforms.uSunDir.value.y)));

    if (view.resolution && view.resolution.width > 0) {
      uniforms.uResolution.value.set(view.resolution.width, view.resolution.height);
      if (view.resolution.pixelRatio) uniforms.uPixelRatio.value = view.resolution.pixelRatio;
    }
    if (view.camera) {
      uniforms.uCamPos.value.copy(view.camera.position);
      tmpCam.copy(view.camera);
    } else {
      uniforms.uCamPos.value.copy(PAL.cam0.position);
      tmpCam.copy(PAL.cam0);
    }
    tmpCam.updateMatrixWorld();

    // 地平线在屏幕上的位置（0=画面顶端，1=画面底端）：全屏化之后用它做逐像素过滤，
    // 让地平线成为一条数学上干净的水平线。
    tmpFwd.set(0, 0, -1).applyQuaternion(tmpCam.quaternion);
    const fov = tmpCam.isPerspectiveCamera ? tmpCam.fov : 46;
    const half = THREE.MathUtils.degToRad(fov) * 0.5;
    const ch = Math.cos(half);
    const sh = Math.sin(half);
    const lY = -tmpCam.position.y;
    const lZ = -tmpFwd.z;
    uniforms.uHorizonY.value.set((sh * lY) / (ch * lZ), 0);
    uniforms.uTanHalf.value = Math.tan(half);
    void dt;
  };
  /** 释放几何与材质 */
  const dispose = () => {
    object3D.remove(mesh);
    geo.dispose();
    material.dispose();
  };

  // 首帧默认状态：太阳已升起（避免未 tick 时一片黑）
  tick({ eased: 1, time: 0, motion: 1, sunElevation: 0.085, sunAzimuth: 0.06 });

  return { object3D, tick, dispose, mesh, material, triangles, vertices };
}

const tmpSize = new THREE.Vector2();
