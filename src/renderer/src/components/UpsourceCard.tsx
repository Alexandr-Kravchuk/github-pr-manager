import { jiraBrowseUrl, stripLeadingIssueKey } from "../../../shared/issue-key";
import { hiddenParentOf } from "../../../shared/pr-group";
import { ageDays } from "../../../shared/pr-table";
import type { PullRequest, UpsourceParticipant, UpsourceParticipantState } from "../../../shared/types";
import {
  UPSOURCE_STATE_LABEL,
  upsourceDue,
  upsourceStage,
  type UpsourceStage,
} from "../../../shared/upsource";
import { cn, relativeTime } from "../format";
import { AuthorButton } from "./AuthorButton";
import { Avatar, CopyLinkButton, IgnoreButton, JiraKeyPill, TileHoverActions } from "./card-controls";

/**
 * An Upsource review, in the frame of a PR card: same stripe, rows and
 * actions, so it sits in the grid as one more card. Its pills come from
 * `pr.upsource` — Upsource has no CI, merge or stack, and no Claude button or
 * PR agent works on it.
 */

const ACCENT: Record<UpsourceStage, string> = {
  "your-review": "border-l-violet-500",
  concern: "border-l-red-500",
  ready: "border-l-emerald-500",
  waiting: "border-l-line-strong",
};

const STAGE_TEXT: Record<UpsourceStage, string> = {
  "your-review": "Your review is asked for",
  concern: "A concern or open discussion waits for you",
  ready: "Every reviewer accepted: you can close it",
  waiting: "Waiting for others",
};

const RING: Record<UpsourceParticipantState, string> = {
  accepted: "ring-emerald-500",
  rejected: "ring-red-500",
  read: "ring-sky-500",
  unread: "ring-line-strong",
};

const pill = "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium";
const neutralPill = cn(pill, "border-line-strong bg-elevated text-fg-muted");

/** The source mark: says at a glance that this is not a GitHub PR. */
export function UpsourceMark({ short = false }: { short?: boolean }) {
  return (
    <span
      title="Upsource review"
      className="shrink-0 rounded bg-fuchsia-500/15 px-1.5 py-0.5 font-medium text-fuchsia-700 dark:text-fuchsia-300"
    >
      {short ? "U" : "Upsource"}
    </span>
  );
}

function ParticipantAvatar({ p, size }: { p: UpsourceParticipant; size: number }) {
  return (
    <Avatar
      login={p.name}
      avatarUrl={p.avatarUrl}
      size={size}
      title={`${p.name}: ${UPSOURCE_STATE_LABEL[p.state]}`}
      className={cn("ring-2", RING[p.state])}
    />
  );
}

interface CardProps {
  pr: PullRequest;
  onOpen: (pr: PullRequest) => void;
  onMarkSeen: (pr: PullRequest) => void;
  onToggleIgnore: (pr: PullRequest) => void;
  hideRepo?: boolean;
  jiraBaseUrl?: string | null;
  parentGroupKey?: string | null;
}

