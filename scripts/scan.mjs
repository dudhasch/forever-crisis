// Publish gate: scan a tree for secrets, personal data and game content.
//   node scripts/scan.mjs [dir]        (default: the files git tracks in this repo)
//   FFC_SCAN_NAMES="name1,name2"       extra words to treat as personal (your user name, handle, local folder names…);
//                                      never commit them
// Exits 1 and lists every finding when something is found.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.venv', '.azurite', 'build', 'release-out', '__pycache__']);

function files() {
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '-z'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\0')
      .filter(Boolean);
  } catch {
    const out = [];
    (function walk(d) {
      for (const n of readdirSync(d)) {
        if (SKIP_DIRS.has(n)) continue;
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(relative(root, p).replaceAll('\\', '/'));
      }
    })(root);
    return out;
  }
}

// ---- rules
const SECRETS = [
  [/AccountKey=[A-Za-z0-9+/=]{20,}/, 'storage account key'],
  [/SharedAccessSignature=|[?&]sig=[A-Za-z0-9%+/=]{20,}/, 'SAS token'],
  [/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/, 'private key'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]{40,}/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{32,}/, 'API key'],
  [/AZURE_STATIC_WEB_APPS_API_TOKEN\s*[:=]\s*['"]?[0-9a-f]{40,}/i, 'SWA deployment token'],
  [/"(AzureWebJobsStorage|STORAGE_CONNECTION)"\s*:\s*"(?!UseDevelopmentStorage=true|<|")[^"]+"/, 'connection string value'],
];
const names = (process.env.FFC_SCAN_NAMES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PII = [
  [/\b[A-Za-z]:[\\/]+Users[\\/]+(?!<|\$|%|Public\b|runneradmin\b)[A-Za-z0-9._-]+/i, 'Windows user folder path'],
  [/\/(home|Users)\/(?!runner\b|<|\$)[a-z0-9._-]+\//, 'home folder path'],
  [/[\w.+-]+@(?!(example\.(com|org)|users\.noreply\.github\.com)\b)[\w-]+\.[a-z]{2,}\b/i, 'email address'],
  ...names.map((n) => [new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), 'personal name']),
];
// game content: binary formats the game ships, generated data folders, big data files
const GAME_EXT = new Set(['.glb', '.gltf', '.bin', '.fbx', '.ktx2', '.dds', '.tga', '.flac', '.ogg', '.wav', '.mp3', '.acb', '.awb', '.usm', '.mp4', '.mkv', '.webm', '.unity3d', '.assets', '.bundle', '.bytes', '.lua', '.a', '.ab', '.dat']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico']);
const GAME_PATH = [/(^|\/)generated\//, /(^|\/)gen\//, /MasterData/i, /(^|\/)(arc|lib)\/(unity|data)\//, /(^|\/)extractor\/data\//, /(^|\/)release-tools\/out\//, /(^|\/)public\/brand\//];
// images that are OK: own UI screenshots without game content, installer art and site icons drawn by the project
// reviewed: the installer art, the app icons and the UI kit (drawn from scratch in GIMP for this project)
const IMAGE_OK = [/^docs\/screenshots\/(installer|online-panel|first-run)/, /^installer\/art\//, /^app\/public\/icons\//, /^app\/public\/ui\//];
// fonts shipped with their licence next to them (Titillium Web, SIL OFL 1.1)
const FONT_OK = /^app\/public\/fonts\/TitilliumWeb-[\w-]+\.woff2$/;
// strings that only appear in extracted game data
const GAME_TEXT = [
  [/"(patk|matk|pdef|mdef)"\s*:\s*\d+/, 'enemy stat table'],
  [/dat_asset_dungeon_\d{5,}/, 'game bundle names'],
  [/\x01C\[\["[0-9a-f]{12}"/, 'dehydrated game text'],
];
// embedded encryption keys (a game's or anyone's): byte-array literals and hex/base64 strings the size of an AES
// key. Checked over the whole file, so arrays split across lines are found. Hashes (sha/md5/integrity lines) and
// low-entropy fillers ('0' * 32, AAAA…) are not keys.
const KEYS = [
  [/[[({]\s*((?:(?:0x[0-9a-f]{1,2}|\d{1,3})\s*,\s*){15,31}(?:0x[0-9a-f]{1,2}|\d{1,3}))\s*,?\s*[\])}]/gi, 'byte-array key literal', (m) => {
    const v = m[1].split(',').map((x) => Number(x.trim()));
    return [16, 24, 32].includes(v.length) && v.every((x) => x <= 255) && new Set(v).size >= 8;
  }],
  [/(?<![0-9a-z])(?:0x)?([0-9a-f]{32}|[0-9a-f]{48}|[0-9a-f]{64})(?![0-9a-z])/gi, 'hex key literal', (m) => new Set(m[1].toLowerCase()).size >= 8],
  [/['"`]([A-Za-z0-9+/]{22}==|[A-Za-z0-9+/]{43}=)['"`]/g, 'base64 key literal', (m) => new Set(m[1]).size >= 8],
];
const HASH_CONTEXT = /sha|md5|hash|digest|integrity|checksum|commit|\brev\b|uuid|guid/i;
const MAX_TEXT = 1_000_000;

const findings = [];
const add = (f, kind, what, line = 0) => findings.push({ f, kind, what, line });

for (const f of files()) {
  if (f === 'scripts/scan.mjs') continue; // its own rules would match
  const p = join(root, f);
  let st;
  try {
    st = statSync(p);
  } catch {
    continue;
  }
  const ext = extname(f).toLowerCase();
  if (GAME_EXT.has(ext)) add(f, 'game', `game asset format ${ext}`);
  if (IMAGE_EXT.has(ext) && !IMAGE_OK.some((r) => r.test(f))) add(f, 'game', 'image (check it shows no game content, then allow it in scan.mjs)');
  for (const r of GAME_PATH) if (r.test(f)) add(f, 'game', `game-derived data path (${r.source})`);
  if (ext === '.gz' || ext === '.zip' || ext === '.7z') add(f, 'game', 'archive (cannot be scanned)');
  if (IMAGE_EXT.has(ext) || GAME_EXT.has(ext) || ext === '.gz' || ext === '.zip' || FONT_OK.test(f)) continue;
  if (st.size > MAX_TEXT) {
    add(f, 'game', `large file ${(st.size / 1e6).toFixed(1)} MB`);
    continue;
  }
  const buf = readFileSync(p);
  if (buf.includes(0)) {
    add(f, 'game', 'binary file');
    continue;
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (!/(^|\/)package-lock\.json$/.test(f)) {
    for (const [r, what, ok] of KEYS) {
      for (const m of text.matchAll(r)) {
        const line = text.slice(0, m.index).split('\n').length;
        const l = lines[line - 1];
        if (l.includes('scan:allow') || HASH_CONTEXT.test(l) || !ok(m)) continue;
        add(f, 'secret', what, line);
      }
    }
  }
  const thirdParty = /(^|\/)(LICENSES?|NOTICE|package-lock\.json)/i.test(f);
  lines.forEach((l, i) => {
    if (l.includes('scan:allow')) return; // a deliberate example (e.g. a test of the path stripper)
    for (const [r, what] of SECRETS) if (r.test(l)) add(f, 'secret', what, i + 1);
    for (const [r, what] of PII) if (r.test(l) && !(thirdParty && what === 'email address')) add(f, 'pii', what, i + 1);
    for (const [r, what] of GAME_TEXT) if (r.test(l)) add(f, 'game', what, i + 1);
  });
}

const by = (k) => findings.filter((x) => x.kind === k);
const total = files().length;
console.log(`scanned ${total} files in ${root}`);
for (const k of ['secret', 'pii', 'game']) {
  const xs = by(k);
  console.log(`${k.padEnd(6)} ${xs.length ? `${xs.length} finding(s)` : 'clean'}`);
  const seen = new Set();
  for (const x of xs) {
    const key = `${x.f}|${x.what}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const n = xs.filter((y) => y.f === x.f && y.what === x.what).length;
    console.log(`  ${x.f}${x.line ? `:${x.line}` : ''}  ${x.what}${n > 1 ? ` (${n} lines)` : ''}`);
  }
}
process.exit(findings.length ? 1 : 0);
