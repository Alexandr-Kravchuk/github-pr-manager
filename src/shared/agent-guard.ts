import { DEFAULT_AGENT_TOOLS } from "./agent-defaults";
import { gitBashPath, isInsideDir, parsePublishCall, PUBLISH_USAGE, samePath, type PublishSub } from "./agent-publish";
import type { AgentRunKind } from "./types";

// The agent's PreToolUse guard: what an agent session may actually run,
// decided outside the model. `--allowedTools` is the first gate, but its rules
// are prefixes the user can edit — `Bash(git diff *)` also matches
// `git diff --output=~/.bashrc`, and a PR's own text can talk the model into
// trying that. This check runs on every tool call through the hook
// (`main/agent/hook.ts`), and nothing in Settings loosens it. Node-free and
// pure, so every rule is unit-tested without starting a session.
//
// Commands are judged by the argv the program will receive, not by their
// text: the command is split the way the shell would split it, and anything
// that would make the shell do more than run one program with literal
// arguments — operators, expansion, globs — refuses it outright. Text checks
// alone let `-XDELETE`, `'-X' POST`, or a PR file named `-XDELETE` matched by
// an unquoted `*` straight through.

/** An allow may carry the command to run in place of the one asked for (the review preflight's checked request). */
export type GuardDecision = { allow: true; command?: string } | { allow: false; reason: string };

/** The PR a run works on: its `gh` reads are held to it. */
export interface GuardPr {
  url: string;
  /** "owner/name", lower case. */
  repo: string;
  number: number;
  /** "github.com" or the GHE host, lower case — what `--hostname` may name. */
  host: string;
}

/** "https://host/owner/name/pull/7" → the PR it names, or null. */
export function guardPrFromUrl(url: string): GuardPr | null {
  const m = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\/?$/.exec(url.trim());
  return m
    ? { url: url.trim().replace(/\/$/, ""), repo: `${m[2]}/${m[3]}`.toLowerCase(), number: Number(m[4]), host: m[1].toLowerCase() }
    : null;
}

/**
 * What one run may reach, from the guard file the app writes for it (passed to
 * the hook): the folders it reads, a review's own publish wrapper (which
 * records, never posts — `agent-publish.ts`) and payload folder, and the
 * plugin folders a skill's Workflow script may come from.
 */
export interface GuardRun {
  /**
   * "full": a drive on your own PR that runs with your own Claude setup
   * (`checkFullToolUse`) — every tool and folder, minus writes to GitHub.
   * Absent: the isolated rules below.
   */
  mode?: "full";
  wrapperPath?: string;
  outDir?: string;
  /** Plugin folders: a Workflow may run a script from inside one of these, and from nowhere else. */
  workflowDirs?: string[];
  /** The wrapper subcommands this run may use (a drive run only replies); absent = all. */
  subs?: PublishSub[];
  /**
   * The run's working folder — the PR's worktree, or the after-merge run's
   * empty folder: a relative path, and a Grep or Glob with no path, mean it.
   * A drive changes files here only.
   */
  workDir?: string;
  /**
   * What the file-reading tools may read: the working folder, the payload
   * folder, the plugin folders the run mounted (a skill reads its own files and
   * its Workflow script there). Absent = nothing.
   */
  readDirs?: string[];
  /**
   * The session's id. Claude Code files what a session spills over — a tool
   * result too long to show, a background task's output — under
   * `<root>/<project>/<sessionId>/`, and tells the session to read it there.
   */
  sessionId?: string;
  /** Those roots: `projects` in Claude Code's config folder, its temp folder. */
  sessionRoots?: string[];
  /** The review skill's preflight, when a mounted plugin carries its helper (`checkPreflight`). */
  preflight?: GuardPreflight;
}

/**
 * The creatio-code-review skill starts each review with a deterministic
 * helper (`scripts/rereview-context.cjs`): an agent of its Workflow reads
 * `installed_plugins.json` to find the helper of the installed plugin, writes
 * the request to a file, runs `node <helper> < <file>`, and the helper writes
 * the PR's data to `<tmp>/creatio-rereview-payload-*`, which the later agents
 * read after `node <helper> --digest <dir>`. Each step is allowed here as
 * exactly that and nothing wider: one file read, these two command shapes,
 * reads of the helper's payload folders.
 */
export interface GuardPreflight {
  /** The helpers the run may start: the mounted plugins' own copies, absolute. */
  helpers: string[];
  /** Claude Code's `plugins/installed_plugins.json`, which the skill reads to find its helper. */
  installedPlugins: string;
  /**
   * The run's own temp folder (`TEMP`/`TMP`/`TMPDIR` of its session), where
   * the helper writes its payload folders — never your shared one, which
   * holds the payloads of every other review of the last day.
   */
  tmpDir: string;
}

/** What the helper names its payload folders. */
export const PREFLIGHT_PAYLOAD_PREFIX = "creatio-rereview-payload-";
/** Where a review skill keeps its preflight helper, inside its plugin. */
export const PREFLIGHT_HELPER = ["skills", "creatio-code-review", "scripts", "rereview-context.cjs"] as const;

/**
 * Inside a drive run's worktree, what it still may not change: git's own
 * folder and hooks, CI workflows, Claude Code and npm settings, git
 * attributes — each of them runs something or reroutes where it runs.
 */
const DRIVE_PROTECTED = [
  ".git",
  ".github",
  ".claude",
  ".husky",
  ".githooks",
  ".npmrc",
  ".gitattributes",
  ".gitmodules",
  ".gitconfig",
  // Hook managers read the commands they run from these.
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".lefthook.yaml",
  "lefthook-local.yml",
  ".pre-commit-config.yaml",
  ".huskyrc",
  ".huskyrc.json",
  ".huskyrc.js",
];

/** Whether a drive run may change `file`: inside its worktree, outside the protected names. */
export function checkDriveWrite(file: string, workDir: string): GuardDecision {
  if (!isInsideDir(file, workDir)) return deny(`This run changes files in its worktree (${workDir}) only.`);
  const rel = gitBashPath(file).slice(gitBashPath(workDir).replace(/\/+$/, "").length + 1);
  const parts = rel.split("/").map((p) => p.toLowerCase());
  const hit = parts.find((p) => DRIVE_PROTECTED.includes(p));
  if (hit) return deny(`${hit} runs or reroutes things; agent runs don't change it.`);
  return { allow: true };
}

/**
 * A Workflow runs JavaScript. A session reviewing someone's PR has that PR
 * checked out as its working folder, so a script the PR brings — a
 * `*.workflow.js` file, or one under `.claude/workflows/` shadowing a skill's
 * workflow name — must never run: only a script inside a plugin folder the
 * app mounted for the run does. Named workflows are refused for the same
 * reason; the review skill falls back to its script by path on its own.
 */
function checkWorkflow(input: unknown, run: GuardRun | null): GuardDecision {
  const i = (input ?? {}) as { scriptPath?: unknown };
  const script = typeof i.scriptPath === "string" ? i.scriptPath : "";
  const dirs = run?.workflowDirs ?? [];
  if (script && dirs.some((d) => isInsideDir(script, d))) return { allow: true };
  if (!script) return deny(`Agent runs start a skill's workflow by its script path — the skill's *.workflow.js${dirs.length ? `, inside ${dirs.join(" or ")}` : ""} — not by name, even where the skill says so.`);
  return deny(`Agent runs only run a skill's own workflow script${dirs.length ? ` — from ${dirs.join(" or ")}` : ""}, never one from the PR.`);
}

/** Runs that only read: reviews, briefs, re-reviews, the after-merge dry run. */
const READ_ONLY: ReadonlySet<AgentRunKind> = new Set(["review", "brief", "rereview", "afterMerge"]);

/** File tools that change files — never in a read-only run. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

/** Tools no agent run gets, whatever the list says: network, other shells. */
const NEVER = new Set(["WebFetch", "WebSearch", "PowerShell", "REPL"]);

/** Tools that read files: held to the run's own folders (`checkRead`). */
const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);

/**
 * Tools that reach nothing outside the session: a skill's instructions, a
 * deferred tool's schema, the session's task list, a sub-agent (whose own
 * calls come through this guard too), a Workflow agent's structured answer.
 * Any tool this file doesn't name is refused — one Claude Code adds later is
 * judged here before an agent run gets it, whatever the list in Settings says.
 */
const SESSION_TOOLS: ReadonlySet<string> = new Set(["Skill", "Agent", "ToolSearch", "TaskCreate", "TaskUpdate", "StructuredOutput"]);

/**
 * Where a path really leads, or null when that can't be told. The guard's own
 * check reads paths as written; the hook passes one that follows links on
 * disk, so a link in the PR's branch (`docs/k -> ~/.ssh/id_rsa`) is judged by
 * where it leads.
 */
export type RealPath = (p: string) => string | null;

const asWritten: RealPath = (p) => p;

function isAbsolutePath(p: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/])/.test(p);
}

/**
 * A path a file tool was given, as an absolute path with `.` segments
 * dropped, or why it can't be judged: `~` (Claude Code expands it to your home
 * folder), a network or device path (`\\host\share` — even looking one up
 * makes Windows sign in to that host), a colon anywhere but after a drive
 * letter (`C:x` is relative to a drive's own current folder), a relative path
 * with no working folder.
 */
function readPath(p: string, workDir: string | undefined): { path: string } | { error: string } {
  const t = p.trim();
  if (t.startsWith("~")) return { error: "Agent runs don't read paths under ~ — name the file inside the run's folders." };
  // Refused before anything resolves it: `path.resolve` drops `src/docs/..`
  // as written, while the system follows `docs` first — a link the PR's
  // branch carries out of the worktree — and steps up from where it leads.
  if (t.split(/[\\/]/).includes("..")) return { error: "Agent runs don't read paths with '..' — name the file inside the run's folders." };
  if (/^[\\/]{2}/.test(t)) return { error: "Agent runs don't read network or device paths." };
  if (t.replace(/^[A-Za-z]:(?=[\\/])/, "").includes(":")) return { error: `${t}: a colon belongs only after a drive letter.` };
  const abs = isAbsolutePath(t) ? t : workDir ? `${workDir.replace(/[\\/]+$/, "")}/${t}` : null;
  if (!abs) return { error: "This run has no working folder to read relative paths in." };
  return { path: abs.split(/[\\/]+/).filter((seg, i) => i === 0 || seg !== ".").join("/") || "/" };
}

/** A glob segment that matches more than itself. */
const GLOB_SEGMENT = /[*?[\]{}]/;

/** How many alternatives a Glob pattern's braces may stand for before the guard gives up judging it. */
const MAX_GLOB_ALTERNATIVES = 256;

/**
 * The first brace group of `s` expanded one level — `a{b,c}d` → `abd`, `acd` —
 * or null when `s` has none. Escaped braces and commas stay literal; an
 * unclosed `{` is skipped. A group without a comma is refused (`{x}`, and the
 * ranges some engines expand by character code — `{-../}` is `-`, `.`, `/`):
 * the guard judges only what it can expand.
 */
