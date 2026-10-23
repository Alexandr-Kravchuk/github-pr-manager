import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeRemote } from "../shared/claude-launch";
import { claudeDesktopSessionUrl, focusTtyScript, promptPrKeys, prUrlKey } from "../shared/claude-sessions";
import type { ClaudeSessionInfo, FocusClaudeSessionResult } from "../shared/types";
import { expandHome, parseRemoteUrls } from "./claude-launch";

// The Claude Code sessions running on this machine, read from the files Claude
// Code itself keeps: `<config>/sessions/<pid>.json` — one per live process,
// with its status, folder and, for a Claude Desktop session, the Desktop's id —
// and the session's transcript, for the PR links the user sent it. Matching
// them to PRs is `shared/claude-sessions.ts`.

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Desktop's id for a Code session; it goes into a `claude://` link, so nothing else passes. */
const HOST_SESSION_ID_RE = /^local_[0-9a-zA-Z-]{1,100}$/;
/** Transcripts are read in pieces this size, so a long one never sits in memory whole. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** A line longer than this is dropped unread rather than buffered without end. */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Claude Code's config folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG_DIR ? expandHome(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude");
}

/** One registry file, checked: what this module uses of it. */
export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  /** "interactive", or "bg" for a session the `claude` session list runs in its own pty. */
  kind: string;
  entrypoint: string;
  hostSessionId?: string;
  name: string;
  status: ClaudeSessionInfo["status"];
  waitingFor?: string;
}

/** A registry file's JSON, or null when it isn't one this module can use. */
export function parseRegistryEntry(raw: unknown): RegistryEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.pid !== "number" || !Number.isInteger(r.pid) || r.pid <= 0) return null;
  if (typeof r.sessionId !== "string" || !SESSION_ID_RE.test(r.sessionId)) return null;
  if (typeof r.cwd !== "string" || r.cwd.length === 0) return null;
  // A spare is a process Claude Code starts ahead of the next session — no
  // session runs in it yet, but its folder could still match a PR's branch.
  if (r.spare === true) return null;
  const entry: RegistryEntry = {
    pid: r.pid,
    sessionId: r.sessionId,
    cwd: r.cwd,
    kind: typeof r.kind === "string" ? r.kind : "interactive",
    entrypoint: typeof r.entrypoint === "string" ? r.entrypoint : "",
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : path.basename(r.cwd),
    status: r.status === "busy" || r.status === "waiting" ? r.status : "idle",
  };
  if (typeof r.hostSessionId === "string" && HOST_SESSION_ID_RE.test(r.hostSessionId)) {
    entry.hostSessionId = r.hostSessionId;
  }
  if (entry.status === "waiting" && typeof r.waitingFor === "string" && r.waitingFor) {
    entry.waitingFor = r.waitingFor;
  }
  return entry;
}

/**
 * What "switch to it" can open for this session. A `bg` session keeps running
 * after its terminal closes: it lives in a pty of Claude Code's own daemon, so
 * no terminal tab has its tty.
 */
export function sessionWhere(
  entry: Pick<RegistryEntry, "kind" | "entrypoint" | "hostSessionId">,
): ClaudeSessionInfo["where"] {
  if (entry.entrypoint === "claude-desktop" && entry.hostSessionId) return "desktop";
  if (entry.entrypoint === "cli" && entry.kind !== "bg") return "terminal";
  return "background";
}

/**
 * Whether the process is alive. Claude Code deletes its registry file on exit,
 * but a crashed or killed one leaves the file behind.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists, it just isn't ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The transcript folder Claude Code names after a working folder. */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The branch checked out in `cwd` and its repository's remote URLs. Walks up
 * to the enclosing checkout; a linked worktree's `.git` is a file pointing at
 * its git dir, whose `commondir` leads to the config with the remotes.
 */
export function gitInfo(cwd: string): { branch: string | null; remotes: string[] } {
  const read = (p: string): string => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return "";
    }
  };
  let dir = path.resolve(cwd);
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat) {
      let gitDir = dotGit;
      if (stat.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(read(dotGit));
        if (!m) return { branch: null, remotes: [] };
        gitDir = path.resolve(dir, m[1]);
      }
      const common = read(path.join(gitDir, "commondir")).trim();
      const commonDir = common ? path.resolve(gitDir, common) : gitDir;
      const head = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(read(path.join(gitDir, "HEAD")));
      return { branch: head ? head[1] : null, remotes: parseRemoteUrls(read(path.join(commonDir, "config"))) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { branch: null, remotes: [] };
    dir = parent;
  }
}

/** How far a session's transcript has been read, and the PR links found so far. */
interface TranscriptState {
  file: string | null;
  offset: number;
  carry: Buffer;
  prKeys: Set<string>;
}

