// What a review session prepared to post, as the app captures it.
//
// The review skill publishes through a `publishCommand` — a script named
// `pr-review-publish.sh` that performs exactly four GitHub writes (a review
// event, a file-level comment, an in-thread reply, a thread resolve). The app
// hands every review session its own script of that name, which does not post
// at all: it checks the call the way the real wrapper does and records it in
// the run's plan. The app then posts the plan itself — at once in On, on your
// Publish in Shadow — and adds the signature, so nothing the model writes can
// reach GitHub on its own or drop the signature.
//
// Node-free and pure: the capture script, the guard hook and the app all parse
// through these functions, and the tests run them without a session.

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface PlanComment {
  path: string;
  body: string;
  line?: number;
  startLine?: number;
  side?: "LEFT" | "RIGHT";
  startSide?: "LEFT" | "RIGHT";
  subjectType?: "line" | "file";
}

export type PublishStep =
  | { kind: "review"; event: ReviewEvent; body: string; commitId?: string; comments: PlanComment[] }
  | { kind: "comment"; comment: PlanComment; commitId: string }
  | { kind: "reply"; replyTo: number; body: string }
  | { kind: "resolve"; threadId: string }
  /**
   * Not a GitHub write: the session hands a thread back to you instead of
   * answering in it (a re-review never argues with the author on your
   * behalf). The app drops any reply to that thread and lists it for you.
   */
  | { kind: "escalate"; replyTo: number; body: string }
  /**
   * A comment in the PR's conversation — the app's own, never the session's:
   * the diagrams it drew (`agent-diagrams.ts`). The capture script has no such
   * write and `readPlanLines` reads none back, so a session can't add one.
   */
  | { kind: "note"; body: string; label: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The real wrapper's limit on a payload file. */
export const PLAN_FILE_MAX_BYTES = 1_048_576;

const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSide = (v: unknown): v is "LEFT" | "RIGHT" => v === "LEFT" || v === "RIGHT";

/** One inline or file-level comment: the fields the comment APIs take, nothing else. */
export function parseComment(raw: unknown): Parsed<PlanComment> {
  if (!isObj(raw)) return fail("a comment must be an object");
  if (typeof raw.path !== "string" || raw.path.length === 0) return fail("a comment needs a path");
  if (typeof raw.body !== "string" || raw.body.length === 0) return fail("a comment needs a body");
  const c: PlanComment = { path: raw.path, body: raw.body };
  if (raw.line != null) {
    if (typeof raw.line !== "number" || !Number.isInteger(raw.line)) return fail("line must be a number");
    c.line = raw.line;
  }
  if (raw.start_line != null) {
    if (typeof raw.start_line !== "number" || !Number.isInteger(raw.start_line)) return fail("start_line must be a number");
    c.startLine = raw.start_line;
  }
  if (raw.side != null) {
    if (!isSide(raw.side)) return fail("side must be LEFT or RIGHT");
    c.side = raw.side;
  }
  if (raw.start_side != null) {
    if (!isSide(raw.start_side)) return fail("start_side must be LEFT or RIGHT");
    c.startSide = raw.start_side;
  }
  if (raw.subject_type != null) {
    if (raw.subject_type !== "line" && raw.subject_type !== "file") return fail("subject_type must be line or file");
    c.subjectType = raw.subject_type;
  }
  return { ok: true, value: c };
}

function parseSha(raw: Record<string, unknown>): Parsed<string | undefined> {
  if (raw.commit_id == null) return { ok: true, value: undefined };
  if (typeof raw.commit_id !== "string" || !/^[0-9a-f]{40}$/.test(raw.commit_id)) return fail("commit_id must be a 40-hex SHA");
  return { ok: true, value: raw.commit_id };
}

/** The review event's JSON: `{event, body, commit_id, comments}`. */
export function parseReview(raw: unknown): Parsed<Extract<PublishStep, { kind: "review" }>> {
  if (!isObj(raw)) return fail("the review must be a JSON object");
  if (raw.event !== "APPROVE" && raw.event !== "REQUEST_CHANGES" && raw.event !== "COMMENT") {
    return fail("event must be APPROVE, REQUEST_CHANGES or COMMENT");
  }
  if (raw.body != null && typeof raw.body !== "string") return fail("body must be a string");
  const sha = parseSha(raw);
  if (!sha.ok) return sha;
  const comments: PlanComment[] = [];
  if (raw.comments != null) {
    if (!Array.isArray(raw.comments)) return fail("comments must be an array");
    for (const c of raw.comments) {
      const p = parseComment(c);
      if (!p.ok) return p;
      comments.push(p.value);
    }
  }
  const step: Extract<PublishStep, { kind: "review" }> = { kind: "review", event: raw.event, body: (raw.body as string | undefined) ?? "", comments };
  if (sha.value) step.commitId = sha.value;
  return { ok: true, value: step };
}

/** A file-level (or single inline) comment's JSON; it needs `commit_id`. */
export function parseFileComment(raw: unknown): Parsed<Extract<PublishStep, { kind: "comment" }>> {
  const c = parseComment(raw);
  if (!c.ok) return c;
  const sha = parseSha(raw as Record<string, unknown>);
  if (!sha.ok) return sha;
  if (!sha.value) return fail("a pull-request comment needs commit_id");
  return { ok: true, value: { kind: "comment", comment: c.value, commitId: sha.value } };
}

/** A call of the wrapper, as its arguments say. */
export type PublishCall =
  | { sub: "review" | "comment"; repo: string; number: number; file: string }
  | { sub: "reply" | "escalate"; repo: string; number: number; replyTo: number; file: string }
  | { sub: "resolve"; threadId: string };

/** The wrapper's subcommands: the skill's four, and the app's own `escalate`. A run's guard file names the ones it may use. */
export const PUBLISH_SUBS = ["review", "comment", "reply", "resolve", "escalate"] as const;
export type PublishSub = (typeof PUBLISH_SUBS)[number];

const USAGE =
  "usage: pr-review-publish.sh review|comment <owner/repo> <number> <file.json> | reply|escalate <owner/repo> <number> <comment-id> <body.txt> | resolve <thread-id>";

function checkRepo(v: string): Parsed<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(v)) return fail(`owner/repo must look like owner/name, got: ${v}`);
  const name = v.split("/")[1];
  if (name === "." || name === "..") return fail(`owner/repo must look like owner/name, got: ${v}`);
  return { ok: true, value: v };
}

