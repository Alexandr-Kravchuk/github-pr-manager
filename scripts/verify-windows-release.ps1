# Run after electron-builder, before uploading anything.
$ErrorActionPreference = 'Stop'
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
  (Resolve-Path 'build/windows-signing/PR-Dashboard.cer').Path)
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = "dist/PR Dashboard Setup $version.exe"
$app = 'dist/win-unpacked/PR Dashboard.exe'
foreach ($file in @($app, $installer)) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
    throw "Invalid or unexpected signing certificate on $file ($($signature.Status))"
  }
  if (-not $signature.TimeStamperCertificate) { throw "Missing timestamp on $file" }
}
# Trust files must be inside the signed installer payload as well as separate assets.
foreach ($name in @('PR-Dashboard.cer', 'Install-PR-Dashboard-Trust.ps1', 'WINDOWS-TRUST.md')) {
  $source = (Get-FileHash "build/windows-signing/$name" -Algorithm SHA256).Hash
  $packed = (Get-FileHash "dist/win-unpacked/windows-signing/$name" -Algorithm SHA256).Hash
  if ($source -ne $packed) { throw "Embedded trust file differs: $name" }
}
$feed = Get-Content dist/latest.yml -Raw
if ($feed -notmatch "(?m)^version: $([regex]::Escape($version))\s*$") { throw 'Wrong update-feed version' }
$updateConfig = Get-Content dist/win-unpacked/resources/app-update.yml -Raw
if ($updateConfig -notmatch 'Alex Kravchuk' -or $updateConfig -match 'verifyUpdateCodeSignature: false') {
  throw 'Update publisher verification is missing or disabled'
}
$destination = 'dist/windows-release'
New-Item -ItemType Directory -Force $destination | Out-Null
Get-ChildItem $destination -File | Remove-Item
foreach ($file in @($installer, "$installer.blockmap", 'dist/latest.yml')) {
  $name = (Split-Path $file -Leaf).Replace(' ', '-')
  Copy-Item -LiteralPath $file -Destination (Join-Path $destination $name)
}
Copy-Item build/windows-signing/PR-Dashboard.cer $destination
Copy-Item build/windows-signing/WINDOWS-TRUST.md $destination
Copy-Item build/windows-signing/Install-PR-Dashboard-Trust.ps1 $destination
Write-Host 'App and installer signatures, signer, timestamps and updater publisher verified.'
