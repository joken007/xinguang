import * as THREE from 'three';

/**
 * 心光 · 后期合成
 * ---------------------------------------------------------------------------
 * 链路：场景 → HalfFloat RT（线性光）→ 亮部提取(1/4) → 横向模糊 → 纵向模糊
 *       → 最终合成（曝光 → bloom → 极轻调色 → 暗角 → 颗粒 → 色调映射 → sRGB 编码）→ 屏幕
 *
 * 三条铁律（前几版就是栽在这里）：
 *   1. 绝不用"晨雾金 screen""lift/gamma/gain 三向调色"这类会把全画面抬灰的操作。
 *      蓝青区域不许被染成米黄，暗部不许被抬成灰板。
 *   2. 曝光只有一个旋钮，色调映射只用一种（Khronos PBR Neutral），
 *      中间过程不改色相，避免整屏发白。
 *   3. 场景 RT 里存的是纯线性光（NoToneMapping + LinearSRGB），最终 pass 里手动
 *      做 tonemap 与 sRGB 编码；三种状态在 render() 结束时全部还原。
 */

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/* ---------------- 亮部提取：只在真正的高光里留能量 ---------------- */
const BRIGHT_FRAG = /* glsl */`
uniform sampler2D tScene;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;

void main() {
  // 4 点盒式采样，避免单点采样让 bloom 抖动
  vec3 c = texture2D(tScene, vUv + uTexel * vec2(-0.5, -0.5)).rgb
         + texture2D(tScene, vUv + uTexel * vec2( 0.5, -0.5)).rgb
         + texture2D(tScene, vUv + uTexel * vec2(-0.5,  0.5)).rgb
         + texture2D(tScene, vUv + uTexel * vec2( 0.5,  0.5)).rgb;
  c *= 0.25;

  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // soft knee：阈值附近平滑过渡，避免高光边界出现硬边
  float soft = clamp(lum - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-5);
  float w = max(soft, lum - uThreshold) / max(lum, 1e-4);
  gl_FragColor = vec4(c * w, 1.0);
}
`;

/* ---------------- 分离高斯模糊 ---------------- */
const BLUR_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uDir;          // 像素步长方向
varying vec2 vUv;

void main() {
  // 9 tap，权重取 sigma≈2.2 的高斯
  float w0 = 0.227027, w1 = 0.194594, w2 = 0.121621, w3 = 0.054054, w4 = 0.016216;
  vec3 c = texture2D(tSrc, vUv).rgb * w0;
  c += texture2D(tSrc, vUv + uDir * 1.3846).rgb * w1;
  c += texture2D(tSrc, vUv - uDir * 1.3846).rgb * w1;
  c += texture2D(tSrc, vUv + uDir * 3.2308).rgb * w2;
  c += texture2D(tSrc, vUv - uDir * 3.2308).rgb * w2;
  c += texture2D(tSrc, vUv + uDir * 5.1769).rgb * w3;
  c += texture2D(tSrc, vUv - uDir * 5.1769).rgb * w3;
  c += texture2D(tSrc, vUv + uDir * 7.1231).rgb * w4;
  c += texture2D(tSrc, vUv - uDir * 7.1231).rgb * w4;
  gl_FragColor = vec4(c, 1.0);
}
`;

/* ---------------- 最终合成 ---------------- */
const FINAL_FRAG = /* glsl */`
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform vec2  uRes;
uniform float uTime;
uniform float uEased;
uniform float uDay;
uniform float uExposure;
uniform float uBloom;
uniform float uVignette;
uniform float uGrain;
varying vec2 vUv;

/* Khronos PBR Neutral：保留色相与饱和度，只把高光往白里收，
 * 不像 ACES 那样把中间调集体推向灰白奶油色。 */
vec3 neutralTonemap(vec3 color) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < startCompression) return color;
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}

vec3 lin2srgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, step(c, vec3(0.0031308)));
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 uv = vUv;
  vec3 col = texture2D(tScene, uv).rgb;

  /* bloom：只在太阳与光路上加一点点辉光，不能把整片天空泡亮 */
  vec3 bloom = texture2D(tBloom, uv).rgb;
  float bl = dot(bloom, vec3(0.2126, 0.7152, 0.0722));
  col += bloom * uBloom * (0.55 + 0.45 * smoothstep(0.0, 1.2, bl));

  col *= uExposure;

  /* 极克制的分离调色：
   *   - 亮部（亮度 > 0.55）只加 3% 暖，且不做屏幕叠加，只轻微乘；
   *   - 暗部（亮度 < 0.10）压一点点并偏冷，保住夜景的"沉"。 */
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 warm = vec3(1.035, 1.005, 0.955);
  col *= mix(vec3(1.0), warm, smoothstep(0.55, 1.05, lum) * (0.35 + 0.65 * uEased));
  col *= mix(vec3(0.965, 0.985, 1.03), vec3(1.0), smoothstep(0.02, 0.22, lum));

  col = neutralTonemap(col);

  /* 暗角：屏幕边缘压暗 22%，把视线收到太阳与语录上 */
  vec2 p = uv - 0.5;
  p.x *= uRes.x / max(uRes.y, 1.0);
  float r = length(p) / 0.72;
  col *= 1.0 - uVignette * smoothstep(0.35, 1.25, r);

  col = lin2srgb(col);

  /* 颗粒：只在暗部与中间调，强度极小，防色带 */
  float n = hash21(uv * uRes + fract(uTime) * 97.3) - 0.5;
  col += n * uGrain * (1.0 - smoothstep(0.45, 0.95, dot(col, vec3(0.333))));

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

