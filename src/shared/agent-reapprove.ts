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
  author?: { login?: string | null } | null;
  state?: string | null;
  submittedAt?: string | null;
  commit?: { oid?: string | null } | null;
  /** ReviewDismissedEvent */
  previousReviewState?: string | null;
  review?: { author?: { login?: string | null } | null; commit?: { oid?: string | null } | null } | null;
}

/**
 * The approvals standing dismissed on a PR, per reviewer: their latest review
 * is DISMISSED, a dismissal event says it was an approval, and it was given on
 * another head than `head`. A dismissed change request is never one — nothing
 * here turns it into an approval — and a review left after the dismissal (even
 * a plain comment) means the reviewer has spoken since: theirs to repeat.
 * `exclude` drops logins (the author, on your own PR), any case.
 */
export function dismissedApprovals(nodes: readonly ReviewTimelineNode[], head: string, exclude: readonly string[] = []): DismissedApproval[] {
  const latest = new Map<string, { login: string; state: string; at: string; head: string }>();
  const wasApproval = new Set<string>();
  for (const n of nodes) {
    if (n.__typename === "PullRequestReview") {
      const login = n.author?.login;
      const at = n.submittedAt;
      // A pending review has no submission time: it isn't on the PR yet.
      if (!login || !at || !n.state) continue;
      const key = login.toLowerCase();
      const prev = latest.get(key);
      if (!prev || at >= prev.at) latest.set(key, { login, state: n.state, at, head: n.commit?.oid ?? "" });
    } else if (n.__typename === "ReviewDismissedEvent") {
      const login = n.review?.author?.login;
      const oid = n.review?.commit?.oid;
      if (login && oid && n.previousReviewState === "APPROVED") wasApproval.add(`${login.toLowerCase()}|${oid}`);
    }
  }
  const skip = new Set(exclude.map((l) => l.toLowerCase()));
  const out: DismissedApproval[] = [];
  for (const [key, r] of latest) {
    if (skip.has(key) || r.state !== "DISMISSED" || !r.head || r.head === head) continue;
    if (wasApproval.has(`${key}|${r.head}`)) out.push({ login: r.login, head: r.head });
  }
  return out.sort((a, b) => a.login.localeCompare(b.login));
}

/**
 * What a PR changes, whatever its base: per file, its path, how it changed
 * (new, deleted, renamed, mode) and its added and removed lines in order — no
 * context lines, line numbers or blob ids, all of which move when only the
 * base does. A binary file keeps its index line, since its content can't be
 * compared any other way: a base change under it reads as a change, the safe
 * side. The same lines moved elsewhere in a file would read the same — only
 * a conflict resolution inside the merge could do that, and it changes no line
 * the reviewer approved.
 */
export function diffFingerprint(diff: string): string {
  const files: Array<{ path: string; lines: string[]; index: string }> = [];
  let cur: { path: string; lines: string[]; index: string } | null = null;
  for (const raw of diff.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const header = /^diff --git a\/.+? b\/(.+)$/.exec(line);
    if (header) {
      cur = { path: header[1], lines: [], index: "" };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("index ")) cur.index = line;
    else if (/^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to) /.test(line)) cur.lines.push(line);
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.lines.push(line, cur.index);
    else if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@") || line.startsWith("similarity index ")) continue;
    else if (line.startsWith("+") || line.startsWith("-") || line.startsWith("\\")) cur.lines.push(line);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files.map((f) => `${f.path}\n${f.lines.join("\n")}`).join("\n\u0000\n");
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
