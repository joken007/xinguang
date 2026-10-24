#!/usr/bin/env node
// Read-only pre-release doctor: answers "what is still missing before this can be published?"
//
//   node tools/preflight.mjs [--repo xinguang] [--domain xinguang.is-a.dev] [--no-domain] [--json]
//
// It never writes anything: no commits, no pushes, no files. Everything it reports is a fact about
// this machine, this checkout, the token (when there is one) and the domain's DNS.
//
// Exit codes: 0 everything needed is in place / 2 no token / 3 the token was rejected /
//             4 the checkout itself is unusable (not a repo, git missing) / 6 GitHub did not answer.

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