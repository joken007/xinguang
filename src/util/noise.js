/**
 * 心光 · 值噪声 / fBm / 可复现随机
 * ------------------------------------------------------------------
 * 地形、植被、云、颗粒都依赖这里。所有函数都是纯函数，
 * 相同 seed 在任何机器上得到相同的世界（便于调试截图比对）。
 * 不依赖 three，可单独在 Node 里跑单元测试。
 */

/** mulberry32：小而快的可复现伪随机 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const perm = new Uint8Array(512);
const grad3 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1
]);

(function seedPermutation(seed = 1337) {
  const rand = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
})();

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/** 3D Perlin 噪声，输出约 [-1, 1] */
export function noise3(x, y, z) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);

  const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
  const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;

  const dot = (hash, x, y, z) => {
    // grad3 只有 12 组梯度（36 个分量），索引必须落在 0..33
    const h = ((hash & 15) % 12) * 3;
    return grad3[h] * x + grad3[h + 1] * y + grad3[h + 2] * z;
  };

  return lerp(
    lerp(
      lerp(dot(perm[AA], x, y, z), dot(perm[BA], x - 1, y, z), u),
      lerp(dot(perm[AB], x, y - 1, z), dot(perm[BB], x - 1, y - 1, z), u),
      v
    ),
    lerp(
      lerp(dot(perm[AA + 1], x, y, z - 1), dot(perm[BA + 1], x - 1, y, z - 1), u),
      lerp(dot(perm[AB + 1], x, y - 1, z - 1), dot(perm[BB + 1], x - 1, y - 1, z - 1), u),
      v
    ),
    w
  );
}

/** 分形布朗运动：多倍频叠加，返回约 [-1, 1] */
export function fbm3(x, y, z, octaves = 4, lacunarity = 2.03, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const mix = lerp;
