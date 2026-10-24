# 把「心光」发布到 GitHub（并变成网站）

> 这一页是给**你**看的操作手册。仓库已经在本机建好、首次提交已完成，剩下的只差「授权推送」这一步。
> 全流程 0 元，不需要买服务器、不需要域名费。

## 现在到哪一步了

| 步骤 | 状态 |
| --- | --- |
| 本机建立 git 仓库、提交历史 | ✅ 已完成（`main` 分支，15 个提交，工作区干净） |
| 仓库结构可直接当 Pages 站点托管 | ✅ 已验证（子路径下 13 个 ES 模块全部 200） |
| 推送与开启 Pages 的脚本 | ✅ 已写好，并用本地裸仓库 + 假 GitHub API **端到端实跑验证过**（含「故意做坏一个资源」的负控） |
| 推送到你的 GitHub 账号 | ⏳ **需要你授权**（见下面「第一步」） |
| 开启 GitHub Pages 线上站点 | ⏳ 授权后我一条命令做完，并自动验证站点真的能打开 |
| 申请免费域名 `xinguang.is-a.dev` | ⏳ 等站点上线后提 PR（脚本已彩排；见 [`docs/free-domain.md`](docs/free-domain.md)） |

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

它会依次：校验令牌身份 → 建仓库（已存在则复用）→ 配 `origin` 并把 `main` 推上去 → 调 API 开启 Pages → 轮询构建状态（最多 20×15s）→ **打开线上地址真验一遍**（`index.html` 200、页面标记齐全、`vendor/three.module.js` 与 `src/*.js` 全部 200）→ 打印 `LIVE_URL`。

> 推送用的令牌通过一个临时凭据文件交给 git，`finally` 里立即删除，`git config` 里不留任何痕迹。凭据文件的 `protocol://host` 是从实际 remote 推导的；push 前会先清空机器上预置的 credential helper —— Git for Windows 自带的 `credential-helper-selector` 会在无人值守时**挂住等人手输密码**，必须显式绕过。
>
> 跑完 `origin` 会留在仓库里（脚本故意不自动删，方便你接着手动 `git push`）。不想要就 `git remote remove origin`。

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
- 想验证的话打开站点点几下，或用任意静态服务器本地跑 `node serve.mjs`

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
**仓库名可以改吗？** 可以，但 Pages 地址会跟着变，改完记得同步 `CNAME`（如果用自定义域则不受影响）。
**脚本报错了怎么知道是真失败？** 三个脚本都按退出码报状态：`0` 成功；`gh-release` 失败退出 `1`、令牌无效 `3`、建仓库失败 `4`；`gh-domain` 域名被占 `4`、fork 失败 `5`、写文件失败 `8`、**开 PR 失败 `9`**。别只看日志里的「OK」字样。
**国内打不开 github.io？** 用方案里的 Cloudflare Pages 镜像，同一个仓库可以同时挂两份。
