# 心光 · 项目技术简报（实现契约）

> 这是一份**必须严格遵守**的接口与美术规范。所有模块由多个实现者并行编写，
> 拼接起来必须能直接跑起来。**不要修改其他模块的文件**，只写自己负责的文件。

## 0. 现状与运行方式

- 项目根目录：`E:\心光`
- 路径含中文字符，**不要用任何外部 CLI 工具**；改文件请用 write/edit 工具。
- three.js **r169** 已离线放在 `E:\心光\vendor\three.module.js`（ES Module，通过 importmap 映射为裸标识符 `three`）。
  `package.json` 里 `"type": "module"`。**不要**用 `import * as THREE from 'https://...'`，统一写 `import * as THREE from 'three';`
- 启动：`node serve.mjs`（零依赖静态服务器，默认 http://127.0.0.1:5173 ）。必须走 http，file:// 下 ES module 会被拦截。
- 视觉验收（Lead 会做，你也可以自己跑）：用 playwright-core 驱动 headless chromium 渲染并截图比对。
  **绝对不要**在 `E:\心光` 下创建 node_modules；需要跑脚本就写到 ASCII 路径的测试台 `E:\shiguang-testbed\`（已装好 playwright-core 和 three.js 副本），
  同步文件用 PowerShell 的 Copy-Item。node 可执行文件在
  `C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。

## 1. 一屏到底的产品体验

全屏 WebGL 场景：**森林 + 大海 + 山川**；画面中央是一条**正念语录**。
用户**每点一下屏幕**，太阳升高一"帧"（共 60 帧），整屏画面变亮一点点：
开头几乎全黑（只能隐约看见中央暖光），到结尾是金色晨光下能看清森林、山脉、海面倒影。
语录每点一次换一条（淡出淡入），未点击 12 秒后自动推进（可暂停）。

## 2. 模块与文件归属（write scope 不重叠）

| 文件 | 负责人 | 内容 |
|---|---|---|
| `src/world/sky.js` | worker-sky | 天空穹顶、太阳、日晕、云、星空 |
| `src/world/terrain.js` | worker-terrain | 前景森林/沙滩、左右山脉、远景山脊、顶点色 |
| `src/world/sea.js` | worker-sea | 海面波浪、太阳反射光路、近岸泡沫 |
| `src/post/composite.js` | worker-post | 场景渲染目标 + 合成通道（曝光曲线、暖色分离、暗角、暗角/颗粒） |
| `src/ui/hud.js` | Lead | DOM 界面（语录、进度、按钮） |
| `src/quotes.js` | Lead | 正念语录数据 |
| `src/main.js` | Lead | 主循环、状态机、指针交互 |
| `src/config.js` `src/util/noise.js` `src/util/resources.js` | Lead（已写好，可读不可改） | 共享常量、噪声、共享 uniform |
| `index.html` `src/styles.css` | Lead（已写好，可读不可改） | 外壳、暗场层 |

只有 `main.js` 会 import 各 world/post 模块。**各 world 模块之间不要互相 import**（只允许 import three 和 util/config）。

## 3. 统一的模块接口（必须实现）

```js
// 每个 world 模块导出一个工厂函数
import * as THREE from 'three';

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {{quality: 'high'|'low'}} opts   quality='low' 时减半细分/关闭次要效果
 * @returns {{ object3D: THREE.Object3D, tick: (view: ViewState) => void, dispose: () => void }}
 */
export function createSky(renderer, opts) { ... }
export function createTerrain(renderer, opts) { ... }   // 每个文件里导出名不同：createSky / createTerrain / createSea
```

`createSea(renderer, opts)` 返回的对象额外有 `tick(view, dt)`（波浪需要时间）。
其余对象 `tick(view)` 即可（不要求用 dt，但可以忽略）。

