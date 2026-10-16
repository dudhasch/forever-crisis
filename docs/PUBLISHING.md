# Publishing the public repository

The public repository is made from the maintainer's release checkout by `scripts/export-public.mjs`: a fresh,
history-free copy of `HEAD` without the data pack's files or maintainer paths, scanned, with a single commit. Nothing
is pushed. The release checkout is where `app/` is maintained: the maintainer's private explorer tree is merged into
it (three-way, so fixes made in `app/` are kept), and the public repository is exported from it.

```bash
node scripts/export-public.mjs ../forever-crisis-public --repo dudhasch/forever-crisis
cd ../forever-crisis-public
npm ci && npm run build && npm test
FFC_SCAN_NAMES="<your names, handles and local folder names>" npm run scan
```

The commit is authored as `dudhasch <155721920+dudhasch@users.noreply.github.com>` (the GitHub noreply address;
override with `--author-name` / `--author-email` or `FFC_EXPORT_NAME` / `FFC_EXPORT_EMAIL`). The export sets
that identity in its own `.git/config`, so a global git identity is never used.

Left out of the public tree: `extractor/data/` (the data pack's files, see below), `release-tools/out/`,
`docs/screenshots/` (add `--with-screenshots` once you have checked they show no game content), `app/SYNCED_FROM`
and `scripts/sync-app.mjs` (the maintainer-only merge). Paths from the git-ignored `release-tools/paths.local.json`
are rewritten to `<archive>`, `<explorer>`, `<converters>`, `<client>`; the scan fails on anything left over.

## The data pack

The extractor's data pack is a recipe of ids, offsets and hashes, with no text, models, textures or audio.

`extractor/data/` (`recipe.json`, `templates.json.gz`, `text-bundles.json`; about 15 MB, 7 MB zipped) lists the
bundles to decode, the output file hashes and the explorer's generated data with every game string replaced by a
reference to where it lives in the player's own files. It is built from the maintainer's local extraction and cannot
be rebuilt from a player's install, so it is published separately from the repository and the GitHub Release, and
pinned by hash:

- `release-tools/pack_data.py` zips `extractor/data` deterministically into
  `release-tools/out/ffcx-data-<catalog revision>-<sha256 prefix>.zip` and writes `extractor/data.lock.json`
  (file name, size, SHA-256, container URL `base`). **The lock file is committed**.
- `release-tools/publish-data.ps1 [-Account <dataStorageAccount>]` uploads the zip to the public `ffcx-data` blob
  container (created by `infra/main.bicep` in a second Storage account; outputs `dataBaseUrl` and
  `dataStorageAccount`) with `az storage blob upload --auth-mode login`. The file name contains the hash and the
  script never overwrites, so older releases keep working. The account defaults to the one in `DATA_BASE_URL` or
  the lock's `base`.
- `scripts/stage-release.ps1` copies the lock into `release.json` (`data.url`, `data.sha256`); the release workflow
  runs it with `-VerifyData`, which downloads the pack and fails the release if it is missing or its hash differs.
- `install.ps1` downloads the pack to `<install>\tools\data\<hash>\`, verifies the SHA-256 from `release.json`,
  and runs `ffcx extract --data <that folder>`. `ffcx.exe` is built without data (`FFCX_NO_BUNDLED_DATA=1` in the
  workflow); `FFCX_DATA` / `--data` select the folder, and a maintainer checkout that has `extractor/data/` still
  bundles it as a fallback for local builds.

To publish a new recipe (after `record.py`/`dehydrate.py` change the data):

```powershell
.venv\Scripts\python release-tools\pack_data.py --base https://<account>.blob.core.windows.net/ffcx-data
pwsh release-tools/publish-data.ps1 -Account <account>
git add extractor/data.lock.json; git commit; git tag vX.Y.Z   # the tag build verifies the upload
```

`publish-data.ps1` signs in with your own `az login`, which needs **Storage Blob Data Contributor** on the data
account (`main.bicep` gives that role only to `id-fc-gh-main`; Owner/Contributor alone is not enough for
`--auth-mode login`). Without it, upload from GitHub Actions instead: commit and push the new
`extractor/data.lock.json` to `main`, put the zip behind a short-lived https link, and run **Actions →
publish-data → Run workflow** with that link. The workflow signs in as `id-fc-gh-main` (OIDC), checks the zip
against the lock on `main` and runs the same script. Then tag the release.

Set the Actions variable `DATA_BASE_URL` to the container URL (or fill `base` in the lock). If the pack ever has to
be withdrawn, delete the blob; installs fail with a clear download error and nothing else changes. Review the pack
before each release the same way as `docs/screenshots`.

## Checklist

1. **Create the repository** on GitHub (public, empty, no README) and push the exported folder:
   `git remote add origin https://github.com/dudhasch/forever-crisis.git && git push -u origin main`.
2. **Settings → Code security**: enable secret scanning, push protection, Dependabot alerts and private
   vulnerability reporting (SECURITY.md points there).
3. **Labels**: make sure `bug` and `enhancement` exist (the issue forms add them).
4. **Azure**: `az group create …` then `az deployment group create -g <rg> -f infra/main.bicep -p infra/main.bicepparam`
   (see infra/README.md).
5. **Secrets and variables → Actions → Variables** (no secrets: the workflows sign in with OIDC through the
   identities from step 4 and read the SWA deployment token from Key Vault; table in infra/README.md). Until
   `AZURE_CLIENT_ID` / `AZURE_CLIENT_ID_PR` are set, `deploy-swa` and `preview-swa` are skipped, not failed:
   - `AZURE_CLIENT_ID`: `mainClientId` (`id-fc-gh-main`; `deploy-swa`, `publish-data`)
   - `AZURE_CLIENT_ID_PR`: `prClientId` (`id-fc-gh-pr`; `preview-swa` for pull requests)
   - `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`: `tenantId`, `subscriptionId`
   - `AZURE_KEY_VAULT`: `keyVaultName` (holds the secret `swa-deployment-token`)
   - `DATA_BASE_URL`: `dataBaseUrl`
   - `SITE_URL`: the site's https URL (`release.yml` passes it to `stage-release.ps1 -Site`; a release fails
     without it)

   Do not create the old `AZURE_STATIC_WEB_APPS_API_TOKEN` secret. Do not put the deploy job in a GitHub
   environment either: that changes the OIDC subject and `id-fc-gh-main` only trusts `refs/heads/main`.
6. **First deploy**: run the `deploy-swa` workflow (Actions → deploy-swa → Run workflow) or push to `main`.
   Builds set `VITE_GITHUB_REPO` to the repository, so "Report a bug" opens issues there.
7. **Check**: open the site, press "Report a bug" on the start menu and confirm GitHub shows the bug form
   with the environment fields filled in.
8. **Data pack**: upload the extractor data and pin it (see "The data pack" above). Do this before the first
   release tag.
9. `.github/CODEOWNERS` names `@dudhasch`; change it if someone else reviews.
