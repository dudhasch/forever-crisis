# FF7 Forever Crisis

Walk the world of **FINAL FANTASY VII EVER CRISIS** again — explore the cities, Mako reactors, and slums, relive iconic story cutscenes, and command ATB battles, rebuilt directly in your web browser.

> [!NOTE]
> **100% Fan Project & Preservation Effort**  
> Ever Crisis is no longer online. This repository contains **no game files or copyrighted assets**. An automated installer finds the game in your own Steam library and extracts the required data locally on your computer. Your game files are never uploaded anywhere.

---

### Quick Links
- 🌐 **Play Online:** [Forever Crisis Web App](https://zealous-meadow-0d9a94303.6.azurestaticapps.net)
- 💾 **Local Offline Play:** Included with the installer (works in any browser without internet)
- 🎯 **Project Scope:** [What This Is & Isn't](#-project-vision-what-this-is-and-isnt)
- 🐛 **Issue Tracker:** [Report a Bug](https://github.com/dudhasch/forever-crisis/issues)
- 📖 **Developer Guide:** [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)

---

## ⚡ 3-Step Quick Start

Getting started takes just three easy steps:

### 1. Check Prerequisites
* **Windows 10 or 11 (64-bit)** — no administrator privileges required.
* **FINAL FANTASY VII EVER CRISIS on Steam** — must be installed with its game data already downloaded (when the game was online, it downloaded ~50 GB on first launch). The installer extracts from this data and does not download game files.
* **Disk Space:** ~57 GB free space for the extracted game, plus ~30 GB temporary space during extraction.
* **Web Browser:** **Google Chrome** or **Microsoft Edge** to play online (via folder access). Any browser works for local offline mode.

### 2. Run the 1-Line Installer
Open **PowerShell** (press <kbd>Win</kbd>, type `powershell`, and press <kbd>Enter</kbd>), then paste and run:

```powershell
irm https://github.com/dudhasch/forever-crisis/releases/latest/download/install.ps1 | iex
```

The installer will guide you through four simple steps:
1. **Find the game** (automatically locates your Steam library; you can also select the folder manually).
2. **Extract** (converts 3D models, music, cutscenes, and battles with live progress bars).
3. **Install** (sets up your chosen mode and desktop shortcuts).
4. **Done!**

> [!TIP]
> Extraction takes about 25–30 minutes on a fast PC with an SSD (or an hour or two on mechanical hard drives). You can close the installer at any time; running the command again will safely resume right where you left off.

<details>
<summary><strong>Prefer to inspect the script before running?</strong></summary>

You can download the script directly from the [latest release](https://github.com/dudhasch/forever-crisis/releases/latest), verify its SHA-256 hash against `SHA256SUMS.txt`, and run it manually:

```powershell
Invoke-WebRequest https://github.com/dudhasch/forever-crisis/releases/latest/download/install.ps1 -OutFile install.ps1
notepad install.ps1
Get-FileHash install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```
</details>

### 3. Launch & Play

Choose how you want to play:

* **Option A: Web Browser (Online)**  
  Open the [Forever Crisis Site](https://zealous-meadow-0d9a94303.6.azurestaticapps.net) in Chrome or Edge, click **Choose folder**, and select `C:\Games\FF7-Forever-Crisis`.  
  *Your browser remembers this folder. Your game files are read locally from your drive and are never uploaded.*

* **Option B: Desktop App / Local Mode (Offline)**  
  Double-click the **FF7 Forever Crisis** shortcut on your desktop or Start Menu.  
  *This launches a tiny local server on your PC (`http://127.0.0.1:17777`) and opens the game in your favorite browser. It works 100% offline with zero internet connection.*

---

## 🎯 Project Vision: What This Is (and Isn't)

Forever Crisis is a fan preservation and reimagining project built with a clear design philosophy in mind:

### ✅ What This Project Is
* **Preserving Ever Crisis with an Authentic Feel:** Giving fans the ability to play and experience Final Fantasy VII Ever Crisis after official servers closed, capturing its visual style and combat presentation.
* **Exploring the Stories & The First Soldier:** Bringing to light the lore and story arcs that made Ever Crisis special — particularly the backstory of **The First Soldier** (Glenn, Matt, Lucia, and young Sephiroth) — alongside classic Final Fantasy VII and Crisis Core episodes.
* **Blending Original Game Elements with Ever Crisis:** Combining the high-fidelity 3D assets, battles, and cutscenes of FF7EC with gameplay elements, exploration flow, and sensibilities inspired by the original PlayStation FF7.
* **Single-Player RPG Progression:** Gacha rolls, stamina timers, microtransactions, and banner grinds are completely eliminated. Progression is refocused into a classic single-player RPG experience where equipment, weapons, and story milestones are earned directly through play and exploration.

### ❌ What This Project Is Not
* **NOT a Decompilation or Recompilation:** This project is not a decomp/recomp of the proprietary FF7EC game client or engine binaries. It is a clean-room browser/desktop reconstruction created with open web technologies (Vite, TypeScript, three.js) that reads your own legally extracted assets.
* **NOT a 1:1 Remake of Ever Crisis:** It does not aim to clone every mobile service interface, menu layer, or backend system 1:1. The focus is on playable exploration, story, and combat.
* **NOT a Gacha Reimplementation:** We do not reimplement gacha mechanics, weapon banners, stamina systems, or monetization loops.

---

## ✨ Features

- 🏙️ **3D World Explorer:** Freely walk through Midgar sectors, Shinra Building floors, Mako reactors, and story dungeons reconstructed in three.js.
- ⚔️ **ATB Combat System:** Battle enemies with authentic abilities, limit breaks, animations, and particle effects.
- 🎬 **Story Cutscenes:** Replay cinematic scenes and dialogue from Final Fantasy VII, Crisis Core, and The First Soldier.
- 🎵 **High-Fidelity Audio & Video:** High-quality FLAC soundtracks with original looping points, voice acting, and converted cutscene movies.
- ☁️ **Flexible Saves:** Keep your progress saved locally in your browser, or optionally enable cloud saves via Microsoft / GitHub login.

---

## ⚙️ Managing Your Installation

### What gets installed where
By default, the installer places files in `C:\Games\FF7-Forever-Crisis`:

| Location | Purpose |
|---|---|
| `C:\Games\FF7-Forever-Crisis\arc`, `lib`, `gen` | Extracted assets: 3D models, textures, audio, cutscenes, effects (~57 GB, ~50,000 files) |
| `C:\Games\FF7-Forever-Crisis\ffcx-manifest.json` | Integrity manifest with SHA-256 checksums and version info |
| `C:\Games\FF7-Forever-Crisis\tools\ffcx` | Extractor engine and local server (includes FFmpeg and vgmstream) |
| `C:\Games\FF7-Forever-Crisis\app` | Explorer client for offline play (if local mode is chosen) |
| `C:\Games\FF7-Forever-Crisis\runtime` | Self-contained PowerShell 7 runtime and terminal UI components |
| `C:\Games\FF7-Forever-Crisis\logs` | Installer and extraction diagnostic logs |
| Desktop & Start Menu | **FF7 Forever Crisis** shortcuts |
| Windows Installed Apps | An **FF7 Forever Crisis** entry for easy management and removal |

*Your original Steam installation is strictly read-only and is never modified.*

### Updating, Repairing, or Uninstalling
Simply run the install command again:

```powershell
irm https://github.com/dudhasch/forever-crisis/releases/latest/download/install.ps1 | iex
```

If an existing installation is detected, the installer will present options to:
- **Update:** Upgrades the explorer and tools to the latest release while keeping your existing extracted assets.
- **Repair:** Verifies every file against checksums and re-extracts any corrupted or missing assets.
- **Uninstall:** Removes shortcuts, the Windows app entry, and the extracted files (your custom files are left intact). You can also uninstall via Windows **Settings → Apps → Installed apps**.

---

## ❓ Troubleshooting & FAQ

<details>
<summary><strong>The installer cannot find my Steam installation automatically</strong></summary>

If your Steam library is on an unusual drive or custom path, the installer will let you manually browse or type the path to your `FINAL FANTASY VII EVER CRISIS` game directory (the folder containing `FF7EC.exe`).
</details>

<details>
<summary><strong>Why do some items show an ID (like <code>#210153</code>) instead of a name?</strong></summary>

A Steam update removed certain string rows from the game's official `MasterData` files before servers went offline. The extractor displays row IDs for missing strings rather than leaving blank spaces. See [docs/KNOWN-GAPS.md](docs/KNOWN-GAPS.md) for full technical details.
</details>

<details>
<summary><strong>How do I stop the local offline server?</strong></summary>

The local server automatically shuts down after two hours of inactivity. You can also stop it immediately using the **Stop the local server** entry in your Windows Start Menu or by closing its console window.
</details>

---

## 🔒 Privacy & Security

- **Your game files stay on your machine:** In web mode, modern browser File System APIs read your local files directly. No game data is ever uploaded to our servers.
- **Optional Cloud Saves:** Cloud saves require signing in with GitHub or Microsoft. Only your save slot data is stored under a securely hashed account identifier.
- **Anonymous Telemetry is Opt-In:** Error diagnostics and play statistics are disabled by default. If you choose to enable them in **Config → Cloud saves, privacy and game files**, only anonymized crash logs, browser family, and gameplay event milestones (e.g. battles completed) are collected. No IP addresses, usernames, or save files are ever recorded, and records older than 180 days are permanently purged.
- **Local Mode is Completely Isolated:** When using desktop local mode, the application communicates exclusively with `127.0.0.1` and makes no external network calls.

---

## 🐛 Feedback & Bug Reports

Found an issue or have a suggestion?
- **In-Game Report:** Click **Report a bug** in the Start Menu, in-game menu (**Extras**), or pause screen. It automatically prepares a GitHub issue draft with your version, browser, and recent error messages (with personal file paths sanitized).
- **Feature Requests:** Submit ideas on our [Feature Request Tracker](https://github.com/dudhasch/forever-crisis/issues/new?template=feature_request.yml).
- **Security Inquiries:** For vulnerability disclosures, please review [SECURITY.md](SECURITY.md).

---

## ⚖️ Legal Notice

**Unofficial fan preservation project. Not affiliated with, endorsed by, or sponsored by Square Enix or Applibot.**  
*FINAL FANTASY VII EVER CRISIS © SQUARE ENIX CO., LTD. All Rights Reserved.*

FF7 Forever Crisis is an entirely non-commercial fan project. All trademarks, characters, artwork, music, and registered properties belong to their respective owners. 

This repository and its releases **contain no copyrighted game assets**. The explorer only functions with assets extracted by users from their legally owned Steam installation. The extractor's reference data pack contains only recipes, hashes, and offsets, and is distributed independently (see [docs/PUBLISHING.md](docs/PUBLISHING.md)).

Code is licensed under the [MIT License](LICENSE). For third-party library licenses, see [NOTICE.md](NOTICE.md) and `extractor/LICENSES`.

---

## 🛠️ Contributing & Development

We welcome community contributions! Whether you want to improve 3D rendering, add battle mechanics, or optimize extraction:
- Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for full architecture notes, build guides, and local test instructions.
- Review [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md) before submitting pull requests.
