// Builds native/macos-locate into dist/native/prd-locate.app — the helper the
// header weather asks for a location fix on macOS (see main/locate.ts for why
// navigator.geolocation can't). Universal (arm64 + x86_64), ad-hoc signed so
// dev runs it; electron-builder re-signs it with the Developer ID on release.
// A no-op off macOS.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

if (process.platform !== "darwin") process.exit(0);

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const src = path.join(root, "native", "macos-locate");
const app = path.join(root, "dist", "native", "prd-locate.app");
const exe = path.join(app, "Contents", "MacOS", "prd-locate");

const inputs = ["main.swift", "Info.plist"].map((f) => path.join(src, f));
const newest = Math.max(...inputs.map((f) => fs.statSync(f).mtimeMs), fs.statSync(new URL(import.meta.url)).mtimeMs);
if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= newest) process.exit(0);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prd-locate-"));
try {
  const slices = ["arm64", "x86_64"].map((arch) => {
    const out = path.join(tmp, arch);
    execFileSync(
      "xcrun",
      ["swiftc", "-O", "-target", `${arch}-apple-macos11.0`, path.join(src, "main.swift"), "-o", out],
      { stdio: "inherit" },
    );
    return out;
  });
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  execFileSync("lipo", ["-create", ...slices, "-output", exe], { stdio: "inherit" });
  fs.copyFileSync(path.join(src, "Info.plist"), path.join(app, "Contents", "Info.plist"));
  execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "inherit" });
  console.log(`[build-locate] ${path.relative(root, app)}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
