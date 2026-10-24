/**
 * 心光 · 地形与植被
 * ------------------------------------------------------------------
 * 构图（相机 (0, 7.2, 0)，fov 46，看向 -Z，海平面 y = 0）:
 *   1) 近景沙岸：脚下约 y=1.2，向 -Z 缓降到水边（z ≈ -22），再往前是浅海；
 *      沙滩上的颗粒与波纹只靠顶点色明暗，不用贴图。
 *   2) 左侧（x < 0）森林海岸：缓坡抬升，朝海一侧平滑入水，长满 15~30m 的高瘦针叶林。
 *      森林一直延伸到 z ≈ -900，形成"海弯"的错觉。
 *   3) 右侧（x > 0）近山：圆润、被森林覆盖，山体带蓝灰岩壁，朝阳的受光面偏暖。
 *      再往右/更远是第二座更高的山。
 *   4) 正前方远景：竖直的"山脊薄带"，横贯整个视野（左右都不断开），
 *      越高越远越被雾吃掉，只在太阳附近透出一点暖色轮廓。
 *
 * 关键设计
 *   - 海岸线 xC(z) 随 -z 向两侧退开（"正前方永远是海"）。陆地高度 = 近岸缓坡 +
 *     若干"山丘"（余弦坑式衰减，天然圆润、等值线弯曲）。山丘有横向/纵深门控，
 *     所以山的轮廓完全由这几座山丘决定，好调也好控。
 *   - 近密远疏用"以相机为原点的分带极坐标网格"：0~30m 环距 1.2m、30~110m 2.4m、
 *     110~210m 4.5m、210~600m 10m，再往外是低密度覆盖带。接缝靠固定环号对齐。
 *   - 所有材质都走 makeWorldMaterial()（共用一个着色器程序），颜色只写在顶点色里。
 */
import * as THREE from 'three';
import { fbm3, noise3, mulberry32, clamp, smoothstep } from '../util/noise.js';
import { makeWorldMaterial } from '../util/resources.js';

/* ------------------------------------------------------------------ *
 * 噪声：统一入口（各层用不同偏移，互不相关；全部可复现）
 * ------------------------------------------------------------------ */
const nA = (x, z, ox, oz) => noise3(x + ox, 1.37, z + oz);
const fA = (x, z, ox, oz, oct = 4) => fbm3(x + ox, 1.37, z + oz, oct);

/** fbm 的实际幅度约 ±0.63，放大到接近 ±1，方便当"0..1 权重"用 */
const f01 = (x, z, ox, oz, oct = 4) => clamp(0.5 + 0.82 * fA(x, z, ox, oz, oct), 0, 1);

/* ------------------------------------------------------------------ *
 * 地形参数
 * ------------------------------------------------------------------ */
const SEA_U = 1.3;                    // 水下顶点统一压到这个深度（米），让海水盖住接缝

/**
 * 海岸线 x 坐标 = 离镜头轴线多远处是水。
 * 近处（z ≈ -10~-30）收到 14~21m，所以镜头左右边缘就能看到沙滩；
 * 越远两侧陆地退得越开，正前方永远是海。
 */
function coastX(z) {
  const d = z < 0 ? -z : 0;
  return 30.0 + 0.14 * d
    + 2.2 * nA(z * 0.021, 0, 3.1, 7.7) + 0.8 * nA(z * 0.09, 0, 8.3, 1.9);
}
// coastX(z) ≈ 14.5 - 0.115z → 在 z=-120 处约 28m，z=-400 处约 60m

/**
 * 山丘：[x, z, 横向半径, 纵深半径, 高度, 陡度指数]。
 * 高度乘 (1 - d²) 的幂 → 山脚圆润、山顶缓和，不会出现锥形或刀切边。
 * 位置经过投影核算：x/|z| ≤ 1.1，保证山落在 46° 画幅的右三分之一里。
 */
const HILLS = [
  // 右前三座（约 600 / 1000 / 1700m）：山脊一座比一座淡，最高那座被雾吃掉一半
  [300, -520, 300, 300, 120, 1.2],
  [520, -900, 420, 420, 150, 1.3],
  [780, -1500, 560, 560, 150, 1.35],
  // 左侧森林海岸：更低缓，主要是"长满树的坡"，别抢视线
  [-320, -640, 360, 460, 80, 1.25],
  [-620, -1100, 460, 560, 110, 1.3],
  [-900, -1700, 620, 720, 120, 1.4]
];

/** 山丘叠加（带低频幅度抖动，避免几座山长得一模一样） */
function hills(x, z) {
  let h = 0;
  for (let i = 0; i < HILLS.length; i++) {
    const H = HILLS[i];
    const dx = (x - H[0]) / H[2];
    const dz = (z - H[1]) / H[3];
    const d2 = dx * dx + dz * dz;
    if (d2 >= 1) continue;
    const amp = H[4] * (0.75 + 0.45 * fA(x * 0.0024, z * 0.0024, 121.3 + i * 7.1, 3.7, 3));
    h += amp * Math.pow(1 - d2, H[5]);
  }
  return h;
}

/**
 * 远山：跨过海湾的几列山脉（离镜头 1.5~4.5km）。
 * 没有它，地平线就是一条平直的海天线，画面读不出"山川"；
 * 有了它，太阳正好从两道山影之间的海口升起，构图才有纵深。
 * 用"绝对值再反相"的 fbm 造脊线，比普通 fbm 更像山脊。
 */
function distantRange(x, z) {
  const r = Math.sqrt(x * x + z * z);
  const gate = smoothstep(1150.0, 1900.0, r) * (1.0 - smoothstep(3400.0, 4600.0, r));
  if (gate <= 0) return 0;
  const a = fA(x * 0.00075, z * 0.00075, 231.1, 5.3, 4);
  const ridge = clamp(1.0 - Math.abs(a) * 1.85, 0.0, 1.0);
  const spread = 0.50 + 0.50 * f01(x * 0.00028, z * 0.00028, 241.7, 2.1, 2);
  const lift = 90.0 + 420.0 * ridge * ridge;
  return gate * spread * lift;
}

