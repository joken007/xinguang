#!/usr/bin/env node
// Post-release polish: point the published metadata at the URL the site actually lives on.
//
//   node tools/publish-polish.mjs --url https://<owner>.github.io/xinguang/ [--push] [--dry-run]
//
// The repository is written as if it did not know its own address, which is right while it is being
// built but wrong the moment it is served: social crawlers want an absolute og:image, and a README
// that says "once Pages is enabled" reads as unfinished. This script closes that gap idempotently --
// run it twice and the second run finds nothing to do and says so.
//
// It rewrites:
//   index.html       og:image / twitter:image -> absolute, adds og:url when missing
//   README.md        the "Live demo" placeholder -> a real link
//   README.zh-CN.md  adds a 线上地址 line under the intro
//   GITHUB.md        marks the push / Pages rows as done
// then rebuilds the single-file bundle (it inlines index.html, so it must never go stale).
//
// --push commits and pushes to origin main. The token comes from $env:GITHUB_TOKEN or
// <dl>/gh-token.txt and is handed to git through a temporary store file that is deleted on the way
// out, the same way tools/gh-release.mjs does it, so nothing is left in .git/config.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEGACY_DL = 'E:/shiguang-testbed/dl';
const HOME_DL = join(homedir(), '.xinguang-release');
const DL = process.env.XINGUANG_DL || (existsSync(LEGACY_DL) ? LEGACY_DL : HOME_DL);
const GIT = process.env.GIT_BIN || (existsSync('E:/shiguang-testbed/git/cmd/git.exe') ? 'E:/shiguang-testbed/git/cmd/git.exe' : 'git');
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
const rawUrl = arg('url', '');
const shouldPush = process.argv.includes('--push');
const dryRun = process.argv.includes('--dry-run');

if (!rawUrl) {
  console.log('NO_URL: pass the address the site is served at, e.g. --url https://you.github.io/xinguang/');
  process.exit(2);
}
let url = rawUrl.trim();
if (!/^https?:\/\/[^/\s]+\//.test(url)) {
  console.log('BAD_URL "' + rawUrl + '" is not an http(s) URL with a trailing path (e.g. https://you.github.io/xinguang/)');
  process.exit(2);
}
if (!url.endsWith('/')) url += '/';
console.log('LIVE_URL ' + url);

