// Shared helpers: storage, auth principal, validation. Pure functions are unit-tested in test/.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TableClient } from '@azure/data-tables';

const clients = new Map();

/** Table client for `name`, creating the table on first use (Azurite or Azure Table Storage). */
export async function table(name) {
  let c = clients.get(name);
  if (!c) {
    const conn = process.env.STORAGE_CONNECTION;
    if (!conn) throw new Error('STORAGE_CONNECTION is not set');
    c = TableClient.fromConnectionString(conn, name, { allowInsecureConnection: conn.includes('UseDevelopmentStorage') || conn.includes('127.0.0.1') });
    await c.createTable().catch((e) => {
      if (e.statusCode !== 409) throw e;
    });
    clients.set(name, c);
  }
  return c;
}

let feed;
export function releaseFeed() {
  feed ??= JSON.parse(readFileSync(new URL('../../release-feed.json', import.meta.url), 'utf8'));
  return feed;
}

/** SWA passes the signed-in user as base64 JSON in x-ms-client-principal (set only by the SWA front end). */
export function principal(request) {
  const raw = request.headers.get('x-ms-client-principal');
  if (!raw) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return p && p.userId ? p : null;
  } catch {
    return null;
  }
}

/** Stable storage key for an account: a hash, so table rows never hold the raw provider id. */
export function accountKey(p) {
  return createHash('sha256').update(`${p.identityProvider}:${p.userId}`).digest('hex').slice(0, 40);
}

export function json(status, body, headers = {}) {
  return { status, jsonBody: body, headers: { 'Cache-Control': 'no-store', ...headers } };
}

// --- version comparison ----------------------------------------------------------------------------------------

export function cmpVersion(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

export function compat(feed, assetFormat, extractor) {
  const fmt = Number(assetFormat);
  if (!Number.isInteger(fmt)) return { ok: false, reason: 'No asset format given.', latestExtractor: feed.extractor.version };
  if (fmt < feed.minAssetFormat) {
    return { ok: false, reason: 'Your extracted game files are too old for this version of the site. Run the installer again to update them.', latestExtractor: feed.extractor.version };
  }
  if (fmt > feed.extractor.assetFormat) {
    return { ok: true, reason: 'Your game files are newer than this site expects; reload the page if something looks wrong.', latestExtractor: feed.extractor.version };
  }
  const outdated = extractor && cmpVersion(extractor, feed.extractor.version) < 0;
  return { ok: true, updateAvailable: !!outdated, latestExtractor: feed.extractor.version };
}

// --- saves -----------------------------------------------------------------------------------------------------

export const SAVE_LIMIT = 900_000; // characters; an Azure Table entity holds at most 1 MB
const CHUNK = 30_000; // a string property holds at most 64 KB (UTF-16)

export function validateSave(body) {
  if (!body || typeof body !== 'object' || typeof body.slots !== 'object' || body.slots === null || Array.isArray(body.slots)) return 'Expected {slots: {...}}.';
  for (const [k, v] of Object.entries(body.slots)) {
    if (!/^ff7ec\.[A-Za-z0-9.]{1,40}$/.test(k)) return `Unexpected slot key ${k}.`;
    if (typeof v !== 'string') return `Slot ${k} must be a string.`;
  }
  const size = JSON.stringify(body.slots).length;
  if (size > SAVE_LIMIT) return `Save data too large (${size} characters, limit ${SAVE_LIMIT}).`;
  return null;
}

export function toEntity(key, body, app) {
  const text = JSON.stringify(body.slots);
  const e = { partitionKey: 'save', rowKey: key, updated: new Date().toISOString(), app: String(app ?? '').slice(0, 32), chunks: 0 };
  for (let i = 0; i * CHUNK < text.length; i++) {
    e[`d${i}`] = text.slice(i * CHUNK, (i + 1) * CHUNK);
    e.chunks = i + 1;
  }
  return e;
}

export function fromEntity(e) {
  let text = '';
  for (let i = 0; i < e.chunks; i++) text += e[`d${i}`] ?? '';
  return { updated: e.updated, app: e.app, slots: text ? JSON.parse(text) : {} };
}

// --- telemetry -------------------------------------------------------------------------------------------------

const TYPES = new Set(['session', 'session-end', 'map', 'story', 'battle', 'menu', 'error']);
const DATA_KEYS = { map: ['map'], story: ['step'], battle: ['battle', 'result', 'seconds'], menu: ['tab'], 'session-end': ['seconds'], error: ['message', 'stack'], session: [] };
const BROWSERS = new Set(['chrome', 'edge', 'firefox', 'safari', 'other']);
const MODES = new Set(['dev', 'folder', 'local', 'remote']);

function str(v, max, re) {
  if (typeof v !== 'string') return null;
  const s = v.slice(0, max);
  return re && !re.test(s) ? null : s;
}

/**
 * Whitelist the documented fields (README "Privacy") and drop everything else. Returns the rows to store or an
 * error string. No IP address, account or header value is ever copied into a row.
 */
export function sanitizeTelemetry(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.events)) return 'Expected {events: [...]}.';
  const install = str(body.install, 36, /^[0-9a-f-]{36}$/);
  if (!install) return 'Missing install id.';
  const base = {
    install,
    app: str(body.app, 20, /^[0-9A-Za-z.+-]+$/) ?? 'unknown',
    mode: MODES.has(body.mode) ? body.mode : 'other',
    browser: BROWSERS.has(body.browser) ? body.browser : 'other',
    screen: str(String(body.screen ?? ''), 5, /^\d{1,5}$/) ?? '',
    assetFormat: Number.isInteger(body.assetFormat) ? body.assetFormat : -1,
  };
  const rows = [];
  for (const ev of body.events.slice(0, 100)) {
    if (!ev || !TYPES.has(ev.type)) continue;
    const data = {};
    for (const k of DATA_KEYS[ev.type]) {
      const v = ev.data?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) data[k] = v;
      else if (typeof v === 'string') data[k] = v.slice(0, k === 'stack' ? 1500 : 300);
    }
    const t = Number.isFinite(ev.t) ? new Date(ev.t) : new Date();
    const day = (Number.isNaN(t.getTime()) ? new Date() : t).toISOString().slice(0, 10);
    rows.push({ partitionKey: day, rowKey: `${Date.now()}-${randomUUID()}`, ...base, type: ev.type, data: JSON.stringify(data) });
  }
  return rows;
}