/* 全屏三角形（比两个三角形少一次光栅化边界） */
function makeFullscreenTri() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0, 3, -1, 0, -1, 3, 0
  ]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
    0, 0, 2, 0, 0, 2
  ]), 2));
  return g;
}

export function createComposite(renderer, opts = {}) {
  const quality = opts.quality || 'high';
  const bloomDiv = quality === 'low' ? 4 : 4;

  const geo = makeFullscreenTri();
  const tri = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  tri.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(tri);
  const quadCam = new THREE.Camera();

  const hdrType = THREE.HalfFloatType;

  const rtScene = new THREE.WebGLRenderTarget(2, 2, {
    type: hdrType,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false
  });

  const rtA = new THREE.WebGLRenderTarget(2, 2, {
    type: hdrType,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false
  });
  const rtB = rtA.clone();

  const brightMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: rtScene.texture },
      uTexel: { value: new THREE.Vector2(1 / 2, 1 / 2) },
      uThreshold: { value: 0.85 },
      uKnee: { value: 0.35 }
    },
    vertexShader: VERT,
    fragmentShader: BRIGHT_FRAG,
    depthTest: false,
    depthWrite: false
  });

  const blurMat = new THREE.ShaderMaterial({
    uniforms: {
      tSrc: { value: null },
      uDir: { value: new THREE.Vector2() }
    },
    vertexShader: VERT,
    fragmentShader: BLUR_FRAG,
    depthTest: false,
    depthWrite: false
  });

  const finalMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: rtScene.texture },
      tBloom: { value: rtA.texture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: { value: 0 },
      uEased: { value: 0 },
      uDay: { value: 0 },
      uExposure: { value: 1.0 },
      uBloom: { value: 0.5 },
      uVignette: { value: 0.30 },
      uGrain: { value: 0.012 }
    },
    vertexShader: VERT,
    fragmentShader: FINAL_FRAG,
    depthTest: false,
    depthWrite: false
  });

  let W = 2, H = 2;

  function setSize(w, h, pixelRatio) {
    W = Math.max(2, Math.floor(w));
    H = Math.max(2, Math.floor(h));
    const pr = Math.max(0.5, pixelRatio || 1);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    const bw = Math.max(2, Math.floor((W * pr) / 1));
    const bh = Math.max(2, Math.floor((H * pr) / 1));
    rtScene.setSize(bw, bh);
    const qw = Math.max(2, Math.floor(bw / bloomDiv));
    const qh = Math.max(2, Math.floor(bh / bloomDiv));
    rtA.setSize(qw, qh);
    rtB.setSize(qw, qh);
    brightMat.uniforms.uTexel.value.set(1 / bw, 1 / bh);
    finalMat.uniforms.uRes.value.set(bw, bh);
  }

  function drawPass(mat, target) {
    tri.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  }

  function render(scene, camera, view) {
    const prevTarget = renderer.getRenderTarget();
    const prevTone = renderer.toneMapping;
    const prevCS = renderer.outputColorSpace;
    const prevAutoClear = renderer.autoClear;

    // --- 1. 场景进 HDR RT（纯线性光，不做任何 tonemap / 编码）
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.autoClear = true;
    renderer.setRenderTarget(rtScene);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    // --- 2. 亮部提取 + 分离模糊
    renderer.autoClear = false;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

    drawPass(brightMat, rtA);

    const bw = rtA.width, bh = rtA.height;
    blurMat.uniforms.tSrc.value = rtA.texture;
    blurMat.uniforms.uDir.value.set(1.0 / bw, 0.0);
    drawPass(blurMat, rtB);
    blurMat.uniforms.tSrc.value = rtB.texture;
    blurMat.uniforms.uDir.value.set(0.0, 1.0 / bh);
    drawPass(blurMat, rtA);

    // --- 3. 合成到屏幕
    const u = finalMat.uniforms;
    u.uTime.value = view && view.time ? view.time : 0;
    u.uEased.value = view && typeof view.eased === 'number' ? view.eased : 0;
    // day = "天亮之后"的白天进度；专门用来让后期在第 60 帧之后继续走，
    // 否则调色/泛光/暗角会和太阳一样在 60 帧冻住。
    u.uDay.value = view && typeof view.day === 'number' ? view.day : 0;
    // 曝光：日出全程只抬 12%，亮度主要交给场景里的光照，不要用后期硬拉
    u.uExposure.value = 0.97 + 0.12 * u.uEased.value + 0.05 * u.uDay.value;
    // 泛光随白天回落一点：正午的太阳是"白亮"而不是"糊成一团"
    u.uBloom.value = 0.40 + 0.20 * u.uEased.value - 0.08 * u.uDay.value;
    u.uVignette.value = 0.34 - 0.10 * u.uEased.value - 0.05 * u.uDay.value;

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    drawPass(finalMat, null);

    renderer.setRenderTarget(prevTarget);
    renderer.toneMapping = prevTone;
    renderer.outputColorSpace = prevCS;
    renderer.autoClear = prevAutoClear;
  }

  function dispose() {
    geo.dispose();
    rtScene.dispose(); rtA.dispose(); rtB.dispose();
    brightMat.dispose(); blurMat.dispose(); finalMat.dispose();
    tri.material.dispose();
  }

  // 调试钩子：允许在控制台/自动化里直接改曝光与 bloom 强度，用来分离"哪一项把画面抬亮"
  return { render, setSize, dispose, dbg: { finalMat, rtScene, brightMat, rtA } };
}