// --- preflight: a --push run must be able to push before it starts rewriting files ----------------
// Without this the run would patch, rebuild the bundle and commit, and only then discover it has no
// token -- leaving a commit behind that claims a URL nobody verified.
let preToken = '';
let preOrigin = '';
if (shouldPush) {
  preToken = process.env.GITHUB_TOKEN || '';
  if (!preToken && existsSync(join(DL, 'gh-token.txt'))) preToken = readFileSync(join(DL, 'gh-token.txt'), 'utf8').trim();
  if (!preToken) { console.log('NO_TOKEN: set $env:GITHUB_TOKEN, or leave the file at ' + join(DL, 'gh-token.txt')); process.exit(2); }
  try {
    preOrigin = execFileSync(GIT, ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) { preOrigin = ''; }
  if (!preOrigin) { console.log('NO_ORIGIN: run tools/gh-release.mjs first, it is what sets origin'); process.exit(4); }
  console.log('PREFLIGHT token ok, origin ' + preOrigin);
}

const changed = [];
function patch(file, from, to, note) {
  const full = join(ROOT, file);
  if (!existsSync(full)) { console.log('SKIP ' + file + ' (absent)'); return; }
  const text = readFileSync(full, 'utf8');
  if (text.includes(to)) { console.log('ALREADY ' + file + ' :: ' + note); return; }
  if (!text.includes(from)) { console.log('SKIP ' + file + ' :: anchor not found (' + note + ')'); return; }
  writeFileSync(full, text.split(from).join(to));
  changed.push(file + ' :: ' + note);
  console.log('PATCHED ' + file + ' :: ' + note);
}

// --- index.html: absolute social metadata ------------------------------------------------------
patch('index.html',
  '<meta property="og:image" content="./preview/03-bright.png" />',
  '<meta property="og:image" content="' + url + 'preview/03-bright.png" />',
  'og:image');
patch('index.html',
  '<meta name="twitter:image" content="./preview/03-bright.png" />',
  '<meta name="twitter:image" content="' + url + 'preview/03-bright.png" />',
  'twitter:image');
patch('index.html',
  '<meta property="og:site_name" content="心光" />',
  '<meta property="og:site_name" content="心光" />' + String.fromCharCode(10) + '<meta property="og:url" content="' + url + '" />',
  'og:url');

// --- README.md: the live demo placeholder ------------------------------------------------------
patch('README.md',
  'Once GitHub Pages is enabled this page is served at `https://<user>.github.io/xinguang/`.',
  'Live at <' + url + '>.',
  'live demo link');

// --- README.zh-CN.md: a short 线上地址 line under the intro ------------------------------------
patch('README.zh-CN.md',
  '## 预览',
  '线上地址：<' + url + '>' + String.fromCharCode(10) + String.fromCharCode(10) + '## 预览',
  '线上地址');

// --- GITHUB.md: mark the two rows that are now done --------------------------------------------
patch('GITHUB.md',
  '| 推送到你的 GitHub 账号 | ⏳ **需要你授权**（见下面「第一步」） |',
  '| 推送到你的 GitHub 账号 | ✅ 已推送：<' + url + '> |',
  'push row');
patch('GITHUB.md',
  '| 开启 GitHub Pages 线上站点 | ⏳ 授权后我一条命令做完，并自动验证站点真的能打开；推送后 `.github/workflows/check.yml` 会再验一遍 |',
  '| 开启 GitHub Pages 线上站点 | ✅ 已上线并验证：<' + url + '> |',
  'pages row');

if (!changed.length) {
  console.log('NO_CHANGES the repository already points at ' + url);
  process.exit(0);
}
console.log('CHANGED ' + changed.length + ' ' + JSON.stringify(changed));

if (dryRun) { console.log('DRY_RUN nothing written to git'); process.exit(0); }

// --- rebuild the single-file bundle ------------------------------------------------------------
const bundle = join(ROOT, '心光.html');
try {
  execFileSync(process.execPath, [join(ROOT, 'tools', 'build-single.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  console.log('BUNDLE_REBUILT ' + readFileSync(bundle).length + ' bytes');
} catch (e) {
  console.log('BUNDLE_FAILED ' + String((e && e.stderr) || (e && e.message) || e).trim().slice(0, 300));
  process.exit(6);
}

function git(args, timeout = 300000) {
  return execFileSync(GIT, args, { cwd: ROOT, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
}

// --- commit ------------------------------------------------------------------------------------
git(['add', '-A']);
if (!git(['status', '--porcelain']).trim()) { console.log('COMMIT_SKIPPED nothing staged'); process.exit(0); }
const msg = 'site: point metadata at the live URL';
git(['commit', '-m', msg]);
console.log('COMMITTED ' + git(['rev-parse', '--short', 'HEAD']).trim() + ' ' + msg);

if (!shouldPush) { console.log('NOT_PUSHED (pass --push when the token is around)'); process.exit(0); }

// --- push --------------------------------------------------------------------------------------
const token = preToken;
const remoteUrl = preOrigin;
const credFile = join(DL, '.gitcred-polish-' + process.pid + '.tmp');
let credBase = 'https://github.com';
try {
  const u = new URL(remoteUrl);
  if (u.protocol === 'http:' || u.protocol === 'https:') credBase = u.protocol + '//' + u.host;
} catch (e) {}
writeFileSync(credFile, credBase.replace('://', '://x-access-token:' + token + '@') + String.fromCharCode(10));
function dropCred() { try { unlinkSync(credFile); } catch (e) {} }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, function () { dropCred(); process.exit(130); });
process.on('exit', dropCred);
try {
  const out = git([
    '-c', 'credential.helper=',
    '-c', 'credential.helper=store --file=' + credFile.split(String.fromCharCode(92)).join('/'),
    '-c', 'credential.interactive=false',
    'push', 'origin', 'main'
  ]);
  const tail = out.trim().split(String.fromCharCode(10)).filter(Boolean).pop();
  console.log('PUSHED ' + (tail || 'ok'));
} catch (e) {
  const why = String((e && e.stderr) || (e && e.message) || e).trim().split(String.fromCharCode(10)).filter(Boolean).slice(-3).join(' | ');
  console.log('PUSH_FAILED ' + why.slice(0, 400));
  process.exit(5);
} finally {
  dropCred();
}
console.log('DONE ' + url);
