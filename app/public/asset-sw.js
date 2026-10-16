/* Forever Crisis asset service worker.
 *
 * Hosted mode: the game files the player extracted live in a local folder they granted with the File System
 * Access API. This worker answers the app's /arc/, /lib/ and /gen/ requests (and /ffcx-manifest.json) from that
 * folder, so every loader (fetch, GLTFLoader, textures, <audio>, <video>) works with plain URLs. Range requests
 * get 206 slices of the File, which keeps seeking in long FLAC/MKV files working.
 */
const PREFIXES = ['/arc/', '/lib/', '/gen/'];
const TYPES = {
  json: 'application/json', glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream',
  png: 'image/png', jpg: 'image/jpeg', ico: 'image/x-icon', flac: 'audio/flac', ogg: 'audio/ogg', mkv: 'video/x-matroska', webm: 'video/webm',
};
let root = null; // FileSystemDirectoryHandle
let dirs = new Map(); // path -> directory handle

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'ffcx-folder-changed') {
    root = null;
    dirs = new Map();
  }
});

function idbHandle() {
  return new Promise((resolve) => {
    const req = indexedDB.open('ffcx', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const tx = req.result.transaction('handles', 'readonly');
      const get = tx.objectStore('handles').get('root');
      get.onsuccess = () => resolve(get.result || null);
      get.onerror = () => resolve(null);
    };
  });
}

async function folder() {
  if (!root) root = await idbHandle();
  return root;
}

async function dir(path) {
  if (dirs.has(path)) return dirs.get(path);
  const parts = path.split('/').filter(Boolean);
  const parent = parts.length ? await dir(parts.slice(0, -1).join('/')) : await folder();
  const h = parts.length ? await parent.getDirectoryHandle(parts[parts.length - 1]) : parent;
  dirs.set(path, h);
  return h;
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function serve(request, pathname) {
  const h = await folder();
  if (!h) return json(503, { error: 'no-folder' });
  if ((await h.queryPermission({ mode: 'read' })) !== 'granted') return json(503, { error: 'permission' });
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel.split('/').some((p) => p === '..' || p === '.')) return json(400, { error: 'bad-path' });
  const cut = rel.lastIndexOf('/');
  let file;
  try {
    const d = await dir(cut < 0 ? '' : rel.slice(0, cut));
    file = await (await d.getFileHandle(rel.slice(cut + 1))).getFile();
  } catch (e) {
    if (e && e.name === 'NotAllowedError') return json(503, { error: 'permission' });
    return new Response('', { status: 404 });
  }
  const type = TYPES[rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : file.size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : file.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, file.size - 1);
    if (start > end) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${file.size}` } });
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${file.size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(file, { status: 200, headers: { ...headers, 'Content-Length': String(file.size) } });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  const p = url.pathname;
  if (p === '/ffcx-manifest.json' || PREFIXES.some((x) => p.startsWith(x))) event.respondWith(serve(event.request, p));
});
