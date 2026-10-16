/**
 * Where game assets come from. Every asset URL the app uses ("/arc/…", "/lib/…", "/gen/…") goes through
 * `assetUrl`, so one build runs in all modes:
 *
 *   dev     Vite serves /arc /lib /gen from the archive (vite.config.ts mounts)            base ""
 *   folder  hosted site; the asset service worker (public/asset-sw.js) answers the same
 *           paths from the folder the player granted (File System Access API)              base ""
 *   local   `ffcx serve` serves the app and the asset folder on localhost                  base ""
 *   remote  hosted site reading a local `ffcx serve` cross-origin (?assets=http://127.0.0.1:17777)  base = that origin
 */
export type AssetMode = 'dev' | 'folder' | 'local' | 'remote';

/** Must match ffcx ASSET_FORMAT (extractor/ffcx/__init__.py) of the extracted folder. */
export const ASSET_FORMAT = 1;
export const APP_VERSION: string = __APP_VERSION__;
/** Short git commit of the build (or "dev"), injected by vite.config.ts. */
export const BUILD_HASH: string = __BUILD_HASH__;
/** The public GitHub repository ("owner/name") for bug reports. Set VITE_GITHUB_REPO at build time to override. */
export const GITHUB_REPO: string = (import.meta.env.VITE_GITHUB_REPO as string | undefined) || 'dudhasch/forever-crisis';

let base = '';
let mode: AssetMode = import.meta.env.DEV ? 'dev' : 'folder';

export function setAssetSource(m: AssetMode, b = '') {
  mode = m;
  base = b.replace(/\/+$/, '');
}

export function assetMode(): AssetMode {
  return mode;
}

/** The URL to load for an app asset path. Non-asset URLs (blob:, data:, http…) pass through. */
export function assetUrl(url: string): string {
  if (!base || !url.startsWith('/')) return url;
  return base + url;
}
