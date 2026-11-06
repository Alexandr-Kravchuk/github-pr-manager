import fs from "node:fs";
import path from "node:path";

// Your PRs that an SDLC orchestrator run drives. The orchestrator
// (`run_sdlc`, `.sdlc/` in the repository) takes a Jira task through
// implementation, a published PR, its own review and fix of the findings, the
// reviewers' remarks and CI — so the PR agent leaves such a PR alone: a
// self-review would repeat the run's review stage, and two agents answering
// the same threads would edit and push the same branch.
//
// A run's state is `.sdlc/state/<KEY>.json` in a checkout, or in one of its
// worktrees (`.claude/worktrees/*`, where a run often works); the PR it
// published is in it as a URL, with the run's `lifecycle_status` and
// `current_stage`. Not always the PR's own checkout: a metarepo's run
// (`mode = "metarepo"`) publishes PRs to its member repositories and keeps
// its state at home — so every checkout the app knows that has a `.sdlc` is
// looked through. Read-only, and cached by file time: the state files are
// rewritten at every step of a run, read on the agent's snapshots.

export interface OrchestratorRun {
  /** The Jira key the run drives (its state file's name). */
  key: string;
  stage: string | null;
  status: string | null;
}

/** A run that has ended no longer holds its PR. */
const ENDED: ReadonlySet<string> = new Set(["completed", "aborted", "exited", "cancelled", "canceled", "failed", "not_needed", "released"]);

interface CacheEntry {
  mtimeMs: number;
  text: string;
  run: OrchestratorRun | null;
}
const cache = new Map<string, CacheEntry>();

function stateDirs(checkout: string): string[] {
  const dirs = [path.join(checkout, ".sdlc", "state")];
  const wt = path.join(checkout, ".claude", "worktrees");
  try {
    for (const name of fs.readdirSync(wt)) dirs.push(path.join(wt, name, ".sdlc", "state"));
  } catch {
    // No worktrees.
  }
  return dirs;
}

function readRun(file: string): CacheEntry | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit;
  let text = "";
  let run: OrchestratorRun | null = null;
  try {
    text = fs.readFileSync(file, "utf8");
    const raw = JSON.parse(text) as { lifecycle_status?: unknown; current_stage?: unknown };
    run = {
      key: path.basename(file, ".json"),
      stage: typeof raw.current_stage === "string" ? raw.current_stage : null,
      status: typeof raw.lifecycle_status === "string" ? raw.lifecycle_status : null,
    };
  } catch {
    // Mid-write, or not a run's state: skipped this time.
  }
  const entry = { mtimeMs: stat.mtimeMs, text, run };
  cache.set(file, entry);
  return entry;
}

/**
 * The checkouts that can hold a run's state: the PR's own, every repository
 * folder set in Settings › Claude, and each folder under the projects folder
 * that has a `.sdlc` — a metarepo's runs live there, not with the PRs they publish.
 */
export function orchestratorRoots(own: string | null, claude: { projectsRoot: string; repoPaths: Record<string, string> }): string[] {
  const roots = new Set<string>();
  if (own) roots.add(own);
  for (const p of Object.values(claude.repoPaths)) if (p) roots.add(p);
  const base = claude.projectsRoot.trim();
  if (base) {
    try {
      for (const name of fs.readdirSync(base)) {
        const dir = path.join(base, name);
        if (fs.existsSync(path.join(dir, ".sdlc"))) roots.add(dir);
      }
    } catch {
      // No projects folder.
    }
  }
  return [...roots].filter((dir) => fs.existsSync(path.join(dir, ".sdlc")) || dir === own);
}

/**
 * The live orchestrator run that published this PR, or null. Only a run's own
 * state file counts (`<KEY>.json`, not its side files), and only while the run
 * hasn't ended.
 */
export function orchestratorRunFor(checkouts: string | readonly string[], prUrl: string): OrchestratorRun | null {
  // The URL as a whole JSON string: …/pull/37 must not match …/pull/371.
  const needle = JSON.stringify(prUrl.replace(/\/$/, ""));
  const dirs = (typeof checkouts === "string" ? [checkouts] : checkouts).flatMap(stateDirs);
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^[A-Z][A-Z0-9]+-\d+\.json$/.test(name)) continue;
      const entry = readRun(path.join(dir, name));
      if (!entry?.run || !entry.text.includes(needle)) continue;
      if (entry.run.status && ENDED.has(entry.run.status.toLowerCase())) continue;
      return entry.run;
    }
  }
  return null;
}

/** "the SDLC orchestrator runs ENG-1 (stage review)" — the Idle reason. */
export function describeOrchestratorRun(run: OrchestratorRun): string {
  return `the SDLC orchestrator runs ${run.key}${run.stage ? ` (stage ${run.stage.replace(/_/g, " ")})` : ""} — the agent leaves it to it`;
}
