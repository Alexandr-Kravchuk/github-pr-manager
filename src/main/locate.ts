// One location fix for the header's weather, from the OS itself.
//
// Not navigator.geolocation: in Electron that calls Google's paid
// geolocation web service (it needs an API key with billing) and, without
// one, times out with no prompt at all. Instead:
//  - macOS: the prd-locate helper app (native/macos-locate, built by
//    scripts/build-locate.mjs into Resources) asks Core Location. It runs as
//    its own bundle through `open`, since Location Services prompts only for a
//    bundle with a usage string; it prints one JSON line to the file `open`
//    redirects its stdout to.
//  - Windows: GeoCoordinateWatcher (System.Device) in Windows PowerShell, which
//    goes through Windows' location settings.
//  - anything else: unavailable.
//
// `unavailable` (no helper, no PowerShell) and `timeout` (the prompt left
// unanswered) are not answers of the user's, so main does not record them.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LocateResult =
  | { status: "ok"; latitude: number; longitude: number }
  | { status: "denied" }
  | { status: "failed"; reason: string }
  | { status: "unavailable"; reason: string }
  | { status: "timeout" };

export type ExecFile = (file: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>;

const defaultExec: ExecFile = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve({ stdout: String(stdout) }),
    );
  });

/** The helper's (or the PowerShell script's) one JSON line → a result. */
export function parseLocateOutput(text: string): LocateResult {
  const line = text.trim().split(/\r?\n/).pop() ?? "";
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { status: "failed", reason: "The location helper gave no answer." };
  }
  const n = (v: unknown, lim: number): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= lim;
  switch (obj.status) {
    case "ok":
      return n(obj.latitude, 90) && n(obj.longitude, 180)
        ? { status: "ok", latitude: obj.latitude, longitude: obj.longitude }
        : { status: "failed", reason: "The location helper sent coordinates out of range." };
    case "denied":
      return { status: "denied" };
    case "disabled":
      return { status: "failed", reason: "Location Services are turned off." };
    case "timeout":
      return { status: "timeout" };
    default:
      return { status: "failed", reason: `Location error${typeof obj.code === "number" ? ` ${obj.code}` : ""}.` };
  }
}

/** Waits up to the helper's own prompt timeout (5 min) plus the fix. */
const MAC_TIMEOUT_MS = 6 * 60_000;
const WIN_TIMEOUT_MS = 90_000;

export async function locateMac(helperApp: string, exec: ExecFile = defaultExec): Promise<LocateResult> {
  if (!fs.existsSync(path.join(helperApp, "Contents", "MacOS", "prd-locate"))) {
    return { status: "unavailable", reason: "The location helper is missing from this build." };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prd-locate-"));
  const out = path.join(dir, "out.json");
  try {
    // -n a fresh instance, -g in the background, -W wait for it to quit.
    await exec("/usr/bin/open", ["-n", "-g", "-W", "--stdout", out, "--stderr", "/dev/null", helperApp], MAC_TIMEOUT_MS);
    return parseLocateOutput(fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "");
  } catch (e) {
    return { status: "failed", reason: (e as Error).message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Windows PowerShell 5.1 (System.Device is .NET Framework); prints the same JSON line. */
export const WINDOWS_LOCATE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Device
  $w = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::Default)
  [void]$w.TryStart($false, [TimeSpan]::FromSeconds(30))
  if ($w.Permission -eq [System.Device.Location.GeoPositionPermission]::Denied) { '{"status":"denied"}'; exit 0 }
  $deadline = (Get-Date).AddSeconds(45)
  while ($w.Position.Location.IsUnknown -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  $l = $w.Position.Location
  $w.Stop()
  if ($l.IsUnknown) { '{"status":"timeout"}'; exit 0 }
  $inv = [Globalization.CultureInfo]::InvariantCulture
  '{"status":"ok","latitude":' + $l.Latitude.ToString($inv) + ',"longitude":' + $l.Longitude.ToString($inv) + '}'
} catch {
  '{"status":"error"}'
}
`;

export async function locateWindows(exec: ExecFile = defaultExec): Promise<LocateResult> {
  const encoded = Buffer.from(WINDOWS_LOCATE_SCRIPT, "utf16le").toString("base64");
  const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const { stdout } = await exec(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], WIN_TIMEOUT_MS);
    return parseLocateOutput(stdout);
  } catch (e) {
    return { status: "unavailable", reason: (e as Error).message };
  }
}

export function locate(opts: { platform?: NodeJS.Platform; helperApp: string; exec?: ExecFile }): Promise<LocateResult> {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") return locateMac(opts.helperApp, opts.exec);
  if (platform === "win32") return locateWindows(opts.exec);
  return Promise.resolve({ status: "unavailable", reason: "Location is not supported on this system." });
}
