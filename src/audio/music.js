/**
 * 心光 · 生成式音乐（WebAudio 实时合成）
 * ==================================================================
 * 零依赖、零外部文件：所有声音都由 OscillatorNode / BiquadFilterNode /
 * ConvolverNode / StereoPannerNode 现场合成，不加载任何 mp3/ogg/采样。
 * 整个文件只有一个导出：createMusic()。
 *
 * 音乐设计
 *   · 调性 C 大调 / A 小调色彩，纯五声（C D E G A）+ 七和弦，
 *     任意叠加都不刺耳；速度 60 BPM，4/4，一小节 4 秒。
 *   · 4 小节一个和声循环，循环 2 次（8 小节）换一个变体进行，
 *     4 套进行轮转，最长的重复周期是 32 小节（约 2 分钟）。
 *   · 分层：pad / bass / 旋律 / 高音铃 / 环境床，各自独立 gain，
 *     随 eased（0=黎明之前，1=天光大亮）逐层淡入。
 *   · 混响用程序生成的 3 秒指数衰减立体声脉冲响应，wet 0.38。
 *   · 母带：lowpass（2.0k → 4.0k）+ 极轻 compressor + 0.8 的限幅增益
 *     + master（0.10 → 0.22）。
 *   · 环境床：棕噪声 → lowpass 320Hz，0.075Hz 的 LFO 做极缓的"呼吸"，
 *     只当底噪，不参与旋律。
 *   · 全部包络用 setValueAtTime + linear/exponentialRamp，音符结束后
 *     在 onended 里 disconnect，不会留下咔嗒声。
 *
 * 调度
 *   · lookahead 调度器：setInterval 200ms，每次把 1.5s 之内的小节
 *     按 ctx.currentTime 的绝对时间排好。后台标签页节流也不会散架。
 *   · update(eased) 每帧调用，只做参数平滑 + 跨小节时排布，
 *     不会每帧创建节点。
 */

/* ---------------------------------------------------------------- 时间常量 */

const BPM = 60;
const BEATS_PER_BAR = 4;
const SPB = 60 / BPM;                 // 一拍 1 秒
const BAR = SPB * BEATS_PER_BAR;      // 一小节 4 秒
const LOOKAHEAD_MS = 200;             // 调度器心跳
const SCHEDULE_AHEAD = 1.5;           // 提前排布多久
const RENDER_SR = 44100;
const RENDER_EASED = 0.85;            // renderOffline 用的固定"天亮程度"

/* ---------------------------------------------------------------- 小工具 */

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};
/** MIDI 音高 → 频率 */
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** mulberry32：小而快的可复现伪随机（内联，保持单文件零 import） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------- 和声 */

/**
 * 和弦表。root 是低音声部的音高（C3 = 48 附近，80~130Hz，不闷不飘）；
 * pad 是和弦铺底的四声部（C4 附近），相邻和弦之间有共同音，连接平滑。
 */
const CHORDS = {
  Cmaj7: { root: 48, pad: [60, 64, 67, 71] },  // C  E  G  B
  Am7:   { root: 45, pad: [57, 60, 64, 67] },  // A  C  E  G
  Fmaj7: { root: 41, pad: [53, 57, 60, 64] },  // F  A  C  E
  G6:    { root: 43, pad: [55, 59, 62, 64] },  // G  B  D  E
  Em7:   { root: 40, pad: [52, 55, 59, 62] }   // E  G  B  D
};

for (const name in CHORDS) {
  const c = CHORDS[name];
  c.name = name;
  c.pcs = new Set();
  for (let i = 0; i < c.pad.length; i++) c.pcs.add(((c.pad[i] % 12) + 12) % 12);
}

/**
 * 和声进行（每个 4 小节一循环）。每 2 个循环换一套，
 * 所以每 8 小节换一次进行，32 小节之后才回到最开始那一套。
 */
const PROGS = [
  ['Cmaj7', 'Am7', 'Fmaj7', 'G6'],   // I – vi – IV – V
  ['Fmaj7', 'G6', 'Cmaj7', 'Am7'],   // IV – V – I – vi
  ['Cmaj7', 'G6', 'Am7', 'Fmaj7'],   // I – V – vi – IV
  ['Am7', 'Fmaj7', 'Cmaj7', 'Em7']   // vi – IV – I – iii
];

