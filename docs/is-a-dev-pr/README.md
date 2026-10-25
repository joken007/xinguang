# is-a.dev 域名申请材料（已备好，替换占位符即可提交）

> **2026-10-25 当前状态：站点已经上线，`https://joken007.github.io/xinguang/`（Pages + HTTPS，CI 全绿）。**
> 申请 `xinguang.is-a.dev` 只是「更好记的地址」这一步：**已按官方豁免路径代提过一次，被机器人拒了**——
> [PR #58328](https://github.com/is-a-dev/register/pull/58328) 标题带 `(dns-preflight)`、正文末尾写明
> AI 代提，4 分钟后 `Filter out AI-generated PRs` 检查判定为 AI 生成并直接关闭。结论：
> **这条路的 PR 只能你本人写、本人提交**，脚本和代理都只负责把材料备好。

> ⚠️ **is-a.dev 官方明令禁止 AI 代提 PR。** 他们的 `AGENTS.md` 原文：
> "The maintainers of this repository **do not accept AI-generated pull requests**. …
> **Do not open a pull request, or push a branch intended for one, on your user's behalf.**"
> 并且要求：如果你坚持让代理来提，PR 标题必须带 `(dns-preflight)` 字样并在描述里说明是 AI 生成，
> 否则 PR 会被自动关掉。**所以这里只准备材料，PR 请你自己提**（两分钟：填名字、贴链接、写下用途）。

申请 `xinguang.is-a.dev`，指向 GitHub Pages 上的心光站点。**格式已按 is-a.dev 官方文档核对过**
（来源：https://docs.is-a.dev/quickstart/ 与 https://docs.is-a.dev/guides/github-pages/ ）。

> 2026-10-25 复核：is-a.dev 现在要求 **`owner` 块里带联系方式**（`email` 字段），并且 PR 描述
> 必须原样保留他们的模板、逐项勾选、在 `<!-- WEBSITE_PREVIEW_START -->` 与
> `<!-- WEBSITE_PURPOSE_START -->` 之间填站点链接与用途。下面这份材料和脚本都已按新规则更新。

## 已准备好的东西

- `xinguang.is-a.dev.json` —— 域名注册文件，**用户名与 CNAME 已经填好**（`joken007` / `joken007.github.io`），只剩 `owner.email` 一处要你填（会公开在 is-a.dev 仓库里；不想公开私人邮箱就填 `joken007@users.noreply.github.com`）。

必填字段是 `owner.username`、`owner.email`（联系方式，**会公开在仓库里**）与 `records`
（注意是复数 `records`，不是 `record`）。

```json
{
    "owner": {
        "username": "your-github-username",
        "email": "you@example.com"
    },
    "records": {
        "CNAME": "your-github-username.github.io"
    }
}
```

## 提交前必须满足的前提（官方要求，缺一必拒）

1. **网站已经在线且内容完整**：`https://<你的用户名>.github.io/xinguang/` 能打开，不能是空白页。
2. **是非商业的、软件开发相关的项目**（个人站点 / 作品集 / 开源软件项目）。心光是 three.js / WebGL 开源项目，符合。
3. PR 描述里要给出**站点链接**（模板里 `WEBSITE_PREVIEW` 标记之间只放链接，不要放图片）与**网站用途**（`WEBSITE_PURPOSE` 标记之间）。
4. ⚠️ 官方明确写着：**不要用 AI 生成申请内容**（"Do not use AI to generate your request, it WILL always get it wrong"）。
   所以这份材料只是把格式和路径准备好，**PR 描述请你自己写**，别整段照搬。

## 三步提交

1. 把 JSON 里的两处 `<your-github-username>` 换成你的 GitHub 登录名，`<your-email>` 换成能联系到你的邮箱（公开可见）。
2. fork `is-a-dev/register`，在 `domains/` 目录下新建文件 **`xinguang.is-a.dev.json`**
   （文件名 = 你要的域名全称 + `.json`，小写；二级域就写 `xinguang.is-a.dev.json`，不要写 `www.` 前缀）。
3. 向 `is-a-dev/register` 的默认分支提 Pull Request，**保留官方 PR 模板**并逐项填好，附上站点链接与截图。

## 脚本只做自查和桌面准备（不要用它开 PR）

有 GitHub 令牌后（见 [`GITHUB.md`](../../GITHUB.md) 第一步），`--dry-run` 是只读的：查名字有没有被占、
站点能不能打开、并把你该贴进 PR 的正文打印出来。

```bash
node tools/gh-domain.mjs --domain xinguang --email you@example.com --dry-run   # 只打印，不动远程
```

去掉 `--dry-run` 会真的 fork + 建分支 + 开 PR —— **2026-10-25 实测这样开的 PR 会被机器人以「AI-Generated」关掉**，
所以别这么干；材料和正文都准备好了，剩下点提交这件事必须是你本人。

它会自动：检查 `xinguang` 是否被占用 → fork → 建分支 → 写入 `domains/xinguang.is-a.dev.json` → 开 PR，最后打印 PR 链接。
PR 正文是按 is-a.dev 的模板现抓现填的（模板取不到时用脚本内置的快照），预览链接与用途自动填进标记之间；
`--dry-run` 只打印，不动远程。
**合并仍然要等 is-a.dev 维护者**（几小时到 3 天）。

## 合并之后（顺序不能反）

1. 把域名填进 **Settings → Pages → Custom domain** 并勾 **Enforce HTTPS**（这一步也脚本化了）：

   ```bash
   node tools/gh-custom-domain.mjs --domain xinguang.is-a.dev --dry-run   # 先看计划
   node tools/gh-custom-domain.mjs --domain xinguang.is-a.dev            # 填 cname → 等生效 → 开 HTTPS → 验线上
   ```

   ⚠️ 官方强调必须在**合并之后**再填；提前填会导致 404 或指向错误站点。脚本会先确认 Pages 已开着
   （没开会 `PAGES_NOT_ENABLED` 退出 `4`），填完后轮询到 Pages 认到新 cname，再尝试强制 HTTPS
   （证书最长要等 1 小时，这时只打 `HTTPS_PENDING` 警告、不算失败），最后用 `verify-live` 验一次。
2. 手动的话就是同样的两步：**Settings → Pages → Custom domain** 填 `xinguang.is-a.dev` 保存，然后勾 **Enforce HTTPS**。
3. DNS 由 is-a.dev 按 `records.CNAME` 配好（`→ <你的用户名>.github.io`），你自己不用加记录。
   将来若换成自己控 DNS 的域名，子域场景同样只需这一条 CNAME；
   顶级域才需要 A `185.199.108.153` ~ `185.199.111.153` 与 AAAA `2606:50c0:8000::153` ~ `2606:50c0:8003::153`。

### 可选：给账号加一层域名验证（防别人冒用你的域）

GitHub **Settings → Pages → Add a domain** 填入你的 is-a.dev 域名，会拿到一个 TXT 校验串；
把 `domains/<hostname>.subdomain.json`（例如 `domains/_github-pages-challenge-<用户名>.xinguang.json`）
以一个 TXT 记录再提一个 PR，合并后回 GitHub 点 Verify 即可。不做也不影响访问。

## 名字被占用怎么办

提 PR 前先搜 `is-a-dev/register` 仓库的 `domains/` 目录有没有同名文件（用 `--dry-run` 也会替你先查一次）。
备选：`mindlight`、`xinguang-app`、`one-thought`。