function checkNumber(v: string): Parsed<number> {
  return /^[1-9][0-9]{0,9}$/.test(v) ? { ok: true, value: Number(v) } : fail(`the PR number must be a positive integer, got: ${v}`);
}

/** The words after the wrapper's path → the call, or the wrapper's own rejection text. */
export function parsePublishCall(args: readonly string[]): Parsed<PublishCall> {
  const [sub, ...rest] = args;
  if (sub === "review" || sub === "comment") {
    if (rest.length !== 3) return fail(USAGE);
    const repo = checkRepo(rest[0]);
    if (!repo.ok) return repo;
    const n = checkNumber(rest[1]);
    if (!n.ok) return n;
    return { ok: true, value: { sub, repo: repo.value, number: n.value, file: rest[2] } };
  }
  if (sub === "reply" || sub === "escalate") {
    if (rest.length !== 4) return fail(USAGE);
    const repo = checkRepo(rest[0]);
    if (!repo.ok) return repo;
    const n = checkNumber(rest[1]);
    if (!n.ok) return n;
    if (!/^[1-9][0-9]{0,15}$/.test(rest[2])) return fail(`the comment id must be a positive integer, got: ${rest[2]}`);
    return { ok: true, value: { sub, repo: repo.value, number: n.value, replyTo: Number(rest[2]), file: rest[3] } };
  }
  if (sub === "resolve") {
    if (rest.length !== 1) return fail(USAGE);
    if (!/^PRRT_[A-Za-z0-9_-]{1,100}$/.test(rest[0])) return fail(`a thread id must look like PRRT_…, got: ${rest[0]}`);
    return { ok: true, value: { sub, threadId: rest[0] } };
  }
  return fail(USAGE);
}

