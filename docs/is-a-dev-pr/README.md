# is-a.dev 域名申请材料（已备好，替换占位符即可提交）

申请 `xinguang.is-a.dev`，指向 GitHub Pages 上的心光站点。**格式已按 is-a.dev 官方文档核对过**
（来源：https://docs.is-a.dev/quickstart/ 与 https://docs.is-a.dev/guides/github-pages/ ）。

## 已准备好的东西

- `xinguang.is-a.dev.json` —— 域名注册文件，只需把 2 处占位符换成你的 GitHub 用户名。

官方格式只有两个字段：`owner.username` 与 `records`（注意是复数 `records`，不是 `record`）。

```json
{
    "owner": {
        "username": "your-github-username"
    },
    "records": {
        "CNAME": "your-github-username.github.io"
    }
}
```

## 提交前必须满足的前提（官方要求，缺一必拒）

1. **网站已经在线且内容完整**：`https://<你的用户名>.github.io/xinguang/` 能打开，不能是空白页。
2. **是非商业的、软件开发相关的项目**（个人站点 / 作品集 / 开源软件项目）。心光是 three.js / WebGL 开源项目，符合。
3. PR 描述里要给出**站点链接 + 一张站点截图**。
4. ⚠️ 官方明确写着：**不要用 AI 生成申请内容**（"Do not use AI to generate your request, it WILL always get it wrong"）。
   所以这份材料只是把格式和路径准备好，**PR 描述请你自己写**，别整段照搬。

## 三步提交

1. 把 JSON 里的两处 `<your-github-username>` 换成你的 GitHub 登录名。
2. fork `is-a-dev/register`，在 `domains/` 目录下新建文件 **`xinguang.is-a.dev.json`**
   （文件名 = 你要的域名全称 + `.json`，小写；二级域就写 `xinguang.is-a.dev.json`，不要写 `www.` 前缀）。
3. 向 `is-a-dev/register` 的默认分支提 Pull Request，**保留官方 PR 模板**并逐项填好，附上站点链接与截图。

## 或者：让我用脚本自动开 PR

有 GitHub 令牌后（见 [`GITHUB.md`](../../GITHUB.md) 第一步）：

```bash
node tools/gh-domain.mjs --domain xinguang --email 你的邮箱 --dry-run   # 先看它会提交什么
node tools/gh-domain.mjs --domain xinguang --email 你的邮箱             # 真的提交
```

它会自动：检查 `xinguang` 是否被占用 → fork → 建分支 → 写入 `domains/xinguang.is-a.dev.json` → 开 PR，最后打印 PR 链接。
**合并仍然要等 is-a.dev 维护者**（几小时到 3 天）。

## 合并之后（顺序不能反）

1. GitHub 仓库 → **Settings → Pages → Custom domain**：填 `xinguang.is-a.dev`，保存。
   ⚠️ 官方强调必须在**合并之后**再填；提前填会导致 404 或指向错误站点。
2. 勾选 **Enforce HTTPS**。
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