export function UpsourceCard({
  pr,
  onOpen,
  onMarkSeen,
  onToggleIgnore,
  hideRepo = false,
  jiraBaseUrl = null,
  parentGroupKey = null,
}: CardProps) {
  const info = pr.upsource;
  if (!info) return null;
  const stage = upsourceStage(info);
  const due = upsourceDue(info.deadline, Date.now());
  const jiraUrl = jiraBrowseUrl(jiraBaseUrl, pr.issueKey);
  const title = jiraUrl ? stripLeadingIssueKey(pr.title, pr.issueKey) : pr.title;
  const task = hiddenParentOf(pr, parentGroupKey);
  const taskLabel = task ? (task.summary ? `${task.key} · ${task.summary}` : task.key) : "";
  const age = ageDays(pr.createdAt, Date.now());

  return (
    <div
      data-pr-id={pr.id}
      className={cn(
        "relative isolate flex flex-col overflow-hidden rounded-lg border border-line border-l-4 bg-surface p-4 shadow-tile transition-colors hover:border-y-line-strong hover:border-r-line-strong",
        ACCENT[stage],
        pr.isIgnored && "opacity-60 hover:opacity-100",
      )}
    >
      <div className="mb-1 flex min-w-0 items-center gap-2 text-xs text-fg-subtle">
        <UpsourceMark />
        <span className="flex min-w-0 items-center gap-1" title={`${info.projectId} · ${info.reviewId}`}>
          {!hideRepo && <span className="truncate">{info.projectId}</span>}
          <span className="shrink-0 text-sm font-semibold tabular-nums text-fg-secondary">{info.reviewId}</span>
        </span>
        {pr.isIgnored && <span className="rounded bg-elevated px-1.5 py-0.5 text-fg-muted">Ignored</span>}
        <CopyLinkButton url={pr.url} noun="review" size="card" />
        <IgnoreButton pr={pr} noun="review" size="card" onToggleIgnore={onToggleIgnore} />
        {jiraUrl && pr.issueKey && <JiraKeyPill issueKey={pr.issueKey} url={jiraUrl} />}
      </div>

      {task && (
        <div title={`Part of ${taskLabel}`} className="mb-0.5 truncate text-xs text-fg-subtle">
          ↳ {taskLabel}
        </div>
      )}

      <button
        type="button"
        onClick={() => onOpen(pr)}
        title={pr.title}
        className="mb-2 block w-full truncate text-left text-[15px] font-semibold leading-snug text-fg hover:text-sky-600 hover:underline dark:hover:text-sky-300"
      >
        {title}
      </button>

      <div className="mb-2 flex flex-wrap items-center gap-2" title={STAGE_TEXT[stage]}>
        {pr.author && info.myRole !== "author" && (
          <AuthorButton login={pr.author.login} className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
            <Avatar login={pr.author.login} avatarUrl={pr.author.avatarUrl} size={18} />
            {pr.author.login}
          </AuthorButton>
        )}
        {info.myRole === "author" ? (
          <span className={cn(pill, "border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-300")}>Author</span>
        ) : stage === "your-review" ? (
          <span className={cn(pill, "border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-300")}>
            Reviewer
          </span>
        ) : (
          <span className={cn(pill, "border-slate-500/40 bg-slate-500/15 text-fg-muted")}>
            {info.myState === "accepted" ? "You accepted" : "You raised a concern"}
          </span>
        )}
        {info.isUnread && (
          <span
            title="Upsource marks this review unread for you"
            className={cn(pill, "border-fuchsia-500/40 bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300")}
          >
            ● Unread
          </span>
        )}
        {info.hasConcern && (
          <span className={cn(pill, "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300")}>
            Concern raised
          </span>
        )}
        {info.isReadyToClose ? (
          <span className={cn(pill, "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300")}>
            ✓ Ready to close
          </span>
        ) : (
          info.reviewersCount > 0 && (
            <span title={`${info.accepted} of ${info.reviewersCount} reviewers accepted`} className={neutralPill}>
              Accepted {info.accepted}/{info.reviewersCount}
            </span>
          )
        )}
        {info.unresolved > 0 && (
          <span className={cn(pill, "border-orange-500/40 bg-orange-500/15 text-orange-700 dark:text-orange-300")}>
            💬 {info.unresolved} unresolved
          </span>
        )}
        {due && (
          <span
            title={due.overdue ? "The due date has passed" : "The review's due date"}
            className={
              due.overdue ? cn(pill, "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300") : neutralPill
            }
          >
            {due.text}
          </span>
        )}
        {pr.isStale && (
          <span
            title={`Open for ${age} days — past the stale threshold`}
            className={cn(pill, "border-stone-500/40 bg-stone-500/15 text-stone-700 dark:text-stone-300")}
          >
            🕸 Stale · {age}d
          </span>
        )}
        {pr.hasNewActivity && (
          <span className="inline-flex items-center gap-1">
            <span className={cn(pill, "border-amber-400/50 bg-amber-400/20 text-amber-700 dark:text-amber-200")}>
              ✦ New comments
            </span>
            <button
              type="button"
              onClick={() => onMarkSeen(pr)}
              title="Mark as seen"
              className="rounded-md border border-line-strong px-1.5 py-0.5 text-xs text-fg-muted hover:bg-elevated hover:text-fg"
            >
              ✓
            </button>
          </span>
        )}
      </div>

      <div className="mt-auto flex items-center justify-between gap-2">
        {info.participants.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-fg-subtle">Reviewers:</span>
            {info.participants.map((p) => (
              <ParticipantAvatar key={p.login} p={p} size={18} />
            ))}
          </div>
        ) : (
          <span />
        )}
        <span className="shrink-0 text-xs text-fg-subtle" title={new Date(pr.updatedAt).toLocaleString()}>
          {relativeTime(pr.updatedAt)}
        </span>
      </div>
    </div>
  );
}

