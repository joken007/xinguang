#!/usr/bin/env node
/*
 * 把多文件的 three.js 应用打包成一个可以直接双击打开的 HTML。
 *
 *   node tools/build-single.mjs  →  E:\心光\心光.html
 *
 * 原理：浏览器在 file:// 下会因为同源策略拒绝加载外部 ES module，
 * 所以把 three.module.js 与所有 src/*.js 去掉 import / export，
 * 改成一段段经典 <script>：three 的公共名字挂到 window.__XG__.three，
 * 每个模块包在 IIFE 里、导出挂到 window.__XG__.m0 / m1 …，互相引用走 __XG__。
 * 代码里没有 import.meta、没有默认导出、没有动态 import，因此这样做是安全的。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT = path.join(ROOT, "心光.html");
const VENDOR = path.join(ROOT, "vendor", "three.module.js");
const ENTRY = path.join(ROOT, "src", "main.js");

/* ---------- 解析 import / export ---------- */

const IMPORT_RE = /(^|\n)[ \t]*import[ \t]+([\s\S]*?)from[ \t]*(['"])([^'"]+)\3/g;
const BARE_IMPORT_RE = /(^|\n)[ \t]*import[ \t]+(['"])([^'"]+)\2/g;
const EXPORT_PREFIX_RE = /(^|\n)([ \t]*)export[ \t]+(const|let|var|function|class)[ \t]+([A-Za-z_$][\w$]*)/g;
const EXPORT_LIST_RE = /(^|\n)[ \t]*export[ \t]*\{([\s\S]*?)\}[ \t]*;?/g;

function collectImports(src) {
  const out = [];
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      let end = m.index + m[0].length;
      while (end < src.length && /[;\s]/.test(src[end])) end++;
      out.push({ start: m.index, end, clause: (m[2] || "").trim(), spec: m[4] || m[3] });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/* 按"标记法"删除 import 语句：先把每个 import 覆盖的下标标记出来，再原样拼接
 * 未被标记的片段。相邻 import 的区间会重叠 1 个字符（上一个 match 尾部吃掉的
 * 换行，正好是下一个 match 的起始换行），如果按"先删后面、再删前面"的顺序
 * 用 slice 拼接，后一次的 end 下标会错位一格，把紧跟其后的代码（比如注释开头
 * 的两个字符）吃掉。标记法与顺序无关，不会错位。 */
function stripImports(src) {
  const marks = new Uint8Array(src.length);
  for (const imp of collectImports(src)) {
    for (let i = imp.start; i < imp.end && i < src.length; i++) marks[i] = 1;
  }
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (marks[i]) { i++; continue; }
    let j = i;
    while (j < src.length && !marks[j]) j++;
    out += src.slice(i, j);
    i = j;
  }
  return out;
}

function stripExports(src) {
  const exported = [];
  let code = src.replace(EXPORT_PREFIX_RE, (all, nl, sp, kind, name) => {
    exported.push({ local: name, name });
    return nl + sp + kind + " " + name;
  });
  code = code.replace(EXPORT_LIST_RE, (all, nl, inner) => {
    for (const raw of inner.split(",")) {
      const item = raw.trim();
      if (!item) continue;
      const mm = item.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (mm) exported.push({ local: mm[1], name: mm[2] });
      else exported.push({ local: item, name: item });
    }
    return nl;
  });
  return { code, exported };
}

/* ---------- 模块图 ---------- */

const files = [];
const byFile = new Map();
let counter = 0;

function visit(abs) {
  if (byFile.has(abs)) return byFile.get(abs);
  const id = "m" + counter++;
  byFile.set(abs, id);
  files.push(abs);
  const dir = path.dirname(abs);
  for (const imp of collectImports(fs.readFileSync(abs, "utf8"))) {
    if (imp.spec === "three") continue;
    visit(path.resolve(dir, imp.spec));
  }
  return id;
}

function namespaceLine(id, exported) {
  const pairs = exported.map((e) => e.name + ": " + e.local);
  return "window.__XG__." + id + " = { " + pairs.join(", ") + " };";
}

function importLines(imp, ns) {
  const lines = [];
  const clause = imp.clause;
  const nsRef = "window.__XG__." + ns;
  const star = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (star) {
    lines.push("const " + star[1] + " = " + nsRef + ";");
    return lines;
  }
  const braces = clause.match(/^\{([\s\S]*)\}$/);
  if (braces) {
    for (const raw of braces[1].split(",")) {
      const it = raw.trim();
      if (!it) continue;
      const mm = it.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (mm) lines.push("const " + mm[2] + " = " + nsRef + "." + mm[1] + ";");
      else if (/^[A-Za-z_$][\w$]*$/.test(it)) lines.push("const " + it + " = " + nsRef + "." + it + ";");
      else lines.push("throw new Error(" + JSON.stringify("无法解析的 import 项: " + it) + ");");
    }
    return lines;
  }
  lines.push("const " + clause + " = " + nsRef + ".__default;");
  return lines;
}

/* ---------- three.module.js ---------- */

const threeSrc = fs.readFileSync(VENDOR, "utf8");
const threeImports = collectImports(threeSrc);
if (threeImports.length) throw new Error("three.module.js 出现了 import: " + JSON.stringify(threeImports));
const three = stripExports(threeSrc);

const threeScript = [
  "/* ===== three.module.js (r169) ===== */",
  three.code,
  namespaceLine("three", three.exported),
].join("\n");

/* ---------- 业务模块 ---------- */

visit(ENTRY);

/* 先把每个文件的依赖算出来，再做一次后序拓扑排序：被依赖的模块必须先注册，
 * 否则引用方执行到 window.__XG__.mN.X 时 mN 还是 undefined。
 * files 是 entry-first 的 DFS 顺序（main.js 排在最前），不能直接拿来内联。 */
const info = files.map((abs) => {
  const src = fs.readFileSync(abs, "utf8");
  const imports = collectImports(src);
  const deps = new Map();
  for (const imp of imports) {
    if (imp.spec === "three") deps.set(imp.spec, "three");
    else deps.set(imp.spec, path.resolve(path.dirname(abs), imp.spec));
  }
  return { abs, src, imports, deps };
});

const byAbs = new Map(info.map((m) => [m.abs, m]));
const order = [];
const done = new Set();
const visiting = new Set();
function topo(abs) {
  if (done.has(abs) || visiting.has(abs)) return;
  visiting.add(abs);
  const m = byAbs.get(abs);
  if (m) {
    for (const dep of m.deps.values()) {
      if (dep !== "three" && byAbs.has(dep)) topo(dep);
    }
  }
  visiting.delete(abs);
  done.add(abs);
  order.push(abs);
}
for (const m of info) topo(m.abs);

const modules = order.map((abs) => {
  const id = byFile.get(abs);
  const m = byAbs.get(abs);
  const stripped = stripExports(stripImports(m.src));
  const lines = [];
  lines.push("/* ===== " + path.relative(ROOT, abs).replace(/\\/g, "/") + " ===== */");
  lines.push("(function () {");
  for (const imp of m.imports) {
    const dep = m.deps.get(imp.spec);
    const ns = dep === "three" ? "three" : byFile.get(dep);
    for (const l of importLines(imp, ns)) lines.push("  " + l);
  }
  lines.push(stripped.code.trim());
  if (stripped.exported.length) lines.push(namespaceLine(id, stripped.exported));
  lines.push("})();");
  return lines.join("\n");
});

/* ---------- HTML ---------- */

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "src", "styles.css"), "utf8");

let out = html;
out = out.replace(/<link rel="stylesheet"[^>]*>/, "<style>\n" + css + "\n</style>");
out = out.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, "");
const scripts = [
  "<script>\nwindow.__XG__ = {};\n" + threeScript + "\n</script>",
].concat(modules.map((m) => "<script>\n" + m + "\n</script>"));
const tag = /<script type="module"[^>]*src="[^"]*main\.js"[^>]*><\/script>/;
if (!tag.test(out)) throw new Error("没有在 index.html 里找到 main.js 的 module script");
// 注意：replace 的字符串替换会把 $'、$&、$1 当作特殊记号，而 three 的源码里就有 $'，
// 所以这里必须用函数形式的替换，返回值按字面量插入。
out = out.replace(tag, () => scripts.join("\n"));

fs.writeFileSync(OUT, out, "utf8");

console.log("已生成", OUT);
console.log("  体积:", (Buffer.byteLength(out, "utf8") / 1024 / 1024).toFixed(2), "MB");
console.log("  模块数:", files.length);
for (const abs of files) console.log("   -", path.relative(ROOT, abs).replace(/\\/g, "/"));
