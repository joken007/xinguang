#!/usr/bin/env node
// One-shot GitHub release for the Xinguang project.
//
//   node tools/gh-release.mjs [--repo xinguang] [--private]
//
// The token is read from (in order): $env:GITHUB_TOKEN, then E:/shiguang-testbed/dl/gh-token.txt.
// It is never printed. The credential is passed to git through a temporary store file that is deleted
// as soon as the push finishes, so nothing is left in .git/config.
//
// Steps: create repo (skipped if it exists) -> add remote -> push main -> enable GitHub Pages -> wait for the build.

import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { existsSync as _exists } from 'node:fs';
import { homedir as _homedir } from 'node:os';
import { join as _join, dirname as _dirname } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';

const LEGACY_DL = 'E:/shiguang-testbed/dl';
const HOME_DL = _join(_homedir(), '.xinguang-release');
const DL = process.env.XINGUANG_DL || (_exists(LEGACY_DL) ? LEGACY_DL : HOME_DL);
const GIT = process.env.GIT_BIN || (_exists('E:/shiguang-testbed/git/cmd/git.exe') ? 'E:/shiguang-testbed/git/cmd/git.exe' : 'git');
const REPO_DIR = _dirname(_dirname(_fileURLToPath(import.meta.url))); // tools/ -> repo root
const API = process.env.GH_API || 'https://api.github.com';            // GH_API / GH_REMOTE_BASE / GH_LIVE_BASE are offline-rehearsal hooks
const REMOTE_BASE = process.env.GH_REMOTE_BASE || 'https://github.com';
const LIVE_BASE = process.env.GH_LIVE_BASE || '';
// Every network leg is bounded. Without these a half-dead GitHub turns the release into a log that
// never moves and never exits -- and by then the token is already sitting on disk.
const API_TIMEOUT = Number(process.env.GH_API_TIMEOUT_MS || 30000);
const GIT_TIMEOUT = Number(process.env.GIT_TIMEOUT_MS || 600000);
mkdirSync(DL, { recursive: true });

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const repoName = arg('repo', 'xinguang');
const isPrivate = process.argv.includes('--private');

let token = process.env.GITHUB_TOKEN || '';
if (!token && existsSync(DL + '/gh-token.txt')) token = readFileSync(DL + '/gh-token.txt', 'utf8').trim();
if (!token) {
  console.log('NO_TOKEN: set $env:GITHUB_TOKEN, or run: node tools/gh-auth.mjs start  (then poll)');
  process.exit(2);
}

// status 0 means "the request never got an answer" (timeout / dropped socket), which callers must
// report as a network failure rather than silently treating as an auth or repo error.
async function api(method, path, body) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'xinguang-release',
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(API_TIMEOUT)
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 400) }; }
      return { status: res.status, json };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise(function (r) { setTimeout(r, 2000 * (attempt + 1)); });
    }
  }
  const why = lastErr && lastErr.cause && lastErr.cause.code ? lastErr.cause.code : String(lastErr && lastErr.message);
  return { status: 0, json: { error: 'network_error', detail: why } };
}

