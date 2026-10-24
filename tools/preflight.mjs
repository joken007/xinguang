#!/usr/bin/env node
// Read-only pre-release doctor: answers "what is still missing before this can be published?"
//
//   node tools/preflight.mjs [--repo xinguang] [--domain xinguang.is-a.dev] [--no-domain] [--json]
//
// It never writes anything: no commits, no pushes, no files. Everything it reports is a fact about
// this machine, this checkout (including whether the files Pages would serve are actually usable),
// the token (when there is one) and the domain's DNS.
//
// Exit codes: 0 everything needed is in place / 2 no token / 3 the token was rejected /
//             4 the checkout itself is unusable (not a repo, git missing, Pages needs files that
//             are not here) / 5 the checkout would not serve correctly (root-absolute path, an
//             importmap pointing at nothing, a token-shaped string in tracked files) / 6 GitHub
//             did not answer.

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCname } from 'node:dns/promises';

const LEGACY_DL = 'E:/shiguang-testbed/dl';
const HOME_DL = join(homedir(), '.xinguang-release');
const DL = process.env.XINGUANG_DL || (existsSync(LEGACY_DL) ? LEGACY_DL : HOME_DL);
const GIT = process.env.GIT_BIN || (existsSync('E:/shiguang-testbed/git/cmd/git.exe') ? 'E:/shiguang-testbed/git/cmd/git.exe' : 'git');
const REPO_DIR = process.env.XINGUANG_REPO_DIR || dirname(dirname(fileURLToPath(import.meta.url)));
const API = process.env.GH_API || 'https://api.github.com';
const TOKEN_FILE = join(DL, 'gh-token.txt');
const API_TIMEOUT = Number(process.env.GH_API_TIMEOUT_MS || 20000);

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const repoName = arg('repo', 'xinguang');
const domain = process.argv.includes('--no-domain') ? '' : arg('domain', 'xinguang.is-a.dev');
const jsonMode = process.argv.includes('--json');

const checks = [];
function add(level, name, detail, code) {
  checks.push({ level: level, name: name, detail: detail, code: code || 0 });
}

