#!/usr/bin/env node
// Verify that a deployed Xinguang page really serves the app.
//
//   node tools/verify-live.mjs <url> [--retries 6] [--delay 5000] [--timeout 20000]
//
// Checks: index.html returns 200 -> contains the page markers -> the importmap entry for "three"
// (./vendor/three.module.js) returns 200 and looks like three.js -> the quoted ES modules
// referenced by index.html all return 200, with a javascript/css content type. The single-file
// build (心光.html) is reported as a warning if it is missing. Exit code 0 = OK, 1 = FAIL.
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
    return { status: res.status, body: body, finalUrl: res.url, ctype: String(res.headers.get('content-type') || '') };
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

  // The three.js build is loaded through the importmap, not through a src= attribute, so the asset
  // loop below never sees it. A broken vendor path is worth catching here: in the browser its only
  // symptom is a canvas that stays black.
  const im = page.body.match(/"three"\s*:\s*"([^"]+)"/);
  notes.push('importmap three -> ' + (im ? im[1] : '(none)'));
  if (!im) failures.push('index.html has no importmap entry for "three"');
  else {
    const rel = im[1].replace(/^\.\//, '');
    const tr = await get(new URL(rel, base).href, timeout);
    notes.push('GET ' + im[1] + ' -> ' + (tr.status || tr.error) + ' (' + Buffer.byteLength(tr.body, 'utf8') + ' B)');
    if (tr.status !== 200) failures.push(im[1] + ' status ' + (tr.status || tr.error));
    else if (!/three\.js|WebGLRenderer/i.test(tr.body)) failures.push(im[1] + ' does not look like three.js');
    else if (!/javascript|ecmascript/i.test(tr.ctype)) failures.push(im[1] + ' is served as ' + (tr.ctype || 'no content-type') + ' (ES modules need a javascript type)');
  }

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
    // A module served as text/plain is a classic broken deploy: the browser refuses it and the
    // only symptom is an empty canvas, so check the header while we are here.
    else if (rel.endsWith('.js') && !/javascript|ecmascript/i.test(r.ctype)) failures.push(rel + ' is served as ' + (r.ctype || 'no content-type') + ' (ES modules need a javascript type)');
    else if (rel.endsWith('.css') && !/text\/css/i.test(r.ctype)) failures.push(rel + ' is served as ' + (r.ctype || 'no content-type'));

  }

  // The single-file build is a shipped artifact (open it offline from the repo), not the entry point,
  // so a host that does not serve it is a warning rather than a broken site.
  const warnings = [];
  const bundleRel = '心光.html';
  const bundle = await get(new URL(encodeURI(bundleRel), base).href, timeout);
  notes.push('GET ' + bundleRel + ' -> ' + (bundle.status || bundle.error) + ' (' + Buffer.byteLength(bundle.body, 'utf8') + ' B)');
  if (bundle.status !== 200) warnings.push(bundleRel + ' is not reachable (' + (bundle.status || bundle.error) + '): the single-file build is missing from the deployment');
  else if (!bundle.body.includes('心光')) warnings.push(bundleRel + ' does not look like the app');

  // Install metadata (the manifest and its icons) does not break the page if it 404s, so it is
  // reported as warnings: the site still works, it just cannot be installed and the browser tab
  // has no icon.
  const manRel = 'site.webmanifest';
  const man = await get(new URL(manRel, base).href, timeout);
  if (man.status !== 200) warnings.push(manRel + ' is not reachable (' + (man.status || man.error) + '): no install metadata');
  else {
    let meta = null;
    try { meta = JSON.parse(man.body); } catch (e) { warnings.push(manRel + ' is not valid JSON'); }
    if (meta) {
      notes.push('manifest name=' + (meta.name || '(none)') + ', icons=' + ((meta.icons || []).length));
      if (!meta.name) warnings.push(manRel + ' has no name');
      for (const ic of (meta.icons || [])) {
        const src = ic && ic.src;
        if (!src) continue;
        const ir = await get(new URL(src.replace(/^\.\//, ''), base).href, timeout);
        notes.push('GET ' + src + ' -> ' + (ir.status || ir.error));
        if (ir.status !== 200) warnings.push(src + ' (manifest icon) status ' + (ir.status || ir.error));
        else if (!/image\//i.test(ir.ctype)) warnings.push(src + ' is served as ' + (ir.ctype || 'no content-type'));
      }
    }
  }

  return { ok: failures.length === 0, notes: notes, failures: failures, warnings: warnings };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.url) { console.log('usage: node tools/verify-live.mjs <url>'); process.exit(2); }
  for (let i = 1; i <= a.retries; i++) {
    const r = await verifyLive(a.url, { timeout: a.timeout });
    console.log('ATTEMPT ' + i + '/' + a.retries + ' ' + (r.ok ? 'OK' : 'FAIL'));
    for (const n of r.notes) console.log('  ' + n);
    for (const f of r.failures) console.log('  ! ' + f);
    for (const w of (r.warnings || [])) console.log('  ~ ' + w);
    if (r.ok) { console.log('VERIFY_OK ' + a.url); process.exit(0); }
    if (i < a.retries) await new Promise(function (res) { setTimeout(res, a.delay); });
  }
  console.log('VERIFY_FAILED ' + a.url);
  process.exit(1);
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('verify-live.mjs');
if (invoked) main();
