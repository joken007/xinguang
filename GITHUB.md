# 把「心光」发布到 GitHub（并变成网站）

> 这一页是给**你**看的操作手册。仓库已经在本机建好、首次提交已完成，剩下的只差「授权推送」这一步。
> 全流程 0 元，不需要买服务器、不需要域名费。

## 现在到哪一步了

| 步骤 | 状态 |
| --- | --- |
| 本机建立 git 仓库、提交历史 | ✅ 已完成（`main` 分支，50 个提交 / 56 个文件，工作区干净） |
| 发布前体检 | ✅ `node tools/preflight.mjs` 一条命令列出「还缺什么」（令牌/仓库/Pages/DNS/工作区，加上站点能不能在 Pages 上跑、有没有令牌串被跟踪），只读不改 |
| 仓库结构可直接当 Pages 站点托管 | ✅ 已验证（子路径下 13 个 ES 模块全部 200） |
| 推送与开启 Pages 的脚本 | ✅ 已写好，并用本地裸仓库 + 假 GitHub API **端到端实跑验证过**（含「故意做坏一个资源」的负控；最近一次彩排把当时全部提交 / 55 个文件真的推了起来，站点自检 200） |
| 授权后自动发布 | ✅ 已就绪：`npm run live` 一条命令在前台做完全程（体检 → 建仓/推送/开 Pages/验站点 → 元数据指向线上地址）；也可以让 `node tools/watch-and-release.mjs`（现在等 7 天）一看到令牌就自己跑，最后把社交预览和文档里的地址指向这个线上地址（已端到端彩排；设 `SKIP_POLISH=1` 可只停在发布这一步） |
| 推送到你的 GitHub 账号 | ⏳ **需要你授权**（见下面「第一步」） |
| 开启 GitHub Pages 线上站点 | ⏳ 授权后我一条命令做完，并自动验证站点真的能打开；推送后 `.github/workflows/check.yml` 会再验一遍 |
| 申请免费域名 `xinguang.is-a.dev` | ⏳ 等站点上线后提 PR（脚本已彩排，且已按 is-a.dev 2026-10 的新规则改造：PR 正文用官方模板现抓现填、域名文件带 `owner.email`；`xinguang.is-a.dev` 今天实测仍是空的，`is-a-dev/register` 里也没有这个文件；见 [`docs/free-domain.md`](docs/free-domain.md)） |
| PR 合并后把域名挂到 Pages（填 cname → 开 HTTPS → 验线上） | ✅ 脚本已就绪并彩排（`tools/gh-custom-domain.mjs`，原来要人去 Settings 手点） |

## 第零步：先体检（随时可以跑）

不确定现在卡在哪？跑这一条，它只读不写（不提交、不推送、不建文件），把结论按行打出来：

```bash
node tools/preflight.mjs            # 也可以 npm run preflight
node tools/preflight.mjs --json     # 给脚本看的结构化输出
node tools/preflight.mjs --offline  # 只用这个 checkout，不碰令牌和网络（CI 每次推送就跑这个）
```

它检查四类事情：

- **这台机器**：`node` / `git` 能不能用、这个 checkout 是不是干净、有没有配 `user.name`/`user.email`（没配的话 `publish-polish` 会在提交那步以退出码 `7` 失败）、单文件版 `心光.html` 是否比源码旧；
- **要发布出去的站点**：Pages 会去取的那些文件在不在、`index.html` 里有没有写死本机地址（`127.0.0.1` / `file://`）或 `/styles.css` 这种根绝对路径（Pages 把仓库挂在子路径下，根绝对路径会 404）、importmap 里的 `three` 指向的文件在不在、`.nojekyll` 在不在、`site.webmanifest` 和它列出的图标在不在、跟踪文件的总量与最大单文件是否在 GitHub 的限制内；
- **别把秘密和垃圾一起发出去**：跟踪的文件里有没有 `ghp_…` 这类令牌串、有没有误跟踪 `*.log` / 凭据 / 临时文件；
- **外部状态**：有没有令牌、令牌是否被接受、仓库和 Pages 现在是什么状态、以及 `xinguang.is-a.dev` 的 DNS 解析到了没有。

