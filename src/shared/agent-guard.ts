import { isInsideDir, parsePublishCall, samePath } from "./agent-publish";
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

export type GuardDecision = { allow: true } | { allow: false; reason: string };

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
 * What one run may do beyond reading, from the guard file the app writes for
 * it (passed to the hook): a review's own publish wrapper (which records,
 * never posts — `agent-publish.ts`) and payload folder, and the plugin folders
 * a skill's Workflow script may come from.
 */
export interface GuardRun {
  wrapperPath?: string;
  outDir?: string;
  /** Plugin folders: a Workflow may run a script from inside one of these, and from nowhere else. */
  workflowDirs?: string[];
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
  if (!script) return deny(`Agent runs start a skill's workflow by its script path${dirs.length ? ` (inside ${dirs.join(" or ")})` : ""}, not by name.`);
  return deny(`Agent runs only run a skill's own workflow script${dirs.length ? ` — from ${dirs.join(" or ")}` : ""}, never one from the PR.`);
}

/** Runs that only read: reviews, briefs, re-reviews, the after-merge dry run. */
const READ_ONLY: ReadonlySet<AgentRunKind> = new Set(["review", "brief", "rereview", "afterMerge"]);

/** File tools that change files — never in a read-only run. */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Tools no agent run gets, whatever the list says: network, other shells. */
const NEVER = new Set(["WebFetch", "WebSearch", "PowerShell", "REPL"]);