function tileTooltip(pr: PullRequest, now: number): string {
  const info = pr.upsource;
  if (!info) return pr.title;
  const due = upsourceDue(info.deadline, now);
  return [
    `Upsource · ${info.projectId} ${info.reviewId}`,
    pr.title,
    pr.author ? `Author: ${pr.author.login}` : null,
    STAGE_TEXT[upsourceStage(info)],
    `Accepted: ${info.accepted}/${info.reviewersCount}`,
    info.hasConcern ? "Concern raised" : null,
    info.unresolved > 0 ? `${info.unresolved} unresolved discussion(s)` : null,
    due ? due.text : null,
    `Opened ${ageDays(pr.createdAt, now)}d ago · updated ${relativeTime(pr.updatedAt)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The Compact tile of an Upsource review. */
export function UpsourceTile({
  pr,
  onOpen,
  onToggleIgnore,
  hideRepo = false,
}: {
  pr: PullRequest;
  onOpen: (pr: PullRequest) => void;
  onToggleIgnore: (pr: PullRequest) => void;
  hideRepo?: boolean;
}) {
  const info = pr.upsource;
  if (!info) return null;
  const stage = upsourceStage(info);
  const due = upsourceDue(info.deadline, Date.now());
  const roleGlyph = info.myRole === "author" ? "A" : stage === "your-review" ? "R" : "✓";

  return (
    <div
      data-pr-id={pr.id}
      title={tileTooltip(pr, Date.now())}
      className={cn(
        "group relative isolate overflow-hidden rounded-md border border-line border-l-[3px] bg-surface px-2 py-1.5 shadow-tile transition-colors hover:border-y-line-strong hover:border-r-line-strong",
        ACCENT[stage],
        pr.isIgnored && "opacity-60 hover:opacity-100",
      )}
    >
      <div className="flex items-center gap-1 text-[11px] leading-none text-fg-subtle">
        <UpsourceMark short />
        <span className="flex min-w-0 items-center gap-1">
          {!hideRepo && <span className="truncate">{info.projectId}</span>}
          <span className="shrink-0 text-xs font-semibold tabular-nums text-fg-secondary">{info.reviewId}</span>
        </span>
        {pr.isIgnored && <span className="shrink-0 rounded bg-elevated px-1 text-fg-muted">I</span>}
        <span className="ml-auto shrink-0 tabular-nums text-fg-faint">{ageDays(pr.createdAt, Date.now())}d</span>
      </div>

      <button
        type="button"
        onClick={() => onOpen(pr)}
        className="mt-1 line-clamp-2 w-full text-left text-[13px] font-medium leading-snug text-fg hover:text-sky-600 dark:hover:text-sky-300"
      >
        {pr.title}
      </button>

      <div className="mt-1.5 flex items-center gap-1 text-[11px] leading-none">
        {pr.author && (
          <AuthorButton login={pr.author.login} className="shrink-0">
            <Avatar login={pr.author.login} avatarUrl={pr.author.avatarUrl} size={16} className="flex" />
          </AuthorButton>
        )}
        <span
          className={cn(
            "inline-flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded font-semibold",
            info.myRole === "author"
              ? "bg-sky-500/20 text-sky-700 dark:text-sky-300"
              : stage === "your-review"
                ? "bg-violet-500/20 text-violet-700 dark:text-violet-300"
                : "bg-slate-500/20 text-fg-muted",
          )}
        >
          {roleGlyph}
        </span>
        <span
          title={`${info.accepted} of ${info.reviewersCount} reviewers accepted`}
          className={cn(
            "shrink-0 tabular-nums",
            info.isReadyToClose ? "text-emerald-600 dark:text-emerald-400" : "text-fg-muted",
          )}
        >
          {info.accepted}/{info.reviewersCount}
        </span>
        {info.isUnread && (
          <span title="Unread in Upsource" className="shrink-0 text-fuchsia-600 dark:text-fuchsia-300">
            ●
          </span>
        )}
        {info.hasConcern && (
          <span title="Concern raised" className="shrink-0 font-medium text-red-600 dark:text-red-300">
            ⚠
          </span>
        )}
        {info.unresolved > 0 && (
          <span
            title={`${info.unresolved} unresolved discussion(s)`}
            className="shrink-0 tabular-nums text-orange-600 dark:text-orange-300"
          >
            💬{info.unresolved}
          </span>
        )}
        {pr.hasNewActivity && (
          <span title="New comments since you last looked" className="shrink-0 font-medium text-amber-600 dark:text-amber-300">
            ✦
          </span>
        )}
        {due && (
          <span
            title={due.text}
            className={cn("ml-auto shrink-0", due.overdue ? "text-amber-600 dark:text-amber-300" : "text-fg-faint")}
          >
            {due.text.replace("Due ", "")}
          </span>
        )}
      </div>

      <TileHoverActions pr={pr} noun="review" onToggleIgnore={onToggleIgnore} />
    </div>
  );
}
