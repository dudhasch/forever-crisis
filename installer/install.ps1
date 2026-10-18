<#
  FF7 Forever Crisis - installer
  -------------------------------
  irm https://github.com/dudhasch/forever-crisis/releases/latest/download/install.ps1 | iex

  Finds FINAL FANTASY VII EVER CRISIS in your Steam libraries, extracts the files the explorer needs from YOUR
  copy into C:\Games\FF7-Forever-Crisis, and (optionally) sets up local mode. Nothing from the game is
  downloaded; the only extra download is the extractor's data pack (a recipe of ids, offsets and hashes, with no text, models, textures or audio),
  checked against the SHA-256 that release.json carries. Run it again to update, repair or uninstall.

  Environment overrides (testing / advanced):
    FFC_BASE          where release files come from (default: the latest GitHub release)
    FFC_INSTALL_DIR   install folder (default C:\Games\FF7-Forever-Crisis)
    FFC_GAME_DIR      skip the search and use this game folder
    FFC_PWSH_ZIP      PowerShell 7 portable zip URL (default: from release.json)
    FFC_FORCE_PORTABLE_PWSH=1   use the portable PowerShell even if pwsh 7 is installed
    FFC_UNATTENDED=1  no questions (defaults everywhere; for tests)
    FFC_KEEP_FILES=1  uninstall keeps the extracted files (default answer "no" to deleting them)

  This file must stay parseable by Windows PowerShell 5.1 (irm | iex runs there first).
#>
param([switch]$Relaunched, [switch]$Uninstall, [string]$Action = '')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$DefaultBase = 'https://github.com/dudhasch/forever-crisis/releases/latest/download'
$Base = if ($env:FFC_BASE) { $env:FFC_BASE.TrimEnd('/') } else { $DefaultBase }
$InstallDir = if ($env:FFC_INSTALL_DIR) { $env:FFC_INSTALL_DIR } else { 'C:\Games\FF7-Forever-Crisis' }
$Runtime = Join-Path $InstallDir 'runtime'
$LogDir = Join-Path $InstallDir 'logs'
$Unattended = $env:FFC_UNATTENDED -eq '1'
$AppName = 'FF7 Forever Crisis'

New-Item -ItemType Directory -Force -Path $Runtime, $LogDir | Out-Null
$LogFile = Join-Path $LogDir ('install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
function Log([string]$m) { Add-Content -LiteralPath $LogFile -Value ((Get-Date -Format 'HH:mm:ss ') + $m) -Encoding UTF8 }
Log "installer start; PowerShell $($PSVersionTable.PSVersion); base $Base; dir $InstallDir; relaunched=$Relaunched"

function Get-Release {
    $json = Invoke-RestMethod -Uri "$Base/release.json" -UseBasicParsing
    Log ("release " + ($json | ConvertTo-Json -Compress -Depth 5))
    return $json
}

# .NET instead of Get-FileHash / Expand-Archive: they live in modules that a broken PSModulePath can hide.
function Get-Sha256([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $fs = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($sha.ComputeHash($fs))).Replace('-', '') } finally { $fs.Dispose(); $sha.Dispose() }
}

function Expand-Zip([string]$Zip, [string]$Dest) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }
    $z = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        $root = [IO.Path]::GetFullPath($Dest)
        foreach ($e in $z.Entries) {
            $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $e.FullName))
            if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw "Bad path in $Zip" }
            if ($e.Name -eq '') { New-Item -ItemType Directory -Force -Path $target | Out-Null; continue }  # folder entry
            New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($target)) | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
        }
    } finally { $z.Dispose() }
}

function Save-File([string]$Url, [string]$Dest, [string]$Sha256) {
    Log "download $Url -> $Dest"
    $tmp = "$Dest.partial"
    Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
    if ($Sha256) {
        $h = Get-Sha256 $tmp
        if ($h -ne $Sha256.ToUpper()) { Remove-Item -LiteralPath $tmp -Force; throw "Download check failed for $(Split-Path $Url -Leaf)." }
    }
    Move-Item -LiteralPath $tmp -Destination $Dest -Force
}

# ------------------------------------------------------------------------------------------------------------
# Stage 1 (any PowerShell): make sure PowerShell 7 + PwshSpectreConsole are there, then relaunch.
# ------------------------------------------------------------------------------------------------------------
try { $Host.UI.RawUI.WindowTitle = "$AppName installer" } catch { }
if (-not $Relaunched) {
    Write-Host ''
    Write-Host "  $AppName" -ForegroundColor Yellow
    Write-Host '  Getting the installer ready...' -ForegroundColor Gray
    try {
        $release = Get-Release
        $pwsh = $null
        if ($env:FFC_FORCE_PORTABLE_PWSH -ne '1') {
            $sys = Get-Command pwsh -ErrorAction SilentlyContinue
            if ($sys -and ([version](& $sys.Source -NoProfile -Command '$PSVersionTable.PSVersion.ToString()')) -ge [version]'7.2') { $pwsh = $sys.Source }
        }
        if (-not $pwsh) {
            $pwsh = Join-Path $Runtime 'pwsh\pwsh.exe'
            if (-not (Test-Path $pwsh)) {
                Write-Host '  One-time download: PowerShell 7 (portable, about 110 MB, nothing is installed system-wide)...' -ForegroundColor Gray
                $zipUrl = if ($env:FFC_PWSH_ZIP) { $env:FFC_PWSH_ZIP } else { $release.pwsh.url }
                $zip = Join-Path $Runtime 'pwsh.zip'
                Save-File $zipUrl $zip $(if ($env:FFC_PWSH_ZIP) { '' } else { $release.pwsh.sha256 })
                Expand-Zip $zip (Join-Path $Runtime 'pwsh')
                Remove-Item -LiteralPath $zip -Force
            }
        }
        $modules = Join-Path $Runtime 'modules'
        if (-not (Test-Path (Join-Path $modules 'PwshSpectreConsole')) -or -not (Test-Path (Join-Path $modules 'ffc-art\materia-green.gif'))) {
            $zip = Join-Path $Runtime 'modules.zip'
            Save-File "$Base/$($release.assets.modules)" $zip $release.sha256.($release.assets.modules)
            Expand-Zip $zip $modules
            Remove-Item -LiteralPath $zip -Force
        }
        $self = Join-Path $Runtime 'install.ps1'
        Save-File "$Base/install.ps1" $self $release.sha256.'install.ps1'
        Log "relaunch in $pwsh"
        $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $self, '-Relaunched')
        if ($Uninstall) { $argList += '-Uninstall' }
        if ($Action) { $argList += @('-Action', $Action) }
        & $pwsh @argList
        return  # not exit: under irm | iex that would close the player's own PowerShell window
    } catch {
        Log ("bootstrap failed: " + $_.Exception.ToString())
        Write-Host ''
        Write-Host '  Sorry, the installer could not get ready:' -ForegroundColor Red
        Write-Host ('  ' + $_.Exception.Message) -ForegroundColor Red
        Write-Host "  Details: $LogFile" -ForegroundColor Gray
        return
    }
}

