import { execFileSync } from 'node:child_process';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Dev mode reads game assets in place instead of copying gigabytes. Two layouts:
//   FFC_ASSETS=<folder>   a folder the installer extracted (<folder>/arc, lib, gen, ffcx-manifest.json)
//   (unset)               your own layout: FFC_ARCHIVE (default: the parent folder), FFC_LIBRARY (default:
//                         <archive>/lib) and FFC_GENERATED (default: ./generated)
const ASSETS = process.env.FFC_ASSETS ? resolve(process.env.FFC_ASSETS) : '';
const ARCHIVE = ASSETS ? join(ASSETS, 'arc') : resolve(process.env.FFC_ARCHIVE ?? resolve(__dirname, '..'));
const LIBRARY = ASSETS ? join(ASSETS, 'lib') : resolve(process.env.FFC_LIBRARY ?? join(ARCHIVE, 'lib'));
const GENERATED = ASSETS ? join(ASSETS, 'gen') : resolve(process.env.FFC_GENERATED ?? resolve(__dirname, 'generated'));
const MOUNTS: Record<string, string> = {
  '/arc/': ARCHIVE, // archive folders (audio, video, textures)
  '/lib/': LIBRARY, // converted GLB/glTF library
  '/gen/': GENERATED, // outputs of tools/*.py
  ...(ASSETS ? { '/ffcx-manifest.json': join(ASSETS, 'ffcx-manifest.json') } : {}),
};

const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.mkv': 'video/x-matroska',
};

function serveMounts(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = decodeURIComponent((req.url ?? '').split('?')[0]);
  const prefix = Object.keys(MOUNTS).find((p) => url.startsWith(p));
  if (!prefix) return next();
  const root = MOUNTS[prefix];
  const file = normalize(join(root, url.slice(prefix.length)));
  if (!file.startsWith(root)) {
    res.statusCode = 403;
    return res.end();
  }
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error('not a file');
    size = st.size;
  } catch {
    res.statusCode = 404;
    return res.end();
  }
  res.setHeader('Content-Type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'max-age=3600');
  // Range support so <audio> can seek through long FLAC tracks.
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : size - 1;
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.setHeader('Content-Length', size);
  createReadStream(file).pipe(res);
}

function archiveMounts(): Plugin {
  return {
    name: 'ff7ec-archive-mounts',
    configureServer(server) {
      server.middlewares.use(serveMounts);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serveMounts);
    },
  };
}

/**
 * fengari (the Lua VM) picks Node or browser code with `typeof process` checks, which webpack builds of
 * it replace at compile time. Do the same here: Electron-based browsers expose a global `process`.
 */
function fengariBrowser(): Plugin {
  return {
    name: 'fengari-browser',
    transform(code, id) {
      if (!/[\\/]fengari[\\/]src[\\/]/.test(id)) return null;
      // Some generated scripts keep 200+ locals in one function (5305/1003 startpoint_01); Lua's cap of 200
      // is only a parser limit, registers go to 255.
      return code
        .replace(/typeof process\b/g, '"undefined"')
        .replace(/process\.env\.FENGARICONF/g, 'undefined')
        .replace('const MAXVARS = 200;', 'const MAXVARS = 250;');
    },
  };
}

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };
function buildHash() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __BUILD_HASH__: JSON.stringify(buildHash()) },
  plugins: [archiveMounts(), fengariBrowser()],
  optimizeDeps: { rolldownOptions: { plugins: [fengariBrowser()] } },
  server: { port: 5180, fs: { allow: [ARCHIVE, LIBRARY, GENERATED] } },
});
