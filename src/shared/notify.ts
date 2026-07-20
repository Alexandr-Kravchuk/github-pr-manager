/**
 * Pure transition detector for desktop notifications.
 *
 * Given the previous and current PR sets, returns the events worth notifying
 * about — computed by *diffing*, so a notification fires the moment a PR enters
 * a state, not for merely being in it. Electron-free so it unit-tests in plain
 * Node, exactly like `state.ts` / `notifications.ts`.
 *
 * Rules that keep the signal clean:
 *  - **Baseline on first run**: a null `prev` (the first snapshot after launch)
 *    fires nothing — otherwise every already-open PR would ping at once, the
 *    same "forest of NEW badges" problem `state.ts` avoids.
 *  - **One event per PR per diff**: the highest-priority transition wins, so a
 *    PR that both fails CI and gets a change request pings once, not twice.
 *  - **Your own actions don't count**: the underlying fields (`hasUnaddressed*`,
 *    `hasHumanApproval`, `ciState`) already reflect the *other* side's action,
 *    and the author-side transitions require a prior snapshot to compare against
 *    — so opening your own PR (no `before`) never pings.
 */

import type { NotificationSettings, PullRequest } from "./types";

export type NotifyEventKind =
  | "review_requested"
  | "changes_requested"
  | "unanswered_comment"
  | "ci_failed"
  | "approved";

/** One thing worth telling the user about, ready to render as a notification. */
export interface NotifyEvent {
  prId: string;
  kind: NotifyEventKind;
  /** Notification title — the event, e.g. "Review requested". */
  title: string;
  /** Notification body — which PR. */
  body: string;
  /** PR URL, opened when the notification is clicked. */
  url: string;
}

/** Highest priority first — the winner when several transitions hit one PR. */
const PRIORITY: NotifyEventKind[] = [
  "review_requested",
  "changes_requested",
  "ci_failed",
  "unanswered_comment",
  "approved",
];

const TITLES: Record<NotifyEventKind, string> = {
  review_requested: "Review requested",
  changes_requested: "Changes requested",
  unanswered_comment: "Comment awaiting your reply",
  ci_failed: "CI failed",
  approved: "PR approved",
};

/** Trims a title so the OS notification body stays a readable single line. */
function clip(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function makeEvent(pr: PullRequest, kind: NotifyEventKind): NotifyEvent {
  return {
    prId: pr.id,
    kind,
    title: TITLES[kind],
    body: `${pr.repo} #${pr.number} — ${clip(pr.title)}`,
    url: pr.url,
  };
}

/**
 * Diffs `prev` → `next` and returns the notification-worthy transitions, gated
 * by `settings`. Returns `[]` when notifications are disabled or on the first
 * (baseline) snapshot.
 */
export function diffNotifications(
  prev: PullRequest[] | null,
  next: PullRequest[],
  settings: NotificationSettings,
): NotifyEvent[] {
  if (!settings.enabled) return [];
  if (prev === null) return []; // first snapshot — establish a baseline only

  const { yourTurn, ciFailed, goodNews } = settings.events;
  const prevById = new Map(prev.map((p) => [p.id, p]));
  const events: NotifyEvent[] = [];

  for (const pr of next) {
    const before = prevById.get(pr.id);
    const isAuthor = pr.roles.includes("author");
    const isReviewer = pr.roles.includes("reviewer");
    const kinds = new Set<NotifyEventKind>();

    if (yourTurn) {
      // Added as a reviewer — the one transition that fires for a *newly seen*
      // PR (you weren't involved before, so it wasn't on the dashboard). We diff
      // only against the immediately-previous snapshot, so a reviewer PR that
      // flickers out of a (successful) fetch and back would re-fire here. Host
      // errors can't cause that — the poller carries the last-good PRs forward —
      // and re-firing on a genuine re-request is the desired behavior, so this
      // is left as a deliberate tradeoff rather than a persistent seen-store.
      const wasReviewer = before ? before.roles.includes("reviewer") : false;
      if (isReviewer && !wasReviewer) kinds.add("review_requested");

      // Author-side transitions need a prior state to compare against.
      if (isAuthor && before) {
        if (!before.hasUnaddressedChangeRequest && pr.hasUnaddressedChangeRequest) {
          kinds.add("changes_requested");
        }
        if (!before.hasUnaddressedComments && pr.hasUnaddressedComments) {
          kinds.add("unanswered_comment");
        }
      }
    }

    if (ciFailed && isAuthor && before && before.ciState !== "failure" && pr.ciState === "failure") {
      kinds.add("ci_failed");
    }

    if (goodNews && isAuthor && before && !before.hasHumanApproval && pr.hasHumanApproval) {
      kinds.add("approved");
    }

    // One event per PR: the highest-priority transition wins.
    const winner = PRIORITY.find((k) => kinds.has(k));
    if (winner) events.push(makeEvent(pr, winner));
  }

  return events;
}
