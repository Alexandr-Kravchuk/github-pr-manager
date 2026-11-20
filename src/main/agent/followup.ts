import fs from "node:fs";
import path from "node:path";

import { readTurnEnd, type TurnEnd } from "../../shared/agent-followup";
import { projectDirName } from "../claude-sessions";

// The file side of following a session you continued with "Open in Claude"
// (`shared/agent-followup.ts` decides what it means). Everything here is
// asynchronous: a transcript runs to megabytes, and main must not stall on it.

/** A transcript file, as last seen. */
export interface TranscriptStat {
  file: string;
  mtimeMs: number;
  size: number;
}

/** The tail read first; a turn's final message and what follows it fit in it many times over. */
const FIRST_TAIL = 1024 * 1024;
/** Never more than this of one transcript: a final message is never this far from the end. */
const MAX_TAIL = 32 * 1024 * 1024;

/**
 * The transcript of the session you continued in `cwd`: Claude Code keeps it
 * as `<config>/projects/<cwd as a name>/<session id>.jsonl` — `--resume` writes
 * on in the same file, a compaction too. A session forked from it gets a file
 * of its own in the same folder, and that folder belongs to the run alone (its
 * worktree), so the newest file there written after you continued is the one;
 * else the session's own. The folder is tried under `cwd` as given and as its
 * real path (macOS's /var is /private/var).
 */
export async function findTranscript(configDir: string, cwd: string, sessionId: string, sinceMs: number): Promise<TranscriptStat | null> {
  const names = new Set([projectDirName(cwd)]);
  try {
    names.add(projectDirName(await fs.promises.realpath(cwd)));
  } catch {
    // The folder is gone: its transcript may still be there under the name it had.
  }
  let best: TranscriptStat | null = null;
  for (const name of names) {
    const dir = path.join(configDir, "projects", name);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const own = entry === `${sessionId}.jsonl`;
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(path.join(dir, entry));
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (!own && st.mtimeMs <= sinceMs) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: path.join(dir, entry), mtimeMs: st.mtimeMs, size: st.size };
    }
  }
  return best;
}

/**
 * How the transcript ends, read from its tail: a growing window from the end
 * until a message of the conversation is in it, or the whole file is read.
 */
export async function readTranscriptEnd(stat: TranscriptStat): Promise<TurnEnd> {
  const fh = await fs.promises.open(stat.file, "r");
  try {
    let want = Math.min(stat.size, FIRST_TAIL);
    for (;;) {
      const start = stat.size - want;
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, start);
      let text = buf.subarray(0, bytesRead).toString("utf8");
      // A window from the middle starts inside a line: drop that piece.
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      const end = readTurnEnd(text);
      if (end.state !== "none" || want >= stat.size || want >= MAX_TAIL) return end;
      want = Math.min(stat.size, want * 4, MAX_TAIL);
    }
  } finally {
    await fh.close();
  }
}
