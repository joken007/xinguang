#!/usr/bin/env node
// Wait for the GitHub device-flow token to appear, then publish automatically.
// Nothing here is required: it exists so that the moment the user authorises, the repo is created,
// pushed, Pages is switched on and the live URL is verified without anyone having to say go.
//
//   node tools/watch-and-release.mjs [--repo xinguang] [--hours 12]
import { readFileSync, existsSync, appendFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEGACY_DL = 'E:/shiguang-testbed/dl';
const DL = process.env.XINGUANG_DL || (existsSync(LEGACY_DL) ? LEGACY_DL : join(homedir(), '.xinguang-release'));
const TOKEN_FILE = join(DL, 'gh-token.txt');
const LOG = join(DL, 'watcher.log');
const RELEASE = join(HERE, 'gh-release.mjs');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const repoName = arg('repo', 'xinguang');
const rawHours = arg('hours', '12');
const hours = Number(rawHours);
// A typo must not be laundered into "I waited long enough": NaN would make the deadline NaN and the
// loop fall straight through to GAVE_UP, which reads like a successful timeout.
if (!Number.isFinite(hours) || hours <= 0) { console.error('BAD_ARG --hours expects a positive number, got ' + JSON.stringify(rawHours)); process.exit(2); }
// The release is bounded too: a half-dead GitHub must end in a loud failure, not a log that never moves.
const RELEASE_TIMEOUT_MS = Number(process.env.RELEASE_TIMEOUT_MS || 20 * 60 * 1000);
function note(m) { const line = '[' + new Date().toISOString() + '] ' + m; try { appendFileSync(LOG, line + '\n'); } catch (e) { console.error('LOG_WRITE_FAILED ' + (e && e.message) + ' :: ' + m); } console.log(line); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function run(cmd, args, env) {
  return new Promise(resolve => {
    execFile(cmd, args, {
      env: Object.assign({}, process.env, env),
      maxBuffer: 8 * 1024 * 1024,
      timeout: RELEASE_TIMEOUT_MS,
      killSignal: 'SIGKILL'
    }, (err, stdout, stderr) => {
      let code = err ? (err.code === undefined ? 1 : err.code) : 0;
      if (err && err.killed) { note('RELEASE_TIMEOUT after ' + Math.round(RELEASE_TIMEOUT_MS / 1000) + 's - killed'); code = 124; }
      resolve({ code, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
const r = await run(process.execPath, [RELEASE, '--repo', repoName], { GITHUB_TOKEN: token });
for (const line of (r.stdout || '').split(/\r?\n/)) if (line.trim()) note('  ' + line.trim());
if (r.stderr && r.stderr.trim()) note('  STDERR ' + r.stderr.trim().slice(0, 800));
note('RELEASE_EXIT ' + r.code);
if (r.code !== 0) { note('DONE_WITH_FAILURE exit=' + r.code); process.exit(r.code || 1); }
const live = (r.stdout.match(/LIVE_URL (\S+)/) || [])[1] || '(see log)';
note('DONE_LIVE ' + live);
// The token is a live credential sitting in cleartext; once the release has succeeded there is no
// reason to keep it. (On failure it is kept on purpose so a retry does not need a fresh authorisation.)
try { unlinkSync(TOKEN_FILE); note('TOKEN_FILE removed'); } catch (e) { note('TOKEN_FILE kept: ' + (e && e.message)); }
process.exit(0);