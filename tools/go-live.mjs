#!/usr/bin/env node
// One command to go live: doctor -> release -> point the metadata at the live address.
//
//   node tools/go-live.mjs [--repo xinguang] [--skip-polish]
//
// watch-and-release.mjs does the same chain in the background, but it has to be running when the
// token appears and it gives up after its window (a week). This is the foreground version: run it
// yourself and watch it happen -- useful when the watcher is not running, or when you would rather
// see each step than read a log afterwards.
//
// The doctor runs first on purpose. Publishing a site whose index.html points at a root path, or
// whose bundle is stale, wastes a deployment: the failure shows up as a 404 in the browser instead
// of as a line here.
//
// Exit codes: the exit code of the step that failed (preflight 2/3/4/5/6, gh-release 1..8). 0 when
// the site is live. A failed polish does NOT fail the run: the site is already up, and the exact
// command to redo the metadata is printed.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const NL = String.fromCharCode(10);

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const repo = arg('repo', 'xinguang');
const skipPolish = process.argv.includes('--skip-polish');

function run(script, args) {
  const r = spawnSync(process.execPath, [join(HERE, script)].concat(args), {
    encoding: 'utf8', timeout: 30 * 60 * 1000, env: process.env
  });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out);
  return { code: r.status === null ? 1 : r.status, out: out };
}

// --- 1. the doctor ----------------------------------------------------------------
const doc = run('preflight.mjs', ['--repo', repo, '--no-domain']);
const summary = (doc.out.match(/^SUMMARY .*$/m) || ['(no SUMMARY line)'])[0];
console.log('DOCTOR ' + summary);
if (doc.code !== 0) {
  const why = {
    2: 'no token -- run node tools/gh-auth.mjs start and finish the browser step, or leave a repo-scoped token in the release directory',
    3: 'the token was rejected by GitHub -- make one with repo scope and try again',
    4: 'this checkout cannot be published as it stands (see CHECKOUT above)',
    5: 'the site would break on Pages (see the lines above) -- this is worth fixing before deploying',
    6: 'GitHub did not answer -- not something to fix in this repository, try again later'
  }[doc.code] || 'the doctor said no';
  console.log('ERROR: ' + why + '.');
  console.log('GO_LIVE_ABORTED preflight exit ' + doc.code);
  process.exit(doc.code);
}

// --- 2. the release ---------------------------------------------------------------
const rel = run('gh-release.mjs', ['--repo', repo]);
const liveMatch = rel.out.match(/^LIVE_URL (\S+)$/m);
const liveUrl = liveMatch ? liveMatch[1].trim() : '';
if (rel.code !== 0) {
  console.log('ERROR: the release failed (gh-release exit ' + rel.code + '); the lines above say why.');
  console.log('GO_LIVE_ABORTED release exit ' + rel.code);
  process.exit(rel.code);
}
if (!/^https?:\/\/[^/]+\//.test(liveUrl)) {
  console.log('ERROR: the release did not print a usable LIVE_URL, so the metadata cannot be pointed anywhere.');
  console.log('GO_LIVE_ABORTED no live url');
  process.exit(1);
}
console.log('LIVE ' + liveUrl);

// --- 3. the metadata --------------------------------------------------------------
let polished = 'not run';
if (skipPolish) polished = '--skip-polish';
else {
  const pol = run('publish-polish.mjs', ['--url', liveUrl, '--push']);
  polished = pol.code === 0 ? 'done' : 'failed (exit ' + pol.code + ')';
  if (pol.code !== 0) {
    console.log('NOTE: the site is live, but the metadata still points at the old address.');
    console.log('NOTE: redo it with: node tools/publish-polish.mjs --url ' + liveUrl + ' --push');
  }
}

console.log('GO_LIVE ' + liveUrl + ' :: polish ' + polished);
console.log('NEXT the site is at the address above. If you want the short domain as well:');
console.log('NEXT   node tools/gh-domain.mjs --domain xinguang --email <a public address of yours>');
console.log('NEXT   (open the pull request that prints, and merge it once is-a.dev accepts it)');
console.log('NEXT   node tools/gh-custom-domain.mjs --domain xinguang.is-a.dev');
process.exit(0);