/**
 * 心光 · 首屏（黑场打字机）
 * ------------------------------------------------------------------
 * 零依赖：本文件不引用任何模块、不加载任何外部资源（字体栈写死系统衬线），
 * 被打包成单文件（心光.html）后在 file:// 下双击打开依然工作。
 *
 * 用法：
 *   const intro = createIntro();     // 同步挂上覆盖层，并开始逐字打字
 *   intro.done.then(() => { ... });  // 淡出 + DOM 移除之后 resolve
 *   intro.close();                   // 立刻开始淡出（幂等，可重复调用）
 *   intro.isOpen;                    // 当前是否还盖着（'closed' 之前都是 true）
 *
 * 状态机：typing → ready → closing → closed
 *   typing   正在逐字打字；点击 / 按键 = 立刻补全（进入 ready，不关闭）
 *   ready    文字已完整，"轻触开始"呼吸闪烁；点击 / 按键 = 关闭
 *   closing  淡出中（900ms），仍然吞掉指针与键盘事件
 *   closed   覆盖层已 remove()，done 已 resolve，所有监听已摘除
 *
 * 事件策略（关键）：覆盖层在 window 的捕获阶段接管 pointerdown / pointerup /
 * click / wheel / keydown，preventDefault + stopPropagation，
 * 所以主程序 #stage 的 pointerup（升一帧太阳）与 window keydown（空格 = 升一帧）
 * 在首屏期间一帧都不会收到。
 */