/** C 大调五声：C D E G A 的音级偏移（相对 C） */
const PENT = [0, 2, 4, 7, 9];

/** 音级 → MIDI。基准 C5 = 72；deg 每 +5 升高一个八度，-5 降低一个八度。 */
function degreeToMidi(deg) {
  const oct = Math.floor(deg / 5);
  const idx = ((deg % 5) + 5) % 5;
  return 72 + oct * 12 + PENT[idx];
}

/** 把音拉到最近的和弦音（只在强拍上用，保证旋律"落在和声里"） */
function snapToChord(midi, chord) {
  const pc = ((midi % 12) + 12) % 12;
  if (chord.pcs.has(pc)) return midi;
  for (let d = 1; d <= 3; d++) {
    if (chord.pcs.has(((midi + d) % 12 + 12) % 12)) return midi + d;
    if (chord.pcs.has(((midi - d) % 12 + 12) % 12)) return midi - d;
  }
  return midi;
}

/**
 * 旋律动机：4 小节一句，每个事件 = [小节内第几拍, 持续几拍, 音级]。
 * 有留白（整小节只有一个音甚至没有音），听起来才像呼吸而不是练习曲。
 */
const MOTIFS = [
  // A：上行的问答，第三小节回环，末小节落在低处
  [
    [[0, 2, 0], [2.5, 1.5, 2]],
    [[1, 1, 3], [2.5, 1.5, 4]],
    [[0, 2, 2], [2.5, 1.5, 0]],
    [[2, 2, -1]]
  ],
  // B：更空，只有三颗音，整小节留白
  [
    [[0, 3.5, 4]],
    [],
    [[1, 1, 2], [2.5, 1.5, 3]],
    [[0, 4, 0]]
  ],
  // C：节奏稍密，句尾挑高
  [
    [[0, 1, 0], [1.5, 1.5, 2], [3, 1, 3]],
    [[0, 2, 4], [3, 1, 2]],
    [[0, 2, 5]],
    [[1, 1, 3], [2.5, 1.5, 1]]
  ]
];

/* ---------------------------------------------------------------- 程序生成的声音素材 */

/** 立体声脉冲响应：指数衰减的噪声，尾音 3 秒，两头做柔化避免"拍手"感 */
function makeImpulse(ctx, seconds) {
  const sr = ctx.sampleRate;
  const len = Math.max(2, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, len, sr);
  const rnd = mulberry32(0x51ee9);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, 3.1) * Math.exp(-2.4 * t);
      const soft = Math.min(1, i / (sr * 0.018));   // 18ms 起音柔化
      const spread = ch === 0 ? 1.0 : 0.92;          // 左右不完全对称，空间更自然
      d[i] = (rnd() * 2 - 1) * env * soft * 0.62 * spread;
    }
  }
  return buf;
}

/** 棕噪声缓冲，首尾交叉淡化，loop 无缝（没有循环点的咔嗒） */
function makeNoise(ctx, seconds) {
  const sr = ctx.sampleRate;
  const len = Math.max(2, Math.floor(sr * seconds));
  const fade = Math.min(len >> 2, Math.floor(sr * 0.4));
  const buf = ctx.createBuffer(2, len, sr);
  const rnd = mulberry32(0xbeef17);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const raw = new Float32Array(len + fade);
    let last = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = rnd() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      raw[i] = last * 3.2;
    }
    for (let i = 0; i < fade; i++) {
      const k = i / fade;
      raw[i] = raw[i] * k + raw[len + i] * (1 - k);
    }
    for (let i = 0; i < len; i++) d[i] = raw[i];
  }
  return buf;
}

/* ---------------------------------------------------------------- 建图 */

/**
 * 建整张音频图。AudioContext 与 OfflineAudioContext 都能用（同一套代码）。
 * 返回的对象里带各层总线的引用，供排布与参数平滑使用。
 */
