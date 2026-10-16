# Contributing

Thanks for helping keep FF7 Forever Crisis playable!

## Ground rules

- **Never commit game content.** No files extracted from the game (models, textures, audio, video,
  animations, Lua scripts, dialogue, master data), no screenshots showing game content, no keys or
  decrypted data. CI runs `npm run scan` and fails on anything that looks like it.
- No personal data in code, tests or logs (names, emails, absolute paths from your machine).
- Be kind: see the [Code of Conduct](CODE_OF_CONDUCT.md).

## Layout

| Folder | What |
|---|---|
| `app/` | the web app (Vite + TypeScript + three.js) |
| `api/` | Azure Functions: version feed, compatibility check, cloud saves, opt-in telemetry |
| `swa/` | Static Web App config (routes, auth, headers) |
| `infra/` | Bicep for Azure ([infra/README.md](infra/README.md)) |
| `installer/`, `extractor/` | the `irm \| iex` installer and the Python extractor (`ffcx`) |
| `scripts/`, `tests/` | build helpers, end-to-end tests |

## Develop

```bash
npm ci
npm run build          # app + dist, no game files needed
npm test               # app unit tests + api tests
npm run scan           # secret, personal-data and game-content scan
```

The game needs assets to run. Install the game once with the installer, then point dev mode at the folder
it extracted:

```bash
FFC_ASSETS=/path/to/ForeverCrisis npm --prefix app run dev
```

## Pull requests

Small, focused PRs with a short description of what changed and how you tested it. Update
`CHANGELOG.md` under "Unreleased" for anything players notice.
