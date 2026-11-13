# Exercise the compiled NSIS payload and ensure unattended installs do not add trust.
$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "dist/PR Dashboard Setup $version.exe").Path
$folder = Join-Path $env:RUNNER_TEMP 'PR Dashboard installer smoke'
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
  (Resolve-Path 'build/windows-signing/PR-Dashboard.cer').Path)
function Read-UserTrust {
  @('Root', 'TrustedPublisher') | ForEach-Object {
    Test-Path "Cert:\CurrentUser\$_\$($cert.Thumbprint)"
  }
}
$before = @(Read-UserTrust)
try {
  foreach ($update in @('', '--updated')) {
    # /D must be the last argument and its path must not be quoted (NSIS syntax).
    $process = Start-Process -FilePath $installer -ArgumentList "/S /currentuser $update /D=$folder" -PassThru
    if (-not $process.WaitForExit(120000)) {
      $process.Kill()
      throw 'Silent installer timed out'
    }
    if ($process.ExitCode -ne 0) { throw "Installer exited $($process.ExitCode)" }
    foreach ($name in @('PR-Dashboard.cer', 'Install-PR-Dashboard-Trust.ps1', 'WINDOWS-TRUST.md')) {
      $source = (Get-FileHash "build/windows-signing/$name" -Algorithm SHA256).Hash
      $installed = (Get-FileHash (Join-Path $folder "windows-signing/$name") -Algorithm SHA256).Hash
      if ($source -ne $installed) { throw "Installed trust payload differs: $name" }
    }
    $after = @(Read-UserTrust)
    if (($before -join ',') -ne ($after -join ',')) { throw 'Silent installation changed current-user trust' }
  }
  Write-Host 'Compiled installer smoke passed: embedded trust files match; silent install and update leave current-user trust unchanged.'
} finally {
  $uninstaller = Join-Path $folder 'Uninstall PR Dashboard.exe'
  if (Test-Path $uninstaller) {
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S /currentuser' -PassThru
    if (-not $uninstall.WaitForExit(60000)) { $uninstall.Kill() }
  }
}