function expandFirstBrace(s: string): string[] | null | { error: string } {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] !== "{") continue;
    let depth = 0;
    const cuts: number[] = [];
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === "\\") {
        j++;
      } else if (c === "{") {
        depth++;
      } else if (c === "," && depth === 1) {
        cuts.push(j);
      } else if (c === "}" && --depth === 0) {
        if (cuts.length === 0) return { error: "A Glob pattern's braces need a comma: {a,b} — a single item or a range isn't taken." };
        const parts: string[] = [];
        let from = i + 1;
        for (const k of cuts) {
          parts.push(s.slice(from, k));
          from = k + 1;
        }
        parts.push(s.slice(from, j));
        return parts.map((x) => s.slice(0, i) + x + s.slice(j + 1));
      }
    }
  }
  return null;
}

/**
 * Every pattern a Glob pattern's braces stand for, nested ones included, as
 * the engine expands them — or null past `MAX_GLOB_ALTERNATIVES`. Judging the
 * text between brace characters alone missed what joins across them:
 * `.{.,}/*` is `../*`.
 */
function expandBraces(pattern: string): string[] | { error: string } {
  let out = [pattern];
  for (;;) {
    let changed = false;
    const next: string[] = [];
    for (const s of out) {
      const e = expandFirstBrace(s);
      if (e && !Array.isArray(e)) return e;
      if (e) changed = true;
      next.push(...(e ?? [s]));
      if (next.length > MAX_GLOB_ALTERNATIVES) return { error: `A Glob pattern's braces can't stand for more than ${MAX_GLOB_ALTERNATIVES} patterns.` };
    }
    if (!changed) return out;
    out = next;
  }
}

/**
 * Where a Glob pattern starts reading. A relative one stays under its folder —
 * once no alternative steps out — but an absolute one names its own folder
 * (`C:/Users/me/.ssh/*`), and so may a brace alternative (`{/etc/*,x}`).
 */
function globStart(pattern: string): { path: string | null } | { error: string } {
  const p = pattern.trim();
  const expanded = expandBraces(p);
  if (!Array.isArray(expanded)) return expanded;
  const alts = expanded.map((x) => x.trim());
  // Off Windows a backslash escapes the next character, so the engine reads
  // `\.\./` and `.\./` as `../`: each alternative is judged as written and
  // with its escapes dropped.
  const unescaped = alts.map((x) => x.replace(/\\(.)/g, "$1").trim());
  if ([...alts, ...unescaped].some((x) => x.startsWith("~"))) return { error: "Agent runs don't glob under ~." };
  if (alts.some((x) => /^[\\/]{2}/.test(x) || x.replace(/^[A-Za-z]:(?=[\\/])/, "").includes(":"))) {
    return { error: "A Glob pattern takes no network path, and a colon only after a drive letter." };
  }
  // Any `..` at all, not only a whole segment: what an engine might still read
  // as one — a range, a sequence the expander doesn't model — fails closed.
  if ([p, ...alts, ...unescaped].some((x) => x.includes(".."))) {
    return { error: "A Glob pattern can't step out of its folder with '..' — and takes no '..' at all." };
  }
  if (!isAbsolutePath(p)) return alts.some(isAbsolutePath) ? { error: "A Glob pattern's alternatives can't be absolute paths." } : { path: null };
  const segs = p.split(/[\\/]/);
  const firstGlob = segs.findIndex((s) => GLOB_SEGMENT.test(s));
  const fixed = firstGlob < 0 ? segs : segs.slice(0, firstGlob);
  const start = fixed.join("/");
  // A bare drive (`C:/{Users}/…` stops at `C:`) is the drive's root: resolved
  // as written, `C:` is that drive's current folder — the hook's, the worktree.
  return { path: /^[A-Za-z]:$/.test(start) ? `${start}/` : start || "/" };
}

/** What a read tool's call reads: its file, or the folder it searches. */
function readTargets(toolName: string, input: unknown, workDir: string | undefined): { paths: string[] } | { error: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const given = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const named = toolName === "Read" ? given(i.file_path) : toolName === "NotebookRead" ? given(i.notebook_path) : given(i.path);
  // Read and NotebookRead name a file; Grep, Glob and LS search the working folder unless told otherwise.
  if (!named && (toolName === "Read" || toolName === "NotebookRead")) return { error: `${toolName} needs a file path.` };
  const where = readPath(named ?? ".", workDir);
  if ("error" in where) return where;
  const paths = [where.path];
  if (toolName === "Glob") {
    const start = globStart(typeof i.pattern === "string" ? i.pattern : "");
    if ("error" in start) return start;
    if (start.path) paths.push(start.path);
  }
  return { paths };
}

/** Whether `file` is `dir` or inside it, with no `..` segment that could step out. */
function withinDir(file: string, dir: string): boolean {
  return !file.split(/[\\/]/).includes("..") && (samePath(file, dir) || isInsideDir(file, dir));
}

/** Whether `file` is in Claude Code's own folder for this run's session: `<root>/<project>/<sessionId>/…`. */
function inSessionFolder(file: string, run: GuardRun, real: RealPath): boolean {
  const id = run.sessionId?.toLowerCase();
  if (!id) return false;
  return (run.sessionRoots ?? []).filter(isAbsolutePath).some((root) => {
    const r = real(root);
    if (!r || !isInsideDir(file, r) || file.split(/[\\/]/).includes("..")) return false;
    const rest = gitBashPath(file).slice(gitBashPath(r).replace(/\/+$/, "").length + 1).split("/");
    return rest.length >= 2 && rest[1].toLowerCase() === id;
  });
}

/**
 * The read tools read the run's own folders and nothing else: its working
 * folder, payload folder and mounted plugins (`readDirs`), and Claude Code's
 * folder for its session. A PR's text can tell a session to read
 * `~/.config/gh/hosts.yml` and quote it in a review comment, which On posts
 * unseen — `--restricted` keeps Read to the working folders today, but that is
 * Claude Code's rule, not this app's, and it judges a link by its name.
 */
export function checkRead(toolName: string, input: unknown, run: GuardRun | null, real: RealPath = asWritten): GuardDecision {
  const targets = readTargets(toolName, input, run?.workDir);
  if ("error" in targets) {
    const named = Object.values((input ?? {}) as Record<string, unknown>).filter((v): v is string => typeof v === "string");
    return deny(targets.error + readHint(named, run));
  }
  // Absolute folders only: an empty or relative one would be read against wherever the check runs.
  const dirs = (run?.readDirs ?? [])
    .filter(isAbsolutePath)
    .map((d) => real(d))
    .filter((d): d is string => Boolean(d));
  for (const target of targets.paths) {
    const r = real(target);
    if (!r) return deny(`${target} is a link to nowhere; agent runs don't read through it.`);
    if (dirs.some((d) => withinDir(r, d)) || (run && inSessionFolder(r, run, real))) continue;
    if (run?.preflight && preflightReadable(r, run.preflight, real)) continue;
    const really = samePath(r, target) ? "" : ` (it really is ${r})`;
    return deny(
      (dirs.length
        ? `This run reads only its own folders (${dirs.join(", ")}); ${target}${really} is outside them.`
        : "This run has no folders to read.") + readHint([target, r, toolName === "Glob" ? String((input as { pattern?: unknown } | null)?.pattern ?? "") : ""], run),
    );
  }
  return { allow: true };
}

/**
 * What a refused read was most likely after, said with the refusal so the
 * next call needn't guess: a named workflow (there are none in agent runs),
 * the publish wrapper (run, never read). Empty when nothing more is known.
 */
function readHint(texts: string[], run: GuardRun | null): string {
  const all = texts.filter(Boolean);
  if (all.some((t) => /\.claude[\\/]+workflows/i.test(t))) return ` ${NAMED_WORKFLOW_HINT}`;
  if (run?.wrapperPath && all.some((t) => samePath(t, run.wrapperPath!))) return ` That is the app's publish wrapper: run it, don't read it — ${PUBLISH_USAGE}.`;
  return "";
}

/** Agent runs have no named workflows: `--restricted` loads no `~/.claude/workflows`, and the guard refuses names anyway. */
const NAMED_WORKFLOW_HINT =
  "Agent runs have no named workflows (nothing from ~/.claude/workflows): start a skill's workflow by its script path, the *.workflow.js in the skill's own folder — Workflow({ scriptPath, args }).";

/** A preflight file a read may open: `installed_plugins.json`, or anything inside one of the helper's payload folders. */
function preflightReadable(file: string, p: GuardPreflight, real: RealPath): boolean {
  const list = real(p.installedPlugins);
  if (list && samePath(file, list)) return true;
  const rest = underTmp(file, p, real);
  return rest !== null && isPayloadName(rest[0]);
}

/** Whether `dir` is one of the helper's payload folders itself, right under the run's temp folder. */
function isPayloadFolder(dir: string, p: GuardPreflight, real: RealPath): boolean {
  const rest = underTmp(dir, p, real);
  return rest !== null && rest.length === 1 && isPayloadName(rest[0]);
}

/** The path's segments below the run's temp folder, or null when it is not inside it. */
function underTmp(file: string, p: GuardPreflight, real: RealPath): string[] | null {
  const tmp = real(p.tmpDir);
  if (!tmp || !isInsideDir(file, tmp) || file.split(/[\\/]/).includes("..")) return null;
  return gitBashPath(file).slice(gitBashPath(tmp).replace(/\/+$/, "").length + 1).split("/");
}

function isPayloadName(name: string): boolean {
  return name.startsWith(PREFLIGHT_PAYLOAD_PREFIX) && name.length > PREFLIGHT_PAYLOAD_PREFIX.length;
}

/**
 * Splits a command at its one unquoted `<`, read the way `shellWords` reads
 * quotes; null when there is none or more than one (`<<` included).
 */
function splitStdin(command: string): { left: string; file: string } | null {
  let quote: string | null = null;
  let at = -1;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\")) i++;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "\\") i++;
    else if (c === "<") {
      if (at >= 0) return null;
      at = i;
    }
  }
  if (at < 0 || quote) return null;
  return { left: command.slice(0, at), file: command.slice(at + 1) };
}

const NODE_NAMES = new Set(["node", "node.exe"]);

/** The keys the review skill's preflight request carries — nothing else is let through. */
const PREFLIGHT_REQUEST_KEYS = new Set(["pr", "dryRun", "rereview", "guidanceDocs"]);

/**
 * Where the guard reads a preflight request and keeps the copy `node` reads.
 * The session can rewrite or rename a file in its payload folder at any time —
 * between this check and `node` opening it, too — so the helper never reads
 * the file the session wrote: `keep` puts the checked text where the session
 * can't write and the command is rewritten to read that. Nothing is locked, so
 * a refused request can be corrected and run again. Injected: the guard itself
 * never touches the disk.
 */
