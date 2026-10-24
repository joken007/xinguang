#!/usr/bin/env node
// Apply for a free is-a.dev subdomain by fork + branch + file + pull request.
//   node tools/gh-domain.mjs --domain xinguang --email you@example.com [--repo xinguang] [--dry-run]

import { readFileSync, existsSync } from 'node:fs';

import { existsSync as _exists } from 'node:fs';
import { homedir as _homedir } from 'node:os';
import { join as _join } from 'node:path';

const LEGACY_DL = 'E:/shiguang-testbed/dl';
const HOME_DL = _join(_homedir(), '.xinguang-release');
const DL = process.env.XINGUANG_DL || (_exists(LEGACY_DL) ? LEGACY_DL : HOME_DL);
const UPSTREAM = 'is-a-dev/register';

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const domain = arg('domain', 'xinguang');
const repoName = arg('repo', 'xinguang');
const note = arg('note', '');
const siteOverride = arg('site', '');
const dryRun = process.argv.includes('--dry-run');
// Note: the is-a.dev schema has no email field any more, so --email is accepted but unused.

let token = process.env.GITHUB_TOKEN || '';
if (!token && existsSync(DL + '/gh-token.txt')) token = readFileSync(DL + '/gh-token.txt', 'utf8').trim();
if (!token) { console.log('NO_TOKEN'); process.exit(2); }
if (process.argv.includes('--email')) console.log('NOTE --email is no longer part of the is-a.dev schema; ignoring it');

async function api(method, path, body) {
  const res = await fetch('https://api.github.com' + path, {
    method: method,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'xinguang-domain', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json: json };
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

const me = await api('GET', '/user');
if (me.status !== 200) { console.log('AUTH_FAILED ' + me.status); process.exit(3); }
const owner = me.json.login;
const full = domain + '.is-a.dev';
const filePath = 'domains/' + full + '.json';

// Preflight: is the live site actually reachable? is-a.dev rejects requests for sites that are not up.
// Best-effort only (a transient network hiccup must not block the dry run).
try {
  const probe = await fetch(siteOverride || ('https://' + owner + '.github.io/' + repoName + '/'), { method: 'GET', redirect: 'follow' });
  console.log('SITE_PREFLIGHT ' + probe.status + ' ' + (siteOverride || ('https://' + owner + '.github.io/' + repoName + '/')));
  if (probe.status !== 200) console.log('WARN the live site did not return 200; is-a.dev requires a live, non-empty site');
} catch (e) { console.log('SITE_PREFLIGHT unreachable (' + (e && e.message) + ')'); }
const taken = await api('GET', '/repos/' + UPSTREAM + '/contents/' + filePath);
if (taken.status === 200) { console.log('DOMAIN_TAKEN ' + full); process.exit(4); }
console.log('DOMAIN_AVAILABLE ' + full);

const payload = {
  owner: { username: owner },
  records: { CNAME: owner + '.github.io' }
};
console.log('PAYLOAD ' + JSON.stringify(payload));
if (dryRun) { console.log('DRY_RUN done'); process.exit(0); }

const fork = await api('POST', '/repos/' + UPSTREAM + '/forks');
if (fork.status !== 202 && fork.status !== 200) { console.log('FORK_FAILED ' + fork.status); process.exit(5); }
const defaultBranch = (fork.json && fork.json.default_branch) || 'main';
for (let i = 0; i < 30; i++) {
  const chk = await api('GET', '/repos/' + owner + '/register');
  if (chk.status === 200) break;
  await sleep(2000);
}
console.log('FORK_READY ' + owner + '/register base=' + defaultBranch);

const branch = 'add-' + domain;
const baseRef = await api('GET', '/repos/' + owner + '/register/git/ref/heads/' + defaultBranch);
if (baseRef.status !== 200) { console.log('BASE_REF_FAILED ' + baseRef.status); process.exit(6); }
const madeRef = await api('POST', '/repos/' + owner + '/register/git/refs', { ref: 'refs/heads/' + branch, sha: baseRef.json.object.sha });
if (madeRef.status === 201) console.log('BRANCH_CREATED ' + branch);
else if (madeRef.status !== 422) { console.log('BRANCH_FAILED ' + madeRef.status); process.exit(7); }

const content = Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8').toString('base64');
const put = await api('PUT', '/repos/' + owner + '/register/contents/' + filePath, { message: 'Add ' + full, content: content, branch: branch });
if (put.status === 201 || put.status === 200) console.log('FILE_WRITTEN ' + filePath);
else { console.log('FILE_FAILED ' + put.status); process.exit(8); }

const site = siteOverride || ('https://' + owner + '.github.io/' + repoName + '/');
const description = note || 'Xinguang (心光) is an open-source three.js / WebGL mindfulness webpage. A calming quote appears at random; every touch lifts the sun one frame higher, and the scene slowly reveals forest, sea and mountains.';
const body = [
  '## Domain',
  '',
  full,
  '',
  '## Description',
  '',
  description,
  '',
  'Live site: ' + site,
  'Source: https://github.com/' + owner + '/' + repoName,
  '',
  'Preview:',
  '',
  '![preview](' + site + 'preview/03-bright.png)',
  '',
  '---',
  '',
  '- [x] The site is already live and this is an open-source, non-commercial project',
  '- [x] I have read the contribution guidelines'
].join('\n');
console.log('PR_BODY_PREVIEW ---');
console.log(body);
console.log('--- end');
const pr = await api('POST', '/repos/' + UPSTREAM + '/pulls', { title: 'Add ' + full, head: owner + ':' + branch, base: defaultBranch, body: body });
if (pr.status === 201) console.log('PR_OPENED ' + pr.json.html_url);
else console.log('PR_FAILED ' + pr.status + ' ' + JSON.stringify(pr.json).slice(0, 400));
console.log('REMINDER is-a.dev asks that the request be written by a human: open the PR and rewrite the description in your own words before a maintainer looks at it.');