最后一行的 `SUMMARY` 会直接说出还差什么。这台机器现在的输出（只摘几行）：

```text
SITE: index.html uses relative paths only (5 src/href references)
IMPORTMAP: "three" -> ./vendor/three.module.js (1.2 MiB)
NOJEKYLL: .nojekyll present (Pages serves the files as they are)
SIZE: 55 files, 11.9 MiB, largest 心光.html 1.5 MiB
SECRETS: no token-looking strings in the 37 tracked text files
FAIL TOKEN: not found -- ... gh-token.txt
SUMMARY blocked on: TOKEN
```

退出码：`0` 都齐了 · `2` 没令牌 · `3` 令牌被拒 · `4` 这个 checkout 本身不可用 · `5` 站点或仓库卫生有问题（写死的本机地址、根绝对路径、importmap 指向空、令牌串被跟踪、单文件超过 100 MiB 等） · `6` GitHub 没应答。

## 第一步：给我一个 GitHub 授权（三选一）

我没有你的 GitHub 账号，**推送必须由你授权**。任选一种，选完告诉我即可。

### 方式 A：设备码登录（推荐，最安全）

你在浏览器里输一个 8 位码，密码不用给我，令牌由 GitHub 直接发给本机脚本。

```bash
node tools/gh-auth.mjs start     # 生成一个形如 XXXX-XXXX 的用户码（15 分钟有效）
```

然后**你自己**打开 https://github.com/login/device ，输入那串码、点授权（选 `repo` 权限）。

码会过期，所以真正等待时用的是这个（码快过期会自动换一个新的并在终端响铃提醒，全程不需要人盯着）：

```bash
node tools/gh-auth.mjs wait --minutes 720
```

它一旦拿到令牌就写到 `E:/shiguang-testbed/dl/gh-token.txt` 并打印 `TOKEN_OK login=...`，该文件**不在仓库里**。


### 方式 B：给我一个 Personal Access Token

1. 打开 https://github.com/settings/tokens → **Generate new token (classic)**
2. 勾选 **`repo`**（必须）和 **`workflow`**（可选，以后要加自动部署才需要）
3. 有效期建议 7 天
4. 把 `ghp_...` 那串发给我（**只发给我，不要贴到公开地方**）

### 方式 C：你自己推

如果你更喜欢自己动手：

```bash
cd E:\心光
git remote add origin https://github.com/<你的用户名>/xinguang.git
git push -u origin main
```

推完把仓库地址发我，我接着配 Pages 和域名。

### 授权之后我这边跑什么

一条命令（默认仓库名 `xinguang`、公开、Pages 从 `main` 根目录发布）：

```bash
node tools/gh-release.mjs --repo xinguang
```

不想依赖后台那个一直挂着的 watcher，就用一条命令在**前台**走完同样三步（体检 → 发布 → 把元数据指向线上地址）：

```bash
node tools/go-live.mjs            # 或 npm run live
```

它**先跑体检**，不过就不部署：`index.html` 里写了根绝对路径（Pages 上必然 404）、importmap 指向空、`vendor/three.module.js` 缺了、或者工作区里跟踪了令牌串，都会在第一步停下并原样退出体检的码（`2` 没令牌 / `3` 令牌被拒 / `5` 站点有问题）。发布成功后会接着跑 `publish-polish --push`；这一步失败**不会**把已经上线的发布判成失败，只打印重新指向的命令。

它会依次：校验令牌身份 → 建仓库（已存在则复用）→ 把 `main` 直接推到仓库地址 → **推成功之后**才配上 `origin`（并本地重建跟踪分支，不再回拉一次网络）→ 调 API 开启 Pages → 轮询构建状态（最多 20×15s）→ **打开线上地址真验一遍**（`index.html` 200、页面标记齐全、`vendor/three.module.js` 与 `src/*.js` 全部 200 且返回 javascript/css 类型——模块被当成 `text/plain` 发出去时页面只会白屏，而这类事故光看首页是 200 看不出来的；单文件版 `心光.html` 取不到只记一条警告）→ 给仓库设主页地址与话题（`homepage` 指线上站点，话题写 `mindfulness / meditation / threejs / webgl / generative-art`；这一步失败只打一行 `REPO_HOMEPAGE_SKIPPED` / `REPO_TOPICS_SKIPPED`，不会把已经上线的发布判成失败）→ 打印 `LIVE_URL`。

