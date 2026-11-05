import { gitBashPath, isInsideDir, parsePublishCall, samePath, type PublishSub } from "./agent-publish";
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
  /** The wrapper subcommands this run may use (a drive run only replies); absent = all. */
  subs?: PublishSub[];
  /** A drive run's worktree: the only place its file tools may change. */
  workDir?: string;
}

/**
 * Inside a drive run's worktree, what it still may not change: git's own
 * folder and hooks, CI workflows, Claude Code and npm settings, git
 * attributes — each of them runs something or reroutes where it runs.
 */
const DRIVE_PROTECTED = [".git", ".github", ".claude", ".husky", ".githooks", ".npmrc", ".gitattributes", ".gitmodules", ".gitconfig"];

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
  const call = parsePublishCall(words.slice(1));
  if (!call.ok) return deny(`PUBLISH-REJECTED: ${call.error}`);
  const c = call.value;
  if (subs && !subs.includes(c.sub)) return deny(`PUBLISH-REJECTED: this run may not ${c.sub}; it may ${subs.join(", ")}.`);
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
  if (run?.wrapperPath && run.outDir && samePath(words[0], run.wrapperPath)) return checkWrapper(words, pr, run.outDir, run.subs);
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
    return checkBash(kind, command, pr, run);
  }
  return { allow: true };
}

const RUN_KINDS: readonly AgentRunKind[] = ["review", "brief", "rereview", "drive", "afterMerge"];

export function isAgentRunKind(value: unknown): value is AgentRunKind {
  return RUN_KINDS.includes(value as AgentRunKind);
}