/**
 * 陆地高度。lat<0 表示海侧，返回负值（水下）。
 * 只在 |x| <= 2400、z >= -2600 的范围内调用。
 */
function heightLand(x, z) {
  const lx = Math.abs(x);
  const d = z < 0 ? -z : 0;

  /* lat = 离水线的横向距离（>0 在陆上，<0 在海底）。
   * 这里绝对不能再乘"左右侧符号"：乘了之后左半边的符号会整体翻转，
   * 海湾里会长出一块斜插进水面的沙洲（画面上像海天线上飘着一片帆），
   * 而真正的左岸反被当成海底沉下去。 */
  const lat = lx - coastX(z);

  // 滩面：水线附近 y≈0，往里 25m 爬到 1.2~1.8m，再往里交给缓坡和山丘
  const beach = smoothstep(-1.0, 0.0, lat) * 0.30 * Math.min(1, 0.15 + lat * 0.34);
  // 内陆缓坡：每米只抬 3~6cm（山脚之外是一大片平缓林地），
  // 二次项只在小范围内生效，远处饱和——否则 x≈2000 会垒出一堵 1700m 的墙。
  // 岸坡用"指数饱和"：水线附近先只抬 2~3m（沙滩），再往内抬到约 58m 的坡地，最后交给山丘。
  //   - 线性 0.035/m 太缓：离岸 150m 才抬 5m，7.2m 高的镜头看过去整条海岸都压在地平线下，画面只剩海。
  //   - 线性 0.42/m 太陡：镜头两侧 30m 内就垒起两堵墙，把海全挡住。
  const u = Math.max(0, lat);
  // 贴着水线先垒起 12~13m 的岸坎（这样岸上的树才立得住、剪影才压得住海平线），
  // 再往里过渡到大尺度缓坡，整体饱和在约 60m。
  const bank = 12.5 * smoothstep(0.0, 26.0, u);
  const ramp = bank + 46.0 * (1 - Math.exp(-Math.max(0, u - 22.0) / 300.0)) + 0.012 * u;
  // 海侧：离开水线后向下倾斜 5.5%，正前方 x=0 在 z=-15 处约 -1.15m
  const dive = lat < 0 ? lat * 0.055 : 0;
  let h = 0.12 + beach + ramp + dive;

  // 起伏：内陆细节（浅，打破平整）+ 山丘
  if (lat > 0) {
    h += smoothstep(0, 40, lat) * (1.5 * fA(x * 0.0055, z * 0.0055, 61.7, 2.3, 4) + 0.55 * nA(x * 0.055, z * 0.055, 71.1, 4.7));
    /* 中尺度起伏（波长 50~90m，幅度 3~7m）：坡面光靠低频山丘 + 平滑法线会读成
     * 一块光滑沙丘，加大一级起伏之后才有"被水切过的山体"的感觉。 */
    /* 近景细节起伏（波长 9~18m，幅度 ~2m）：只在相机 260m 内加，
     * 远处顶点太稀，加了只会变成锯齿。这是让"光滑沙丘"变成"真山坡"的那一层。 */
    const nearR = Math.sqrt(x * x + z * z);
    const fineD = 1 - smoothstep(120, 380, nearR);
    if (fineD > 0.001) {
      /* 两个尺度：18m 的土坡/冲沟（撑起轮廓）+ 7m 的小碎石堆（只负责近处细节） */
      h += fineD * smoothstep(3, 16, lat) * (
        3.6 * fA(x * 0.055, z * 0.055, 311.7, 2.4, 4) +
        1.1 * fA(x * 0.145, z * 0.145, 317.3, 5.1, 3)
      );
    }

    /* 山体骨架：一层脊状噪声（波长 ~160m），把"圆弧形大包"打散成真正的山脊与沟谷。
     * 只靠低频山丘 + 平滑法线，无论怎么调颜色都像沙丘。 */
    const ridgeAmp = smoothstep(3, 46, lat) * (5.0 + 9.0 * smoothstep(30, 220, h));
    const rid = 1 - Math.abs(fA(x * 0.0132, z * 0.0132, 331.1, 4.2, 5));
    h += ridgeAmp * (rid * rid - 0.42);

    const midAmp = smoothstep(4, 60, lat) * (2.6 + 4.4 * smoothstep(20, 160, h));
    h += midAmp * (0.72 * fA(x * 0.0185, z * 0.0185, 91.1, 3.3, 4) + 0.42 * fA(x * 0.047, z * 0.047, 96.7, 2.7, 3));

    // 山丘只长在陆地上，用 lat 门控保证山脚平滑入海、不出现直边
    const gate = smoothstep(6, 90, lat) * (1 - smoothstep(1700, 2300, lx));
    if (gate > 0) h += gate * hills(x, z);
    // 远山只长在离水线 240m 往里的地方：否则会在海天线上堵住太阳
    const dr = distantRange(x, z) * smoothstep(240, 700, lat);
    if (dr > 0) h += dr;

    /* 远处不许留低平的沙洲：极坐标网格在 1.5km 之外顶点很稀，水线附近的高低起伏
     * 会被抽成零星几块浅色碎片，画面上就像海天线上飘着一片帆。
     * 处理办法：远地要么是有脊线的山（那就留在水面之上），要么干脆沉下去。 */
    const farR = Math.sqrt(x * x + z * z);
    const far = smoothstep(1500.0, 2200.0, farR);
    if (far > 0) {
      const keep = smoothstep(26.0, 110.0, h);
      const sunk = -SEA_U - 45.0;
      const replaced = sunk + (h - sunk) * keep;
      h = h + (replaced - h) * far;
    }
  } else {
    // 海底：继续变深，并加一点起伏，避免一整片平底
    h += smoothstep(-3, -260, lat) * (14 * fA(x * 0.0032, z * 0.0032, 81.1, 3.1, 3) - 30);
  }

  return h;
}

