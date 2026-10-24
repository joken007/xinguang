#!/usr/bin/env node
// GitHub Device Flow helper for the Xinguang release.
// Usage:
//   node tools/gh-auth.mjs start   -> prints a user code + verification URL, saves device.json next to the token
//   node tools/gh-auth.mjs poll    -> polls once (until that code expires), then writes gh-token.txt (outside the repo)
//   node tools/gh-auth.mjs wait    -> keeps a valid code alive for --minutes (default 720), beeps for attention,
//                                     and writes gh-token.txt as soon as the user authorises. Never needs attention.
//
// The OAuth app client id below is the public GitHub CLI client id; no secret is needed for device flow.
// Nothing here writes into the repository.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_ID = '178c6fc778ccc68e1d6a';
const SCOPE = 'repo read:user';
import { existsSync as _exists } from 'node:fs';
import { homedir as _homedir } from 'node:os';
import { join as _join } from 'node:path';

// Portable locations: set GIT_BIN / XINGUANG_DL to override. On this machine the portable git and the
// release scratch dir already exist, so those are picked up automatically; elsewhere the defaults apply.
const LEGACY_DL = 'E:/shiguang-testbed/dl';
const HOME_DL = _join(_homedir(), '.xinguang-release');
const DL = process.env.XINGUANG_DL || (_exists(LEGACY_DL) ? LEGACY_DL : HOME_DL);
const GIT = process.env.GIT_BIN || (_exists('E:/shiguang-testbed/git/cmd/git.exe') ? 'E:/shiguang-testbed/git/cmd/git.exe' : 'git');
const OUT_DIR = DL;
const DEVICE_FILE = join(OUT_DIR, 'device.json');
const TOKEN_FILE = join(OUT_DIR, 'gh-token.txt');
mkdirSync(OUT_DIR, { recursive: true });

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const mode = process.argv[2] || 'start';

// Never let a transient network blip kill the wait loop: a dropped TLS socket is a normal thing to
// happen over a long night, not a reason to stop listening for the token.
function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json(); }).catch(function (e) {
    return { error: 'network_error', detail: String(e && e.message ? e.message : e) };
  });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function stamp() { return new Date().toISOString().slice(11, 19); }
function beep() { try { process.stderr.write('\u0007'); } catch (e) {} }

async function newCode(reason) {
  const d = await post('https://github.com/login/device/code', { client_id: CLIENT_ID, scope: SCOPE });
  if (!d.device_code) throw new Error('device code request failed: ' + JSON.stringify(d));
  d._started_at = Date.now();
  writeFileSync(DEVICE_FILE, JSON.stringify(d, null, 2));
  console.log('[' + stamp() + '] NEW_CODE' + (reason ? ' (' + reason + ')' : ''));
  console.log('  USER_CODE=' + d.user_code + '   (expires in ' + Math.round(d.expires_in / 60) + ' min)');
  console.log('  OPEN: ' + d.verification_uri);
  beep(); beep(); beep();
  return d;
}

function loadCode() {
  if (!existsSync(DEVICE_FILE)) return null;
  try {
    const d = JSON.parse(readFileSync(DEVICE_FILE, 'utf8'));
    const started = d._started_at || 0;
    const lived = (Date.now() - started) / 1000;
    if (!d.device_code || lived > (d.expires_in || 900) - 30) return null;
    return d;
  } catch (e) { return null; }
}

async function tryToken(deviceCode) {
  const t = await post('https://github.com/login/oauth/access_token', {
    client_id: CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  });
  if (t.access_token) {
    writeFileSync(TOKEN_FILE, t.access_token);
    const me = await fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + t.access_token, 'User-Agent': 'xinguang-release' } }).then(function (r) { return r.json(); });
    console.log('[' + stamp() + '] TOKEN_OK login=' + (me.login || '?') + ' scopes=' + (t.scope || ''));
    console.log('TOKEN_FILE=' + TOKEN_FILE);
    beep(); beep(); beep();
    return { done: true };
  }
  // network_error is treated as pending: retry instead of dying.
  return { pending: t.error === 'authorization_pending' || t.error === 'slow_down' || t.error === 'network_error', error: t.error, raw: t };
}

