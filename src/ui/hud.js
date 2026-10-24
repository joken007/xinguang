/**
 * 心光 · 界面层
 * ------------------------------------------------------------------
 * 只做三件事：把语录换掉、把进度显示出来、把按钮状态同步给主循环。
 * 场景与画面全部在 WebGL 里，这里只操作 DOM，不参与渲染循环。
 */

import { PHASES } from '../quotes.js';

const FADE_OUT_MS = 380;
const FADE_IN_MS = 60;

export function createHud() {
  const root = document.documentElement;
  const $ = (id) => document.getElementById(id);

  const el = {
    stage: $('stage'),
    quote: document.querySelector('.quote'),
    quoteText: $('quote-text'),
    quoteAuthor: $('quote-author'),
    hint: $('hint'),
    progressFill: $('progress-fill'),
    count: $('count'),
    phase: $('phase'),
    fps: $('fps'),
    curtain: $('curtain'),
    sunwash: $('sunwash'),
    vignette: $('vignette'),
    a11y: $('a11y-status'),
    btnAuto: $('btn-auto'),
    btnMotion: $('btn-motion'),
    btnSound: $('btn-sound'),
    btnReset: $('btn-reset'),
    fatal: $('fatal'),
    fatalReason: $('fatal-reason')
  };

  let swapToken = 0;
  let lastPhaseIndex = -1;
  let hintHidden = false;

  /** 换一条语录：淡出 → 换字 → 淡入。用 token 防止快速连点时乱序。 */
  function setQuote(item, immediate = false) {
    const token = ++swapToken;
    const apply = () => {
      el.quoteText.textContent = item.text;
      el.quoteAuthor.textContent = item.author || '';
      el.quoteAuthor.parentElement.style.visibility = item.author ? 'visible' : 'hidden';
      el.quote.classList.remove('is-out');
    };

    if (immediate) {
      apply();
      return;
    }

    el.quote.classList.add('is-out');
    window.setTimeout(() => {
      if (token !== swapToken) return; // 期间又点了，放弃这次
      apply();
    }, FADE_OUT_MS);
  }

  /** 进度：0..1 */
  function setProgress(ratio, count, total) {
    el.progressFill.style.width = (Math.max(0, Math.min(1, ratio)) * 100).toFixed(2) + '%';
    /* 60 帧之后太阳还在升：这时不再显示 "61 / 60"，改成继续往上计的"第 N 帧"，
     * 让页脚也承认"天光大亮不是终点"。 */
    el.count.textContent = count > total ? count + ' 帧' : count + ' / ' + total;

    /* 相位按"已经点了多少帧"算，而不是按正在追赶的平滑值算：
     * 否则快速连点到 60/60 之后，页脚会出现"60 / 60 · 晨光初照"这种自相矛盾的读数。 */
    const phaseRatio = total > 0 ? count / total : ratio;
    let phaseIndex = 0;
    for (let i = 0; i < PHASES.length; i++) {
      if (phaseRatio >= PHASES[i].at - 1e-6) phaseIndex = i;
    }
    if (phaseIndex !== lastPhaseIndex) {
      lastPhaseIndex = phaseIndex;
      el.phase.textContent = PHASES[phaseIndex].label;
      el.a11y.textContent = PHASES[phaseIndex].label;
    }
  }

  /** 页面暗场与暖洗：eased 0..1 是"天亮"进度，day 0..1 是"天亮之后"的白天进度。
   *  两个都变，DOM 层才不会在第 60 帧之后跟着画面一起冻住。 */
  function setAtmosphere(eased, day) {
    const d = day > 0 ? (day > 1 ? 1 : day) : 0;
    // 暗场不做成线性 —— 让开头几帧几乎全黑，中途才快速亮起来
    const curtain = Math.pow(1 - eased, 1.9) * (1 - 0.25 * d);
    el.curtain.style.opacity = (0.97 * curtain).toFixed(4);
    el.sunwash.style.opacity = (Math.min(1, Math.pow(eased, 2.2) * (1 + 0.15 * d)) * 0.9).toFixed(4);
    el.vignette.style.opacity = (0.38 + 0.5 * (1 - eased) - 0.05 * d).toFixed(4);
    root.style.setProperty('--ink-dim', 'rgba(246,239,228,' + Math.min(1, 0.42 + 0.24 * eased + 0.06 * d).toFixed(3) + ')');
    root.style.setProperty('--ink-faint', 'rgba(246,239,228,' + Math.min(1, 0.22 + 0.16 * eased + 0.05 * d).toFixed(3) + ')');
    root.style.setProperty('--quote-scrim', (0.08 + 0.18 * eased + 0.04 * d).toFixed(3));
  }

  function toggleHint(hidden) {
    if (hidden === hintHidden) return;
    hintHidden = hidden;
    el.hint.classList.toggle('is-hidden', hidden);
  }

  function setButton(which, on) {
    const map = { auto: el.btnAuto, motion: el.btnMotion, sound: el.btnSound };
    const btn = map[which];
    if (btn) btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function setFps(value) {
    el.fps.textContent = value ? value + ' fps' : '';
  }

  function showFatal(reason) {
    if (el.fatalReason) el.fatalReason.textContent = reason || '当前浏览器无法创建 WebGL 场景。';
    if (el.fatal) el.fatal.hidden = false;
  }

  return {
    el,
    setQuote,
    setProgress,
    setAtmosphere,
    toggleHint,
    setButton,
    setFps,
    showFatal
  };
}