export interface RequestStore {
  /** The request's text; null when it can't be read (or isn't a small file). */
  read(file: string): string | null;
  /** A copy of `text` the session can't change; its path, or null when it can't be made. */
  keep(text: string): string | null;
}

/** A store that has nothing: every request is refused. */
const NO_REQUESTS: RequestStore = { read: () => null, keep: () => null };

/** A path as one single-quoted shell word. */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Whether a preflight request is for this run's PR only. The helper runs `gh`
 * with your login and fetches whatever PR `pr` names, so a request a PR's text
 * steered toward another repository would carry that repository's threads,
 * diff and files into this run's payload. `guidanceDocs` are paths in that same
 * PR's repository, read at its base — already readable through `gh api`.
 */
function requestProblem(text: string | null, pr: GuardPr | null): string | null {
  if (text === null) return "the request file can't be read";
  if (!pr) return "this run has no PR to hold the request to";
  let req: unknown;
  try {
    req = JSON.parse(text);
  } catch {
    return "the request is not JSON";
  }
  if (typeof req !== "object" || req === null || Array.isArray(req)) return "the request is not a JSON object";
  const r = req as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => !PREFLIGHT_REQUEST_KEYS.has(k));
  if (extra.length) return `the request carries ${extra.join(", ")}, which the preflight doesn't take`;
  const target = typeof r.pr === "string" ? guardPrFromUrl(r.pr.trim()) : null;
  if (!target || target.host !== pr.host || target.repo !== pr.repo || target.number !== pr.number) return `the request must name this run's PR, ${pr.url}`;
  if ("dryRun" in r && typeof r.dryRun !== "boolean") return "dryRun must be true or false";
  if ("rereview" in r && (typeof r.rereview !== "string" || r.rereview.length > 20)) return "rereview must be a short word";
  if ("guidanceDocs" in r) {
    const docs = r.guidanceDocs;
    const safe = (d: unknown) => typeof d === "string" && d.length > 0 && d.length <= 300 && !d.startsWith("/") && !d.includes("\\") && !d.split("/").includes("..");
    if (!Array.isArray(docs) || docs.length > 50 || !docs.every(safe)) return "guidanceDocs must be up to 50 relative paths in the PR's repository";
  }
  return null;
}

/**
 * The review skill's preflight (`GuardPreflight`): `node <helper> < <request>`
 * with the request in the run's payload folder and for the run's own PR, or
 * `node <helper> --digest <payload folder>`. Null when the command doesn't
 * start a helper, so the other rules judge it; any other use of a helper —
 * one of another plugin version included — is refused with what is allowed.
 */
function checkPreflight(command: string, pr: GuardPr | null, run: GuardRun | null, real: RealPath, requests: RequestStore): GuardDecision | null {
  const p = run?.preflight;
  if (!p) return null;
  const stdin = splitStdin(command);
  const split = shellWords(stdin ? stdin.left : command);
  if ("error" in split) return null;
  const w = split.words;
  if (w.length < 2 || !NODE_NAMES.has(w[0].toLowerCase())) return null;
  const helper = real(w[1]);
  const listed = helper !== null && p.helpers.some((h) => samePath(helper, h));
  if (!listed) {
    const name = PREFLIGHT_HELPER[PREFLIGHT_HELPER.length - 1];
    if (gitBashPath(w[1]).split("/").pop()?.toLowerCase() !== name) return null;
    return deny(`This run's review preflight helper is ${p.helpers.join(" or ")}; ${w[1]} is not it (a plugin updated since the run started?).`);
  }
  const shape = `The review preflight runs as node "<helper>" < "<request file under ${run?.outDir ?? "the run's payload folder"}>", or node "<helper>" --digest "<payload folder>" — nothing else.`;
  if (stdin) {
    const file = shellWords(stdin.file);
    if ("error" in file || file.words.length !== 1 || w.length !== 2) return deny(shape);
    const outDir = run?.outDir ? real(run.outDir) : null;
    const req = real(file.words[0]);
    if (!outDir || !req || !isInsideDir(req, outDir)) return deny(shape);
    const text = requests.read(req);
    const problem = requestProblem(text, pr);
    if (problem) return deny(`The review preflight request is refused: ${problem}.`);
    const copy = text === null ? null : requests.keep(text);
    if (!copy) return deny("The review preflight request couldn't be set aside for node to read.");
    // The helper reads the checked copy, never the file the session can still change.
    const fwd = (s: string) => s.replace(/\\/g, "/");
    return { allow: true, command: `node ${shellQuote(fwd(helper))} < ${shellQuote(fwd(copy))}` };
  }
  if (w.length === 4 && w[2] === "--digest") {
    const dir = real(w[3]);
    if (dir && isAbsolutePath(w[3]) && isPayloadFolder(dir, p, real)) return { allow: true };
  }
  return deny(shape);
}

function deny(reason: string): GuardDecision {
  return { allow: false, reason };
}

/** The review preflight's two calls, with this run's own helper and folders — what a refused attempt at it is told. */
function preflightUsage(run: GuardRun, p: GuardPreflight): string {
  const helper = (p.helpers[0] ?? "<helper>").replace(/\\/g, "/");
  const out = (run.outDir ?? "<the run's payload folder>").replace(/\\/g, "/");
  return `node runs only the review preflight here, as node "${helper}" < "${out}/<request>.json" (the request written there with the Write tool) or node "${helper}" --digest "<payload folder>" — no other script, no shell around it.`;
}

// ---------------------------------------------------------------------------
// Hints: every refusal is a step the model spends re-reading its whole
// context, so a refusal says what to do instead — the command that works, or
// the tool to use. Hints only explain; what is allowed is decided above and
// below, never here. The same commands go into a run's rules up front
// (`sessionToolRules`): a Workflow's agents don't get those rules, and learn
// them only from a refusal.
// ---------------------------------------------------------------------------

/**
 * Whether Claude Code's `--allowedTools` rules let `command` run without an
 * approval nobody can give in an agent run: `Bash(prefix *)`, `Bash(prefix*)`,
 * `Bash(prefix:*)`, an exact `Bash(command)`, or a bare `Bash`. Only for
 * choosing which commands a hint names — never for a decision.
 */
export function ruleAllows(rules: readonly string[], command: string): boolean {
  return rules.some((rule) => {
    if (rule === "Bash") return true;
    const m = /^Bash\((.*)\)$/.exec(rule);
    if (!m) return false;
    const p = m[1];
    if (p.endsWith(":*")) return command.startsWith(p.slice(0, -2));
    if (p.endsWith("*")) return command.startsWith(p.slice(0, -1));
    return command === p;
  });
}

/** The PR's own words for a hint, or placeholders when the run names none. */
function prWords(pr: { repo: string; number: number } | null | undefined): { repo: string; n: string } {
  return { repo: pr?.repo ?? "<owner/repo>", n: pr ? String(pr.number) : "<number>" };
}

/**
 * What a run that may not use git reads instead, as commands the guard lets
 * through for this PR — only those `tools` (the run's `--allowedTools`) let run.
 */
function gitInstead(pr: { repo: string; number: number } | null | undefined, tools: readonly string[]): string[] {
  const { repo, n } = prWords(pr);
  const out: string[] = [];
  if (ruleAllows(tools, `gh pr view ${n}`)) out.push(`the head, base and commits: gh pr view ${n} --json headRefOid,baseRefOid,commits (statusCheckRollup for CI)`);
  if (ruleAllows(tools, `gh pr diff ${n}`)) out.push(`the diff: gh pr diff ${n} (--name-only for its files)`);
  if (ruleAllows(tools, `gh api repos/${repo}`)) {
    out.push(`one file's diff: gh api repos/${repo}/pulls/${n}/files --paginate --jq '.[] | select(.filename == "PATH") | .patch'`);
    out.push(`a file at a commit: gh api 'repos/${repo}/contents/PATH?ref=SHA' -H 'Accept: application/vnd.github.raw'`);
  }
  return out;
}

/** A program as the shell would name it: no folder, no `.exe`, lower case. */
function programName(word: string): string {
  return (gitBashPath(word).split("/").pop() ?? "").toLowerCase().replace(/\.exe$/, "");
}

/** What a read-only run does instead of a program it doesn't run. */
const INSTEAD: ReadonlyArray<[ReadonlySet<string>, string]> = [
  [new Set(["ls", "dir", "find", "tree", "stat", "test"]), "find files with the Glob tool"],
  [new Set(["cat", "head", "tail", "less", "more", "type", "wc", "sed", "awk", "od", "xxd"]), "read a file with the Read tool (offset and limit for a part of it)"],
  [new Set(["grep", "egrep", "fgrep", "rg", "findstr", "ag", "ack"]), "search with the Grep tool"],
  [new Set(["jq"]), "shape gh's JSON with its own --jq"],
  [new Set(["sleep", "timeout", "wait", "ping"]), "don't wait in the shell — a background workflow reports to you by itself when it ends"],
  [new Set(["echo", "printf", "true", "pwd", "whoami", "date"]), "say it in your reply instead"],
  [new Set(["cd", "pushd"]), "commands already run in the run's working folder, and gh already points at this PR"],
  [new Set(["sh", "bash", "zsh", "dash", "cmd", "pwsh", "powershell"]), "run the program itself, as one plain command"],
  [new Set(["git"]), "use gh (gh pr view, gh pr diff) — git can run the PR's own filters"],
];

const SHELL_NAMES: ReadonlySet<string> = INSTEAD.find(([names]) => names.has("sh"))![0];

function insteadOf(prog: string): string {
  return INSTEAD.find(([names]) => names.has(prog))?.[1] ?? "nothing else runs here — no script or program from the PR's repository";
}

/** What Bash runs in a read-only run, in words. */
function readOnlyPrograms(run: GuardRun | null): string {
  return `gh, twg${run?.wrapperPath ? ", the publish wrapper" : ""}${run?.preflight ? ", the review preflight's node" : ""}`;
}

/** The refusal of a program a read-only run doesn't run, with what to do instead. */
function readOnlyRefusal(words: string[], run: GuardRun | null): string {
  const prog = programName(words[0] ?? "");
  // The wrapper handed to another program: a shell runs it as it is, and there is nothing in it to read.
  if (run?.wrapperPath && words.slice(1).some((w) => samePath(w, run.wrapperPath!))) {
    return SHELL_NAMES.has(prog)
      ? `This run only reads: run the publish wrapper itself, not through ${prog} — ${PUBLISH_USAGE}.`
      : `This run only reads: that is the app's publish wrapper — run it, don't read it — ${PUBLISH_USAGE}.`;
  }
  if (prog === "node" && run?.preflight) return `This run only reads: ${preflightUsage(run, run.preflight)}`;
  const why = prog === "node" && words.slice(1).some((w) => /\.claude[\\/]+projects[\\/]/i.test(w)) ? "read your workflow's files with the Read tool" : insteadOf(prog);
  return `This run only reads: Bash runs ${readOnlyPrograms(run)} only. Instead of ${prog || "that"}: ${why}.`;
}

