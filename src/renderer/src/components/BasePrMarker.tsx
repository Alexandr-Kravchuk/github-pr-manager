import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { basePrTitle, type LinkedPrPlace } from "../../../shared/pr-group";
import { prSignal, type PrSignal } from "../../../shared/pr-filter";
import { repoShortName } from "../../../shared/pr-table";
import type { PullRequest } from "../../../shared/types";
import { cn } from "../format";
import { locateLinkedPr, setLinkedHighlight } from "./linked-pr";

const PREVIEW_WIDTH_PX = 340;
/** Rough height of the preview, to flip it above the marker near the bottom edge. */
const PREVIEW_HEIGHT_PX = 120;

const PLACE_TEXT: Record<Exclude<LinkedPrPlace, "visible">, string> = {
  above: "↑ Above in the list — scroll up to see it",
  below: "↓ Below in the list — scroll down to see it",
  absent: "Not in the list now — a filter or a collapsed group hides it",
};

const ACCENT: Record<PrSignal, string> = {
  blocked: "border-l-red-500",
  myReview: "border-l-violet-500",
  waiting: "border-l-line-strong",
  attention: "border-l-amber-500",
  approved: "border-l-emerald-500",
  idle: "border-l-line-strong",
};

interface Props {
  pr: PullRequest;
  base: PullRequest;
  trackComments: boolean;
  onOpen: (pr: PullRequest) => void;
  className?: string;
  children: ReactNode;
}

/**
 * The "on #N" marker of a hand-made stacked PR. Hovering it outlines the PR it
 * names; when that PR is not on screen — scrolled away, filtered out, in a
 * collapsed group — a preview of it hangs under the marker instead, since an
 * outline nobody can see says nothing. A click opens that PR.
 */
export function BasePrMarker({ pr, base, trackComments, onOpen, className, children }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<{ rect: DOMRect; place: Exclude<LinkedPrPlace, "visible"> } | null>(null);

  const show = () => {
    setLinkedHighlight(base.id, true);
    const place = locateLinkedPr(base.id);
    if (place !== "visible" && ref.current) setPreview({ rect: ref.current.getBoundingClientRect(), place });
  };
  const hide = () => {
    setLinkedHighlight(base.id, false);
    setPreview(null);
  };

  // A fixed preview would drift off its marker on scroll; an unmounted marker
  // must not leave the other card outlined.
  useEffect(() => {
    if (!preview) return;
    const close = () => setPreview(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [preview]);
  useEffect(() => () => setLinkedHighlight(base.id, false), [base.id]);

  const style = preview
    ? {
        position: "fixed" as const,
        left: Math.max(8, Math.min(preview.rect.left, window.innerWidth - PREVIEW_WIDTH_PX - 8)),
        width: PREVIEW_WIDTH_PX,
        ...(preview.rect.bottom + 6 + PREVIEW_HEIGHT_PX > window.innerHeight
          ? { bottom: window.innerHeight - preview.rect.top + 6 }
          : { top: preview.rect.bottom + 6 }),
      }
    : undefined;

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(base);
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        title={preview ? undefined : basePrTitle(pr, base)}
        aria-label={`Based on pull request ${base.number}`}
        className={className}
      >
        {children}
      </button>
      {preview &&
        createPortal(
          <div
            style={style}
            role="tooltip"
            className="pointer-events-none z-50 rounded-lg border border-line-strong bg-elevated p-2 text-xs shadow-lg"
          >
            <div className="mb-1.5 text-fg-muted">{PLACE_TEXT[preview.place]}</div>
            <div
              className={cn(
                "rounded-md border border-line border-l-[3px] bg-surface px-2 py-1.5",
                ACCENT[prSignal(base, { trackComments })],
              )}
            >
              <div className="flex items-center gap-1 text-[11px] text-fg-subtle">
                <span className="truncate">{repoShortName(base.repo)}</span>
                <span className="font-semibold tabular-nums text-fg-secondary">#{base.number}</span>
                {base.isDraft && <span className="rounded bg-elevated px-1 text-fg-muted">Draft</span>}
              </div>
              <div className="mt-0.5 line-clamp-2 text-sm font-medium text-fg">{base.title}</div>
              <div className="mt-0.5 text-[11px] text-fg-subtle">
                {base.author?.login ?? "ghost"} · {base.headRefName}
              </div>
            </div>
            <div className="mt-1.5 text-fg-subtle">Merge #{base.number} first · click to open it</div>
          </div>,
          document.body,
        )}
    </>
  );
}
