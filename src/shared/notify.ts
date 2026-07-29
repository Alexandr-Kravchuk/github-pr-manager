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

/**
 * Canonical default notification settings — OFF by default (opt-in). Single
 * source of truth: `config.ts` clones this for the main-process default, and the
 * renderer (`Settings.tsx`) imports it directly for its initial state. This
 * module stays Electron/Node-free precisely so the renderer can value-import it
 * (the rest of `shared/` is type-only for the renderer). Keep it that way.
 */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: false,
  native: true,
  sound: false,
  events: { yourTurn: true, ciFailed: true, goodNews: true },
};

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
const PRIORITY = [
  "review_requested",
  "changes_requested",
  "ci_failed",
  "unanswered_comment",
  "approved",
] as const satisfies readonly NotifyEventKind[];

// Compile-time guard: every NotifyEventKind must appear in PRIORITY. Unlike
// TITLES (an exhaustive Record), a plain array wouldn't catch a newly-added
// kind left out of the priority order — it would silently never fire. If this
// line stops compiling, add the missing kind(s) to PRIORITY above.
type MissingFromPriority = Exclude<NotifyEventKind, (typeof PRIORITY)[number]>;
const _priorityIsExhaustive: MissingFromPriority extends never ? true : MissingFromPriority = true;
void _priorityIsExhaustive;

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
    // A PR the user explicitly ignored is muted everywhere — hidden from the
    // dashboard and excluded from counts — so it must not toast or chime either.
    // The baseline still advances (`prevNotifyPrs` in main.ts is the full list),
    // so un-ignoring it later won't replay a backlog.
    if (pr.isIgnored) continue;

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

/** Above this many events, collapse a burst into one summary toast. */
export const MAX_INDIVIDUAL_NOTIFICATIONS = 4;

/** How a batch of events should be delivered — the pure decision, no Electron. */
export type DeliveryMode = "none" | "summary" | "individual" | "sound-only";

export interface DeliveryPlan {
  mode: DeliveryMode;
  /** `individual` only: one silent flag per event (true = no chime for it). */
  silent: boolean[];
  /** `summary` only: whether the single summary toast is silent. */
  summarySilent: boolean;
}

export interface DeliveryContext {
  /** Our window is the focused one — the dashboard already shows the change. */
  focused: boolean;
  /** OS/Electron can show native notifications (`Notification.isSupported()`). */
  nativeSupported: boolean;
}

/**
 * Decides how to deliver a batch of notification events, given the user's
 * settings and runtime context. Pure and Electron-free so every branch —
 * focus suppression, the summary-vs-individual split, chime-once, and the
 * native-off sound fallback — unit-tests in plain Node; `main.ts` only executes
 * the returned descriptor.
 */
export function planDelivery(
  events: NotifyEvent[],
  settings: NotificationSettings,
  ctx: DeliveryContext,
): DeliveryPlan {
  const none: DeliveryPlan = { mode: "none", silent: [], summarySilent: true };
  if (!settings.enabled || events.length === 0) return none;
  // Don't notify for the window the user is actively viewing — a focus/restore
  // tick would otherwise dump a burst of toasts for everything that moved away.
  if (ctx.focused) return none;

  const { native, sound } = settings;
  if (native && ctx.nativeSupported) {
    if (events.length > MAX_INDIVIDUAL_NOTIFICATIONS) {
      return { mode: "summary", silent: [], summarySilent: !sound };
    }
    // Sound at most once (on the first) so a batch doesn't chime N times.
    return { mode: "individual", silent: events.map((_, i) => !(sound && i === 0)), summarySilent: true };
  }
  // No native toast (disabled or unsupported), but the user still wants a ping.
  if (sound) return { mode: "sound-only", silent: [], summarySilent: true };
  return none;
}