/** Whether a read-only run's Bash runs this program at all (its arguments are judged elsewhere). */
function runsInReadOnly(words: string[], run: GuardRun | null): boolean {
  const prog = programName(words[0] ?? "");
  if (prog === "gh" || prog === "twg") return true;
  if (prog === "node" && run?.preflight) return true;
  return Boolean(run?.wrapperPath && words[0] && samePath(words[0], run.wrapperPath));
}

/** What to do instead of the shell syntax a command used — the parts that commonly come along. */
function syntaxHint(command: string): string {
  // Quoted text is the command's own: an operator inside quotes is not one —
  // but the shell still expands `$` inside double quotes.
  const bare = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
  const expands = command.replace(/'[^']*'/g, "''");
  const hints: string[] = [];
  if (/^\s*(cd|pushd)\s/.test(bare)) hints.push("no cd — commands already run in the run's working folder");
  if (/\d>/.test(bare)) hints.push("drop 2>&1 and 2>/dev/null — errors come back to you anyway");
  if (/(^|[^|])\|(?!\|)/.test(bare)) hints.push("no pipes — shape JSON with gh's --jq; a result too long to show is saved to a file you can Read");
  if (/;|&&|\|\||&(?!\d)/.test(bare.replace(/\d>&\d/g, ""))) hints.push("one command per call — make each its own call");
  if (/<</.test(bare)) hints.push("no heredocs — write a file with the Write tool");
  if (/\$\(|`/.test(expands)) hints.push("no $(…) — run that command on its own and write its value out");
  else if (/\$[A-Za-z_{]/.test(expands)) hints.push("no $VARIABLES — write the value out");
  if (/(^|\s)~/.test(bare)) hints.push("~ isn't expanded — write the full path");
  return hints.join("; ");
}

/** A command the shell rules refused, with what to do instead — and, in a read-only run, the programs it doesn't run. */
function refusedSyntax(kind: AgentRunKind, command: string, error: string, run: GuardRun | null): string {
  const parts = [error];
  const syntax = syntaxHint(command);
  if (syntax) parts.push(`Instead: ${syntax}.`);
  if (READ_ONLY.has(kind)) {
    const refused = [
      ...new Set(
        looseCommands(command)
          .filter((w) => /^[A-Za-z]/.test(w[0] ?? "") && !runsInReadOnly(w, run))
          .map((w) => programName(w[0]))
          // The syntax hint already says "no cd".
          .filter((p) => p !== "cd" && p !== "pushd"),
      ),
    ].slice(0, 3);
    if (refused.length) parts.push(`Bash runs ${readOnlyPrograms(run)} only here — ${refused.map((p) => `instead of ${p}: ${insteadOf(p)}`).join("; ")}.`);
  }
  if (/\.claude[\\/]+workflows/i.test(command)) parts.push(NAMED_WORKFLOW_HINT);
  return parts.join(" ");
}

/**
 * The rules a session gets up front about its tools (appended to its system
 * prompt by `agentRules`): what the guard refuses, and what works instead —
 * only commands both the guard and `allowedTools` let through, so following
 * them is never a refused call. Kept short: it rides on every step of every
 * run. The full-context drive doesn't get it (`checkFullToolUse`).
 */
export interface ToolRulesRun {
  /** The run's `--allowedTools` rules. */
  allowedTools: readonly string[];
  pr?: { repo: string; number: number } | null;
  /** A review's own publish wrapper and payload folder (`GuardRun`). */
  wrapperPath?: string;
  outDir?: string;
  /** The skill workflows the run's prompt names, by script path. */
  workflows?: readonly string[];
}

export function sessionToolRules(kind: AgentRunKind, t: ToolRulesRun): string {
  const tools = t.allowedTools;
  const readOnly = READ_ONLY.has(kind);
  const out: string[] = [
    readOnly
      ? `Tools here — a guard checks every call, and a refused call is a wasted step. Bash runs one plain command per call: ${readOnlyPrograms(t.wrapperPath ? { wrapperPath: t.wrapperPath } : null)} only — no ls, cat, grep, node, sleep, cd or git; no pipes, redirection, 2>&1, ; or &&; quote any * ? { } ~ #. Files: Read (offset/limit for a part), Glob, Grep.`
      : "Tools here — a guard checks every call, and a refused call is a wasted step. Bash runs one plain command per call: no pipes, redirection, 2>&1, ; or &&; no cd (you are in the worktree) and no git -C; quote any * ? { } ~ #. Files: Read (offset/limit for a part), Glob, Grep.",
  ];
  if (readOnly) {
    const instead = gitInstead(t.pr, tools);
    if (instead.length) out.push(`Instead of git — ${instead.join("; ")}. Shape JSON with --jq (rows with @tsv, never \\t).`);
  }
  if (ruleAllows(tools, "twg jira")) out.push("twg's -o takes json, jsonl, yaml or text.");
  out.push("A result too long to show is saved to a file you are told of: Read that file (offset/limit) rather than running the command again.");
  if (t.workflows?.length) {
    out.push(
      `Named workflows don't exist here: start a skill's workflow by its script path, even where the skill says to use its name — ${t.workflows.map((w) => `Workflow({ scriptPath: "${w.replace(/\\/g, "/")}", args })`).join(" or ")}. It runs in the background and reports when it ends: don't wait or poll from the shell.`,
    );
  }
  // A drive's rules give its one wrapper call (reply) themselves.
  if (t.wrapperPath && t.outDir && kind !== "drive") {
    const w = gitBashPath(t.wrapperPath);
    const { repo, n } = prWords(t.pr);
    out.push(
      `The publish wrapper (run it — never with --help, never read it): ${w} review|comment ${repo} ${n} FILE.json · reply|escalate ${repo} ${n} COMMENT-ID FILE.txt · resolve THREAD-ID; every FILE written under ${t.outDir.replace(/\\/g, "/")}/ and passed by its absolute path. It posts no status comment: start the review workflow with statusComment: false.`,
    );
  }
  return out.join(" ");
}

/**
 * Splits a command into the argv the shell would pass, or explains why the
 * shell would do something else. Single quotes are literal; double quotes
 * allow only \" \\ escapes and refuse `$` and backticks; outside quotes,
 * operators (; & | < > ( )), `$`, backticks, globs (* ? [ ]) and line breaks
 * are refused. A backslash outside quotes takes the next character literally.
 */
export function shellWords(command: string): { words: string[] } | { error: string } {
  const words: string[] = [];
  let cur = "";
  let inWord = false;
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i];
    if (ch === "\n" || ch === "\r") return { error: "Line breaks are not allowed — run one command." };
    if (ch === " " || ch === "\t") {
      if (inWord) {
        words.push(cur);
        cur = "";
        inWord = false;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return { error: "Unbalanced quote." };
      cur += command.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      inWord = true;
      for (;;) {
        if (i >= n) return { error: "Unbalanced quote." };
        const c = command[i];
        if (c === '"') {
          i++;
          break;
        }
        if (c === "$" || c === "`") return { error: "Expansion ($, backticks) is not allowed in agent runs." };
        if (c === "\n" || c === "\r") return { error: "Line breaks are not allowed — run one command." };
        if (c === "\\" && (command[i + 1] === '"' || command[i + 1] === "\\")) {
          cur += command[i + 1];
          i += 2;
          continue;
        }
        cur += c;
        i++;
      }
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= n) return { error: "A trailing backslash." };
      cur += command[i + 1];
      inWord = true;
      i += 2;
      continue;
    }
    if (";&|<>()".includes(ch)) return { error: "Shell operators (pipes, redirection, chaining) are not allowed in agent runs — run one plain command." };
    if (ch === "$" || ch === "`") return { error: "Expansion ($, backticks) is not allowed in agent runs." };
    if ("*?[]".includes(ch)) return { error: "Unquoted wildcards are not allowed — they would expand to the PR's own file names. Quote the word (a query string such as 'repos/…/contents?ref=main' too)." };
    // `{a,b}` is brace expansion (one word becomes several), `~` expands to a
    // path, `#` starts a comment the shell drops — each makes the argv differ
    // from what is checked here. Quote them when they are meant literally.
    if ("{}~#".includes(ch)) return { error: "Unquoted { } ~ # are not allowed — the shell would expand or drop them; quote them." };
    cur += ch;
    inWord = true;
    i++;
  }
  if (inWord) words.push(cur);
  return { words };
}

/**
 * git flags that write a file or run a program even under a reading
 * subcommand: `--output` writes anywhere, `--ext-diff`/`--textconv` run
 * configured programs, `--no-index` reads outside the repository, the pack
 * ones run a remote program. Matched by `gitLongOption`, so `--output=x` and
 * an abbreviation git expands to one of them count too.
 */
const GIT_DANGEROUS = ["--output", "--ext-diff", "--textconv", "--no-index", "--exec-path", "--upload-pack", "--receive-pack", "--exec"];

/**
 * git flags that read a file the command names, anywhere on disk: a commit
 * message (`--file`, `--template`), blame's contents and ignore list, a
 * pathspec or exclude list. The Read tool is held to the run's folders, but
 * `git commit -F ~/.ssh/id_rsa` would carry that file into a commit the app
 * then pushes — so the file such a flag names is held to the same folders
 * (`checkGitFiles`). A drive writes its commit message into its payload
 * folder and commits with `-F`, since the guard refuses `$(…)` and heredocs.
 */
const GIT_READS_FILE = ["--file", "--template", "--pathspec-from-file", "--contents", "--ignore-revs-file", "--exclude-from"];

/**
 * Real git options that happen to be a prefix of a flag above (`--text` of
 * `--textconv`): an exact name is that option, never an abbreviation.
 */
const GIT_EXACT_OPTIONS = new Set(["--text", "--ignore-rev", "--exclude"]);

/** The value-taking short options of the diff family (`-SFoo`: "Foo" is the value). */
const GIT_DIFF_VALUE_SHORTS = "nSGLUlMCBXI";

/**
 * The short forms of `GIT_READS_FILE`, per subcommand — `-F` is a message
 * file to commit and merge but `--fixed-strings` to log. `values` are the
 * short options that take the rest of the word as their value, so `-mFix` is
 * a message, while `-aF x` still reads x.
 */
const GIT_READS_FILE_SHORT: Record<string, { reads: string; values: string }> = {
  commit: { reads: "Ft", values: "mcCSu" },
  merge: { reads: "F", values: "mXsS" },
  blame: { reads: "S", values: "LMC" },
  diff: { reads: "O", values: GIT_DIFF_VALUE_SHORTS },
  log: { reads: "O", values: GIT_DIFF_VALUE_SHORTS },
  show: { reads: "O", values: GIT_DIFF_VALUE_SHORTS },
  stash: { reads: "O", values: `m${GIT_DIFF_VALUE_SHORTS}` },
  "ls-files": { reads: "X", values: "x" },
};

