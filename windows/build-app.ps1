# Build the Windows menu bar app (LightMCPMenuBar.exe) and install to %LOCALAPPDATA%\LightMCP.
param([switch]$NoInstall)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$srcDir = Join-Path $PSScriptRoot "LightMenuBar"
$outDir = Join-Path $PSScriptRoot "build"
$binDir = Join-Path $outDir "LightMCP"

if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$csc = $null
foreach ($fw in @("Framework64","Framework")) {
    $p = "C:\Windows\Microsoft.NET\$fw\v4.0.30319\csc.exe"
    if (Test-Path $p) { $csc = $p; break }
}
if (-not $csc) { throw "csc.exe not found" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "node" }

$settings = @{ repoPath = $root; nodePath = $node } | ConvertTo-Json
Set-Content -Path (Join-Path $binDir "appsettings.json") -Value $settings -Encoding UTF8

$outExe = Join-Path $binDir "LightMCPMenuBar.exe"

$cscArgs = New-Object System.Collections.ArrayList
[void]$cscArgs.Add("/target:winexe")
[void]$cscArgs.Add("/out:$outExe")
[void]$cscArgs.Add("/reference:System.dll")
[void]$cscArgs.Add("/reference:System.Core.dll")
[void]$cscArgs.Add("/reference:System.Drawing.dll")
[void]$cscArgs.Add("/reference:System.Windows.Forms.dll")
[void]$cscArgs.Add("/reference:Microsoft.CSharp.dll")
Get-ChildItem -Path $srcDir -Filter *.cs | ForEach-Object { [void]$cscArgs.Add($_.FullName) }

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "Compilation failed" }

if (-not $NoInstall) {
    $installDir = Join-Path $env:LOCALAPPDATA "LightMCP"
    if (-not (Test-Path $installDir)) { New-Item -ItemType Directory -Force -Path $installDir | Out-Null }
    Copy-Item -Path (Join-Path $binDir "*") -Destination $installDir -Recurse -Force
    Write-Host "Installed to $installDir"
    Write-Host "Run: $installDir\LightMCPMenuBar.exe"
}
Write-Host "Build OK: $binDir\LightMCPMenuBar.exe"