function buildGraph(ctx, destination, opts) {
  const o = opts || {};
  const mkGain = (v) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };

  const g = {
    ctx: ctx,
    offline: !!o.offline,
    enabled: true,
    currentEased: 0,
    nodes: []
  };

  /* ---- 混响：程序生成的立体声脉冲响应 ---- */
  const conv = ctx.createConvolver();
  conv.buffer = makeImpulse(ctx, 3.0);
  const revIn = mkGain(1);        // 发送总线入口
  const wet = mkGain(0.38);       // 湿声比例
  revIn.connect(conv);
  conv.connect(wet);

  /* ---- 母带链路：mix → tone(lowpass) → comp → trim(0.8) → master → analyser ---- */
  const mix = mkGain(1);

  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 2200;
  tone.Q.value = 0.4;

  let comp = null;
  if (typeof ctx.createDynamicsCompressor === 'function') {
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.knee.value = 20;
    comp.ratio.value = 1.8;
    comp.attack.value = 0.08;
    comp.release.value = 0.5;
  }

  const trim = mkGain(0.8);       // 母带之前的限幅增益：所有层加起来也不削波
  const master = mkGain(0.0001);  // 总音量，随 eased 从 0.10 升到 0.22

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.55;

  mix.connect(tone);
  if (comp) {
    tone.connect(comp);
    comp.connect(trim);
  } else {
    tone.connect(trim);
  }
  trim.connect(master);
  master.connect(analyser);
  analyser.connect(destination);
  wet.connect(mix);               // 湿声也过同样的母带

  /* ---- 分层总线：每层独立 gain，各自一条混响发送 ---- */
  const mkLayer = (level, send) => {
    const out = mkGain(0);
    out.connect(mix);
    const s = mkGain(send);
    out.connect(s);
    s.connect(revIn);
    return { out: out, send: s, level: level };
  };

  g.pad = mkLayer(1.0, 0.55);
  g.bass = mkLayer(1.0, 0.10);
  g.mel = mkLayer(1.0, 0.45);
  g.bell = mkLayer(1.0, 0.60);
  g.amb = mkLayer(0.50, 0.18);

  /* ---- 环境床：棕噪声 → lowpass，0.075Hz 的 LFO 让"浪"慢慢起伏 ---- */
  const ambSrc = ctx.createBufferSource();
  ambSrc.buffer = makeNoise(ctx, 6.0);
  ambSrc.loop = true;

  const ambHP = ctx.createBiquadFilter();
  ambHP.type = 'highpass';
  ambHP.frequency.value = 58;
  ambHP.Q.value = 0.5;

  const ambLP = ctx.createBiquadFilter();
  ambLP.type = 'lowpass';
  ambLP.frequency.value = 320;
  ambLP.Q.value = 0.55;

  const ambSwell = mkGain(1);
  const ambLfo = ctx.createOscillator();
  ambLfo.type = 'sine';
  ambLfo.frequency.value = 0.075;
  const ambLfoGain = mkGain(0.34);
  ambLfo.connect(ambLfoGain);
  ambLfoGain.connect(ambSwell.gain);

  ambSrc.connect(ambHP);
  ambHP.connect(ambLP);
  ambLP.connect(ambSwell);
  ambSwell.connect(g.amb.out);

  ambSrc.start(0);
  ambLfo.start(0);

  g.mix = mix;
  g.tone = tone;
  g.comp = comp;
  g.trim = trim;
  g.master = master;
  g.analyser = analyser;
  g.conv = conv;
  g.wet = wet;
  g.revIn = revIn;
  g.ambSrc = ambSrc;
  g.ambLfo = ambLfo;

  return g;
}

/**
 * 把 eased 映射到各层音量、总音量与低通频率。
 * smooth=true 用 setTargetAtTime（现场播放，永远不跳变）；
 * smooth=false 用 setValueAtTime + linearRamp（离线渲染，从 0 淡入 0.4s）。
 */
