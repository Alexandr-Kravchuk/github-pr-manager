#requires -Version 5.1
<#
.SYNOPSIS
  Install the PR Dashboard public signing certificate for the current user.
.DESCRIPTION
  Keep this script beside PR-Dashboard.cer. Right-click it and choose
  Run with PowerShell. Windows may ask you to confirm trusting the certificate.
  No administrator rights are needed. The certificate's SHA-256 fingerprint is
  pinned here; a different certificate is refused before any trust is changed.
#>
$ErrorActionPreference = 'Stop'
try {
  $certPath = Join-Path $PSScriptRoot 'PR-Dashboard.cer'
  $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certPath)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $fingerprint = [BitConverter]::ToString($sha256.ComputeHash($cert.RawData)).Replace('-', '')
  } finally { $sha256.Dispose() }
  if ($fingerprint -ne '88318B490543030451A852253D414169BFEDC9288C099908F043AF425C17858F') {
    throw 'Certificate fingerprint mismatch. No trust was installed.'
  }
  if ($cert.HasPrivateKey) { throw 'Expected a public certificate without a private key.' }
  $now = Get-Date
  if ($now -lt $cert.NotBefore -or $now -gt $cert.NotAfter) {
    throw 'The signing certificate is not currently valid. Download the current release.'
  }
  Get-Command Import-Certificate -ErrorAction Stop | Out-Null
  Write-Host 'Publisher: Alex Kravchuk (self-signed PR Dashboard certificate)'
  Write-Host "SHA-256: $fingerprint"
  Write-Host 'Trust applies to code signed with this key, not only one installer.'
  Write-Host 'Check the fingerprint against the official project documentation before confirming Windows prompts.'
  foreach ($store in @('Cert:\CurrentUser\Root', 'Cert:\CurrentUser\TrustedPublisher')) {
    $entry = "$store\$($cert.Thumbprint)"
    if (-not (Test-Path -LiteralPath $entry)) {
      Import-Certificate -FilePath $certPath -CertStoreLocation $store | Out-Null
    }
    if (-not (Test-Path -LiteralPath $entry)) { throw "Certificate was not installed in $store." }
  }
  Write-Host 'Trust installed for this Windows account. You can now run the PR Dashboard installer.'
  Write-Host 'SmartScreen warnings may still appear.'
} catch {
  Write-Error "Could not install PR Dashboard trust: $($_.Exception.Message)" -ErrorAction Continue
  Write-Host 'If one store was already updated, follow WINDOWS-TRUST.md to remove trust if desired.'
  throw
}