function git(args, extraEnv) {
  return execFileSync(GIT, args, {
    cwd: REPO_DIR,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT,
    killSignal: 'SIGKILL',
    // Never let git stop to ask a human for credentials: fail loudly instead of hanging a script.
    env: Object.assign({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, process.env, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

const me = await api('GET', '/user');
if (me.status === 0) { console.log('NETWORK_FAILED /user ' + JSON.stringify(me.json).slice(0, 300)); process.exit(6); }
if (me.status !== 200) { console.log('AUTH_FAILED status=' + me.status + ' ' + JSON.stringify(me.json).slice(0, 300)); process.exit(3); }
const owner = me.json.login;
console.log('AUTHENTICATED as ' + owner + ' (' + (me.json.name || '') + ')');

const desc = 'A mindfulness page: every touch lifts the sun one frame. three.js / WebGL, no build step.';
const TOPICS = ['mindfulness', 'meditation', 'threejs', 'webgl', 'generative-art'];
let created = await api('POST', '/user/repos', {
  name: repoName, private: isPrivate, description: desc,
  has_issues: true, has_wiki: false, has_projects: false, auto_init: false
});
if (created.status === 0) { console.log('NETWORK_FAILED /user/repos ' + JSON.stringify(created.json).slice(0, 300)); process.exit(6); }
if (created.status === 201) console.log('REPO_CREATED ' + created.json.full_name);
else if (created.status === 422) console.log('REPO_EXISTS (reusing)');
else { console.log('REPO_ERROR status=' + created.status + ' ' + JSON.stringify(created.json).slice(0, 400)); process.exit(4); }

const remoteUrl = REMOTE_BASE + '/' + owner + '/' + repoName + '.git';
console.log('REMOTE ' + remoteUrl);

// One credential file per process. Two releases running at once (a re-run started while the first is
// still pushing) must never share a file: if they do, whichever finishes first deletes the credential
// the other one is mid-push with. The pid in the name also lets a sweeper tell "leftover of a dead
// process" from "live file of a running one" without guessing from timestamps.
const credFile = DL + '/.gitcred-' + process.pid + '.tmp';
// git matches a stored credential on protocol + host, so both have to be read off the real remote or
// the entry is never found. (Reading them off remoteUrl also keeps the offline rehearsal honest.)
let credBase = 'https://github.com';
try {
  const u = new URL(remoteUrl);
  if (u.protocol === 'http:' || u.protocol === 'https:') credBase = u.protocol + '//' + u.host;
} catch (e) {}
writeFileSync(credFile, credBase.replace('://', '://x-access-token:' + token + '@') + '\n');
// A killed process skips finally blocks, which would leave the token in cleartext on disk. Drop it on
// the way out of an interrupt too. (On Windows these handlers only fire for a real console Ctrl-C; the
// watcher's startup sweep is the backstop for everything else.)
function dropCred() { try { unlinkSync(credFile); } catch (e) {} }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, function () { dropCred(); process.exit(130); });
process.on('exit', dropCred);
let pushed = false;
try {
  const out = git([
    '-c', 'credential.helper=',                                  // drop any preconfigured helper (GCM etc.)
    // forward slashes: git re-parses this value through shell rules, where backslashes are escapes
    '-c', 'credential.helper=store --file=' + credFile.replace(/\\/g, '/'),
    '-c', 'credential.interactive=false',
    // Push to the URL itself, not to a named remote: adding origin first would mean a push that fails
    // (or a process killed mid-push) leaves the repo pointing at a release that never landed.
    'push', remoteUrl, 'main'
  ]);
  pushed = true;
  console.log('PUSH ' + out.trim().split(/\r?\n/).slice(-1)[0]);
} catch (e) {
  // execFileSync throws on a non-zero exit; without this the script would die on a raw stack trace and
  // leave the caller to guess whether the code reached the remote.
  const why = String((e && e.stderr) || (e && e.message) || e).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
  console.log('PUSH_FAILED ' + why.slice(0, 400));
  process.exit(5);
} finally {
  dropCred();
}

// Only after the branch is really on the remote does the repo get a remote to point at.
if (pushed) {
  const existing = git(['remote']).split(/\r?\n/).filter(Boolean);
  if (existing.includes('origin')) git(['remote', 'set-url', 'origin', remoteUrl]);
  else git(['remote', 'add', 'origin', remoteUrl]);
  console.log('REMOTE_ADDED origin -> ' + remoteUrl);
  // Rebuild the tracking ref locally instead of fetching it back: we just pushed this very commit, so
  // refs/remotes/origin/main is known, and a fetch here would be one more network dependency that can
  // hang on a half-dead remote after the release has already landed.
  try {
    git(['update-ref', 'refs/remotes/origin/main', 'refs/heads/main']);
    git(['config', 'branch.main.remote', 'origin']);
    git(['config', 'branch.main.merge', 'refs/heads/main']);
    console.log('UPSTREAM origin/main');
  } catch (e) {
    // Tracking is a convenience; not having it must not fail an otherwise good release.
    console.log('UPSTREAM_SKIPPED ' + String((e && e.message) || e).split(/\r?\n/)[0].slice(0, 200));
  }
}

const pagesRepo = '/' + owner + '/' + repoName;
let pages = await api('POST', '/repos' + pagesRepo + '/pages', { source: { branch: 'main', path: '/' } });
if (pages.status === 201) console.log('PAGES_ENABLED');
else if (pages.status === 409) console.log('PAGES_ALREADY_ENABLED');
else if (pages.status === 0) { console.log('NETWORK_FAILED /pages ' + JSON.stringify(pages.json).slice(0, 300)); process.exit(6); }
else { console.log('PAGES_SETUP status=' + pages.status + ' ' + JSON.stringify(pages.json).slice(0, 300)); process.exit(7); }

const url = (LIVE_BASE || ('https://' + owner + '.github.io')) + '/' + repoName + '/';
for (let i = 0; i < 20; i++) {
  await new Promise(function (r) { setTimeout(r, 15000); });
  const st = await api('GET', '/repos' + pagesRepo + '/pages');
  const status = st.json && st.json.status;
  console.log('PAGES_BUILD ' + (i + 1) + '/20 status=' + status);
  if (status === 'built') break;
  if (status === 'errored') { console.log('PAGES_ERRORED ' + JSON.stringify(st.json).slice(0, 300)); break; }
}

// Verify the deployed site actually serves the app (retry: the first build can lag the API status).
const { verifyLive } = await import('./verify-live.mjs');
let v = { ok: false, failures: ['not run'] };
for (let i = 0; i < 6; i++) {
  v = await verifyLive(url, { timeout: 20000 });
  if (v.ok) break;
  console.log('LIVE_VERIFY retry ' + (i + 1) + '/6 ' + v.failures.join(' | '));
  await new Promise(function (r) { setTimeout(r, 8000); });
}
for (const n of v.notes) console.log('  ' + n);
for (const w of (v.warnings || [])) console.log('  ~ ' + w);
const result = v.ok ? 'OK' : 'FAILED';
console.log('LIVE_VERIFY ' + result);
for (const f of v.failures) console.log('  ! ' + f);
if (!v.ok) {
  console.log('ERROR: deployed site verification failed. Exiting with code 1.');
  process.exit(1);
}

// A public repo is easier to find when its homepage points at the live site and it carries a few
// topics. Both calls are cosmetic: a rate limit, a scope that is too narrow or a changed API must not
// fail a release that has already landed.
try {
  const hp = await api('PATCH', '/repos' + pagesRepo, { homepage: url, description: desc });
  console.log(hp.status === 200 ? 'REPO_HOMEPAGE ' + url : 'REPO_HOMEPAGE_SKIPPED status=' + hp.status);
  const tp = await api('PUT', '/repos' + pagesRepo + '/topics', { names: TOPICS });
  console.log(tp.status === 200 ? 'REPO_TOPICS ' + ((tp.json && tp.json.names) || []).join(', ') : 'REPO_TOPICS_SKIPPED status=' + tp.status);
} catch (e) {
  console.log('REPO_METADATA_SKIPPED ' + String((e && e.message) || e).slice(0, 200));
}

const head = await api('GET', '/repos/' + owner + '/' + repoName + '/commits/main');
console.log('LIVE_URL ' + url);
console.log('PAGES_URL ' + (pages.json && pages.json.html_url ? pages.json.html_url : url));
console.log('HEAD ' + (head.json && head.json.sha ? head.json.sha.slice(0, 7) : '?'));