/**
 * Whether `word` is one of `options` as git reads it: `--file`, `--file=x`,
 * and any abbreviation git expands — commit, merge and blame take an
 * unambiguous prefix (`--fil=x` is `--file=x`). An ambiguous prefix is
 * refused too, which costs nothing: git refuses it as well.
 */
function gitLongOption(word: string, options: readonly string[]): boolean {
  if (!word.startsWith("--")) return false;
  const name = word.split("=", 1)[0];
  if (name.length < 3 || GIT_EXACT_OPTIONS.has(name)) return false;
  return options.some((o) => o.startsWith(name));
}

/**
 * The short flags a `-abc` word sets, in order, up to and including the first
 * one that takes a value, and that value when it is attached (`-Fmsg.txt`):
 * the rest of the word.
 */
function gitShortFlags(word: string, values: string): { flags: string; attached: string } {
  if (!/^-[^-]/.test(word)) return { flags: "", attached: "" };
  for (let i = 1; i < word.length; i++) {
    if (values.includes(word[i])) return { flags: word.slice(1, i + 1), attached: word.slice(i + 1) };
  }
  return { flags: word.slice(1), attached: "" };
}

/**
 * The files the file-reading flags of `git <sub> <args>` name: `--file=x`,
 * `--file x`, `-Fx`, `-F x`, `-aF x`. A flag with no value yields "", which
 * no check lets through. `--` is not taken as the end of the flags: a word
 * after it read as a flag can only be refused, never let through.
 */
function gitFlagFiles(sub: string, args: string[]): string[] {
  const short = GIT_READS_FILE_SHORT[sub];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (gitLongOption(w, GIT_READS_FILE)) {
      const eq = w.indexOf("=");
      files.push(eq >= 0 ? w.slice(eq + 1) : (args[++i] ?? ""));
      continue;
    }
    if (!short) continue;
    // A reading flag takes a value too, so it ends the cluster: `-Ft` is the file "t".
    const { flags, attached } = gitShortFlags(w, short.values + short.reads);
    if (flags && short.reads.includes(flags[flags.length - 1])) files.push(attached || (args[++i] ?? ""));
  }
  return files;
}

/**
 * A git flag reads only what the Read tool may read: the run's own folders,
 * links followed to where they lead. The path must be absolute — git reads a
 * relative one against the shell's current folder, which the guard can't see.
 */
function checkGitFiles(sub: string, args: string[], run: GuardRun | null, real: RealPath): GuardDecision {
  for (const file of gitFlagFiles(sub, args)) {
    if (!file || !isAbsolutePath(file)) {
      return deny(`git ${sub} reads the file a flag names; give it by its absolute path inside the run's folders${file ? ` (not ${file})` : ""}, or give a commit message with -m.`);
    }
    const read = checkRead("Read", { file_path: file }, run, real);
    if (!read.allow) return deny(`git ${sub} would read ${file}: ${read.reason}`);
  }
  return { allow: true };
}

/**
 * git subcommands a drive run may use. A list, not "anything but push": an
 * unknown word can be an alias from your git config, and an alias can run a
 * shell command.
 */
const GIT_DRIVE = new Set([
  "status",
  "diff",
  "log",
  "show",
  "add",
  "commit",
  "restore",
  "rm",
  "mv",
  "rev-parse",
  "ls-files",
  "blame",
  "merge-base",
  // No `fetch`: the session's git has no network; the app fetches the base before it starts.
  "merge",
  // No `rebase`: the app pushes a fast-forward only, and a rebase never is one.
  "cherry-pick",
  "stash",
  "branch",
]);

/** `gh api` flags that only shape a read; a value-taking one consumes the next word. */
const GH_API_FLAGS: Record<string, "flag" | "value"> = {
  "--jq": "value",
  "-q": "value",
  "--paginate": "flag",
  "--slurp": "flag",
  "--cache": "value",
  "-i": "flag",
  "--include": "flag",
  "--silent": "flag",
  // Checked below: the PR's own host, and Accept headers only.
  "--hostname": "value",
  "-H": "value",
  "--header": "value",
  // GraphQL only, checked below: the query and its variables.
  "-f": "value",
  "--raw-field": "value",
  "-F": "value",
  "--field": "value",
};

const FIELD_FLAGS = new Set(["-f", "--raw-field", "-F", "--field"]);

/**
 * GraphQL a review may send: a read of its own PR, field by field. A
 * reviewed PR's text can talk the session into querying elsewhere and pasting
 * the answer into a review comment, so the WHOLE selection tree is checked,
 * not just its roots, against an allow-list of the fields a review needs:
 *
 *   - roots: `repository(owner, name)` naming this PR's repository (literal or
 *     a -F/-f variable), `viewer` / `user` with scalar fields only (who "I"
 *     am), `rateLimit`;
 *   - under `repository`: `pullRequest(number)` naming this PR, and a few
 *     scalars;
 *   - below that: the fields of a PR, its threads, comments, reviews, commits
 *     and checks (`GRAPHQL_PR_FIELDS`). None of them reaches another
 *     repository, organization or user's data — `repository`, `owner`,
 *     `repositories`, `organization`, `search`, `node(s)`, `object` are not on
 *     the list anywhere.
 *
 * Only `query` operations, no fragments, no directives. The tokenizer is
 * stricter than GraphQL itself — no block strings (`"""`), no backslash
 * escapes, no line break in a string, nothing but the characters a query
 * needs — so what it reads as a string is exactly what GitHub reads as one.
 */
const GRAPHQL_SCALAR_ROOTS: Record<string, ReadonlySet<string>> = {
  viewer: new Set(["login", "id", "databaseId", "name", "__typename"]),
  user: new Set(["login", "id", "databaseId", "name", "__typename"]),
  rateLimit: new Set(["limit", "remaining", "cost", "resetAt", "used", "nodeCount", "__typename"]),
};
const GRAPHQL_REPO_FIELDS = new Set(["pullRequest", "nameWithOwner", "id", "name", "url", "viewerPermission", "__typename"]);
const GRAPHQL_PR_FIELDS = new Set([
  // connections
  "nodes", "edges", "node", "cursor", "totalCount", "pageInfo", "hasNextPage", "hasPreviousPage", "endCursor", "startCursor",
  // the PR
  "pullRequest", "id", "databaseId", "number", "title", "body", "bodyText", "url", "state", "isDraft", "createdAt", "updatedAt",
  "headRefName", "headRefOid", "baseRefName", "baseRefOid", "mergeable", "mergeStateStatus", "reviewDecision",
  "additions", "deletions", "changedFiles", "files", "path", "changeType", "labels", "name", "__typename",
  // threads, comments, reviews
  "reviewThreads", "isResolved", "isOutdated", "isCollapsed", "viewerCanResolve", "viewerCanReply", "resolvedBy",
  "line", "originalLine", "startLine", "originalStartLine", "diffSide", "startDiffSide", "subjectType",
  "comments", "replyTo", "author", "login", "viewerDidAuthor", "publishedAt", "lastEditedAt", "submittedAt",
  "outdated", "position", "originalPosition", "diffHunk", "isMinimized", "minimizedReason",
  "reviews", "latestReviews", "latestOpinionatedReviews", "reviewRequests", "requestedReviewer",
  // commits and checks
  "commits", "commit", "oid", "abbreviatedOid", "committedDate", "pushedDate", "authoredDate", "message", "messageHeadline", "messageBody", "parents",
  "statusCheckRollup", "contexts", "conclusion", "status", "context", "description", "targetUrl", "detailsUrl",
]);

type GqlToken = { t: "name" | "string" | "number" | "punct" | "var"; v: string };

function gqlTokens(query: string): GqlToken[] | null {
  if (query.includes('"""') || query.includes("\\")) return null;
  const out: GqlToken[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    const rest = query.slice(i);
    if (/[\s,]/.test(ch)) {
      i++;
    } else if (ch === "#") {
      while (i < query.length && query[i] !== "\n") i++;
    } else if (ch === '"') {
      const end = query.indexOf('"', i + 1);
      if (end < 0) return null;
      const v = query.slice(i + 1, end);
      if (/[\r\n]/.test(v)) return null;
      out.push({ t: "string", v });
      i = end + 1;
    } else if (ch === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
      if (!m) return null;
      out.push({ t: "var", v: m[0].slice(1) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)!;
      out.push({ t: "name", v: m[0] });
      i += m[0].length;
    } else if (/[-0-9]/.test(ch)) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
      if (!m) return null;
      out.push({ t: "number", v: m[0] });
      i += m[0].length;
    } else if (rest.startsWith("...")) {
      out.push({ t: "punct", v: "..." });
      i += 3;
    } else if ("{}():!=[]@".includes(ch)) {
      out.push({ t: "punct", v: ch });
      i++;
    } else {
      return null;
    }
  }
  return out;
}

class GqlRefusal extends Error {}

