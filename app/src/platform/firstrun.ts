/**
 * Boot gate: make sure the game assets are reachable before the explorer starts, and explain plainly what to do
 * when they are not (no folder chosen yet, permission needed again, unsupported browser, outdated files).
 */
import './firstrun.css';
import { forgetFolder, folderSupported, looksLikeAssetFolder, permission, pickFolder, startServiceWorker, storedFolder } from './folder';
import { APP_VERSION, ASSET_FORMAT, GITHUB_REPO, assetUrl, setAssetSource } from './source';

export interface AssetManifest {
  format: number;
  assetFormat: number;
  extractor: string;
  catalogRevision: number;
  created: string;
  stats?: { files: number; bytes: number; missing: number; textMissing?: number };
}

let manifest: AssetManifest | null = null;
export const assetManifest = () => manifest;

const README = `https://github.com/${GITHUB_REPO}#readme`;
const DEFAULT_FOLDER = 'C:\\Games\\FF7-Forever-Crisis';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Show a card; resolves with the id of the button the player clicked. */
function screen(o: { title: string; lines: (string | HTMLElement)[]; buttons: { id: string; label: string; primary?: boolean }[]; note?: string }) {
  document.querySelector('.ffcx-gate')?.remove();
  const wrap = el('div', 'ffcx-gate');
  const card = el('div', 'ffcx-card');
  card.append(el('h1', '', 'Forever Crisis'), el('div', 'ffcx-kicker', 'unofficial fan project'), el('h2', '', o.title));
  for (const l of o.lines) card.append(typeof l === 'string' ? el('p', '', l) : l);
  const row = el('div', 'ffcx-buttons');
  card.append(row);
  if (o.note) card.append(el('p', 'ffcx-note', o.note));
  wrap.append(card);
  document.body.append(wrap);
  return new Promise<string>((resolve) => {
    for (const b of o.buttons) {
      const btn = el('button', b.primary ? 'primary' : '', b.label);
      btn.onclick = () => resolve(b.id);
      row.append(btn);
    }
    (row.querySelector('button.primary') as HTMLButtonElement | null)?.focus();
  });
}

function closeScreen() {
  document.querySelector('.ffcx-gate')?.remove();
}

async function readManifest(): Promise<AssetManifest | { error: string }> {
  try {
    const r = await fetch(assetUrl('/ffcx-manifest.json'), { cache: 'no-store' });
    if (r.ok) return (await r.json()) as AssetManifest;
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return { error: body.error ?? `http-${r.status}` };
  } catch {
    return { error: 'unreachable' };
  }
}

type Screen = Parameters<typeof screen>[0];
const SCREENS = {
  welcome: (): Screen => ({
    title: 'Welcome',
    lines: [
      'Forever Crisis runs on the game files you extracted from your own copy of FINAL FANTASY VII EVER CRISIS. Nothing from the game is downloaded from this site.',
      `Click “Choose folder” and pick the folder the installer created — usually ${DEFAULT_FOLDER}.`,
      'Your browser will ask whether this site may view the files. They stay on your PC.',
    ],
    buttons: [{ id: 'pick', label: 'Choose folder', primary: true }, { id: 'help', label: 'I haven’t installed it yet' }],
    note: 'Works in Chrome and Edge. Remembered for next time.',
  }),
  wrong: (name: string): Screen => ({
    title: 'That isn’t the game folder',
    lines: [`“${name}” doesn’t contain the extracted files. Pick the folder the installer created (it has a file named ffcx-manifest.json), usually ${DEFAULT_FOLDER}.`],
    buttons: [{ id: 'ok', label: 'Choose again', primary: true }],
  }),
  back: (name: string): Screen => ({
    title: 'Welcome back',
    lines: [`Your browser needs your OK to read the game folder “${name}” again.`],
    buttons: [{ id: 'go', label: 'Continue', primary: true }],
    note: 'Tip: choose “Allow on every visit” to skip this next time.',
  }),
  missing: (name: string, error: string): Screen => ({
    title: 'Game files not found',
    lines: [`The folder “${name}” can’t be read right now (${error}). It may have been moved or deleted.`],
    buttons: [{ id: 'pick', label: 'Choose folder', primary: true }, { id: 'retry', label: 'Try again' }],
  }),
  outdated: (extractor: string): Screen => ({
    title: 'Your game files need an update',
    lines: [
      `This version of Forever Crisis (${APP_VERSION}) expects newer extracted files than the ones in your folder (extracted with version ${extractor}).`,
      'Run the installer again: it finds your game, updates only what changed and keeps your saves.',
    ],
    buttons: [{ id: 'go', label: 'Continue anyway' }, { id: 'help', label: 'How to update', primary: true }],
  }),
};

