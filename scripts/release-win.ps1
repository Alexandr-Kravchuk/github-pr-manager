#requires -Version 5.1
<#
.SYNOPSIS
  Build and publish the Windows installer for PR Dashboard on a Windows host
  (e.g. ts1-core-dev04), attaching it to the matching GitHub Release.

.DESCRIPTION
  The Windows counterpart of scripts/release-mac.sh. It:
    1. clones/updates the repo (token works whether the repo is public or private),
    2. runs npm ci + npm run build,
    3. packs the NSIS installer with electron-builder,
    4. uploads the .exe + .blockmap + latest.yml (the electron-updater Windows
       feed) to the v<version> GitHub Release.

  The assets are uploaded via the GitHub API, not electron-builder --publish,
  because electron-builder refuses to add assets to a release that is already
  published or older than 2 hours. The API path is idempotent: re-running
  replaces same-named assets. (electron-builder is still run with --publish
  always so it generates latest.yml; its own upload may no-op, which is fine.)

  Builds from origin/main (HEAD), so make sure the version bump is on main and
  package-lock.json is the cross-platform one (npm install --package-lock-only)
  before running — the macOS-only lock omits Windows native deps and breaks npm ci.

  Run over SSH from macOS (keepalives ride out brief VPN blips):
    ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10 ts1 `
      "powershell -ExecutionPolicy Bypass -File C:\path\release-win.ps1 -Token <gh-token>"
  where <gh-token> = `gh auth token --hostname github.com` (repo scope).

.PARAMETER Token
  GitHub token with 'repo' scope. Used to clone (if private) and to publish assets.

.PARAMETER RepoDir
  Working checkout directory. Default C:\apps\prd-build.

.PARAMETER Tag
  Release tag to attach to. Default v<version from package.json>.
#>
param(
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$RepoDir = "C:\apps\prd-build",
  [string]$Tag
)

$ErrorActionPreference = "Stop"
$env:GIT_TERMINAL_PROMPT = "0"
$Repo = "Alexandr-Kravchuk/github-pr-manager"
$CloneUrl = "https://github.com/$Repo.git"
$CloneUrlAuth = "https://$Token@github.com/$Repo.git"

function Check($name) { if ($LASTEXITCODE -ne 0) { throw "$name failed (exit $LASTEXITCODE)" } }
function Log($m) { Write-Host "`n> $m" -ForegroundColor Cyan }

# --- checkout ---------------------------------------------------------------
Log "Preparing checkout at $RepoDir"
$valid = $false
if (Test-Path (Join-Path $RepoDir ".git")) {
  git -C $RepoDir rev-parse --is-inside-work-tree 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $valid = $true }
}
if (-not $valid) {
  if (Test-Path $RepoDir) { Remove-Item -Recurse -Force $RepoDir }
  git clone $CloneUrlAuth $RepoDir; Check "git clone"
}
Set-Location $RepoDir
git remote set-url origin $CloneUrlAuth
git fetch origin --tags --prune; Check "git fetch"
git checkout main; Check "git checkout"
git reset --hard origin/main; Check "git reset"
git remote set-url origin $CloneUrl   # scrub token from .git/config
Log ("HEAD " + (git rev-parse --short HEAD))

# --- build ------------------------------------------------------------------
Log "npm ci"
npm ci; Check "npm ci"
Log "npm run build"
npm run build; Check "npm run build"
Log "electron-builder --win nsis"
$env:GH_TOKEN = $Token   # lets electron-builder emit latest.yml; its upload may no-op
npx --no-install electron-builder --win nsis --publish always
# Note: a non-zero here usually means "skipped publishing" (release already
# published / >2h old) — harmless, the API upload below does the real work.

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
if (-not $Tag) { $Tag = "v$version" }
Log "Version $version -> release $Tag"

# --- locate (or create) the release ----------------------------------------
$headers = @{ Authorization = "Bearer $Token"; "User-Agent" = "release-win"; Accept = "application/vnd.github+json" }
$apiBase = "https://api.github.com/repos/$Repo"
try {
  $rel = Invoke-RestMethod -Headers $headers "$apiBase/releases/tags/$Tag"
} catch {
  Log "Release $Tag not found - creating a draft"
  $body = @{ tag_name = $Tag; name = $version; draft = $true } | ConvertTo-Json
  $rel = Invoke-RestMethod -Method Post -Headers $headers -Body $body -ContentType "application/json" "$apiBase/releases"
}
$relId = $rel.id

# --- upload assets via API (idempotent) ------------------------------------
$dist = Join-Path $RepoDir "dist"
$exe = Get-ChildItem "$dist\*.exe" -ErrorAction Stop | Select-Object -First 1
if (-not $exe) { throw "No .exe found in $dist" }
# GitHub asset names have no spaces; this matches electron-builder's dashed name
# and the `url` field inside latest.yml.
$exeName = $exe.Name -replace ' ', '-'
$uploads = @(
  @{ Path = $exe.FullName;                 Name = $exeName;            Type = "application/octet-stream" }
  @{ Path = "$($exe.FullName).blockmap";   Name = "$exeName.blockmap"; Type = "application/octet-stream" }
  @{ Path = (Join-Path $dist "latest.yml"); Name = "latest.yml";       Type = "text/yaml" }
)
foreach ($u in $uploads) {
  if (-not (Test-Path $u.Path)) { throw "Missing artifact: $($u.Path)" }
  foreach ($a in ($rel.assets | Where-Object { $_.name -eq $u.Name })) {
    Log "Replacing existing asset $($a.name)"
    Invoke-RestMethod -Method Delete -Headers $headers "$apiBase/releases/assets/$($a.id)" | Out-Null
  }
  $h = $headers.Clone(); $h["Content-Type"] = $u.Type
  $url = "https://uploads.github.com/repos/$Repo/releases/$relId/assets?name=$($u.Name)"
  Log "Uploading $($u.Name)"
  Invoke-RestMethod -Method Post -Headers $h -InFile $u.Path -Uri $url | Out-Null
}

Log "Done: $Tag now carries the Windows installer + latest.yml"
