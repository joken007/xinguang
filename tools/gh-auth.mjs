#!/usr/bin/env node
// GitHub Device Flow helper for the Xinguang release.
// Usage:
//   node tools/gh-auth.mjs start   -> prints a user code + verification URL, saves device.json next to the token
//   node tools/gh-auth.mjs poll    -> polls until the user authorises, then writes gh-token.txt (outside the repo)
//
// The OAuth app client id below is the public GitHub CLI client id; no secret is needed for device flow.
// Nothing here writes into the repository.

import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT_ID = '178c6fc778ccc68e1d6a';
const SCOPE = 'repo read:user';
const OUT_DIR = 'E:/shiguang-testbed/dl';
const DEVICE_FILE = join(OUT_DIR, 'device.json');
const TOKEN_FILE = join(OUT_DIR, 'gh-token.txt');

const mode = process.argv[2] || 'start';

function post(url, body, headers) {
  return fetch(url, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, headers || {}),
    body: JSON.stringify(body)
  }).then(function (r) { return r.json(); });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

if (mode === 'start') {
  const d = await post('https://github.com/login/device/code', { client_id: CLIENT_ID, scope: SCOPE });
  if (!d.device_code) { console.log('FAILED ' + JSON.stringify(d)); process.exit(1); }
  writeFileSync(DEVICE_FILE, JSON.stringify(d, null, 2));
  console.log('USER_CODE=' + d.user_code);
  console.log('VERIFY_URL=' + d.verification_uri);
  console.log('EXPIRES_IN=' + d.expires_in + 's  INTERVAL=' + d.interval + 's');
  console.log('DEVICE_SAVED=' + DEVICE_FILE);
} else if (mode === 'poll') {
  const d = JSON.parse(readFileSync(DEVICE_FILE, 'utf8'));
  let interval = (d.interval || 5) * 1000;
  const deadline = Date.now() + (d.expires_in || 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const t = await post('https://github.com/login/oauth/access_token', {
      client_id: CLIENT_ID, device_code: d.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
    });
    if (t.access_token) {
      writeFileSync(TOKEN_FILE, t.access_token);
      const me = await fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer ' + t.access_token, 'User-Agent': 'xinguang-release' } }).then(function (r) { return r.json(); });
      console.log('TOKEN_OK login=' + (me.login || '?') + ' scopes=' + (t.scope || ''));
      console.log('TOKEN_FILE=' + TOKEN_FILE);
      process.exit(0);
    }
    if (t.error === 'authorization_pending') { continue; }
    if (t.error === 'slow_down') { interval += 5000; continue; }
    console.log('POLL_STOP ' + JSON.stringify(t));
    process.exit(2);
  }
  console.log('POLL_EXPIRED');
  process.exit(3);
} else {
  console.log('usage: gh-auth.mjs start|poll');
  process.exit(1);
}
