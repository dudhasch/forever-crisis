"""Command line: ffcx locate | validate | art | extract | serve | version"""
from __future__ import annotations

import argparse
import json
import multiprocessing
import sys
from pathlib import Path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog='ffcx', description='Extract the explorer assets from your own FF7 Ever Crisis install.')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('version')
    sub.add_parser('locate', help='find the game in all Steam libraries (JSON)')
    v = sub.add_parser('validate', help='check a game folder (JSON)')
    v.add_argument('path')
    x = sub.add_parser('extract', help='extract assets (progress as JSON lines on stdout)')
    x.add_argument('--game', help='game folder (…\steamapps\common\FF7EC)')
    x.add_argument('--archive', help=argparse.SUPPRESS)  # developer: read the maintainer's local extraction
    x.add_argument('--client', help=argparse.SUPPRESS)  # developer, with --archive: its copy of the game folder
    x.add_argument('--trace', action='store_true', help=argparse.SUPPRESS)
    x.add_argument('--out', required=True)
    x.add_argument('--workers', type=int)
    x.add_argument('--data', help='folder with the data pack (recipe.json, templates.json.gz, text-bundles.json); default: FFCX_DATA')
    x.add_argument('--keep-work', action='store_true', help='keep the decoded bundles (faster re-runs, ~25 GB)')
    x.add_argument('--only', help=argparse.SUPPRESS)
    x.add_argument('--limit', type=int, default=0, help=argparse.SUPPRESS)
    r = sub.add_parser('art', help='write a few pictures from the game for the installer (JSON)')
    r.add_argument('--game', required=True)
    r.add_argument('--out', required=True, help='install folder (pictures go to <out>/.ffcx/art)')
    s = sub.add_parser('serve', help='serve the explorer and the assets on localhost (local mode)')
    s.add_argument('--root', required=True, help='asset root (the install folder)')
    s.add_argument('--app', help='folder with the built web app (default: <root>\app)')
    s.add_argument('--port', type=int, default=17777)
    s.add_argument('--open', action='store_true', help='open the browser')
    s.add_argument('--stop', action='store_true', help='stop a running local server')
    a = ap.parse_args(argv)

    if a.cmd == 'version':
        from . import __version__, ASSET_FORMAT
        print(json.dumps({'version': __version__, 'assetFormat': ASSET_FORMAT}))
        return 0
    if a.cmd == 'locate':
        from . import game
        print(json.dumps({'candidates': game.candidates(), 'libraries': [str(p) for p in game.steam_libraries()]}))
        return 0
    if a.cmd == 'validate':
        from . import game
        print(json.dumps(game.validate(Path(a.path))))
        return 0
    if a.cmd == 'extract':
        import os
        from .pipeline import Run
        if a.data:
            os.environ['FFCX_DATA'] = str(Path(a.data).resolve())
        if not (a.game or a.archive):
            ap.error('--game is required')
        try:
            r = Run(Path(a.out), game=a.game, archive=a.archive, trace=a.trace, workers=a.workers, keep_work=a.keep_work,
                    only=a.only.split(',') if a.only else None, limit=a.limit, client=a.client)
        except RuntimeError as e:  # e.g. the data pack is missing: same JSON line the installer shows for other errors
            print(json.dumps({'event': 'error', 'message': str(e)}), flush=True)
            return 1
        return r.run()
    if a.cmd == 'art':
        from .art import build
        meta = Path(a.out) / '.ffcx'
        print(json.dumps(build(Path(a.game), meta / 'art', meta, root=Path(a.out))))
        return 0
    if a.cmd == 'serve':
        from .server import serve, stop
        if a.stop:
            return 0 if stop(a.port) else 1
        return serve(Path(a.root), Path(a.app) if a.app else None, a.port, a.open)
    return 2


if __name__ == '__main__':
    multiprocessing.freeze_support()
    sys.exit(main())