function git(args) {
  try {
    return execFileSync(GIT, ['-C', REPO_DIR].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) {
    return '';
  }
}

function jsFilesUnder(dir) {
  const out = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      for (const f of jsFilesUnder(full)) out.push(f);
    } else if (/[.]js$/.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

// ---- this machine + this checkout -------------------------------------------------------------
add('ok', 'NODE', 'v' + process.versions.node);

const gitVersion = git(['--version']);
if (!gitVersion) {
  add('bad', 'GIT', 'git is not usable (' + GIT + ')', 4);
} else {
  add('ok', 'GIT', gitVersion.replace(/^git version /, ''));
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const commits = git(['rev-list', '--count', 'HEAD']);
if (!branch || !commits) {
  add('bad', 'REPO', REPO_DIR + ' is not a git checkout with a commit', 4);
} else {
  const dirty = git(['status', '--porcelain']);
  if (dirty) {
    const n = dirty.split(String.fromCharCode(10)).length;
    add('warn', 'REPO', branch + ', ' + commits + ' commits, ' + n + ' uncommitted change(s) -- commit or stash before releasing');
  } else {
    add('ok', 'REPO', branch + ', ' + commits + ' commits, clean tree');
  }
}

const userName = git(['config', 'user.name']);
const userEmail = git(['config', 'user.email']);
if (!userName || !userEmail) {
  add('warn', 'IDENTITY', 'user.name / user.email are not set for this repository -- publish-polish would fail with exit 7');
} else {
  add('ok', 'IDENTITY', userName + ' <' + userEmail + '>');
}

const bundle = join(REPO_DIR, '心光.html');
if (!existsSync(bundle)) {
  add('warn', 'BUNDLE', '心光.html is missing -- run: node tools/build-single.mjs');
} else {
  const bundleMs = statSync(bundle).mtimeMs;
  const size = statSync(bundle).size;
  let newestMs = 0;
  for (const rel of ['src', 'vendor']) {
    for (const file of jsFilesUnder(join(REPO_DIR, rel))) {
      const ms = statSync(file).mtimeMs;
      if (ms > newestMs) newestMs = ms;
    }
  }
  if (newestMs > bundleMs + 1000) {
    add('warn', 'BUNDLE', '心光.html is older than src/ -- run: node tools/build-single.mjs (' + size + ' B)');
  } else {
    add('ok', 'BUNDLE', '心光.html ' + size + ' B, newer than src/');
  }
}

// ---- what the site itself has to look like once Pages serves it -------------------------------
function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MiB';
  if (n >= 1024) return Math.round(n / 1024) + ' KiB';
  return n + ' B';
}
function readTextRel(rel) {
  try { return readFileSync(join(REPO_DIR, rel), 'utf8'); } catch (e) { return null; }
}

const trackedRaw = git(['ls-files', '-z']);
const tracked = trackedRaw ? trackedRaw.split(String.fromCharCode(0)).filter(Boolean) : [];

const MUST_TRACK = ['index.html', 'src/main.js', 'src/styles.css', 'vendor/three.module.js', '心光.html'];
const missingMust = MUST_TRACK.filter(function (rel) { return !existsSync(join(REPO_DIR, rel)); });
if (missingMust.length) {
  add('bad', 'CHECKOUT', 'missing from this checkout: ' + missingMust.join(', '), 4);
} else {
  add('ok', 'CHECKOUT', 'the files Pages serves are all present (' + MUST_TRACK.join(', ') + ')');
}

const indexHtml = readTextRel('index.html');
if (indexHtml === null) {
  add('bad', 'SITE', 'index.html cannot be read', 5);
} else {
  const refs = [];
  const re = /(?:src|href)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(indexHtml)) !== null) refs.push(m[1]);
  const localHost = refs.filter(function (r) { return /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|file:\/\/|[A-Za-z]:\\)/i.test(r); });
  const rootAbs = refs.filter(function (r) { return r.charAt(0) === '/'; });
  if (rootAbs.length) {
    add('bad', 'SITE', 'index.html refers to root-absolute paths (' + rootAbs.slice(0, 3).join(', ') + ') -- Pages serves this repository from a subpath, so those 404', 5);
  } else if (localHost.length) {
    add('bad', 'SITE', 'index.html points at this machine (' + localHost.slice(0, 3).join(', ') + ') -- that address does not exist for visitors', 5);
  } else {
    add('ok', 'SITE', 'index.html uses relative paths only (' + refs.length + ' src/href references)');
  }

  const im = indexHtml.match(/"three"\s*:\s*"([^"]+)"/);
  if (!im) {
    add('bad', 'IMPORTMAP', 'index.html has no importmap entry for "three" -- the scene would never load', 5);
  } else {
    const target = im[1].replace(/^\.\//, '');
    const abs = join(REPO_DIR, target);
    if (!existsSync(abs)) {
      add('bad', 'IMPORTMAP', 'index.html imports three from ' + im[1] + ' but that file is not here', 5);
    } else {
      add('ok', 'IMPORTMAP', '"three" -> ' + im[1] + ' (' + fmtBytes(statSync(abs).size) + ')');
    }
  }

  const nojekyll = existsSync(join(REPO_DIR, '.nojekyll'));
  if (!nojekyll) {
    add('warn', 'NOJEKYLL', '.nojekyll is missing -- nothing breaks today, but Jekyll would start processing files that begin with _');
  } else {
    add('ok', 'NOJEKYLL', '.nojekyll present (Pages serves the files as they are)');
  }

  const manifestText = readTextRel('site.webmanifest');
  if (manifestText === null) {
    add('warn', 'MANIFEST', 'site.webmanifest is missing -- installable-app metadata will be ignored');
  } else {
    try {
      const man = JSON.parse(manifestText);
      const icons = Array.isArray(man.icons) ? man.icons : [];
      if (!man.name || !icons.length) {
        add('warn', 'MANIFEST', 'site.webmanifest needs a name and at least one icon');
      } else {
        const gone = icons.filter(function (ic) { return !existsSync(join(REPO_DIR, String(ic.src || '').replace(/^\.\//, ''))); });
        if (gone.length) {
          add('warn', 'MANIFEST', 'site.webmanifest lists icons that are not here: ' + gone.map(function (ic) { return ic.src; }).join(', '));
        } else {
          add('ok', 'MANIFEST', man.name + ', ' + icons.length + ' icons, all present');
        }
      }
    } catch (e) {
      add('warn', 'MANIFEST', 'site.webmanifest is not valid JSON (' + (e && e.message) + ')');
    }
  }
}

// ---- repository hygiene: the things GitHub will refuse, or leak -------------------------------
let totalBytes = 0;
let largest = { rel: '', size: 0 };
for (const rel of tracked) {
  let st = null;
  try { st = statSync(join(REPO_DIR, rel)); } catch (e) { continue; }
  if (!st.isFile()) continue;
  totalBytes += st.size;
  if (st.size > largest.size) largest = { rel: rel, size: st.size };
}
if (largest.size > 100 * 1024 * 1024) {
  add('bad', 'SIZE', largest.rel + ' is ' + fmtBytes(largest.size) + ' -- GitHub refuses files over 100 MiB', 5);
} else if (largest.size > 50 * 1024 * 1024) {
  add('warn', 'SIZE', largest.rel + ' is ' + fmtBytes(largest.size) + ' -- over 50 MiB, GitHub warns about it');
} else if (totalBytes > 1024 * 1024 * 1024) {
  add('bad', 'SIZE', fmtBytes(totalBytes) + ' tracked -- a GitHub Pages site is capped at 1 GiB', 5);
} else {
  add('ok', 'SIZE', tracked.length + ' files, ' + fmtBytes(totalBytes) + ', largest ' + largest.rel + ' ' + fmtBytes(largest.size));
}

const TOKEN_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /Bearer\s+gh[pousr]_[A-Za-z0-9]{20,}/];
const TEXT_EXT = /\.(?:js|mjs|css|html|md|json|yml|yaml|txt|webmanifest)$/;
const leaks = [];
for (const rel of tracked) {
  if (!TEXT_EXT.test(rel)) continue;
  const text = readTextRel(rel);
  if (!text) continue;
  if (TOKEN_PATTERNS.some(function (p) { return p.test(text); })) leaks.push(rel);
}
if (leaks.length) {
  add('bad', 'SECRETS', 'token-looking strings in tracked files: ' + leaks.slice(0, 3).join(', ') + ' -- remove them before pushing', 5);
} else {
  add('ok', 'SECRETS', 'no token-looking strings in the ' + tracked.filter(function (r) { return TEXT_EXT.test(r); }).length + ' tracked text files');
}

const scratch = tracked.filter(function (rel) {
  const name = rel.split('/').pop();
  return /^\.gitcred/.test(name) || /-token\.txt$/.test(name) || /\.log$/.test(name) || /\.tmp$/.test(name);
});
if (scratch.length) {
  add('warn', 'TRACKED', 'scratch files are tracked: ' + scratch.slice(0, 5).join(', ') + ' -- untrack them, they will be published');
}

// ---- the token --------------------------------------------------------------------------------
let token = process.env.GITHUB_TOKEN || '';
let tokenSource = token ? '$env:GITHUB_TOKEN' : '';
if (!token && existsSync(TOKEN_FILE)) {
  token = readFileSync(TOKEN_FILE, 'utf8').trim();
  tokenSource = TOKEN_FILE;
}
if (!token) {
  add('bad', 'TOKEN', 'not found -- run: node tools/gh-auth.mjs start, or leave a repo-scoped token at ' + TOKEN_FILE, 2);
} else {
  add('ok', 'TOKEN', 'found in ' + tokenSource + ' (' + token.length + ' chars, value never printed)');
}

async function api(path) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(API + path, {
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'xinguang-preflight'
        },
        signal: AbortSignal.timeout(API_TIMEOUT)
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 200) }; }
      return { status: res.status, json: json, scopes: res.headers.get('x-oauth-scopes') || '' };
    } catch (e) {
      lastErr = e;
    }
  }
  const why = lastErr && lastErr.cause && lastErr.cause.code ? lastErr.cause.code : String(lastErr && lastErr.message);
  return { status: 0, json: { error: 'network_error', detail: why }, scopes: '' };
}

