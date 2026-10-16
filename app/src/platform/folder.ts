/**
 * The player's asset folder in hosted mode: a FileSystemDirectoryHandle kept in IndexedDB (the service worker
 * reads the same record) plus the asset service worker that serves it.
 */

interface PermissionHandle extends FileSystemDirectoryHandle {
  queryPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ffcx', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction('handles', mode).objectStore('handles'));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export function folderSupported() {
  return 'showDirectoryPicker' in window && 'serviceWorker' in navigator && window.isSecureContext;
}

export async function storedFolder(): Promise<PermissionHandle | null> {
  try {
    return (await idb<PermissionHandle | undefined>('readonly', (s) => s.get('root'))) ?? null;
  } catch {
    return null;
  }
}

export async function forgetFolder() {
  await idb('readwrite', (s) => s.delete('root'));
  navigator.serviceWorker.controller?.postMessage({ type: 'ffcx-folder-changed' });
}

/** Ask for a folder (needs a click). Returns null if the player cancelled. */
export async function pickFolder(): Promise<PermissionHandle | null> {
  try {
    const picker = (window as unknown as { showDirectoryPicker(o: object): Promise<PermissionHandle> }).showDirectoryPicker;
    const h = await picker.call(window, { id: 'ff7-forever-crisis', mode: 'read' });
    await idb('readwrite', (s) => s.put(h, 'root'));
    navigator.serviceWorker.controller?.postMessage({ type: 'ffcx-folder-changed' });
    return h;
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return null;
    throw e;
  }
}

export async function permission(h: PermissionHandle, ask: boolean): Promise<PermissionState> {
  const state = await h.queryPermission({ mode: 'read' });
  if (state === 'granted' || !ask) return state;
  return h.requestPermission({ mode: 'read' });
}

/** Folder content check (the picker can return any folder). */
export async function looksLikeAssetFolder(h: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    await h.getFileHandle('ffcx-manifest.json');
    return true;
  } catch {
    return false;
  }
}

/** Register the asset service worker and wait until it controls this page. */
export async function startServiceWorker(): Promise<void> {
  await navigator.serviceWorker.register('/asset-sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return;
  await new Promise<void>((resolve) => {
    navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
    setTimeout(resolve, 3000);
  });
  if (!navigator.serviceWorker.controller) location.reload(); // first visit in some browsers: claim after reload
}
