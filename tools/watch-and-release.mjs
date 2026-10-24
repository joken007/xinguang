#!/usr/bin/env node
// Wait for the GitHub device-flow token to appear, then publish automatically.
// Nothing here is required: it exists so that the moment the user authorises, the repo is created,
// pushed, Pages is switched on, the live URL is verified, and the metadata is then pointed at that
// URL -- all without anyone having to say go. Set SKIP_POLISH=1 to stop after the release.
//
//   node tools/watch-and-release.mjs [--repo xinguang] [--hours 12]
import { readFileSync, existsSync, appendFileSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEGACY_DL = 'E:/shiguang-testbed/dl';
const DL = process.env.XINGUANG_DL || (existsSync(LEGACY_DL) ? LEGACY_DL : join(homedir(), '.xinguang-release'));
const TOKEN_FILE = join(DL, 'gh-token.txt');
const LOG = join(DL, 'watcher.log');
const RELEASE = join(HERE, 'gh-release.mjs');
const POLISH = join(HERE, 'publish-polish.mjs');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const repoName = arg('repo', 'xinguang');
const rawHours = arg('hours', '12');
const hours = Number(rawHours);
// The release is bounded too: a half-dead GitHub must end in a loud failure, not a log that never moves.
const rawReleaseTimeout = process.env.RELEASE_TIMEOUT_MS;
const RELEASE_TIMEOUT_MS = rawReleaseTimeout === undefined ? 20 * 60 * 1000 : Number(rawReleaseTimeout);
// Same trap as --hours: NaN goes into setTimeout, Node clamps it to 1 ms, and the release is killed
// before it can push. A mistyped knob has to stop the run, not silently sabotage it.
if (!Number.isFinite(RELEASE_TIMEOUT_MS) || RELEASE_TIMEOUT_MS <= 0) {
  console.error('BAD_ENV RELEASE_TIMEOUT_MS expects a positive number, got ' + JSON.stringify(rawReleaseTimeout));
  process.exit(2);
}
function note(m) { const line = '[' + new Date().toISOString() + '] ' + m; try { appendFileSync(LOG, line + '\n'); } catch (e) { console.error('LOG_WRITE_FAILED ' + (e && e.message) + ' :: ' + m); } console.log(line); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// gh-release wipes its temporary credential file on the way out, but a process killed outright never
// runs that code -- and that file holds a live token in cleartext. Sweep up on the way in, so a crash
// can only ever leave it until the next run rather than forever.
//
// Ownership comes from the file name: gh-release writes .gitcred-<pid>.tmp, so a file whose pid is no
// longer running is a leftover, while one whose pid is alive belongs to a release that may be mid-push.
// Timestamps are the wrong test for that -- a busy machine can make a live file look minutes old, and
// a second watcher deleting the credential under a running push breaks it for no reason.
// Older versions wrote a bare .gitcred-tmp with no pid; those fall back to age.
const rawStaleAge = process.env.STALE_CRED_AGE_MS;
const STALE_CRED_AGE_MS = rawStaleAge === undefined ? 120000 : Number(rawStaleAge);
// A typo here must not silently widen the sweep: Number('abc') is NaN, and every comparison against
// NaN is false, which would quietly turn "leave young files alone" into "delete everything".
if (!Number.isFinite(STALE_CRED_AGE_MS) || STALE_CRED_AGE_MS <= 0) {
  console.error('BAD_ENV STALE_CRED_AGE_MS expects a positive number, got ' + JSON.stringify(rawStaleAge));
  process.exit(2);
}
// A live pid is not proof of ownership: Windows recycles pid numbers, so once an unrelated process
// inherits a dead release's pid, its leftover credential looks "in use" forever. Nothing legitimate
// holds one longer than a single release, so age is the tiebreaker for that case.
const rawMaxAge = process.env.STALE_CRED_MAX_AGE_MS;
const maxAgeRequested = rawMaxAge === undefined ? 2 * 60 * 60 * 1000 : Number(rawMaxAge);
if (!Number.isFinite(maxAgeRequested) || maxAgeRequested <= 0) {
  console.error('BAD_ENV STALE_CRED_MAX_AGE_MS expects a positive number, got ' + JSON.stringify(rawMaxAge));
  process.exit(2);
}
// That knob is double-edged: set it too low and it eats the credential of a release that is still
// pushing. A release can never outlive RELEASE_TIMEOUT_MS, so the effective cap has a floor of one
// release plus a minute -- the knob can raise the cap, never lower it into a running push.
const STALE_CRED_MAX_AGE_MS = Math.max(maxAgeRequested, RELEASE_TIMEOUT_MS + 60000);
function ageText(ms) { return ms < 1000 ? Math.round(ms) + 'ms' : Math.round(ms / 1000) + 's'; }
// Checked last on purpose: a mistyped knob is the more interesting mistake, so "--hours abc" must not
// bury a bad RELEASE_TIMEOUT_MS behind its own complaint.
// A typo must not be laundered into "I waited long enough": NaN would make the deadline NaN and the
// loop fall straight through to GAVE_UP, which reads like a successful timeout.
if (!Number.isFinite(hours) || hours <= 0) { console.error('BAD_ARG --hours expects a positive number, got ' + JSON.stringify(rawHours)); process.exit(2); }
// .gitcred-<pid>.tmp is what gh-release writes now; .gitcred-tmp is the name older versions used.
const CRED_RE = /^\.gitcred(?:-(\d+))?[-.]tmp$/;
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}
function sweepStaleCred() {
  let names = [];
  try { names = readdirSync(DL).filter(n => CRED_RE.test(n)); } catch (e) { return 0; }
  let swept = 0;
  for (const name of names) {
    const full = join(DL, name);
    const m = CRED_RE.exec(name);
    const ownerPid = m && m[1] ? Number(m[1]) : 0;
    try {
      const age = Date.now() - statSync(full).mtimeMs;
      if (ownerPid) {
        if (pidAlive(ownerPid)) {
          if (age <= STALE_CRED_MAX_AGE_MS) { note('CRED_FILE_IN_USE left alone (pid ' + ownerPid + ' is running) ' + name); continue; }
          unlinkSync(full);
          note('STALE_CRED_REMOVED_AGED ' + full + ' (pid ' + ownerPid + ' is alive but the file is ' + ageText(age) + ' old)');
          swept++; continue;
        }
        unlinkSync(full); note('STALE_CRED_REMOVED ' + full); swept++; continue;
      }
      if (age < STALE_CRED_AGE_MS) { note('CRED_FILE_IN_USE left alone (' + ageText(age) + ' old) ' + name); continue; }
      unlinkSync(full); note('STALE_CRED_REMOVED ' + full); swept++;
    } catch (e) { note('CRED_FILE_UNREADABLE ' + full + ' :: ' + (e && e.message)); }
  }
  return swept;
}
sweepStaleCred();
// Our own child's credential can go once its release is over -- but only if we actually ran one. A
// watcher that merely waited, gave up and exited must not delete a credential another process holds.
let releaseStarted = false;
function dropCred() {
  if (!releaseStarted) return false;
  return sweepStaleCred() > 0;
}
// Note: on Windows a handler is only reached for a real console Ctrl-C; a TerminateProcess kill runs
// nothing, which is exactly why the startup sweep above exists.
process.on('exit', dropCred);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, function () { dropCred(); process.exit(130); });

