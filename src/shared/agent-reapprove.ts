// Approvals dismissed by a push that only brought in the base branch.
//
// A branch rule that dismisses approvals on every push (GitHub's "dismiss
// stale pull request approvals", on in creatio-ui's master) takes them away
// when the base is merged into a PR, or when a stack's base merges under it,
// although nothing of the PR changed. Across three epics that was 211
// approvals in 70 PRs, and 42% of their review hours passed after the first
// approval. Here: which approvals stand dismissed (from the PR's timeline),
// and whether the PR's own changes are the same at the dismissed head and now
// (from two diffs). Pure and Node-free — the reads are main's
// (`main/agent/reapprove.ts`), and the policy asks here too.

export interface DismissedApproval {
  /** As GitHub spells it — what a review request names. */
  login: string;
  /** The head the approval was given on. */
  head: string;
}

/** One node of the PR's timeline, as the query reads it. */
export interface ReviewTimelineNode {
  __typename: string;
  /** PullRequestReview */
  id?: string | null;
  author?: { login?: string | null } | null;
  state?: string | null;
  submittedAt?: string | null;
  commit?: { oid?: string | null } | null;
  /** ReviewDismissedEvent */
  previousReviewState?: string | null;
  review?: { id?: string | null; author?: { login?: string | null } | null; commit?: { oid?: string | null } | null } | null;
}

/**
 * The approvals standing dismissed on a PR, per reviewer: their latest review
 * is DISMISSED, the dismissal event of that very review (by its id — not its
 * author and commit, which an earlier dismissed approval may share) says it was
 * an approval, and it was given on another head than `head`. A dismissed change
 * request is never one, and a review left after the dismissal (even a plain
 * comment) means the reviewer has spoken since: theirs to repeat. `exclude`
 * drops logins (the author, on your own PR), any case.
 */
export function dismissedApprovals(nodes: readonly ReviewTimelineNode[], head: string, exclude: readonly string[] = []): DismissedApproval[] {
  const latest = new Map<string, { login: string; id: string; state: string; at: string; head: string }>();
  const dismissedApprovalIds = new Set<string>();
  for (const n of nodes) {
    if (n.__typename === "PullRequestReview") {
      const login = n.author?.login;
      const at = n.submittedAt;
      // A pending review has no submission time: it isn't on the PR yet.
      if (!login || !at || !n.state || !n.id) continue;
      const key = login.toLowerCase();
      const prev = latest.get(key);
      if (!prev || at >= prev.at) latest.set(key, { login, id: n.id, state: n.state, at, head: n.commit?.oid ?? "" });
    } else if (n.__typename === "ReviewDismissedEvent") {
      if (n.previousReviewState === "APPROVED" && n.review?.id) dismissedApprovalIds.add(n.review.id);
    }
  }
  const skip = new Set(exclude.map((l) => l.toLowerCase()));
  const out: DismissedApproval[] = [];
  for (const [key, r] of latest) {
    if (skip.has(key) || r.state !== "DISMISSED" || !r.head || r.head === head) continue;
    if (dismissedApprovalIds.has(r.id)) out.push({ login: r.login, head: r.head });
  }
  return out.sort((a, b) => a.login.localeCompare(b.login));
}

/**
 * What a PR changes, whatever its base: per file, its path, how it changed
 * (new, deleted, renamed, mode) and each hunk's lines with their context —
 * only no line numbers, hunk headings or blob ids, which move when the base
 * changes somewhere else in the file. A base change next to the PR's lines
 * changes their context, and so reads as a change: the safe side, as is a
 * line of the PR moved elsewhere. A file's header ends at its first `@@`;
 * past it a line starting `--- ` or `+++ ` is content (a removed `-- comment`,
 * an added `++ x`), never skipped. A binary file keeps its index line, since
 * its content can't be compared any other way.
 */
export function diffFingerprint(diff: string): string {
  type File = { path: string; meta: string[]; index: string; hunks: string[][] };
  const files: File[] = [];
  let cur: File | null = null;
  let hunk: string[] | null = null;
  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    // Never a hunk line: each of those starts with " ", "+", "-" or "\".
    const header = /^diff --git a\/.+? b\/(.+)$/.exec(line);
    if (header) {
      cur = { path: header[1], meta: [], index: "", hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@")) {
      hunk = [];
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk === null) {
      // The file's header. "--- a/…", "+++ b/…" and "similarity index" say nothing the lines here don't.
      if (line.startsWith("index ")) cur.index = line;
      else if (/^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to) /.test(line)) cur.meta.push(line);
      else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.meta.push(line, cur.index);
      continue;
    }
    if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\")) hunk.push(line);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files.map((f) => [f.path, ...f.meta, ...f.hunks.map((h) => `@@\n${h.join("\n")}`)].join("\n")).join("\n\u0000\n");
}

/** The same changes at both heads — and some at all: two empty diffs say nothing. */
export function sameChanges(before: string, after: string): boolean {
  const a = diffFingerprint(before);
  return a !== "" && a === diffFingerprint(after);
}

/** The line a re-approval posts above the signature. */
export function reapprovalBody(oldHead: string): string {
  return `Re-approved: only the base branch changed since my approval at \`${oldHead.slice(0, 7)}\` — the PR's own changes are the same.`;
}