function applyEased(g, eased, when, smooth) {
  const e = clamp01(eased);
  const on = g.enabled ? 1 : 0;

  const t = {
    pad: g.pad.level * (0.62 + 0.38 * e) * on,
    bass: g.bass.level * smoothstep(0.10, 0.60, e) * on,
    mel: g.mel.level * smoothstep(0.20, 0.76, e) * on,
    bell: g.bell.level * smoothstep(0.40, 0.95, e) * on,
    amb: g.amb.level * (0.70 + 0.30 * e) * on,
    master: on ? (0.10 + 0.12 * e) : 0.0001,
    tone: 2000 + 2000 * e
  };

  const layers = ['pad', 'bass', 'mel', 'bell', 'amb'];

  if (smooth) {
    for (let i = 0; i < layers.length; i++) {
      const p = g[layers[i]].out.gain;
      p.cancelScheduledValues(when);
      p.setTargetAtTime(t[layers[i]], when, 1.0);
    }
    g.master.gain.cancelScheduledValues(when);
    g.master.gain.setTargetAtTime(t.master, when, 0.7);
    g.tone.frequency.cancelScheduledValues(when);
    g.tone.frequency.setTargetAtTime(t.tone, when, 1.4);
  } else {
    for (let i = 0; i < layers.length; i++) {
      const p = g[layers[i]].out.gain;
      p.setValueAtTime(0, 0);
      p.linearRampToValueAtTime(t[layers[i]], 0.4);
    }
    g.master.gain.setValueAtTime(0.0001, 0);
    g.master.gain.linearRampToValueAtTime(t.master, 0.4);
    g.tone.frequency.setValueAtTime(t.tone, 0);
  }

  g.currentEased = e;
}

/* ---------------------------------------------------------------- 单音发声 */

/**
 * 一个会自己收尾的音：osc → env（attack / hold / release）→ panner → dest。
 * 起音从 0.0001 指数上升、结束前一定有 release，osc.stop 之后在 onended 里
 * disconnect —— 所以不会有咔嗒声，也不会留下泄漏的节点。
 */
function voice(ctx, dest, cfg) {
  const t0 = cfg.t0;
  const attack = Math.max(0.002, cfg.attack);
  const hold = Math.max(0, cfg.hold);
  const release = Math.max(0.05, cfg.release);
  const peak = Math.max(0.0002, cfg.peak);
  const end = t0 + attack + hold + release;

  const osc = ctx.createOscillator();
  osc.type = cfg.type || 'sine';
  osc.frequency.setValueAtTime(cfg.freq, t0);
  if (cfg.freqEnd && cfg.freqEnd > 0) {
    osc.frequency.exponentialRampToValueAtTime(cfg.freqEnd, end);
  }
  if (cfg.detune) osc.detune.setValueAtTime(cfg.detune, t0);
  if (cfg.detuneEnd) osc.detune.linearRampToValueAtTime(cfg.detuneEnd, end);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  env.gain.setValueAtTime(peak, t0 + attack + hold);
  env.gain.exponentialRampToValueAtTime(0.0001, end);

  let tail = env;
  let panner = null;
  if (typeof ctx.createStereoPanner === 'function' && cfg.pan !== undefined) {
    panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(clamp(cfg.pan, -1, 1), t0);
    env.connect(panner);
    tail = panner;
  }
  tail.connect(dest);
  osc.connect(env);

  osc.start(t0);
  osc.stop(end + 0.05);
  osc.onended = () => {
    try {
      osc.disconnect();
      env.disconnect();
      if (panner) panner.disconnect();
    } catch (err) { /* 已经断开过了 */ }
  };
  return osc;
}

/* ---------------------------------------------------------------- 逐层排布 */

/** pad：每小节 4 个和弦音，1.2~2.3s 慢起音，跨到下一小节才收尾，互相叠成持续和声 */
function schedulePad(ctx, g, chord, t0, rnd) {
  let n = 0;
  const count = chord.pad.length;
  for (let i = 0; i < count; i++) {
    const midi = chord.pad[i];
    const start = t0 + i * 0.045;                 // 轻微错开，避免"齐刷刷"地拍下来
    const attack = 1.2 + rnd() * 1.1;
    const hold = BAR * 0.85 + rnd() * 0.5;
    const release = 2.0 + rnd() * 1.0;
    const pan = (i - (count - 1) / 2) * 0.20;
    voice(ctx, g.pad.out, {
      type: 'sine', freq: mtof(midi), t0: start,
      attack: attack, hold: hold, release: release,
      peak: 0.135, pan: pan
    });
    // 三角波做一点点合唱，音色厚一点但不刺
    voice(ctx, g.pad.out, {
      type: 'triangle', freq: mtof(midi), t0: start,
      attack: attack * 1.15, hold: hold, release: release * 1.1,
      peak: 0.056, pan: pan, detune: 6
    });
    n += 2;
  }
  return n;
}

