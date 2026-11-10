// Draws a PR's change as Mermaid diagrams after a review or a brief: one short
// `claude -p` run of its own, apart from the review session. The review skill
// is left to review; this run gets the PR's title, what the review said it
// does and its diff, and answers once.
//
// The run has no tools, loads none of your settings, hooks or MCP servers
// (`--restricted --strict-mcp-config`), starts in a folder of the app's own
// (no repository CLAUDE.md), and saves no session — so it never appears among
// your sessions or binds to a PR's card. What it answers is filtered by
// `cleanDiagrams` (shared/agent-diagrams.ts) and checked in the renderer,
// whose real browser is the only place a flowchart parses.

import fs from "node:fs";

import { cleanDiagrams, DIAGRAM_SYSTEM_PROMPT, diagramPrompt, extractDiagrams } from "../../shared/agent-diagrams";
import { launcherEnv } from "../../shared/claude-launch";
import type { AgentItemDiagrams } from "../../shared/types";
import { hostFlag, type GhRunner } from "./publish";
import type { Spawner } from "./runner";

/** Parses each source in the renderer's mermaid: one answer per source, or null when no window could answer. */
export type MermaidChecker = (sources: string[]) => Promise<boolean[] | null>;

export const DRAW_TIMEOUT_MS = 240_000;

/** The drawing run's command line: one answer, no tools, nothing of yours loaded, nothing saved. */
export function diagramArgs(model: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--restricted",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--tools",
    "",
    "--system-prompt",
    DIAGRAM_SYSTEM_PROMPT,
    ...(model ? ["--model", model] : []),
  ];
}

/**
 * The link of a comment in the PR's conversation that carries a Mermaid
 * diagram already — whoever posted it — null when none does, undefined when
 * the comments could not be read.
 */
export async function existingDiagramUrl(gh: GhRunner, url: string, repo: string, n: number): Promise<string | null | undefined> {
  const r = await gh(["api", "--paginate", `repos/${repo}/issues/${n}/comments?per_page=100`, "--jq", '.[] | select(.body | test("```mermaid")) | .html_url', ...hostFlag(url)]);
  if (r.code !== 0) return undefined;
  return (
    r.stdout
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? null
  );
}

async function prDiff(gh: GhRunner, url: string, repo: string, n: number): Promise<string | null> {
  const r = await gh(["api", `repos/${repo}/pulls/${n}`, "-H", "Accept: application/vnd.github.v3.diff", ...hostFlag(url)], { timeoutMs: 90_000 });
  return r.code === 0 && r.stdout.trim() ? r.stdout : null;
}

interface OnceResult {
  text: string;
  costUsd?: number;
  error?: string;
}

/** One `claude -p` answer: the prompt in on stdin, the JSON result out. */
function runOnce(spawner: Spawner, args: string[], cwd: string, input: string, timeoutMs: number): Promise<OnceResult> {
  return new Promise((resolve) => {
    const child = spawner(args, cwd, { ...launcherEnv(process.env) });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (r: OnceResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ text: "", error: `no answer in ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out = (out + d).slice(-400_000)));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => (err = (err + d).slice(-4_000)));
    child.on("error", (e) => finish({ text: "", error: (e as Error).message }));
    // `close`, not `exit`: the answer may still be in the pipe when the process exits.
    child.on("close", (code: number | null) => {
      type Answer = { is_error?: unknown; result?: unknown; total_cost_usd?: unknown };
      const raw = ((): Answer | null => {
        try {
          const v: unknown = JSON.parse(out.trim());
          return typeof v === "object" && v !== null ? (v as Answer) : null;
        } catch {
          return null;
        }
      })();
      const costUsd = typeof raw?.total_cost_usd === "number" ? raw.total_cost_usd : undefined;
      if (!raw || typeof raw.result !== "string") {
        finish({ text: "", ...(costUsd !== undefined ? { costUsd } : {}), error: err.trim().split("\n").slice(-2).join(" ") || `exit ${code}` });
      } else if (raw.is_error === true) {
        finish({ text: "", ...(costUsd !== undefined ? { costUsd } : {}), error: raw.result.slice(0, 300) || "the run reported an error" });
      } else {
        finish({ text: raw.result, ...(costUsd !== undefined ? { costUsd } : {}) });
      }
    });
    child.stdin?.end(input);
  });
}

export interface DrawInput {
  url: string;
  repo: string;
  number: number;
  title: string;
  /** What the review or brief said the PR does, in a sentence. */
  summary?: string | null;
  model: string;
  /** A folder of the app's own to run in. */
  cwd: string;
}

export interface DrawDeps {
  gh: GhRunner;
  spawner: Spawner;
  check?: MermaidChecker;
  timeoutMs?: number;
}

export interface DrawOutcome {
  diagrams: AgentItemDiagrams;
  ms: number;
  costUsd?: number;
}

/**
 * The PR's diagrams: none when it carries one already (its link instead), or
 * when its diff can't be read, or when the run finds nothing worth drawing.
 * Never throws — a diagram is never worth failing a review over.
 */
export async function drawDiagrams(input: DrawInput, deps: DrawDeps): Promise<DrawOutcome> {
  const t0 = Date.now();
  const done = (diagrams: AgentItemDiagrams, costUsd?: number): DrawOutcome => ({ diagrams, ms: Date.now() - t0, ...(costUsd !== undefined ? { costUsd } : {}) });
  try {
    const existing = await existingDiagramUrl(deps.gh, input.url, input.repo, input.number);
    if (existing) return done({ list: [], checked: false, existingUrl: existing, note: "The PR has a Mermaid diagram already" });
    const diff = await prDiff(deps.gh, input.url, input.repo, input.number);
    if (!diff) return done({ list: [], checked: false, note: "Could not read the PR's diff" });
    fs.mkdirSync(input.cwd, { recursive: true });
    const run = await runOnce(deps.spawner, diagramArgs(input.model), input.cwd, diagramPrompt({ title: input.title, summary: input.summary, diff }), deps.timeoutMs ?? DRAW_TIMEOUT_MS);
    if (run.error) return done({ list: [], checked: false, note: `The drawing run failed: ${run.error}` }, run.costUsd);
    const { kept, dropped } = cleanDiagrams(extractDiagrams(run.text));
    const notes = [...dropped];
    let list = kept;
    let checked = false;
    if (list.length > 0 && deps.check) {
      const ok = await deps.check(list.map((d) => d.source)).catch(() => null);
      if (ok && ok.length === list.length) {
        checked = true;
        notes.push(...list.filter((_, i) => !ok[i]).map((d) => `${d.title}: it does not render`));
        list = list.filter((_, i) => ok[i]);
      }
    }
    const note = notes.length > 0 ? notes.join("; ") : list.length === 0 ? "Nothing worth drawing in this change" : undefined;
    return done({ list, checked, ...(note ? { note } : {}) }, run.costUsd);
  } catch (e) {
    return done({ list: [], checked: false, note: `Could not draw: ${(e as Error).message}` });
  }
}