> 推送用的令牌通过一个临时凭据文件交给 git，`finally` 里立即删除，`git config` 里不留任何痕迹。凭据文件的 `protocol://host` 是从实际 remote 推导的；push 前会先清空机器上预置的 credential helper —— Git for Windows 自带的 `credential-helper-selector` 会在无人值守时**挂住等人手输密码**，必须显式绕过。
>
> 跑完 `origin` 会留在仓库里（脚本故意不自动删，方便你接着手动 `git push`）。不想要就 `git remote remove origin`。
> **推送失败时仓库里根本不会有 `origin`**：脚本先直接往地址推、推成功了才 `git remote add origin`，所以不会留下一个指向失败 push 的 remote。中途被强杀也一样干净。反过来说，如果仓库里**本来就有** `origin`（上一次成功发布留下的），再跑一次失败的发布不会去动它——原样保留。
>
> 中断残留也考虑到了：临时凭据文件由 `finally` 删除，脚本还会在**启动时先扫一遍**上一次被强杀留下的凭据文件（打印 `STALE_CRED_REMOVED`）。凭据文件名里带着写它的进程号（`.gitcred-<pid>.tmp`），所以清扫看的是「写这个文件的进程还活着吗」：活着就打印 `CRED_FILE_IN_USE left alone (pid N is running)` 放过，死了才删。这样即使同一个目录里有两个 release 同时在跑，也不会互删对方正在用的凭据。旧版本留下的裸 `.gitcred-tmp` 没有进程号，才退回用年龄判断（默认两分钟，可用 `STALE_CRED_AGE_MS` 调；给它一个非数字会直接 `BAD_ENV` 退出 2，而不是悄悄变成「全删」）。进程号也不是铁证——Windows 会回收 pid，残留文件一旦被无关进程「继承」了那个号就会看起来永远活着；所以还加了一道老化兜底：pid 活着但文件已经超过 2 小时（正常一次发布最多 20 分钟），照样删掉并打印 `STALE_CRED_REMOVED_AGED`（阈值 `STALE_CRED_MAX_AGE_MS`，默认两小时；非数字同样 `BAD_ENV` 退出 2）。这个阈值有**下限**：一次发布最长活不过 `RELEASE_TIMEOUT_MS`（默认 20 分钟），所以生效值至少是「一次发布 + 1 分钟」——你只能把它调大，调不到低于一次正在跑的发布，免得手一抖把正在推的凭据扫掉。读不动/删不掉的凭据文件不再静默跳过，会打印 `CRED_FILE_UNREADABLE`。注意 Windows 上 Node 的 `SIGTERM`/`SIGINT` 处理器对 `TerminateProcess` 强杀**根本不会运行**，所以真正的兜底是这次启动清扫，而不是信号处理。

### 需要你拍板的三个默认值

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 仓库名 | `xinguang` | 地址就是 `https://<你的用户名>.github.io/xinguang/` |
| 公开 / 私有 | **公开** | GitHub Pages 免费版要求公开仓库 |
| 免费域名 | 申请 `xinguang.is-a.dev` | 名字想换就说；不想折腾就先只用 `github.io` 地址 |

## 第二步：开启 GitHub Pages（推送之后）

仓库 → **Settings → Pages**：

- Source: **Deploy from a branch**
- Branch: **main** / **/(root)**
- 保存，等 1–2 分钟

线上地址就是： `https://<你的用户名>.github.io/xinguang/`