/** Reads what was appended to the transcript since the last scan. */
async function readTranscript(state: TranscriptState): Promise<void> {
  if (!state.file) return;
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(state.file, "r");
  } catch {
    return;
  }
  try {
    const { size } = await handle.stat();
    if (size < state.offset) {
      // Rewritten from the start — read it again.
      state.offset = 0;
      state.carry = Buffer.alloc(0);
      state.prKeys.clear();
    }
    while (state.offset < size) {
      const buf = Buffer.alloc(Math.min(CHUNK_BYTES, size - state.offset));
      const { bytesRead } = await handle.read(buf, 0, buf.length, state.offset);
      if (bytesRead <= 0) break;
      state.offset += bytesRead;
      // Split on the last newline in bytes, so a character cut by the chunk
      // edge is decoded whole on the next pass.
      const data = state.carry.length ? Buffer.concat([state.carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const end = data.lastIndexOf(0x0a);
      if (end < 0) {
        state.carry = data.length > MAX_LINE_BYTES ? Buffer.alloc(0) : Buffer.from(data);
        continue;
      }
      state.carry = Buffer.from(data.subarray(end + 1));
      for (const line of data.toString("utf8", 0, end).split("\n")) {
        for (const key of promptPrKeys(line)) state.prKeys.add(key);
      }
    }
  } finally {
    await handle.close();
  }
}

/** Where the session's transcript is: under its folder's name, else found by its id. */
function findTranscript(projectsDir: string, entry: RegistryEntry): string | null {
  const name = `${entry.sessionId}.jsonl`;
  const direct = path.join(projectsDir, projectDirName(entry.cwd), name);
  if (fs.existsSync(direct)) return direct;
  // Claude Code shortens very long folder names; look the file up instead.
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(projectsDir, d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Claude Desktop's data folder, which keeps a record of every Code session it has. */
export function claudeDesktopDir(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string {
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Claude");
  if (platform === "win32") return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude");
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "Claude");
}

/** One Desktop session record (`claude-code-sessions/<account>/<org>/local_….json`), checked. */
export interface DesktopRecord {
  /** Desktop's id, `local_…` — what its link opens. */
  sessionId: string;
  /** Claude Code's session id inside it, when Desktop recorded one. */
  cliSessionId: string | null;
  title: string;
  isArchived: boolean;
  /** A run of a scheduled task (a routine) — it touches many PRs at once. */
  scheduled: boolean;
  /** The PRs Desktop bound to the session — the ones it opened or worked on. */
  prKeys: string[];
  lastActivityAt: number;
}

/** A Desktop session record's JSON, or null when it isn't one this module can use. */
export function parseDesktopRecord(raw: unknown): DesktopRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.sessionId !== "string" || !HOST_SESSION_ID_RE.test(r.sessionId)) return null;
  const prKeys = new Set<string>();
  if (Array.isArray(r.prs)) {
    for (const pr of r.prs) {
      const url = typeof pr === "object" && pr !== null ? (pr as Record<string, unknown>).url : null;
      const key = typeof url === "string" ? prUrlKey(url) : null;
      if (key) prKeys.add(key);
    }
  }
  return {
    sessionId: r.sessionId,
    cliSessionId: typeof r.cliSessionId === "string" && SESSION_ID_RE.test(r.cliSessionId) ? r.cliSessionId : null,
    title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : r.sessionId,
    isArchived: r.isArchived === true,
    scheduled: typeof r.scheduledTaskId === "string" && r.scheduledTaskId.length > 0,
    prKeys: [...prKeys].sort(),
    lastActivityAt: typeof r.lastActivityAt === "number" ? r.lastActivityAt : 0,
  };
}

/** Only records written within this window are read: thousands of old ones pile up. */
const DESKTOP_RECENT_MS = 14 * 24 * 60 * 60 * 1000;
/** How often the whole folder is listed again; between listings only known records are checked. */
const DESKTOP_LIST_EVERY_MS = 60_000;

async function statOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

async function readdirOrEmpty(p: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(p);
  } catch {
    return [];
  }
}

/**
 * Claude Desktop's session records, re-read only when a file changed. Desktop
 * pauses an idle session — stops its process to stay under its cap of live
 * ones, or when memory runs low — without archiving it, so a session with no
 * process can still be one click away; these records are how it is found.
 */
