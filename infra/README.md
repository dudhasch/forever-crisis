# Azure infrastructure

`main.bicep` creates, in one resource group (names for `workload=fc`, `env=prd`, westeurope):

| Resource | Purpose |
|---|---|
| Static Web App (Free) `swa-fc-prd-weu-001` | the web app (`app/dist`) and managed Functions (`api/`); PR previews on |
| Storage account (Standard_LRS) `stfcprd…` | Table Storage: `saves` (cloud saves), `telemetry` (opt-in stats) |
| Storage account (Standard_LRS) `stfcdata…` | public `ffcx-data` container for the extractor data packs |
| Key Vault (RBAC) `kv-fc-prd-…` | secret `swa-deployment-token` (written by the deployment) |
| Identity `id-fc-gh-main` | GitHub Actions on `main` (federated: `repo:<oidc repo>:ref:refs/heads/main`) |
| Identity `id-fc-gh-pr` | GitHub Actions on pull requests (federated: `repo:<oidc repo>:pull_request`) |
| App settings | `STORAGE_CONNECTION`, `TELEMETRY_ENABLED`, `TELEMETRY_RETENTION_DAYS` |
| Custom domain (optional) | `customDomain` parameter; add the CNAME to the default hostname first |

Roles (least privilege; infrastructure changes are deployed by hand, not by CI):

| Identity | Role | Scope |
|---|---|---|
| `id-fc-gh-main` | Contributor | the Static Web App |
| `id-fc-gh-main` | Storage Blob Data Contributor | the data storage account |
| `id-fc-gh-main` | Key Vault Secrets User | the Key Vault |
| `id-fc-gh-pr` | Reader | the resource group |
| `id-fc-gh-pr` | Key Vault Secrets User | the Key Vault |
| `adminPrincipalId` (optional) | Key Vault Secrets Officer | the Key Vault |

The identities are created only when `githubRepo` is set. Parameters are in `main.bicepparam` (environment
variables `FFC_WORKLOAD`, `FFC_ENV`, `AZURE_LOCATION`, `FFC_REPOSITORY_URL`, `FFC_CUSTOM_DOMAIN`,
`FFC_GITHUB_REPO`, `FFC_GITHUB_OIDC_REPO`, `FFC_ADMIN_PRINCIPAL_ID`, with defaults).

`<oidc repo>` is `githubRepo` unless the repository uses GitHub's immutable OIDC subjects (new repositories do):
then the token's subject is `repo:owner@<owner id>/name@<repo id>:…` and `githubOidcRepo` must be that prefix
without `repo:`. Read it with `gh api repos/<owner>/<name>/actions/oidc/customization/sub` (`sub_claim_prefix`).

## Check locally (nothing is deployed)

```bash
az bicep build -f infra/main.bicep --stdout > /dev/null
az bicep lint -f infra/main.bicep
az bicep build-params -f infra/main.bicepparam --stdout > /dev/null
```

## Deploy with Azure PowerShell

```powershell
New-AzResourceGroup -Name rg-fc-web-prd-weu-001 -Location westeurope -Tag @{ app = 'forever-crisis' }
az bicep build -f infra/main.bicep --outfile main.json   # Az PowerShell needs bicep on PATH otherwise
$p = @{ githubRepo = 'dudhasch/forever-crisis'; repositoryUrl = 'https://github.com/dudhasch/forever-crisis'
        githubOidcRepo = 'dudhasch@155721920/forever-crisis@1422091107'
        adminPrincipalId = (Get-AzADUser -SignedIn).Id }
New-AzResourceGroupDeployment -ResourceGroupName rg-fc-web-prd-weu-001 -TemplateFile main.json -TemplateParameterObject $p
```

## Deploy with the Azure CLI

```bash
az group create -n rg-fc-web-prd-weu-001 -l westeurope
FFC_GITHUB_REPO=dudhasch/forever-crisis FFC_GITHUB_OIDC_REPO=dudhasch@155721920/forever-crisis@1422091107 az deployment group create -g rg-fc-web-prd-weu-001 -f infra/main.bicep -p infra/main.bicepparam
```

## GitHub settings from the outputs

The workflows sign in to Azure with OIDC (`azure/login@v2`, `permissions: id-token: write`); no Azure secret is
stored in GitHub. Set these **variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Output | Used by |
|---|---|---|
| `AZURE_CLIENT_ID` | `mainClientId` (`id-fc-gh-main`) | `deploy-swa.yml`, `publish-data.yml` (pushes / runs on `main`) |
| `AZURE_CLIENT_ID_PR` | `prClientId` (`id-fc-gh-pr`) | `preview-swa.yml` (pull requests) |
| `AZURE_TENANT_ID` | `tenantId` | all three |
| `AZURE_SUBSCRIPTION_ID` | `subscriptionId` | all three |
| `AZURE_KEY_VAULT` | `keyVaultName` | `deploy-swa.yml`, `preview-swa.yml` read the secret `swa-deployment-token` |
| `DATA_BASE_URL` | `dataBaseUrl` | `release.yml` (`-VerifyData`), `publish-data.yml` |
| `SITE_URL` | `siteUrl` (or the custom domain) | `release.yml` |

```bash
az deployment group show -g rg-fc-web-prd-weu-001 -n main --query properties.outputs -o json
```

The federated credentials pin the OIDC subject, so:

- `id-fc-gh-main` works only for runs on `refs/heads/main` (not tags, other branches or jobs with an
  `environment:`, which change the subject to `repo:<oidc repo>:environment:<name>`).
- `id-fc-gh-pr` works only for `pull_request` runs. Pull requests from forks get no OIDC token, so
  `preview-swa.yml` skips them (`head.repo.full_name == github.repository`).

The repository secret `AZURE_STATIC_WEB_APPS_API_TOKEN` is no longer used; delete it if it exists. To rotate the
deployment token, reset it on the Static Web App and redeploy `main.bicep` (it writes `swa-deployment-token`).

## Deploy with the Azure Developer CLI

```bash
azd auth login
azd env new forever-crisis
azd env set AZURE_LOCATION westeurope
azd provision          # infra only
azd deploy             # optional: uploads app/dist from your machine
```

## Sign-in

`swa/staticwebapp.config.json` enables only the built-in GitHub and Microsoft (AAD) providers; Google and
Twitter return 404. `/api/saves` needs a signed-in user. No provider secrets are needed for the built-in ones.
