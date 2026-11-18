import { execFile } from "node:child_process";

// electron-updater accepts a downloaded Windows installer only when Windows
// itself calls its signature Valid. Our release certificate is self-signed, so
// on a machine that never ran Install-PR-Dashboard-Trust.ps1 Windows answers
// "untrusted root" and every update is thrown away after its download.
//
// This adds exactly one accepted case on top of electron-updater's own check:
// the file's signature is intact, the only fault Windows finds is the untrusted
// root, and the signer is our certificate by its SHA-256. Anyone can make a
// self-signed certificate with our name; no one can sign with our key. Every
// other answer (Valid, a broken hash, no signature, another signer) goes to
// electron-updater's verifier unchanged.

/**
 * SHA-256 of build/windows-signing/PR-Dashboard.cer, the same value
 * Install-PR-Dashboard-Trust.ps1 pins. A certificate rotation changes all of
 * them in one release, or updates from the releases before it stop.
 */
export const PINNED_SIGNER_SHA256 = "88318B490543030451A852253D414169BFEDC9288C099908F043AF425C17858F";

/** electron-updater's `verifyUpdateCodeSignature`: null accepts, a string is the reason to refuse. */
export type VerifyUpdateCodeSignature = (publisherNames: string[], file: string) => Promise<string | null>;

// The file path arrives through the environment, never inside the command, so
// no file name can break out of the script. It is compared with the signed
// file's path inside PowerShell, where both are UTF-16: stdout is written in
// the console's OEM code page, so a path with letters outside ASCII would come
// back garbled. StatusMessage is localized, so the untrusted-root case is
// matched against the message Windows gives for CERT_E_UNTRUSTEDROOT
// (0x800B0109) in the same language.
export const SIGNATURE_PROBE = [
  "$f = $env:PRD_UPDATE_FILE",
  "$s = Get-AuthenticodeSignature -LiteralPath $f",
  "$sha = $null",
  "if ($s.SignerCertificate) {",
  "  $h = [Security.Cryptography.SHA256]::Create()",
  "  try { $sha = [BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData)).Replace('-', '') } finally { $h.Dispose() }",
  "}",
  "$same = [bool]$s.Path -and ([IO.Path]::GetFullPath($s.Path) -eq [IO.Path]::GetFullPath($f))",
  "$untrusted = ([ComponentModel.Win32Exception]::new(-2146762487)).Message",
  "[pscustomobject]@{ status = [int]$s.Status; untrustedRoot = ($s.StatusMessage -eq $untrusted); samePath = $same; sha256 = $sha } | ConvertTo-Json -Compress",
].join("\n");

const SIGNATURE_STATUS_UNKNOWN_ERROR = 1; // System.Management.Automation.SignatureStatus

/** Whether the probe's answer is our untouched installer under an untrusted root. */
export function isPinnedUntrustedRoot(stdout: string, pinned = PINNED_SIGNER_SHA256): boolean {
  let data: unknown;
  try {
    data = JSON.parse(stdout.trim());
  } catch {
    return false;
  }
  if (!data || typeof data !== "object") return false;
  const { status, untrustedRoot, samePath, sha256 } = data as Record<string, unknown>;
  if (status !== SIGNATURE_STATUS_UNKNOWN_ERROR || untrustedRoot !== true) return false;
  // The answer must be about the file we asked for (electron-updater checks the same).
  if (samePath !== true) return false;
  return typeof sha256 === "string" && sha256.toUpperCase() === pinned.toUpperCase();
}

/**
 * The environment the probe runs in: ours without PSModulePath — one inherited
 * from PowerShell 7 can keep Windows PowerShell from loading
 * Get-AuthenticodeSignature (electron-updater drops it for the same reason) —
 * plus the file to check.
 */
export function probeEnv(file: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (key.toUpperCase() !== "PSMODULEPATH") out[key] = value;
  out.PRD_UPDATE_FILE = file;
  return out;
}

/** Runs the probe on one file; resolves its stdout, or "" on any failure. */
export type SignatureProbe = (file: string) => Promise<string>;

export const runSignatureProbe: SignatureProbe = (file) =>
  new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-InputFormat", "None", "-Command", SIGNATURE_PROBE],
      { timeout: 20_000, windowsHide: true, env: probeEnv(file) },
      (error, stdout) => resolve(error ? "" : String(stdout)),
    );
  });

/**
 * Wraps electron-updater's verifier: our pinned certificate under an untrusted
 * root is accepted, everything else is decided by `fallback` as before.
 */
export function createPinnedVerifier(
  fallback: VerifyUpdateCodeSignature,
  probe: SignatureProbe = runSignatureProbe,
  pinned = PINNED_SIGNER_SHA256,
): VerifyUpdateCodeSignature {
  return async (publisherNames, file) => {
    if (isPinnedUntrustedRoot(await probe(file), pinned)) return null;
    return fallback(publisherNames, file);
  };
}
