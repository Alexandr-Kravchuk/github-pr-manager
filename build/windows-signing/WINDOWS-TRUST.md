# Trust PR Dashboard on Windows

Windows releases built with this setup are signed by **Alex Kravchuk** using a
self-signed code-signing certificate. This is a project certificate, not a
certificate issued by a public certificate authority. Trusting it is optional;
SmartScreen reputation warnings may still appear.

## Optional trust from the installer

At the end of an interactive installation, select **Trust this certificate for my
Windows account** and click **Finish**. The option is off by default. It launches
PowerShell as the desktop user and uses the public certificate embedded in the
installer. Confirm Windows' certificate prompt after checking the fingerprint
below. Read the success or error in the PowerShell window, then close it.

Only the current user's certificate stores are changed, including with an
all-users installation. If a non-elevated launch is unavailable, the script refuses
an elevated import; use the separate script from your normal account instead.
Silent installations and app updates do not run trust setup. Uninstalling the app
does not remove certificate trust; use the removal instructions below.

The first installer launch can still show SmartScreen: Windows checks the installer
before it can offer this option. Corporate policy can also prevent importing trust.

## Install trust with the PowerShell script

1. Download `Install-PR-Dashboard-Trust.ps1` and `PR-Dashboard.cer` from the same
   official release and save both in the same folder.
2. Right-click `Install-PR-Dashboard-Trust.ps1` and select **Run with PowerShell**
   (on Windows 11, this may be under **Show more options**).
3. The script checks the certificate's pinned SHA-256 fingerprint and validity
   before changing trust. Check the displayed fingerprint against this document,
   then accept the Windows certificate confirmation. Trust is installed only for
   your current account; administrator rights are not needed.
4. Run the PR Dashboard installer. Re-running the script skips trust already installed.

The script does not download files or change your execution policy. If Windows or
company policy blocks running downloaded scripts, use the manual steps below or ask
IT. A failed or cancelled import may leave trust in one store; use the removal
instructions below if you want to undo it. SmartScreen warnings may still appear.

## Install trust manually once per Windows account

1. Download `PR-Dashboard.cer` from the official release:
   https://github.com/Alexandr-Kravchuk/github-pr-manager/releases
2. Check its SHA-256 fingerprint against this value, preferably through a
   separately trusted copy of the project's documentation:

   ```text
   88318B490543030451A852253D414169BFEDC9288C099908F043AF425C17858F
   ```

   In PowerShell, from the download folder:

   ```powershell
   $certPath = (Resolve-Path .\PR-Dashboard.cer).Path
   $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certPath)
   $sha256 = [System.Security.Cryptography.SHA256]::Create()
   $fingerprint = [BitConverter]::ToString($sha256.ComputeHash($cert.RawData)).Replace('-', '')
   $sha256.Dispose()
   if ($fingerprint -ne '88318B490543030451A852253D414169BFEDC9288C099908F043AF425C17858F') {
     throw 'Certificate fingerprint mismatch; do not install it'
   }
   Import-Certificate -FilePath $certPath -CertStoreLocation Cert:\CurrentUser\Root
   Import-Certificate -FilePath $certPath -CertStoreLocation Cert:\CurrentUser\TrustedPublisher
   ```

   Accept the Windows certificate confirmation only after checking the fingerprint.
   These commands affect the current account and do not require administrator rights.
   On a managed computer, ask IT if policy prevents the import.
3. Check the downloaded installer before opening it:

   ```powershell
   $signature = Get-AuthenticodeSignature '.\PR-Dashboard-Setup-<version>.exe'
   $signature | Format-List Status, StatusMessage, SignerCertificate
   if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $cert.Thumbprint) {
     throw 'Installer signature is invalid or belongs to a different certificate'
   }
   ```

   Replace `<version>` with the downloaded version. Then run the installer normally.

Trusting this certificate trusts code signed with its private key, not just a
single installer. The public `.cer` contains no private key. Never import a `.pfx`
or a private key received with an installer. Certificate validity ends on
12 November 2031; rotation will require installing the replacement certificate.
Previously released unsigned installers do not acquire a signature retroactively.

## Remove trust

In the same PowerShell session (with `$cert` still set):

```powershell
Remove-Item "Cert:\CurrentUser\TrustedPublisher\$($cert.Thumbprint)"
Remove-Item "Cert:\CurrentUser\Root\$($cert.Thumbprint)"
```

To remove it later, open `certmgr.msc`, find **Alex Kravchuk** in Trusted Publishers
and Trusted Root Certification Authorities, verify the certificate fingerprint,
and delete that certificate from both stores.
