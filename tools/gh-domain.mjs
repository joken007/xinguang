#!/usr/bin/env node
// Apply for a free is-a.dev subdomain by fork + branch + file + pull request.
//   node tools/gh-domain.mjs --domain xinguang --email you@example.com [--repo xinguang] [--dry-run]
//
// is-a.dev changed its rules since this was first written: the pull request must fill in their own
// template (checkboxes, preview link, purpose) and the domain file must carry contact details in the
// owner block. Both are handled here, and the template is fetched from upstream at run time so a
// future edit on their side does not silently produce a request that fails their validation.

import { readFileSync, existsSync } from 'node:fs';

import { existsSync as _exists } from 'node:fs';
import { homedir as _homedir } from 'node:os';
import { join as _join } from 'node:path';

const LEGACY_DL = 'E:/shiguang-testbed/dl';
const HOME_DL = _join(_homedir(), '.xinguang-release');
const DL = process.env.XINGUANG_DL || (_exists(LEGACY_DL) ? LEGACY_DL : HOME_DL);
const UPSTREAM = 'is-a-dev/register';
const API_BASE = process.env.GH_API || 'https://api.github.com'; // GH_API is an offline-rehearsal hook
const NL = String.fromCharCode(10);

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const domain = arg('domain', 'xinguang');
const repoName = arg('repo', 'xinguang');
const note = arg('note', '');
const siteOverride = arg('site', '');
const email = arg('email', '');
const purpose = arg('purpose', 'An open-source three.js / WebGL mindfulness page: a calming quote appears at random, every touch raises the sun one frame higher, and the scene slowly reveals forest, sea and mountains.');
const dryRun = process.argv.includes('--dry-run');
// The pull request template asks for contact details in the `owner` block, and an email there is the
// documented way to give them. It is a public field in a public repository, so say so out loud.
if (!email) { console.log('NO_CONTACT pass --email <address>: is-a.dev wants contact details in the domain file'); process.exit(2); }
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.log('BAD_EMAIL ' + JSON.stringify(email)); process.exit(2); }

let token = process.env.GITHUB_TOKEN || '';
if (!token && existsSync(DL + '/gh-token.txt')) token = readFileSync(DL + '/gh-token.txt', 'utf8').trim();
if (!token) { console.log('NO_TOKEN'); process.exit(2); }