let owner = '';
if (token) {
  const me = await api('/user');
  if (me.status === 0) {
    add('bad', 'AUTH', 'GitHub did not answer: ' + (me.json.detail || 'network error'), 6);
  } else if (me.status >= 500) {
    add('bad', 'AUTH', 'GitHub answered HTTP ' + me.status + ' -- that is their side, try again later', 6);
  } else if (me.status !== 200) {
    add('bad', 'AUTH', 'the token was rejected (HTTP ' + me.status + ') -- re-run node tools/gh-auth.mjs start', 3);
  } else {
    owner = me.json.login;
    const scopes = me.scopes.trim();
    if (scopes && !/repo|public_repo/.test(scopes)) {
      add('warn', 'AUTH', "login=" + owner + " but the scopes are '" + scopes + "' -- creating a repository needs repo");
    } else {
      add('ok', 'AUTH', 'login=' + owner + ' scopes=' + (scopes || '(fine-grained token, no scope list)'));
    }
  }
}

if (owner) {
  const repo = await api('/repos/' + owner + '/' + repoName);
  if (repo.status === 0) {
    add('bad', 'REPO_LOOKUP', 'GitHub did not answer: ' + (repo.json.detail || 'network error'), 6);
  } else if (repo.status >= 500) {
    add('bad', 'REPO_LOOKUP', 'GitHub answered HTTP ' + repo.status + ' -- try again later', 6);
  } else if (repo.status === 404) {
    add('ok', 'REPO_LOOKUP', owner + '/' + repoName + ' does not exist yet (gh-release creates it)');
  } else if (repo.status !== 200) {
    add('warn', 'REPO_LOOKUP', 'lookup answered HTTP ' + repo.status);
  } else {
    add('ok', 'REPO_LOOKUP', repo.json.full_name + ' already exists (' + (repo.json.private ? 'private' : 'public') + ')');
    const pages = await api('/repos/' + owner + '/' + repoName + '/pages');
    if (pages.status === 0) {
      add('bad', 'PAGES', 'GitHub did not answer: ' + (pages.json.detail || 'network error'), 6);
    } else if (pages.status >= 500) {
      add('bad', 'PAGES', 'GitHub answered HTTP ' + pages.status + ' -- try again later', 6);
    } else if (pages.status === 404) {
      add('warn', 'PAGES', 'not enabled yet -- gh-release turns it on');
    } else if (pages.status === 200) {
      add('ok', 'PAGES', 'on, ' + (pages.json.html_url || '') + (pages.json.cname ? ', custom domain ' + pages.json.cname : ''));
    } else {
      add('warn', 'PAGES', 'lookup answered HTTP ' + pages.status);
    }
  }
}