### ViewState（主循环每帧传给你）
```js
{
  progress: 0..1,      // 线性亮度进度（0 = 第一步之前，1 = 完全升起）
  eased: 0..1,         // 缓动后的进度，全部视觉插值用这个
  sunElevation: 弧度,   // -0.155 → 0.085（地平线下 → 略高于地平线）
  sunAzimuth: 0.06,     // 东经偏转，见 config.js SUN_AZIMUTH
  sunWorldDir: THREE.Vector3, // 世界空间：从场景中心指向太阳的单位向量（y 可为负）
  time: 秒,             // 累计时间
  motion: 0..1,         // 0 = 用户关闭了"流动"动画（降级安静模式），1 = 正常
  camera: THREE.PerspectiveCamera, // 只读
  resolution: { width, height, pixelRatio }
}
```

### 坐标与世界尺度
- 相机：位置 `(0, 7.2, 0)`，lookAt `(0, 9.5?, -100)`（Lead 负责设置；你按此设计构图）。**不要移动相机**。
- 相机朝向 **-Z**，正前方就是大海；**左边是森林海岸，右边是山**（左右可镜像，但必须两侧都有东西）。
- 海平面 y = 0。相机在岸上（高 7.2m），海从 `z ≈ -25` 一直延伸到 z = -4000。
- 太阳在正前方（-Z 方向），因此水面正中央会出现一条竖直的太阳光路 —— 这是画面的灵魂。
- 尺度单位 = 米。近距离物体细节要细（沙滩颗粒级别的噪声），远山要大气透视。

## 4. 色彩与光照规范（全项目统一）

- **只有一个光源**：主循环已创建好 `THREE.DirectionalLight`（太阳）与一个很弱的 `HemisphereLight`（天空光）。
  **场景里所有物体必须接收它**（MeshStandardMaterial 默认即接收）。**不要**再往场景里加 DirectionalLight / PointLight / SpotLight，也不要开阴影（lead 不开 shadowMap）。
- 夜间基调：#05070e ~ #0b1224（深蓝近黑）；黎明：#1b2a4a → 靛紫 #4a4a72；日出：#ff9d5c → #ffd9a0 → 天空顶 #7fa6c9。
- 颜色要用**线性空间**思维：three r169 默认 `ColorManagement.enabled` 与 `outputColorSpace = SRGBColorSpace`，
  `new THREE.Color(0xrrggbb)` 会自动转线性，可以直接用十六进制写。
- 目标画面：**低饱和、电影感、雾很重**。避免纯饱和的绿/蓝；草色偏青灰绿，山体偏蓝灰，岩石偏暖灰。
- 环境雾：`src/util/resources.js` 导出 `fogUniforms`（fogColor / fogDensityScale / fogSunColor / fogSunDir / fogSunAmount），
  Lead 每帧更新。地形模块必须使用 `makeWorldMaterial()`（它就是为此准备的），天空/海面的雾在各自 shader 里算。
- **必须支持的"变亮"手段**：你的所有颜色/自发光都跟随 `view.eased` 变化；`eased = 0` 时画面应当是"几乎全黑、只有太阳附近有微弱暖光"。

## 5. 性能预算

- 60 fps @ 1920×1080（集成显卡）。总 draw call 预算 ≈ 60，三角形 ≈ 30 万。
- 地形用**顶点色**而不是贴图；植被用 InstancedMesh（一次 draw call 搞定上千棵）。
- 严格避免每帧 `new THREE.Vector3()` 之类的分配（用模块级临时变量）。
- 不引入任何新依赖。

## 6. 代码风格

- ES Module，2 空格缩进，单引号，分号，函数前写中文注释说明意图。
- 着色器用模板字符串 + `/* glsl */` 注释；GLSL 要兼容 WebGL2 的 GLSL ES 3.00（three 会自动加前缀，
  你只写 `#include` 与常规写法即可；**不要**写 `precision` 声明）。
- 不要 `console.log` 噪音（可在 `opts.debug` 为真时打印一次编译信息）。
- 结束时用 write 工具写文件，再用 `node --check` 之类的办法自检语法（可用 python 或直接靠 playwright 跑一遍）。

## 7. 自检要求

写完后至少在 headless 里跑一次，确认没有 GLSL 编译错误（three 会在 console.error 打印
"THREE.WebGLProgram: Shader Error ..."）。Lead 会做统一视觉回归，但**你交付的模块必须自身可编译、无报错**。
