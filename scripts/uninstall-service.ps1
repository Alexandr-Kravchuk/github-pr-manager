<#
.SYNOPSIS
  Stops and removes the PR Dashboard WinSW service. Run elevated.
#>
[CmdletBinding()]
param(
  [string] $ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Stop'
$ServiceId = 'github-pr-manager'
$exePath = Join-Path $ProjectDir 'service\prdash.exe'

if (-not (Test-Path $exePath)) {
  Write-Warning "WinSW binary not found at $exePath; nothing to uninstall."
  return
}

& $exePath stop 2>$null
& $exePath uninstall

for ($i = 0; $i -lt 30; $i++) {
  if (-not (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 1
}

Write-Host "Removed '$ServiceId'."
