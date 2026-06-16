<#
.SYNOPSIS
  Rebuilds the app and restarts the WinSW service. Run after pulling code changes.
.NOTES
  Assumes the service was already installed via install-service.ps1 (which placed
  the WinSW binary at <project>\service\prdash.exe). Run elevated.
#>
[CmdletBinding()]
param(
  [string] $ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'
$exePath = Join-Path $ProjectDir 'service\prdash.exe'

if (-not (Test-Path $exePath)) {
  throw "WinSW binary not found at $exePath. Run install-service.ps1 first."
}

if (-not $SkipBuild) {
  Write-Host "Building..."
  Push-Location $ProjectDir
  try {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
  } finally { Pop-Location }
}

Write-Host "Restarting service..."
& $exePath restart

Write-Host "Done."
