import { readFileSync } from "node:fs";
import path from "node:path";

const START = Date.now().toString(36);
let cached: string | null = null;

/**
 * A token that identifies the currently running build. It changes when a new
 * production build is deployed (`next build` writes a fresh `.next/BUILD_ID`),
 * which lets the client detect "I'm on an old build" and auto-reload — so open
 * tabs stay current across redeploys without a manual refresh.
 */
export function appVersion(): string {
  if (cached) return cached;
  try {
    cached = readFileSync(path.join(process.cwd(), ".next/BUILD_ID"), "utf8").trim();
  } catch {
    // Dev mode (no BUILD_ID) — fall back to the process start time.
    cached = `dev-${START}`;
  }
  return cached;
}