/** bass：每小节一个根音，sine，0.05s 起音、1.6s 释放，全曲最轻的一层 */
function scheduleBass(ctx, g, chord, t0) {
  voice(ctx, g.bass.out, {
    type: 'sine',
    freq: mtof(chord.root),
    t0: t0,
    attack: 0.05,
    hold: 2.2,
    release: 1.6,
    peak: 0.16,
    pan: 0
  });
  return 1;
}

/**
 * 旋律：拨弦感（triangle + 指数衰减 1.2~2.5s）。
 * 每 8 小节换一个动机；每个动机的第 2 次循环做变化（后半句移高八度、
 * 末音改落点），所以同一个句子不会原样重复。
 */
function scheduleMelody(ctx, g, chord, t0, barIndex, eased, rnd) {
  const cycle = Math.floor(barIndex / 4);
  const barInCycle = barIndex % 4;
  const motif = MOTIFS[Math.floor(cycle / 2) % MOTIFS.length];
  const variant = (cycle % 2) === 1;
  const events = motif[barInCycle] || [];
  let n = 0;

  for (let i = 0; i < events.length; i++) {
    const beat = events[i][0];
    const dur = events[i][1];
    let deg = events[i][2];

    if (variant) {
      if (barInCycle >= 2) deg += 5;                       // 后半句抬高八度
      if (barInCycle === 3 && i === events.length - 1) {
        deg += (rnd() < 0.5 ? 1 : -1);                     // 末音换个落点
      }
    }

    let midi = degreeToMidi(deg);
    if (beat === 0) midi = snapToChord(midi, chord);       // 强拍落在和声里
    // 偶数小节偶尔把整句抬高八度，让同一动机有明暗对比（不改变旋律走向）
    if (barIndex % 2 === 0 && rnd() < 0.30) midi += 12;
    midi = clamp(midi, 64, 96);                            // G4..C7，别刺耳

    const start = t0 + beat * SPB;
    const decay = clamp(1.2 + dur * 0.4, 1.2, 2.5);
    voice(ctx, g.mel.out, {
      type: 'triangle',
      freq: mtof(midi),
      t0: start,
      attack: 0.008,
      hold: 0.02,
      release: decay,
      peak: 0.50,
      pan: (rnd() * 2 - 1) * 0.35,
      detune: 0,
      detuneEnd: -5                                     // 尾音轻轻下沉，像拨弦的余韵
    });
    n += 1;
  }
  return n;
}

/** 高音铃：每 4~8 小节偶尔一颗，长衰减 3~5s，左右轻微分开 */
function scheduleBell(ctx, g, barIndex, t0, rnd) {
  if (barIndex % 4 !== 2) return 0;
  if (rnd() > 0.55) return 0;
  const pool = [84, 88, 91, 96];                       // C6 E6 G6 C7
  const midi = pool[Math.floor(rnd() * pool.length)];
  voice(ctx, g.bell.out, {
    type: 'sine',
    freq: mtof(midi),
    t0: t0 + 1.0 + rnd() * 1.5,
    attack: 0.02,
    hold: 0.15,
    release: 3.0 + rnd() * 2.0,
    peak: 0.22,
    pan: (rnd() * 2 - 1) * 0.6
  });
  return 1;
}

/**
 * 排一小节。只创建节点、只写绝对时间，不读 ctx.currentTime，
 * 所以现场播放和离线渲染可以共用这一份代码。
 * 返回这一小节新建了多少个发声单元（stats().notesScheduled 靠它）。
 */
function scheduleBar(ctx, g, barIndex, t0, eased, rnd) {
  const e = clamp01(eased);
  const cycle = Math.floor(barIndex / 4);
  const prog = PROGS[Math.floor(cycle / 2) % PROGS.length];
  const chord = CHORDS[prog[barIndex % 4]];
  let n = 0;

  n += schedulePad(ctx, g, chord, t0, rnd);

  if (e > 0.06) n += scheduleBass(ctx, g, chord, t0);
  if (e > 0.14) n += scheduleMelody(ctx, g, chord, t0, barIndex, e, rnd);
  if (e > 0.36) n += scheduleBell(ctx, g, barIndex, t0, rnd);

  return n;
}

/* ---------------------------------------------------------------- 离线渲染 */

