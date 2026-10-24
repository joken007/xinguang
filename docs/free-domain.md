# 心光 · 免费域名方案调研

> 调研时间：2026-10-24（Asia/Shanghai）。结论基于当时的官方文档与社区来源，免费服务政策变动频繁，**申请前请再点开链接确认一次**。

---

## 结论速览

1. **能拿到什么**：GitHub Pages 自带的 `用户名.github.io/仓库名/` 本身就是免费地址（但域名属于 GitHub，不是你的）；若想要自己的独立域名，目前真正还能白嫖且有口碑的是 **is-a.dev**（开发者二级域）与 **Cloudflare Pages 的 `*.pages.dev`**，`eu.org`、`pp.ua` 仍开放但门槛/维护成本更高，`us.kg` 基本已凉。
2. **最推荐哪条路**：主站继续用 GitHub Pages 托管，**首选申请 is-a.dev 二级域**（如 `xinguang.is-a.dev`）绑到仓库；同时用 **Cloudflare Pages 免费子域做国内镜像**，两条腿走路。
3. **需要用户做什么**：提供 GitHub 用户名与一个邮箱 → 自己在 `is-a-dev/register` 仓库提一个 PR（本资料已备好 JSON 模板）→ 在仓库 Settings → Pages 填入自定义域 → 在 DNS 面板加一条 CNAME 指向 GitHub Pages。全程 0 元。

---

## 一、GitHub Pages 自带地址算不算免费域名？