站点已经准备好这些：
- 全部资源走**相对路径**，放在 `/<仓库名>/` 子路径下不会 404
- 带了 `.nojekyll`，Jekyll 不会去动 `src/` 之类的目录
- 纯静态、零构建：Pages 直接托管仓库根目录即可
- 应用图标、`site.webmanifest`（可以「添加到主屏幕」当应用打开）、`robots.txt` 都已就位
- 社交分享用的是 `./preview/03-bright.png`（相对地址）。微信 / Twitter 的抓取器要绝对地址，所以 `watch-and-release` 发布成功后会自己跑一次 `tools/publish-polish.mjs`（见下一节）；只有想换地址或手工重跑时才需要自己敲命令
- 想验证的话打开站点点几下，或用任意静态服务器本地跑 `node serve.mjs`

`main` 每次推送都会跑一遍 `.github/workflows/check.yml`：语法检查 → 重新打包单文件版并要求与仓库里的一致 → `node tools/preflight.mjs --offline` 检查「这个 checkout 真的能当站点跑吗」（写死的本机地址、根绝对路径、importmap 指向空、令牌串被跟踪）→ Pages 已开启时再用 `tools/verify-live.mjs` 访问线上地址确认能打开。所以首页一旦坏掉，仓库的 Actions 会先红给你看，而不是上线之后才发现。

验线上之前会先问一次 Pages API：站点还没开启就跳过这一步并写明原因。因为第一次推送发生在开启 Pages 之前（开启是另一次 API 调用），那时若硬验线上，仓库的第一次 CI 就会为了一个不是站点本身的原因变红。

### 知道地址之后：把元数据指过去

站点一旦有了真实地址，仓库里那些「还不知道自己住哪」的占位写法就该收尾了：`og:image` 是相对路径、README 还写着「Once Pages is enabled…」、状态表还是 ⏳。一条命令收掉：

```bash
node tools/publish-polish.mjs --url https://<你的用户名>.github.io/xinguang/ --push
```

它做四件事：把 `index.html` 的 `og:image` / `twitter:image` 改成绝对地址并补上 `og:url`；把 `README.md` / `README.zh-CN.md` 里的演示地址换掉；把本文档状态表里「推送到 GitHub」「开启 Pages」两行改成 ✅；然后重打包 `心光.html`（它内联了 `index.html`，不改就会过期），最后一并提交推送。

几个刻意的设计：**幂等**——第二次跑只会打 `ALREADY` / `NO_CHANGES`；**地址变了也能再跑**——站点先挂在 `<用户名>.github.io/xinguang/`，以后绑上 `xinguang.is-a.dev` 这类自定义域名时，用新地址再跑一次，它会把之前写进去的绝对地址整体改过去（同样的地址再跑则是 `NO_CHANGES`）；**先探路再动手**——带 `--push` 时会先确认令牌和 `origin` 都在，缺一个直接 `NO_TOKEN` / `NO_ORIGIN` 退出，不会留下一笔「声称了地址、却没推上去」的提交；`--dry-run` 只看会改什么不落盘；推送同样用临时凭据文件、`finally` 删除。
## 第三步：免费域名（可选但推荐）

详细调研见 [`docs/free-domain.md`](docs/free-domain.md)，结论是两条腿走路：

| 方案 | 拿到什么 | 需要你做什么 |
| --- | --- | --- |
| **is-a.dev**（首选） | `xinguang.is-a.dev` 这样的独立二级域 | 定个名字 → 用一个 GitHub PR 申请（几小时~3 天合并，永久免费） |
| **Cloudflare Pages**（镜像） | `xinguang.pages.dev` | 用 GitHub 授权一次，连仓库自动部署；国内访问更稳 |
| 保底 | `用户名.github.io/xinguang/` | 什么都不用做 |

### 申请 is-a.dev 的 DNS 记录

心光是子域，只需要一条：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| `CNAME` | `xinguang` | `<你的用户名>.github.io` |

（如果以后要给**顶级域**绑 Pages，才需要 A 记录 `185.199.108.153` ~ `185.199.111.153` 与 AAAA `2606:50c0:8000::153` ~ `2606:50c0:8003::153`。）

仓库里对应的文件是 `CNAME`（一行，只有域名，**不带** `https://`、不带路径）：

```
xinguang.is-a.dev
```

**is-a.dev 的顺序是固定的**（官方指南 <https://docs.is-a.dev/guides/github-pages/> 明确要求）：

