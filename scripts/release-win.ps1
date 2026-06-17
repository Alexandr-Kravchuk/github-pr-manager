#requires -Version 5.1
<#
.SYNOPSIS
  Build and upload the Windows installer for PR Dashboard on a Windows host
  (e.g. ts1-core-dev04), attaching it to the GitHub Release for the version.

.DESCRIPTION
  Windows counterpart of scripts/release-mac.sh, same clean flow:
    1. clone/update the repo (token works whether public or private),
    2. npm ci + npm run build,
    3. electron-builder packs the NSIS installer with --publish never (still
       emits latest.yml, the Windows update feed),
    4. upload the .exe + .blockmap + latest.yml to the release BY ID.

  The release is resolved from the /releases LIST (which matches DRAFT releases),
  not the by-tag endpoint (which 404s on drafts and made electron-builder create
  duplicate drafts). Uploading by ID is idempotent and lands on the same release
  as the macOS build.

  Run over SSH from macOS (keepalives ride out brief VPN blips):
    ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=10 ts1 `
      "powershell -ExecutionPolicy Bypass -File C:\path\release-win.ps1 -Token <gh-token>"
  where <gh-token> = `gh auth token --hostname github.com` (repo scope).

.PARAMETER Token
  GitHub token with 'repo' scope. Used to clone (if private) and to upload assets.

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
$CloneUrlAuth = "https://$Token@github.com/$Repo.git"
$CloneUrlClean = "https://github.com/$Repo.git"
$apiBase = "https://api.github.com/repos/$Repo"
$headers = @{ Authorization = "Bearer $Token"; "User-Agent" = "release-win"; Accept = "application/vnd.github+json" }

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
git remote set-url origin $CloneUrlClean   # scrub token from .git/config
Log ("HEAD " + (git rev-parse --short HEAD))

# --- build (no publish; electron-builder still emits latest.yml) -------------
Log "npm ci"
npm ci; Check "npm ci"
Log "npm run build"
npm run build; Check "npm run build"
Log "electron-builder --win nsis (no publish)"
npx --no-install electron-builder --win nsis --publish never; Check "electron-builder"

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
if (-not $Tag) { $Tag = "v$version" }
Log "Version $version -> release $Tag"

# --- resolve the release by ID (LIST matches drafts; by-tag would not) ------
# Retry to ride out the brief lag before a freshly created draft lists; create
# only if truly absent.
$rel = $null
for ($i = 0; $i -lt 5; $i++) {
  $rels = Invoke-RestMethod -Headers $headers "$apiBase/releases?per_page=100"
  $rel = $rels | Where-Object { $_.tag_name -eq $Tag } | Select-Object -First 1
  if ($rel) { break }
  Start-Sleep -Seconds 3
}
if (-not $rel) {
  Log "Release $Tag not found - creating a draft"
  $body = @{ tag_name = $Tag; name = $version; draft = $true } | ConvertTo-Json
  $rel = Invoke-RestMethod -Method Post -Headers $headers -Body $body -ContentType "application/json" "$apiBase/releases"
}
$relId = $rel.id

# --- upload assets by ID (idempotent) ---------------------------------------
$dist = Join-Path $RepoDir "dist"
$exe = Get-ChildItem "$dist\*.exe" -ErrorAction Stop | Select-Object -First 1
if (-not $exe) { throw "No .exe found in $dist" }
$exeName = $exe.Name -replace ' ', '-'   # matches latest.yml's url
$uploads = @(
  @{ Path = $exe.FullName;                  Name = $exeName;            Type = "application/octet-stream" }
  @{ Path = "$($exe.FullName).blockmap";    Name = "$exeName.blockmap"; Type = "application/octet-stream" }
  @{ Path = (Join-Path $dist "latest.yml"); Name = "latest.yml";        Type = "text/yaml" }
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

Log "Windows assets uploaded to $Tag (id $relId). Publish when both platforms are in:"
Log "  gh release edit $Tag --draft=false --latest"
