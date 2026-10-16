<#
  Download the decoders bundled with ffcx into extractor/tools (CI and fresh clones):
    vgmstream r2117 (CRI ACB/AWB/HCA) and FFmpeg 9.0.1 essentials (FLAC encode, MKV mux).
  Pinned versions: the extraction reference hashes in extractor/data/recipe.json were made with them.
#>
$ErrorActionPreference = 'Stop'
$tools = Join-Path (Split-Path $PSScriptRoot -Parent) 'extractor\tools'
New-Item -ItemType Directory -Force $tools | Out-Null
$tmp = Join-Path ([IO.Path]::GetTempPath()) "ffc-tools-$PID"
New-Item -ItemType Directory -Force $tmp | Out-Null

$vgm = Join-Path $tmp 'vgmstream.zip'
Invoke-WebRequest 'https://github.com/vgmstream/vgmstream/releases/download/r2117/vgmstream-win64.zip' -OutFile $vgm
if ((Get-FileHash $vgm -Algorithm SHA256).Hash -ne '6C4A8A3813864FEFED081BBD337DBC0AD93BF88E0B92F5DB98D7AB258B22DC6C') { throw 'vgmstream download hash mismatch' }
Expand-Archive $vgm -DestinationPath (Join-Path $tools 'vgmstream') -Force

$ff = Join-Path $tmp 'ffmpeg.zip'
Invoke-WebRequest 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.1/ffmpeg-9.0.1-essentials_build.zip' -OutFile $ff
Expand-Archive $ff -DestinationPath $tmp -Force
Copy-Item (Get-ChildItem $tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName (Join-Path $tools 'ffmpeg.exe') -Force
Copy-Item (Get-ChildItem $tmp -Recurse -Filter LICENSE | Select-Object -First 1).FullName (Join-Path (Split-Path $tools) 'LICENSES\ffmpeg.txt') -Force -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $tmp
Get-ChildItem $tools | Format-Table Name, Length
