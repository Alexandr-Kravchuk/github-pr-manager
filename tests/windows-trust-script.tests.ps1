# Exercise the real installer script with isolated certificate-store operations.
$ErrorActionPreference = 'Stop'
$folder = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory $folder | Out-Null
$global:prdTrustEntries = [System.Collections.Generic.HashSet[string]]::new()
$global:prdTrustImports = 0
function Import-Certificate {
  param($FilePath, $CertStoreLocation)
  if ($CertStoreLocation -notin @('Cert:\CurrentUser\Root', 'Cert:\CurrentUser\TrustedPublisher')) {
    throw "Unexpected store: $CertStoreLocation"
  }
  $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($FilePath)
  $global:prdTrustEntries.Add("$CertStoreLocation\$($cert.Thumbprint)") | Out-Null
  $global:prdTrustImports++
}
function Test-Path {
  param($LiteralPath)
  if ($LiteralPath -like 'Cert:*') { return $global:prdTrustEntries.Contains($LiteralPath) }
  Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath
}
try {
  $source = Join-Path $PSScriptRoot '../build/windows-signing'
  Copy-Item "$source/Install-PR-Dashboard-Trust.ps1" $folder
  Copy-Item "$source/PR-Dashboard.cer" $folder
  $script = Join-Path $folder 'Install-PR-Dashboard-Trust.ps1'
  & $script
  if ($global:prdTrustImports -ne 2) { throw 'Expected both current-user stores to be imported' }
  & $script
  if ($global:prdTrustImports -ne 2) { throw 'Second run must not import duplicates' }
  $bytes = [IO.File]::ReadAllBytes((Join-Path $folder 'PR-Dashboard.cer'))
  $bytes[$bytes.Length - 1] = $bytes[$bytes.Length - 1] -bxor 1
  [IO.File]::WriteAllBytes((Join-Path $folder 'PR-Dashboard.cer'), $bytes)
  $refused = $false
  try { & $script 2>$null } catch {
    if ($_.Exception.Message -notlike '*fingerprint mismatch*') { throw }
    $refused = $true
  }
  if (-not $refused -or $global:prdTrustImports -ne 2) { throw 'Changed certificate must fail before importing' }
  Write-Host 'Trust-script tests passed: current-user imports, repeat run, tampered certificate refusal.'
} finally {
  Remove-Item $folder -Recurse -Force
  Remove-Variable prdTrustEntries, prdTrustImports -Scope Global
}
