import { useCallback, useState } from "react";

import type { PullRequest } from "../../../shared/types";
import { cn } from "../format";

/**
 * The controls every card and tile carries, whatever the item is — a GitHub
 * PR (`PrCard`, `PrTile`) or an Upsource review (`UpsourceCard`,
 * `UpsourceTile`): copy the link, ignore, the Jira key, the author's face.
 * One copy, so the two kinds of card cannot drift apart.
 */

type IconSize = "card" | "tile";

/** Card icons are 14px; the tile's hover actions use 12px with a heavier stroke. */
function Svg({ size, children }: { size: IconSize; children: React.ReactNode }) {
  const px = size === "card" ? 14 : 12;
  return (
    <svg
      viewBox="0 0 24 24"
      width={px}
      height={px}
      fill="none"
      stroke="currentColor"
      strokeWidth={size === "card" ? 2 : 2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function CopyIcon({ size, done }: { size: IconSize; done: boolean }) {
  return (
    <Svg size={size}>
      {done ? (
        <polyline points="20 6 9 17 4 12" />
      ) : (
        <>
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </>
      )}
    </Svg>
  );
}

/** Crossed-out eye — "ignore"; open eye — "un-ignore". */
function EyeIcon({ size, off }: { size: IconSize; off: boolean }) {
  return (
    <Svg size={size}>
      {off ? (
        <>
          <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </>
      ) : (
        <>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </Svg>
  );
}

/** Copies the item's link; a tick for a moment says it worked. */
export function CopyLinkButton({ url, noun, size }: { url: string; noun: string; size: IconSize }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    window.api
      .copyText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [url]);
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Copied" : `Copy ${noun} link`}
      aria-label={`Copy ${noun} link`}
      className={cn(
        "shrink-0 rounded p-0.5 hover:bg-elevated",
        copied ? "text-emerald-600 dark:text-emerald-400" : "text-fg-faint hover:text-fg-secondary",
      )}
    >
      <CopyIcon size={size} done={copied} />
    </button>
  );
}

/** Hides the item from the dashboard, or brings an ignored one back. */
export function IgnoreButton({
  pr,
  noun,
  size,
  onToggleIgnore,
}: {
  pr: PullRequest;
  noun: string;
  size: IconSize;
  onToggleIgnore: (pr: PullRequest) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggleIgnore(pr)}
      title={pr.isIgnored ? "Un-ignore (show on the dashboard)" : "Ignore (hide from the dashboard)"}
      aria-label={pr.isIgnored ? `Un-ignore ${noun}` : `Ignore ${noun}`}
      className={cn(
        "shrink-0 rounded p-0.5 hover:bg-elevated",
        pr.isIgnored ? "text-sky-600 dark:text-sky-400" : "text-fg-faint hover:text-fg-secondary",
      )}
    >
      <EyeIcon size={size} off={!pr.isIgnored} />
    </button>
  );
}

/** A tile's copy and ignore, shown on hover in its corner so they cost no layout width. */
export function TileHoverActions({
  pr,
  noun,
  onToggleIgnore,
}: {
  pr: PullRequest;
  noun: string;
  onToggleIgnore: (pr: PullRequest) => void;
}) {
  return (
    <div className="absolute right-1 top-1 hidden items-center gap-0.5 rounded bg-surface/90 px-0.5 group-hover:flex">
      <CopyLinkButton url={pr.url} noun={noun} size="tile" />
      <IgnoreButton pr={pr} noun={noun} size="tile" onToggleIgnore={onToggleIgnore} />
    </div>
  );
}

/**
 * The issue key as a link to Jira, opened in the system browser. The caller
 * renders it only when a real URL exists (`jiraBrowseUrl`), so a user without
 * Jira sees no dead badge.
 */
export function JiraKeyPill({ issueKey, url }: { issueKey: string; url: string }) {
  return (
    <button
      type="button"
      onClick={() => window.api.openExternal(url).catch(() => {})}
      title={`Open ${issueKey} in Jira`}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-indigo-500/40 bg-indigo-500/15 px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-500/25 hover:underline dark:text-indigo-300"
    >
      {issueKey} ↗
    </button>
  );
}

/** A face, or its initial in the same circle when the source named no avatar. */
export function Avatar({
  login,
  avatarUrl,
  size,
  className,
  title,
}: {
  login: string;
  avatarUrl: string;
  size: number;
  className?: string;
  title?: string;
}) {
  return avatarUrl ? (
    <img src={avatarUrl} alt="" width={size} height={size} title={title} className={cn("rounded-full", className)} />
  ) : (
    <span
      title={title}
      style={{ width: size, height: size }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-elevated text-[9px] uppercase text-fg-muted",
        className,
      )}
    >
      {login[0]}
    </span>
  );
}