/** 近景：叠加亚米级起伏，让 1~2m 的网格有真实凹凸 */
function heightNear(x, z) {
  let h = heightLand(x, z);
  const lat = Math.abs(x) - coastX(z);
  const inland = smoothstep(1.5, 22, lat);
  h += inland * 0.40 * fA(x * 0.042, z * 0.042, 101.3, 8.1, 3);
  // 沙滩上的风纹（横向波长约 3m），只在滩面附近生效
  const beachBand = smoothstep(-1.2, 0.2, lat) * (1 - smoothstep(2.5, 9, lat)) * smoothstep(0.1, 0.6, h);
  h += beachBand * 0.055 * Math.sin(lat * 2.1 + nA(x * 0.06, z * 0.06, 111.7, 2.3) * 3.0);
  return h;
}

/** 森林掩膜：低频成片，用来控制树的疏密与林缘（0 = 荒滩，1 = 密林） */
function forestMask(x, z) {
  return smoothstep(-0.30, 0.40, fA(x * 0.021, z * 0.021, 41.9, 3.3, 3) + 0.16 * nA(x * 0.11, z * 0.11, 5.7, 1.1));
}

/** 太阳方向（照明判断用；与 Lead 的 DirectionalLight 一致：正前方略偏右） */
const SUN_FX = 0.0599;
const SUN_FZ = -0.9982;

/* ------------------------------------------------------------------ *
 * 顶点色（全部是 albedo，照明交给引擎）
 * ------------------------------------------------------------------ */
const C = {
  sandDry: new THREE.Color(0x7c7259),
  sandBright: new THREE.Color(0x9c9074),
  sandDark: new THREE.Color(0x6b6250),
  sandWet: new THREE.Color(0x5c5344),
  sandWetCool: new THREE.Color(0x3d434b),
  grassDry: new THREE.Color(0x475c2d),
  grassLow: new THREE.Color(0x3f5128),
  grassHigh: new THREE.Color(0x526c38),
  forestFloor: new THREE.Color(0x2c3a22),
  rockWarm: new THREE.Color(0x6a665c),
  rockSun: new THREE.Color(0x6f6858),
  rockCool: new THREE.Color(0x55617a),
  rockDark: new THREE.Color(0x3c424c),
  ridgeNear: new THREE.Color(0x38435c),
  ridgeFar: new THREE.Color(0x333e59),
  ridgePeak: new THREE.Color(0x545e78),
  trunk: new THREE.Color(0x4a3f33),
  needleDeep: new THREE.Color(0x35543f),
  needleMid: new THREE.Color(0x4b7355),
  needleSun: new THREE.Color(0x6d9166),
  needleBase: new THREE.Color(0x3b5a45)
};

const _c = new THREE.Color();
const _c2 = new THREE.Color();