if (mode === 'start') {
  const d = await newCode('');
  console.log('DEVICE_SAVED=' + DEVICE_FILE);
} else if (mode === 'poll') {
  const d = JSON.parse(readFileSync(DEVICE_FILE, 'utf8'));
  let interval = (d.interval || 5) * 1000;
  const deadline = Date.now() + ((d.expires_in || 900) - ((Date.now() - (d._started_at || Date.now())) / 1000)) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const r = await tryToken(d.device_code);
    if (r.done) process.exit(0);
    if (r.pending) { if (r.error === 'slow_down') interval += 5000; continue; }
    console.log('POLL_STOP ' + JSON.stringify(r.raw));
    process.exit(2);
  }
  console.log('POLL_EXPIRED');
  process.exit(3);
} else if (mode === 'wait') {
  const minutes = Number(arg('minutes', '720'));
  const hardDeadline = Date.now() + minutes * 60000;
  let lastBeat = 0;
  let netFails = 0;

  async function waitLoop() {
    let d = loadCode();
    if (d) {
      console.log('[' + stamp() + '] REUSING existing code');
      console.log('  USER_CODE=' + d.user_code + '   OPEN: ' + d.verification_uri);
    } else {
      d = await newCode('no valid code on disk');
    }
    let interval = Math.max(10000, (d.interval || 5) * 1000); // gentle: half the request volume of the spec minimum
    while (Date.now() < hardDeadline) {
      await sleep(interval);
      // Wall-clock age, never an accumulator: sleeps plus HTTP round trips drift by minutes over a night.
      const codeAge = (Date.now() - (d._started_at || Date.now())) / 1000;
      if (codeAge > (d.expires_in || 900) - 60) {
        try {
          d = await newCode('previous code expired');
          interval = Math.max(10000, (d.interval || 5) * 1000);
        } catch (e) {
          console.log('[' + stamp() + '] CODE_REFRESH_RETRY ' + (e && e.message ? e.message : e));
          beep();
          await sleep(30000);
        }
        continue;
      }
      let r;
      try {
        r = await tryToken(d.device_code);
      } catch (e) {
        r = { pending: true, error: 'network_error', raw: String(e && e.message ? e.message : e) };
      }
      if (r.done) process.exit(0);
      // The server can retire a code before our own clock says so, and a code can be rejected outright:
      // either way the one on disk is useless, so ask for a fresh one and stay alive.
      if (r.error === 'expired_token' || r.error === 'incorrect_device_code') {
        console.log('[' + stamp() + '] CODE_REJECTED ' + r.error + ' (requesting a new one)');
        d = await newCode('server rejected the code: ' + r.error);
        interval = Math.max(10000, (d.interval || 5) * 1000);
        continue;
      }
      if (!r.pending) {
        console.log('[' + stamp() + '] POLL_STOP ' + JSON.stringify(r.raw));
        process.exit(2);
      }
      if (r.error === 'network_error') {
        netFails++;
        console.log('[' + stamp() + '] NETWORK_RETRY (' + netFails + ') ' + JSON.stringify(r.raw).slice(0, 160));
        await sleep(Math.min(60000, 5000 * netFails));
        continue;
      } else { netFails = 0; }
      if (r.error === 'slow_down') interval += 5000;
      if (Date.now() - lastBeat > 60000) {
        lastBeat = Date.now();
        const left = Math.round(((d.expires_in || 900) - (Date.now() - (d._started_at || Date.now())) / 1000) / 60);
        console.log('[' + stamp() + '] WAITING code=' + d.user_code + ' code_valid_for=' + left + 'min');
        beep();
      }
    }
  }

  // Supervisor: an unexpected throw must never end the wait, it just restarts the loop.
  while (Date.now() < hardDeadline) {
    try {
      await waitLoop();
    } catch (e) {
      console.log('[' + stamp() + '] SUPERVISOR_RESTART ' + (e && e.message ? e.message : e));
      beep();
      await sleep(20000);
    }
  }
  console.log('[' + stamp() + '] WAIT_TIMEOUT after ' + minutes + ' min');
  process.exit(3);
} else {
  console.log('usage: gh-auth.mjs start|poll|wait [--minutes N]');
  process.exit(1);
}