/** "C:\a\b" or "C:/a/b" → "/c/a/b", the form Git Bash (and the review skill) uses; POSIX paths unchanged. */
export function gitBashPath(p: string): string {
  const drive = /^([A-Za-z]):[\\/]/.exec(p);
  return drive ? `/${drive[1].toLowerCase()}/${p.slice(3).replace(/\\/g, "/")}` : p.replace(/\\/g, "/");
}

/** One spelling of a path to compare by: Git Bash form, no trailing slash, case-folded (Windows paths are case-insensitive). */
function pathKey(p: string): string {
  const g = gitBashPath(p.trim()).replace(/\/+$/, "");
  return /^\/[a-z]\//.test(g) ? g.toLowerCase() : g;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** Whether `file` is inside `dir` (never `dir` itself), with no `..` or `.` segment that could step out. */
export function isInsideDir(file: string, dir: string): boolean {
  const f = pathKey(file);
  if (f.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  const d = pathKey(dir);
  return f.startsWith(`${d}/`) && f.length > d.length + 1;
}

/**
 * Whether the review skill will take this path as its publishCommand: it
 * accepts only an absolute path to `pr-review-publish.sh` of letters, digits,
 * `. _ - /` and no `..` — a path with a space (a user folder, "PR Dashboard")
 * makes it fall back to plain `gh api` writes, which the guard refuses.
 */
export function isUsableWrapperPath(p: string): boolean {
  const g = gitBashPath(p);
  return /^\/[A-Za-z0-9._/-]*\/pr-review-publish\.sh$/.test(g) && !g.split("/").includes("..");
}

/** The body with the signature under it. The app adds it; the session never sees a way around it. */
export function signedBody(body: string, signature: string): string {
  const b = body.trimEnd();
  return b ? `${b}\n\n${signature}` : signature;
}

/** One GitHub write of a plan, ready for `gh api`. */
export interface PublishRequest {
  /** What it posts, for errors and the log: "review", "comment on a.ts", … */
  label: string;
  endpoint: string;
  /** The JSON sent with `--input`. A GraphQL call carries `{query, variables}`. */
  body: Record<string, unknown>;
}

export interface PublishContext {
  repo: string;
  number: number;
  signature: string;
  /** An approve becomes a plain comment (Settings › Agent › hold approve while another reviewer's change request is open). */
  holdApprove: boolean;
  /** Re-review: resolve threads (Settings › Agent › re-review: resolve). Absent = yes. */
  allowResolve?: boolean;
  /** Re-review: approve once your threads are closed (Settings › Agent › re-review: approve). Absent = yes; off turns an approve into a comment. */
  allowApprove?: boolean;
}

/** Comment ids the session handed back to you: replies to them are held back. */
function escalatedTargets(steps: readonly PublishStep[]): Set<number> {
  return new Set(steps.flatMap((s) => (s.kind === "escalate" ? [s.replyTo] : [])));
}

/**
 * The steps that become GitHub writes, in order: no escalations (they aren't
 * writes), no reply to a thread that was escalated, no resolve when resolving
 * is off. `planRequests` and the publish progress both count over this list.
 */
export function postedSteps(steps: readonly PublishStep[], ctx: Pick<PublishContext, "allowResolve">): PublishStep[] {
  const escalated = escalatedTargets(steps);
  return steps.filter(
    (s) => s.kind !== "escalate" && !(s.kind === "reply" && escalated.has(s.replyTo)) && !(s.kind === "resolve" && ctx.allowResolve === false),
  );
}

/** The reply that drops your comment in a thread where the author pushed back. */
export const DROP_REPLY = "Fair point — I'm dropping this.";

/**
 * Your choices on the threads the author pushed back on, as writes: "drop"
 * answers in the thread and resolves it; "keep" (or no choice) leaves it
 * open, as it is. `threadIds` maps a thread's first comment to its thread.
 */
export function disputeSteps(
  escalations: ReadonlyArray<{ replyTo: number }>,
  choices: Readonly<Record<string, "keep" | "drop">>,
  threadIds: ReadonlyMap<number, string>,
): PublishStep[] {
  const out: PublishStep[] = [];
  for (const e of escalations) {
    if (choices[String(e.replyTo)] !== "drop") continue;
    out.push({ kind: "reply", replyTo: e.replyTo, body: DROP_REPLY });
    const thread = threadIds.get(e.replyTo);
    if (thread) out.push({ kind: "resolve", threadId: thread });
  }
  return out;
}

export const HELD_APPROVE_NOTE = "_The agent would approve, but another reviewer's change request is still open — approve is held until it is addressed._";

function commentBody(c: PlanComment, signature: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = { path: c.path, body: signature ? signedBody(c.body, signature) : c.body };
  if (c.line !== undefined) out.line = c.line;
  if (c.startLine !== undefined) out.start_line = c.startLine;
  if (c.side) out.side = c.side;
  if (c.startSide) out.start_side = c.startSide;
  if (c.subjectType) out.subject_type = c.subjectType;
  return out;
}

const RESOLVE_MUTATION = "mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }";

/**
 * The plan as GitHub writes, in the order the session made them. The review
 * body, a file-level comment and a reply each end with the signature; the
 * inline comments of a review sit under its signed body.
 */
export function planRequests(steps: readonly PublishStep[], ctx: PublishContext): PublishRequest[] {
  const base = `repos/${ctx.repo}/pulls/${ctx.number}`;
  return postedSteps(steps, ctx).map((s): PublishRequest => {
    switch (s.kind) {
      case "review": {
        const held = ctx.holdApprove && s.event === "APPROVE";
        const noApprove = ctx.allowApprove === false && s.event === "APPROVE";
        const body: Record<string, unknown> = {
          event: held || noApprove ? "COMMENT" : s.event,
          body: signedBody(held ? `${s.body.trimEnd()}\n\n${HELD_APPROVE_NOTE}` : s.body, ctx.signature),
        };
        if (s.commitId) body.commit_id = s.commitId;
        if (s.comments.length) body.comments = s.comments.map((c) => commentBody(c, null));
        return { label: held ? "review (approve held)" : `review (${s.event.toLowerCase().replace("_", " ")})`, endpoint: `${base}/reviews`, body };
      }
      case "comment":
        return { label: `comment on ${s.comment.path}`, endpoint: `${base}/comments`, body: { ...commentBody(s.comment, ctx.signature), commit_id: s.commitId } };
      case "reply":
        return { label: `reply to comment ${s.replyTo}`, endpoint: `${base}/comments/${s.replyTo}/replies`, body: { body: signedBody(s.body, ctx.signature) } };
      case "resolve":
        return { label: `resolve ${s.threadId}`, endpoint: "graphql", body: { query: RESOLVE_MUTATION, variables: { id: s.threadId } } };
      case "note":
        return { label: s.label, endpoint: `repos/${ctx.repo}/issues/${ctx.number}/comments`, body: { body: signedBody(s.body, ctx.signature) } };
      case "escalate":
        // Filtered out by postedSteps; here only for the type checker.
        throw new Error("an escalation is not a GitHub write");
    }
  });
}

/** What the Board shows of a plan: enough to judge it, bounded in size. */
export interface PublishSummary {
  event: ReviewEvent | null;
  body: string;
  comments: Array<{ path: string; line?: number; body: string }>;
  replies: Array<{ replyTo: number; body: string }>;
  resolves: number;
  /** Threads handed back to you: what the author disagrees about, in a line. */
  escalations: Array<{ replyTo: number; body: string }>;
  /** The head the review was made against, when it says. */
  commitId?: string;
  /** Diagrams that go out with it, as one comment (set by the app after drawing, not by the session). */
  diagrams?: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function summarizePlan(steps: readonly PublishStep[]): PublishSummary {
  const out: PublishSummary = { event: null, body: "", comments: [], replies: [], resolves: 0, escalations: [] };
  const escalated = escalatedTargets(steps);
  for (const s of steps) {
    if (s.kind === "review") {
      out.event = s.event;
      out.body = clip(s.body, 20_000);
      if (s.commitId) out.commitId = s.commitId;
      for (const c of s.comments) out.comments.push({ path: c.path, line: c.line, body: clip(c.body, 4_000) });
    } else if (s.kind === "comment") {
      out.comments.push({ path: s.comment.path, line: s.comment.line, body: clip(s.comment.body, 4_000) });
      out.commitId ??= s.commitId;
    } else if (s.kind === "reply") {
      if (!escalated.has(s.replyTo)) out.replies.push({ replyTo: s.replyTo, body: clip(s.body, 4_000) });
    } else if (s.kind === "escalate") {
      out.escalations.push({ replyTo: s.replyTo, body: clip(s.body, 1_000) });
    } else if (s.kind === "resolve") {
      out.resolves++;
    }
  }
  out.comments = out.comments.slice(0, 100);
  out.replies = out.replies.slice(0, 100);
  return out;
}

/** "Would approve, 3 comments, 1 reply" — the plan in one line. */
export function describePlan(p: PublishSummary): string {
  const parts: string[] = [];
  if (p.event === "APPROVE") parts.push("approve");
  else if (p.event === "REQUEST_CHANGES") parts.push("request changes");
  else if (p.event === "COMMENT") parts.push("comment");
  const n = (count: number, one: string, many: string) => (count ? `${count} ${count === 1 ? one : many}` : null);
  for (const part of [
    n(p.comments.length, "inline comment", "inline comments"),
    n(p.replies.length, "reply", "replies"),
    n(p.resolves, "resolve", "resolves"),
    n(p.escalations?.length ?? 0, "dispute for you", "disputes for you"),
    n(p.diagrams ?? 0, "diagram", "diagrams"),
  ]) {
    if (part) parts.push(part);
  }
  return parts.length ? parts.join(", ") : "nothing";
}

/**
 * The plan file's lines → steps; a line that doesn't parse is dropped (the
 * capture script wrote only checked ones). A session may record again — after
 * "Edit first", after your answer — so a step recorded twice counts once, and
 * of several reviews only the last stands: a run posts one review, and the
 * summary you are shown is that one.
 */
export function readPlanLines(text: string): PublishStep[] {
  const steps: PublishStep[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (seen.has(line.trim())) continue;
    seen.add(line.trim());
    try {
      const raw = JSON.parse(line) as { kind?: unknown };
      if (raw.kind === "review") {
        const p = parseReview({ ...(raw as object), commit_id: (raw as { commitId?: unknown }).commitId, comments: ((raw as { comments?: PlanComment[] }).comments ?? []).map(toWire) });
        if (p.ok) steps.push(p.value);
      } else if (raw.kind === "comment") {
        const r = raw as { comment?: PlanComment; commitId?: unknown };
        const p = r.comment ? parseFileComment({ ...toWire(r.comment), commit_id: r.commitId }) : null;
        if (p?.ok) steps.push(p.value);
      } else if (raw.kind === "reply") {
        const r = raw as { replyTo?: unknown; body?: unknown };
        if (typeof r.replyTo === "number" && Number.isInteger(r.replyTo) && r.replyTo > 0 && typeof r.body === "string" && r.body.length > 0) {
          steps.push({ kind: "reply", replyTo: r.replyTo, body: r.body });
        }
      } else if (raw.kind === "escalate") {
        const r = raw as { replyTo?: unknown; body?: unknown };
        if (typeof r.replyTo === "number" && Number.isInteger(r.replyTo) && r.replyTo > 0 && typeof r.body === "string" && r.body.length > 0) {
          steps.push({ kind: "escalate", replyTo: r.replyTo, body: r.body });
        }
      } else if (raw.kind === "resolve") {
        const r = raw as { threadId?: unknown };
        if (typeof r.threadId === "string" && /^PRRT_[A-Za-z0-9_-]{1,100}$/.test(r.threadId)) steps.push({ kind: "resolve", threadId: r.threadId });
      }
    } catch {
      // A torn last line from a killed session.
    }
  }
  const lastReview = steps.map((s) => s.kind).lastIndexOf("review");
  return steps.filter((s, i) => s.kind !== "review" || i === lastReview);
}

/** A comment back in the API's spelling, so a stored step re-checks through the same parser. */
function toWire(c: PlanComment): Record<string, unknown> {
  return commentBody(c, null);
}
