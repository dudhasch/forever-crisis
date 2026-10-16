/**
 * Online features of the hosted site (Azure Static Web App + managed functions in /api). All optional: when
 * /api is not there (dev server, local mode, offline) everything here quietly reports "unavailable".
 *
 *   cloud saves   SWA built-in sign-in (GitHub / Microsoft); the save slots the in-game menu keeps in
 *                 localStorage are uploaded / restored as one document per account
 *   update feed   /api/version: latest app and extractor versions, asset format the site expects
 *   telemetry     strictly opt-in, see telemetry.ts
 */
import { APP_VERSION, ASSET_FORMAT } from './source';

/** What the game keeps in localStorage: autosave, the menu's three slots, story flags and battle settings. */
export const SAVE_KEYS = ['ff7ec.game', 'ff7ec.save.1', 'ff7ec.save.2', 'ff7ec.save.3', 'ff7ec.storyFlags', 'ff7ec.battleSettings', 'ff7ec.battleItems', 'ff7ec.storyMode'];

export interface VersionFeed {
  app: { version: string; notes?: string; url?: string };
  extractor: { version: string; assetFormat: number; url?: string };
  minAssetFormat: number;
}

export interface Principal {
  userId: string;
  userDetails: string;
  identityProvider: string;
}

async function getJSON<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: 'no-store', ...init });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

let available: Promise<boolean> | null = null;
/** Is the site's API there at all? */
export function apiAvailable(): Promise<boolean> {
  available ??= getJSON<VersionFeed>('/api/version').then((v) => !!v?.app);
  return available;
}

export function versionFeed() {
  return getJSON<VersionFeed>('/api/version');
}

/** Asset compatibility as the server sees it (the deployed app's expectations vs the local manifest). */
export function compatCheck(assetFormat: number, extractor: string) {
  return getJSON<{ ok: boolean; reason?: string; latestExtractor: string }>(
    `/api/compat?assetFormat=${assetFormat}&extractor=${encodeURIComponent(extractor)}&app=${encodeURIComponent(APP_VERSION)}`,
  );
}

export async function whoAmI(): Promise<Principal | null> {
  const me = await getJSON<{ clientPrincipal: Principal | null }>('/.auth/me');
  return me?.clientPrincipal ?? null;
}

export function signIn(provider: 'github' | 'aad') {
  location.href = `/.auth/login/${provider}?post_login_redirect_uri=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
}

export function signOut() {
  location.href = `/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(location.pathname)}`;
}

export interface CloudSave {
  updated: string;
  app: string;
  slots: Record<string, string>;
}

function localSlots(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SAVE_KEYS) {
    const v = localStorage.getItem(k);
    if (v != null) out[k] = v;
  }
  return out;
}

export async function uploadSaves(): Promise<CloudSave | null> {
  const body: CloudSave = { updated: new Date().toISOString(), app: APP_VERSION, slots: localSlots() };
  const r = await getJSON<CloudSave>('/api/saves', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r) localStorage.setItem('ffcx.cloud.lastSync', body.updated);
  return r;
}

export function cloudSaves() {
  return getJSON<CloudSave>('/api/saves');
}

/** Replace the local slots with the cloud copy (the caller reloads the page so the game picks them up). */
export async function restoreSaves(): Promise<boolean> {
  const c = await cloudSaves();
  if (!c) return false;
  for (const k of SAVE_KEYS) {
    if (k in c.slots) localStorage.setItem(k, c.slots[k]);
  }
  localStorage.setItem('ffcx.cloud.lastSync', c.updated);
  return true;
}

let autoTimer = 0;
let lastHash = '';
/** Optional: back up automatically whenever a slot changed (checked once a minute while signed in). */
export function startAutoBackup() {
  if (autoTimer || localStorage.getItem('ffcx.cloud.auto') !== '1') return;
  lastHash = JSON.stringify(localSlots());
  autoTimer = window.setInterval(async () => {
    const now = JSON.stringify(localSlots());
    if (now !== lastHash && (await whoAmI())) {
      if (await uploadSaves()) lastHash = now;
    }
  }, 60_000);
}

export function stopAutoBackup() {
  clearInterval(autoTimer);
  autoTimer = 0;
}

export { ASSET_FORMAT };
