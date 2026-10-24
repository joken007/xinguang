#!/usr/bin/env node
// Verify that a deployed Xinguang page really serves the app.
//
//   node tools/verify-live.mjs <url> [--retries 6] [--delay 5000] [--timeout 20000]
//
// Checks: index.html returns 200 -> contains the page markers -> the importmap target
// (./vendor/three.module.js) returns 200 and looks like three.js -> the quoted ES modules
// referenced by index.html all return 200. Exit code 0 = OK, 1 = FAIL.
//
// Also exported as verifyLive(url, opts) so tools/gh-release.mjs can run it right after deploy.

const MARKERS = ['心光', 'three.module.js', 'importmap'];
const MODULE_RE = /(?:src|href)="(\.\/[^"]+\.(?:js|css))"/g;

function parseArgs(argv) {
  const url = argv[0];
  function num(name, dflt) {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
  }
  return { url: url, retries: num('retries', 6), delay: num('delay', 5000), timeout: num('timeout', 20000) };
}

async function get(url, timeout) {
  const ac = new AbortController();
  const t = setTimeout(function () { ac.abort(); }, timeout);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'User-Agent': 'xinguang-verify' } });
    const body = await res.text();
    return { status: res.status, body: body, finalUrl: res.url };
  } catch (e) {
    return { status: 0, body: '', error: String(e && e.message ? e.message : e) };
  } finally { clearTimeout(t); }
}

export async function verifyLive(url, opts) {
  opts = opts || {};
  const timeout = opts.timeout || 20000;
  const base = url.replace(/\/?$/, '/');
  const notes = [];
  const page = await get(base, timeout);
  notes.push('GET ' + base + ' -> ' + (page.status || page.error));
  if (page.status !== 200) return { ok: false, notes: notes, failures: ['index.html status ' + (page.status || page.error)] };

  const failures = [];
  for (const m of MARKERS) {
    if (!page.body.includes(m)) failures.push('index.html missing marker: ' + m);
  }
  notes.push('index.html bytes=' + Buffer.byteLength(page.body, 'utf8'));

  const assets = [];
  let match;
  MODULE_RE.lastIndex = 0;
  while ((match = MODULE_RE.exec(page.body)) !== null) assets.push(match[1]);
  notes.push('local assets referenced: ' + assets.join(', '));
  if (!assets.length) failures.push('no local js/css assets found in index.html');

  for (const rel of assets) {
    const u = new URL(rel.replace(/^\.\//, ''), base).href;
    const r = await get(u, timeout);
    notes.push('GET ' + rel + ' -> ' + (r.status || r.error) + ' (' + Buffer.byteLength(r.body, 'utf8') + ' B)');
    if (r.status !== 200) failures.push(rel + ' status ' + (r.status || r.error));
    else if (rel.endsWith('three.module.js') && !/three\.js|WebGLRenderer/i.test(r.body)) failures.push(rel + ' does not look like three.js');
  }

  return { ok: failures.length === 0, notes: notes, failures: failures };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.url) { console.log('usage: node tools/verify-live.mjs <url>'); process.exit(2); }
  for (let i = 1; i <= a.retries; i++) {
    const r = await verifyLive(a.url, { timeout: a.timeout });
    console.log('ATTEMPT ' + i + '/' + a.retries + ' ' + (r.ok ? 'OK' : 'FAIL'));
    for (const n of r.notes) console.log('  ' + n);
    for (const f of r.failures) console.log('  ! ' + f);
    if (r.ok) { console.log('VERIFY_OK ' + a.url); process.exit(0); }
    if (i < a.retries) await new Promise(function (res) { setTimeout(res, a.delay); });
  }
  console.log('VERIFY_FAILED ' + a.url);
  process.exit(1);
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('verify-live.mjs');
if (invoked) main();