/** A recursive reader of one document, refusing (by throwing) at the first thing outside the allow-list. */
function readGraphql(toks: GqlToken[], vars: Record<string, string>, pr: GuardPr | null): void {
  let i = 0;
  const no = (reason: string): never => {
    throw new GqlRefusal(reason);
  };
  const peek = () => toks[i];
  const take = (v?: string) => {
    const k = toks[i];
    if (!k || (v !== undefined && k.v !== v)) no("That GraphQL query couldn't be read; agent runs send plain queries.");
    i++;
    return k;
  };
  const valueOf = (k: GqlToken | undefined) => (k?.t === "var" ? vars[k.v] : k?.v);

  // A value: a scalar, a variable, a list or an input object. Only the top-level scalar is kept.
  const readValue = (): GqlToken | undefined => {
    const k = take();
    if (k.v === "[") {
      while (peek() && peek().v !== "]") readValue();
      take("]");
      return undefined;
    }
    if (k.v === "{") {
      while (peek() && peek().v !== "}") {
        take();
        take(":");
        readValue();
      }
      take("}");
      return undefined;
    }
    if (k.t === "punct") no("That GraphQL query couldn't be read; agent runs send plain queries.");
    return k;
  };
  const readArgs = (): Record<string, GqlToken | undefined> => {
    const args: Record<string, GqlToken | undefined> = {};
    if (peek()?.v !== "(") return args;
    take("(");
    while (peek() && peek().v !== ")") {
      const name = take();
      if (name.t !== "name") no("That GraphQL query couldn't be read; agent runs send plain queries.");
      take(":");
      args[name.v] = readValue();
    }
    take(")");
    return args;
  };
  const noDirective = () => {
    if (peek()?.v === "@") no("GraphQL directives are not allowed in agent runs.");
  };

  type Level = "root" | "repository" | "pr" | keyof typeof GRAPHQL_SCALAR_ROOTS;
  const readSelection = (level: Level): void => {
    take("{");
    while (peek() && peek().v !== "}") {
      if (peek().v === "...") {
        take("...");
        if (peek()?.v !== "on") no("GraphQL fragments are not allowed in agent runs; inline the fields.");
        take("on");
        if (take().t !== "name") no("That GraphQL query couldn't be read; agent runs send plain queries.");
        noDirective();
        readSelection(level);
        continue;
      }
      let field = take();
      if (field.t !== "name") no("That GraphQL query couldn't be read; agent runs send plain queries.");
      if (peek()?.v === ":") {
        take(":");
        field = take();
        if (field.t !== "name") no("That GraphQL query couldn't be read; agent runs send plain queries.");
      }
      const name = field.v;
      const args = readArgs();
      noDirective();
      let next: Level | null = null;
      if (level === "root") {
        if (name === "repository") {
          const repo = `${valueOf(args.owner) ?? ""}/${valueOf(args.name) ?? ""}`.toLowerCase();
          if (pr && repo !== pr.repo) no(`This run reads ${pr.repo} only.`);
          next = "repository";
        } else if (name in GRAPHQL_SCALAR_ROOTS) {
          next = name as keyof typeof GRAPHQL_SCALAR_ROOTS;
        } else {
          no(`GraphQL reads start from this PR's repository in agent runs, not from ${name}.`);
        }
      } else if (level === "repository") {
        if (!GRAPHQL_REPO_FIELDS.has(name)) no(`GraphQL reads stay inside PR #${pr?.number ?? "?"} in agent runs, not ${name}.`);
        if (name === "pullRequest" && pr && valueOf(args.number) !== String(pr.number)) no(`This run reads PR #${pr.number} only.`);
        next = "pr";
      } else if (level === "pr") {
        if (!GRAPHQL_PR_FIELDS.has(name)) no(`GraphQL reads stay inside the PR in agent runs; ${name} is not one of the fields a review reads.`);
        next = "pr";
      } else {
        if (!GRAPHQL_SCALAR_ROOTS[level].has(name)) no(`${level} gives only ${[...GRAPHQL_SCALAR_ROOTS[level]].join(", ")} in agent runs.`);
        if (peek()?.v === "{") no(`${level} gives only scalar fields in agent runs.`);
      }
      if (peek()?.v === "{") readSelection(next ?? "pr");
    }
    take("}");
  };

  while (i < toks.length) {
    // An operation: `{ … }`, or `query [Name] [($v: Type = default, …)] { … }`.
    if (peek().t === "name") {
      if (peek().v !== "query") {
        no(peek().v === "mutation" || peek().v === "subscription" ? "gh api graphql can only read in agent runs — the app posts the result itself." : "GraphQL fragments are not allowed in agent runs; inline the fields.");
      }
      take("query");
      if (peek()?.t === "name") take();
      if (peek()?.v === "(") {
        take("(");
        while (peek() && peek().v !== ")") {
          if (take().t !== "var") no("That GraphQL query couldn't be read; agent runs send plain queries.");
          take(":");
          // The type: Name, [Name], with ! anywhere.
          while (peek() && (peek().t === "name" || ["[", "]", "!"].includes(peek().v))) take();
          if (peek()?.v === "=") {
            take("=");
            readValue();
          }
        }
        take(")");
      }
      noDirective();
    }
    readSelection("root");
  }
}

/** Whether a GraphQL document only reads, and only from this PR — see `readGraphql`. */
export function checkGraphqlRead(query: string, vars: Record<string, string>, pr: GuardPr | null): GuardDecision {
  const toks = gqlTokens(query);
  if (!toks || toks.length === 0) return deny("That GraphQL query couldn't be read; agent runs send plain queries (no block strings or escapes).");
  try {
    readGraphql(toks, vars, pr);
    return { allow: true };
  } catch (e) {
    // Anything the reader didn't expect is a refusal too — never a pass.
    return deny(e instanceof GqlRefusal ? e.message : "That GraphQL query couldn't be read; agent runs send plain queries.");
  }
}

function checkGhApi(args: string[], pr: GuardPr | null): GuardDecision {
  let endpoint: string | null = null;
  const fields: Array<{ flag: string; value: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      const long = a.startsWith("--");
      const name = long ? a.split("=")[0] : a.slice(0, 2);
      const attached = long ? (a.includes("=") ? a.slice(a.indexOf("=") + 1) : null) : a.length > 2 ? a.slice(2) : null;
      const kind = GH_API_FLAGS[name];
      if (!kind) {
        // What these flags were for, said the way the guard takes it: a query string goes in the quoted path.
        const why =
          name === "--ref"
            ? " A ref goes in the quoted path: 'repos/<owner>/<repo>/contents/PATH?ref=SHA'."
            : name === "-X" || name === "--method"
              ? " gh api reads with GET already: drop -X, and put query parameters in the quoted path ('…?recursive=1')."
              : name === "--template" || name === "-t"
                ? " --jq already prints a string as it is: drop --template."
                : " Query parameters go in the quoted path ('…?ref=SHA').";
        return deny(`gh api is read-only in agent runs: only --jq, --paginate, --slurp, --cache, --include, --silent, --hostname and Accept headers.${why}`);
      }
      if (kind === "flag") {
        if (attached !== null) return deny("gh api is read-only in agent runs.");
        continue;
      }
      let value = attached;
      if (value === null) {
        // A value that looks like a flag is read differently by gh than here.
        if (args[i + 1] === undefined || args[i + 1].startsWith("-")) return deny(`${name} needs a value that isn't a flag.`);
        value = args[++i];
      }
      if (name === "--hostname" && pr && value.toLowerCase() !== pr.host) return deny(`This run reads ${pr.host} only.`);
      if ((name === "-H" || name === "--header") && !/^Accept:\s*application\/(vnd\.github[A-Za-z0-9.+-]*|json)$/i.test(value)) {
        return deny("Only Accept headers (application/vnd.github…) are allowed with gh api in agent runs.");
      }
      if (FIELD_FLAGS.has(name)) fields.push({ flag: name, value });
      continue;
    }
    if (endpoint !== null) return deny("gh api takes one endpoint in agent runs.");
    endpoint = a;
  }
  if (!endpoint) return deny("gh api needs an endpoint.");
  if (/^\/?graphql$/i.test(endpoint)) {
    // `-f/-F key=value`: `query` is the document, the rest its variables. A
    // `-F key=@file` reads a file into the request — the PR's own files included.
    const vars: Record<string, string> = {};
    let query: string | null = null;
    for (const f of fields) {
      const eq = f.value.indexOf("=");
      if (eq <= 0) return deny("A GraphQL field is key=value.");
      const key = f.value.slice(0, eq).replace(/\[\]$/, "");
      const val = f.value.slice(eq + 1);
      if ((f.flag === "-F" || f.flag === "--field") && val.startsWith("@")) return deny("-F key=@file reads a file; agent runs pass values only.");
      if (key === "query") query = val;
      else vars[key] = val;
    }
    if (query === null) return deny("gh api graphql needs -f query='…'.");
    return checkGraphqlRead(query, vars, pr);
  }
  // A body turns any REST call into a write (gh switches to POST).
  if (fields.length) return deny("gh api -f/-F would send a request body; agent runs read REST endpoints only.");
  // The signed-in user: who "I" am, for the review's own engagement checks.
  if (/^\/?user\/?$/.test(endpoint)) return { allow: true };
  // "repos/a/b/../../c/d" would pass the repository check and reach another
  // repository — and so would "..%2F..", the %2F (below) read as the slash it stands for.
  if (endpoint.split("?")[0].replace(/%2f/gi, "/").split("/").some((seg) => seg === "." || seg === "..")) return deny("Dot segments are not allowed in gh api paths.");
  const repo = endpoint.replace(/^\//, "").split("/").slice(1, 3).join("/").toLowerCase();
  // A relative REST path of the run's own repository: no other host (no "://"),
  // no other repository, no {owner} placeholders resolved from a remote. Past
  // owner/name a segment may hold %2F — a branch name's slash, as in
  // "branches/release%2F2.0" — and no other escape.
  if (!/^\/?repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/(?:[A-Za-z0-9._-]|%2[Ff])+)*\/?(\?[A-Za-z0-9._=&%-]*)?$/.test(endpoint)) {
    // This PR's repository, written with something the path doesn't take: say that, not "another repository".
    if (pr && /^\/?repos\//.test(endpoint) && repo === pr.repo) {
      return deny("A gh api path takes letters, digits, '.', '_', '-' and %2F (a slash inside a branch name) — nothing else.");
    }
    return deny("Only GitHub REST reads of this PR's repository (repos/owner/name/…) are allowed.");
  }
  if (pr && repo !== pr.repo) return deny(`This run reads ${pr.repo} only.`);
  return { allow: true };
}

/**
 * The gh pr view/diff/checks (and run view) flags an agent run may pass, and
 * whether each takes a value. Anything else is refused — an allow-list, so a
 * flag added to gh later can't slip through.
 */
const GH_PR_FLAGS: Record<string, "flag" | "value"> = {
  "--json": "value",
  "--jq": "value",
  "-q": "value",
  "--template": "value",
  "-t": "value",
  "--repo": "value",
  "-R": "value",
  "--color": "value",
  "--comments": "flag",
  "--name-only": "flag",
  "--patch": "flag",
  "--required": "flag",
  "--log": "flag",
  "--log-failed": "flag",
};

function checkGhPr(args: string[], pr: GuardPr | null): GuardDecision {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      // `--name=value`, `--name value`, `-Rvalue` (attached short) and `-R value`.
      const long = a.startsWith("--");
      const name = long ? a.split("=")[0] : a.slice(0, 2);
      const attached = long ? (a.includes("=") ? a.slice(a.indexOf("=") + 1) : null) : a.length > 2 ? a.slice(2) : null;
      const kind = GH_PR_FLAGS[name];
      if (a === "--") {
        const { repo, n } = prWords(pr);
        return deny(`gh pr diff takes no file paths in agent runs: take the file from the whole diff, or its patch alone with gh api repos/${repo}/pulls/${n}/files --paginate --jq '.[] | select(.filename == "PATH") | .patch'.`);
      }
      if (!kind) return deny(`gh ${name} is not one of the flags agent runs may use.`);
      if (kind === "flag") {
        if (attached !== null) return deny(`${name} takes no value.`);
        continue;
      }
      let value = attached;
      if (value === null) {
        if (args[i + 1] === undefined || args[i + 1].startsWith("-")) return deny(`${name} needs a value that isn't a flag.`);
        value = args[++i];
      }
      if ((name === "--repo" || name === "-R") && pr && value.toLowerCase() !== pr.repo) {
        return deny(`This run reads ${pr.repo} only.`);
      }
      continue;
    }
    // The positional: this PR's number or URL, nothing else.
    if (pr && a !== String(pr.number) && a.replace(/\/$/, "") !== pr.url) return deny(`This run reads PR #${pr.number} only.`);
  }
  return { allow: true };
}

