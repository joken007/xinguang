#!/usr/bin/env node
// Point the GitHub Pages site at the free is-a.dev subdomain, once that pull request has been merged.
//
//   node tools/gh-custom-domain.mjs --domain xinguang.is-a.dev [--repo xinguang] [--check-url <url>] [--dry-run]
//
// The token is read from (in order): $env:GITHUB_TOKEN, then E:/shiguang-testbed/dl/gh-token.txt.
// It is never printed.
//
// Steps: confirm the Pages site exists -> PUT the custom domain -> wait until the API reports it ->
// ask for enforced HTTPS (the certificate can take up to an hour, so a refusal here is a warning, not a
// failure) -> open the domain and run the same live check the release uses.
//
// GitHub's order matters: only set the custom domain AFTER the is-a.dev pull request is merged, otherwise
// the domain does not point at anything yet and the site starts answering 404. This tool refuses to run
// when Pages is not enabled, so the earlier steps cannot be skipped.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { verifyLive } from './verify-live.mjs';

const LEGACY_DL = 'E:/shiguang-testbed/dl';
const HOME_DL = join(homedir(), '.xinguang-release');
const DL = process.env.XINGUANG_DL || (existsSync(LEGACY_DL) ? LEGACY_DL : HOME_DL);
const API = process.env.GH_API || 'https://api.github.com'; // GH_API is an offline-rehearsal hook
const API_TIMEOUT = Number(process.env.GH_API_TIMEOUT_MS || 30000);
const POLL_MS = Number(process.env.PAGES_POLL_MS || 5000);
const POLL_TRIES = Number(process.env.PAGES_POLL_TRIES || 12);

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function flag(name) { return process.argv.includes('--' + name); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

const domain = arg('domain', '');
const repoName = arg('repo', 'xinguang');
const checkUrlArg = arg('check-url', '');
const retries = Number(arg('retries', '6'));
const delay = Number(arg('delay', '5000'));
const dryRun = flag('dry-run');

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
if (!domain) { console.log('NO_DOMAIN pass --domain xinguang.is-a.dev'); process.exit(2); }
if (!DOMAIN_RE.test(domain)) { console.log('BAD_DOMAIN ' + JSON.stringify(domain) + ' (want a bare hostname like xinguang.is-a.dev)'); process.exit(2); }

let token = process.env.GITHUB_TOKEN || '';
if (!token && existsSync(DL + '/gh-token.txt')) token = readFileSync(DL + '/gh-token.txt', 'utf8').trim();
if (!token) { console.log('NO_TOKEN set $env:GITHUB_TOKEN, or run: node tools/gh-auth.mjs start'); process.exit(2); }

async function api(method, path, body) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API + path, {
        method: method,
        headers: {
          Authorization: 'Bearer ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'xinguang-custom-domain',
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(API_TIMEOUT)
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 400) }; }
      return { status: res.status, json: json };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(2000);
    }
  }
  return { status: 0, json: { error: String(lastErr && lastErr.message ? lastErr.message : lastErr) } };
}

const me = await api('GET', '/user');
if (me.status === 0) { console.log('NETWORK_FAILED /user ' + JSON.stringify(me.json).slice(0, 300)); process.exit(6); }
if (me.status !== 200) { console.log('AUTH_FAILED ' + me.status); process.exit(3); }
const owner = me.json.login;
const pagesPath = '/repos/' + owner + '/' + repoName + '/pages';
console.log('AUTHENTICATED ' + owner);

const before = await api('GET', pagesPath);
if (before.status === 0) { console.log('NETWORK_FAILED ' + pagesPath + ' ' + JSON.stringify(before.json).slice(0, 300)); process.exit(6); }
console.log('PAGES_LOOKUP status=' + before.status);
if (before.status === 404) {
  console.log('PAGES_NOT_ENABLED run node tools/gh-release.mjs first: a custom domain needs a Pages site to point at');
  process.exit(4);
}
if (before.status !== 200) { console.log('PAGES_LOOKUP_FAILED ' + before.status + ' ' + JSON.stringify(before.json).slice(0, 300)); process.exit(6); }

const checkUrl = checkUrlArg || ('https://' + domain + '/');
if (dryRun) {
  console.log('PLAN set cname=' + domain + ' on ' + owner + '/' + repoName);
  console.log('PLAN enforce HTTPS (warn only if the certificate is not ready yet)');
  console.log('PLAN verify ' + checkUrl);
  console.log('DRY_RUN done');
  process.exit(0);
}

const current = before.json && before.json.cname ? before.json.cname : '';
if (current === domain) {
  console.log('ALREADY_CNAME ' + domain);
} else {
  const put = await api('PUT', pagesPath, { cname: domain });
  if (put.status === 0) { console.log('NETWORK_FAILED PUT ' + pagesPath + ' ' + JSON.stringify(put.json).slice(0, 300)); process.exit(6); }
  if (put.status !== 200 && put.status !== 204) { console.log('CNAME_FAILED ' + put.status + ' ' + JSON.stringify(put.json).slice(0, 300)); process.exit(6); }
  console.log('CNAME_SET ' + domain + (current ? ' (was ' + current + ')' : ''));
}

let settled = false;
for (let i = 1; i <= POLL_TRIES; i++) {
  const st = await api('GET', pagesPath);
  const got = st.status === 200 && st.json && st.json.cname ? st.json.cname : '';
  console.log('PAGES_WAIT ' + i + '/' + POLL_TRIES + ' cname=' + (got || '(none)') + ' https_enforced=' + (st.status === 200 && st.json ? !!st.json.https_enforced : '?'));
  if (got === domain) { settled = true; break; }
  if (i < POLL_TRIES) await sleep(POLL_MS);
}
if (!settled) console.log('WARN GitHub has not reported the custom domain yet; it usually does within a minute, so re-run this later if the line below fails');

let httpsState = 'pending';
for (let i = 1; i <= POLL_TRIES; i++) {
  const st = await api('GET', pagesPath);
  if (st.status === 200 && st.json && st.json.https_enforced) { httpsState = 'already'; break; }
  const put = await api('PUT', pagesPath, { https_enforced: true });
  if (put.status === 200 || put.status === 204) { httpsState = 'enforced'; break; }
  console.log('HTTPS_WAIT ' + i + '/' + POLL_TRIES + ' status=' + put.status + ' (the certificate can take up to an hour)');
  if (i < POLL_TRIES) await sleep(POLL_MS);
}
if (httpsState === 'already') console.log('HTTPS_ALREADY');
else if (httpsState === 'enforced') console.log('HTTPS_ENFORCED');
else console.log('HTTPS_PENDING run this again in a few minutes: Settings -> Pages -> Enforce HTTPS was not accepted yet');

let ok = false;
for (let i = 1; i <= Math.max(1, retries); i++) {
  const r = await verifyLive(checkUrl, { timeout: 20000 });
  console.log('VERIFY ' + i + '/' + Math.max(1, retries) + ' ' + (r.ok ? 'OK' : 'FAIL'));
  for (const n of r.notes) console.log('  ' + n);
  for (const f of r.failures) console.log('  ! ' + f);
  if (r.ok) { ok = true; break; }
  if (i < Math.max(1, retries)) await sleep(delay);
}
if (ok) { console.log('LIVE_URL ' + checkUrl); console.log('LIVE_VERIFY OK'); process.exit(0); }
console.log('VERIFY_FAILED ' + checkUrl);
console.log('NOTE DNS for a freshly merged is-a.dev domain can take a few minutes; if this keeps failing, check Settings -> Pages -> Custom domain');
process.exit(5);