// ---- the domain ------------------------------------------------------------------------------
if (domain) {
  try {
    const records = await resolveCname(domain);
    add('ok', 'DOMAIN', domain + ' CNAME ' + records.join(', '));
  } catch (e) {
    add('warn', 'DOMAIN', domain + ' has no CNAME yet (' + (e.code || 'lookup failed') + ') -- expected until the is-a.dev PR is merged');
  }
}

// ---- summary ---------------------------------------------------------------------------------
const bad = checks.filter(function (c) { return c.level === 'bad'; });
const warns = checks.filter(function (c) { return c.level === 'warn'; });
const summary = bad.length
  ? 'blocked on: ' + bad.map(function (c) { return c.name; }).join(', ')
  : 'ready to release' + (warns.length ? ' (' + warns.length + ' warning' + (warns.length === 1 ? '' : 's') + ')' : '');

if (jsonMode) {
  console.log(JSON.stringify({ summary: summary, checks: checks }, null, 2));
} else {
  for (const c of checks) {
    const tag = c.level === 'ok' ? '' : c.level === 'warn' ? 'WARN ' : 'FAIL ';
    console.log(tag + c.name + ': ' + c.detail);
  }
  console.log('SUMMARY ' + summary);
}
process.exit(bad.length ? bad[0].code : 0);