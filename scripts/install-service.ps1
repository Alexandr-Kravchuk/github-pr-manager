<#
.SYNOPSIS
  Installs (or reinstalls) the PR Dashboard as a WinSW Windows service behind IIS.

.DESCRIPTION
  Mirrors the macOS launchd installer for Windows (ts1-core-dev04):
    - npm ci + npm run build (unless -SkipBuild)
    - deploys the WinSW binary + a token-substituted prdash.xml into <project>\service
    - idempotently (re)installs the service: stop/uninstall any existing one,
      wait for the SCM to actually remove it (handles "marked for deletion"),
      then install + start

  The service listens on 127.0.0.1:<Port>; IIS + ARR terminate TLS and reverse
  proxy to it (see web.config). Run from an elevated PowerShell.

.NOTES
  Secrets are NOT written to disk. Set these as MACHINE env vars first
  (the service inherits them at start):
    AUTH_SECRET, GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET
    (later: GHE_OAUTH_CLIENT_ID, GHE_OAUTH_CLIENT_SECRET)
  e.g.  [Environment]::SetEnvironmentVariable('AUTH_SECRET','<random>','Machine')
#>
[CmdletBinding()]
param(
  # Path to the WinSW executable to deploy (download from github.com/winsw/winsw releases).
  [Parameter(Mandatory = $true)] [string] $WinSWPath,
  # gMSA service account, e.g. 'CONTOSO\prdash$' (note the trailing $).
  [Parameter(Mandatory = $true)] [string] $ServiceAccount,
  # Public HTTPS origin used for OAuth callbacks, e.g. 'https://prdash.creatio'.
  [Parameter(Mandatory = $true)] [string] $AuthUrl,
  [int]    $Port = 3737,
  [string] $ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'
$ServiceId = 'github-pr-manager'

function Resolve-NodeExe {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "node.exe not found on PATH. Install Node and ensure it's on the machine PATH." }
  return $cmd.Source
}

# --- 1. Build -------------------------------------------------------------
if (-not $SkipBuild) {
  Write-Host "Installing dependencies and building..."
  Push-Location $ProjectDir
  try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed." }
  } finally { Pop-Location }
}

# --- 2. Warn on missing secrets ------------------------------------------
foreach ($name in 'AUTH_SECRET', 'GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET') {
  if (-not [Environment]::GetEnvironmentVariable($name, 'Machine')) {
    Write-Warning "Machine env var '$name' is not set - the service will not authenticate until it is."
  }
}

# --- 3. Deploy WinSW binary + substituted XML ----------------------------
$nodeExe   = Resolve-NodeExe
$serviceDir = Join-Path $ProjectDir 'service'
New-Item -ItemType Directory -Force -Path $serviceDir | Out-Null

$exePath = Join-Path $serviceDir 'prdash.exe'
$xmlPath = Join-Path $serviceDir 'prdash.xml'
Copy-Item -Force -Path $WinSWPath -Destination $exePath

$template = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'prdash.xml')
$template = $template.Replace('@NODE_EXE@',        $nodeExe)
$template = $template.Replace('@PORT@',            "$Port")
$template = $template.Replace('@WORKDIR@',         $ProjectDir)
$template = $template.Replace('@AUTH_URL@',        $AuthUrl.TrimEnd('/'))
$template = $template.Replace('@SERVICE_ACCOUNT@', $ServiceAccount)
Set-Content -Path $xmlPath -Value $template -Encoding UTF8

# --- 4. Idempotent (re)install -------------------------------------------
if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) {
  Write-Host "Existing service found - stopping and uninstalling..."
  & $exePath stop   2>$null
  & $exePath uninstall
  # The SCM removes a service asynchronously; a service can linger as
  # "marked for deletion" (e.g. if services.msc is open). Wait it out.
  for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
  }
  if (Get-Service -Name $ServiceId -ErrorAction SilentlyContinue) {
    throw "Service '$ServiceId' is still present (likely marked for deletion). Close services.msc and retry."
  }
}

Write-Host "Installing service..."
& $exePath install
& $exePath start

Write-Host ""
Write-Host "Installed '$ServiceId' (account: $ServiceAccount)."
Write-Host "Listening on http://127.0.0.1:$Port (front it with IIS/ARR on 443)."
Write-Host "Public URL: $AuthUrl"
Write-Host "Logs: $serviceDir\prdash.*.log"