note('WATCHING for ' + TOKEN_FILE + ' (repo=' + repoName + ', up to ' + hours + 'h)');
const deadline = Date.now() + hours * 3600 * 1000;
let token = '';
while (Date.now() < deadline) {
  if (existsSync(TOKEN_FILE)) {
    try {
      const t = readFileSync(TOKEN_FILE, 'utf8').trim();
      // The waiter writes this file with a single writeFileSync, so a readable non-empty value is complete.
      // Do NOT second-guess its shape here: whether the token is good is the API's call (a bad one makes
      // gh-release exit 3 loudly). A length heuristic would just turn a clear failure into a silent wait.
      if (t) { token = t; break; }
      note('TOKEN_FILE is empty; still waiting');
    } catch (e) { note('TOKEN_FILE read failed: ' + (e && e.message)); }
  }
  await sleep(15000);
}
if (!token) { note('GAVE_UP no token within ' + hours + 'h'); process.exit(3); }
note('TOKEN_SEEN (' + token.length + ' chars, not logged) - starting the release');

// Stream the child's output line by line. The release can legitimately spend minutes waiting on git,
// and buffering until the child exits would leave the log silent for exactly the stretch where someone
// is watching it.
function run(cmd, args, env) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '';
    let timedOut = false;
    const timer = setTimeout(function () { timedOut = true; note('RELEASE_TIMEOUT after ' + Math.round(RELEASE_TIMEOUT_MS / 1000) + 's - killing'); try { child.kill('SIGKILL'); } catch (e) {} }, RELEASE_TIMEOUT_MS);
    function feed(chunk, toStderr) {
      const text = chunk.toString();
      if (toStderr) stderr += text; else stdout += text;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) if (line.trim()) note('  ' + line.trim());
    }
    child.stdout.on('data', function (c) { feed(c, false); });
    child.stderr.on('data', function (c) { feed(c, true); });
    child.on('error', function (e) { note('RELEASE_SPAWN_ERROR ' + (e && e.message)); });
    child.on('close', function (code, signal) {
      clearTimeout(timer);
      if (pending.trim()) note('  ' + pending.trim());
      resolve({ code: timedOut ? 124 : (code === null ? 1 : code), stdout: stdout, stderr: stderr, signal: signal });
    });
  });
}
releaseStarted = true;
const r = await run(process.execPath, [RELEASE, '--repo', repoName], { GITHUB_TOKEN: token });
if (r.stderr && r.stderr.trim()) note('  STDERR ' + r.stderr.trim().slice(0, 800));
dropCred();
note('RELEASE_EXIT ' + r.code + (r.signal ? ' (signal ' + r.signal + ')' : ''));
if (r.code !== 0) { note('DONE_WITH_FAILURE exit=' + r.code); process.exit(r.code || 1); }
const live = (r.stdout.match(/LIVE_URL (\S+)/) || [])[1] || '';

// The site is up, so the second half of "published" is the metadata that until now could only say
// "once Pages is enabled": social images are relative and the docs still read as work in progress.
// Doing it here means authorising really is the only step the user has to take. A failure of this
// cosmetic step must not hide that the site itself is live, so it is reported and not fatal.
let polished;
if (process.env.SKIP_POLISH === '1') polished = 'SKIP_POLISH=1';
else if (!/^https?:\/\/\S+\/$/.test(live)) polished = 'no usable LIVE_URL, run publish-polish by hand';
else {
  const p = await run(process.execPath, [POLISH, '--url', live, '--push'], { GITHUB_TOKEN: token });
  if (p.code === 0) polished = 'metadata now points at ' + live;
  else polished = 'POLISH_FAILED exit=' + p.code + ' -- run tools/publish-polish.mjs --url ' + live + ' --push';
}
note('DONE_LIVE ' + (live || '(see log)') + ' :: ' + polished);
// The token is a live credential sitting in cleartext; once the release has succeeded there is no
// reason to keep it. (On failure it is kept on purpose so a retry does not need a fresh authorisation.)
try { unlinkSync(TOKEN_FILE); note('TOKEN_FILE removed'); } catch (e) { note('TOKEN_FILE kept: ' + (e && e.message)); }
process.exit(0);