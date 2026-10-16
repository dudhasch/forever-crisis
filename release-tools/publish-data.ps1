<#
  Upload the data pack named in extractor/data.lock.json (built by pack_data.py) to the public blob container.
  The container is created by infra/main.bicep; its URL is the `dataBaseUrl` deployment output.

  Usage:  pwsh release-tools/publish-data.ps1 [-Account <storage account name>] [-File <pack zip>]
  -Account defaults to the account in $env:DATA_BASE_URL or in "base" of the lock file; -File defaults to
  release-tools/out/<lock file name>.
  Uses `az storage blob upload --auth-mode login`, so it needs an Azure sign-in that has "Storage Blob Data
  Contributor" on the data account: either your own `az login` (with that role) or GitHub Actions signed in as
  id-fc-gh-main with OIDC (.github/workflows/publish-data.yml). The blob name contains the pack's hash, so an
  upload never replaces a pack that an older release still points at; the script refuses to overwrite.
#>
param([string]$Account, [string]$Container = 'ffcx-data', [string]$File)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$lock = Get-Content ([IO.Path]::Combine($root, 'extractor', 'data.lock.json')) -Raw | ConvertFrom-Json
if (-not $Account) {
    $base = if ($env:DATA_BASE_URL) { $env:DATA_BASE_URL } else { $lock.base }
    if ($base -match '^https://([a-z0-9]{3,24})\.blob\.core\.windows\.net/') { $Account = $Matches[1] }
    else { throw 'Pass -Account, or set DATA_BASE_URL / "base" in extractor/data.lock.json to the container URL.' }
}
if (-not $File) { $File = [IO.Path]::Combine($root, 'release-tools', 'out', $lock.file) }
if (-not (Test-Path -LiteralPath $File)) { throw "Build the pack first: python release-tools/pack_data.py ($File is missing)." }
$sha = (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLower()
if ($sha -ne $lock.sha256) { throw "$File does not match extractor/data.lock.json (run pack_data.py again)." }
az storage blob upload --account-name $Account --container-name $Container --name $lock.file --file $File `
    --auth-mode login --content-type application/zip --overwrite false --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Upload failed (a blob with this name may already exist, which is fine: it has the same hash).' }
$url = "https://$Account.blob.core.windows.net/$Container/$($lock.file)"
Write-Host "Uploaded: $url"
Write-Host "Set `"base`" in extractor/data.lock.json to https://$Account.blob.core.windows.net/$Container if it is still empty."
