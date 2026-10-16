"""Local mode: serve the explorer and the extracted assets on http://127.0.0.1:<port>.

    /                 the built web app (<root>/app)
    /arc/ /lib/ /gen/ the extracted asset folders (<root>/arc, lib, gen), with HTTP Range for audio/video seeking
    /brand/           the logo and icons the extractor drew from the player's game (<root>/brand)
    /ffcx-manifest.json, /ffcx-local.json (tells the app it runs in local mode)
    /ffcx/stop        POST: shut the server down (Start-menu "Stop" shortcut)

Only binds to 127.0.0.1. Cross-origin reads (the hosted site using ?assets=http://127.0.0.1:17777) are allowed only
for origins listed in <root>/install.json "allowedOrigins". Stops by itself after 2 hours without requests.
"""
from __future__ import annotations

import json
import mimetypes
import os
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import __version__

TYPES = {'.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
         '.png': 'image/png', '.jpg': 'image/jpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.mkv': 'video/x-matroska',
         '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8',
         '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm'}
IDLE_SECONDS = 2 * 3600


def make_handler(root: Path, app: Path, origins: set[str], state: dict):
    mounts = {'/arc/': root / 'arc', '/lib/': root / 'lib', '/gen/': root / 'gen', '/brand/': root / 'brand'}

    class Handler(BaseHTTPRequestHandler):
        server_version = f'ffcx/{__version__}'

        def log_message(self, fmt, *args):  # quiet (windowless)
            pass

        def _cors(self):
            o = self.headers.get('Origin')
            if o and o in origins:
                self.send_header('Access-Control-Allow-Origin', o)
                self.send_header('Vary', 'Origin')
                self.send_header('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header('Access-Control-Allow-Methods', 'GET, HEAD')
            self.send_header('Access-Control-Allow-Headers', 'Range')
            self.end_headers()

        def do_POST(self):
            state['last'] = time.time()
            if self.path == '/ffcx/stop' and self.client_address[0] == '127.0.0.1':
                self.send_response(204)
                self.end_headers()
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            self.send_error(404)

        def do_HEAD(self):
            self.do_GET(head=True)

        def do_GET(self, head=False):
            state['last'] = time.time()
            path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
            if path == '/ffcx-local.json':
                return self._bytes(json.dumps({'mode': 'local', 'version': __version__}).encode(), 'application/json', head)
            if path.startswith('/api/'):
                return self.send_error(404)
            if path == '/ffcx-manifest.json':
                return self._file(root / 'ffcx-manifest.json', head)
            for prefix, base in mounts.items():
                if path.startswith(prefix):
                    return self._file(base / path[len(prefix):], head, base)
            rel = path.lstrip('/') or 'index.html'
            f = app / rel
            if not f.is_file():  # single-page app
                f = app / 'index.html'
            return self._file(f, head, app)

        def _bytes(self, data: bytes, ctype: str, head: bool):
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self._cors()
            self.end_headers()
            if not head:
                self.wfile.write(data)

        def _file(self, f: Path, head: bool, base: Path | None = None):
            try:
                f = f.resolve()
                if base is not None and not str(f).lower().startswith(str(base.resolve()).lower()):
                    return self.send_error(403)
                size = f.stat().st_size
                if not f.is_file():
                    raise FileNotFoundError
            except OSError:
                return self.send_error(404)
            ctype = TYPES.get(f.suffix.lower()) or mimetypes.guess_type(f.name)[0] or 'application/octet-stream'
            start, end, status = 0, size - 1, 200
            rng = self.headers.get('Range')
            if rng and rng.startswith('bytes='):
                a, _, b = rng[6:].split(',')[0].partition('-')
                try:
                    if a:
                        start, end = int(a), (int(b) if b else size - 1)
                    else:
                        start, end = max(0, size - int(b)), size - 1
                except ValueError:
                    start, end = 0, size - 1
                end = min(end, size - 1)
                if start > end:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.end_headers()
                    return
                status = 206
            self.send_response(status)
            self.send_header('Content-Type', ctype)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(end - start + 1))
            self.send_header('Cache-Control', 'no-cache' if f.suffix in ('.html', '.json') else 'max-age=3600')
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self._cors()
            self.end_headers()
            if head:
                return
            try:
                with open(f, 'rb') as fh:
                    fh.seek(start)
                    left = end - start + 1
                    while left > 0:
                        chunk = fh.read(min(1 << 20, left))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        left -= len(chunk)
            except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                pass

    return Handler


def running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/ffcx-local.json', timeout=1) as r:
            return json.load(r).get('mode') == 'local'
    except Exception:
        return False


def stop(port: int) -> bool:
    try:
        urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/ffcx/stop', method='POST'), timeout=2)
        return True
    except Exception:
        return False


def serve(root: Path, app: Path | None, port: int, open_browser: bool) -> int:
    root = Path(root)
    app = Path(app) if app else root / 'app'
    url = f'http://127.0.0.1:{port}/'
    if running(port):  # already up (second click on the shortcut)
        if open_browser:
            webbrowser.open(url)
        return 0
    origins = set()
    try:
        origins = set(json.loads((root / 'install.json').read_text(encoding='utf-8')).get('allowedOrigins', []))
    except (OSError, ValueError):
        pass
    state = {'last': time.time()}
    httpd = ThreadingHTTPServer(('127.0.0.1', port), make_handler(root, app, origins, state))
    httpd.daemon_threads = True

    def idle():
        while True:
            time.sleep(60)
            if time.time() - state['last'] > IDLE_SECONDS:
                httpd.shutdown()
                return
    threading.Thread(target=idle, daemon=True).start()
    if open_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
    return 0
