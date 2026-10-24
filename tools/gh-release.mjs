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

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const GIT = 'E:/shiguang-testbed/git/cmd/git.exe';
const REPO_DIR = 'E:/心光';
const DL = 'E:/shiguang-testbed/dl';
const API = 'https://api.github.com';

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

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'xinguang-release',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 400) }; }
  return { status: res.status, json };
}

function git(args, extraEnv) {
  return execFileSync(GIT, args, {
    cwd: REPO_DIR,
    encoding: 'utf8',
    env: Object.assign({}, process.env, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

const me = await api('GET', '/user');
if (me.status !== 200) { console.log('AUTH_FAILED status=' + me.status + ' ' + JSON.stringify(me.json).slice(0, 300)); process.exit(3); }
const owner = me.json.login;
console.log('AUTHENTICATED as ' + owner + ' (' + (me.json.name || '') + ')');

const desc = 'A mindfulness page: every touch lifts the sun one frame. three.js / WebGL, no build step.';
let created = await api('POST', '/user/repos', {
  name: repoName, private: isPrivate, description: desc,
  has_issues: true, has_wiki: false, has_projects: false, auto_init: false
});
if (created.status === 201) console.log('REPO_CREATED ' + created.json.full_name);
else if (created.status === 422) console.log('REPO_EXISTS (reusing)');
else { console.log('REPO_ERROR status=' + created.status + ' ' + JSON.stringify(created.json).slice(0, 400)); process.exit(4); }

const remoteUrl = 'https://github.com/' + owner + '/' + repoName + '.git';
const existing = git(['remote']).split(/\r?\n/).filter(Boolean);
if (existing.includes('origin')) git(['remote', 'set-url', 'origin', remoteUrl]);
else git(['remote', 'add', 'origin', remoteUrl]);
console.log('REMOTE ' + remoteUrl);

const credFile = DL + '/.gitcred-tmp';
writeFileSync(credFile, 'https://x-access-token:' + token + '@github.com\n');
try {
  const out = git([
    '-c', 'credential.helper=store --file=' + credFile,
    'push', '-u', 'origin', 'main'
  ]);
  console.log('PUSH ' + out.trim().split(/\r?\n/).slice(-1)[0]);
} finally {
  try { unlinkSync(credFile); } catch (e) {}
}

const pagesRepo = '/' + owner + '/' + repoName;
let pages = await api('POST', '/repos' + pagesRepo + '/pages', { source: { branch: 'main', path: '/' } });
if (pages.status === 201) console.log('PAGES_ENABLED');
else if (pages.status === 409) console.log('PAGES_ALREADY_ENABLED');
else console.log('PAGES_SETUP status=' + pages.status + ' ' + JSON.stringify(pages.json).slice(0, 300));

const url = 'https://' + owner + '.github.io/' + repoName + '/';
for (let i = 0; i < 20; i++) {
  await new Promise(function (r) { setTimeout(r, 15000); });
  const st = await api('GET', '/repos' + pagesRepo + '/pages');
  const status = st.json && st.json.status;
  console.log('PAGES_BUILD ' + (i + 1) + '/20 status=' + status);
  if (status === 'built') break;
  if (status === 'errored') { console.log('PAGES_ERRORED ' + JSON.stringify(st.json).slice(0, 300)); break; }
}

const head = await api('GET', '/' + owner + '/' + repoName + '/commits/main');
console.log('LIVE_URL ' + url);
console.log('PAGES_URL ' + (pages.json && pages.json.html_url ? pages.json.html_url : url));
console.log('HEAD ' + (head.json && head.json.sha ? head.json.sha.slice(0, 7) : '?'));