/** `gh auth status`: which account is signed in — never with the token itself. */
function checkGhAuthStatus(args: string[], pr: GuardPr | null): GuardDecision {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--active" || a === "-a") continue;
    const name = a.startsWith("--") ? a.split("=")[0] : a.slice(0, 2);
    if (name !== "--hostname" && name !== "-h") return deny("gh auth status takes only --hostname and --active in agent runs.");
    const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : a.length > 2 && !a.startsWith("--") ? a.slice(2) : args[++i];
    if (!value || value.startsWith("-")) return deny(`${name} needs a value that isn't a flag.`);
    if (pr && value.toLowerCase() !== pr.host) return deny(`This run reads ${pr.host} only.`);
  }
  return { allow: true };
}

function checkGh(words: string[], pr: GuardPr | null): GuardDecision {
  const [, group, sub] = words;
  if (group === "api") return checkGhApi(words.slice(2), pr);
  if (group === "pr" && (sub === "view" || sub === "diff" || sub === "checks")) return checkGhPr(words.slice(3), pr);
  if (group === "run" && sub === "view") return checkGhPr(words.slice(3).filter((w) => !/^\d+$/.test(w)), pr);
  if (group === "auth" && sub === "status") return checkGhAuthStatus(words.slice(3), pr);
  return deny("Agent runs read from GitHub only; the app posts the result itself.");
}

/**
 * The Atlassian `twg` CLI, for reading the PR's Jira task (the review skill
 * refuses to review without its acceptance criteria), Confluence pages, and
 * what the after-merge dry run checks. Its command path is the leading
 * lower-case words — `twg jira workitem get ENG-1 -o json` → `jira workitem
 * get` — and that path must be one of the reads below, exactly: a word before
 * or after a read verb can turn it into a write (`… transition`, `… comment
 * create`), so a verb alone is never enough. `help` may take any topic.
 * A flag that names a file to write or a program to open is refused too.
 */
export const TWG_READ_PATHS: ReadonlySet<string> = new Set([
  "jira workitem get",
  "jira workitem query",
  "jira workitem changelog query",
  "jira workitem transitions query",
  "jira workitem link-types query",
  "confluence content get",
  "confluence search query",
  "rovo search",
  "context user",
  "whoami",
  "pr-tree",
  "workitem-tree",
  "work-tree",
  "commits",
  "user-search",
  "recently-viewed",
  "capabilities",
]);

/**
 * The twg flags a read may pass, and whether each takes a value. Anything
 * else is refused: an unknown flag's arity is unknown, and a word taken for
 * its value could be read by twg as a subcommand instead.
 */
const TWG_FLAGS: Record<string, "flag" | "value"> = {
  "-o": "value",
  "--output": "value",
  "--output-summary": "value",
  "--detail": "value",
  "--format": "value",
  "--jql": "value",
  "--cql": "value",
  "--query": "value",
  "--limit": "value",
  "--max-results": "value",
  "--fields": "value",
  "--expand": "value",
  "--cursor": "value",
  "--site": "value",
  "--space": "value",
  "--type": "value",
  "--all": "flag",
  "--help": "flag",
  "-h": "flag",
};

/**
 * The lower-case values a value flag may take as a separate word. Any other
 * separate value must not read like a subcommand: were twg to parse the flag
 * as taking no value, a word like `create` would land in the command path.
 * Anything at all may go attached (`--jql=…`).
 */
const TWG_FLAG_WORDS: Record<string, ReadonlySet<string>> = {
  "-o": new Set(["json", "yaml", "text", "table", "md", "markdown", "csv"]),
  "--output": new Set(["json", "yaml", "text", "table", "md", "markdown", "csv"]),
  "--output-summary": new Set(["none", "auto", "always", "never", "full", "brief"]),
  "--detail": new Set(["full", "summary", "brief", "minimal", "standard"]),
  "--format": new Set(["md", "markdown", "html", "adf", "storage", "text", "json", "view", "wiki"]),
};

const SUBCOMMAND_LIKE = /^[a-z][a-z-]*$/;

function checkTwg(words: string[]): GuardDecision {
  const path: string[] = [];
  let i = 1;
  for (; i < words.length && SUBCOMMAND_LIKE.test(words[i]); i++) path.push(words[i]);
  const cmd = path.join(" ");
  // `help` only describes commands, whatever topic it is given — but its
  // flags are held to the same list as every read's.
  if (path[0] !== "help" && !TWG_READ_PATHS.has(cmd)) {
    return deny(`twg ${cmd || "…"} is not one of the reads agent runs may use (${[...TWG_READ_PATHS].slice(0, 4).join(", ")}, …) — the app leaves Jira changes to you.`);
  }
  // After the path: known flags with their values, and positionals that can't
  // pass for a subcommand (an issue key, a page id, a quoted phrase) — so no
  // parser, however it orders flags and words, can find a write in there.
  for (; i < words.length; i++) {
    const w = words[i];
    if (w.startsWith("-")) {
      // A second line of defence, whatever the list says.
      if (/file|dir|save|write|exec|editor|open|browser|yes|force|apply/i.test(w)) return deny("That twg flag writes or opens something; agent runs only read.");
      const long = w.startsWith("--");
      const name = long ? w.split("=")[0] : w;
      // A short flag is exactly `-o` or `-h`: `-ofile` reads differently in different parsers.
      const kind = TWG_FLAGS[name];
      if (!kind) return deny(`twg ${name} is not one of the flags agent runs may use${long ? "" : " (short flags go on their own: -o json)"}.`);
      const attached = long && w.includes("=");
      if (kind === "flag" && attached) return deny(`${name} takes no value.`);
      if (kind === "value" && !attached) {
        const value = words[i + 1];
        if (value === undefined || value.startsWith("-")) return deny(`${name} needs a value that isn't a flag.`);
        if (SUBCOMMAND_LIKE.test(value) && !TWG_FLAG_WORDS[name]?.has(value)) {
          return deny(`"${value}" after ${name} reads like a subcommand; write it attached (${long ? name : "--output"}=${value}) or quoted with a space.`);
        }
        i++;
      }
      continue;
    }
    if (SUBCOMMAND_LIKE.test(w)) return deny(`"${w}" after twg ${cmd} reads like a subcommand; quote a search phrase or put it in a flag.`);
  }
  return { allow: true };
}

/** A call of this run's publish wrapper: checked the way the wrapper checks it, and held to the PR and the run's folder. */
function checkWrapper(words: string[], pr: GuardPr | null, outDir: string, subs?: PublishSub[]): GuardDecision {
  const sub = words[1] ?? "";
  // The skill's own wrapper also edits a "Reviewing now" status comment; the app's posts none.
  if (sub === "status" || sub === "status-edit") {
    return deny("PUBLISH-REJECTED: the app's wrapper posts no status comment — skip it and go on (start the review workflow with statusComment: false); the app shows the run's progress itself.");
  }
  const call = parsePublishCall(words.slice(1));
  if (!call.ok) {
    // `--help`, or nothing: the usage, and where its files go — the wrapper is the app's own, so there is no more to read.
    const asked = !sub || /^(-h|--help|help|-\?)$/.test(sub);
    return deny(`PUBLISH-REJECTED: ${call.error}${asked ? ` — the app's own wrapper: it records each write and posts nothing; write every file under ${outDir.replace(/\\/g, "/")}/ and pass its absolute path.` : ""}`);
  }
  const c = call.value;
  if (subs && !subs.includes(c.sub)) return deny(`PUBLISH-REJECTED: this run may not ${c.sub}; it may ${subs.join(", ")}.`);
  if (c.sub !== "resolve") {
    if (pr && (c.repo.toLowerCase() !== pr.repo || c.number !== pr.number)) return deny(`This run publishes to ${pr.repo}#${pr.number} only.`);
    if (!isInsideDir(c.file, outDir)) return deny(`Write the file under ${outDir} and pass its absolute path.`);
  }
  return { allow: true };
}

function checkGit(kind: AgentRunKind, words: string[], pr: GuardPr | null, run: GuardRun | null, real: RealPath): GuardDecision {
  // Not even the reading subcommands: `git diff` and `git log -p` run textconv
  // filters by default, and the PR's own .gitattributes picks which files go
  // through them. A read-only run takes the diff from `gh pr diff`.
  if (READ_ONLY.has(kind)) {
    const instead = gitInstead(pr, DEFAULT_AGENT_TOOLS[kind]);
    return deny(`This run only reads, and git can run configured filters on the PR's files — so no git; use gh${instead.length ? `: ${instead.join("; ")}` : " pr diff / gh pr view"}.`);
  }
  const sub = words[1] ?? "";
  // Global options come before the subcommand: `-C <dir>` moves the
  // repository, `-c` rewrites config (aliases, pagers).
  if (sub.startsWith("-")) return deny(`git global options (-C, -c, --git-dir, …) are not allowed in agent runs${sub === "-C" ? " — git already runs in the worktree: drop -C <dir>" : ""}.`);
  // Drive (stage 5) does not rely on this alone: its worktree has no push URL,
  // and the app pushes the branch itself after checking the commit.
  if (sub === "push") return deny("Agent runs don't push from the shell — the app pushes your branch itself.");
  if (!GIT_DRIVE.has(sub)) return deny(`git ${sub} is not one of the git commands agent runs may use.`);
  if (words.some((w) => gitLongOption(w, GIT_DANGEROUS))) {
    return deny("That git flag writes files or runs programs; agent runs can't use it.");
  }
  return checkGitFiles(sub, words.slice(2), run, real);
}

export function checkBash(
  kind: AgentRunKind,
  rawCommand: string,
  pr: GuardPr | null = null,
  run: GuardRun | null = null,
  real: RealPath = asWritten,
  requests: RequestStore = NO_REQUESTS,
): GuardDecision {
  const preflight = kind === "review" || kind === "rereview" ? checkPreflight(rawCommand, pr, run, real, requests) : null;
  if (preflight) return preflight;
  const split = shellWords(rawCommand);
  if ("error" in split) return deny(refusedSyntax(kind, rawCommand, split.error, run));
  const words = split.words;
  if (words.length === 0) return deny("An empty command.");
  // `FOO=1 git push` would slip past a check on the program's name.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const gh = /^GH_(HOST|REPO)=/.test(words[0]) ? " — gh already points at this PR's host and repository" : "";
    return deny(`Commands can't start with environment assignments in agent runs${gh}: run the command without ${words[0].split("=")[0]}=….`);
  }
  if (run?.wrapperPath && run.outDir && samePath(words[0], run.wrapperPath)) return checkWrapper(words, pr, run.outDir, run.subs);
  if (words[0] === "git") return checkGit(kind, words, pr, run, real);
  if (words[0] === "gh") return checkGh(words, pr);
  if (words[0] === "twg") return checkTwg(words);
  if (READ_ONLY.has(kind)) return deny(readOnlyRefusal(words, run));
  return { allow: true };
}

