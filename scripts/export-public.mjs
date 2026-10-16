// Build the public repository: a fresh, history-free copy of this repo's committed HEAD without the data pack's
// files or maintainer paths, scanned, with one initial commit. Nothing is pushed.
//   node scripts/export-public.mjs <out-dir> [--repo owner/name] [--with-screenshots]
//        [--author-name <name>] [--author-email <noreply email>]     (or FFC_EXPORT_NAME / FFC_EXPORT_EMAIL)
// The commit is authored with the owner's GitHub noreply address by default, set as the export's repository-local
// identity, so a global git identity is never used.
// Then: cd <out-dir> && npm ci && npm run build && npm test
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const VALUED = ['--repo', '--author-name', '--author-email'];
const opt = (n, d = '') => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const out = resolve(args.find((a, i) => !a.startsWith('--') && !VALUED.includes(args[i - 1])) ?? 'public-out');
const repo = opt('--repo');
const src = resolve('.');
// dudhasch's GitHub noreply address (the number is the account id: `gh api users/dudhasch --jq .id`)
const AUTHOR_NAME = opt('--author-name', process.env.FFC_EXPORT_NAME || 'dudhasch');
const AUTHOR_EMAIL = opt('--author-email', process.env.FFC_EXPORT_EMAIL || '155721920+dudhasch@users.noreply.github.com');
if (!/@users\.noreply\.github\.com$/.test(AUTHOR_EMAIL))
  throw new Error(`refusing to author the public commit as ${AUTHOR_EMAIL}: use a GitHub noreply address`);

// Paths that never go public. extractor/data holds the data pack's files, recorded from the maintainer's local
// extraction. The data pack is a recipe of ids, offsets and hashes, with no text, models, textures or audio; it is hosted outside the repository and
// extractor/data.lock.json (kept) pins its SHA-256 (see docs/PUBLISHING.md).
const EXCLUDE = [
  /^extractor\/data\//,
  /^release-tools\/out\//,
  /^app\/SYNCED_FROM$/,
  /^scripts\/sync-app\.mjs$/, // maintainer-only: merges the explorer's private working tree into app/ (see the script)
  /^tests\/e2e\/.*\.(png|jpg)$/,
  ...(args.includes('--with-screenshots') ? [] : [/^docs\/screenshots\//]),
];

// Maintainer-specific paths -> neutral placeholders (text files only). The paths are not written here: they come
// from the git-ignored release-tools/paths.local.json (see release-tools/paths.py) and FFC_EXPORT_PATHS
// ("path=placeholder;..."), longest first. The scan below catches anything left over.
const PLACEHOLDER = { FFC_EXPLORER: '<explorer>', FFC_CLIENT: '<client>', FFC_ARCHIVE: '<archive>', FFC_MODS: '<converters>', FFC_LIBRARY: '<library>' };
function localPaths() {
  const list = [];
  const f = join(src, 'release-tools', 'paths.local.json');
  if (existsSync(f)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(f, 'utf8')))) if (PLACEHOLDER[k] && v) list.push([v, PLACEHOLDER[k]]);
  for (const kv of (process.env.FFC_EXPORT_PATHS ?? '').split(';').filter(Boolean)) list.push(kv.split('='));
  return list.sort((a, b) => b[0].length - a[0].length);
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const REWRITE = localPaths().map(([path, to]) => [new RegExp(path.split(/[\\/]+/).filter(Boolean).map(esc).join('(?:\\\\|/)+'), 'gi'), to]);
const TEXT = /\.(ts|js|mjs|cjs|json|md|yml|yaml|html|css|py|ps1|psm1|bicep|bicepparam|txt|toml|cfg|spec|svg|webmanifest)$|(^|\/)(\.gitignore|\.editorconfig|CODEOWNERS|LICENSE)$/i;

function sh(cmd, a, cwd = out, input) {
  return execFileSync(cmd, a, { cwd, input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'], maxBuffer: 1 << 30 }).toString();
}

// marks a folder this script made (inside .git, so it is never committed)
const MARK = join(out, '.git', 'ffc-public-export');
if (existsSync(out) && readdirSync(out).some((n) => n !== 'node_modules')) {
  if (!existsSync(MARK)) throw new Error(`${out} exists and was not made by this script`);
  for (const n of readdirSync(out)) if (n !== 'node_modules') rmSync(join(out, n), { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });

const files = sh('git', ['ls-files', '-z'], src).split('\0').filter(Boolean);
let kept = 0;
let rewritten = 0;
const dropped = [];
for (const f of files) {
  if (EXCLUDE.some((r) => r.test(f))) {
    dropped.push(f);
    continue;
  }
  let buf;
  try {
    buf = execFileSync('git', ['show', `HEAD:${f}`], { cwd: src, maxBuffer: 1 << 30 });
  } catch {
    continue; // deleted in the working tree but staged? skip
  }
  if (TEXT.test(f)) {
    let s = buf.toString('utf8');
    const before = s;
    for (const [r, to] of REWRITE) s = s.replace(r, to);
    if (f === 'app/package.json') s = publicAppPackage(s);
    if (f === 'package.json') s = publicRootPackage(s);
    if (repo) s = s.replaceAll('dudhasch/forever-crisis', repo).replace(/@dudhasch\b/g, `@${repo.split('/')[0]}`);
    if (s !== before) rewritten++;
    buf = Buffer.from(s, 'utf8');
  }
  const p = join(out, f);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, buf);
  kept++;
}
/** The explorer's maintainer-only scripts (extract:*, check:*) need the maintainer's local extraction. */
function publicAppPackage(s) {
  const j = JSON.parse(s);
  for (const k of Object.keys(j.scripts ?? {})) if (/^(extract|check):/.test(k)) delete j.scripts[k];
  return JSON.stringify(j, null, 2) + '\n';
}
function publicRootPackage(s) {
  const j = JSON.parse(s);
  delete j.scripts.sync;
  return JSON.stringify(j, null, 2) + '\n';
}

console.log(`exported ${kept} files to ${out} (${rewritten} rewritten, ${dropped.length} left out)`);
for (const d of dropped) console.log(`  left out: ${d}`);

// scan, then a fresh history with one commit
execFileSync(process.execPath, [join(src, 'scripts/scan.mjs'), out], { stdio: 'inherit' });
if (!existsSync(join(out, '.git'))) sh('git', ['init', '-q', '-b', 'main']);
writeFileSync(MARK, 'made by scripts/export-public.mjs\n');
sh('git', ['config', '--local', 'user.name', AUTHOR_NAME]);
sh('git', ['config', '--local', 'user.email', AUTHOR_EMAIL]);
sh('git', ['add', '-A']);
const status = sh('git', ['status', '--porcelain']);
if (status.trim()) sh('git', ['commit', '-q', '-F', '-'], out, 'FF7 Forever Crisis: initial public release\n');
console.log(`committed as ${AUTHOR_NAME} <${AUTHOR_EMAIL}>`);
execFileSync(process.execPath, [join(src, 'scripts/scan.mjs'), out], { stdio: 'inherit' });
console.log(`\n${out} is ready (fresh history, not pushed).`);