function deny(reason: string): GuardDecision {
  return { allow: false, reason };
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
    if ("*?[]".includes(ch)) return { error: "Unquoted wildcards are not allowed — they would expand to the PR's own file names." };
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
 * subcommand, matched as prefixes so `--output=x` counts: `--output` writes
 * anywhere, `--ext-diff`/`--textconv` run configured programs, `--no-index`
 * reads outside the repository, the pack ones run a remote program.
 */
const GIT_DANGEROUS = ["--output", "--ext-diff", "--textconv", "--no-index", "--exec-path", "--upload-pack", "--receive-pack", "--exec"];

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
  "fetch",
  "rebase",
  "merge",
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
 * GraphQL root fields a read may start from. `repository` is held to the PR's
 * own; `node(s)` only to the PR-thread types the review re-reads by id.
 * Anything wider — `search`, `organization`, another repository — could read
 * code the PR's author can't see, for a review comment to repeat it.
 */
const GRAPHQL_ROOTS = new Set(["repository", "viewer", "rateLimit", "node", "nodes", "user"]);
const GRAPHQL_NODE_TYPES = new Set(["PullRequestReviewThread", "PullRequestReviewComment", "PullRequestReview", "PullRequest", "IssueComment"]);

type GqlToken = { t: "name" | "string" | "punct" | "var"; v: string };

function gqlTokens(query: string): GqlToken[] | null {
  const out: GqlToken[] = [];
  let i = 0;
  while (i < query.length) {
    const ch = query[i];
    if (/\s|,/.test(ch)) {
      i++;
    } else if (ch === "#") {
      while (i < query.length && query[i] !== "\n") i++;
    } else if (ch === '"') {
      let v = "";
      i++;
      while (i < query.length && query[i] !== '"') {
        if (query[i] === "\\") i++;
        v += query[i] ?? "";
        i++;
      }
      if (i >= query.length) return null;
      i++;
      out.push({ t: "string", v });
    } else if (ch === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(query.slice(i));
      if (!m) return null;
      out.push({ t: "var", v: m[0].slice(1) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(query.slice(i))!;
      out.push({ t: "name", v: m[0] });
      i += m[0].length;
    } else if (query.startsWith("...", i)) {
      out.push({ t: "punct", v: "..." });
      i += 3;
    } else if ("{}():!=[]@".includes(ch) || /[0-9-]/.test(ch)) {
      out.push({ t: "punct", v: ch });
      i++;
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Whether a GraphQL document only reads, and only from where a review of this
 * PR needs to: no mutation or subscription, no fragment spread at the root,
 * root fields from `GRAPHQL_ROOTS`, `repository(owner, name)` naming this PR's
 * repository (literally or through a variable passed with -F/-f), and
 * `node(s)` selecting only PR-thread types.
 */
export function checkGraphqlRead(query: string, vars: Record<string, string>, pr: GuardPr | null): GuardDecision {
  const toks = gqlTokens(query);
  if (!toks) return deny("That GraphQL query couldn't be read; agent runs send plain queries.");
  if (toks.some((k) => k.t === "name" && (k.v === "mutation" || k.v === "subscription"))) {
    return deny("gh api graphql can only read in agent runs — the app posts the result itself.");
  }
  if (toks.some((k) => k.t === "name" && k.v === "fragment")) return deny("GraphQL fragments are not allowed in agent runs; inline the fields.");
  const value = (k: GqlToken | undefined) => (k?.t === "string" ? k.v : k?.t === "var" ? vars[k.v] : undefined);
  let depth = 0;
  let parenDepth = 0;
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i];
    if (k.v === "(") parenDepth++;
    else if (k.v === ")") parenDepth--;
    else if (k.v === "{") depth++;
    else if (k.v === "}") depth--;
    if (parenDepth > 0 || depth !== 1 || k.v === "{" || k.v === "}") continue;
    // A root selection: `field`, `alias: field`, possibly with (args) and a selection set.
    if (k.v === "...") return deny("Fragment spreads at the root are not allowed in agent runs.");
    if (k.t !== "name") continue;
    let field = k.v;
    if (toks[i + 1]?.v === ":" && toks[i + 2]?.t === "name") {
      field = toks[i + 2].v;
      i += 2;
    }
    if (!GRAPHQL_ROOTS.has(field)) return deny(`GraphQL reads start from this PR's repository in agent runs, not from ${field}.`);
    // Its arguments, when it has them.
    const args: Record<string, GqlToken | undefined> = {};
    let j = i + 1;
    if (toks[j]?.v === "(") {
      let d = 0;
      for (; j < toks.length; j++) {
        if (toks[j].v === "(") d++;
        else if (toks[j].v === ")" && --d === 0) break;
        else if (d === 1 && toks[j].t === "name" && toks[j + 1]?.v === ":") args[toks[j].v] = toks[j + 2];
      }
      j++;
    }
    if (field === "repository" && pr) {
      const repo = `${value(args.owner) ?? ""}/${value(args.name) ?? ""}`.toLowerCase();
      if (repo !== pr.repo) return deny(`This run reads ${pr.repo} only.`);
    }
    if ((field === "node" || field === "nodes") && toks[j]?.v === "{") {
      // Every selection directly inside must be `... on <PR-thread type>`.
      let d = 0;
      for (let m = j; m < toks.length; m++) {
        if (toks[m].v === "{") d++;
        else if (toks[m].v === "}" && --d === 0) break;
        else if (d === 1 && toks[m].t === "name") {
          if (toks[m].v === "on") {
            if (!GRAPHQL_NODE_TYPES.has(toks[m + 1]?.v ?? "")) return deny("node(s) reads only review threads and comments in agent runs.");
            m++;
            continue;
          }
          if (toks[m].v === "id" || toks[m].v === "__typename") continue;
          return deny("node(s) reads only review threads and comments in agent runs; select them with `... on PullRequestReviewThread`.");
        }
      }
    }
  }
  return { allow: true };
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
      if (!kind) return deny("gh api is read-only in agent runs: only --jq, --paginate, --slurp, --cache, --include, --silent, --hostname and Accept headers.");
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
  // "repos/a/b/../../c/d" would pass the repository check and reach another repository.
  if (endpoint.split("?")[0].split("/").some((seg) => seg === "." || seg === "..")) return deny("Dot segments are not allowed in gh api paths.");
  // A relative REST path of the run's own repository: no other host (no "://"),
  // no other repository, no {owner} placeholders resolved from a remote.
  if (!/^\/?repos\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?(\?[A-Za-z0-9._=&%-]*)?$/.test(endpoint)) {
    return deny("Only GitHub REST reads of this PR's repository (repos/owner/name/…) are allowed.");
  }
  if (pr) {
    const repo = endpoint.replace(/^\//, "").split("/").slice(1, 3).join("/").toLowerCase();
    if (repo !== pr.repo) return deny(`This run reads ${pr.repo} only.`);
  }
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
 * refuses to review without its acceptance criteria) and Confluence pages. Its
 * command path is lower-case words ending in a reading verb —
 * `twg jira workitem get ENG-1 -o json` — so a path naming a write (`update`,
 * `transition`, `create`, …), the raw `api`, or account setup is refused, as is
 * any flag that names a file to write or a program to open.
 */
const TWG_READ_VERBS = new Set([
  "get",
  "query",
  "search",
  "list",
  "describe",
  "bulk-lookup",
  "types",
  "status",
  "overview",
  "tree",
  "help",
  "whoami",
  "pr-tree",
  "workitem-tree",
  "work-tree",
  "org-tree",
  "focus-areas-tree",
  "commits",
  "collaborators",
  "deployments",
  "user-search",
  "recently-viewed",
  "capabilities",
  "inbox",
  "peers",
  "manager",
  "manager-chain",
  "direct-reports",
  "jira-links",
  "content-references",
  "space-content",
]);
const TWG_NEVER = new Set(["api", "login", "logout", "setup", "upgrade", "uninstall", "consent", "feedback", "env", "cache", "auth", "admin", "completion", "doctor", "install"]);

function checkTwg(words: string[]): GuardDecision {
  let verb: string | null = null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (TWG_NEVER.has(w)) return deny(`twg ${w} is not available to agent runs.`);
    if (!/^[a-z][a-z-]*$/.test(w)) break;
    if (TWG_READ_VERBS.has(w)) {
      verb = w;
      break;
    }
  }
  if (!verb) return deny("Agent runs may only read with twg (get, search, query, list, …) — the app leaves Jira changes to you.");
  if (words.some((w) => w.startsWith("-") && /file|dir|save|write|exec|editor|open|browser|yes|force|apply/i.test(w))) {
    return deny("That twg flag writes or opens something; agent runs only read.");
  }
  return { allow: true };
}

/** A call of this run's publish wrapper: checked the way the wrapper checks it, and held to the PR and the run's folder. */
function checkWrapper(words: string[], pr: GuardPr | null, outDir: string): GuardDecision {
  const call = parsePublishCall(words.slice(1));
  if (!call.ok) return deny(`PUBLISH-REJECTED: ${call.error}`);
  const c = call.value;
  if (c.sub !== "resolve") {
    if (pr && (c.repo.toLowerCase() !== pr.repo || c.number !== pr.number)) return deny(`This run publishes to ${pr.repo}#${pr.number} only.`);
    if (!isInsideDir(c.file, outDir)) return deny(`Write the file under ${outDir} and pass its absolute path.`);
  }
  return { allow: true };
}

function checkGit(kind: AgentRunKind, words: string[]): GuardDecision {
  // Not even the reading subcommands: `git diff` and `git log -p` run textconv
  // filters by default, and the PR's own .gitattributes picks which files go
  // through them. A read-only run takes the diff from `gh pr diff`.
  if (READ_ONLY.has(kind)) return deny("This run only reads, and git can run configured filters on the PR's files — use gh pr diff / gh pr view.");
  const sub = words[1] ?? "";
  // Global options come before the subcommand: `-C <dir>` moves the
  // repository, `-c` rewrites config (aliases, pagers).
  if (sub.startsWith("-")) return deny("git global options (-C, -c, --git-dir, …) are not allowed in agent runs.");
  // Drive (stage 5) does not rely on this alone: its worktree has no push URL,
  // and the app pushes the branch itself after checking the commit.
  if (sub === "push") return deny("Agent runs don't push from the shell — the app pushes your branch itself.");
  if (!GIT_DRIVE.has(sub)) return deny(`git ${sub} is not one of the git commands agent runs may use.`);
  if (words.some((w) => GIT_DANGEROUS.some((f) => w === f || w.startsWith(`${f}=`)))) {
    return deny("That git flag writes files or runs programs; agent runs can't use it.");
  }
  return { allow: true };
}

export function checkBash(kind: AgentRunKind, rawCommand: string, pr: GuardPr | null = null, run: GuardRun | null = null): GuardDecision {
  const split = shellWords(rawCommand);
  if ("error" in split) return deny(split.error);
  const words = split.words;
  if (words.length === 0) return deny("An empty command.");
  // `FOO=1 git push` would slip past a check on the program's name.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) return deny("Commands can't start with environment assignments in agent runs.");
  if (run?.wrapperPath && run.outDir && samePath(words[0], run.wrapperPath)) return checkWrapper(words, pr, run.outDir);
  if (words[0] === "git") return checkGit(kind, words);
  if (words[0] === "gh") return checkGh(words, pr);
  if (words[0] === "twg") return checkTwg(words);
  if (READ_ONLY.has(kind)) return deny("This run only reads: it doesn't run commands from the PR's repository.");
  return { allow: true };
}

/** The path a file tool is about to write, as Claude Code reports it. */
function toolFilePath(input: unknown): string {
  const i = (input ?? {}) as { file_path?: unknown; notebook_path?: unknown };
  return typeof i.file_path === "string" ? i.file_path : typeof i.notebook_path === "string" ? i.notebook_path : "";
}

/**
 * The decision for one tool call; `input` is the tool's input as Claude Code
 * reports it, `pr` the PR the run works on (its gh reads are held to it), `run`
 * what a review run may write (its wrapper and payload folder), if anything.
 */
export function checkToolUse(kind: AgentRunKind, toolName: string, input: unknown, pr: GuardPr | null = null, run: GuardRun | null = null): GuardDecision {
  if (NEVER.has(toolName)) return deny(`${toolName} is not available to agent runs.`);
  if (toolName === "Workflow") return checkWorkflow(input, run);
  if (READ_ONLY.has(kind) && WRITE_TOOLS.has(toolName)) {
    // A review writes the payload files its publish step hands the wrapper —
    // new files in its own folder, nothing in the PR's checkout.
    const outDir = run?.outDir;
    if (outDir && toolName === "Write" && isInsideDir(toolFilePath(input), outDir)) return { allow: true };
    return deny(outDir ? `This run only reads; it writes payload files under ${outDir} and nothing else.` : "This run only reads; it can't change files.");
  }
  if (toolName === "Bash") {
    const command = typeof (input as { command?: unknown } | null)?.command === "string" ? (input as { command: string }).command : "";
    if (!command.trim()) return deny("An empty command.");
    return checkBash(kind, command, pr, run);
  }
  return { allow: true };
}

const RUN_KINDS: readonly AgentRunKind[] = ["review", "brief", "rereview", "drive", "afterMerge"];

export function isAgentRunKind(value: unknown): value is AgentRunKind {
  return RUN_KINDS.includes(value as AgentRunKind);
}
