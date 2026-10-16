import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { assetUrl } from './platform/source';

const gltfLoader = new GLTFLoader();
const gltfCache = new Map<string, Promise<GLTF>>();
const jsonCache = new Map<string, Promise<unknown>>();
const textureCache = new Map<string, Promise<THREE.Texture>>();
const textureLoader = new THREE.TextureLoader();

export function loadGLTF(url: string): Promise<GLTF> {
  let p = gltfCache.get(url);
  if (!p) {
    p = gltfLoader.loadAsync(assetUrl(url));
    p.catch(() => gltfCache.delete(url));
    gltfCache.set(url, p);
  }
  return p;
}

export async function fetchJSON<T>(url: string): Promise<T> {
  let p = jsonCache.get(url);
  if (!p) {
    p = fetch(assetUrl(url)).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return r.json();
    });
    p.catch(() => jsonCache.delete(url));
    jsonCache.set(url, p);
  }
  return p as Promise<T>;
}

export async function tryJSON<T>(url: string): Promise<T | null> {
  try {
    return await fetchJSON<T>(url);
  } catch {
    return null;
  }
}

/** Color textures are sRGB; data textures (depth) must stay linear and unfiltered. */
export function loadTexture(url: string, kind: 'color' | 'data'): Promise<THREE.Texture> {
  const key = `${kind}:${url}`;
  let p = textureCache.get(key);
  if (!p) {
    p = textureLoader.loadAsync(assetUrl(url)).then((t) => {
      if (kind === 'color') {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
      } else {
        t.colorSpace = THREE.NoColorSpace;
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
      }
      return t;
    });
    p.catch(() => textureCache.delete(key));
    textureCache.set(key, p);
  }
  return p;
}

/** Drop cached background textures of a map we left (they are 4096x2048 each). */
export function releaseTextures(urls: Iterable<string>) {
  for (const url of urls) {
    for (const kind of ['color', 'data']) {
      const key = `${kind}:${url}`;
      const p = textureCache.get(key);
      if (p) {
        p.then((t) => t.dispose());
        textureCache.delete(key);
      }
    }
  }
}