const lerpCol = (out, a, b, t) => {
  out.setRGB(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
  return out;
};


/** 地面坡度（有限差分）。返回 [h, 坡度] */
const _slopeOut = { h: 0, s: 0, gx: 0, gz: 0 };
function slopeAt(x, z, e) {
  const h = heightLand(x, z);
  const hx = (heightLand(x + e, z) - heightLand(x - e, z)) / (2 * e);
  const hz = (heightLand(x, z + e) - heightLand(x, z - e)) / (2 * e);
  _slopeOut.h = h;
  _slopeOut.gx = hx;
  _slopeOut.gz = hz;
  _slopeOut.s = Math.sqrt(hx * hx + hz * hz);
  return _slopeOut;
}

/**
 * 地面顶点色。
 * 层次：湿沙带 → 干沙 → 盐风草甸 → 林下 → 山体岩面 / 受光坡的暖色。
 */
function colorForGround(out, x, z, h, r) {
  const lx = Math.abs(x);
  const lat = lx - coastX(z);

  // 细节按距离淡出（远处顶点稀疏，高频噪声只会变成彩色噪点）
  const fine = 1 - smoothstep(40, 200, r);

  // -- 湿沙带：水线以上 0~0.7m 压暗并偏蓝（沙滩与海衔接的关键）--
  const wet = 1 - smoothstep(0.02, 0.70, h);
  // -- 干沙：亮/暗细纹（梳状纹理由网格级噪声补，这里只给大块明暗）--
  const sandT = clamp(0.5 + 1.6 * fA(x * 0.055, z * 0.075, 141.7, 2.2, 3), 0, 1);
  lerpCol(out, C.sandDark, C.sandBright, sandT);
  out.lerp(C.sandDry, 0.35 * (1 - wet));
  // -- 水里：压暗、更冷 --
  if (h < 0.02) {
    lerpCol(_c2, C.sandWet, C.sandWetCool, clamp(0.35 - h * 0.9, 0, 1));
    out.lerp(_c2, smoothstep(0.02, -0.35, h));
  }
  out.lerp(C.sandWetCool, wet * 0.72);
  out.multiplyScalar(1 - wet * 0.45);

  // -- 往里走：盐风草甸 → 林下 --
  /* 沙带只留水线以上 1~5m 的一条：原来过渡到 14m，等于把整条岸坡都刷成米色沙丘，
   * 远看像沙漠而不是"森林海岸"。 */
  const inland = smoothstep(0.6, 5.0, lat);
  // 沙/草交界带一点湿沙的冷调，海和岸的衔接更自然
  if (inland < 1) out.lerp(C.sandWetCool, 0.12 * (1 - inland) * fine);
  lerpCol(_c2, C.grassDry, C.grassLow, clamp(0.5 + 1.5 * fA(x * 0.02, z * 0.02, 151.3, 6.6, 3), 0, 1));
  _c2.lerp(C.grassHigh, 0.45 * clamp(0.5 + 1.3 * nA(x * 0.008, z * 0.008, 161.1, 3.7), 0, 1));
  out.lerp(_c2, inland * 0.95);

  const fm = forestMask(x, z);
  out.lerp(C.forestFloor, fm * smoothstep(5, 22, lat) * 0.92);

  // -- 山体岩面：坡度越陡越多，朝阳坡用暖灰、背光坡用冷蓝灰 --
  const steep = smoothstep(0.34, 0.95, slopeAt(x, z, 8.0).s);
  // 岩面只在真正的高处出现：岸坎（h≈12~30）必须留草/林，否则整条海岸都是米色石头
  const rockAmt = steep * smoothstep(60, 150, h) * 0.82 + smoothstep(160, 300, h) * 0.26;
  if (rockAmt > 0.01) {
    const gx = _slopeOut.gx, gz = _slopeOut.gz;
    // 法线水平分量约为 (-gx, -gz)，与太阳水平方向点乘 > 0 即受光
    const lit = -(gx * SUN_FX + gz * SUN_FZ) / (Math.sqrt(gx * gx + gz * gz) + 1e-4);
    lerpCol(_c2, C.rockCool, C.rockSun, clamp(0.5 + lit * 2.0, 0, 1));
    _c2.lerp(C.rockWarm, 0.4 * clamp(0.5 + nA(x * 0.035, z * 0.035, 171.7, 3.3), 0, 1));
    _c2.lerp(C.rockDark, 0.35 * clamp(0.5 + 1.4 * fA(x * 0.012, z * 0.012, 181.1, 1.9, 3), 0, 1) * (1 - clamp(0.5 + lit, 0, 1)));
    out.lerp(_c2, clamp(rockAmt, 0, 1));
  }

  // -- 山顶与林冠的微暖：受光侧更亮一点，暗场里也能看出层次 --
  //   （只按"水平朝向 + 海拔"给一点点方向性明暗，真正的光照仍由太阳灯负责）
  /* 中尺度斑驳：大块的草/林/裸岩交错。只靠低频配色 + 平滑法线，整面坡会被光抹成
   * 一块"塑料沙丘"；加一层 10~50m 尺度的明暗噪声之后才读得出山体表面的质感。 */
  /* 远处顶点稀疏、几何细节全被抽掉，颜色是唯一还能交代"坡面上的林窗、裸土、阴影"的通道，
   * 所以远处的斑驳只降权、不关掉。 */
  const mottle = fA(x * 0.085, z * 0.085, 201.3, 3.1, 3) * 0.5 + fA(x * 0.021, z * 0.021, 205.7, 2.3, 3) * 0.5;
  out.multiplyScalar(1 + mottle * (0.11 + 0.20 * fine));

  const litH = clamp(0.5 + (SUN_FX * x + SUN_FZ * z) * 0.00035 + h * 0.0016, 0, 1);
  out.multiplyScalar(1 + (litH - 0.5) * 0.30);

  return out;
}

/* ------------------------------------------------------------------ *
 * 网格构建：以相机为原点的分带极坐标网格（下密上疏）
 * ------------------------------------------------------------------ */
/* 水线阈值：h 低于它的一律压到水下。0.04 太贴水面，浪谷一过就露出发丝般的深色薄片，
 * 抬到 0.30 并把落差按比例放大，让"看得见的岸"从 0.3m 以上才开始。 */
const SEA_EPS = 1.0;

/** 环距分段：[起始半径, 环距]，覆盖 0 → 4400m。 */
const RING_BANDS = [
  [0, 0.45],      // 脚下 ~ 12m：0.45m 一格（沙滩的凹凸靠它）
  [12, 0.75],     // 12 ~ 30m
  [30, 1.5],      // 30 ~ 60m
  [60, 3.0],      // 60 ~ 90m
  [90, 6.0],      // 90 ~ 210m
  [210, 14],      // 210 ~ 600m
  [600, 40],      // 600 ~ 1200m
  [1200, 100]     // 1200 ~ 2000m
];

/** 方位分段数：按顶部弧长定（每段近似 segLen 米）。90° 的片最多 32 段，
 *  保证远处环也不会塌成"一个三角扇"那种超长刀片。 */
function angSeg(segLen, r, a0, a1) {
  const span = Math.abs(a1 - a0);
  // 目标：每格弧长约 segLen 米；再做 2 的幂量化，相邻环才能整齐二分
  const want = Math.max(1, ((span * Math.max(r, 0.5)) / segLen));
  let n = 1;
  while (n < 96 && n * 2 <= want * 1.35) n *= 2;
  return n < 4 ? 4 : n;
}

/**
 * 生成一张环带网格（某一侧的某一段方位角）。
 * 环号 j 不固定用同一个弧长分段数：从粗到细逐级提升，
 * 于是相邻两环之间共享的下标严格一一对齐，不会撕缝，也不会出现 T 形接点。
 */
function buildBand(a0, a1, rLo, rHi, segLen, hFn, heightFn) {
  // 环半径表
  const radii = [];
  let r = 0;
  let bi = 0;
  while (r < rHi - 1e-6) {
    while (bi < RING_BANDS.length - 1 && r >= RING_BANDS[bi + 1][0]) bi++;
    const nr = r + RING_BANDS[bi][1];
    radii.push(Math.min(nr, rHi));
    r = nr;
  }
  const rows = radii.length;
  // 每环方位分段数：内侧（近处）细、外侧（远处）粗
  const segs = new Uint16Array(rows);
  for (let j = 0; j < rows; j++) segs[j] = angSeg(segLen, radii[j], a0, a1);
  // 方位角表（按最长段数对齐，保证 a0 / a1 严格落在边界子午线上）
  let maxSeg = 0;
  for (let j = 0; j < rows; j++) if (segs[j] > maxSeg) maxSeg = segs[j];
  const angs = new Float64Array(maxSeg + 1);
  for (let a = 0; a <= maxSeg; a++) angs[a] = a0 + (a1 - a0) * (a / maxSeg);

  const pos = new Float32Array(rows * (maxSeg + 1) * 3);
  const col = new Float32Array(rows * (maxSeg + 1) * 3);
  const hgt = new Float32Array(rows * (maxSeg + 1));

  for (let j = 0; j < rows; j++) {
    const segsJ = segs[j];
    const span = angs[maxSeg] - angs[0];
    for (let a = 0; a <= segsJ; a++) {
      const k = j * (maxSeg + 1) + a;
      // 第 a 个顶点始终落在这一段方位角的 a/segsJ 处 → 相邻两环一一对应
      const ang = angs[0] + span * (a / segsJ);
      const rr = radii[j];
      const x = Math.sin(ang) * rr;
      const z = -Math.cos(ang) * rr;
      let h = heightFn(x, z);
      /* 只要低于海面，就压到足够深：浪高约 ±0.6m，若让近岸浅滩停在 -0.2 一类的
       * 高度，浪谷一过就会露出水面，变成画面里一道道"深色爪子"。 */
      if (h < SEA_EPS) h = -SEA_U - Math.min(80, Math.max(0, SEA_EPS - h) * 0.60);
      hgt[k] = h;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      colorForGround(_c, x, z, h, rr);
      col[k * 3] = _c.r; col[k * 3 + 1] = _c.g; col[k * 3 + 2] = _c.b;
    }
  }

  // 索引：相邻两环同号顶点直接相连（不是梯形 stitch！）
  //   外环较粗时（segs[j+1] < segs[j]），第 b 段的角宽是内环的 (segs[j]/segs[j+1]) 倍，
  //   逐段拆成几个三角，避免出现跨半屏的超长刀片。
  const tri = [];
  for (let j = 0; j < rows - 1; j++) {
    const sa = segs[j];
    const sb = segs[j + 1];
    const ia = j * (maxSeg + 1);
    const ib = (j + 1) * (maxSeg + 1);
    for (let b = 0; b < sb; b++) {
      const aStart = Math.round((sa * b) / sb);
      const aEnd = Math.round((sa * (b + 1)) / sb);
      // 先把外环这一段的一个端点固定住，内环上若干顶点依次连过去（扇形）
      for (let a = aStart; a < aEnd; a++) {
        tri.push(ia + a, ib + b, ia + a + 1);
      }
      // 外环第 b 段到第 b+1 段之间的另一条边
      tri.push(ia + aEnd, ib + b, ib + b + 1);
    }
  }

  // 整片在水下的三角形丢掉（看不见，省预算）
  const idx = [];
  for (let t = 0; t < tri.length; t += 3) {
    const A = tri[t], B = tri[t + 1], Cc = tri[t + 2];
    if (hgt[A] < -0.6 && hgt[B] < -0.6 && hgt[Cc] < -0.6) continue;
    idx.push(A, B, Cc);
  }
  // 按实际用到的顶点打包（外环较粗，尾部有没用到的列）
  let used = 0;
  for (let i = 0; i < idx.length; i++) if (idx[i] + 1 > used) used = idx[i] + 1;
  const vN = used;
  const pOut = new Float32Array(vN * 3);
  const cOut = new Float32Array(vN * 3);
  pOut.set(pos.subarray(0, vN * 3));
  cOut.set(col.subarray(0, vN * 3));
  return { pos: pOut, col: cOut, idx, count: vN };
}


/**
 * 地形网格：单张极坐标网格。
 * 所有环共用同一套方位分段（segs+1 个顶点，首尾重合），相邻两环天然一一对应，
 * 于是只有四边形，不存在"扇形缝合"——上一版的多带 + 扇形缝合在画面里留下了
 * 横贯全屏的灰白平板和几根指向地平线的细长爪子。
 */
function buildPolarGround(o) {
  const segs = o.segs | 0;
  const cols = segs + 1;
  const radii = [];
  for (let r = o.rMin; r < o.rMax; r *= o.growth) radii.push(r);
  radii.push(o.rMax);
  const rows = radii.length;
  const vN = rows * cols;
  const pos = new Float32Array(vN * 3);
  const col = new Float32Array(vN * 3);
  const hgt = new Float32Array(vN);

  for (let j = 0; j < rows; j++) {
    const rr = radii[j];
    for (let a = 0; a <= segs; a++) {
      const ang = (a / segs) * Math.PI * 2;
      const x = Math.sin(ang) * rr;
      const z = -Math.cos(ang) * rr;
      let h = o.heightFn(x, z);
      /* 只要低于水线，一律压到足够深：浪高约 ±0.6m，
       * 让近岸浅滩停在 0 附近，浪谷一过就会露出发丝般的深色薄片。 */
      if (h < SEA_EPS) h = -SEA_U - Math.min(80, Math.max(0, SEA_EPS - h) * 0.60);
      const k = j * cols + a;
      hgt[k] = h;
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      colorForGround(_c, x, z, h, rr);
      col[k * 3] = _c.r; col[k * 3 + 1] = _c.g; col[k * 3 + 2] = _c.b;
    }
  }

  const idx = [];
  for (let j = 0; j < rows - 1; j++) {
    const ia = j * cols;
    const ib = (j + 1) * cols;
    for (let a = 0; a < segs; a++) {
      const A = ia + a, B = ia + a + 1, Cc = ib + a, D = ib + a + 1;
      // 整片都在水下的四边形直接丢（海面盖着，看不见）
      if (hgt[A] < -0.6 && hgt[B] < -0.6 && hgt[Cc] < -0.6 && hgt[D] < -0.6) continue;
      idx.push(A, B, Cc);
      idx.push(B, D, Cc);
    }
  }
  return { pos, col, idx };
}

/** 近景左右两片（各自一个 draw call，便于合并时控制剔除边界） */
function buildNearBands() {
  const out = [];
  const HPI = Math.PI * 0.5;
  out.push(buildBand(0.02, HPI, 0, 190, 1.0, 'nearE', heightNear));
  out.push(buildBand(-HPI, -0.02, 0, 190, 1.0, 'nearW', heightNear));
  return out;
}

/** 中景 / 远景覆盖带 */
function buildFarBands() {
  const out = [];
  const PI = Math.PI;
  out.push(buildBand(0.30, PI - 0.02, 180, 2000, 9, 'midE', heightLand));
  out.push(buildBand(-PI + 0.02, -0.30, 180, 2000, 9, 'midW', heightLand));
  out.push(buildBand(0.014, 0.306, 170, 2000, 9, 'forE', heightLand));
  out.push(buildBand(-0.306, -0.014, 170, 2000, 9, 'forW', heightLand));
  // 两侧身后的岸线（相机背后也算海岸，避免转头看到空白）
  out.push(buildBand(PI + 0.02, PI * 2 - 0.02, 0, 500, 2.4, 'backE', heightLand));
  out.push(buildBand(-PI * 2 + 0.02, -PI - 0.02, 0, 500, 2.4, 'backW', heightLand));
  return out;
}

/* ------------------------------------------------------------------ *
 * 远景山脊（竖直薄带）
 *   法线朝向观众 → 受光均匀、不会出现"横躺着被顶光照亮"的怪异感；
 *   越远越薄、越低、越向雾色收敛（大气透视）。
 * ------------------------------------------------------------------ */
const RIDGE_TABLE = [
  // [方位角(弧度，0=正前方，正=偏右), 半径, 峰高, 宽度(方位的弧度)]
  [-1.55, 1200, 205, 0.20],
  [-1.22, 1260, 262, 0.24],
  [-0.90, 1190, 198, 0.21],
  [-0.58, 1240, 288, 0.26],
  [-0.26, 1210, 214, 0.22],
  [0.06, 1280, 272, 0.25],
  [0.38, 1220, 222, 0.23],
  [0.70, 1250, 282, 0.26],
  [1.02, 1200, 208, 0.22],
  [1.34, 1240, 268, 0.25],
  [1.62, 1210, 216, 0.22]
];

/** 某个方位、某个半径处的山脊顶端高度 */
function ridgeTop(az, r, envScale) {
  let env = 0;
  for (let i = 0; i < RIDGE_TABLE.length; i++) {
    const d = (az - RIDGE_TABLE[i][0]) / RIDGE_TABLE[i][3];
    env += RIDGE_TABLE[i][2] * Math.exp(-d * d);
  }
  // 主脊/谷：约 55% 的方位是"山"，其余被拉低到接近海面，山脊看起来是断续的一条排峰
  const clim = smoothstep(-0.12, 0.18, nA(az * 1.6, 0, 231.7, 5.3)) * (0.72 + 0.42 * nA(az * 5.2, 0, 241.1, 9.7));
  // 远处起伏变平缓
  const flat = 1 - 0.55 * smoothstep(1400, 9000, r);
  const detail = 1 + flat * (0.20 * nA(az * 11.0, r * 0.0006, 251.3, 3.9) + 0.10 * nA(az * 26.0, r * 0.0015, 261.7, 7.1));
  return env * clim * detail * flat * envScale;
}

/** 远景山脊：一张按 [方位][半径] 组织的竖直薄带 */
function buildFarRidge() {
  const NAZ = 160;
  const radii = [];
  for (let r = 900; r <= 5200; r += 130 + r * 0.05) radii.push(r);
  const rows = radii.length;
  const count = (NAZ + 1) * rows * 2;
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const idx = [];

  let p = 0;
  for (let j = 0; j < rows; j++) {
    const r = radii[j];
    const far = smoothstep(1000, 5200, r);
    for (let i = 0; i <= NAZ; i++) {
      const az = -2.02 + (i / NAZ) * 4.04;
      const sa = Math.sin(az), ca = Math.cos(az);
      const x = sa * r, z = -ca * r;
      const top = Math.max(2, ridgeTop(az, r, 1));
      // 底部压到水下，顶端按高度
      pos[p * 3] = x; pos[p * 3 + 1] = -4; pos[p * 3 + 2] = z;
      pos[(p + 1) * 3] = x; pos[(p + 1) * 3 + 1] = top; pos[(p + 1) * 3 + 2] = z;

      // 底部偏暗（含雾），顶部略亮，远处整体向雾色收敛
      lerpCol(_c, C.ridgeNear, C.ridgeFar, far);
      _c.lerp(C.ridgePeak, 0.32 * (1 - far * 0.6));
      const base = 0.72 + 0.28 * (1 - far);
      col[p * 3] = _c.r * base; col[p * 3 + 1] = _c.g * base; col[p * 3 + 2] = _c.b * base;
      col[(p + 1) * 3] = _c.r * 1.10; col[(p + 1) * 3 + 1] = _c.g * 1.06; col[(p + 1) * 3 + 2] = _c.b * 1.02;
      p += 2;
    }
  }
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < NAZ; i++) {
      const a = (j * (NAZ + 1) + i) * 2;
      const b = a + 2;
      const c = a + (NAZ + 1) * 2;
      const d = c + 2;
      idx.push(a, b, c, b, d, c);
    }
  }
  return { pos, col, idx, count };
}

