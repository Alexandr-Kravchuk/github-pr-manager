import fs from "node:fs";
import path from "node:path";

import type { AgentItem, AgentScenario } from "../../shared/types";
import type { BoardMark } from "./journal";

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
  /**
   * Where each PR's card stood on the Board when the journal last looked
   * (`journal.ts`): kept across a restart, so a card that moved while the app
   * was closed is logged as one move. Absent until the journal's first look.
   */
  board?: Record<string, BoardMark>;
  /**
   * Re-approve / re-ask: what the check found for each PR head it looked at
   * (`reapprove.ts`), by ledger key — so a head is read once, across a
   * restart. Dropped once its PR leaves the dashboard.
   */
  reapprove?: Record<string, ReapproveMark>;
  /**
   * Re-review after a push alone: whether the new head was the reviewed change
   * on a new base (`sameChangeOnNewBase`), by `…|rereview|<head>|base` key —
   * read once per head. Dropped once its PR leaves the dashboard.
   */
  baseOnly?: Record<string, BaseOnlyMark>;
}

export interface BaseOnlyMark {
  verdict: "same" | "changed";
  /** The head of your review it was compared with. */
  oldHead: string;
  /** The base it holds for: the PR retargeted since, it is looked at again. */
  baseRefName: string;
  note: string;
  at: string;
}

export interface ReapproveMark {
  verdict: "same" | "pass";
  logins?: string[];
  oldHead?: string;
  note: string;
  at: string;
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
      ...(typeof raw.board === "object" && raw.board !== null && !Array.isArray(raw.board) ? { board: raw.board } : {}),
      ...(typeof raw.reapprove === "object" && raw.reapprove !== null && !Array.isArray(raw.reapprove) ? { reapprove: raw.reapprove } : {}),
      ...(typeof raw.baseOnly === "object" && raw.baseOnly !== null && !Array.isArray(raw.baseOnly) ? { baseOnly: raw.baseOnly } : {}),
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

/**
 * What a log line is about (`journal.ts` has the full list of events):
 * - `run`    — a run's own steps: queued, started, its end with time, cost and tokens, published, pushed, merged;
 * - `item`   — an item's state changed (queued → working → needsYou → done), with how long the old state lasted;
 * - `board`  — a PR's card moved to another column, or got another button, with how long it stood where it was;
 * - `plan`   — why the agent leaves a PR alone changed, or what holds the queue changed;
 * - `action` — something you did: a button, a menu, the tray — with what came of it;
 * - `agent`  — the agent itself: start, stop, settings changed.
 * Lines written before kinds existed have none: they are `run` lines.
 */
export type AgentLogKind = "run" | "item" | "board" | "plan" | "action" | "agent";

export interface AgentLogEntry {
  at: string;
  kind: AgentLogKind;
  event: string;
  prId?: string;
  prNumber?: number;
  repo?: string;
  scenario?: AgentScenario;
  runId?: string;
  headOid?: string | null;
  sessionId?: string;
  detail?: string;
  /** A change's two ends: states, columns, reasons; null where there was none (a new card) or is none (it left). */
  from?: string | null;
  to?: string | null;
  /** How long it took, or how long the `from` side lasted. */
  ms?: number;
  /** The rest, by event: a run's stats, a card's lane and button, an action's arguments. */
  data?: Record<string, unknown>;
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

/**
 * `beforeSave` runs at the start of every save and flush, before the state is
 * written — where the journal compares what changed and writes its lines, so
 * the state on disk and the log agree.
 */
export function openStore(dir: string, today: string, beforeSave?: () => void): AgentStore {
  const stateFile = path.join(dir, "state.json");
  const logFile = path.join(dir, "log.jsonl");
  const data = readStore(stateFile, today);
  let chain: Promise<void> = Promise.resolve();
  const serialize = () => {
    try {
      beforeSave?.();
    } catch (e) {
      // The journal is best-effort: it never stops the state being saved.
      console.warn(`[agent] journal: ${(e as Error).message}`);
    }
    return JSON.stringify(store.data, (key, value: unknown) => (key === "pushTo" ? undefined : value), 2);
  };
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
      // A card that kept its worktree for work in it stays while it does: dropped, nothing would ever free the folder.
      store.data.items = store.data.items.filter(
        (i) => !(i.state === "done" || i.state === "error") || i.localWork?.kept === true || Date.parse(i.finishedAt ?? i.queuedAt) >= keepAfter,
      );
      void store.save();
    },
  };
  return store;
}