/** The path a file tool is about to write, as Claude Code reports it. */
export function toolFilePath(input: unknown): string {
  const i = (input ?? {}) as { file_path?: unknown; notebook_path?: unknown };
  return typeof i.file_path === "string" ? i.file_path : typeof i.notebook_path === "string" ? i.notebook_path : "";
}

/**
 * The decision for one tool call; `input` is the tool's input as Claude Code
 * reports it, `pr` the PR the run works on (its gh reads are held to it), `run`
 * what the run may reach (its folders, its wrapper and payload folder), if
 * anything, and `real` how a read's path is followed to where it leads.
 */
export function checkToolUse(
  kind: AgentRunKind,
  toolName: string,
  input: unknown,
  pr: GuardPr | null = null,
  run: GuardRun | null = null,
  real: RealPath = asWritten,
  requests: RequestStore = NO_REQUESTS,
): GuardDecision {
  if (run?.mode === "full" && kind === "drive") return checkFullToolUse(toolName, input, pr, run);
  if (NEVER.has(toolName)) return deny(`${toolName} is not available to agent runs.`);
  if (toolName === "Workflow") return checkWorkflow(input, run);
  if (READ_TOOLS.has(toolName)) return checkRead(toolName, input, run, real);
  if (READ_ONLY.has(kind) && WRITE_TOOLS.has(toolName)) {
    // A review writes the payload files its publish step hands the wrapper —
    // new files in its own folder, nothing in the PR's checkout.
    const outDir = run?.outDir;
    if (outDir && toolName === "Write" && isInsideDir(toolFilePath(input), outDir)) return { allow: true };
    // The preflight's agent writes its request where its TEMP points — the run's own temp folder, which node may not read from.
    const file = toolFilePath(input);
    const pf = run?.preflight;
    const tmp = pf ? real(pf.tmpDir) : null;
    const toTmp = run && pf && tmp && file && isInsideDir(real(file) ?? file, tmp) ? ` The review preflight's request goes there too — ${preflightUsage(run, pf)}` : "";
    return deny(outDir ? `This run only reads; it writes payload files under ${outDir} and nothing else.${toTmp}` : "This run only reads; it can't change files.");
  }
  // A drive run edits its own worktree — and writes reply files for its
  // wrapper into its payload folder — and nothing else.
  if (!READ_ONLY.has(kind) && WRITE_TOOLS.has(toolName)) {
    if (run?.outDir && toolName === "Write" && isInsideDir(toolFilePath(input), run.outDir)) return { allow: true };
    if (!run?.workDir) return deny("This run has no worktree to change.");
    return checkDriveWrite(toolFilePath(input), run.workDir);
  }
  if (toolName === "Bash") {
    const command = typeof (input as { command?: unknown } | null)?.command === "string" ? (input as { command: string }).command : "";
    if (!command.trim()) return deny("An empty command.");
    return checkBash(kind, command, pr, run, real, requests);
  }
  if (SESSION_TOOLS.has(toolName)) return { allow: true };
  return deny(`${toolName || "That tool"} is not one of the tools agent runs may use.`);
}

// ---------------------------------------------------------------------------
// Full context: a drive on your own PR (Settings › Agent › "Your PRs: full
// context"). The session runs with your CLAUDE.md, hooks, plugins and MCP
// servers, reads and writes anywhere you can, runs any command. What it still
// may not do is write to GitHub — the app pushes the commits and posts the
// replies itself, after your click in Shadow. This is a denylist and a
// best-effort one: it stops a model that forgets the rule (`git push`,
// `gh pr comment`, a GitHub MCP write tool), not a script that hides the call
// (`sh script.sh`, `python -c`). The hard boundary for the push is the
// session's environment (`sessionGitEnv`): no credentials, every remote URL
// rewritten to one git can't reach.
// ---------------------------------------------------------------------------

/** Programs that run the next word as the command: their own flags and assignments are skipped. */
const COMMAND_PREFIXES = new Set(["sudo", "env", "command", "exec", "nohup", "time", "xargs", "nice", "caffeinate"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** A lenient split for full-context runs: quotes are taken off, operators and substitutions start a new command. */
export function looseCommands(command: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let cur = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(cur);
    cur = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1);
      const stop = end < 0 ? command.length : end;
      const inner = command.slice(i + 1, stop);
      // A substitution inside double quotes runs too.
      if (ch === '"' && /\$\(|`/.test(inner)) for (const c of looseCommands(inner.replace(/^[^$`]*(\$\(|`)/, ""))) out.push(c);
      cur += inner;
      inWord = true;
      i = stop;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      cur += command[++i];
      inWord = true;
      continue;
    }
    if (";&|()`\n\r{}".includes(ch) || (ch === "$" && command[i + 1] === "(")) {
      endCommand();
      continue;
    }
    if (ch === " " || ch === "\t") {
      endWord();
      continue;
    }
    cur += ch;
    inWord = true;
  }
  endCommand();
  return out;
}

/** The program and its arguments, past assignments and `sudo`/`env`/`xargs`-like prefixes; the program by its base name. */
function commandCore(words: string[]): string[] {
  let i = 0;
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    const name = (words[i] ?? "").split("/").pop() ?? "";
    if (!COMMAND_PREFIXES.has(name)) break;
    i++;
    while (i < words.length && words[i].startsWith("-")) i++;
  }
  const rest = words.slice(i);
  if (rest.length > 0) rest[0] = rest[0].split("/").pop() ?? rest[0];
  return rest;
}

const GH_WRITES: Record<string, ReadonlySet<string> | "all-but-read"> = {
  pr: new Set(["comment", "review", "merge", "edit", "close", "create", "ready", "reopen", "lock", "unlock", "update-branch"]),
  issue: new Set(["create", "comment", "edit", "close", "reopen", "delete", "transfer", "pin", "unpin", "lock", "unlock", "develop"]),
  repo: new Set(["create", "edit", "delete", "fork", "rename", "archive", "unarchive", "sync"]),
  label: new Set(["create", "edit", "delete", "clone"]),
  secret: new Set(["set", "delete"]),
  variable: new Set(["set", "delete"]),
  release: "all-but-read",
  gist: new Set(["create", "edit", "delete", "rename"]),
};
const GH_RELEASE_READS = new Set(["list", "view", "download"]);

function fullGhApi(args: string[]): GuardDecision {
  let endpoint: string | null = null;
  const fields: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const attached = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : null;
    const value = (): string => attached ?? args[++i] ?? "";
    if (name === "-X" || name === "--method") {
      if (value().toUpperCase() !== "GET") return deny("This session doesn't write to GitHub — the app pushes and posts after your click.");
    } else if (/^-X./.test(a)) {
      if (a.slice(2).toUpperCase() !== "GET") return deny("This session doesn't write to GitHub — the app pushes and posts after your click.");
    } else if (FIELD_FLAGS.has(name) || /^-[fF]./.test(a)) {
      fields.push(/^-[fF]./.test(a) ? a.slice(2) : value());
    } else if (name === "--input") {
      return deny("gh api --input sends a request body; this session doesn't write to GitHub.");
    } else if (!a.startsWith("-") && endpoint === null) {
      endpoint = a;
    }
  }
  if (fields.length === 0) return { allow: true };
  // With fields gh sends a POST: only a GraphQL query is a read.
  if (endpoint === "graphql" && !fields.some((f) => /\bmutation\b/i.test(f))) return { allow: true };
  return deny("That gh api call writes to GitHub; this session doesn't — the app pushes and posts after your click.");
}

function fullCommand(words: string[], pr: GuardPr | null, run: GuardRun, depth: number): GuardDecision {
  if (run.wrapperPath && run.outDir && words[0] && samePath(words[0], run.wrapperPath)) return checkWrapper(words, pr, run.outDir, run.subs);
  const w = commandCore(words);
  const prog = w[0] ?? "";
  if (SHELLS.has(prog)) {
    const c = w.indexOf("-c");
    if (c > 0 && w[c + 1] !== undefined && depth < 3) return checkFullBash(w[c + 1], pr, run, depth + 1);
    return { allow: true };
  }
  if (prog === "git") {
    let i = 1;
    for (; i < w.length && w[i].startsWith("-"); i++) {
      if (w[i] === "-c" && /^alias\./i.test(w[i + 1] ?? "")) return deny("git aliases set on the command line are not allowed here.");
      if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(w[i])) i++;
    }
    const sub = w[i] ?? "";
    if (sub === "push" || sub === "send-pack") return deny("This session doesn't push — the app pushes your branch after your click.");
    return { allow: true };
  }
  if (prog === "gh") {
    const group = w[1] ?? "";
    const sub = w[2] ?? "";
    if (group === "api") return fullGhApi(w.slice(2));
    const writes = GH_WRITES[group];
    if (writes === "all-but-read" ? sub !== "" && !GH_RELEASE_READS.has(sub) : writes?.has(sub)) {
      return deny(`gh ${group} ${sub} writes to GitHub; this session doesn't — the app pushes and posts the replies after your click.`);
    }
  }
  return { allow: true };
}

export function checkFullBash(command: string, pr: GuardPr | null, run: GuardRun, depth = 0): GuardDecision {
  for (const words of looseCommands(command)) {
    const d = fullCommand(words, pr, run, depth);
    if (!d.allow) return d;
  }
  return { allow: true };
}

/** The read tools of a GitHub MCP server; any other tool of it writes. */
const GITHUB_MCP_READ = /^(get_|list_|search_)|_read$|^(actions_get|actions_list|projects_get|projects_list|web_search|semantic_issue_similarity_search|check_dependency_vulnerabilities)$/;

/** `mcp__<server>__<tool>`: a GitHub (or GHE) server's tool that writes. */
export function isGithubMcpWrite(toolName: string): boolean {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!m) return false;
  if (!/(^|[_-])(github|ghe)([_-]|$)/i.test(m[1])) return false;
  return !GITHUB_MCP_READ.test(m[2]);
}

/** A full-context drive: everything but writing to GitHub. */
export function checkFullToolUse(toolName: string, input: unknown, pr: GuardPr | null, run: GuardRun): GuardDecision {
  if (toolName === "Bash") {
    const command = typeof (input as { command?: unknown } | null)?.command === "string" ? (input as { command: string }).command : "";
    return checkFullBash(command, pr, run);
  }
  if (isGithubMcpWrite(toolName)) {
    return deny(`${toolName} writes to GitHub; this session doesn't — the app pushes and posts the replies after your click.`);
  }
  return { allow: true };
}

const RUN_KINDS: readonly AgentRunKind[] = ["review", "brief", "rereview", "drive", "afterMerge"];

export function isAgentRunKind(value: unknown): value is AgentRunKind {
  return RUN_KINDS.includes(value as AgentRunKind);
}
