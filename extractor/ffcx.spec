# PyInstaller spec: dist/ffcx/{ffcx.exe, ffcx-server.exe} sharing one _internal folder.
#   ..\.venv\Scripts\pyinstaller ffcx.spec --noconfirm
# Needs tools/ffmpeg.exe and tools/vgmstream/ (scripts/fetch-tools.ps1 downloads them in CI).
from PyInstaller.utils.hooks import collect_all, collect_submodules

datas, binaries, hidden = [], [], []
for pkg in ('UnityPy', 'texture2ddecoder', 'etcpak', 'astc_encoder', 'wannacri', 'fmod_toolkit', 'archspec', 'pygltflib'):
    d, b, h = collect_all(pkg)
    datas += d; binaries += b; hidden += h
hidden += collect_submodules('cryptography') + ['lz4.frame', 'lz4.block', 'msgpack', 'sqlite3', 'PIL.Image', 'numpy']
datas += [('vendor', 'vendor'), ('tools', 'tools'), ('LICENSES', 'LICENSES')]
# The data pack (a recipe of ids, offsets and hashes, with no text, models, textures or audio) is not in the repository: releases fetch it at install time
# (extractor/data.lock.json). A maintainer checkout that has extractor/data/ still gets it bundled as a fallback.
import os
if os.path.isfile(os.path.join('data', 'recipe.json')) and not os.environ.get('FFCX_NO_BUNDLED_DATA'):
    datas += [('data', 'data')]

a = Analysis(['ffcx_entry.py'], pathex=['.', 'vendor'], datas=datas, binaries=binaries, hiddenimports=hidden,
             excludes=['tkinter', 'matplotlib', 'IPython', 'pytest'], noarchive=False)
pyz = PYZ(a.pure)
cli = EXE(pyz, a.scripts, [], exclude_binaries=True, name='ffcx', console=True, icon=None, upx=False)
srv = EXE(pyz, a.scripts, [], exclude_binaries=True, name='ffcx-server', console=False, icon=None, upx=False)
coll = COLLECT(cli, srv, a.binaries, a.datas, name='ffcx', upx=False)
