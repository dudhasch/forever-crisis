# FF7 Forever Crisis

Walk the world of **FINAL FANTASY VII EVER CRISIS** again: the cities, reactors and slums, the story scenes and the
ATB battles, rebuilt in your browser from the game you already own.

Ever Crisis is no longer online. This fan project contains **no game files**. A small installer finds the game in
your Steam library and extracts what the explorer needs from **your own copy**.

**Site:** <https://zealous-meadow-0d9a94303.6.azurestaticapps.net>

## Install

Open **PowerShell** (press <kbd>Win</kbd>, type `powershell`, press <kbd>Enter</kbd>) and paste:

```powershell
irm https://github.com/dudhasch/forever-crisis/releases/latest/download/install.ps1 | iex
```

**Prefer to read it first?** Download the script from the
[latest release](https://github.com/dudhasch/forever-crisis/releases/latest), look at it, compare its SHA-256 with
`SHA256SUMS.txt` from the same release, then run it:

```powershell
Invoke-WebRequest https://github.com/dudhasch/forever-crisis/releases/latest/download/install.ps1 -OutFile install.ps1
notepad install.ps1
Get-FileHash install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

The installer walks you through four steps: **Find the game → Extract → Install → Done**. It shows progress bars
and plain explanations. If the game isn't found, it explains why and lets you pick the folder yourself.

In **Windows Terminal** (the default on Windows 11) the installer shows real pictures: once it has found your game it
takes the story logos, some key art and the Forever Crisis logo from **your copy** and shows them while it works.
Older console windows show the key art in colored blocks.

### Requirements

- Windows 10 or 11 (64-bit), no administrator rights needed
- FINAL FANTASY VII EVER CRISIS installed through **Steam**, with its game data downloaded. While the game was
  online, it downloaded about 50 GB the first time it started. The installer needs that data; it does not download
  anything from the game.
- About **57 GB** of free disk space, plus about 30 GB more while extracting (temporary)
- To play online: **Google Chrome or Microsoft Edge** (they can open a folder on your PC). Other browsers can use
  local mode.

Extraction takes about 25-30 minutes on a fast PC (24-core CPU, NVMe SSD); expect up to an hour or two on slower PCs or
hard disks. You can stop at any time; run the command again and it continues where it stopped.

## Play

- **Online:** open the [site](https://zealous-meadow-0d9a94303.6.azurestaticapps.net) in Chrome or Edge and click
  **Choose folder**, then pick `C:\Games\FF7-Forever-Crisis`. Your browser remembers the folder. The site only reads
  it; your files are never uploaded.
- **Local mode:** double-click **FF7 Forever Crisis** on your desktop or in the Start menu. It starts a small server
  on your PC (`http://127.0.0.1:17777`, only reachable from this PC) and opens the explorer in your browser. It works
  in any browser and without internet. It stops by itself after two hours of inactivity, or use the Start-menu
  entry **Stop the local server**.

Some names show an id (such as `#210153`) instead of text: a Steam update removed those rows from the game's data.
See [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md).

## What gets installed where

| Where | What |
|---|---|
| `C:\Games\FF7-Forever-Crisis\arc`, `lib`, `gen` | the extracted files: models, textures, music, movies, battle effects, story data (about 57 GB, 50,000 files) |
| `C:\Games\FF7-Forever-Crisis\ffcx-manifest.json` | list of extracted files with checksums and the extractor version |
| `C:\Games\FF7-Forever-Crisis\tools\ffcx` | the extractor and local server (includes FFmpeg and vgmstream) |
| `C:\Games\FF7-Forever-Crisis\app` | the explorer for local mode (only if you chose local mode) |
| `C:\Games\FF7-Forever-Crisis\runtime` | a portable PowerShell 7 (only if your PC doesn't have it) and the installer's UI module |
| `C:\Games\FF7-Forever-Crisis\logs` | installer and extractor logs |
| Desktop and Start menu | **FF7 Forever Crisis** shortcuts |
| Apps & features | an **FF7 Forever Crisis** entry, for uninstalling |

Your Steam installation is only read, never changed.

## Update, repair, uninstall

Run the install command again. If Forever Crisis is already installed, the installer offers **Update** (when a new
version exists), **Repair** (checks every file and finishes anything missing) and **Uninstall**. You can also
uninstall from **Settings → Apps → Installed apps → FF7 Forever Crisis**, or from the Start-menu entry **Update,
repair or uninstall**. Uninstalling removes the shortcuts, the Apps entry and (if you agree) the files the installer
created; anything else you put in the folder stays.

## Report a bug

Choose **Report a bug** on the start menu, in the game menu (**Extras**) or in a battle or cutscene pause window.
It opens a GitHub issue form in a new tab with the version, mode, browser, where you are in the game, the asset
folder version and the last few errors filled in (file paths removed). You see everything before it is sent and
can edit it; your save is added only as a short summary, and only if you tick the box. You need a GitHub account.
Ideas go in a [feature request](https://github.com/dudhasch/forever-crisis/issues/new?template=feature_request.yml).
Security problems: please follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Privacy

- The site never uploads your game files. In online mode the browser reads them locally after you grant access.
- **Cloud saves** are optional. Sign in with GitHub or Microsoft (Azure Static Web Apps sign-in). Only your save
  slots are stored, under a hashed account key.
- **Play statistics and error reports** are **off** unless you turn them on in the in-game menu
  (**Config → Cloud saves, privacy and game files**). When they are on, only these fields are sent:
  - a random id created when you turn the option on (deleted when you turn it off; not linked to any account)
  - the explorer version, asset mode (folder or local), browser family (Chrome, Edge, Firefox, Safari, other) and a
    rounded screen width
  - events: session start and length, map entered (map id), story step started (step number), battle finished
    (battle id, result, seconds), menu opened (tab)
  - error messages and stack traces, with file paths reduced to file names, at most 20 per session
  - **Not stored:** IP addresses, account ids, save data, anything you type. Rows older than 180 days are deleted.
- Local mode talks to nothing but your own PC.

## Legal

**Unofficial fan project, not affiliated with Square Enix. FINAL FANTASY VII EVER CRISIS © SQUARE ENIX CO., LTD.
All Rights Reserved.**

FF7 Forever Crisis is non-commercial and is not endorsed or sponsored by Square Enix or Applibot. All related names,
characters, music, artwork and other content are trademarks and copyrights of their owners. The website uses its
own title and icons; the logo made from the game's artwork is drawn on your PC from your copy and only shown in
local mode.

The code is licensed under the [MIT license](LICENSE). The license does not cover any game assets: see
[NOTICE.md](NOTICE.md).

This repository and its releases distribute **no game assets**: no models, textures, audio, video, text or scripts
from the game. The explorer only works with files a player extracts from **their own** copy of the game. The
extractor's data pack is a recipe of ids, offsets and hashes, with no text, models, textures or audio. It is not
stored in this repository: the installer downloads it and checks its SHA-256 (`extractor/data.lock.json`, see
[docs/PUBLISHING.md](docs/PUBLISHING.md)).

The decoding methods come from public open-source projects: [ff7ecapi](https://github.com/shalzuth/ff7ecapi) (MIT)
for the catalog, bundle and master-data formats, and [vgmstream](https://github.com/vgmstream/vgmstream) for CRI
audio and video. Third-party licenses are in `extractor/LICENSES`.

---

## For developers

This repository is the source of truth for the release: the web app, the extractor, the installer and the site.
Pull requests go here; see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). The
maintainer also works on the explorer in a private working tree next to their local extraction of the game (for
the game data the app needs while developing) and merges those changes into `app/` with a three-way merge, so
changes made here are kept.

```
app/              the explorer (Vite + TypeScript + three.js)
  public/icons/     site icons, drawn by release-tools/make_installer_art.py --icons (original, no game assets)
api/              Azure Functions (SWA managed): /api/version, /api/compat, /api/saves, /api/telemetry
swa/              staticwebapp.config.json
extractor/        ffcx: Python extractor + local server (PyInstaller -> ffcx.exe, ffcx-server.exe)
  ffcx/             game discovery, catalog and MasterData decryption, bundle decoding, pipeline, text, server
  vendor/           the explorer's converters (copied by release-tools/sync_vendor.py, paths from FFCX_* env)
  data.lock.json    file name + SHA-256 + URL of the published data pack (the installer downloads it)
installer/        install.ps1 (irm | iex, PowerShell 5.1 bootstrap -> PowerShell 7 + PwshSpectreConsole)
  art/              materia animations drawn by release-tools/make_installer_art.py (original, no game assets)
infra/            main.bicep: Static Web App (Free), Storage accounts, Key Vault, GitHub OIDC identities
release-tools/    maintainer tools that need the maintainer's local extraction (recipe, templates, decode list)
scripts/          export-public, fetch-tools, finish-dist, scan, stage-release
tests/            unit tests (templates, data lock) and end-to-end checks (CSP headers, folder service worker)
.github/workflows ci (build + tests + scan), release (tag -> GitHub Release), deploy-swa and preview-swa (Azure),
                  publish-data (upload a data pack)
```

### How extraction works

1. `ffcx locate` reads the Steam path from the registry and every library in `libraryfolders.vdf`, then checks
   `FF7EC.exe`, the IL2CPP metadata, `octo/pdb/**/octocacheevai` and `octo/v1`.
2. The Octo catalog is AES-decrypted with a key found among the player's own IL2CPP string literals, then parsed
   (`Database.proto`). The MasterData key is found the same way. The only key in this repository is the CRI key
   for the game's audio and movies (`0x11DA4DE45ADE` in `extractor/ffcx/convert.py`), which is public: it comes
   from [vgmstream's key list](https://github.com/vgmstream/vgmstream/blob/master/src/meta/hca_keys.h).
3. A CAB index is read from the headers of all bundles (only header bytes are decoded).
4. Only the bundles and resources in the recipe are decoded (name-derived XOR) into a staging folder.
5. The explorer's converters run on them: models (`unity_gltf.py` v5, battle stages with their baked lightmaps,
   emissive materials and props), textures (UnityPy PNG, stage normal and occlusion maps included), weapons,
   skies, music and sound effects (vgmstream → FLAC with loop tags), movies (WannaCRI → VP9 + FLAC in MKV),
   animations (`convert_anims.py --scope all`), EC's particle effects with their meshes, stage ambience and attach
   points (`convert_effects.py`) and every map's lighting: fog, ambient, sun, post-processing
   (`extract_lighting.py`).
6. Text templates are filled from the player's decrypted MasterData and Lua scripts. Strings that a current
   install no longer has get a fallback ([docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md)).
7. Every file is hashed into `ffcx-manifest.json` and compared with the release's reference hashes.

Before extracting, the installer runs `ffcx art --game <dir> --out <install>`: it decodes 16 small bundles (the story
logos and nine key-art backdrops) into `<install>\.ffcx\art` and runs the brand step early (the logo on a light card),
about 10-20 s. The release itself only contains the materia orbs in `installer/art` (drawn by code) and the FIGlet
title.

Progress is printed as JSON lines (`{"event":"phase"|"progress"|"warn"|"error"|"done", ...}`), which the installer
renders. Every phase is resumable (`.ffcx/done/*.txt`). A finished item's marker carries a stamp of its outputs'
reference hashes, so running a newer release over an older install redoes only what changed.

### Building a release (maintainer)

Needs the maintainer's local extraction, the explorer's working tree, the converters and the game. Their folders
come from environment variables or `release-tools/paths.local.json` (see `release-tools/paths.py`).

```powershell
py -3.10 -m venv .venv; .venv\Scripts\pip install -r extractor\requirements.txt pyinstaller pygltflib
.venv\Scripts\python release-tools\sync_vendor.py           # converters -> extractor/vendor
.venv\Scripts\python release-tools\make_recipe.py --no-hash # what the explorer can request
.venv\Scripts\python release-tools\dehydrate.py             # text templates + literal review report
# (from extractor/) recording run on the local extraction and its copy of the game folder
..\.venv\Scripts\python -m ffcx extract --archive <extraction> --client <its game folder> --out <dir> --trace
.venv\Scripts\python release-tools\record.py <dir>          # decode list + reference hashes into recipe.json
# after a converter change, redo only its phases in the folder of the last recording (make_recipe.py without
# --no-hash, so new files get hashes), then: record.py <dir> --partial
..\.venv\Scripts\python -m ffcx extract --archive <extraction> --client <its game folder> --out <dir> --trace --only models,effects,lighting
.venv\Scripts\python release-tools\pack_data.py             # extractor/data -> data pack zip + data.lock.json
pwsh release-tools/publish-data.ps1 -Account <acct>         # upload the pack (docs/PUBLISHING.md)
pwsh scripts/fetch-tools.ps1                                # vgmstream + FFmpeg into extractor/tools
.venv\Scripts\python release-tools\make_installer_art.py    # installer/art (only when changing the materia)
```

Commit, tag `vX.Y.Z` and push: `release.yml` builds `ffcx.exe`, the app and the installer files and creates the
GitHub Release (`install.ps1`, `release.json` (names the pinned data pack), `ffcx-*.zip`, `app-*.zip`,
`pwsh-modules-*.zip`, `SHA256SUMS.txt`). Update `api/release-feed.json` so the site and installer know about the
new version.

### Testing locally

```powershell
pwsh scripts/stage-release.ps1 -Out .\release-base -Site http://127.0.0.1:4280 -Mirror   # release files
python -m http.server 8765 -d .\release-base                                             # any static server
$env:FFC_BASE = 'http://127.0.0.1:8765'; $env:FFC_INSTALL_DIR = "$env:TEMP\ffc-install"
$env:FFC_PWSH_ZIP = 'http://127.0.0.1:8765/PowerShell-7.6.7-win-x64.zip'
irm $env:FFC_BASE/install.ps1 | iex                                                      # in Windows PowerShell 5.1
```

Site + functions with the emulators:

```powershell
npm install                       # SWA CLI, Azurite (dev dependencies)
npm run azurite                   # Table Storage emulator
copy api\local.settings.sample.json api\local.settings.json
npm run build:app; npm run swa    # http://localhost:4280 (sign-in is simulated by the SWA CLI)
```

### Deploying (maintainer, needs approval)

`infra/main.bicep` creates the Static Web App (Free), the Storage accounts, a Key Vault with the SWA deployment
token and two GitHub identities. The workflows sign in with OIDC (no stored Azure secret): `deploy-swa.yml` deploys
on pushes to `main`, `preview-swa.yml` deploys a preview per pull request. Until their Actions variables are set they
are skipped, so a fork or a fresh copy shows no failed runs. The variables are listed in
[infra/README.md](infra/README.md#github-settings-from-the-outputs).