1. 先按上面的清单提 PR —— DNS 那一条 CNAME 由 is-a.dev 那边按你 JSON 里的 `records` 配好，**你自己不用加任何 DNS 记录**；
2. **等 PR 合并之后**，再去 Settings → Pages 填自定义域。提前填会 404 或指错站点；
3. 最后勾 **Enforce HTTPS**（证书签发最长等 1 小时）。

上面这一整套仓库里已经有脚本做掉了：

```bash
node tools/gh-domain.mjs --domain xinguang --email you@example.com --dry-run   # 先看它会提交什么
node tools/gh-domain.mjs --domain xinguang --email you@example.com             # 查重名 → fork → 建分支 → 写 JSON → 开 PR
```

`--email` 现在是必填的：is-a.dev 2026-10 起要求域名文件里带联系方式（`owner.email`，**会公开在仓库里**），
缺了会直接 `NO_CONTACT` 退出。PR 正文它会**现抓官方模板再填**——注释原样保留、每一项要求勾选，
站点链接与用途分别填进 `<!-- WEBSITE_PREVIEW_START/END -->` 与 `<!-- WEBSITE_PURPOSE_START/END -->` 之间
（上游取不到模板时用脚本内置快照，并在输出里打 `PR_TEMPLATE snapshot`）。
另外两条硬规则：根子域必须**与软件开发相关**（心光是 three.js / WebGL 开源项目，符合）、**非商业**。
但 is-a.dev 官方明确写着 **申请文字必须由人自己写、用 AI 生成的一定会被拒**，所以开完 PR 请你去把那几段描述改成自己的话再等维护者看。

仓库根目录的 `CNAME` 文件不用你手写：在 Settings 里填完自定义域，GitHub 会自动提交一个只有一行域名、不带 `https://`、不带路径的 `CNAME`。
> 如果你以后换成自己控 DNS 的域名（比如买了顶级域），那时才需要「先填自定义域、再加 DNS」的防抢注顺序。

### PR 合并之后：把域名挂到 Pages 上

is-a.dev 合并 PR 后，那边配的 DNS 记录通常几分钟到几十分钟才生效。剩下的两步也能交给脚本：

```bash
node tools/gh-custom-domain.mjs --domain xinguang.is-a.dev --dry-run   # 只看计划，不写任何东西
node tools/gh-custom-domain.mjs --domain xinguang.is-a.dev            # 填 cname → 等 Pages 认到 → 开 HTTPS → 验线上
```

它会先确认 Pages 已经开着（没开会直接 `PAGES_NOT_ENABLED` 退出 `4`——这时填域名只会指到空站点），
然后 `PUT` 自定义域、轮询到 Pages 认到新 cname、再尝试 **Enforce HTTPS**（证书签发最长可能要一小时，
这时只打 `HTTPS_PENDING` 警告、不算失败），顺手把仓库主页地址改成自定义域名（失败只记一行），最后用 `verify-live` 验一次首页与它引用的本地资源。

地址从 `<owner>.github.io/<repo>/` 换成自定义域名之后，社交预览里的绝对地址也要跟着改（再跑一次即可，
`publish-polish` 按模式匹配整行改写，认得出旧地址）：

```bash
node tools/publish-polish.mjs --url https://xinguang.is-a.dev/ --push
```
## 这个仓库里有什么

- `index.html` + `src/` + `vendor/`：多文件版（开发用，需要静态服务器）
- `心光.html`：单文件版（three.js 全内联，双击即开，约 1.5 MB）
- `preview/`、`screenshots/`：README 与文档里的截图
- `LICENSE`：MIT

## 常见问题