/* ------------------------------------------------------------------ *
 * 针叶树：树干（细圆柱）+ 4 段圆锥树冠，合并成两个 InstancedMesh
 * ------------------------------------------------------------------ */
function makeConifer() {
  const trunkH = 15;
  const trunk = new THREE.CylinderGeometry(0.34, 0.72, trunkH, 5, 1, true);
  trunk.translate(0, trunkH / 2, 0);

  const tiers = [
    // [底半径, 高, 底 y]  —— 树冠总高约 38m，实例再缩放到 15~30m
    [5.4, 19, 8.5],
    [4.2, 16, 17],
    [2.8, 15, 24.5],
    [1.4, 12.5, 31]
  ];
  const TOP = 43.5;
  const coneGeos = tiers.map(([r, h, y0]) => {
    const g = new THREE.ConeGeometry(r, h, 6, 1, false);
    g.translate(0, y0 + h / 2, 0);
    return g;
  });

  // 手工合并（避免引入 BufferGeometryUtils）
  const merge = (geos, colorFn) => {
    const pos = [], col = [], idx = [];
    for (const g of geos) {
      const arr = g.attributes.position.array;
      const base = pos.length / 3;
      for (let i = 0; i < arr.length; i += 3) {
        pos.push(arr[i], arr[i + 1], arr[i + 2]);
      }
      const gi = g.index;
      if (gi) for (let i = 0; i < gi.count; i++) idx.push(base + gi.getX(i));
      else for (let i = 0; i < arr.length / 3; i++) idx.push(base + i);
      g.dispose();
    }
    for (let i = 0; i < pos.length; i += 3) {
      colorFn(pos[i], pos[i + 1], pos[i + 2]);
      col.push(_c.r, _c.g, _c.b);
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    out.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    out.computeVertexNormals();
    out.computeBoundingSphere();
    return out;
  };

  // 树干 + 树冠合成一个几何体：整片森林只要一次 draw call
  const merged = merge([trunk].concat(coneGeos), (x, y) => {
    if (y <= trunkH * 0.92) {
      // 树干：底部暗、往上略青
      lerpCol(_c, C.trunk, C.needleDeep, 0.55 * clamp(y / trunkH, 0, 1));
      return;
    }
    // 树顶深、树底略暖；越往上越沉默，只在朝光的坡上留一点青
    const t = clamp(y / TOP, 0, 1);
    lerpCol(_c, C.needleBase, C.needleDeep, Math.pow(t, 0.75));
    const n = 0.5 + 0.5 * nA(x * 1.9, y * 1.1, 271.3, 5.7);
    _c.lerp(C.needleMid, 0.35 * (1 - t) * n);
    _c.lerp(C.needleSun, 0.22 * (1 - t) * (1 - n));
  });

  return merged;
}

/* ------------------------------------------------------------------ *
 * 低多边形岩块
 * ------------------------------------------------------------------ */
function makeRockGeometry(rng) {
  const g = new THREE.DodecahedronGeometry(1, 0);
  const p = g.attributes.position;
  const jitter = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = p.getX(i).toFixed(3) + ',' + p.getY(i).toFixed(3) + ',' + p.getZ(i).toFixed(3);
    let s = jitter.get(key);
    if (s === undefined) {
      s = 0.74 + rng() * 0.5;
      jitter.set(key, s);
    }
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * 0.68, p.getZ(i) * s * (0.85 + rng() * 0.3));
  }
  g.computeVertexNormals();
  // 顶点色：顶面亮、底部暗（世界 y 就接近实例 y，flatShading 会吃法线但不吃颜色）
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    _c.setRGB(0.62, 0.60, 0.56).multiplyScalar(0.72 + 0.35 * clamp(y * 0.5 + 0.5, 0, 1));
    col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}