async function checkFormat(m: AssetManifest): Promise<boolean> {
  manifest = m;
  if (m.assetFormat >= ASSET_FORMAT) return true;
  const c = await screen(SCREENS.outdated(m.extractor));
  if (c === 'help') window.open(README, '_blank');
  return true;
}

function unsupported(): Promise<never> {
  const steps = el('ol', 'ffcx-steps');
  for (const s of [
    'Open the “FF7 Forever Crisis” shortcut the installer put on your desktop or in the Start menu.',
    'It starts Forever Crisis on your own PC (local mode) and works in any modern browser.',
  ]) steps.append(el('li', '', s));
  void screen({
    title: 'This browser can’t open your game folder',
    lines: ['The online version reads the files you extracted from your own copy of the game straight from your PC. That needs Google Chrome or Microsoft Edge on a computer.', 'You can still play in local mode:', steps],
    buttons: [{ id: 'help', label: 'Read the guide', primary: true }],
  }).then(() => window.open(README, '_blank'));
  return new Promise<never>(() => undefined);
}

/** Resolves once assets load; never resolves while the player still has to act. */
export async function ensureAssets(): Promise<void> {
  // ?ffcx-preview=welcome|back|wrong|missing|outdated|unsupported shows a screen as-is (docs, screenshots)
  const preview = new URLSearchParams(location.search).get('ffcx-preview');
  if (preview === 'unsupported') return unsupported();
  if (preview && preview in SCREENS) {
    const make = SCREENS[preview as keyof typeof SCREENS] as (a: string, b: string) => Screen;
    void screen(make('FF7-Forever-Crisis', 'NotFoundError'));
    return new Promise<never>(() => undefined);
  }
  if (import.meta.env.DEV) return; // Vite serves the archive mounts

  // local mode: `ffcx serve` serves this page and the assets from the install folder
  const local = await fetch('/ffcx-local.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (local?.mode === 'local') {
    setAssetSource('local');
    const m = await readManifest();
    if ('error' in m) throw new Error('The local server is running but the extracted files are missing. Run the installer again.');
    await checkFormat(m);
    return;
  }

  // hosted page reading a local server (for browsers without folder access): ?assets=http://127.0.0.1:17777
  const q = new URLSearchParams(location.search).get('assets');
  if (q) localStorage.setItem('ffcx.assetBase', q);
  const remote = localStorage.getItem('ffcx.assetBase');
  if (remote) {
    setAssetSource('remote', remote);
    const m = await readManifest();
    if (!('error' in m)) return void (await checkFormat(m));
    const c = await screen({
      title: 'Local game server not reachable',
      lines: [`Forever Crisis is set to read your files from ${remote}, but nothing answered. Start “FF7 Forever Crisis” from your desktop first.`],
      buttons: [{ id: 'retry', label: 'Try again', primary: true }, { id: 'folder', label: 'Use a folder instead' }],
    });
    if (c === 'retry') location.reload();
    localStorage.removeItem('ffcx.assetBase');
    setAssetSource('folder');
  }

  if (!folderSupported()) return unsupported();
  try {
    await startServiceWorker();
  } catch (e) {
    console.warn('asset service worker', e); // e.g. embedded browsers without service workers
    return unsupported();
  }

  for (;;) {
    const h = await storedFolder();
    if (!h) {
      const c = await screen(SCREENS.welcome());
      if (c === 'help') {
        window.open(README, '_blank');
        continue;
      }
      const picked = await pickFolder();
      if (!picked) continue;
      if (!(await looksLikeAssetFolder(picked))) {
        await forgetFolder();
        await screen(SCREENS.wrong(picked.name));
        continue;
      }
      continue;
    }
    let state = await permission(h, false);
    if (state !== 'granted') {
      await screen(SCREENS.back(h.name));
      state = await permission(h, true).catch(() => 'denied' as PermissionState);
      if (state !== 'granted') continue;
    }
    const m = await readManifest();
    if ('error' in m) {
      const c = await screen(SCREENS.missing(h.name, m.error));
      if (c === 'pick') await forgetFolder();
      continue;
    }
    closeScreen();
    await checkFormat(m);
    closeScreen();
    return;
  }
}