**推送要密码怎么办？** GitHub 已经不允许密码推送，用上面的令牌。
**推送卡住不动、没有任何输出？** 是 Git 预置的 credential helper 在等你手输密码。用本仓库的脚本推（它会绕过 helper）；直接 `git push` 的话先执行 `git config --global --unset credential.helper`，或设 `GIT_TERMINAL_PROMPT=0` 让它直接报错而不是干等。
**网络半死（能连上但一直不回）会怎样？** 不会挂住：API 请求 30 秒超时并重试两次，`git push` 最多等 10 分钟，整个发布由 `watch-and-release` 再兜一层 20 分钟上限。任一环节超时都以非零退出码大声失败（`6` / `5` / `124`），不会出现「日志永远停在那里」的情况。想调就设 `GH_API_TIMEOUT_MS`、`GIT_TIMEOUT_MS`、`RELEASE_TIMEOUT_MS`（`RELEASE_TIMEOUT_MS` 给非数字会先 `BAD_ENV` 退出 2 —— 否则 `NaN` 会被 Node 折成 1 毫秒，等于每次发布开门即被杀；环境变量的校验排在 `--hours` 之前，所以两者同时写错时先报的是环境变量那条），以及 `GH_PAGES_POLL_MS`（只影响等 Pages 构建时的轮询间隔，默认 15 秒，彩排会把它调小）。
**令牌会一直留在磁盘上吗？** 发布成功后会删掉 `gh-token.txt`；失败时**故意保留**，方便你直接重跑而不用重新授权。想手动删就删掉那个文件。
**仓库名可以改吗？** 可以，但 Pages 地址会跟着变，改完记得同步 `CNAME`（如果用自定义域则不受影响）。
**脚本报错了怎么知道是真失败？** 都按退出码报状态，别只看日志里的「OK」字样：

| 脚本 | 退出码 |
| --- | --- |
| `preflight` | `0` 都齐了 · `2` 没有令牌 · `3` 令牌被拒 · `4` checkout 不可用（不是仓库 / 没有 git / 缺 Pages 要取的文件） · `5` 站点或仓库卫生有问题（根绝对路径、importmap 指向空、令牌串被跟踪、单文件超 100 MiB） · `6` GitHub 没应答（含 5xx） |
| `gh-release` | `0` 成功 · `1` **线上站点验证失败** · `2` 没有令牌 · `3` 令牌无效 · `4` 建仓库失败 · `5` **推送失败**（含超时） · `6` **网络不通/超时** · `7` 开 Pages 失败 · `8` **GitHub 那边建站失败**（Pages 构建 `errored`：脚本会引用 GitHub 给的原因并让你去看 Actions 里的构建日志，不会把它混成「站点没应答」；这不是重试能修的，站点会一直 404 到构建本身被修好） |
| `go-live` | `0` 站点已上线（含元数据收尾） · 其余 = 失败那一步的退出码（体检的 `2`/`3`/`4`/`5`/`6`，或发布的 `1`–`8`）。元数据那步失败不改变退出码，因为站点已经上线了 |
| `gh-domain` | `0` 成功 · `2` 没有令牌 / 没给 `--email` 或邮箱格式不对 · `3` 令牌无效 · `4` 域名已被占 · `5` fork 失败 · `6`/`7` 建分支失败 · `8` 写文件失败 · `9` **PR 没能开出来** |
| `publish-polish` | `0` 成功 · `2` 没有令牌 / `--url` 缺失或不是 http(s) 地址 · `4` 仓库里没有 `origin`（先跑 `gh-release`） · `5` **推送失败** · `6` 重打包单文件版失败 · `7` 提交失败（仓库没配 `user.name` / `user.email`） |
| `gh-custom-domain` | `0` 成功（含证书还没就绪时只警告） · `2` 没有令牌 / `--domain` 缺失或格式不对 · `3` 令牌无效 · `4` **Pages 还没开**（先去跑 `gh-release`） · `5` **域名还打不开/验证失败** · `6` 网络不通 / 读写 Pages 失败 |
| `watch-and-release` | `0` 发布成功（含随后的元数据收尾） · `2` `--hours` / 环境变量不合法 · `3` 等不到令牌 · `124` 发布超过 20 分钟被掐断 · 其余 = `gh-release` 的退出码。收尾那一步失败**不**改变退出码，因为站点本身已经上线了 —— 它会把 `POLISH_FAILED` 和该敲的命令写进同一行 `DONE_LIVE` 日志 |
**国内打不开 github.io？** 用方案里的 Cloudflare Pages 镜像，同一个仓库可以同时挂两份。