/* ------------------------------------------------------------------ *
 * 主工厂
 * ------------------------------------------------------------------ */
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

function addGeometryMesh(group, disposables, pos, col, idx, material) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const n = pos.length / 3;
  geo.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.frustumCulled = false;
  disposables.push(geo);
  group.add(mesh);
  return mesh;
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {{quality?: 'high'|'low', debug?: boolean}} opts
 * @returns {{ object3D: THREE.Object3D, tick: (view: any) => void, dispose: () => void }}
 */
export function createTerrain(renderer, opts) {
  const o = opts || {};
  const low = o.quality === 'low';
  const group = new THREE.Group();
  group.name = 'terrain';
  group.matrixAutoUpdate = false;
  const disposables = [];

  /* ---------------- 材质（全部走 makeWorldMaterial，共用一份程序） ---------------- */
  const groundMat = makeWorldMaterial(THREE, {
    vertexColors: true,
    roughness: 0.97,
    metalness: 0.0,
    emissive: new THREE.Color(0x2a1608),
    emissiveIntensity: 0
  });
  const treeMat = makeWorldMaterial(THREE, {
    vertexColors: true,
    roughness: 0.90,
    metalness: 0.0,
    emissive: new THREE.Color(0x20180f),
    emissiveIntensity: 0
  });
  const rockMat = makeWorldMaterial(THREE, {
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    flatShading: true,
    emissive: new THREE.Color(0x2a1608),
    emissiveIntensity: 0
  });
  disposables.push(groundMat, treeMat, rockMat);

  /* ---------------- 地形网格：一整张极坐标网格 ---------------- */
  const ground = buildPolarGround({
    segs: low ? 192 : 288,
    rMin: 2.0,
    rMax: 4600,
    growth: low ? 1.065 : 1.048,
    heightFn: heightNear
  });
  const groundMesh = addGeometryMesh(group, disposables, ground.pos, ground.col, ground.idx, groundMat);
  groundMesh.name = 'ground';

  if (o.debug && typeof window !== 'undefined') {
    window.__terrainDebug = {
      heightLand, heightNear, coastX, forestMask,
      sample: (x, z) => heightLand(x, z)
    };
    const rows = [];
    for (const z of [0, -20, -60, -120, -250, -500, -900]) {
      rows.push('z=' + z + ' ' + [0, 30, 120, 300, 600, 900].map((x) => x + ':' + heightLand(x, z).toFixed(1)).join(' '));
    }
    console.info('[terrain] heights\n' + rows.join('\n'));
  }

  /* ---------------- 针叶林（InstancedMesh） ---------------- */
  const treeGeo = makeConifer();
  disposables.push(treeGeo);
  const treeBudget = low ? 1400 : 3200;

  // 一次性算出所有树的位置（先收集，再分配实例数组）
  const rng = mulberry32(20261023);
  const trees = [];
  let guard = 0;
  const maxX = 1080, maxZ = 1500;
  while (trees.length < treeBudget && guard < treeBudget * 40) {
    guard++;
    // 左森林为主（约 62%），右侧近山也种（约 38%）
    const westSide = rng() < 0.62;
    const x = westSide ? -(18 + Math.pow(rng(), 1.15) * 900) : (18 + Math.pow(rng(), 1.25) * 820);
    const z = 8 - Math.pow(rng(), 1.05) * maxZ;
    if (x > maxX || z < -maxZ) continue;

    const lat = Math.abs(x) - coastX(z);
    if (lat < 6) continue;                       // 太靠近水线：不长树
    const fm = forestMask(x, z);
    // 成片疏密：低频噪声决定哪里密、哪里是林间空地
    const crowd = smoothstep(-0.05, 0.7, fm + 0.20 * nA(x * 0.055, z * 0.055, 281.3, 4.4));
    if (rng() > 0.10 + 0.90 * crowd) continue;

    const sl = slopeAt(x, z, 4);
    if (sl.h < 2.0) continue;
    if (sl.s > 1.05) continue;                   // 太陡的岩壁不长树
    if (Math.abs(x) < 15 && z > -20) continue;   // 脚下别挡镜头

    trees.push({ x, z, h: sl.h, gx: sl.gx, gz: sl.gz, crowd, r: rng(), r2: rng(), r3: rng(), r4: rng() });
  }

  // 树只用一个 InstancedMesh（树干与树冠已合并进同一个几何体，一次 draw call）
  const forest = new THREE.InstancedMesh(treeGeo, treeMat, trees.length);
  forest.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  forest.frustumCulled = false;
  forest.matrixAutoUpdate = false;

  const col = new THREE.Color();
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    // 高瘦针叶：树高 15~30m，越高越细
    const tall = 0.52 + 0.62 * Math.pow(t.r, 0.7);
    const sy = 0.36 + 0.32 * tall * (0.85 + 0.30 * t.r2);
    const thin = 0.72 + 0.30 * t.r3;
    const sx = sy * thin * 1.05;
    const sz = sy * thin * 1.05;
    // 顺坡轻微倾斜
    const tiltX = clamp(-t.gz, -1, 1) * 0.05;
    const tiltZ = clamp(t.gx, -1, 1) * 0.05;

    _m.compose(
      _v.set(t.x, t.h - 1.1, t.z),
      _q.setFromEuler(_e.set(tiltX, t.r4 * Math.PI * 2, tiltZ)),
      _s.set(sx, sy * 0.9, sz)
    );
    forest.setMatrixAt(i, _m);

    // 每棵树的色差（实例颜色乘法）：暗场靠它做出剪影层次
    const v = 0.62 + 0.55 * t.r2 * (0.6 + 0.4 * t.crowd);
    const warm = t.r3;
    col.setRGB(v * (0.88 + 0.22 * warm), v * (0.96 + 0.08 * t.r), v * (0.86 + 0.16 * (1 - warm)));
    forest.setColorAt(i, col);
  }
  forest.count = trees.length;
  forest.instanceMatrix.needsUpdate = true;
  if (forest.instanceColor) forest.instanceColor.needsUpdate = true;
  forest.computeBoundingSphere();
  group.add(forest);

  /* ---------------- 山体岩石 ---------------- */
  const rockRng = mulberry32(777);
  const rockGeo = makeRockGeometry(rockRng);
  disposables.push(rockGeo);
  const rockSpots = [];
  guard = 0;
  const rockBudget = low ? 50 : 95;
  while (rockSpots.length < rockBudget && guard < rockBudget * 80) {
    guard++;
    // 优先落在右侧近山的坡面上
    const az = 0.55 + rockRng() * 1.35;
    const dist = 170 + Math.pow(rockRng(), 0.65) * 850;
    const x = Math.sin(az) * dist;
    const z = -Math.cos(az) * dist;
    const sl = slopeAt(x, z, 5);
    if (sl.h < 14 || sl.s < 0.20) continue;
    rockSpots.push({ x, z, h: sl.h, gx: sl.gx, gz: sl.gz, r1: rockRng(), r2: rockRng(), r3: rockRng() });
  }
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, Math.max(1, rockSpots.length));
  rocks.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  rocks.frustumCulled = false;
  for (let i = 0; i < rockSpots.length; i++) {
    const r = rockSpots[i];
    const sc = 2.4 + r.r1 * 7.0;
    _m.compose(
      _v.set(r.x, r.h - sc * 0.3, r.z),
      _q.setFromEuler(_e.set(r.gx * 0.35 + (r.r2 - 0.5) * 0.4, r.r3 * 6.283, r.gz * 0.35 + (r.r1 - 0.5) * 0.4)),
      _s.set(sc * (0.8 + r.r2 * 0.6), sc * (0.55 + r.r1 * 0.5), sc * (0.8 + r.r3 * 0.6))
    );
    rocks.setMatrixAt(i, _m);
    const v = 0.80 + 0.45 * r.r2;
    col.setRGB(v * 1.05, v, v * 0.9);
    rocks.setColorAt(i, col);
  }
  rocks.count = rockSpots.length;
  rocks.instanceMatrix.needsUpdate = true;
  if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
  rocks.computeBoundingSphere();
  group.add(rocks);

  /* ---------------- 统计（debug 时打印一次） ---------------- */
  let tri = 0;
  let calls = 0;
  group.traverse((obj) => {
    const g = obj.geometry;
    if (!g || !obj.isMesh) return;
    const n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    tri += n * (obj.isInstancedMesh ? obj.count : 1);
    calls++;
  });
  if (o.debug) {
    console.info('[terrain] triangles≈' + Math.round(tri) + ' drawCalls=' + calls + ' trees=' + trees.length + ' rocks=' + rockSpots.length);
  }

  /* ---------------- tick：只做缓动插值，不分配对象 ---------------- */
  const emissiveBase = new THREE.Color(0x2a1608);
  let lastEased = -1;

  function tick(view) {
    const eased = view && typeof view.eased === 'number' ? clamp(view.eased, 0, 1) : 1;
    /* day 让"天亮之后"的山林也继续动一点点：真实光照接管之后，
     * 自发光的暖调要慢慢退下去（否则第 60 帧后整个世界就被冻住）。 */
    const day = view && typeof view.day === 'number' ? clamp(view.day, 0, 1) : 0;
    const dk = day * day * (3 - 2 * day);
    const key = eased - 0.10 * dk;
    if (Math.abs(key - lastEased) < 0.0008) return;
    lastEased = key;
    // 朝阳面的暖色自发光：eased=0 时全黑，随日出缓慢升起
    const e = eased * eased * (0.55 + 0.45 * eased) * (1 - 0.18 * dk);
    groundMat.emissive.setRGB(emissiveBase.r * e, emissiveBase.g * e, emissiveBase.b * e);
    rockMat.emissive.setRGB(emissiveBase.r * e * 0.8, emissiveBase.g * e * 0.8, emissiveBase.b * e * 0.8);
    treeMat.emissive.setRGB(0.05 * e, 0.042 * e, 0.030 * e);
  }

  function dispose() {
    group.clear();
    forest.dispose();
    rocks.dispose();
    for (let i = 0; i < disposables.length; i++) {
      const d = disposables[i];
      if (d && d.dispose) d.dispose();
    }
    disposables.length = 0;
  }

  return { object3D: group, tick, dispose };
}