export function createIntro() {
  var FADE_MS = 900;
  var FIRST_DELAY_MS = 420;
  var STYLE_ID = 'xg-intro-style';

  /* ------------------------------------------------------------ 文案与节奏 */

  var LINES = [
    { kind: 'title', text: '心光', speed: 108, gap: 600 },
    { kind: 'sub', text: '一念升起，天地渐明', speed: 92, gap: 600 },
    { kind: 'body', text: '这是一片会亮起来的森林、海与山川。', speed: 82, gap: 540 },
    { kind: 'body', text: '轻触画面，太阳便升起一帧。', speed: 82, gap: 540 },
    { kind: 'body', text: '呼吸，跟着光，慢慢看清。', speed: 82, gap: 620 }
  ];

  /* 标点后的停顿（毫秒） */
  var PAUSE_AFTER = {
    '，': [260, 340],
    '、': [240, 320],
    '。': [340, 420],
    '；': [300, 380],
    '：': [260, 340],
    '…': [300, 400],
    '—': [300, 400]
  };

  /* 固定种子的伪随机：打字节奏有抖动，但每次打开都一样，方便自动化比对 */
  var seed = 0x9e3779b9;
  function rand() {
    seed = (seed + 0x6d2b79f5) | 0;
    var t = seed;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* ------------------------------------------------------------ 样式注入 */

  var CSS = [
    '.xg-intro {',
    '  position: fixed;',
    '  inset: 0;',
    '  z-index: 9999;',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  padding: clamp(22px, 5.5vw, 88px);',
    '  margin: 0;',
    '  background:',
    '    radial-gradient(118% 88% at 50% 108%, rgba(9, 15, 30, 0.92) 0%, rgba(5, 7, 15, 0.97) 56%, #04060c 100%),',
    '    #04060c;',
    '  color: #f6efe4;',
    '  font-family: "Songti SC", "STSong", "Source Han Serif SC", "Noto Serif SC", "SimSun", ui-serif, serif;',
    '  font-synthesis: none;',
    '  -webkit-font-smoothing: antialiased;',
    '  text-rendering: optimizeLegibility;',
    '  overflow: hidden;',
    '  cursor: default;',
    '  user-select: none;',
    '  -webkit-user-select: none;',
    '  -webkit-tap-highlight-color: transparent;',
    '  touch-action: none;',
    '  opacity: 1;',
    '  transform: scale(1);',
    '  filter: blur(0);',
    '  transition:',
    '    opacity 900ms cubic-bezier(0.22, 0.61, 0.36, 1),',
    '    transform 900ms cubic-bezier(0.22, 0.61, 0.36, 1),',
    '    filter 900ms cubic-bezier(0.22, 0.61, 0.36, 1);',
    '  will-change: opacity, transform, filter;',
    '}',
    '',
    '.xg-intro * { box-sizing: border-box; }',
    '',
    '.xg-intro-inner {',
    '  display: flex;',
    '  flex-direction: column;',
    '  align-items: center;',
    '  text-align: center;',
    '  gap: clamp(12px, 2.2vh, 24px);',
    '  max-width: min(36em, 94vw);',
    '}',
    '',
    '.xg-intro-line {',
    '  margin: 0;',
    '  padding: 0;',
    '  font-weight: 400;',
    '  letter-spacing: 0.12em;',
    '  line-height: 1.9;',
    '  min-height: 1.9em;',
    '}',
    '',
    '.xg-intro-line--title {',
    '  font-size: clamp(42px, 8.6vw, 84px);',
    '  line-height: 1.36;',
    '  min-height: 1.36em;',
    '  letter-spacing: 0.3em;',
    '  text-indent: 0.3em;',
    '  color: #ffcb8a;',
    '  text-shadow: 0 0 30px rgba(255, 203, 138, 0.26), 0 0 78px rgba(255, 168, 96, 0.16);',
    '}',
    '',
    '.xg-intro-line--sub {',
    '  font-size: clamp(15px, 2.1vw, 20px);',
    '  letter-spacing: 0.24em;',
    '  text-indent: 0.24em;',
    '  color: rgba(246, 239, 228, 0.6);',
    '}',
    '',
    '.xg-intro-body {',
    '  display: flex;',
    '  flex-direction: column;',
    '  align-items: center;',
    '  gap: clamp(0px, 0.8vh, 8px);',
    '}',
    '',
    '.xg-intro-line--body {',
    '  font-size: clamp(14px, 1.55vw, 17px);',
    '  line-height: 2.1;',
    '  letter-spacing: 0.12em;',
    '  color: rgba(246, 239, 228, 0.8);',
    '}',
    '',
    '.xg-intro-caret {',
    '  display: inline-block;',
    '  width: 1px;',
    '  height: 1em;',
    '  margin-left: 0.16em;',
    '  vertical-align: -0.12em;',
    '  background: #ffcb8a;',
    '  box-shadow: 0 0 8px rgba(255, 203, 138, 0.5);',
    '  animation: xg-intro-blink 1.06s steps(1, end) infinite;',
    '}',
    '',
    '.xg-intro-hint {',
    '  margin: clamp(10px, 3vh, 30px) 0 0;',
    '  padding: 0;',
    '  font-size: clamp(12px, 1.4vw, 14px);',
    '  letter-spacing: 0.42em;',
    '  text-indent: 0.42em;',
    '  color: rgba(255, 203, 138, 0.92);',
    '  opacity: 0;',
    '  transition: opacity 700ms cubic-bezier(0.22, 0.61, 0.36, 1);',
    '}',
    '',
    '.xg-intro.is-ready .xg-intro-hint { opacity: 1; }',
    '.xg-intro.is-ready .xg-intro-hint-inner { animation: xg-intro-breathe 3.6s cubic-bezier(0.4, 0, 0.2, 1) infinite; }',
    '.xg-intro.is-ready .xg-intro-caret { animation-duration: 1.7s; opacity: 0.75; }',
    '',
    '.xg-intro.is-closing {',
    '  opacity: 0;',
    '  transform: scale(1.035);',
    '  filter: blur(7px);',
    '}',
    '',
    '@keyframes xg-intro-blink {',
    '  0%, 49% { opacity: 1; }',
    '  50%, 100% { opacity: 0; }',
    '}',
    '',
    '@keyframes xg-intro-breathe {',
    '  0%, 100% { opacity: 0.45; }',
    '  50% { opacity: 1; }',
    '}',
    '',
    '@media (prefers-reduced-motion: reduce) {',
    '  .xg-intro-caret { animation: none; opacity: 0.8; }',
    '  .xg-intro.is-ready .xg-intro-hint-inner { animation: none; opacity: 1; }',
    '  .xg-intro { transition-duration: 400ms; }',
    '}'
  ].join('\n');

  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------ DOM 结构 */

  var root = document.createElement('div');
  root.className = 'xg-intro';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', '心光 · 序');
  root.setAttribute('data-state', 'typing');

  var inner = document.createElement('div');
  inner.className = 'xg-intro-inner';
  root.appendChild(inner);

  var lineEls = [];
  var textEls = [];
  var bodyGroup = null;

  for (var li = 0; li < LINES.length; li++) {
    var def = LINES[li];
    var p = document.createElement('p');
    p.className = 'xg-intro-line xg-intro-line--' + def.kind;
    var span = document.createElement('span');
    span.className = 'xg-intro-text';
    p.appendChild(span);

    if (def.kind === 'body') {
      if (!bodyGroup) {
        bodyGroup = document.createElement('div');
        bodyGroup.className = 'xg-intro-body';
        inner.appendChild(bodyGroup);
      }
      bodyGroup.appendChild(p);
    } else {
      inner.appendChild(p);
    }

    lineEls.push(p);
    textEls.push(span);
  }

  var caret = document.createElement('i');
  caret.className = 'xg-intro-caret';
  caret.setAttribute('aria-hidden', 'true');

  var hint = document.createElement('p');
  hint.className = 'xg-intro-hint';
  hint.setAttribute('aria-hidden', 'true');
  var hintInner = document.createElement('span');
  hintInner.className = 'xg-intro-hint-inner';
  hintInner.textContent = '轻触开始';
  hint.appendChild(hintInner);
  inner.appendChild(hint);

  var mount = document.body || document.documentElement;
  mount.appendChild(root);

  /* ------------------------------------------------------------ 状态与打字机 */

  var state = 'typing';
  var timer = 0;
  var closeTimer = 0;
  var activeLine = -1;
  var qi = 0;
  var resolveDone = null;
  var done = new Promise(function (resolve) { resolveDone = resolve; });

  function setState(next) {
    state = next;
    root.setAttribute('data-state', next);
  }

  var queue = [];
  for (var l = 0; l < LINES.length; l++) {
    var d = LINES[l];
    var chars = Array.from(d.text);
    for (var c = 0; c < chars.length; c++) {
      var ch = chars[c];
      var isLast = c === chars.length - 1;
      var delay;
      if (isLast) {
        delay = d.gap;
      } else if (PAUSE_AFTER[ch]) {
        var range = PAUSE_AFTER[ch];
        delay = range[0] + rand() * (range[1] - range[0]);
      } else {
        delay = d.speed + (rand() * 2 - 1) * 9;
        if (delay < 80) delay = 80;
        if (delay > 110) delay = 110;
      }
      queue.push({ line: l, ch: ch, delay: delay });
    }
  }

  function moveCaret(line) {
    if (caret.parentNode) caret.parentNode.removeChild(caret);
    lineEls[line].appendChild(caret);
  }

  function typeStep() {
    if (state !== 'typing') return;
    var item = queue[qi];
    if (!item) { finishTyping(); return; }
    qi++;
    if (item.line !== activeLine) {
      activeLine = item.line;
      moveCaret(item.line);
    }
    textEls[item.line].textContent += item.ch;
    timer = window.setTimeout(typeStep, item.delay);
  }

  function finishTyping() {
    if (state !== 'typing') return;
    window.clearTimeout(timer);
    timer = 0;
    qi = queue.length;
    for (var i = 0; i < LINES.length; i++) textEls[i].textContent = LINES[i].text;
    activeLine = LINES.length - 1;
    moveCaret(activeLine);
    setState('ready');
    root.classList.add('is-ready');
    hint.setAttribute('aria-hidden', 'false');
  }

  function close() {
    if (state === 'closed' || state === 'closing') return;
    if (state === 'typing') finishTyping();
    setState('closing');
    root.classList.add('is-closing');
    root.setAttribute('aria-hidden', 'true');
    window.clearTimeout(timer);
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(finishClose, FADE_MS + 40);
  }

  function finishClose() {
    if (state === 'closed') return;
    window.clearTimeout(closeTimer);
    closeTimer = 0;
    setState('closed');
    removeListeners();
    if (root.parentNode) root.parentNode.removeChild(root);
    if (resolveDone) {
      var r = resolveDone;
      resolveDone = null;
      r();
    }
  }

  function advance() {
    if (state === 'typing') { finishTyping(); return; }
    if (state === 'ready') { close(); return; }
  }

  /* ------------------------------------------------------------ 事件：全部在 window 捕获阶段吞掉 */

  var opts = { capture: true, passive: false };
  var BLOCK_DEFAULT = {
    ' ': 1, 'Spacebar': 1, 'Enter': 1, 'ArrowRight': 1, 'ArrowLeft': 1,
    'ArrowUp': 1, 'ArrowDown': 1, 'PageUp': 1, 'PageDown': 1, 'Home': 1, 'End': 1, 'Tab': 1
  };

  function swallow(e) {
    if (state === 'closed') return false;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    return true;
  }

  function onPointerDown(e) {
    if (!swallow(e)) return;
    if (e.pointerType === 'mouse' && typeof e.button === 'number' && e.button !== 0) return;
    advance();
  }

  function onSwallow(e) {
    swallow(e);
  }

  function onKeyDown(e) {
    if (state === 'closed') return;
    if (e.cancelable && BLOCK_DEFAULT[e.key]) e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    if (e.repeat) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' || e.key === 'ArrowRight') advance();
  }

  function onKeyUp(e) {
    if (state === 'closed') return;
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
  }

  var LISTENERS = [
    ['pointerdown', onPointerDown],
    ['pointerup', onSwallow],
    ['click', onSwallow],
    ['dblclick', onSwallow],
    ['mousedown', onSwallow],
    ['mouseup', onSwallow],
    ['touchstart', onSwallow],
    ['touchend', onSwallow],
    ['wheel', onSwallow],
    ['contextmenu', onSwallow],
    ['keydown', onKeyDown],
    ['keyup', onKeyUp]
  ];

  function addListeners() {
    for (var i = 0; i < LISTENERS.length; i++) {
      window.addEventListener(LISTENERS[i][0], LISTENERS[i][1], opts);
    }
  }

  function removeListeners() {
    for (var i = 0; i < LISTENERS.length; i++) {
      window.removeEventListener(LISTENERS[i][0], LISTENERS[i][1], opts);
    }
  }

  addListeners();

  /* ------------------------------------------------------------ 自动化测试钩子 */

  window.__XG_INTRO__ = {
    get state() { return state; },
    get isOpen() { return state !== 'closed'; },
    finishTyping: finishTyping,
    close: close,
    root: root
  };

  timer = window.setTimeout(typeStep, FIRST_DELAY_MS);

  return {
    done: done,
    close: close,
    get isOpen() { return state !== 'closed'; },
    get state() { return state; }
  };
}
