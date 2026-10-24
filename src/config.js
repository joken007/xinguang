/**
 * 心光 · 全局常量与共享接口
 * ------------------------------------------------------------------
 * 这个文件是各模块之间唯一的"契约"。改动它之前先确认所有调用方：
 *   - main.js           主循环 / 状态机
 *   - world/*.js        场景各层
 *   - post/composite.js 后期合成
 *   - ui/*.js           界面
 */

/** 第一阶段的帧数：60 次点击后天光大亮。
 *  注意这不是"终点"——满 60 帧之后太阳仍在继续升起（见 SUN_ELEVATION_MAX）。 */
export const TOTAL_TICKS = 60;

/** 每一"帧"（点击一次）亮度前进的比例，柔化指数让开头与结尾更从容 */
export const LIFT_EASE = 0.62;

/**
 * 场景相机与太阳的共用参数。
 * 太阳方位固定：正前方略偏右，因此"日落余晖"会在水面正中拉出一条光路。
 */
export const SUN_AZIMUTH = 0.06;          // 弧度，相对相机正前方偏右
export const SUN_ELEVATION_START = -0.155; // 开始时太阳在地平线下（约 -8.9°）
/**
 * 完全升起后的高度：+0.26 rad ≈ 14.9°。
 * 相机 fov 46°/俯角 2.5°，地平线在屏幕中线略下方，
 * 14.9° 大约对应屏高 25%~30% 的位置——太阳清晰地悬在海面之上，
 * 而不是"贴着水线的一条缝"。
 */
export const SUN_ELEVATION_END = 0.10;
/**
 * 太阳高度缓入指数：太阳在后半程明显往上爬，
 * elev = START + (END - START) * pow(eased, SUN_ELEVATION_EASE)
 * eased=0.55 时刚过海平线，1.0 时到最高点。
 */
export const SUN_ELEVATION_EASE = 1.55;
/**
 * "天光大亮"之后太阳还在往上爬，渐近地逼近这条高度（0.26 rad ≈ 14.9°）。
 * 相机 fov 46°、俯角约 5.4°，画面上缘大约在 +17.6°，
 * 所以 14.9° 时太阳圆盘仍完整留在画面里 —— 永远升不完，
 * 却也永远不会走出画面。
 */
export const SUN_ELEVATION_MAX = 0.26;
/**
 * 第二阶段上升的"尾巴"长度（单位：第一阶段 = 60 帧）。
 * elev = MAX - (MAX - END) * exp(-(progress - 1) / SUN_ELEVATION_TAIL)
 * 取 2.0 时，再点 60 帧才走完剩下的大约 39%，点 120 帧走完 63%：
 * 太阳一直在升，只是越来越慢。
 */
export const SUN_ELEVATION_TAIL = 2.0;
/**
 * 太阳高度的硬上限：0.285 rad ≈ 16.3°。
 * 画面上缘在 +17.6°（fov 46°、俯角 5.43°），太阳圆盘的角半径约 0.97°，
 * 16.3° + 0.97° = 17.3° < 17.6° —— 圆盘与日晕的核心始终留在画面里。
 */
export const SUN_ELEVATION_CEIL = 0.285;
/**
 * 说明：高度本身是"收敛"的（有界 + 单调 = 必有极限），所以"永远在升"这句话
 * 在数学上只能理解为"每一帧都还在升、永远升不完"。真正让世界不冻住的是
 * 下面的 DAY_FADE_TAIL（天色/雾/曝光/海面反光在天亮后继续演化）。
 */
/**
 * 软上限的过渡带宽（弧度）：离上限还有 3 个带宽时基本是线性，进入带内平滑减速，
 * 永远不越过 SUN_ELEVATION_CEIL，也不会出现"突然停住"的折点。
 * 取 0.02 时，高度最终稳定在 0.2561 rad ≈ 14.7°（距画面上缘还有约 2.9°）。
 */
export const SUN_ELEVATION_BAND = 0.02;
/**
 * "白天"阶段的时间常数（单位：第一阶段 = 60 帧）。
 * day = 1 - exp(-(progress - 1) / DAY_FADE_TAIL)：
 * 天光大亮之后天色、雾、曝光、海面反光继续演化，直到接近正午的清澈感 ——
 * 天亮了世界也不会"冻住"。p=2 时 ≈0.33，p=3 时 ≈0.55，p=6 时 ≈0.86。
 */
export const DAY_FADE_TAIL = 2.5;
/** 自动模式最多替用户点多少帧；到顶就停手，把戏演完不如把选择留给人。 */
export const AUTO_TICK_LIMIT = 90;
/**
 * 太阳高度（弧度）作为"平滑进度"的函数 —— 主循环与离屏渲染共用同一条曲线，
 * 保证实时画面与测试用的离线快照永远一致。
 *   p <= 1：缓动爬到 SUN_ELEVATION_END（天光大亮）
 *   p > 1 ：指数尾巴趋近 SUN_ELEVATION_MAX，再经连续软上限收敛到 ≈14.7°
 */
export function sunElevationAt(progress, eased) {
  const p = progress;
  const e = eased == null ? Math.min(1, Math.max(0, p)) : Math.min(1, Math.max(0, eased));
  if (p <= 1) {
    return SUN_ELEVATION_START + (SUN_ELEVATION_END - SUN_ELEVATION_START) * Math.pow(e, SUN_ELEVATION_EASE);
  }
  const raw = SUN_ELEVATION_MAX - (SUN_ELEVATION_MAX - SUN_ELEVATION_END) * Math.exp(-(p - 1) / SUN_ELEVATION_TAIL);
  const BAND = SUN_ELEVATION_BAND;
  // softcap(x) = CEIL - BAND*ln(1 + exp((CEIL - x)/BAND))：处处连续、单调、有界
  return SUN_ELEVATION_CEIL - BAND * Math.log(1 + Math.exp((SUN_ELEVATION_CEIL - raw) / BAND));
}
/** "白天"进度：天光大亮之后继续 0→1（天色/雾/曝光/海面反光靠它继续演化） */
export function dayAmountAt(progress) {
  return progress <= 1 ? 0 : 1 - Math.exp(-(progress - 1) / DAY_FADE_TAIL);
}
export const SUN_DISTANCE = 8000;

/** 一条把 day(0..1) 映射到扩展关键帧 t 的三次曲线：起步慢、末段快，接在原始末帧之后 */
export const DAY_RAMP = (day) => day * day * (3 - 2 * day);

/** 太阳颜色随高度：地平线处更红、更高处更白黄 */
export const SUN_NEAR_COLOR = [1.0, 0.44, 0.17];
export const SUN_MID_COLOR = [1.0, 0.68, 0.34];
export const SUN_HIGH_COLOR = [1.0, 0.93, 0.80];

/** 世界尺寸（米）。相机放在原点附近，海平面 y = 0 */
export const SEA_LEVEL = 0.0;
export const CAMERA_HEIGHT = 7.2;

/** 单个光源：太阳 */
export const SUN_LIGHT_INTENSITY = 3.0;

/** 地面材质的附加太阳方位（用于地形自定义光照注入） */
export const SUN_LIGHT_DIR = (elev) => {
  const ce = Math.cos(elev);
  return [Math.sin(SUN_AZIMUTH) * ce, Math.sin(elev), -Math.cos(SUN_AZIMUTH) * ce];
};