/** 16bit PCM WAV → base64（只给测试/试听用，正常播放完全不需要） */
function encodeWavBase64(buf) {
  const chs = buf.numberOfChannels;
  const frames = buf.length;
  const bytes = 44 + frames * chs * 2;
  const ab = new ArrayBuffer(bytes);
  const dv = new DataView(ab);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  dv.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, chs, true);
  dv.setUint32(24, buf.sampleRate, true);
  dv.setUint32(28, buf.sampleRate * chs * 2, true);
  dv.setUint16(32, chs * 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, frames * chs * 2, true);

  const chans = [];
  for (let c = 0; c < chs; c++) chans.push(buf.getChannelData(c));

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < chs; c++) {
      const v = clamp(chans[c][i], -1, 1);
      dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }

  const u8 = new Uint8Array(ab);
  let out = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return btoa(out);
}

/* ---------------------------------------------------------------- 主入口 */

/**
 * 心光 · 音乐
 * 返回 { setEnabled, update, stats, renderOffline }
 */
export function createMusic() {
  let ctx = null;
  let graph = null;
  let built = false;
  let enabled = false;
  let startTime = 0;
  let nextBarTime = 0;
  let notesScheduled = 0;
  let lastBar = -1;
  let curEased = 0;
  let lastApplied = -1;
  let timer = null;

  const rnd = mulberry32(0x51a9c0);

  /** lookahead 调度：把 1.5s 之内的小节全部按绝对时间排好 */
  function scheduleUntil() {
    if (!ctx || !graph || !enabled) return;
    const now = ctx.currentTime;
    let guard = 0;
    while (nextBarTime < now + SCHEDULE_AHEAD && guard < 8) {
      // 标签页被节流太久，落点已经过去了：跳到最近的网格点，别补一堆过去的小节
      if (nextBarTime < now - 0.25) {
        const k = Math.ceil((now + 0.12 - startTime) / BAR);
        nextBarTime = startTime + k * BAR;
      }
      const barIndex = Math.round((nextBarTime - startTime) / BAR);
      notesScheduled += scheduleBar(ctx, graph, barIndex, nextBarTime, curEased, rnd);
      lastBar = barIndex;
      nextBarTime += BAR;
      guard++;
    }
  }

  function startTimer() {
    if (timer !== null) return;
    if (typeof setInterval !== 'function') return;
    timer = setInterval(() => {
      try { scheduleUntil(); } catch (err) { /* 单次排布失败不该让音乐停摆 */ }
    }, LOOKAHEAD_MS);
  }

  function ensureCtx() {
    if (ctx) return true;
    const Ctor = (typeof window !== 'undefined') &&
      (window.AudioContext || window.webkitAudioContext);
    if (!Ctor) return false;
    try {
      ctx = new Ctor();
    } catch (err) {
      ctx = null;
      return false;
    }
    return true;
  }

  function ensureGraph() {
    if (graph) return true;
    if (!ensureCtx()) return false;
    try {
      graph = buildGraph(ctx, ctx.destination, { offline: false });
    } catch (err) {
      graph = null;
      return false;
    }
    built = true;
    graph.enabled = false;
    startTime = ctx.currentTime;
    nextBarTime = startTime + 0.35;   // 第一小节半拍之后进，不"砸"下来
    applyEased(graph, curEased, startTime, true);
    startTimer();
    return true;
  }

  return {
    /**
     * 开 / 关。幂等。
     * on=true：还没建图就建图，并 ctx.resume()；on=false：淡出到 0，不 stop 任何东西。
     */
    setEnabled(on) {
      const want = !!on;
      if (want) {
        if (!ensureGraph()) { enabled = false; return; }
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          try {
            const p = ctx.resume();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch (err) { /* 自动播放策略拒绝时保持 suspended，等用户手势 */ }
        }
        enabled = true;
        graph.enabled = true;
        if (nextBarTime < ctx.currentTime - 0.25) {
          const k = Math.ceil((ctx.currentTime + 0.12 - startTime) / BAR);
          nextBarTime = startTime + k * BAR;
        }
        applyEased(graph, curEased, ctx.currentTime, true);
        scheduleUntil();
      } else {
        enabled = false;
        if (graph) {
          graph.enabled = false;
          applyEased(graph, curEased, ctx.currentTime, true);
        }
      }
    },

    /** 每帧调用。只做参数平滑 + 跨小节时排布，不逐帧建节点。 */
    update(eased) {
      const e = clamp01(Number(eased) || 0);
      curEased = e;
      if (!ctx || !graph) return;
      if (lastApplied < 0 || Math.abs(e - lastApplied) > 0.0015) {
        applyEased(graph, e, ctx.currentTime, true);
        lastApplied = e;
      }
      scheduleUntil();
    },

    /** 现场状态 + 挂在 master 之后的 AnalyserNode 实测 rms / peak */
    stats() {
      const out = {
        enabled: enabled,
        ctxState: ctx ? ctx.state : 'none',
        built: built,
        bar: 0,
        beat: 0,
        notesScheduled: notesScheduled,
        rms: 0,
        peak: 0
      };
      if (ctx && built) {
        const el = Math.max(0, ctx.currentTime - startTime);
        out.bar = Math.floor(el / BAR);
        out.beat = Math.round(((el % BAR) / SPB) * 100) / 100;
      }
      if (graph && graph.analyser) {
        const buf = new Float32Array(graph.analyser.fftSize);
        graph.analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          sum += v * v;
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
        }
        out.rms = Math.round(Math.sqrt(sum / buf.length) * 100000) / 100000;
        out.peak = Math.round(peak * 100000) / 100000;
      }
      return out;
    },

    /**
     * 用 OfflineAudioContext 渲染同样长度的音乐并测量。
     * 复用 buildGraph / scheduleBar，所以它证明的就是现场那套图。
     * 返回 { peak, rms, seconds }（额外附带 secondsRms 逐秒 RMS，
     * 以及 opts.wav === true 时的 wavBase64，方便无头测试与试听）。
     */
    async renderOffline(seconds, opts) {
      const o = opts || {};
      const secs = Math.max(1, Math.min(120, Number(seconds) || 20));
      const Off = (typeof window !== 'undefined') &&
        (window.OfflineAudioContext || window.webkitOfflineAudioContext);
      if (!Off) return { peak: 0, rms: 0, seconds: secs, error: 'no OfflineAudioContext' };

      let off = null;
      try {
        off = new Off(2, Math.ceil(secs * RENDER_SR), RENDER_SR);
      } catch (err) {
        return { peak: 0, rms: 0, seconds: secs, error: 'OfflineAudioContext failed' };
      }

      const eased = clamp01(o.eased === undefined ? RENDER_EASED : Number(o.eased));
      const gOff = buildGraph(off, off.destination, { offline: true, eased: eased });
      gOff.enabled = true;
      applyEased(gOff, eased, 0, false);

      // 从 0.06s 开始按小节排布，一直排到渲染长度之后（尾音自然被截断）
      const rrnd = mulberry32(0x7e57);
      let t = 0.06;
      let bar = 0;
      while (t < secs) {
        scheduleBar(off, gOff, bar, t, eased, rrnd);
        bar++;
        t += BAR;
      }

      const buf = await off.startRendering();

      const ch0 = buf.getChannelData(0);
      const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
      const n = buf.length;

      let peak = 0;
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const a = ch0[i] < 0 ? -ch0[i] : ch0[i];
        const b = ch1[i] < 0 ? -ch1[i] : ch1[i];
        if (a > peak) peak = a;
        if (b > peak) peak = b;
        const m = (ch0[i] + ch1[i]) * 0.5;
        sum += m * m;
      }
      const rms = Math.sqrt(sum / Math.max(1, n));

      const secondsRms = [];
      const sr = buf.sampleRate;
      for (let s = 0; s < secs; s++) {
        const a = Math.floor(s * sr);
        const b = Math.min(n, Math.floor((s + 1) * sr));
        let ss = 0;
        let cnt = 0;
        for (let i = a; i < b; i++) {
          const m = (ch0[i] + ch1[i]) * 0.5;
          ss += m * m;
          cnt++;
        }
        secondsRms.push(Math.round(Math.sqrt(cnt ? ss / cnt : 0) * 100000) / 100000);
      }

      const out = {
        peak: Math.round(peak * 100000) / 100000,
        rms: Math.round(rms * 100000) / 100000,
        seconds: secs,
        secondsRms: secondsRms
      };
      if (o.wav === true) {
        try { out.wavBase64 = encodeWavBase64(buf); } catch (err) { out.wavBase64 = null; }
      }
      return out;
    }
  };
}
