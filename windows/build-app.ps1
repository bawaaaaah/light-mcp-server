# Builds LightMCPMenuBar.exe (the notification area controller for this checkout's server) with the C#
# compiler that ships with the .NET Framework, and installs it in %LOCALAPPDATA%\LightMCP. The checkout's
# path and the current `node` go into appsettings.json next to the installed exe; see windows/README.md to
# override them. -NoInstall only builds windows\build\LightMCP\LightMCPMenuBar.exe (as the CI does): run
# from there, the app finds the checkout around it.
param([switch]$NoInstall)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$srcDir = Join-Path $PSScriptRoot "LightMenuBar"
$binDir = Join-Path $PSScriptRoot "build\LightMCP"
$exeName = "LightMCPMenuBar.exe"
$built = Join-Path $binDir $exeName
$installDir = Join-Path $env:LOCALAPPDATA "LightMCP"
$installed = Join-Path $installDir $exeName

# Ending the app closes the server's stdin: the server saves and exits on its own. Wait for it, so the new
# copy does not find it still answering on the port.
function Stop-App($apps) {
    $servers = @($apps | ForEach-Object {
        Get-CimInstance Win32_Process -Filter "ParentProcessId = $($_.Id)" | ForEach-Object { $_.ProcessId }
    })
    $apps | Stop-Process -Force
    $servers | ForEach-Object { Wait-Process -Id $_ -Timeout 10 -ErrorAction SilentlyContinue }
}

$csc = @("Framework64", "Framework") |
    ForEach-Object { Join-Path $env:WINDIR "Microsoft.NET\$_\v4.0.30319\csc.exe" } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
if (-not $csc) { throw "csc.exe not found: the .NET Framework 4.x is required" }

# A running app locks its exe.
$running = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($exeName)) -ErrorAction SilentlyContinue)
$fromBuild = @($running | Where-Object { $_.Path -eq $built })
if ($fromBuild.Count -gt 0) { Stop-App $fromBuild }

if (Test-Path $binDir) { Remove-Item $binDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$sources = Get-ChildItem -Path $srcDir -Filter *.cs | ForEach-Object { $_.FullName }
# /codepage:65001: the sources are UTF-8 (accented menu titles); csc would read them in the ANSI code page.
& $csc /nologo /target:winexe /optimize+ /codepage:65001 "/out:$built" `
    /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll `
    $sources
if ($LASTEXITCODE -ne 0) { throw "Compilation failed" }
Write-Host "Built $built"

if ($NoInstall) {
    if ($fromBuild.Count -gt 0) { Start-Process -FilePath $built }
    return
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "node is not on PATH; install it or set nodePath afterwards (see windows/README.md)" }

$others = @($running | Where-Object { $_.Path -ne $built })
if ($others.Count -gt 0) { Stop-App $others }

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Path $built -Destination $installDir -Force
$settings = [ordered]@{ repoPath = $root; nodePath = $node.Source } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $installDir "appsettings.json"), $settings, (New-Object Text.UTF8Encoding($false)))
Write-Host "Installed $installed"

if ($running.Count -gt 0) {
    Start-Process -FilePath $installed
} else {
    Write-Host "Start it with: & `"$installed`""
}
