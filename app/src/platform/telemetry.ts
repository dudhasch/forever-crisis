/**
 * Opt-in play statistics and error reports. OFF unless the player turns it on in Config → Online & privacy.
 *
 * What is sent (and nothing else) — documented in the README "Privacy" section:
 *   install   a random id made when you opt in (crypto.randomUUID), deleted when you opt out; not tied to any account
 *   app       explorer version, asset mode (folder / local), asset format
 *   env       browser family (Chrome/Edge/Firefox/Safari/other), screen size bucket (e.g. 1920x1080 -> "1920")
 *   events    session start/end (seconds played), map entered (map key), story step started/finished (step index),
 *             battle finished (battle id, result, seconds), menu opened (tab)
 *   errors    error message and stack (file paths reduced to file names), at most 20 per session
 * No IP address is stored by the API, no account id, no save data, no free text.
 */
import { APP_VERSION, ASSET_FORMAT, assetMode } from './source';

const OPT_KEY = 'ffcx.telemetry';
const ID_KEY = 'ffcx.installId';

export interface TelemetryEvent {
  t: number;
  type: 'session' | 'session-end' | 'map' | 'story' | 'battle' | 'menu' | 'error';
  data?: Record<string, string | number | boolean | null>;
}

let queue: TelemetryEvent[] = [];
let errors = 0;
let started = 0;
let timer = 0;

export function telemetryEnabled() {
  return localStorage.getItem(OPT_KEY) === '1';
}

export function setTelemetry(on: boolean) {
  if (on) {
    localStorage.setItem(OPT_KEY, '1');
    if (!localStorage.getItem(ID_KEY)) localStorage.setItem(ID_KEY, crypto.randomUUID());
    startTelemetry();
  } else {
    localStorage.removeItem(OPT_KEY);
    localStorage.removeItem(ID_KEY);
    queue = [];
    clearInterval(timer);
    timer = 0;
  }
}

function browser() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'edge';
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

export function track(type: TelemetryEvent['type'], data?: TelemetryEvent['data']) {
  if (!telemetryEnabled()) return;
  if (type === 'error' && ++errors > 20) return;
  queue.push({ t: Date.now(), type, data });
  if (queue.length >= 50) void flush();
}

function stripPaths(s: string) {
  return s.replace(/(?:https?:\/\/[^\s)]+\/|[A-Za-z]:\\[^\s)]+\\)([^/\\\s)]+)/g, '$1').slice(0, 2000);
}

export async function flush(beacon = false) {
  if (!queue.length || !telemetryEnabled()) return;
  const body = JSON.stringify({
    install: localStorage.getItem(ID_KEY),
    app: APP_VERSION,
    mode: assetMode(),
    assetFormat: ASSET_FORMAT,
    browser: browser(),
    screen: String(Math.round(screen.width / 160) * 160),
    events: queue.splice(0),
  });
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon('/api/telemetry', new Blob([body], { type: 'application/json' }));
    return;
  }
  await fetch('/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => undefined);
}

export function startTelemetry() {
  if (!telemetryEnabled() || timer) return;
  started = Date.now();
  track('session');
  timer = window.setInterval(() => void flush(), 30_000);
  addEventListener('pagehide', () => {
    track('session-end', { seconds: Math.round((Date.now() - started) / 1000) });
    void flush(true);
  });
}

addEventListener('error', (e) => track('error', { message: stripPaths(String(e.message)), stack: stripPaths(String(e.error?.stack ?? '')) }));
addEventListener('unhandledrejection', (e) => {
  const r = e.reason as Error | undefined;
  track('error', { message: stripPaths(String(r?.message ?? r)), stack: stripPaths(String(r?.stack ?? '')) });
});

type Fn = (...a: unknown[]) => unknown;
/** Observe a few App methods without touching the game code: maps, story steps, battles. */
export function instrument(app: object) {
  const a = app as Record<string, Fn>;
  const wrap = (name: string, before?: (args: unknown[]) => void, after?: (res: unknown, args: unknown[], ms: number) => void) => {
    const orig = a[name];
    if (typeof orig !== 'function') return;
    a[name] = function (this: unknown, ...args: unknown[]) {
      const t0 = performance.now();
      before?.(args);
      const res = orig.apply(this, args);
      if (after) Promise.resolve(res).then((r) => after(r, args, performance.now() - t0), () => undefined);
      return res;
    };
  };
  wrap('loadMap', (args) => track('map', { map: String(args[0]) }));
  wrap('playStep', (args) => track('story', { step: Number(args[0]) }));
  wrap('runBattle', undefined, (res, args, ms) => {
    const req = args[0] as { battleId?: number } | undefined;
    track('battle', { battle: Number(req?.battleId ?? -1), result: String(res), seconds: Math.round(ms / 1000) });
  });
}
