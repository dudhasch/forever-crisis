// Folder (hosted) mode, end to end in Chromium without the native folder dialog:
//   the site (SWA emulator) registers the asset service worker; the test puts real extracted files into a
//   browser-provided directory handle (Origin Private File System), stores the handle exactly where
//   "Choose folder" stores it, and checks that the service worker serves JSON, GLB and FLAC (with Range).
//   Then it reloads and checks the first-run gate lets the explorer start.
//
//   node tests/e2e/folder-sw.mjs [site=http://localhost:4280] [assets=http://127.0.0.1:17777]
import { chromium } from 'playwright';

const SITE = process.argv[2] ?? 'http://localhost:4280';
const ASSETS = process.argv[3] ?? 'http://127.0.0.1:17777';
const FILES = ['/ffcx-manifest.json', '/gen/maps.json', '/gen/music.json', '/lib/unity/questcharacter/001/model/001/model.glb', '/arc/05-Music-FLAC/bgm_bc_001.flac'];

const browser = await chromium.launch();
const page = await browser.newPage();
const log = [];
page.on('console', (m) => log.push(`${m.type()}: ${m.text()}`));
await page.goto(SITE + '/');
await page.waitForSelector('.ffcx-gate h2', { timeout: 30000 });
const first = await page.textContent('.ffcx-gate h2');
console.log('first screen:', first);

const result = await page.evaluate(async ({ ASSETS, FILES }) => {
  const sha = async (buf) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('FF7-Forever-Crisis', { create: true });
  const expected = {};
  for (const u of FILES) {
    const buf = await (await fetch(ASSETS + u)).arrayBuffer();
    expected[u] = { size: buf.byteLength, sha: await sha(buf) };
    const parts = u.slice(1).split('/');
    let d = root;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(buf);
    await w.close();
  }
  // store the handle where platform/folder.ts pickFolder() stores it
  await new Promise((res, rej) => {
    const r = indexedDB.open('ffcx', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('handles');
    r.onsuccess = () => {
      const tx = r.result.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(root, 'root');
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    };
  });
  navigator.serviceWorker.controller?.postMessage({ type: 'ffcx-folder-changed' });
  const out = { controlled: !!navigator.serviceWorker.controller, files: {} };
  for (const u of FILES) {
    const r = await fetch(u);
    const buf = await r.arrayBuffer();
    out.files[u] = { status: r.status, type: r.headers.get('content-type'), same: (await sha(buf)) === expected[u].sha, size: buf.byteLength };
  }
  const flac = FILES.at(-1);
  const r = await fetch(flac, { headers: { Range: 'bytes=1000-1999' } });
  const part = new Uint8Array(await r.arrayBuffer());
  const whole = new Uint8Array(await (await fetch(ASSETS + flac)).arrayBuffer()).slice(1000, 2000);
  out.range = { status: r.status, contentRange: r.headers.get('content-range'), length: part.length, same: part.every((b, i) => b === whole[i]) };
  const missing = await fetch('/arc/does/not/exist.png');
  out.missing = missing.status;
  // an <audio> element seeking inside the FLAC through the service worker
  out.audio = await new Promise((res) => {
    const a = new Audio(flac);
    a.muted = true;
    a.onloadedmetadata = () => {
      a.currentTime = Math.min(30, a.duration / 2);
      a.onseeked = () => res({ duration: Math.round(a.duration), seekedTo: Math.round(a.currentTime) });
    };
    a.onerror = () => res({ error: a.error?.message ?? 'error' });
    setTimeout(() => res({ timeout: true }), 15000);
  });
  return out;
}, { ASSETS, FILES });
console.log(JSON.stringify(result, null, 1));

await page.reload();
await page.waitForTimeout(4000);
const gate = await page.$('.ffcx-gate');
console.log('after reload, first-run screen shown:', gate ? await gate.textContent('h2') : 'none (explorer started)');
console.log('console:', log.filter((l) => /error|warn/i.test(l)).slice(0, 8).join('\n  '));
const ok = result.controlled && Object.values(result.files).every((f) => f.status === 200 && f.same) && result.range.status === 206 && result.range.same && result.missing === 404 && !gate;
await browser.close();
console.log(ok ? 'FOLDER MODE OK' : 'FOLDER MODE FAILED');
process.exit(ok ? 0 : 1);