function createDesktopStore(dir: string, now: () => number) {
  const root = path.join(dir, "claude-code-sessions");
  /** Every record file at the last listing: Desktop id → path and mtime. */
  let known = new Map<string, { path: string; mtimeMs: number }>();
  let orgDirs: string[] = [];
  let listedAt = -Infinity;
  const cache = new Map<string, { mtimeMs: number; record: DesktopRecord | null }>();

  async function list(t: number): Promise<void> {
    const next = new Map<string, { path: string; mtimeMs: number }>();
    const dirs: string[] = [];
    for (const account of await readdirOrEmpty(root)) {
      for (const org of await readdirOrEmpty(path.join(root, account))) dirs.push(path.join(root, account, org));
    }
    for (const d of dirs) {
      const names = (await readdirOrEmpty(d)).filter((f) => f.startsWith("local_") && f.endsWith(".json"));
      const stats = await Promise.all(names.map((f) => statOrNull(path.join(d, f))));
      names.forEach((f, i) => {
        const st = stats[i];
        if (st && t - st.mtimeMs < DESKTOP_RECENT_MS) next.set(f.slice(0, -".json".length), { path: path.join(d, f), mtimeMs: st.mtimeMs });
      });
    }
    known = next;
    orgDirs = dirs;
    listedAt = t;
    for (const id of [...cache.keys()]) if (!known.has(id)) cache.delete(id);
  }

  return {
    /** The recent records, plus the record of every live Desktop session in `liveIds`. */
    async refresh(liveIds: ReadonlySet<string>): Promise<DesktopRecord[]> {
      const t = now();
      const listed = t - listedAt >= DESKTOP_LIST_EVERY_MS;
      if (listed) await list(t);
      // A session started since the last listing is live already — look its file up by name.
      for (const id of liveIds) {
        if (known.has(id)) continue;
        for (const d of orgDirs) {
          const p = path.join(d, `${id}.json`);
          const st = await statOrNull(p);
          if (st) {
            known.set(id, { path: p, mtimeMs: st.mtimeMs });
            break;
          }
        }
      }
      const records: DesktopRecord[] = [];
      for (const [id, file] of known) {
        const cached = cache.get(id);
        // An archived or scheduled record is shown by nothing; the next listing re-checks it.
        const settled = cached?.record && (cached.record.isArchived || cached.record.scheduled) && !liveIds.has(id);
        let mtimeMs = file.mtimeMs;
        if (!listed && !settled) {
          const st = await statOrNull(file.path);
          if (!st) {
            known.delete(id);
            cache.delete(id);
            continue;
          }
          mtimeMs = st.mtimeMs;
        }
        let record = cached?.record ?? null;
        if (!cached || cached.mtimeMs !== mtimeMs) {
          try {
            record = parseDesktopRecord(JSON.parse(await fs.promises.readFile(file.path, "utf8")));
            cache.set(id, { mtimeMs, record });
          } catch {
            // Caught mid-write — keep what was read before and try again next scan.
          }
        }
        if (record) records.push(record);
      }
      return records;
    },
  };
}

function execText(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
  });
}

/**
 * Scans the running sessions; keeps how far each transcript was read, so a
 * scan reads only what the sessions wrote since the previous one.
 */