# ------------------------------------------------------------------------------------------------------------
# Stage 2 (PowerShell 7 + PwshSpectreConsole)
# ------------------------------------------------------------------------------------------------------------
$env:PSModulePath = (Join-Path $Runtime 'modules') + [IO.Path]::PathSeparator + $env:PSModulePath
[Console]::OutputEncoding = [Text.Encoding]::UTF8  # before Spectre loads, so it detects Unicode
Import-Module PwshSpectreConsole -ErrorAction Stop
if ($Host.UI.SupportsVirtualTerminal) {
    # classic console windows (conhost) are VT-capable under PowerShell 7 but Spectre's detection can miss it
    $caps = [Spectre.Console.AnsiConsole]::Profile.Capabilities
    $caps.Ansi = $true; $caps.Unicode = $true; $caps.ColorSystem = [Spectre.Console.ColorSystem]::TrueColor
}
# Console apps we start can leave VT processing off in a classic console; switch it back on before drawing.
Add-Type -Namespace FFC -Name Con -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int h);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(System.IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(System.IntPtr h, uint m);
'@
function Enable-VT {
    $h = [FFC.Con]::GetStdHandle(-11); $m = 0
    if ([FFC.Con]::GetConsoleMode($h, [ref]$m)) { [FFC.Con]::SetConsoleMode($h, $m -bor 0x4) | Out-Null }
}
Enable-VT
$Accent = '#e8c26a'      # gold
$Mako = '#3ce68c'
$Dim = 'grey42'
$Steps = @('Find the game', 'Extract', 'Install', 'Done')
$StepMateria = @('green', 'blue', 'yellow', 'red')
$Tools = Join-Path $InstallDir 'tools'
$Ffcx = Join-Path $Tools 'ffcx\ffcx.exe'
$State = Join-Path $InstallDir 'install.json'
$Port = 17777
$ArtDir = Join-Path $Runtime 'modules\ffc-art'          # original artwork shipped with the installer
$GameArt = Join-Path $InstallDir '.ffcx\art'           # pictures from the player's own game (ffcx art)
# everything the installer and the extractor create in the install folder: uninstall deletes only these
# (runtime\ and logs\ last, after the installer's own PowerShell has exited)
$Created = @('arc', 'lib', 'gen', 'brand', 'app', 'tools', '.ffcx', 'ffcx-manifest.json', 'install.json')
$Recap = New-Object System.Collections.Generic.List[string]

# This file stays ASCII (Windows PowerShell 5.1 reads it first): special characters come from code points.
$Ch = @{
    check = [string][char]0x2713; cross = [string][char]0x2717; dot = [string][char]0x00B7; bar = [string][char]0x2501
    arrow = [string][char]0x203A; ell = [string][char]0x2026; mid = [string][char]0x2022
    spin = @(0x280B, 0x2819, 0x2839, 0x2838, 0x283C, 0x2834, 0x2826, 0x2827, 0x2807, 0x280F | ForEach-Object { [string][char]$_ })
}
# $Live: the terminal can redraw in place (animations, live progress). Questions are asked unless FFC_UNATTENDED.
$Live = [Spectre.Console.AnsiConsole]::Profile.Capabilities.Interactive

function Esc([string]$s) { if (-not $s) { return '' }; Get-SpectreEscapedText $s }
function M([string]$markup) { [Spectre.Console.Markup]::new($markup) }
function Show($renderable) { Enable-VT; [Spectre.Console.AnsiConsole]::Write($renderable) }
function Say([string]$markup) { Enable-VT; Write-SpectreHost $markup }
function Width { [Spectre.Console.AnsiConsole]::Profile.Width }
function Height { [Spectre.Console.AnsiConsole]::Profile.Height }

# Images: Sixel (real pixels) in terminals that support it, colored half blocks elsewhere; never fatal.
function Img([string]$path, [int]$width, [switch]$Animate) {
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { return $null }
    try {
        if ($Animate) { return Get-SpectreImage -ImagePath $path -MaxWidth $width -Animation }
        return Get-SpectreImage -ImagePath $path -MaxWidth $width
    } catch { Log "image $path : $($_.Exception.Message)"; return $null }
}
function Materia([string]$color, [int]$width = 6, [switch]$Animate) {
    $ext = if ($Animate) { 'gif' } else { 'png' }
    return Img (Join-Path $ArtDir "materia-$color.$ext") $width -Animate:$Animate
}
# Real pixels? (Windows Terminal 1.22+ and other Sixel terminals; classic consoles get colored blocks.)
$Sixel = $false
try { $Sixel = (Get-SpectreImage -ImagePath (Join-Path $ArtDir 'materia-green.png') -MaxWidth 2) -is [PwshSpectreConsole.PixelImage] } catch { }
function Get-GameArt([string]$kind) {
    if (-not (Test-Path -LiteralPath $GameArt)) { return @() }
    return @(Get-ChildItem -LiteralPath $GameArt -Filter "$kind-*" | Sort-Object Name | ForEach-Object { $_.FullName })
}

# In-place drawing: render to an ANSI string and write it at a screen position. A Sixel picture is drawn by writing
# only its pixel data at the spot; nothing else is rewritten, so pictures and animations do not flicker.
$E = [string][char]27
function ConvertTo-Ansi($renderable, [int]$width) {
    $sw = New-Object IO.StringWriter
    $set = New-Object Spectre.Console.AnsiConsoleSettings
    $set.Ansi = [Spectre.Console.AnsiSupport]::Yes
    $set.ColorSystem = [Spectre.Console.ColorSystemSupport]::TrueColor
    $set.Out = New-Object Spectre.Console.AnsiConsoleOutput $sw
    $c = [Spectre.Console.AnsiConsole]::Create($set)
    $c.Profile.Width = [Math]::Max(10, $width)
    $c.Profile.Capabilities.Unicode = $true
    $c.Write($renderable)
    return $sw.ToString()
}
function Write-Region([int]$x, [int]$y, [int]$width, $renderable, [switch]$Pad, [int]$MaxRows = 0) {
    $lines = (ConvertTo-Ansi $renderable $width).TrimEnd("`r", "`n") -split "`r?`n"
    $n = [Math]::Min($lines.Count, (Height) - 1 - $y)                # never below the window (the cursor cannot go there)
    if ($MaxRows -gt 0) { $n = [Math]::Min($n, $MaxRows) }
    for ($i = 0; $i -lt $n; $i++) {
        [Console]::SetCursorPosition($x, $y + $i)
        if ($Pad) {
            $visible = ($lines[$i] -replace "$E\[[0-9;]*m", '').Length
            [Console]::Write($lines[$i] + (' ' * [Math]::Max(0, $width - $visible)))
        } else { [Console]::Write($lines[$i] + "$E[K") }  # and clear the rest of the line
    }
}
function Get-Rows($renderable) { ((ConvertTo-Ansi $renderable 400).TrimEnd("`r", "`n") -split "`n").Count }
function Write-Sixel([int]$x, [int]$y, $image) {
    $m = [regex]::Match((ConvertTo-Ansi $image 400), "(?s)${E}P.*?${E}\\")  # just the pixel data, no blank cells
    if ($m.Success) { [Console]::SetCursorPosition($x, $y); [Console]::Write($m.Value) }
}

function Get-SixelFrames($image, [int]$count = 24) {
    $frames = New-Object System.Collections.Generic.List[string]
    for ($i = 0; $i -lt $count; $i++) {
        $ansi = ConvertTo-Ansi $image 400
        $m = [regex]::Match($ansi, "(?s)${E}P.*?${E}\\")
        if ($m.Success) { [void]$frames.Add($m.Value) }
    }
    return @($frames)
}

$script:ActiveAnimation = $null

function Start-MateriaAnimation($items, [int]$intervalMs = 45) {
    if (-not ($Live -and $Sixel) -or $Unattended) { return }
    Stop-MateriaAnimation
    if (-not $items -or -not $items.Count) { return }

    $sync = [hashtable]::Synchronized(@{ Stop = $false })
    $rs = [runspacefactory]::CreateRunspace()
    $rs.Open()
    $ps = [powershell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript({
        param($sync, $animItems, [int]$interval)
        $f = 0
        while (-not $sync.Stop) {
            try {
                $curX = [Console]::CursorLeft
                $curY = [Console]::CursorTop
                foreach ($it in $animItems) {
                    if ($it.frames.Count -gt 0) {
                        [Console]::SetCursorPosition($it.x, $it.y)
                        [Console]::Write($it.frames[$f % $it.frames.Count])
                    }
                }
                [Console]::SetCursorPosition($curX, $curY)
            } catch { }
            $f++
            Start-Sleep -Milliseconds $interval
        }
    }).AddArgument($sync).AddArgument($items).AddArgument($intervalMs)

    $handle = $ps.BeginInvoke()
    $script:ActiveAnimation = @{
        Sync = $sync
        PowerShell = $ps
        Runspace = $rs
        Handle = $handle
    }
}

function Stop-MateriaAnimation {
    if ($script:ActiveAnimation) {
        try {
            $script:ActiveAnimation.Sync.Stop = $true
            if ($script:ActiveAnimation.Handle) {
                [void]$script:ActiveAnimation.Handle.AsyncWaitHandle.WaitOne(500)
            }
            $script:ActiveAnimation.PowerShell.Dispose()
            $script:ActiveAnimation.Runspace.Dispose()
        } catch { }
        $script:ActiveAnimation = $null
    }
}


function Hex([int[]]$c) { '#{0:x2}{1:x2}{2:x2}' -f $c[0], $c[1], $c[2] }
function Blend([int[]]$a, [int[]]$b, [double]$t) { @(0, 1, 2 | ForEach-Object { [int]($a[$_] + ($b[$_] - $a[$_]) * $t) }) }

# The title in big letters, colored from gold to mako green (FIGlet text drawn to a string, then painted).
function Get-TitleArt([string]$text) {
    $sw = New-Object IO.StringWriter
    $set = New-Object Spectre.Console.AnsiConsoleSettings
    $set.Ansi = [Spectre.Console.AnsiSupport]::No
    $set.ColorSystem = [Spectre.Console.ColorSystemSupport]::NoColors
    $set.Out = New-Object Spectre.Console.AnsiConsoleOutput $sw
    $c = [Spectre.Console.AnsiConsole]::Create($set)
    $c.Profile.Width = 200
    $c.Write((New-Object Spectre.Console.FigletText $text))
    $lines = @($sw.ToString() -split "`r?`n" | Where-Object { $_.Trim() })
    $w = ($lines | Measure-Object Length -Maximum).Maximum
    $from = @(232, 194, 106); $to = @(60, 230, 140)
    $out = foreach ($line in $lines) {
        $sb = New-Object Text.StringBuilder
        for ($i = 0; $i -lt $line.Length; $i += 3) {
            $seg = $line.Substring($i, [Math]::Min(3, $line.Length - $i))
            if (-not $seg.Trim()) { [void]$sb.Append($seg); continue }
            [void]$sb.Append("[bold $(Hex (Blend $from $to ($i / [Math]::Max(1, $w))))]$(Esc $seg)[/]")
        }
        $sb.ToString()
    }
    return M ($out -join "`n")
}

function Clear-Screen { try { Clear-Host } catch { } }

function Show-Header([int]$n, [switch]$NoClear, [switch]$NoRecap) {
    if (-not $NoClear) { Stop-MateriaAnimation; Clear-Screen }
    $chips = for ($i = 0; $i -lt $Steps.Count; $i++) {
        if ($i -lt $n - 1) { "[$Mako]$($Ch.check) $($Steps[$i])[/]" }
        elseif ($i -eq $n - 1) { "[black on $Accent] $($i + 1) $($Steps[$i]) [/]" }
        else { "[$Dim]$($i + 1) $($Steps[$i])[/]" }
    }
    $title = M ("[bold $Accent]FF7 FOREVER CRISIS[/]  [$Dim]installer[/]`n" + ($chips -join "  [$Dim]$($Ch.arrow)[/]  "))
    $orb = if ($n -ge 1) { Materia $StepMateria[$n - 1] 5 } else { $null }
    if ($orb) { Show (Format-SpectreColumns -Data @($orb, $title)) } else { Show $title; Write-Host '' }
    Show (Write-SpectreRule -LineColor Grey23 -PassThru)
    if ($NoRecap) { return }
    foreach ($r in $Recap) { Say $r }
    if ($Recap.Count) { Write-Host '' }
}
function Ask([string]$question, [string[]]$choices) {
    if ($Unattended) { return $choices[0] }
    return Read-SpectreSelection -Message "[bold]$question[/]" -Choices $choices -Color $Accent
}
function Confirm([string]$question, [bool]$default = $true) {
    if ($Unattended) { return $default }
    return Read-SpectreConfirm -Message $question -DefaultAnswer $(if ($default) { 'y' } else { 'n' }) -Color $Accent
}
function Fail([string]$message) {
    Stop-MateriaAnimation
    Log "FAIL $message"
    Write-Host ''
    $text = M ("[white]$(Esc $message)[/]`n`n[$Dim]Details are in[/] [grey]$(Esc $LogFile)[/]")
    $orb = Materia 'red' 6
    $body = if ($orb) { Format-SpectreColumns -Data @($orb, $text) } else { $text }
    Show (Format-SpectrePanel -Data $body -Header '[bold red] Something went wrong [/]' -Border Rounded -Color Red)
    if (-not $Unattended) { Read-SpectrePause -Message "[$Dim]Press any key to close[/]" -AnyKey | Out-Null }
    exit 1
}
function Read-State { if (Test-Path $State) { Get-Content -LiteralPath $State -Raw | ConvertFrom-Json } else { $null } }
function Get-Size([long]$b) { if ($b -ge 1GB) { '{0:N1} GB' -f ($b / 1GB) } else { '{0:N0} MB' -f ($b / 1MB) } }
function Get-Clock([double]$s) { $t = [TimeSpan]::FromSeconds([Math]::Max(0.0, $s)); if ($t.TotalHours -ge 1) { $t.ToString('h\:mm\:ss') } else { $t.ToString('m\:ss') } }
function Get-Bar([double]$f, [int]$w, [string]$color) {
    $f = [Math]::Min(1.0, [Math]::Max(0.0, $f)); $n = [int][Math]::Floor($f * $w)
    "[$color]$($Ch.bar * $n)[/][grey19]$($Ch.bar * ($w - $n))[/]"
}

# Opening screen: the title next to a spinning materia (animated infinitely where Sixel is available).
function Show-Banner {
    Clear-Screen
    $sub = M ("[$Dim]A fan-made explorer for[/] [white]FINAL FANTASY VII EVER CRISIS[/][$Dim]. It walks you through the game's world,[/]`n" +
        "[$Dim]story and battles, built from the files of[/] [white]your own[/] [$Dim]Steam copy.[/]")
    $title = if ((Width) -ge 80) { Get-TitleArt 'Forever Crisis' } else { M "[bold $Accent]FF7 FOREVER CRISIS[/]" }
    $text = Format-SpectreRows -Data @($title, $sub)
    $orb = Materia 'green' 14 -Animate:$Live
    if (-not $orb -or (Width) -lt 100) { Show $text; Write-Host ''; return }
    if (-not ($Live -and $Sixel)) { Show (Format-SpectreColumns -Data @($orb, $text)); return }
    $y = [Console]::CursorTop
    Show (Format-SpectreColumns -Data @($orb, $text))
    $end = [Console]::CursorTop
    [Console]::SetCursorPosition(0, $end)
    $frames = Get-SixelFrames $orb 24
    if ($frames.Count) {
        Start-MateriaAnimation @(@{ x = 0; y = $y; frames = $frames }) 45
    }
}

function Install-Tools($release) {
    $ver = $release.sha256.($release.assets.extractor)  # the exact build, so a repair also fixes a changed binary
    $marker = Join-Path $Tools "ffcx\.version"
    if ((Test-Path $Ffcx) -and (Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $ver)) { return }
    Invoke-SpectreCommandWithStatus -Spinner Dots -Color $Accent -Title 'Downloading the extractor...' -ScriptBlock {
        $zip = Join-Path $Runtime 'ffcx.zip'
        Save-File "$Base/$($release.assets.extractor)" $zip $release.sha256.($release.assets.extractor)
        if (Test-Path (Join-Path $Tools 'ffcx')) { Remove-Item -Recurse -Force (Join-Path $Tools 'ffcx') }
        Expand-Zip $zip $Tools
        Remove-Item -LiteralPath $zip -Force
        Set-Content -LiteralPath $marker -Value $ver
    } | Out-Null
}

# The data pack (a recipe of ids, offsets and hashes, with no text, models, textures or audio) is not in the repository or the release:
# release.json names a file on a separate host and pins its SHA-256 (from extractor/data.lock.json). A relative url
# (test mirrors) is resolved against $Base. The folder is named by the hash, so a changed pack is fetched again.
$DataNeeded = @('recipe.json', 'templates.json.gz', 'text-bundles.json')
function Get-DataDir($release) { Join-Path $Tools ('data\' + $release.data.sha256.Substring(0, 12)) }
function Install-Data($release) {
    if (-not $release.data -or -not $release.data.sha256) { throw 'This release has no data pack (release.json is incomplete).' }
    $dir = Get-DataDir $release
    $have = $true; foreach ($n in $DataNeeded) { if (-not (Test-Path -LiteralPath (Join-Path $dir $n))) { $have = $false } }
    if ($have) { return }
    $url = [string]$release.data.url
    if ($url -notmatch '^https?://') { $url = "$Base/$url" }
    Invoke-SpectreCommandWithStatus -Spinner Dots -Color $Accent -Title 'Downloading the extraction recipe...' -ScriptBlock {
        $zip = Join-Path $Runtime 'data.zip'
        Save-File $url $zip $release.data.sha256
        if (Test-Path -LiteralPath $dir) { Remove-Item -Recurse -Force -LiteralPath $dir }
        Expand-Zip $zip $dir
        Remove-Item -LiteralPath $zip -Force
    } | Out-Null
    foreach ($n in $DataNeeded) { if (-not (Test-Path -LiteralPath (Join-Path $dir $n))) { throw "The data pack is incomplete ($n is missing)." } }
    # older packs are no longer needed
    $keep = Split-Path $dir -Leaf
    Get-ChildItem -LiteralPath (Join-Path $Tools 'data') -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $keep } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

function Invoke-Ffcx([string[]]$arguments) {
    $out = & $Ffcx @arguments
    Enable-VT
    return ($out -join "`n")
}

# A quick look into the game (a few seconds): its story logos and some key art for the screens that follow.
function Get-Art([string]$game) {
    if ((Get-GameArt 'scene').Count -ge 3 -and (Test-Path -LiteralPath (Join-Path $GameArt 'hero.png'))) { return }
    try {
        Invoke-SpectreCommandWithStatus -Spinner Dots -Color $Accent -Title 'Taking a first look at your game...' -ScriptBlock {
            $r = & $Ffcx art --game $game --out $InstallDir 2>&1
            Log ("art " + ($r -join ' '))
        } | Out-Null
    } catch { Log "art failed: $($_.Exception.Message)" }
    Enable-VT
}

$StoryNames = [ordered]@{
    'logo-01' = 'FINAL FANTASY VII'
    'logo-02' = 'CRISIS CORE FINAL FANTASY VII'
    'logo-03' = 'FINAL FANTASY VII THE FIRST SOLDIER'
    'logo-04' = 'FINAL FANTASY VII THE FIRST SOLDIER EPISODE II'
    'logo-05' = 'FINAL FANTASY VII ADVENT CHILDREN EC EDITION'
    'logo-06' = 'DIRGE of CERBERUS FINAL FANTASY VII EC EDITION'
    'logo-07' = 'BEFORE CRISIS FINAL FANTASY VII EC EDITION'
}

function Select-Stories([string[]]$stories) {
    if ($Unattended -or -not $Live -or $stories.Count -le 1) { return $stories }
    Write-Host ''
    $p = [Spectre.Console.MultiSelectionPrompt[string]]::new()
    $p.Title = '[bold]Which stories would you like to extract/install?[/]'
    $p.PageSize = [Math]::Max(5, $stories.Count)
    $p.WrapAround = $true
    $p.Required = $true
    $p.HighlightStyle = [Spectre.Console.Style]::new([Spectre.Console.Color]::FromHex($Accent))
    $p.InstructionsText = "[$Dim](Press [white]space[/] to toggle, [white]enter[/] to confirm)[/]"
    foreach ($s in $stories) {
        $node = $p.AddChoice($s)
        $node.Select()
    }
    Enable-VT
    $selected = [Spectre.Console.AnsiConsole]::Prompt($p)
    return @($selected)
}

function Show-Found([string]$game) {
    $Recap.Add("[$Mako]$($Ch.check)[/] Game: [white]$(Esc $game)[/]")
    Say "[$Mako]$($Ch.check)[/] Found the game in [white]$(Esc $game)[/]"
    Get-Art $game
    $logos = Get-GameArt 'logo'
    if ($logos.Count -and $Sixel) {
        $w = [Math]::Max(16, [Math]::Min(26, [int](((Width) - 8) / 4) - 2))
        $cells = foreach ($p in $logos) { Img $p $w }
        $cells = @($cells | Where-Object { $_ })
        if ($cells.Count) {
            Write-Host ''
            $gallery = Format-SpectreColumns -Data $cells
            Show (Format-SpectrePanel -Data $gallery -Header "[$Accent] The stories in your copy of the game [/]" -Border Rounded -Color Grey30 -Expand)
        }
    }
    $foundStories = @()
    foreach ($p in $logos) {
        $key = [IO.Path]::GetFileNameWithoutExtension($p)
        if ($StoryNames.Contains($key)) {
            $foundStories += $StoryNames[$key]
        } else {
            $foundStories += $key
        }
    }
    if ($foundStories.Count -gt 1) {
        $script:SelectedStories = Select-Stories $foundStories
        $Recap.Add("[$Mako]$($Ch.check)[/] Stories: [white]$(($script:SelectedStories) -join ', ')[/]")
        Say "[$Mako]$($Ch.check)[/] Selected [white]$($script:SelectedStories.Count)[/] of [white]$($foundStories.Count)[/] stories"
    } elseif ($foundStories.Count -eq 1) {
        $script:SelectedStories = $foundStories
        $Recap.Add("[$Mako]$($Ch.check)[/] Story: [white]$($foundStories[0])[/]")
    } else {
        $script:SelectedStories = @()
    }
}

function Find-Game {
    Show-Header 1
    if ($env:FFC_GAME_DIR) {
        $v = Invoke-Ffcx @('validate', $env:FFC_GAME_DIR) | ConvertFrom-Json
        if ($v.ok) { $script:GameDir = $v.path; Show-Found $v.path; return }
        Fail "FFC_GAME_DIR is not a usable game folder: $($v.reason)"
    }
    $script:Located = $null
    Invoke-SpectreCommandWithStatus -Spinner Dots -Color $Accent -Title 'Looking for FINAL FANTASY VII EVER CRISIS in your Steam libraries...' -ScriptBlock {
        $script:Located = (& $Ffcx locate) -join "`n"
    } | Out-Null
    Enable-VT
    $found = $script:Located | ConvertFrom-Json
    Log ("locate " + ($found | ConvertTo-Json -Compress -Depth 5))
    $ok = @($found.candidates | Where-Object { $_.ok })
    if ($ok.Count -ge 1) {
        $game = $ok[0].path
        if ($ok.Count -gt 1) { $game = Ask 'The game is in more than one place. Which one?' @($ok | ForEach-Object { $_.path }) }
        $script:GameDir = $game
        Show-Found $game
        return
    }
    $why = if ($found.candidates.Count) { $found.candidates[0].reason } else { 'It is not in any of your Steam library folders.' }
    $text = M ("[white]$(Esc $why)[/]`n`n" +
        "Forever Crisis needs the PC (Steam) version of FINAL FANTASY VII EVER CRISIS, [white]installed and with its game data downloaded[/] " +
        "(while the game was online, it downloaded about 50 GB the first time it started). The game files stay where they are; nothing is changed.`n`n" +
        "[$Dim]Steam libraries searched: $(Esc (($found.libraries) -join ', '))[/]")
    $orb = Materia 'yellow' 6
    Show (Format-SpectrePanel -Header '[bold yellow] Game not found [/]' -Border Rounded -Color Yellow -Data $(if ($orb) { Format-SpectreColumns -Data @($orb, $text) } else { $text }))
    if ($Unattended) { Fail 'Game not found.' }
    while ($true) {
        $c = Ask 'What would you like to do?' @('Choose the game folder myself', 'Cancel')
        if ($c -eq 'Cancel') { exit 1 }
        $path = Select-Folder
        if (-not $path) { continue }
        $v = Invoke-Ffcx @('validate', $path) | ConvertFrom-Json
        if ($v.ok) { $script:GameDir = $path; Show-Found $path; return }
        Say "[yellow]That folder doesn't work:[/] $(Esc $v.reason) [$Dim](Pick the folder that contains FF7EC.exe, usually ...\steamapps\common\FF7EC)[/]"
    }
}

function Select-Folder {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $d = New-Object System.Windows.Forms.FolderBrowserDialog
        $d.Description = 'Select the FINAL FANTASY VII EVER CRISIS folder (it contains FF7EC.exe)'
        $d.UseDescriptionForTitle = $true
        if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $d.SelectedPath }
        return $null
    } catch {
        return Read-SpectreText -Message 'Paste the game folder path' -AllowEmpty
    }
}

function Select-InstallFolder {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $d = New-Object System.Windows.Forms.FolderBrowserDialog
        $d.Description = 'Select the folder to install FF7 Forever Crisis into'
        $d.UseDescriptionForTitle = $true
        if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { return $d.SelectedPath }
        return $null
    } catch {
        return Read-SpectreText -Message 'Paste the install folder path' -AllowEmpty
    }
}

function Request-InstallDir {
    while ($true) {
        $c = Ask 'Where would you like to install the game?' @('Enter path', 'Browse for folder...', 'Cancel')
        if ($c -eq 'Cancel') { return $null }
        $path = $null
        if ($c -eq 'Browse for folder...') {
            $path = Select-InstallFolder
        } else {
            $entered = Read-SpectreText -Message 'Enter install folder path' -DefaultAnswer $script:InstallDir
            if (-not [string]::IsNullOrWhiteSpace($entered)) {
                $path = $entered.Trim()
            }
        }
        if (-not $path) { continue }
        try {
            $fullPath = [System.IO.Path]::GetFullPath($path.Trim('"', "'", ' '))
            return $fullPath
        } catch {
            Say "[yellow]Invalid path:[/] $(Esc $_.Exception.Message)"
        }
    }
}

function Set-InstallDir([string]$newPath) {
    $oldInstallDir = $script:InstallDir
    $oldRuntime = $script:Runtime
    $oldLogDir = $script:LogDir

    $script:InstallDir = $newPath
    $script:Runtime = Join-Path $script:InstallDir 'runtime'
    $script:LogDir = Join-Path $script:InstallDir 'logs'
    $script:Tools = Join-Path $script:InstallDir 'tools'
    $script:Ffcx = Join-Path $script:Tools 'ffcx\ffcx.exe'
    $script:State = Join-Path $script:InstallDir 'install.json'
    $script:GameArt = Join-Path $script:InstallDir '.ffcx\art'

    New-Item -ItemType Directory -Force -Path $script:InstallDir, $script:Runtime, $script:LogDir | Out-Null

    if ($oldRuntime -ne $script:Runtime -and (Test-Path $oldRuntime)) {
        Copy-Item -Path (Join-Path $oldRuntime '*') -Destination $script:Runtime -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($oldLogDir -ne $script:LogDir -and (Test-Path $oldLogDir)) {
        Copy-Item -Path (Join-Path $oldLogDir '*') -Destination $script:LogDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    $newModules = Join-Path $script:Runtime 'modules'
    if (Test-Path $newModules) {
        $env:PSModulePath = $newModules + [IO.Path]::PathSeparator + $env:PSModulePath
        $script:ArtDir = Join-Path $newModules 'ffc-art'
    }
    $script:LogFile = Join-Path $script:LogDir ('install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    Log "install dir changed from $oldInstallDir to $script:InstallDir"

    if ($oldInstallDir -ne $script:InstallDir -and (Test-Path $oldInstallDir)) {
        Remove-Item -LiteralPath (Join-Path $oldInstallDir 'runtime') -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $oldInstallDir 'logs') -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $oldInstallDir -Force -ErrorAction SilentlyContinue
    }
}

$PhaseNames = [ordered]@{
    catalog = 'Reading the game catalog'; index = 'Indexing game files'; decode = 'Unpacking game data'; models = 'Building 3D models'
    textures = 'Exporting textures'; weapons = 'Building weapons'; sky = 'Exporting skies'; music = 'Converting music'
    sounds = 'Converting sound effects'; movies = 'Converting movies'; animations = 'Preparing animations'
    effects = 'Building battle effects'; lighting = 'Reading stage lighting'; text = 'Preparing story text'; brand = 'Drawing the logo and icons'; verify = 'Checking files'
}
# Seconds each phase took on the reference PC (24 cores, NVMe): the overall bar and the time left are weighted by
# these, scaled by how fast this PC turns out to be. Animations and effects are long steps without progress of their own.
$PhaseSeconds = @{ catalog = 20; index = 35; decode = 125; models = 100; textures = 200; weapons = 10; sky = 3; music = 15
    sounds = 29; movies = 45; animations = 700; effects = 190; lighting = 8; text = 20; brand = 3; verify = 75 }
$Tips = @(
    'You can stop at any time. Run the install command again and it continues where it stopped.'
    'Your Steam copy is only read, never changed.'
    'Local mode works in any browser and without internet.'
    'Online, Chrome and Edge read the folder straight from your PC. Nothing is uploaded.'
    'Cloud saves and play statistics are optional and off until you turn them on.'
    'The longest steps are the 3D models and the animations.'
    'Run the installer again later to update, repair or uninstall.'
)

# The extraction screen: a slideshow of the game's own artwork, every phase with its own bar, an overall bar with
# the time left, and a materia that keeps turning while the extractor works. Redrawn in place (live display).
function Invoke-Extract($release, [string]$game) {
    Show-Header 2 -NoRecap
    Say "Copying what the explorer needs from your game into [white]$(Esc $InstallDir)[/]. [$Dim]About 25 minutes on a fast PC, longer on a hard disk.[/]"
    Write-Host ''

    $keys = @($PhaseNames.Keys)
    $st = @{}
    foreach ($k in $keys) { $st[$k] = @{ done = 0.0; total = 0.0; state = 'wait'; start = 0.0; end = 0.0 } }
    $weightAll = 0.0; foreach ($k in $keys) { $weightAll += $PhaseSeconds[$k] }
    # How long this PC takes per reference second, from the phases that really ran (resumed ones end at once).
    $speed = {
        $w = 0.0; $s = 0.0
        foreach ($k in $keys) { $x = $st[$k]; if ($x.state -eq 'done' -and $x.end - $x.start -gt 2) { $w += $PhaseSeconds[$k]; $s += $x.end - $x.start } }
        if ($w -lt 60 -or $s -lt 30) { return 1.0 }
        return [Math]::Min(6.0, [Math]::Max(0.25, $s / $w))
    }
    $fraction = {
        param($k, [double]$now, [double]$v)
        $x = $st[$k]
        if ($x.state -eq 'done') { return 1.0 }
        if ($x.state -ne 'run') { return 0.0 }
        if ($x.total -gt 1) { return $x.done / $x.total }
        return [Math]::Min(0.95, ($now - $x.start) / ($PhaseSeconds[$k] * $v))  # no counts: estimate from time
    }

    # Screen layout. Everything has to fit the window (the cursor cannot go below it), so the picture is measured and
    # made smaller until picture panel (+3 rows frame and caption) and footer fit below what is already on screen.
    $top = [Console]::CursorTop
    $orbW = 8
    $orb = Materia 'blue' $orbW -Animate:($Live -and $Sixel)
    $orbRows = if ($orb) { [Math]::Max(3, (Get-Rows $orb)) } else { 3 }
    $budget = (Height) - $top - $orbRows - 3                     # rows for the upper part (picture panel or phase list)
    $compact = (-not $Live) -or $budget -lt $PhaseNames.Count     # too small (or no cursor control): text lines only
    $scenes = @(Get-GameArt 'scene')
    $pics = @(); $picW = [Math]::Min(56, (Width) - 70)
    if (-not $compact -and $scenes.Count) {
        while ($picW -ge 24) {
            $probe = Img $scenes[0] $picW
            if (-not $probe) { break }
            if ((Get-Rows $probe) + 3 -le $budget) { $pics = @($scenes | ForEach-Object { Img $_ $picW } | Where-Object { $_ }); break }
            $picW -= 4
        }
    }
    # phase list columns: mark 3 + name 28 + bar + count "100.000 / 112.464" 19 (with padding); wider would wrap
    $listW = (Width) - $(if ($pics.Count) { $picW + 6 } else { 0 }) - 1
    $barW = [Math]::Max(6, [Math]::Min(32, $listW - 54))

    $gridOf = {
        param([double]$elapsed, [int]$tick, [double]$v)
        $rows = foreach ($k in $keys) {
            $s = $st[$k]
            $f = & $fraction $k $elapsed $v
            switch ($s.state) {
                'done' { New-SpectreGridRow @((M "[$Mako]$($Ch.check)[/]"), (M "[grey70]$($PhaseNames[$k])[/]"), (M (Get-Bar 1 $barW $Mako)), (M "[$Dim]done[/]")) }
                'run' {
                    $count = if ($s.total -gt 1) { '{0:N0} / {1:N0}' -f $s.done, $s.total } else { "[$Dim]working$($Ch.ell)[/]" }
                    New-SpectreGridRow @((M "[$Accent]$($Ch.spin[$tick % $Ch.spin.Count])[/]"), (M "[bold white]$($PhaseNames[$k])[/]"), (M (Get-Bar $f $barW 'deepskyblue1')), (M "[white]$count[/]"))
                }
                default { New-SpectreGridRow @((M "[$Dim]$($Ch.dot)[/]"), (M "[$Dim]$($PhaseNames[$k])[/]"), (M (Get-Bar 0 $barW 'grey19')), (M ' ')) }
            }
        }
        Format-SpectreGrid -Data $rows -Padding 1
    }
    $footOf = {
        param([double]$elapsed, [double]$v)
        $overall = 0.0
        foreach ($k in $keys) { $overall += $PhaseSeconds[$k] * (& $fraction $k $elapsed $v) }
        $left = ($weightAll - $overall) * $v
        $overall /= $weightAll
        $eta = if ($elapsed -gt 30 -and $overall -lt 1) { "  [$Dim]$($Ch.mid)[/]  about [white]$(Get-Clock ([Math]::Ceiling($left / 60) * 60))[/] left" } else { '' }
        $tip = $Tips[[int][Math]::Floor($elapsed / 12) % $Tips.Count]
        M ("[bold]Overall[/]  " + (Get-Bar $overall ([Math]::Min(60, (Width) - 40)) $Mako) + ("  [bold white]{0,3}%[/]" -f [int][Math]::Floor($overall * 100)) +
            "`n[$Dim]Elapsed[/] [white]$(Get-Clock $elapsed)[/]$eta`n[$Dim]Tip: $(Esc $tip)[/]")
    }
    $panelOf = { param([int]$n) Format-SpectrePanel -Data (Format-SpectreRows -Data @($pics[$n], (M "[$Dim]From your game  $($n + 1)/$($pics.Count)[/]"))) -Border Rounded -Color Grey23 }

    # Drawn once: the picture panel on the left (its height decides where the footer goes) and the orb.
    # Afterwards only the parts that change are written in place, so the pictures never flicker.
    Enable-VT
    $gridX = 0; $panelH = 0
    if ($compact) { $orb = $null; $pics = @() }
    elseif ($pics.Count) {
        [Console]::SetCursorPosition(0, $top); Show (& $panelOf 0)
        $panelH = [Console]::CursorTop - $top
        $gridX = $picW + 6
    }
    $footY = $top + [Math]::Max($panelH, $keys.Count) + 1
    $footX = 0
    if ($orb) { [Console]::SetCursorPosition(0, $footY); Show $orb; $footX = $orbW + 2 }
    $endY = [Math]::Min((Height) - 1, $footY + $orbRows)
    $drawScreen = {
        param([double]$t, [int]$tick)
        $v = & $speed
        if ($compact) {  # one line now and then
            $run = @($keys | Where-Object { $st[$_].state -eq 'run' } | Select-Object -First 1)
            $o = 0.0; foreach ($k in $keys) { $o += $PhaseSeconds[$k] * (& $fraction $k $t $v) }
            Say ("[$Dim]{0}[/]  {1,3}%  [white]{2}[/]" -f (Get-Clock $t), [int][Math]::Floor(100 * $o / $weightAll), $(if ($run.Count) { $PhaseNames[$run[0]] } else { '' }))
            return
        }
        Write-Region $gridX $top ((Width) - $gridX - 1) (& $gridOf $t $tick $v) -MaxRows ($footY - $top - 1)
        Write-Region $footX $footY ((Width) - $footX - 1) (& $footOf $t $v) -MaxRows 3
        if ($pics.Count) {
            $n = [int][Math]::Floor($t / 15) % $pics.Count
            if ($n -ne $script:ShownPic) {
                $script:ShownPic = $n
                if ($Sixel) {
                    Write-Sixel 2 ($top + 1) $pics[$n]
                    Write-Region 2 ($top + $panelH - 2) $picW (M "[$Dim]From your game  $($n + 1)/$($pics.Count)[/]") -Pad
                } else { [Console]::SetCursorPosition(0, $top); Show (& $panelOf $n) }
            }
        }
        if ($orb -and $Live -and $Sixel) { Write-Sixel 0 $footY $orb }
        [Console]::SetCursorPosition(0, $endY)
    }
    $draw = {
        param([double]$t, [int]$tick)
        try { & $drawScreen $t $tick }
        catch {
            Log "screen: $($_.Exception.Message) $($_.ScriptStackTrace)"
            if (-not $compact) { try { [Console]::SetCursorPosition(0, $endY) } catch { }; Write-Host '' }
            Set-Variable -Name compact -Value $true -Scope 1  # plain status lines from now on
        }
    }

    $script:ShownPic = 0
    $res = @{ ok = $false; warnings = @(); message = '' }
    $cursor = $true; try { $cursor = [Console]::CursorVisible; [Console]::CursorVisible = $false } catch { }
    try {
        & $draw 0 0
        $psi = [Diagnostics.ProcessStartInfo]::new($Ffcx)
        foreach ($a in @('extract', '--game', $game, '--out', $InstallDir, '--data', (Get-DataDir $release))) { $psi.ArgumentList.Add($a) }
        $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
        $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
        $p = [Diagnostics.Process]::Start($psi)
        $errTask = $p.StandardError.ReadToEndAsync()
        $clock = [Diagnostics.Stopwatch]::StartNew()
        $tick = 0; $lastDraw = 0.0
        $pending = $p.StandardOutput.ReadLineAsync()
        while ($true) {
            if ($pending.Wait(120)) {
                $line = $pending.Result
                if ($null -eq $line) { break }
                $pending = $p.StandardOutput.ReadLineAsync()
                Log "ffcx $line"
                try { $ev = $line | ConvertFrom-Json } catch { continue }
                $now = $clock.Elapsed.TotalSeconds
                switch ($ev.event) {
                    'phase' {
                        foreach ($k in $keys) { if ($k -eq $ev.id) { break }; if ($st[$k].state -ne 'done') { $st[$k].state = 'done'; $st[$k].end = $now } }
                        if ($st.ContainsKey($ev.id)) { $x = $st[$ev.id]; $x.state = 'run'; $x.total = [double]$ev.total; $x.done = 0; $x.start = $now }
                    }
                    'progress' {
                        if ($st.ContainsKey($ev.id)) {
                            $s = $st[$ev.id]; $s.done = [double]$ev.done; $s.total = [double]$ev.total
                            if ($ev.total -and $ev.done -ge $ev.total) { if ($s.state -ne 'done') { $s.state = 'done'; $s.end = $now } }
                            elseif ($s.state -ne 'done') { $s.state = 'run' }
                        }
                    }
                    'warn' { $res.warnings += $ev.message }
                    'error' { $res.message = $ev.message }
                    'done' { $res.ok = $true; $res.done = $ev; foreach ($k in $keys) { $st[$k].state = 'done' } }
                }
                if ($clock.Elapsed.TotalSeconds - $lastDraw -lt 0.15) { continue }
            }
            $t = $clock.Elapsed.TotalSeconds
            if ($compact -and $t - $lastDraw -lt 30) { continue }
            $tick++; $lastDraw = $t
            & $draw $t $tick
        }
        $p.WaitForExit()
        Log ("ffcx stderr: " + $errTask.Result)
        if ($p.ExitCode -ne 0 -and -not $res.message) { $res.message = "The extractor stopped (exit code $($p.ExitCode))." }
        & $draw $clock.Elapsed.TotalSeconds $tick
    } finally {
        try { [Console]::CursorVisible = $cursor } catch { }
        if (-not $compact) { [Console]::SetCursorPosition(0, $endY) }
        Write-Host ''
    }
    if (-not $res.ok) { Fail ("Extraction stopped: " + $res.message + "`nRun the installer again to continue where it stopped.") }
    foreach ($w in $res.warnings) { Say "[yellow]![/] $(Esc $w)" }
    $d = $res.done
    $Recap.Add(("[$Mako]$($Ch.check)[/] Extracted [white]{0:N0}[/] files ([white]{1}[/]) in [white]{2}[/]" -f $d.files, (Get-Size $d.bytes), (Get-Clock $d.seconds)))
    $script:ExtractResult = $d
}

function New-Shortcut([string]$path, [string]$target, [string]$arguments, [string]$icon, [string]$description) {
    $sh = New-Object -ComObject WScript.Shell
    $s = $sh.CreateShortcut($path)
    $s.TargetPath = $target
    $s.Arguments = $arguments
    $s.WorkingDirectory = $InstallDir
    $s.Description = $description
    if ($icon -and (Test-Path $icon)) { $s.IconLocation = "$icon,0" }
    $s.Save()
}

function Install-Local($release, [string]$game, [bool]$localMode) {
    Show-Header 3
    $pwshExe = (Get-Process -Id $PID).Path
    $newPwsh = Join-Path $Runtime 'pwsh\pwsh.exe'
    if (Test-Path $newPwsh) { $pwshExe = $newPwsh }
    $menu = Join-Path ([Environment]::GetFolderPath('Programs')) $AppName
    New-Item -ItemType Directory -Force $menu | Out-Null
    $icon = Join-Path $game 'FF7EC.exe'
    $server = Join-Path $Tools 'ffcx\ffcx-server.exe'
    if ($localMode) {
        Invoke-SpectreCommandWithStatus -Spinner Dots -Color $Accent -Title 'Installing local mode...' -ScriptBlock {
            $zip = Join-Path $Runtime 'app.zip'
            Save-File "$Base/$($release.assets.app)" $zip $release.sha256.($release.assets.app)
            $app = Join-Path $InstallDir 'app'
            if (Test-Path $app) { Remove-Item -Recurse -Force $app }
            Expand-Zip $zip $app
            Remove-Item -LiteralPath $zip -Force
        } | Out-Null
        $args1 = "serve --root `"$InstallDir`" --port $Port --open"
        New-Shortcut (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk") $server $args1 $icon 'Play FF7 Forever Crisis on this PC (local mode)'
        New-Shortcut (Join-Path $menu "$AppName.lnk") $server $args1 $icon 'Play FF7 Forever Crisis on this PC (local mode)'
        New-Shortcut (Join-Path $menu "Stop the local server.lnk") $server "serve --root `"$InstallDir`" --port $Port --stop" '' 'Stop the FF7 Forever Crisis local server'
        Say "[$Mako]$($Ch.check)[/] Local mode: desktop and Start-menu shortcut [$Accent]$AppName[/]"
    }
    if ($release.site) {
        $url = Join-Path $menu "$AppName (online).url"
        Set-Content -LiteralPath $url -Value "[InternetShortcut]`r`nURL=$($release.site)`r`n" -Encoding ASCII
    }
    New-Shortcut (Join-Path $menu "Update, repair or uninstall.lnk") $pwshExe "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Runtime 'install.ps1')`" -Relaunched" '' 'Update, repair or uninstall FF7 Forever Crisis'

    # Apps & features entry (per user, no admin)
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FF7ForeverCrisis'
    New-Item -Path $key -Force | Out-Null
    $size = [int]((Get-ChildItem -LiteralPath $InstallDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1KB)
    $props = @{
        DisplayName = $AppName; DisplayVersion = $release.version; Publisher = 'Fan project (not affiliated with Square Enix)'
        InstallLocation = $InstallDir; EstimatedSize = $size; NoModify = 1; NoRepair = 0
        UninstallString = "`"$pwshExe`" -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Runtime 'install.ps1')`" -Relaunched -Uninstall"
        ModifyPath = "`"$pwshExe`" -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Runtime 'install.ps1')`" -Relaunched"
        DisplayIcon = $icon; URLInfoAbout = 'https://github.com/dudhasch/forever-crisis'
    }
    foreach ($k in $props.Keys) { New-ItemProperty -Path $key -Name $k -Value $props[$k] -Force | Out-Null }
    $origins = @()
    if ($release.site) { $origins += ([Uri]$release.site).GetLeftPart([UriPartial]::Authority) }
    @{ version = $release.version; game = $game; localMode = $localMode; installed = (Get-Date).ToString('o'); allowedOrigins = $origins; port = $Port; stories = $script:SelectedStories } |
        ConvertTo-Json | Set-Content -LiteralPath $State -Encoding UTF8
    Say "[$Mako]$($Ch.check)[/] Added to [white]Apps & features[/] and the Start menu ([white]$AppName[/])"
    $Recap.Add("[$Mako]$($Ch.check)[/] Shortcuts, Start menu and Apps & features")
}

# Five materia turning together, then the way to play next to a picture from the game.
function Show-Done($release, $extract, [bool]$localMode) {
    Show-Header 4
    $orbs = @('green', 'blue', 'yellow', 'red', 'purple' | ForEach-Object { Materia $_ 8 -Animate:($Live -and $Sixel) } | Where-Object { $_ })
    if ($orbs.Count -eq 5 -and (Width) -ge 60) {
        if ($Live -and $Sixel) {
            # five materia turning together, centered
            $rows = Get-Rows $orbs[0]
            $y = [Console]::CursorTop
            Write-Host ("`n" * ($rows - 1))
            $end = [Console]::CursorTop
            $y = $end - $rows  # the window may have scrolled
            $x0 = [int](((Width) - (5 * 8 + 4 * 2)) / 2)
            $items = for ($i = 0; $i -lt 5; $i++) {
                $frames = Get-SixelFrames $orbs[$i] 24
                @{ x = ($x0 + $i * 10); y = $y; frames = $frames }
            }
            Start-MateriaAnimation $items 40
            [Console]::SetCursorPosition(0, $end)
        } else { Show (Format-SpectreAligned -Data (Format-SpectreColumns -Data $orbs) -HorizontalAlignment Center) }
    }
    $lines = @("[bold $Accent]All done.[/] [white]Your game files are in[/] [$Accent]$(Esc $InstallDir)[/]", '')
    if ($release.site) {
        $lines += "[bold white]Play online[/]"
        $lines += "Open [link]$(Esc $release.site)[/] in Chrome or Edge, click [white]Choose folder[/] and pick the folder above."
        try { Set-Clipboard -Value $InstallDir; $lines += "[$Dim](The folder path is on your clipboard.)[/]" } catch { }
        $lines += ''
    }
    if ($localMode) {
        $lines += "[bold white]Play on this PC[/]"
        $lines += "Double-click [white]$AppName[/] on your desktop. Any browser, no internet needed."
        $lines += ''
    }
    if ($script:SelectedStories -and $script:SelectedStories.Count) {
        $lines += "[bold white]Stories[/]"
        $lines += ($script:SelectedStories | ForEach-Object { "[$Accent]$($Ch.mid)[/] [white]$(Esc $_)[/]" }) -join "`n"
        $lines += ''
    }
    $lines += "[$Dim]Run the installer again anytime to update, repair or uninstall.`nLog: $(Esc $LogFile)[/]"
    $text = M ($lines -join "`n")
    # the Forever Crisis logo, drawn from the player's game (ffcx art); else one of the game's pictures
    $hero = Join-Path $GameArt 'hero.png'
    $scenes = @(Get-GameArt 'scene')
    $picW = [Math]::Min(44, (Width) - 64)
    $pic = $null
    if ($picW -ge 20) {
        if (Test-Path -LiteralPath $hero) { $pic = Img $hero $picW }
        elseif ($scenes.Count) { $pic = Img $scenes[(Get-Random -Maximum $scenes.Count)] ([Math]::Min($picW, [int](((Height) - 16) * 8 / 3))) }
    }
    # a grid keeps the picture beside the text (columns would wrap it above); the text column wraps instead
    $body = if ($pic) { Format-SpectreGrid -Data @(, (New-SpectreGridRow @($pic, $text))) -Padding 2 } else { $text }
    Show (Format-SpectrePanel -Data $body -Header "[bold $Accent] Ready to play [/]" -Border Rounded -Color $Accent -Expand)
    if ($localMode -and -not $Unattended -and (Confirm 'Start the explorer now?' $true)) {
        Start-Process -FilePath (Join-Path $Tools 'ffcx\ffcx-server.exe') -ArgumentList @('serve', '--root', $InstallDir, '--port', $Port, '--open')
    }
    if (-not $Unattended) {
        Read-SpectrePause -Message "[$Dim]Press any key to close[/]" -AnyKey | Out-Null
    }
    Stop-MateriaAnimation
}

function Remove-All {
    Stop-MateriaAnimation
    Clear-Screen
    $orb = Materia 'purple' 5
    $title = M "[bold $Accent]FF7 FOREVER CRISIS[/]  [$Dim]uninstall[/]"
    if ($orb) { Show (Format-SpectreColumns -Data @($orb, $title)) } else { Show $title; Write-Host '' }
    Show (Write-SpectreRule -LineColor Grey23 -PassThru)
    $server = Join-Path $Tools 'ffcx\ffcx-server.exe'
    if (Test-Path $server) { & $server serve --root $InstallDir --port $Port --stop 2>$null | Out-Null }
    Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk") -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) $AppName) -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FF7ForeverCrisis' -Recurse -Force -ErrorAction SilentlyContinue
    Say "[$Mako]$($Ch.check)[/] Removed the shortcuts and the Apps & features entry"
    $deleteFiles = Confirm "Also delete the extracted game files in $(Esc $InstallDir)?" ($env:FFC_KEEP_FILES -ne '1')
    if ($deleteFiles) {
        # only what the installer and the extractor created; anything else in the folder stays
        Invoke-SpectreCommandWithStatus -Spinner Dots -Color $Accent -Title 'Deleting files...' -ScriptBlock {
            foreach ($n in $Created) {
                $p = Join-Path $InstallDir $n
                if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
            }
        } | Out-Null
        # the running PowerShell may live in runtime\ - remove it after this process exits, then the folder if it is empty
        $cmd = "/c ping 127.0.0.1 -n 3 >nul & rmdir /s /q `"$Runtime`" & rmdir /s /q `"$LogDir`" & rmdir `"$InstallDir`""
        Start-Process -FilePath cmd.exe -ArgumentList $cmd -WindowStyle Hidden
    }
    $kept = if ($deleteFiles) { '' } else { "`n[$Dim]The extracted files are still in $(Esc $InstallDir); run the installer again to use them.[/]" }
    Show (Format-SpectrePanel -Data (M "[white]FF7 Forever Crisis was removed.[/] Your game install was not touched.`n[$Dim]Cloud saves (if you used them) stay in your account until you delete them on the site.[/]$kept") -Header "[bold $Accent] Uninstalled [/]" -Border Rounded -Color $Accent)
}

function Show-Welcome {
    $items = @(  # unary commas keep the inner arrays (PowerShell would flatten them into one list)
        , @('green', '[bold white]Find the game[/]', 'in your Steam libraries (or you pick the folder)')
        , @('blue', '[bold white]Extract[/]', 'the files the explorer needs from your copy, about 57 GB. The game itself is not changed.')
        , @('yellow', '[bold white]Install[/]', 'shortcuts, and local mode if you want to play without the website')
    )
    $rows = foreach ($it in $items) {
        $orb = Materia $it[0] 4
        New-SpectreGridRow @($(if ($orb) { $orb } else { M "[$Accent]$($Ch.mid)[/]" }), (M "$($it[1])`n[$Dim]$($it[2])[/]"))
    }
    $grid = Format-SpectreGrid -Data $rows -Padding 2
    $note = M "[$Dim]Fan project, not affiliated with Square Enix or Applibot. Nothing from the game is downloaded.[/]"
    Write-Host ''
    Show (Format-SpectrePanel -Data (Format-SpectreRows -Data @($grid, (M ' '), $note)) -Header "[$Accent] What happens [/]" -Border Rounded -Color Grey30)
}

function Show-Installed($existing, $release, [bool]$newer) {
    $info = M ("Installed: version [white]$(Esc $existing.version)[/] in [white]$(Esc $InstallDir)[/]" +
        $(if ($newer) { "`n[$Accent]Version $(Esc $release.version) is available.[/]" } else { "`n[$Dim]This is the latest version.[/]" }) +
        $(if ($existing.game) { "`n[$Dim]Game: $(Esc $existing.game)[/]" } else { '' }))
    $hero = Join-Path $GameArt 'hero.png'
    $scenes = @(Get-GameArt 'scene')
    $pic = $null
    if ((Width) -ge 100) {
        if (Test-Path -LiteralPath $hero) { $pic = Img $hero 36 } elseif ($scenes.Count) { $pic = Img $scenes[(Get-Random -Maximum $scenes.Count)] 30 }
    }
    Write-Host ''
    Show (Format-SpectrePanel -Data $(if ($pic) { Format-SpectreColumns -Data @($pic, $info) } else { $info }) -Border Rounded -Color Grey30)
}

# ---- main ----------------------------------------------------------------------------------------------------
try {
    Show-Banner
    $release = Get-Release
    $existing = Read-State
    if ($Uninstall) { Remove-All; exit 0 }
    $mode = 'install'
    if ($Action) { $mode = $Action }
    elseif ($existing) {
        $newer = [version]$release.version -gt [version]$existing.version
        $choices = @()
        if ($newer) { $choices += "Update to $($release.version)" }
        $choices += @('Repair (check and finish the files)', 'Uninstall', 'Close')
        Show-Installed $existing $release $newer
        $c = Ask 'What would you like to do?' $choices
        if ($c -eq 'Close') { exit 0 }
        if ($c -eq 'Uninstall') { Remove-All; exit 0 }
        $mode = if ($c -like 'Update*') { 'update' } else { 'repair' }
    } else {
        Show-Welcome
        while (-not (Confirm "Install to [white]$(Esc $script:InstallDir)[/]?" $true)) {
            $newPath = Request-InstallDir
            if (-not $newPath) { exit 0 }
            Set-InstallDir $newPath
        }
    }
    Install-Tools $release
    Install-Data $release
    if ($existing -and $existing.game -and $mode -ne 'install' -and (Test-Path $existing.game)) {
        $script:GameDir = $existing.game
        Show-Header 1
        Show-Found $existing.game
    } else { Find-Game }
    $game = $script:GameDir
    $localMode = if ($existing) { [bool]$existing.localMode } else { Write-Host ''; Confirm 'Also set up local mode (play on this PC without the website, any browser)?' $true }
    $Recap.Add("[$Mako]$($Ch.check)[/] Local mode: [white]$(if ($localMode) { 'yes' } else { 'no' })[/]")
    Invoke-Extract $release $game
    $extract = $script:ExtractResult
    Install-Local $release $game $localMode
    Show-Done $release $extract $localMode
    Log 'installer finished'
    exit 0
} catch {
    Stop-MateriaAnimation
    Log ("error: " + $_.Exception.ToString() + "`n" + $_.ScriptStackTrace)
    Fail $_.Exception.Message
} finally {
    Stop-MateriaAnimation
}
