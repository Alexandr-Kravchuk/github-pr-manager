import { execFileSync } from "node:child_process";

// GUI-launched macOS apps inherit a minimal PATH (login shells add Homebrew etc.
// via ~/.zprofile, but Finder/.app launches don't run a login shell). So `gh`
// resolves when the app is started from a terminal but NOT from the bundle —
// which makes token resolution fail with a misleading "not signed in". We fix
// that by merging the login shell's PATH + the usual locations at startup.

const COMMON_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

/** Best-effort PATH from the user's login shell (covers Homebrew, asdf/mise, MacPorts, nix). */
function loginShellPath(): string[] {
  if (process.platform === "win32") return [];
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    // Marker-wrapped so any profile chatter on stdout doesn't pollute the value.
    const out = execFileSync(shell, ["-l", "-c", 'printf "<<<%s>>>" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = out.match(/<<<([\s\S]*)>>>/);
    return match ? match[1].split(":").filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Ensures `process.env.PATH` includes the locations where CLIs like `gh` live,
 * so `child_process` can find them whether the app was launched from a terminal
 * or from the .app bundle. No-op on Windows (PATH is inherited normally there).
 */
export function ensureCliPath(): void {
  if (process.platform === "win32") return;
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (dir: string) => {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      ordered.push(dir);
    }
  };
  loginShellPath().forEach(add);
  (process.env.PATH || "").split(":").forEach(add);
  COMMON_BIN_DIRS.forEach(add);
  process.env.PATH = ordered.join(":");
}