export function createClaudeSessionScanner(
  opts: {
    configDir?: string;
    desktopDir?: string;
    isAlive?: (pid: number) => boolean;
    now?: () => number;
  } = {},
) {
  const alive = opts.isAlive ?? isAlive;
  const transcripts = new Map<string, TranscriptState>();
  const desktop = createDesktopStore(opts.desktopDir ?? claudeDesktopDir(), opts.now ?? Date.now);
  let entries = new Map<string, RegistryEntry>();
  /** Paused Desktop sessions of the last scan: session id → Desktop's id. */
  let paused = new Map<string, string>();
  let inFlight: Promise<ClaudeSessionInfo[]> | null = null;

  async function scanOnce(): Promise<ClaudeSessionInfo[]> {
    const configDir = opts.configDir ?? claudeConfigDir();
    const registryDir = path.join(configDir, "sessions");
    let files: string[];
    try {
      files = (await fs.promises.readdir(registryDir)).filter((f) => f.endsWith(".json"));
    } catch {
      files = [];
    }
    const live = new Map<string, RegistryEntry>();
    for (const f of files) {
      let entry: RegistryEntry | null;
      try {
        entry = parseRegistryEntry(JSON.parse(await fs.promises.readFile(path.join(registryDir, f), "utf8")));
      } catch {
        // Being rewritten right now, or not JSON — the next scan reads it again.
        continue;
      }
      if (entry && alive(entry.pid)) live.set(entry.sessionId, entry);
    }
    entries = live;
    for (const id of [...transcripts.keys()]) if (!live.has(id)) transcripts.delete(id);

    const liveHosts = new Set<string>();
    for (const e of live.values()) if (e.hostSessionId) liveHosts.add(e.hostSessionId);
    let records: DesktopRecord[] = [];
    try {
      records = await desktop.refresh(liveHosts);
    } catch {
      // Desktop not installed, or its folder unreadable — live sessions still show.
    }
    const byHost = new Map(records.map((r) => [r.sessionId, r]));

    const projectsDir = path.join(configDir, "projects");
    const sessions: ClaudeSessionInfo[] = [];
    for (const entry of live.values()) {
      const record = entry.hostSessionId ? byHost.get(entry.hostSessionId) : undefined;
      // Archiving stops the process; this skips the seconds before it is gone.
      if (record?.isArchived) continue;
      let state = transcripts.get(entry.sessionId);
      if (!state) {
        state = { file: null, offset: 0, carry: Buffer.alloc(0), prKeys: new Set() };
        transcripts.set(entry.sessionId, state);
      }
      // A new session writes its transcript only after the first prompt.
      if (!state.file) state.file = findTranscript(projectsDir, entry);
      await readTranscript(state);
      const git = gitInfo(entry.cwd);
      // A routine's run touches many PRs; it counts only by what it was sent.
      const desktopPrs = record && !record.scheduled ? record.prKeys : [];
      const info: ClaudeSessionInfo = {
        id: entry.sessionId,
        name: record?.title ?? entry.name,
        status: entry.status,
        where: sessionWhere(entry),
        prKeys: [...new Set([...state.prKeys, ...desktopPrs])].sort(),
        repoKeys: [...new Set(git.remotes.map(normalizeRemote).filter((k): k is string => k !== null))].sort(),
        branch: git.branch,
      };
      if (entry.waitingFor) info.waitingFor = entry.waitingFor;
      sessions.push(info);
    }

    // Paused: in Desktop, not archived, no process. Matched by the PRs Desktop
    // bound to them only — their folder is often a shared checkout whose
    // branch has moved on since, so a branch match would be a guess.
    const nextPaused = new Map<string, string>();
    for (const r of records) {
      if (r.isArchived || r.scheduled || liveHosts.has(r.sessionId) || r.prKeys.length === 0) continue;
      const id = r.cliSessionId ?? r.sessionId.slice("local_".length);
      if (!SESSION_ID_RE.test(id) || live.has(id)) continue;
      nextPaused.set(id, r.sessionId);
      sessions.push({
        id,
        name: r.title,
        status: "paused",
        where: "desktop",
        prKeys: r.prKeys,
        repoKeys: [],
        branch: null,
        lastActivityAt: r.lastActivityAt,
      });
    }
    paused = nextPaused;
    return sessions.sort((a, b) => a.id.localeCompare(b.id));
  }

  return {
    /** The running sessions. Concurrent calls share one scan. */
    scan(): Promise<ClaudeSessionInfo[]> {
      inFlight ??= scanOnce().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    /**
     * Brings the session to the front: the Desktop session through its link
     * (`openUrl` is Electron's `shell.openExternal`, injected so this module
     * stays Electron-free), a CLI session by the terminal tab on its tty.
     */
    async focus(
      sessionId: string,
      deps: { openUrl: (url: string) => Promise<void>; platform?: NodeJS.Platform },
    ): Promise<FocusClaudeSessionResult> {
      const entry = entries.get(sessionId);
      // Desktop opens its session whether or not a process runs it — opening
      // a paused one resumes it.
      const hostSessionId = entry && sessionWhere(entry) === "desktop" ? entry.hostSessionId : paused.get(sessionId);
      if (hostSessionId) {
        try {
          await deps.openUrl(claudeDesktopSessionUrl(hostSessionId));
          return { ok: true };
        } catch (e) {
          return { ok: false, error: `Could not open Claude Desktop: ${(e as Error).message}` };
        }
      }
      if (!entry || !alive(entry.pid)) return { ok: false, error: "This Claude session is no longer running." };
      const where = sessionWhere(entry);
      if (where === "background") {
        return { ok: false, error: `“${entry.name}” runs in the background — it has no window to switch to.` };
      }
      if ((deps.platform ?? process.platform) !== "darwin") {
        return { ok: false, error: `Switching to a terminal is supported on macOS only. The session runs in ${entry.cwd}.` };
      }
      let tty: string;
      try {
        tty = await execText("ps", ["-o", "tty=", "-p", String(entry.pid)]);
      } catch (e) {
        return { ok: false, error: `Could not look the session's terminal up: ${(e as Error).message}` };
      }
      if (!/^[\w/.-]+$/.test(tty) || tty === "??") {
        return { ok: false, error: `“${entry.name}” has no terminal to switch to.` };
      }
      const device = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
      let denied = false;
      for (const app of ["iterm", "terminal"] as const) {
        try {
          const out = await execText("osascript", focusTtyScript(app, device).flatMap((l) => ["-e", l]));
          if (out === "ok") return { ok: true };
        } catch (e) {
          // Not installed (the script does not compile), or Automation access
          // denied (-1743) — try the other one either way.
          if (/-1743/.test((e as Error).message)) denied = true;
        }
      }
      return {
        ok: false,
        error: denied
          ? "PR Dashboard is not allowed to control the terminal — allow it in System Settings → Privacy & Security → Automation."
          : `Could not find the iTerm2 or Terminal tab of “${entry.name}” (${device}).`,
      };
    },
  };
}