| 项目 | 结论 | 来源 |
| --- | --- | --- |
| `用户名.github.io`（用户站） | **是免费子域，但域名所有权属于 GitHub**，不是「你的域名」；可以绑自定义域 | [GitHub Docs · 关于自定义域](https://docs.github.com/zh/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages) |
| `用户名.github.io/仓库名/`（项目站） | 同样免费；**也可以单独绑自定义域**，且会覆盖账号级自定义域 | [同上](https://docs.github.com/zh/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages) |
| 是否支持 HTTPS | 支持，可勾选 Enforce HTTPS；绑定后证书签发**最长要等 1 小时** | [Securing with HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https) · [故障排查](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/troubleshooting-custom-domains-and-github-pages) |
| CNAME 文件 | 一个仓库**只能一个**自定义域；文件内容**只能是域名本身**，不带协议、不带路径 | [故障排查](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/troubleshooting-custom-domains-and-github-pages) |
| 一个仓库绑几个域 | **只能 1 个**；不支持把多个仓库挂到 `sub.example.com/a`、`/b` 这种子路径 | [讨论 #173106](https://github.com/orgs/community/discussions/173106) · [讨论 #164202](https://github.com/orgs/community/discussions/164202) |
| 账号级行为 | 给用户站设了自定义域后，**该账号所有项目站默认沿用此域**，路径为 `你的域/仓库名/`；可对单仓库覆盖 | [GitHub Docs](https://docs.github.com/zh/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages) |
| 用量软限制 | 仓库建议 ≤1 GB、站点 ≤1 GB、带宽软限 100 GB/月、软限 10 次构建/小时（Actions 发布不受构建次数限制） | [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) |
| 所有权/安全 | 官方**建议先验证域名**（加 `_github-pages-challenge-<用户名>` TXT 记录）再绑，避免子域被他人抢占 | [验证自定义域](https://docs.github.com/zh/pages/configuring-a-custom-domain-for-your-github-pages-site/verifying-your-custom-domain-for-github-pages) · [讨论 #170204](https://github.com/orgs/community/discussions/170204) |

**一句话**：`github.io` 地址是「免费的托管地址」，不是「你的免费域名」。要独立域名，得下面另申请一个再 CNAME 指过来。

---

## 二、当前仍开放的免费域名/子域逐个核实

### 2.1 is-a.dev —— ⭐ 最推荐

| 项目 | 说明 |
| --- | --- |
| 形式 | `你的名字.is-a.dev` |
| 申请方式 | **GitHub PR**：fork `is-a-dev/register`，在 `domains/` 下新增 `你的名字.json`，提交 PR |
| 需要什么 | 一个 GitHub 账号 + 一个能收到邮件的邮箱；JSON 里需填 `owner`（username/email）和 `record` |
| 审核时长 | 官方 PR 自动回复写明「**几小时到 3 天**」，志愿者审核；社区反馈平均约 3 小时 |
| 是否支持 CNAME | ✅ 支持。GitHub Pages 场景填 `"CNAME": "你的用户名.github.io"`（**不带 https:// 和斜杠**） |
| 费用/续期 | 完全免费，无年费；但**每次修改记录都要再走 PR** |
| 门槛（重要） | 网站必须与**软件开发相关**，且**非商业**；官方明确**不收**游戏、课程、AI agent/chatbot 类站点。个人主页/作品集如无开发属性可能被拒 |
| 坑 | 只有「根子域」需要满足开发相关要求；**域名被判定滥用/长期不可访问会被回收**。另外 is-a.dev 主域在 Vercel 上无法直接添加（Vercel 要求验证根域） |
| 来源 | [PR 模板（要求原文）](https://github.com/is-a-dev/register/blob/main/.github/PULL_REQUEST_TEMPLATE.md) · [GitHub Pages 指南](https://github.com/is-a-dev/docs/blob/main/src/guides/github-pages.md) · [域名结构文档](https://is-a-dev-docs.pages.dev/domain-structure/) · [FAQ](https://docs.is-a.dev/faq/) · [Vercel 讨论](https://github.com/vercel/community/discussions/7005) |

> ⚠️ **对「心光」的适用性判断**：「心光」是一个 three.js / WebGL 技术项目（正念网页），**属于软件开发相关、非商业**，通过 is-a.dev 审核的概率较高。但为了稳妥，建议在仓库 README 和站点描述里**明确写出它是 three.js 技术项目/开源项目**，PR 描述也照此写。
> 另外 is-a.dev 同组织还推出了 `is-a.bot`，规则类似（[来源](https://github.com/rudra496/register)）。

### 2.2 js.org

| 项目 | 说明 |
| --- | --- |
| 形式 | `项目名.js.org` 或 `用户名.js.org` |
| 申请方式 | **GitHub PR**：往 `js-org/js.org` 仓库的域名列表加自己的子域 |
| 需要什么 | GitHub Pages 站点需先上线并**有实质内容**（不接受占位页）；仓库里放 `CNAME` 文件（项目站放 `gh-pages` 分支） |
| 审核时长 | 官方说明**24 小时内**上线 |
| 是否支持 CNAME | ✅ 就是这个流程 |
| 费用/续期 | 免费，无明确年审 |
| 门槛（重要） | **极其严格**：网站必须与 **JavaScript 生态直接相关**（NPM 包、JS 工具），官方明确**不收个人主页/作品集**，「只是用了 JS」也不符合 |
| 坑 | 近年收紧了政策，社区明确说**停止接收**个人页面、博客、Discord bot 页、无关库教程 |
| 来源 | [js.org 官网四步流程](https://www.js.org/) · [js.org 仓库](https://github.com/js-org/js.org) · [内容要求 README](https://cdn.jsdelivr.net/gh/js-org/js.org@master/README.md) |

> 判断：「心光」是 WebGL 应用，**不是 JS 生态工具（非 npm 包/框架）**，按新规**大概率被拒**。不建议把 js.org 当首选，但值得作为「顺手一投」的备选。**未核实**：是否有个案例外通过。

### 2.3 eu.org（nic.eu.org）

| 项目 | 说明 |
| --- | --- |
| 形式 | `你的名字.eu.org`（免费子域，1996 年起运营） |
| 申请方式 | **网页表单**：在 `nic.eu.org` 注册账号 → 提交域名申请 → 邮箱验证 |
| 需要什么 | 邮箱；**eu.org 不提供 DNS 托管**，必须自己指定 **nameserver**（可先托管到 Cloudflare / ClouDNS 等） |
| 审核时长 | 官方无承诺；社区反馈**普遍约 2 周**，也有更久；无付费插队 |
| 是否支持 CNAME | 可以，但要在你自己的 DNS 商处配置（因为 NS 指向别人） |
| 费用/续期 | 免费，长期可用 |
| 坑 | ① 部分国家代码子域（如 CY / GR / NL）由别处处理，`nic.eu.org` 会直接拒绝；② 必须先有可用的 nameserver 才批；③ DNSSEC 与 Cloudflare 组合有人踩坑；④ 审核慢且无客服 |
| 来源 | [nic.eu.org 官网](https://nic.eu.org/) · [2026 申请指南](https://arynjennen1989-stack.github.io/guides/how-to-get-a-free-eu-org-domain.html) · [社区教程](https://www.cnblogs.com/hopeblaze/articles/18637920) |

### 2.4 us.kg / pp.ua

| 服务 | 现状 | 来源 |
| --- | --- | --- |
| **us.kg** | ❌ **基本凉了**。2024-10 因滥用被 .KG 注册局警告并暂停注册；后续要求审批（指定邮箱后缀 + GitHub issue），又传出**要收 2 美元服务费**、解析被反复暂停。运营方 DigitalPlat 已把主推后缀换成 **dpdns.org** | [landian.news 汇总](https://www.landian.news/archives/tag/digitalplat) · [DigitalPlat 对比页](https://agentdeals.dev/compare/digitalplat-vs-zilore-com) · [GitHub 镜像说明](https://github.com/VReast/us.kg.Domain) |
| **dpdns.org**（DigitalPlat 现主推） | ⚠️ 仍可申请，GitHub/邮箱注册，支持托管到 Cloudflare，**有效期 1 年、需每年续期**；US.KG 后缀已停止新注册 | [V2EX 讨论](https://global.v2ex.co/t/1210029) · [什么值得买教程](https://post.smzdm.com/p/ad733eqd/) |
| **pp.ua** | ⚠️ 仍开放。在 `nic.ua` 注册申请，需**手机号 SMS 或 Telegram bot 激活**；免费；**每个号码 30 天内最多 3 个**；**每年必须续期**（到期前 4 个月内可续）；换号需联系客服 | [nic.ua 限制说明](https://nic.ua/en/knowledge-base/pp-ua-domains-restrictions) · [激活说明](https://nic.ua/ru/knowledge-base/how-to-activate-pp-ua-domain) · [社区全流程](https://www.nodeloc.com/t/topic/52103/58) |
| **nic.eu.org** | 即上面的 eu.org 本体 | [nic.eu.org](https://nic.eu.org/) |

> 注：`us.kg`「需缴 2 美元」的说法来自 landian.news 2026-10 的更新标题，**具体政策未核实**到官方原文，仅作风险提示。

### 2.5 平台自带的免费子域（Cloudflare Pages / Netlify / Vercel）

| 平台 | 免费子域 | 免费额度 | 备注 | 来源 |
| --- | --- | --- | --- | --- |
| **Cloudflare Pages** | `项目名.pages.dev` | 无限站点/请求/带宽；**500 次构建/月**，单次 1 个并发；单文件 ≤25 MiB、单站 ≤20,000 文件 | ✅ **支持绑定 GitHub 仓库自动部署**；✅ 可加自定义域；✅ **最适合做「心光」的国内镜像** | [Cloudflare Pages Limits](https://developers.cloudflare.com/pages/platform/limits/) |
| **Netlify** | `项目名.netlify.app` | 100 GB 带宽/月（硬限）、300 构建分钟/月 | ✅ 可加自定义域；免费版仅 1 名成员 | [Netlify Free 计划公告](https://www.netlify.com/blog/introducing-netlify-free-plan/) · [定价文档](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/legacy-pricing-plans/) |
| **Vercel** | `项目名.vercel.app` | Hobby 免费 | ⚠️ **Hobby 仅限非商业个人用途**（fair use）；「免费首年域名」优惠不适用于 Pro 试用 | [Vercel Hobby Plan](https://vercel.com/docs/plans/hobby) |

**要点**：这三个 `*.pages.dev` / `*.netlify.app` / `*.vercel.app` 地址**本身就是免费子域**，且**都能绑自定义域**（也就是可以反过来把 `xinguang.is-a.dev` 指向 Cloudflare Pages）。它们跟 GitHub Pages 是**并存关系**，不是二选一——正适合做镜像。

### 2.6 其它可申请项（信息较杂，部分未核实）

| 服务 | 说明 | 核实状态 |
| --- | --- | --- |
| `runs-on.dev` | 2026 年新出的免费子域，PR 注册，`*.runs-on.dev` 通配解析到 Vercel；明确致敬 is-a.dev | 来源：[GitHub zordhalo/runs-on.dev](https://github.com/zordhalo/runs-on.dev)，**具体申请门槛未核实** |
| `is-a.bot` | is-a.dev 同组织的新域，申报方式类似 | 来源：[rudra496/register](https://github.com/rudra496/register)，**详细规则未核实** |
| `SubFree` / `openalias.xyz` / `stackryze` 等 | 社区整理的免费子域服务 | **未核实**，来源为第三方列表 [harys722/free-domains](https://github.com/harys722/free-domains)、[free-for-life Domains.md](https://raw.githubusercontent.com/wdhdev/free-for-life/master/data/Domains.md) |
| **Freenom**（.tk/.ml/.ga/.cf/.gq） | ❌ 已停止免费注册多年，不要考虑 | 社区共识，本次未单独取证 |

---

## 三、给「心光」的推荐方案（按推荐度排序）

### 方案 A（首选）：is-a.dev 自定义域 + GitHub Pages 托管

- **拿到**：`xinguang.is-a.dev`（或 `心光` 的拼音/英文名，如 `mindlight.is-a.dev`），指向现有的 GitHub Pages 仓库。
- **用户要做的事**：
  1. 选一个未被占用的名字（在 `domains/` 目录搜一下有没有同名文件）。
  2. fork `is-a-dev/register`，把下方 JSON 存成 `domains/<名字>.json`，提 PR（**PR 描述必须原样保留官方模板**：注释不能删、每项要求勾选，并在标记之间填站点链接与用途）。
  3. 等待合并（约几小时~3 天）。
  4. 合并后到 GitHub 仓库 **Settings → Pages → Custom domain** 填 `<名字>.is-a.dev` 并保存（会自动生成 CNAME 文件）。
  5. 等 DNS 生效后勾选 **Enforce HTTPS**。
- **申请 JSON 模板（需替换占位符）**：

~~~json
{
    "owner": {
        "username": "你的GitHub用户名",
        "email": "你的邮箱"
    },
    "records": {
        "CNAME": "你的GitHub用户名.github.io"
    }
}
~~~

> ⚠️ 字段名是 **`records`（复数）**；`owner` 里必须有 `username`，并且**带联系方式**（`email`，会公开在仓库里；
> 官方也接受 Twitter / Discord，但 email 是最省事的）。
> 格式是 2026-10-25 从官方文档 <https://docs.is-a.dev/quickstart/>、<https://docs.is-a.dev/guides/github-pages/>
> 与 <https://github.com/is-a-dev/register/blob/main/.github/PULL_REQUEST_TEMPLATE.md> 复核的；
> 网上不少教程还在用旧的 `record`（单数）、或没写联系方式，都会被校验判错。

- **理由**：免费、无需续期、审核快、天然支持 CNAME、社区口碑好；「心光」属开发项目，符合其非商业+开发相关门槛。

### 方案 B（推荐并行）：Cloudflare Pages 镜像 + 免费 `*.pages.dev`

- **拿到**：`xinguang.pages.dev` 免费子域，**并可直接把方案 A 的自定义域也绑到它**（见第五节权衡）。
- **用户要做的事**：
  1. 注册 Cloudflare 账号（免费）。
  2. Workers & Pages → Create → Pages → **Connect to Git**，授权并选择「心光」仓库。
  3. 构建配置：这是**零依赖静态站**，无构建命令；Build command 留空，Build output directory 填 `.`（根目录）。
  4. 部署后得到 `项目名.pages.dev`。
  5. （可选）在 Custom domains 里绑定同一个 `xinguang.is-a.dev`。
- **注意**：免费版 **500 次构建/月**，对个人项目绰绰有余；单文件 ≤25 MiB（心光的 `心光.html` 约 1.5 MB，没问题）。

### 方案 C（备选）：直接用 GitHub Pages 默认地址，先不折腾域名

- **拿到**：`用户名.github.io/仓库名/`。零申请、零配置。
- **适合**：只想先发出去看看。缺点是地址长、且域名不归自己。可随时升级到方案 A。

> 不推荐：`us.kg`（基本停摆）、`js.org`（大概率不符合新规）、`Freenom`（已停）。

---

## 四、GitHub Pages 自定义域 DNS 记录表 + CNAME 文件

### 4.1 「心光」这种情况用哪种记录

「心光」用的是**子域**（`xinguang.is-a.dev`），**只需一条 CNAME**，不需要 A/AAAA。

| 类型 | 主机记录 (Name/Host) | 值 (Value) | TTL | 说明 |
| --- | --- | --- | --- | --- |
| **CNAME** | `xinguang`（或你在 is-a.dev 注册的完整子域） | `你的用户名.github.io` | 自动 / 3600 | **子域绑 GitHub Pages 的正确做法**；不要带 `https://`、不要带仓库路径、末尾不要加 `.`（多数面板自动处理） |

### 4.2 如果哪天要用「顶级域」(apex，如 `example.com`)

GitHub 官方给出的 IP（2025–2026 仍为这一组，官方文档原文）：

| 类型 | 主机记录 | 值 | 来源 |
| --- | --- | --- | --- |
| **A** | `@` | `185.199.108.153` | [GitHub Docs · Managing a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site) |
| **A** | `@` | `185.199.109.153` | 同上 |
| **A** | `@` | `185.199.110.153` | 同上 |
| **A** | `@` | `185.199.111.153` | 同上 |
| **AAAA** | `@` | `2606:50c0:8000::153` | 同上 |
| **AAAA** | `@` | `2606:50c0:8001::153` | 同上 |
| **AAAA** | `@` | `2606:50c0:8002::153` | 同上 |
| **AAAA** | `@` | `2606:50c0:8003::153` | 同上 |
| **CNAME** | `www` | `你的用户名.github.io` | 同上 |

> 官方提醒：即使配了 AAAA，也**建议同时保留 A 记录**（IPv6 全球普及仍慢）。

### 4.3 仓库里的 CNAME 文件

- 位置：**发布源分支的根目录**（若用 `main` 分支发布，就是仓库根目录，与 `index.html` 同级）。
- 内容：**只有域名本身，一行**。

~~~
xinguang.is-a.dev
~~~

- 格式要求（官方原文）：CNAME 文件**只能包含一个域**；**必须仅含域名**，不能带 `https://`、不能带路径、不能有空行/说明文字。
- 一般**不需要手动创建**：在 Settings → Pages 里填入自定义域并保存时，GitHub 会自动提交这个文件。
- ⚠️ 若用**自定义 GitHub Actions 工作流**发布，则不会生成 CNAME，且现有 CNAME 文件会被忽略——此时改由 Actions 配置自定义域。

### 4.4 绑定顺序（官方强调，防子域劫持）

1. **先在** GitHub 仓库 Settings → Pages 填好自定义域（或先做域名验证 TXT）。
2. **再去** DNS 面板加解析记录。
3. 等生效（最长 24 小时）→ 勾选 Enforce HTTPS（证书最长再等 1 小时）。

> 官方原话：如果先配 DNS 再告诉 GitHub，别人可能抢先在该子域上托管站点（[来源](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)）。

---

## 五、国内可访问性与「是否要做 Cloudflare Pages 镜像」

| 问题 | 现状 | 来源 |
| --- | --- | --- |
| GitHub Pages 国内可访问性 | ⚠️ **有已知问题**。社区普遍反映中国大陆**很多地区存在 DNS 解析异常 / 链路干扰**，不是站点挂了而是链路问题 | [技术博客实测 2026](https://tanqingbo.cn/github-pages-access/) · [镜像站说明](https://mcgit.place/mayx/blog/src/commit/be9602047b40dbbfc1c6e9f63a9254e875ba92bc/proxylist.md) |
| 是否有平台级封锁 | ⚠️ 有报道称 **2025-04-13 起**中国大陆访问 GitHub 出现 403/受限提示，属平台侧策略信号；具体范围随时间变化 | [Gitee 博客分析](https://blog.gitee.com/2026/01/23/open-source-narrowing-space-key-concerns/) |
| 第三方总结 | 「Vercel、Netlify、GitHub Pages 在中国大陆无法访问」的说法在部分文档出现（表述较绝对，各地运营商差异大） | [TinaCMS 文档](https://tina.io/docs/zh/tinacloud/deployment-options/alibaba-cloud) |

### 建议：**是，建议同时提供 Cloudflare Pages 镜像**

- **理由**：Cloudflare 的 IP 在国内连通性通常好于 `github.io`；免费额度充足（无限带宽、500 构建/月）；且能自动从 GitHub 仓库构建，维护成本几乎为零。
- **做法**：同一仓库同时接 GitHub Pages 与 Cloudflare Pages，两边都能访问；把 is-a.dev 域名指向其中一条（或都绑，按需切换）。
- **注意**：Cloudflare 的 `pages.dev` 在国内也**不保证稳定**（同样是境外服务），镜像只是「多一条路」，不是「解决墙」；真要国内加速必须 ICP 备案 + 国内节点（[参考](https://tanqingbo.cn/github-pages-access/)）。
- **低改动替代**：如只想小改，也可在 Cloudflare 上给 `github.io` 反向代理/自建镜像站，或做 DNS 分流双线部署。

---

## 六、不确定 / 未核实项（明确标注）

以下内容本次**未能取得官方一手来源**，落地前请自行复核：

1. **us.kg 需缴 2 美元** 的具体政策原文（仅见 landian.news 标题汇总）——**未核实**。
2. `runs-on.dev`、`is-a.bot`、`SubFree`、`openalias.xyz` 的**完整申请门槛与当前可用性**——**未核实**。
3. **js.org 是否有非 JS 生态项目通过的例外**——**未核实**。
4. `eu.org` 2026 年的**实际平均审核时长**（官方无承诺，社区样本 2 周左右）——**未核实为官方数据**。
5. **GitHub 2025-04 中国 403 事件的官方说明与当前覆盖范围**——**未核实**，来源为第三方分析。
6. gitcode / CSDN / 什么值得买等中文教程站的内容为二手转述，文中已尽量改用官方或一手来源；个别无法替代处已标注。

---

## 七、最小行动清单（给用户）

- [ ] 提供 **GitHub 用户名** 与一个**邮箱**。
 - [ ] 想好要申请的 **is-a.dev 子域名字**（建议 `mindlight` / `xinguang` / `xin-guang`）。
- [ ] fork `is-a-dev/register`，用第三节的 JSON 模板建文件（记得填 `owner.email`）、提 PR（描述保留官方模板并逐项勾选、填链接与用途）。
- [ ] 合并后：GitHub 仓库 Settings → Pages → 填自定义域 → 保存。
- [ ] DNS 面板加一条 **CNAME**：`<名字>` → `你的用户名.github.io`。
- [ ] 生效后勾选 **Enforce HTTPS**。
- [ ] （可选，强烈建议）注册 Cloudflare，把同一仓库接一个 Pages 项目做镜像。

