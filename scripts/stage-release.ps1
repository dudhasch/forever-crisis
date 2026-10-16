<#
  Assemble the release files (what a GitHub Release holds) into one folder:

    install.ps1, release.json, ffcx-<v>-win64.zip, app-<v>.zip, pwsh-modules-<v>.zip, SHA256SUMS.txt

  Usage:  pwsh scripts/stage-release.ps1 -Out <folder> -Site https://<site> [-Mirror]
  -Site is the hosted site's URL (release.json tells the installer where it is; default: $env:SITE_URL).
  -Mirror also copies the PowerShell 7 zip next to them (offline tests: set FFC_PWSH_ZIP to it).
  The release workflow runs the same script on GitHub Actions (-Site from the SITE_URL variable).
#>
param(
    [string]$Out = 'release-out',
    [string]$Site = $env:SITE_URL,
    [switch]$Mirror,
    [string]$DataBase = $env:DATA_BASE_URL,
    [string]$DataPack = '',
    [switch]$VerifyData
)
$ErrorActionPreference = 'Stop'
if (-not $Site -or $Site -notmatch '^https?://') {
    throw "-Site is required: the site's URL, e.g. https://<name>.azurestaticapps.net (on GitHub Actions: the SITE_URL variable). Got '$Site'."
}
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$pwshVersion = '7.6.7'
$pwshUrl = "https://github.com/PowerShell/PowerShell/releases/download/v$pwshVersion/PowerShell-$pwshVersion-win-x64.zip"
$pwshSha = 'd2f952ebdbf24386cb8923553aa58e41a846db35a6155ea04c58142a4b16dbb7'

New-Item -ItemType Directory -Force $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$names = @{ extractor = "ffcx-$version-win64.zip"; app = "app-$version.zip"; modules = "pwsh-modules-$version.zip" }

# extractor (PyInstaller onedir) -> zip with a top-level ffcx\ folder
$dist = Join-Path $root 'build\dist\ffcx'
if (-not (Test-Path (Join-Path $dist 'ffcx.exe'))) { throw 'Build the extractor first (extractor\ffcx.spec).' }
Compress-Archive -Path $dist -DestinationPath (Join-Path $Out $names.extractor) -Force -CompressionLevel Optimal

# web app for local mode
$app = Join-Path $root 'app\dist'
if (-not (Test-Path (Join-Path $app 'index.html'))) { throw 'Build the app first (npm run build:app).' }
Compress-Archive -Path (Join-Path $app '*') -DestinationPath (Join-Path $Out $names.app) -Force

# PwshSpectreConsole (pinned) and the artwork for the installer UI
$mods = Join-Path ([IO.Path]::GetTempPath()) "ffc-modules-$PID"
New-Item -ItemType Directory -Force $mods | Out-Null
Save-PSResource -Name PwshSpectreConsole -Version '2.6.3' -Path $mods -TrustRepository
# the installer's own artwork (materia drawn by release-tools/make_installer_art.py; no game assets)
Copy-Item -Recurse (Join-Path $root 'installer\art') (Join-Path $mods 'ffc-art')
Compress-Archive -Path (Join-Path $mods '*') -DestinationPath (Join-Path $Out $names.modules) -Force
Remove-Item -Recurse -Force $mods

# data pack: pinned by extractor/data.lock.json, hosted outside the repository
$lock = Get-Content (Join-Path $root 'extractor\data.lock.json') -Raw | ConvertFrom-Json
$dataUrl = ''
if ($Mirror) {
    $local = if ($DataPack) { $DataPack } else { Join-Path $root "release-tools\out\$($lock.file)" }
    if (-not (Test-Path $local)) { throw "-Mirror needs the data pack ($local); build it with release-tools/pack_data.py." }
    if ((Get-FileHash $local -Algorithm SHA256).Hash.ToLower() -ne $lock.sha256) { throw "$local does not match extractor/data.lock.json." }
    Copy-Item $local (Join-Path $Out $lock.file) -Force
    $dataUrl = $lock.file  # relative: the installer resolves it against FFC_BASE
} else {
    $base = if ($DataBase) { $DataBase } else { $lock.base }
    if (-not $base) { throw 'No data pack location: set "base" in extractor/data.lock.json or the DATA_BASE_URL variable (docs/PUBLISHING.md).' }
    $dataUrl = "$($base.TrimEnd('/'))/$($lock.file)"
    if ($VerifyData) {
        $tmp = Join-Path ([IO.Path]::GetTempPath()) "ffc-data-$PID.zip"
        Invoke-WebRequest -Uri $dataUrl -OutFile $tmp -UseBasicParsing
        $got = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
        Remove-Item $tmp -Force
        if ($got -ne $lock.sha256) { throw "The data pack at $dataUrl has SHA-256 $got, extractor/data.lock.json pins $($lock.sha256)." }
    }
}

Copy-Item (Join-Path $root 'installer\install.ps1') (Join-Path $Out 'install.ps1') -Force
if ($Mirror) {
    $zip = Join-Path $Out "PowerShell-$pwshVersion-win-x64.zip"
    if (-not (Test-Path $zip)) { Invoke-WebRequest $pwshUrl -OutFile $zip }
}

$sha = @{}
foreach ($f in @($names.Values) + 'install.ps1') { $sha[$f] = (Get-FileHash (Join-Path $Out $f) -Algorithm SHA256).Hash }
$release = [ordered]@{
    version = $version
    site = $Site
    assets = $names
    sha256 = $sha
    data = [ordered]@{ file = $lock.file; url = $dataUrl; sha256 = $lock.sha256; size = $lock.size }
    pwsh = @{ version = $pwshVersion; url = $pwshUrl; sha256 = $pwshSha }
}
$release | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Out 'release.json') -Encoding UTF8
($sha.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Value.ToLower())  $($_.Name)" }) | Set-Content (Join-Path $Out 'SHA256SUMS.txt') -Encoding ASCII
Get-ChildItem $Out | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
