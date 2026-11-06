import fs from "node:fs";
import path from "node:path";

import type { AgentItem, AgentScenario } from "../../shared/types";

// The agent's memory across restarts, in its own files under userData/agent —
// never in settings.json, whose validation must not be able to trip on it.
//   state.json — the ledger, today's run count and the agent's items (what it
//                ran, what waits for you, what it prepared in shadow);
//   log.jsonl  — one line per thing it did, trimmed to the retention.
// Writes are atomic (a temp file renamed over the old one) and serialized, so
// a crash mid-write can't leave a half-written ledger — the ledger is what
// stops the agent from posting the same review twice.

/** `dismissed`: taken out of the queue by you before it ran — not queued again for that head. */
export type LedgerState = "started" | "prepared" | "published" | "failed" | "dismissed";

export interface LedgerEntry {
  state: LedgerState;
  at: string;
  runId: string;
}

export type AgentItemRecord = AgentItem;

export interface AgentStoreData {
  version: 1;
  ledger: Record<string, LedgerEntry>;
  /** Local date ("YYYY-MM-DD") `runsToday` counts for. */
  day: string;
  runsToday: number;
  items: AgentItemRecord[];
  /** Shadow reviews you published exactly as prepared — the Shadow → On hint counts these. */
  acceptedUnchanged: number;
  /**
   * Drive attempts per PR id: an attempt is a run that ended in a push. Reset
   * when CI turns green or someone else pushes (the head is no longer the one
   * the agent pushed, `agentHead`).
   */
  drive: Record<string, { attempts: number; agentHead?: string }>;
  /** The last head the agent pushed to each of your PRs — a head that needs no self-review of its own. */
  pushedHeads: Record<string, string>;
  /** Paused as a whole (Board, companion, tray) — it stays paused across a restart. */
  paused: boolean;
}

export function emptyStore(day: string): AgentStoreData {
  return { version: 1, ledger: {}, day, runsToday: 0, items: [], acceptedUnchanged: 0, drive: {}, pushedHeads: {}, paused: false };
}

/** Reads state.json; a missing or broken file starts empty rather than failing the agent. */
export function readStore(file: string, day: string): AgentStoreData {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AgentStoreData>;
    if (raw?.version !== 1 || typeof raw.ledger !== "object" || !Array.isArray(raw.items)) return emptyStore(day);
    return {
      version: 1,
      ledger: raw.ledger ?? {},
      day: typeof raw.day === "string" ? raw.day : day,
      runsToday: typeof raw.runsToday === "number" ? raw.runsToday : 0,
      // Never from disk: a drive's push is checked against what the app took in memory before the session.
      items: raw.items.map((item) => {
        const { pushTo: _dropped, ...rest } = item as AgentItemRecord;
        return rest as AgentItemRecord;
      }),
      acceptedUnchanged: typeof raw.acceptedUnchanged === "number" ? raw.acceptedUnchanged : 0,
      drive: typeof raw.drive === "object" && raw.drive !== null ? raw.drive : {},
      pushedHeads: typeof raw.pushedHeads === "object" && raw.pushedHeads !== null ? raw.pushedHeads : {},
      paused: raw.paused === true,
    };
  } catch {
    return emptyStore(day);
  }
}

/** Writes through a temp file and a rename: the old file stays whole until the new one is. */
export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export interface AgentLogEntry {
  at: string;
  prNumber: number;
  repo: string;
  scenario: AgentScenario;
  runId: string;
  event: string;
  headOid?: string | null;
  sessionId?: string;
  detail?: string;
}

/** Keeps the log lines newer than the retention; malformed lines go too. */
export function pruneLog(text: string, keepAfterMs: number): string {
  return text
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        return Date.parse((JSON.parse(line) as AgentLogEntry).at) >= keepAfterMs;
      } catch {
        return false;
      }
    })
    .map((l) => `${l}\n`)
    .join("");
}

export interface AgentStore {
  data: AgentStoreData;
  /** Persists `data` (serialized with any write in flight). */
  save(): Promise<void>;
  /** Persists `data` now, synchronously — for the app's way out, which doesn't wait for a promise. */
  flush(): void;
  log(entry: AgentLogEntry): void;
  /** Drops log lines and finished items older than the retention. */
  prune(retentionDays: number, now: number): void;
}

export function openStore(dir: string, today: string): AgentStore {
  const stateFile = path.join(dir, "state.json");
  const logFile = path.join(dir, "log.jsonl");
  const data = readStore(stateFile, today);
  let chain: Promise<void> = Promise.resolve();
  const serialize = () => JSON.stringify(store.data, (key, value: unknown) => (key === "pushTo" ? undefined : value), 2);
  const store: AgentStore = {
    data,
    save() {
      // A drive's `pushTo` (where its push goes, the fingerprint and SSH
      // snapshot it is checked against) lives in memory only: a file on disk
      // is one a session that ran code could have rewritten. After a restart
      // a drive's Push asks for the run again.
      const text = serialize();
      chain = chain.then(() => writeFileAtomic(stateFile, text)).catch((e) => console.warn(`[agent] could not save state: ${(e as Error).message}`));
      return chain;
    },
    flush() {
      try {
        writeFileAtomic(stateFile, serialize());
      } catch (e) {
        console.warn(`[agent] could not save state: ${(e as Error).message}`);
      }
    },
    log(entry) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
      } catch (e) {
        console.warn(`[agent] could not write the log: ${(e as Error).message}`);
      }
    },
    prune(retentionDays, now) {
      const keepAfter = now - retentionDays * 86_400_000;
      try {
        writeFileAtomic(logFile, pruneLog(fs.readFileSync(logFile, "utf8"), keepAfter));
      } catch {
        // No log yet.
      }
      store.data.items = store.data.items.filter(
        (i) => !(i.state === "done" || i.state === "error") || Date.parse(i.finishedAt ?? i.queuedAt) >= keepAfter,
      );
      void store.save();
    },
  };
  return store;
}