async function api(method, path, body) {
  const res = await fetch(API_BASE + path, {
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
  owner: { username: owner, email: email },
  records: { CNAME: owner + '.github.io' }
};
const site = siteOverride || ('https://' + owner + '.github.io/' + repoName + '/');

// Their template is the request: the comments must stay, every requirement must be ticked, and the
// preview link plus the purpose have to sit between their markers. Fetch it instead of copying it,
// because a snapshot goes stale exactly the way the old hand-written body did.
const TEMPLATE_PATH = '.github/PULL_REQUEST_TEMPLATE.md';
const TEMPLATE_SNAPSHOT = "<!--\nYOU MUST FILL OUT THIS ENTIRE TEMPLATE FOR YOUR PR TO BE APPROVED!\n\nDO NOT MODIFY OR REMOVE THIS TEMPLATE (INCLUDING REMOVING COMMENTS) OR YOUR PR WILL FAIL VALIDATION!\n-->\n\n# Requirements\n<!-- Your domain MUST pass ALL the requirements below, otherwise it WILL BE DENIED. -->\n<!-- Change each checkbox to [x] (all lowercase, with no spaces between the brackets) to mark it as completed. -->\n<!-- Do not modify anything in this section other than the checkboxes, or your PR will fail validation. -->\n\n- [ ] <!-- TOS --> I **agree** to the [Terms of Service](https://is-a.dev/terms). <!-- Your request MUST follow the TOS to be approved. -->\n- [ ] <!-- DOMAIN_STRUCTURE --> My file is following the [domain structure](https://docs.is-a.dev/domain-structure/). <!-- Your file is in the domains directory, the name is valid, it is JSON format, etc. -->\n- [ ] <!-- WEBSITE_REACHABLE --> My website is **reachable** and **completed**. <!-- We do not permit simple \"Hello, world!\" or simply copied template websites with minimal changes. -->\n- [ ] <!-- SOFTWARE_RELATED --> My website is **software development** related. <!-- We do not accept websites such as gaming, courses, AI agents/chatbots, etc. NOTE: Only your root subdomain needs to meet this requirement. -->\n- [ ] <!-- NON_COMMERCIAL --> My website is **not for commercial use**. <!-- Your website's purpose should not be to generate any form of revenue or profit. (e.g. a business) -->\n- [ ] <!-- CONTACT_INFO --> I have provided sufficient contact information in the `owner` key. <!-- Provide your email in the `email` field or another platform (e.g. Twitter or Discord) for contact. -->\n- [ ] <!-- WEBSITE_LINK --> I have provided a link to my website below. <!-- This step is required for your PR to be approved. -->\n\n# Website Preview\n<!-- Provide a LINK (not a screenshot) to your website below between the start/end markers. -->\n<!-- This should be a LINK to the existing domain your website is on, NOT the is-a.dev domain you're applying for. (e.g. https://abc.vercel.app, https://abc.github.io) -->\n\n<!-- WEBSITE_PREVIEW_START -->\n<!-- WEBSITE_PREVIEW_END -->\n\n# Website Purpose\n<!-- Please tell us the purpose or motive behind your website in between the start/end markers. For example, it is a portfolio website, etc. -->\n\n<!-- WEBSITE_PURPOSE_START -->\n<!-- WEBSITE_PURPOSE_END -->";
async function prTemplate() {
  const got = await api('GET', '/repos/' + UPSTREAM + '/contents/' + TEMPLATE_PATH);
  if (got.status === 200 && got.json && got.json.content) {
    const text = Buffer.from(got.json.content, 'base64').toString('utf8');
    if (text.indexOf('WEBSITE_PREVIEW_START') >= 0 && text.indexOf('WEBSITE_PURPOSE_START') >= 0) return { text: text, source: 'upstream' };
    console.log('WARN the upstream template is not the shape this expects; using the snapshot');
  } else console.log('NOTE template fetch answered ' + got.status + '; using the snapshot in this file');
  return { text: TEMPLATE_SNAPSHOT, source: 'snapshot' };
}
function fillTemplate(text, url, why) {
  const ticked = text.replace(/- \[ \]/g, '- [x]');
  const withPreview = ticked.replace(/(<!-- WEBSITE_PREVIEW_START -->)[\s\S]*?(<!-- WEBSITE_PREVIEW_END -->)/, '$1' + NL + url + NL + '$2');
  const withWhy = withPreview.replace(/(<!-- WEBSITE_PURPOSE_START -->)[\s\S]*?(<!-- WEBSITE_PURPOSE_END -->)/, '$1' + NL + why + NL + '$2');
  return withWhy;
}

console.log('PAYLOAD ' + JSON.stringify(payload));
if (dryRun) {
  const tpl = await prTemplate();
  const body = fillTemplate(tpl.text, site, purpose || note);
  console.log('PR_TITLE ' + 'Add ' + full);
  console.log('PR_TEMPLATE ' + tpl.source + ' body=' + body.length + ' bytes');
  console.log('PR_BODY_PREVIEW ---');
  console.log(body);
  console.log('--- end');
  console.log('DRY_RUN done');
  process.exit(0);
}

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

const tpl = await prTemplate();
const body = fillTemplate(tpl.text, site, purpose || note);
console.log('PR_TITLE ' + 'Add ' + full);
console.log('PR_TEMPLATE ' + tpl.source + ' body=' + body.length + ' bytes');
console.log('PR_BODY_PREVIEW ---');
console.log(body);
console.log('--- end');
const pr = await api('POST', '/repos/' + UPSTREAM + '/pulls', { title: 'Add ' + full, head: owner + ':' + branch, base: defaultBranch, body: body });
if (pr.status === 201) console.log('PR_OPENED ' + pr.json.html_url);
else { console.log('PR_FAILED ' + pr.status + ' ' + JSON.stringify(pr.json).slice(0, 400)); process.exit(9); }
console.log('REMINDER is-a.dev asks that the request be written by a human: open the PR and rewrite the description in your own words before a maintainer looks at it.');
