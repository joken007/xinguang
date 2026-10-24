# 把「心光」发布到 GitHub（并变成网站）

> 这一页是给**你**看的操作手册。仓库已经在本机建好、首次提交已完成，剩下的只差「授权推送」这一步。
> 全流程 0 元，不需要买服务器、不需要域名费。

## 现在到哪一步了

| 步骤 | 状态 |
| --- | --- |
| 本机建立 git 仓库、提交历史 | ✅ 已完成（`main` 分支，30 个提交 / 52 个文件，工作区干净） |
| 仓库结构可直接当 Pages 站点托管 | ✅ 已验证（子路径下 13 个 ES 模块全部 200） |
| 推送与开启 Pages 的脚本 | ✅ 已写好，并用本地裸仓库 + 假 GitHub API **端到端实跑验证过**（含「故意做坏一个资源」的负控；最近一次彩排把当前全部 30 个提交 / 52 个文件真的推了起来，站点自检 200） |
| 授权后自动发布 | ✅ 已就绪：`node tools/watch-and-release.mjs` 一看到令牌就自动建仓/推送/开 Pages/验站点（已彩排） |
| 推送到你的 GitHub 账号 | ⏳ **需要你授权**（见下面「第一步」） |
| 开启 GitHub Pages 线上站点 | ⏳ 授权后我一条命令做完，并自动验证站点真的能打开；推送后 `.github/workflows/check.yml` 会再验一遍 |
| 申请免费域名 `xinguang.is-a.dev` | ⏳ 等站点上线后提 PR（脚本已彩排；`xinguang.is-a.dev` 今天实测仍是空的：访问会跳去 is-a.dev 的「available」页，`is-a-dev/register` 里也没有这个文件；见 [`docs/free-domain.md`](docs/free-domain.md)） |

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

它会依次：校验令牌身份 → 建仓库（已存在则复用）→ 把 `main` 直接推到仓库地址 → **推成功之后**才配上 `origin`（并本地重建跟踪分支，不再回拉一次网络）→ 调 API 开启 Pages → 轮询构建状态（最多 20×15s）→ **打开线上地址真验一遍**（`index.html` 200、页面标记齐全、`vendor/three.module.js` 与 `src/*.js` 全部 200）→ 打印 `LIVE_URL`。

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
- 社交分享用的是 `./preview/03-bright.png`（现在是相对地址；知道最终域名后把它改成绝对地址，微信/Twitter 的抓取器才认得）
- 想验证的话打开站点点几下，或用任意静态服务器本地跑 `node serve.mjs`

`main` 每次推送都会跑一遍 `.github/workflows/check.yml`：语法检查 → 重新打包单文件版并要求与仓库里的一致 → 用 `tools/verify-live.mjs` 访问线上地址确认能打开。所以首页一旦坏掉，仓库的 Actions 会先红给你看。

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
node tools/gh-domain.mjs --domain xinguang      # 查重名 → fork → 建分支 → 写 JSON → 开 PR
```

> PR 正文它会按官方模板填好（域名 / 描述 / 线上地址 / 预览图 / 两个勾选项）。但 is-a.dev 官方明确写着 **申请文字必须由人自己写、用 AI 生成的一定会被拒**，所以开完 PR 请你去把那几行描述改成自己的话再等维护者看。

仓库根目录的 `CNAME` 文件不用你手写：在 Settings 里填完自定义域，GitHub 会自动提交一个只有一行域名、不带 `https://`、不带路径的 `CNAME`。
> 如果你以后换成自己控 DNS 的域名（比如买了顶级域），那时才需要「先填自定义域、再加 DNS」的防抢注顺序。

## 这个仓库里有什么

- `index.html` + `src/` + `vendor/`：多文件版（开发用，需要静态服务器）
- `心光.html`：单文件版（three.js 全内联，双击即开，约 1.5 MB）
- `preview/`、`screenshots/`：README 与文档里的截图
- `LICENSE`：MIT

## 常见问题

**推送要密码怎么办？** GitHub 已经不允许密码推送，用上面的令牌。
**推送卡住不动、没有任何输出？** 是 Git 预置的 credential helper 在等你手输密码。用本仓库的脚本推（它会绕过 helper）；直接 `git push` 的话先执行 `git config --global --unset credential.helper`，或设 `GIT_TERMINAL_PROMPT=0` 让它直接报错而不是干等。
**网络半死（能连上但一直不回）会怎样？** 不会挂住：API 请求 30 秒超时并重试两次，`git push` 最多等 10 分钟，整个发布由 `watch-and-release` 再兜一层 20 分钟上限。任一环节超时都以非零退出码大声失败（`6` / `5` / `124`），不会出现「日志永远停在那里」的情况。想调就设 `GH_API_TIMEOUT_MS`、`GIT_TIMEOUT_MS`、`RELEASE_TIMEOUT_MS`（`RELEASE_TIMEOUT_MS` 给非数字会先 `BAD_ENV` 退出 2 —— 否则 `NaN` 会被 Node 折成 1 毫秒，等于每次发布开门即被杀；环境变量的校验排在 `--hours` 之前，所以两者同时写错时先报的是环境变量那条）。
**令牌会一直留在磁盘上吗？** 发布成功后会删掉 `gh-token.txt`；失败时**故意保留**，方便你直接重跑而不用重新授权。想手动删就删掉那个文件。
**仓库名可以改吗？** 可以，但 Pages 地址会跟着变，改完记得同步 `CNAME`（如果用自定义域则不受影响）。
**脚本报错了怎么知道是真失败？** 都按退出码报状态，别只看日志里的「OK」字样：

| 脚本 | 退出码 |
| --- | --- |
| `gh-release` | `0` 成功 · `1` **线上站点验证失败** · `2` 没有令牌 · `3` 令牌无效 · `4` 建仓库失败 · `5` **推送失败**（含超时） · `6` **网络不通/超时** · `7` 开 Pages 失败 |
| `gh-domain` | `0` 成功 · `2` 没有令牌 · `3` 令牌无效 · `4` 域名已被占 · `5` fork 失败 · `6`/`7` 建分支失败 · `8` 写文件失败 · `9` **PR 没能开出来** |
| `watch-and-release` | `0` 发布成功 · `2` `--hours` 参数不合法 · `3` 等不到令牌 · `124` 发布超过 20 分钟被掐断 · 其余 = `gh-release` 的退出码 |
**国内打不开 github.io？** 用方案里的 Cloudflare Pages 镜像，同一个仓库可以同时挂两份。
