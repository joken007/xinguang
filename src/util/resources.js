/**
 * 心光 · 共享 GPU 资源
 * ------------------------------------------------------------------
 * three 的材质程序缓存以"着色器代码 + 宏定义 + 光照/阴影配置"为键。
 * 场景里所有地形、植被、岩石都用同一个 makeWorldMaterial()，
 * 并在 onBeforeCompile 里注入完全相同的代码块；只要注入块里用到的
 * uniform 是同一批对象引用，它们就会编译成同一份 GLSL 程序，
 * 被程序缓存复用 —— 这是控制 draw call / 程序切换开销的关键。
 *
 * 约定：注入块里只允许出现硬编码常量，不引入只属于某个材质的 uniform。
 * 需要按材质变化的东西，请走 attribute 或几何体顶点颜色。
 */

/** 世界雾：所有地面物体共用，随日出变亮变淡 */
export const fogUniforms = {
  fogColor: { value: null },        // THREE.Color  大气底色
  fogDensityScale: { value: 1 },    // 随日出 1 → 0.3
  fogSunColor: { value: null },     // THREE.Color  朝向太阳一侧的暖雾
  fogSunDir: { value: null },       // THREE.Vector3 世界空间太阳方向（已归一化）
  fogSunAmount: { value: 0 }        // 0 → 1
};

/** 统一创建"世界材质"：MeshStandardMaterial + 高度雾注入 */
export function makeWorldMaterial(THREE, params = {}) {
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.94,
    metalness: 0.0,
    flatShading: false,
    ...params
  });
  mat.fog = false;                 // 关掉 three 自带雾，改用自己的高度雾
  attachWorldFog(mat);
  return mat;
}

/**
 * 给任意 MeshStandardMaterial（或子类）挂上共享的高度雾。
 * 地形、树、岩石、远处的沙丘都调用它，从而共享同一个着色器程序。
 */
export function attachWorldFog(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.xgFogColor = fogUniforms.fogColor;
    shader.uniforms.xgFogDensity = fogUniforms.fogDensityScale;
    shader.uniforms.xgFogSunColor = fogUniforms.fogSunColor;
    shader.uniforms.xgFogSunDir = fogUniforms.fogSunDir;
    shader.uniforms.xgFogSunAmount = fogUniforms.fogSunAmount;

    // 顶点阶段：把世界高度传出去（直接用 worldpos_vertex 里的 worldPosition）
    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_pars_vertex>',
      '#include <fog_pars_vertex>\nvarying float xgWorldY;\nvarying vec3 xgWorldPos;'
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_vertex>',
      '#include <fog_vertex>\n\txgWorldY = (modelMatrix * vec4(transformed, 1.0)).y;\n\txgWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      '#include <project_vertex>'
    );

    // 程序化噪声：给平坦的大面积表面加细节（否则地形是一片光滑的"沙丘"）
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      '#include <common>\n' + NOISE_GLSL
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n' + DETAIL_GLSL
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_pars_fragment>',
      FOG_GLSL
    );
    // 用我们自己的雾替换掉 three 的 fog 混合
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      FOG_APPLY_GLSL
    );
  };
  mat.customProgramCacheKey = () => 'xinguang-world-fog-v2';
  return mat;
}

const NOISE_GLSL = /* glsl */`
uniform float xgNoiseUnused;
float xgHash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}
float xgNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = xgHash(i);
  float b = xgHash(i + vec2(1.0, 0.0));
  float c = xgHash(i + vec2(0.0, 1.0));
  float d = xgHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

const DETAIL_GLSL = /* glsl */`
{
  vec3 wp = xgWorldPos;
  float dcam = distance(wp, cameraPosition);
  // 三个尺度：大块斑驳 / 中景纹理 / 近处细碎；高频按距离淡出（远处顶点稀疏，只会变噪点）
  float f1 = xgNoise(wp.xz * 0.030 + wp.y * 0.02);
  float f2 = xgNoise(wp.xz * 0.150 + 11.3);
  float f3 = xgNoise(wp.xz * 0.850 + 5.7);
  float nearFade = 1.0 - smoothstep(50.0, 240.0, dcam);
  float n = 0.62 + 0.62 * f1;
  n *= 1.0 + 0.34 * (f2 - 0.5);
  n *= 1.0 + 0.42 * (f3 - 0.5) * nearFade;
  diffuseColor.rgb *= clamp(n, 0.35, 1.65);
}
`;

const FOG_GLSL = /* glsl */`
varying float xgWorldY;
varying vec3 xgWorldPos;
uniform vec3 xgFogColor;
uniform float xgFogDensity;
uniform vec3 xgFogSunColor;
uniform vec3 xgFogSunDir;
uniform float xgFogSunAmount;
// ---------------------------------------------------------------
// 大气透视 + 贴地雾：
//   - 密度随离相机距离指数增长（远处山峦被吃掉）
//   - 密度随高度指数衰减（山谷里积雾、山顶更清晰）
//   - 朝向太阳的一侧染上暖色（晨雾的灵魂）
// ---------------------------------------------------------------
vec3 xgApplyFog(vec3 color, vec3 worldPos) {
  vec3 v = worldPos - cameraPosition;
  float dist = length(v);
  vec3 dir = v / max(dist, 0.001);

  // 远处基础大气：1 - exp(-d * k)
  float fogDist = 1.0 - exp(-dist * 0.00038 * xgFogDensity);

  // 高度衰减：海平面附近更浓，向上快速稀薄
  float h = worldPos.y;
  float heightFalloff = exp(-max(h, 0.0) * 0.010);
  // 近处不做高度雾（否则脚边会糊成一片）
  float heightFade = smoothstep(60.0, 500.0, dist);
  float fogH = (1.0 - exp(-dist * 0.0010 * xgFogDensity)) * heightFalloff * heightFade;

  float fogAmt = clamp(max(fogDist, fogH) , 0.0, 1.0);

  // 太阳方向的暖雾
  float sunFacing = pow(max(dot(dir, xgFogSunDir), 0.0), 3.0);
  vec3 fogCol = mix(xgFogColor, xgFogSunColor, clamp(sunFacing * xgFogSunAmount, 0.0, 1.0));

  // 地平线附近再提一点亮（逆光的大气辉光）
  float horizonGlow = pow(1.0 - abs(dir.y), 8.0) * xgFogSunAmount * 0.35;
  fogCol += xgFogSunColor * horizonGlow;

  return mix(color, fogCol, fogAmt);
}
`;

const FOG_APPLY_GLSL = /* glsl */`
  gl_FragColor.rgb = xgApplyFog(gl_FragColor.rgb, xgWorldPos);
`;

/** 初始化（在 renderer 就绪后调用一次） */
export function initSharedUniforms(THREE, fogColorHex, sunColorHex) {
  fogUniforms.fogColor.value = new THREE.Color(fogColorHex);
  fogUniforms.fogSunColor.value = new THREE.Color(sunColorHex);
  fogUniforms.fogSunDir.value = new THREE.Vector3(0, 0, -1);
}
